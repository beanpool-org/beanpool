/**
 * What needs the member right now, as the header's small icons show it: one entry per kind, only while
 * something of that kind does. Pure, so the priority, accent, fit and wording are tested once
 * (utils/__tests__/needs-you.test.ts); the component only loads the data and draws the result.
 */

import type { DecisionWithTally, MyPoolVoting } from './db';
import { poolVoteBlocker } from './decision-card';

export type NeedsYouKind = 'deal' | 'vote' | 'message' | 'group';

/**
 * Highest first. The highest sits nearest the invite/Settings/avatar group and keeps its spot as others
 * come and go; the lowest are the first to fold into "•••".
 *
 * Seam for owners and admins: a 🛡️ kind for pending admin items (feat/app-node-admin-entry) slots in here
 * once the node serves its pending-admin-items endpoint. It is not on main yet, so nothing is faked.
 */
export const NEEDS_YOU_PRIORITY: readonly NeedsYouKind[] = ['deal', 'vote', 'message', 'group'];

/** Where a tap lands. Resolved to a route by the component, so this file stays free of navigation. */
export type NeedsYouTarget =
    | { to: 'deal'; postId: string; txId: string }
    | { to: 'my-deals' }
    | { to: 'decide' }
    | { to: 'chat'; conversationId: string; event?: boolean }
    | { to: 'unread-messages' };

export interface NeedsYouEntry {
    kind: NeedsYouKind;
    /** Things of this kind; the icon shows it in a dot only above 1. */
    count: number;
    /** Only a deal waiting on the member, or a vote closing within 48h, gets the (amber) accent. Never red. */
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
    /** 'dm' for a direct chat; group and event chats are '*_thread' and counted from Your groups instead. */
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
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

    const dms = (i.conversations || []).filter(c => c.unread > 0 && !c.type.endsWith('_thread'));
    if (dms.length) {
        out.push({
            kind: 'message', count: dms.length, accent: false,
            label: dms.length === 1
                ? (dms[0].unread === 1 ? `Unread message from ${dms[0].peer}` : `${dms[0].unread} unread messages from ${dms[0].peer}`)
                : `Unread messages from ${dms.length} people`,
            target: dms.length === 1 ? { to: 'chat', conversationId: dms[0].id } : { to: 'unread-messages' },
        });
    }

    // Muted chats stay quiet here too. Enterprise chats are left out: the app has no screen for them yet,
    // so an icon would have nowhere to land.
    const groups = (i.groupChats || []).filter(g => g.unreadCount > 0 && !g.mute && g.kind !== 'enterprise');
    if (groups.length) {
        const [g] = groups;
        out.push({
            kind: 'group', count: groups.length, accent: false,
            label: groups.length === 1 ? `${plural(g.unreadCount, 'new line', 'new lines')} in ${g.name}` : `New lines in ${groups.length} of your groups`,
            target: groups.length === 1
                ? { to: 'chat', conversationId: g.conversationId, event: g.kind === 'event' || undefined }
                : { to: 'unread-messages' },
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
