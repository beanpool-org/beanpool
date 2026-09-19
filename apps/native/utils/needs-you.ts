/**
 * What needs the member right now, as the header's small icons show it: one entry per kind, only while
 * something of that kind does. Pure, so the priority, accent, fit and wording are tested once
 * (utils/__tests__/needs-you.test.ts); the component only loads the data and draws the result.
 */

import type { DecisionWithTally, MyPoolVoting } from './db';
import { isMuted, type YourChatMute } from './your-groups';
import { poolVoteBlocker } from './decision-card';
import { canManageNode, type AdminQueueItem, type SettingsSection } from './node-role';

export type NeedsYouKind = 'admin' | 'deal' | 'vote' | 'message' | 'group';

/**
 * Highest first. The highest sits nearest the invite/Settings/avatar group and keeps its spot as others
 * come and go; the lowest are the first to fold into "•••". Admin work (🛡️, owners and admins only) comes
 * first: a report or an emergency suspension can be urgent.
 */
export const NEEDS_YOU_PRIORITY: readonly NeedsYouKind[] = ['admin', 'deal', 'vote', 'message', 'group'];

/** Where a tap lands. Resolved to a route by the component, so this file stays free of navigation. */
export type NeedsYouTarget =
    | { to: 'admin'; section: SettingsSection }
    | { to: 'deal'; postId: string; txId: string }
    | { to: 'my-deals' }
    | { to: 'decide' }
    | { to: 'chat'; conversationId: string; event?: boolean; thread?: 'group' | 'enterprise' }
    | { to: 'unread-messages' }
    /** Talk → Groups (groups slice 2): group, enterprise and event chats are listed there, not under Messages. */
    | { to: 'your-groups' };

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
    decisions: { decisions: Pick<DecisionWithTally, 'opensAt' | 'closesAt' | 'myVote' | 'franchise'>[]; myPoolVoting: MyPoolVoting | null; signed: boolean } | null;
    conversations: NeedsYouConversation[] | null;
    groupChats: NeedsYouGroupChat[] | null;
    /**
     * The member's node role (GET /api/node-admin/me) and, only when that is owner/admin, the node's admin
     * queue (GET /api/node-admin/queue). null when either is unknown: no 🛡️ rather than a guess.
     */
    admin: { role: unknown; queue: { total: number; items: AdminQueueItem[] } | null } | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One admin-queue item in words: "2 reports to review". Kinds from apps/server/src/engine/admin-queue.ts. */
export function adminItemInWords(i: Pick<AdminQueueItem, 'kind' | 'count' | 'label'>): string {
    const n = i.count;
    switch (i.kind) {
        case 'reports': return `${plural(n, 'report', 'reports')} to review`;
        case 'disputes': return `${plural(n, 'stalled trade', 'stalled trades')} awaiting a ruling`;
        case 'suspensions': return `${plural(n, 'emergency suspension', 'emergency suspensions')} the community is voting on`;
        case 'removals': return n === 1 ? '1 removal in its 7-day grace period' : `${n} removals in their 7-day grace period`;
        case 'unclean_shutdown': return 'the node restarted after an unclean shutdown';
        // A kind a newer node added: its own label, with the count.
        default: return `${i.label.charAt(0).toLowerCase()}${i.label.slice(1)}: ${n}`;
    }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "2 reports to review", "2 reports to review and 1 stalled trade awaiting a ruling", "A, B and C". */
export function adminLabel(items: Pick<AdminQueueItem, 'kind' | 'count' | 'label'>[]): string {
    const parts = items.map(adminItemInWords);
    const joined = parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return capitalise(joined);
}

/** "closes within the hour", "closes in 3 hours", "closes tonight", "closes tomorrow", "closes in 4 days". */
export function closesInWords(closesAt: string, now: number): string {
    const closes = new Date(closesAt);
    const ms = closes.getTime() - now;
    const hours = Math.floor(ms / 3600_000);
    if (hours < 1) return 'closes within the hour';
    if (hours < 12) return `closes in ${plural(hours, 'hour', 'hours')}`;
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOfDay(closes) - startOfDay(new Date(now))) / 86400_000);
    if (days <= 0) return closes.getHours() >= 17 ? 'closes tonight' : 'closes later today';
    if (days === 1) return 'closes tomorrow';
    return `closes in ${days} days`;
}

/** A step that is the member's to take: accept a request made to them, or finish a deal in progress. */
function dealsWaiting(txns: NeedsYouTransaction[], me: string): NeedsYouTransaction[] {
    return txns.filter(t =>
        (t.status === 'requested' && t.sellerPublicKey === me)
        || (t.status === 'pending' && (t.buyerPublicKey === me || t.sellerPublicKey === me)));
}

