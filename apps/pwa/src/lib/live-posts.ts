/**
 * Listing changes the node pushes over /ws, applied to the lists the pages already hold.
 *
 * The node sends the whole listing with `new_post` / `post_updated`, and the id with `post_removed`. Every
 * broadcast used to be a doorbell here: lib/sync.ts ran the coordinator, and every mounted view re-fetched —
 * the marketplace alone asks for its list, the viewer's own posts and the enterprise statuses. One new listing
 * sent every open tab back to the node for all of it. A public offer or need (the rule is @beanpool/core
 * `livePostChange`) now goes to the views instead, and each writes it into the SAME list its refresh writes.
 *
 * This app keeps no store of posts: each page holds the list its refresh fetched. So "the same merge path" is
 * `applyLivePostChange` over that list, and `replayLiveChanges` over a refresh's result — a refresh that was
 * already in flight when a push arrived read the node before the change, and must not undo it.
 *
 * A push never moves the sync cursor, and the catch-up refresh stays the backstop: on reconnect, on the tab
 * coming back, and on each view's own periodic tick.
 */
import { LIVE_POST_TYPES, pushedPostIsStale, type LivePostChange } from '@beanpool/core';
import type { MarketplacePost } from './api';

/** A page's handler: writes the change into the list it holds. */
export type LivePostView = (change: LivePostChange) => void;
/**
 * True when this viewer has more riding on the change than the listing itself — an open deal on it, a chat
 * about it (conversations carry the listing's title and status), or a removal of something the page holds as
 * an event, a poll or the viewer's own. Such a change takes the doorbell: the full refresh, as before.
 */
export type LivePostTie = (change: LivePostChange) => boolean;

let views: LivePostView[] = [];
let ties: LivePostTie[] = [];

// Changes handed to the views, in order, so a refresh in flight can replay the ones that landed after it began.
// Bounded: a refresh that outlives this many pushes leaves the rest to the next one.
const LOG_MAX = 500;
let seq = 0;
let log: Array<{ seq: number; change: LivePostChange }> = [];

const isHome = (p: MarketplacePost) => !(p as { _remoteNode?: string })._remoteNode;
const changedId = (change: LivePostChange) => (change.kind === 'upsert' ? change.post.id : change.id);

export function onLivePostChange(view: LivePostView): () => void {
    views.push(view);
    return () => { views = views.filter(v => v !== view); };
}

export function registerLivePostTie(tie: LivePostTie): () => void {
    ties.push(tie);
    return () => { ties = ties.filter(t => t !== tie); };
}

/**
 * Called by lib/sync.ts for a change @beanpool/core `livePostChange` accepted. Returns false — and hands the
 * change to nobody — when it should ring the doorbell instead: the viewer's own listing or one they accepted,
 * or any registered tie. A tie that throws counts as a tie.
 */
export function routeLivePostChange(change: LivePostChange, selfPubkey: string | null): boolean {
    if (change.kind === 'upsert' && selfPubkey
        && (change.post.authorPublicKey === selfPubkey || change.post.acceptedBy === selfPubkey)) return false;
    for (const tie of ties) {
        try { if (tie(change)) return false; } catch { return false; }
    }
    log.push({ seq: ++seq, change });
    if (log.length > LOG_MAX) log = log.slice(log.length - LOG_MAX);
    for (const view of [...views]) {
        try { view(change); } catch (e) { console.warn('[Live posts] A view could not apply a pushed change:', e); }
    }
    return true;
}

/** Taken as a refresh starts; hand it to `replayLiveChanges` with what the refresh fetched. */
export function liveChangeMark(): number {
    return seq;
}

/** A refresh's result, with every change pushed since `mark` applied over it. */
export function replayLiveChanges(mark: number, list: MarketplacePost[], fits: (p: MarketplacePost) => boolean): MarketplacePost[] {
    let out = list;
    for (const entry of log) {
        if (entry.seq > mark) out = applyLivePostChange(out, entry.change, fits);
    }
    return out;
}

/**
 * One pushed change applied to a list a page holds. Only this node's listings are touched (a peer community's
 * copy can share an id). A new listing that fits the page's filter goes to the front, where the node's
 * newest-first order puts it; an edit replaces the listing and moves it there, or drops it if it no longer fits;
 * a removal drops it. An edit to a listing the page does not hold is not added: the node left it off this list
 * for reasons the push cannot show (an author on holiday, a paused enterprise), and the next refresh decides.
 * A push older than the copy held changes nothing. Returns the same array when nothing changed.
 */
export function applyLivePostChange(list: MarketplacePost[], change: LivePostChange, fits: (p: MarketplacePost) => boolean): MarketplacePost[] {
    const i = list.findIndex(p => p.id === changedId(change) && isHome(p));
    if (change.kind === 'remove') {
        return i < 0 ? list : list.filter((_, j) => j !== i);
    }
    const post = change.post as unknown as MarketplacePost;
    if (i >= 0) {
        if (pushedPostIsStale(list[i].updatedAt, post.updatedAt)) return list;
        const rest = list.filter((_, j) => j !== i);
        return fits(post) ? [post, ...rest] : rest;
    }
    if (!change.created || !fits(post)) return list;
    return [post, ...list];
}

/** The list-read parameters a page fetches with (lib/api.ts getMarketplacePosts). */
export interface ListFilter {
    type?: string;
    types?: string;
    category?: string;
    beansOnly?: boolean;
    targetGroupId?: string;
}

/**
 * Whether the node's list read with these parameters would include this listing, for the fields a pushed public
 * offer or need can differ on (the node's `getPosts` list filter in @beanpool/engine).
 */
export function postFitsList(p: MarketplacePost, f: ListFilter): boolean {
    if (!p.active || (p.status !== 'active' && p.status !== 'pending')) return false;
    if (f.targetGroupId) return p.targetGroupId === f.targetGroupId;
    if (f.type && f.type !== 'all' && p.type !== f.type) return false;
    if (f.types && !f.types.split(',').map(t => t.trim()).includes(p.type)) return false;
    if (f.category && f.category !== 'all' && p.category !== f.category) return false;
    if (f.beansOnly && p.cashAlsoNeeded) return false;
    return true;
}

/** A page's tie for removals of what it holds as an event, a poll or the viewer's own listing. */
export function heldPostTie(held: () => MarketplacePost[], selfPubkey: string | null | undefined): LivePostTie {
    return (change) => {
        if (change.kind !== 'remove') return false;
        const p = held().find(q => q.id === change.id && isHome(q));
        return !!p && (!LIVE_POST_TYPES.has(p.type) || (!!selfPubkey && p.authorPublicKey === selfPubkey));
    };
}

/** An open deal (requested or pending) on the listing a change is about. */
export function openDealTie(deals: () => ReadonlyArray<{ postId: string; status: string }>): LivePostTie {
    return (change) => {
        const id = changedId(change);
        return deals().some(t => t.postId === id && (t.status === 'requested' || t.status === 'pending'));
    };
}

/** A conversation about the listing a change is about. */
export function conversationTie(conversations: () => ReadonlyArray<{ postId?: string | null }>): LivePostTie {
    return (change) => {
        const id = changedId(change);
        return conversations().some(c => c.postId === id);
    };
}

export function resetLivePostsForTest(): void {
    views = [];
    ties = [];
    seq = 0;
    log = [];
}
