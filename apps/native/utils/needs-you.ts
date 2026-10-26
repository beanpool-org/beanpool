/**
 * What needs the member right now, as the header's small icons show it: one entry per kind, only while
 * something of that kind does. Pure, so the priority, accent, fit and wording are tested once
 * (utils/__tests__/needs-you.test.ts); the component only loads the data and draws the result.
 */

import { capitalFirst, fitNeedsYou, isOwnInviteChange, NEEDS_YOU_PRIORITY, NEEDS_YOU_SLOT, needsYouRowOrder, t, tn, type NeedsYouKind } from '@beanpool/core';
import type { DecisionWithTally, MyPoolVoting } from './db';
import { isMuted, type YourChatMute } from './your-groups';
import { isOwnRemoval, poolVoteBlocker } from './decision-card';
import { canManageNode, type AdminQueueItem, type SettingsSection } from './node-role';

export {
    fitNeedsYou, isOwnInviteChange, NEEDS_YOU_PRIORITY, NEEDS_YOU_SLOT, needsYouRowOrder,
    type NeedsYouKind,
};

export function moreLabel(hidden: number): string {
    return tn(hidden, '{n} more thing needs you', '{n} more things need you');
}

/** Where a tap lands: {@link needsTargetHref} names the screen, and the component navigates there. */
export type NeedsYouTarget =
    | { to: 'admin'; section: SettingsSection }
    | { to: 'deal'; postId: string; txId: string }
    | { to: 'my-deals' }
    | { to: 'decide' }
    | { to: 'chat'; conversationId: string; event?: boolean; thread?: 'group' | 'enterprise' }
    | { to: 'unread-messages' }
    /** Talk → Groups (groups slice 2): group, enterprise and event chats are listed there, not under Messages. */
    | { to: 'your-groups' }
    /**
     * An enterprise's keepers' console, for its keepers' vote (DESIGN-group-decisions §2.8; its Decisions block is there
     * since slice S7). The node sends it only to an app that asks with `lands=enterprise` (utils/home-store.ts homePath);
     * the two ship together.
     */
    | { to: 'enterprise'; id: string }
    /**
     * A chat group, for its members' vote (slice S3): its chat with the info sheet open, where its Decisions block is. The
     * node sends it only to an app that asks with `lands=group` (utils/home-store.ts homePath).
     */
    | { to: 'group'; id: string }
    /**
     * An invitation to a group: its invite landing (app/group/[id].tsx), opened as an invitation. Several: Commons →
     * Groups, where each shows INVITED. The node sends these only to an app that asks with `lands=invite`
     * (utils/home-store.ts homePath).
     */
    | { to: 'invite'; id: string }
    | { to: 'invites' }
    /**
     * People → Invites, where requests to join are listed with Invite and Not now (front doors S1). The node sends it only
     * to an app that asks with `lands=people` (utils/home-store.ts homePath).
     */
    | { to: 'people' };

/** A chat group's vote lands on the group: its chat screen, told it is a group, with its info sheet open (`info=1`). */
export function groupVoteHref(groupId: string): { pathname: string; params: Record<string, string> } {
    return { pathname: '/chat/[id]', params: { id: groupId, group: '1', info: '1' } };
}

/**
 * The screen each landing opens, as `router.push` takes it (components/NeedsYouIcons.tsx `goToNeedsTarget`; Home's Needs
 * you card too). Every landing but 'admin', which needs the phone unlock and sign-in link (useManageNode).
 */