export function buildNeedsYou(i: NeedsYouInputs): NeedsYouEntry[] {
    const out: NeedsYouEntry[] = [];

    // Owners and admins only, and only while the node's queue holds something. The node answers the queue
    // only for an owner/admin anyway; checking the role here as well means a stale queue never outlives a demotion.
    const queue = canManageNode(i.admin?.role) ? i.admin?.queue : null;
    const adminItems = (queue?.items || []).filter(x => x.count > 0);
    if (queue && queue.total > 0 && adminItems.length) {
        out.push({
            kind: 'admin', count: queue.total, accent: true,
            label: adminLabel(adminItems),
            // The node lists the most pressing kind first (reports); the tap opens /settings at its section.
            target: { to: 'admin', section: adminItems[0].section },
        });
    }

    const deals = dealsWaiting(i.transactions || [], i.me);
    if (deals.length) {
        const [first] = deals;
        out.push({
            kind: 'deal', count: deals.length, accent: true,
            label: deals.length === 1 ? 'A deal is waiting for you' : `${deals.length} deals waiting for you`,
            target: deals.length === 1 && first.postId ? { to: 'deal', postId: first.postId, txId: first.id } : { to: 'my-deals' },
        });
    }

    if (i.decisions?.signed) {
        const blocked = poolVoteBlocker(i.decisions.myPoolVoting) !== null;
        const votes = i.decisions.decisions
            .filter(d => !d.myVote
                && Date.parse(d.opensAt) <= i.now && Date.parse(d.closesAt) > i.now
                // A money vote the member can't cast yet (no completed trade) isn't asking anything of them.
                && !(d.franchise === 'quadratic_trade' && blocked))
            .sort((a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt));
        if (votes.length) {
            const soonest = votes[0].closesAt;
            const when = closesInWords(soonest, i.now);
            out.push({
                kind: 'vote', count: votes.length,
                accent: Date.parse(soonest) - i.now <= VOTE_ACCENT_WINDOW_MS,
                label: votes.length === 1 ? `Vote ${when}` : `${votes.length} votes to cast, the first ${when}`,
                target: { to: 'decide' },
            });
        }
    }

    const dms = (i.conversations || []).filter(c => c.unread > 0 && c.type === 'dm');
    if (dms.length) {
        out.push({
            kind: 'message', count: dms.length, accent: false,
            label: dms.length === 1
                ? (dms[0].unread === 1 ? `Unread message from ${dms[0].peer}` : `${dms[0].unread} unread messages from ${dms[0].peer}`)
                : `Unread messages from ${dms.length} people`,
            target: dms.length === 1 ? { to: 'chat', conversationId: dms[0].id } : { to: 'unread-messages' },
        });
    }

    // Muted chats stay quiet here too (a lapsed mute is not a mute). Enterprise keeper chats count like any
    // other: since groups slice 2 they have a screen, and Talk's Groups total counts them.
    const groups = (i.groupChats || []).filter(g => g.unreadCount > 0 && !isMuted(g.mute as YourChatMute | null, new Date(i.now)));
    if (groups.length) {
        const [g] = groups;
        out.push({
            kind: 'group', count: groups.length, accent: false,
            label: groups.length === 1 ? `${plural(g.unreadCount, 'new line', 'new lines')} in ${g.name}` : `New lines in ${groups.length} of your groups`,
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

export const NEEDS_YOU_SLOT = 48;

/**
 * What fits in a slot this wide, every target 48dp. When there are more kinds than slots, the last slot
 * becomes "•••" for the rest. Nothing shows until the slot has been measured.
 */
export function fitNeedsYou(entries: NeedsYouEntry[], width: number, slot = NEEDS_YOU_SLOT): { shown: NeedsYouEntry[]; hidden: number } {
    const slots = Math.floor(width / slot);
    if (slots <= 0) return { shown: [], hidden: 0 };
    if (entries.length <= slots) return { shown: entries, hidden: 0 };
    const shown = entries.slice(0, slots - 1);
    return { shown, hidden: entries.length - shown.length };
}

/**
 * Left to right, as drawn: the row is right-aligned against the invite/Settings/avatar group, so the
 * highest priority is last (rightmost) and "•••" is first (nearest the bean).
 */
export function needsYouRowOrder(fit: { shown: NeedsYouEntry[]; hidden: number }): (NeedsYouKind | 'more')[] {
    const kinds: (NeedsYouKind | 'more')[] = fit.shown.map(e => e.kind).reverse();
    return fit.hidden > 0 ? ['more', ...kinds] : kinds;
}

export function moreLabel(hidden: number): string {
    return hidden === 1 ? '1 more thing needs you' : `${hidden} more things need you`;
}
