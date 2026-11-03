/**
 * The Market's order, one rule for both apps (DESIGN-market-order-fable.md §2, §5; Marty, 3 Nov 2026: "All Fable's picks").
 *
 * Newest LISTED first, under the day headings Today / Yesterday / This Week / Older Listings. A post is listed when it was
 * created, and nothing a member does to it moves that: not an edit, a pause, an RSVP, a deal, a hide and restore. Two kinds of
 * post have a second moment: an event is listed again 24 hours before it starts (its next date, for a series), and an open
 * poll 24 hours before it closes. It comes back once, among that day's new posts, and sinks like any post.
 *
 * Then one bound: no named author takes more than two places in a day's run until everyone else's posts of that day have
 * had theirs. Their third and later go to the end of that day, in their order. A copy of someone else's post on the
 * worldwide community, and any post with no author on the row, share one hidden author and are exempt.
 *
 * Pure, with one import (the words layer's key helper): the phone's SQLite rows (`created_at`, `event_start_at`) and the web's (`createdAt`, `eventStartAt`)
 * give the same order.
 */

import { word } from './words.js';

/** An event or a poll is listed again this long before its moment. */
export const RELIST_BEFORE_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, any>;

function ms(v: unknown): number {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (typeof v !== 'string' || !v) return NaN;
    return Date.parse(v);
}

function pick(p: Row, snake: string, camel: string): unknown {
    return p[snake] ?? p[camel];
}

/** When the post was created, never later than `now` (a clock ahead never sits on top). A row with no time is the oldest. */
function createdMs(p: Row, now: number): number {
    const c = ms(pick(p, 'created_at', 'createdAt'));
    return Number.isFinite(c) ? Math.min(c, now) : 0;
}

/**
 * The time the Market orders `post` by. Its creation time, except that an upcoming event (not cancelled, not over) whose start
 * is at most 24 hours away, and an open poll that closes within 24 hours, are listed at that 24-hour mark, if it is later than
 * their creation.
 */
export function listedAt(post: Row, now: number): number {
    const created = createdMs(post, now);
    const active = post.status === undefined || post.status === 'active';

    if (post.type === 'event' && active) {
        const state = pick(post, 'event_state', 'eventState');
        const start = ms(pick(post, 'event_start_at', 'eventStartAt'));
        if (state !== 'cancelled' && Number.isFinite(start)) {
            const endRaw = ms(pick(post, 'event_end_at', 'eventEndAt'));
            const ends = Number.isFinite(endRaw) ? endRaw : start;
            const mark = start - RELIST_BEFORE_MS;
            if (ends > now && mark <= now) return Math.max(created, mark);
        }
    } else if (post.type === 'poll' && active) {
        const closes = ms(pick(post, 'poll_closes_at', 'pollClosesAt'));
        if (Number.isFinite(closes) && closes > now) {
            const mark = closes - RELIST_BEFORE_MS;
            if (mark <= now) return Math.max(created, mark);
        }
    }
    return created;
}

/** The author to count, or null where the row names none: a copy, or a row with no author key. */
function namedAuthor(p: Row): string | null {
    if (p.shownCopy === true) return null;
    if (typeof p.shown_from === 'string' && p.shown_from) return null;
    const key = p.author_pubkey ?? p.authorPublicKey ?? p.authorPubkey;
    return typeof key === 'string' && key ? key : null;
}