export function needsTargetHref(target: Exclude<NeedsYouTarget, { to: 'admin' }>): { pathname: string; params?: Record<string, string> } {
    switch (target.to) {
        case 'deal': return { pathname: '/post/[id]', params: { id: target.postId, txId: target.txId } };
        case 'my-deals': return { pathname: '/(tabs)/market', params: { tab: 'deals' } };
        // Commons has no route or param for one Decision, so every vote lands on its Decide section. Only a node with
        // Decisions sends a vote line (routes/home-answer.ts, the header's own read).
        case 'decide': return { pathname: '/(tabs)/projects', params: { section: 'decide' } };
        // The chat screen is told its kind on the way in, so it never waits on a lookup to decide.
        case 'chat': return target.event
            ? { pathname: '/chat/[id]', params: { id: target.conversationId, event: '1' } }
            : target.thread
                ? { pathname: '/chat/[id]', params: { id: target.conversationId, [target.thread]: '1' } }
                : { pathname: '/chat/[id]', params: { id: target.conversationId } };
        // Talk → Messages lists chats with people; the Unread filter narrows it to these.
        case 'unread-messages': return { pathname: '/(tabs)/chats', params: { view: 'messages', filter: 'unread' } };
        // Group, enterprise and event chats live in Talk → Groups (groups slice 2), with their counts.
        case 'your-groups': return { pathname: '/(tabs)/chats', params: { view: 'groups' } };
        // A keepers' vote is never in Commons → Decide: it lands in the enterprise's console (S7), whose Decisions block lists it.
        case 'enterprise': return { pathname: '/treasury-manage', params: { publicKey: target.id } };
        // A group's vote: the group itself (its chat, the info sheet open on its Decisions block), never Talk's list.
        case 'group': return groupVoteHref(target.id);
        // An invitation: the landing that says what the group is and who asked, with Join (utils/your-groups.ts
        // inviteLandingHref, as a Commons row opens it); several, the Commons list where each is marked INVITED.
        case 'invite': return { pathname: '/group/[id]', params: { id: target.id, invited: '1' } };
        case 'invites': return { pathname: '/(tabs)/projects', params: { section: 'groups' } };
        case 'people': return { pathname: '/(tabs)/people', params: { view: 'invites' } };
    }
}

export interface NeedsYouEntry {
    kind: NeedsYouKind;
    /** Things of this kind; the icon shows it in a dot only above 1. */
    count: number;
    /** Only admin work, a deal waiting on the member, or a vote closing within 48h gets the (amber) accent. Never red. */
    accent: boolean;
    /** In words, for screen readers and the "Needs you" sheet. */
    label: string;
    target: NeedsYouTarget;
}

export const VOTE_ACCENT_WINDOW_MS = 48 * 3600_000;

export interface NeedsYouTransaction {
    id: string;
    postId: string;
    status: string;
    buyerPublicKey: string;
    sellerPublicKey: string;
}

export interface NeedsYouConversation {
    id: string;
    /**
     * Only 'dm' is a message from a person. Group and event chats ('*_thread') are counted from Your groups
     * instead, and a legacy 'group' conversation is left out rather than passed off as a person.
     */
    type: string;
    unread: number;
    peer: string;
}

/** One of the member's open invitations to a group: GET /api/your-groups `invites` (server engine/group-invites.ts). */
export interface NeedsYouGroupInvite {
    groupId: string;
    name: string;
}

/** One row of GET /api/your-groups. */
export interface NeedsYouGroupChat {
    kind: 'group' | 'enterprise' | 'event';
    conversationId: string;
    name: string;
    unreadCount: number;
    mute: unknown | null;
}

export interface NeedsYouInputs {
    me: string;
    now: number;
    /** null when a source failed to load: that kind is left out rather than guessed. */
    transactions: NeedsYouTransaction[] | null;
    /** Only a signed list says which votes are the member's own; an unsigned one is left out. */
    decisions: {
        decisions: (Pick<DecisionWithTally, 'opensAt' | 'closesAt' | 'myVote' | 'franchise'> & Partial<Pick<DecisionWithTally, 'effect' | 'subject'>>)[];
        myPoolVoting: MyPoolVoting | null;
        signed: boolean;
    } | null;
    conversations: NeedsYouConversation[] | null;
    groupChats: NeedsYouGroupChat[] | null;
    /** Absent or null when not read (a node from before it said them): no line rather than a guess. */
    groupInvites?: NeedsYouGroupInvite[] | null;
    /**
     * The member's node role (GET /api/node-admin/me) and, only when that is owner/admin/moderator, the node's admin
     * queue (GET /api/node-admin/queue). null when either is unknown: no 🛡️ rather than a guess. `decisions` words it.
     */
    admin: ({ role: unknown; queue: { total: number; items: AdminQueueItem[] } | null } & AdminWordsNode) | null;
}

/** What the admin words need to know about the node, from its cached profile. */
export interface AdminWordsNode {
    /**
     * The node's `decisions` switch as its profile last said. Only `false` changes the words: an emergency suspension
     * there opens no vote and lifts by itself after 7 days. On, or not said (a node from before the switch): as today.
     */
    decisions?: boolean;
}