function startOfLocalDay(t: number): number {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** Whole local calendar days from `thenMs` to `nowMs`: 0 for earlier today, 1 for any time yesterday. */
function localDays(thenMs: number, nowMs: number): number {
    // Rounded, because a day with a daylight-saving change is 23 or 25 hours long.
    return Math.round((startOfLocalDay(nowMs) - startOfLocalDay(thenMs)) / DAY_MS);
}

/**
 * The Market's order: `listedAt` newest first, then created, then id; then, within each local day, a named author's third and
 * later posts after everyone else's of that day. Returns a new array, the input untouched; hides nothing.
 */
export function marketOrder<T extends Row>(posts: readonly T[], now: number): T[] {
    const keyed = posts.map(p => ({ p, listed: listedAt(p, now), created: createdMs(p, now), id: String(p.id ?? '') }));
    keyed.sort((a, b) =>
        b.listed - a.listed
        || b.created - a.created
        || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    const out: T[] = [];
    let i = 0;
    while (i < keyed.length) {
        const day = startOfLocalDay(keyed[i].listed);
        let j = i;
        while (j < keyed.length && startOfLocalDay(keyed[j].listed) === day) j++;
        const kept: T[] = [];
        const after: T[] = [];
        const seen = new Map<string, number>();
        for (let k = i; k < j; k++) {
            const author = namedAuthor(keyed[k].p);
            const n = author === null ? 0 : (seen.get(author) ?? 0);
            if (author !== null) seen.set(author, n + 1);
            (n >= 2 ? after : kept).push(keyed[k].p);
        }
        out.push(...kept, ...after);
        i = j;
    }
    return out;
}

export type DaySectionId = 'today' | 'yesterday' | 'thisweek' | 'older';

export interface DaySection<T> {
    id: DaySectionId;
    /** The heading in English: the app shows it through its words layer. */
    title: 'Today' | 'Yesterday' | 'This Week' | 'Older Listings';
    posts: T[];
}

/** Heading and bucket for a local day count: 0 or less Today, 1 Yesterday, 2 to 6 This Week, else Older Listings. */
const HEADINGS: ReadonlyArray<Pick<DaySection<never>, 'id' | 'title'>> = [
    { id: 'today', title: 'Today' },
    { id: 'yesterday', title: 'Yesterday' },
    { id: 'thisweek', title: 'This Week' },
    { id: 'older', title: 'Older Listings' },
];

/** The ordered list under its four headings by the local day of `listedAt`, empty ones left out. Order within is kept. */
export function daySections<T extends Row>(ordered: readonly T[], now: number): DaySection<T>[] {
    const buckets: T[][] = [[], [], [], []];
    for (const p of ordered) {
        const days = localDays(listedAt(p, now), now);
        buckets[days <= 0 ? 0 : days === 1 ? 1 : days < 7 ? 2 : 3].push(p);
    }
    return HEADINGS.map((h, n) => ({ ...h, posts: buckets[n] })).filter(s => s.posts.length > 0);
}

/**
 * "New since you last looked" (DESIGN-market-order-fable.md §2.9, slice 4). One stamp per device, kept beside the fresh banner's
 * dismissal: the newest `listedAt` on screen when the Market was last left. No per-post state, no node, no account.
 * Both apps store it under this key (AsyncStorage on the phone, localStorage on the web).
 */
export const MARKET_SEEN_KEY = 'bp_market_seen_listed';

/** The line's words, in the section header's style on both apps; each shows it through t(). */
export const NEW_SINCE_LINE = word('New since you last looked');

/** The newest `listedAt` among `posts`, or null for none: what to store when the Market is left. */
export function newestListed(posts: readonly Row[], now: number): number | null {
    let newest: number | null = null;
    for (const p of posts) {
        const at = listedAt(p, now);
        if (newest === null || at > newest) newest = at;
    }
    return newest;
}

/** A stored stamp read back: a positive whole number of milliseconds, as a number or a digit string; anything else is none. */
export function parseSeenListed(stored: unknown): number | null {
    const n = typeof stored === 'number' ? stored : typeof stored === 'string' && /^\d+$/.test(stored.trim()) ? Number(stored.trim()) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Where the line goes in `ordered` (the Market's order, as drawn): the index of the first post listed at or before `stamp`, so the
 * line sits above it. -1 for no line: no stamp (the first visit), nothing newer (that index would be 0), or nothing at or before
 * the stamp. The caller shows none under a search or a filter.
 */
export function newSinceIndex(ordered: readonly Row[], stamp: number | null, now: number): number {
    if (stamp === null) return -1;
    const i = ordered.findIndex(p => listedAt(p, now) <= stamp);
    return i > 0 ? i : -1;
}