/** One admin-queue item in words: "2 reports to review". Kinds from apps/server/src/engine/admin-queue.ts. */
export function adminItemInWords(i: Pick<AdminQueueItem, 'kind' | 'count' | 'label'>, node: AdminWordsNode = {}): string {
    const n = i.count;
    switch (i.kind) {
        case 'reports': return tn(n, '{n} report to review', '{n} reports to review');
        case 'disputes': return tn(n, '{n} stalled trade awaiting a ruling', '{n} stalled trades awaiting a ruling');
        // The phone's own words rather than the node's label, so a node whose label still speaks of a vote is not believed.
        case 'suspensions': return node.decisions === false
            ? tn(n, '{n} emergency suspension in its 7 days', '{n} emergency suspensions in their 7 days')
            : tn(n, '{n} emergency suspension the community is voting on', '{n} emergency suspensions the community is voting on');
        case 'removals': return tn(n, '{n} removal in its 7-day grace period', '{n} removals in their 7-day grace period');
        case 'unclean_shutdown': return t('the node restarted after an unclean shutdown');
        case 'knocks': return tn(n, '{n} person asked to join', '{n} people asked to join');
        // A kind a newer node added: its own label, with the count.
        default: return `${i.label.charAt(0).toLowerCase()}${i.label.slice(1)}: ${n}`;
    }
}

/** "2 reports to review", "2 reports to review and 1 stalled trade awaiting a ruling", "A, B and C". */
export function adminLabel(items: Pick<AdminQueueItem, 'kind' | 'count' | 'label'>[], node: AdminWordsNode = {}): string {
    const parts = items.map(i => adminItemInWords(i, node));
    const joined = parts.length <= 1 ? (parts[0] ?? '') : t('{items} and {last}', { items: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] });
    return capitalFirst(joined);
}

/** "closes within the hour", "closes in 3 hours", "closes tonight", "closes tomorrow", "closes in 4 days". */
export function closesInWords(closesAt: string, now: number): string {
    const closes = new Date(closesAt);
    const ms = closes.getTime() - now;
    const hours = Math.floor(ms / 3600_000);
    if (hours < 1) return t('closes within the hour');
    if (hours < 12) return tn(hours, 'closes in {n} hour', 'closes in {n} hours');
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOfDay(closes) - startOfDay(new Date(now))) / 86400_000);
    if (days <= 0) return closes.getHours() >= 17 ? t('closes tonight') : t('closes later today');
    if (days === 1) return t('closes tomorrow');
    return tn(days, 'closes in {n} day', 'closes in {n} days');
}

/** A step that is the member's to take: accept a request made to them, or finish a deal in progress. */
function dealsWaiting(txns: NeedsYouTransaction[], me: string): NeedsYouTransaction[] {
    return txns.filter(t =>
        (t.status === 'requested' && t.sellerPublicKey === me)
        || (t.status === 'pending' && (t.buyerPublicKey === me || t.sellerPublicKey === me)));
}

export function buildNeedsYou(i: NeedsYouInputs): NeedsYouEntry[] {
    const out: NeedsYouEntry[] = [];

    // Owners, admins and moderators only, and only while the node's queue holds something (a moderator's queue
    // is the reports alone: the node filters it). The node answers the queue only for a node role anyway; checking the role here as well means a stale queue never outlives a demotion.
    const queue = canManageNode(i.admin?.role) ? i.admin?.queue : null;
    const queued = (queue?.items || []).filter(x => x.count > 0);
    // Requests to join are answered in People → Invites, which Settings has no list for (front doors S1): their own line.
    const knocks = queued.find(x => x.kind === 'knocks');
    const adminItems = queued.filter(x => x.kind !== 'knocks');
    if (queue && adminItems.length) {
        out.push({
            kind: 'admin', count: adminItems.reduce((n, x) => n + x.count, 0), accent: true,
            label: adminLabel(adminItems, { decisions: i.admin?.decisions }),
            // The node lists the most pressing kind first (reports); the tap opens /settings at its section.
            target: { to: 'admin', section: adminItems[0].section },
        });
    }
    if (knocks) {
        out.push({ kind: 'knock', count: knocks.count, accent: true, label: capitalFirst(adminItemInWords(knocks)), target: { to: 'people' } });
    }

    const deals = dealsWaiting(i.transactions || [], i.me);
    if (deals.length) {
        const [first] = deals;
        out.push({
            kind: 'deal', count: deals.length, accent: true,
            label: deals.length === 1 ? t('A deal is waiting for you') : tn(deals.length, '{n} deal waiting for you', '{n} deals waiting for you'),
            target: deals.length === 1 && first.postId ? { to: 'deal', postId: first.postId, txId: first.id } : { to: 'my-deals' },
        });
    }

    if (i.decisions?.signed) {
        const blocked = poolVoteBlocker(i.decisions.myPoolVoting) !== null;
        const votes = i.decisions.decisions
            .filter(d => !d.myVote
                && Date.parse(d.opensAt) <= i.now && Date.parse(d.closesAt) > i.now
                // A money vote the member can't cast yet (no completed trade) isn't asking anything of them, nor is a vote
                // on removing them (removal by vote S2: nobody votes on their own removal).
                && !(d.franchise === 'quadratic_trade' && blocked)
                && !isOwnRemoval({ effect: d.effect ?? '', subject: d.subject }, i.me))
            .sort((a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt));
        if (votes.length) {
            const soonest = votes[0].closesAt;
            const when = closesInWords(soonest, i.now);
            out.push({
                kind: 'vote', count: votes.length,
                accent: Date.parse(soonest) - i.now <= VOTE_ACCENT_WINDOW_MS,
                label: votes.length === 1
                    ? t('Vote {closes}', { closes: when })
                    : tn(votes.length, '{n} vote to cast, the first {closes}', '{n} votes to cast, the first {closes}', { closes: when }),
                target: { to: 'decide' },
            });
        }
    }

    // Open invitations to groups, one line for them all as the node words it on Home: gone once each is accepted,
    // declined or withdrawn (the node lists only what is still open).
    const invites = (i.groupInvites || []).filter(g => typeof g?.groupId === 'string' && g.groupId && typeof g.name === 'string');
    if (invites.length) {
        out.push({
            kind: 'invite', count: invites.length, accent: false,
            label: invites.length === 1
                ? t("You're invited to join {name}", { name: invites[0].name })
                : tn(invites.length, "You're invited to join {n} group", "You're invited to join {n} groups"),
            target: invites.length === 1 ? { to: 'invite', id: invites[0].groupId } : { to: 'invites' },
        });
    }

    const dms = (i.conversations || []).filter(c => c.unread > 0 && c.type === 'dm');
    if (dms.length) {
        out.push({
            kind: 'message', count: dms.length, accent: false,
            label: dms.length === 1
                ? (dms[0].unread === 1
                    ? t('Unread message from {name}', { name: dms[0].peer })
                    : tn(dms[0].unread, '{n} unread message from {name}', '{n} unread messages from {name}', { name: dms[0].peer }))
                : tn(dms.length, 'Unread messages from {n} person', 'Unread messages from {n} people'),
            target: dms.length === 1 ? { to: 'chat', conversationId: dms[0].id } : { to: 'unread-messages' },
        });
    }

    // Muted chats stay quiet here too (a lapsed mute is not a mute). Enterprise discussion threads count like any
    // other: since groups slice 2 they have a screen, and Talk's Groups total counts them.
    const groups = (i.groupChats || []).filter(g => g.unreadCount > 0 && !isMuted(g.mute as YourChatMute | null, new Date(i.now)));
    if (groups.length) {
        const [g] = groups;
        out.push({
            kind: 'group', count: groups.length, accent: false,
            label: groups.length === 1
                ? tn(g.unreadCount, '{n} new line in {name}', '{n} new lines in {name}', { name: g.name })
                : tn(groups.length, 'New lines in {n} of your groups', 'New lines in {n} of your groups'),
            target: groups.length === 1
                ? (g.kind === 'event'
                    ? { to: 'chat', conversationId: g.conversationId, event: true }
                    : { to: 'chat', conversationId: g.conversationId, thread: g.kind })
                : { to: 'your-groups' },
        });
    }

    const rank = (k: NeedsYouKind) => NEEDS_YOU_PRIORITY.indexOf(k);
    return out.sort((a, b) => rank(a.kind) - rank(b.kind));
}
