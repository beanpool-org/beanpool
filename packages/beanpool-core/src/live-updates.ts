/**
 * The node's live feed (`/ws`) as the apps consume it: which broadcasts carry a change an app can write
 * straight into what it holds, and how a dropped socket comes back.
 *
 * Every broadcast used to be a doorbell. Both apps ignored the payload and ran their catch-up sync, so one new
 * listing made every open phone send requests back to the node — harmless on a community node, thousands of
 * requests per listing on a global one, and paid mobile data for every phone either way. The node already sends
 * the whole listing with `new_post` / `post_updated` (apps/server/src/engine/posts.ts, read back through
 * `getPosts`, so photos are links, not data). This module decides when that payload is enough.
 *
 * A change qualifies only when it is the same for every reader and complete for the app to render:
 *   - public audience, said by the payload itself. Group and direct posts go to their recipients only and keep the
 *     doorbell; so does a node too old to say, because "unknown" must not read as "public".
 *   - an offer or a need. An event's broadcast has the host's note, the RSVP list and the reader's own RSVP taken
 *     off (`publicBroadcastPost`), and a poll's carries the voter's own choice: neither is what every reader's own
 *     sync would return.
 *   - a timestamp to order it by, so a late push never overwrites a newer copy (`pushedPostIsStale`).
 * Anything else — a bare `{ type }` doorbell, pause/resume's `{ type, id }`, every private or trade event — stays
 * on the catch-up sync, which also remains the backstop on reconnect, on foreground and on its periodic tick.
 *
 * Shared by the phone app and the PWA so the rule cannot drift between them. No imports: this is in the barrel
 * Metro bundles for the phone (see __tests__/barrel-is-universal.test.ts).
 */

/** The only post types a pushed payload is applied for. */
export const LIVE_POST_TYPES: ReadonlySet<string> = new Set(['offer', 'need']);

/** The listing fields an app reads to apply a pushed change. The payload is the node's full post; this names the part relied on. */
export interface LivePost {
    id: string;
    type: string;
    authorPublicKey: string;
    updatedAt: string;
    audienceScope: 'public';
    acceptedBy?: string | null;
    [field: string]: unknown;
}

export type LivePostChange =
    /** `new_post` / `post_updated` with the whole listing. `created` is true for `new_post`. */
    | { kind: 'upsert'; post: LivePost; created: boolean }
    /** `post_removed`: the listing is cancelled (removed by its author, a convenor or an admin). */
    | { kind: 'remove'; id: string };

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function instant(iso: unknown): number {
    return typeof iso === 'string' ? Date.parse(iso) : NaN;
}

/**
 * The change a live-feed event carries that an app may apply without fetching, or null when the event is a
 * doorbell for this purpose and the app should run its catch-up sync exactly as before.
 */
export function livePostChange(event: unknown): LivePostChange | null {
    if (!isObject(event)) return null;
    if (event.type === 'new_post' || event.type === 'post_updated') {
        const post = event.post;
        if (!isObject(post)) return null;
        if (typeof post.id !== 'string' || !post.id) return null;
        if (typeof post.type !== 'string' || !LIVE_POST_TYPES.has(post.type)) return null;
        if (post.audienceScope !== 'public') return null;
        if (typeof post.authorPublicKey !== 'string' || !post.authorPublicKey) return null;
        if (!Number.isFinite(instant(post.updatedAt))) return null;
        return { kind: 'upsert', post: post as LivePost, created: event.type === 'new_post' };
    }
    if (event.type === 'post_removed') {
        if (typeof event.id !== 'string' || !event.id) return null;
        if (event.audienceScope !== 'public') return null;
        return { kind: 'remove', id: event.id };
    }
    return null;
}

/**
 * True when the copy an app already holds is strictly newer than a pushed one, so writing the push would move
 * the listing backwards. Equal instants apply: the push may carry a change that did not move `updatedAt`.
 * A local copy with no usable timestamp never blocks a push.
 */
export function pushedPostIsStale(localUpdatedAt: unknown, pushedUpdatedAt: unknown): boolean {
    const local = instant(localUpdatedAt);
    const pushed = instant(pushedUpdatedAt);
    if (!Number.isFinite(local) || !Number.isFinite(pushed)) return false;
    return local > pushed;
}

// ===================== RECONNECT =====================

/** The backoff window starts at 1 s and doubles per failed attempt... */
export const RECONNECT_BASE_MS = 1000;
/** ...up to 30 s... */
export const RECONNECT_CAP_MS = 30_000;
/**
 * ...but never narrower than 5 s. When Cloudflare restarts an edge server every phone on it drops at once; a
 * first retry of 1 s plus up to 1 s of jitter brought them all back inside the same two seconds.
 */
export const RECONNECT_MIN_SPREAD_MS = 5000;
/** After a reconnect, the catch-up sync waits a random 0–3 s, so a node restart does not get every sync at once. */
export const RECONNECT_SYNC_SPREAD_MS = 3000;

/**
 * Full jitter: a uniformly random wait in [0, window), where the window is 1 s × 2^attempt, at least 5 s and at
 * most 30 s. `attempt` counts the retries since the socket last opened (0 for the first). Only for a socket that
 * dropped: a person bringing the app to the front reconnects at once, since that is one person, not a crowd.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
    const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
    // 2^5 already passes the cap; clamping the exponent keeps a huge count from overflowing to Infinity.
    const grown = RECONNECT_BASE_MS * 2 ** Math.min(n, 16);
    const window = Math.min(RECONNECT_CAP_MS, Math.max(RECONNECT_MIN_SPREAD_MS, grown));
    return Math.floor(random() * window);
}

/** The random wait before the catch-up sync that follows a reconnect. */
export function reconnectSyncDelayMs(random: () => number = Math.random): number {
    return Math.floor(random() * RECONNECT_SYNC_SPREAD_MS);
}

// ===================== NO ROOM =====================

/**
 * The close code a node sends a socket it has no room for (one of its caps, apps/server/src/ws-limits.ts). A refused
 * upgrade tells an app nothing (browsers and React Native hide its status), and the app came back within 30 s, so on a
 * full node every refused phone tried about four times a minute. So a node that says so (the global profile) lets the
 * socket in and closes it at once with this code and `retry=<seconds>` as the reason, and the app waits that long or
 * more before trying again, reading everything over HTTP meanwhile.
 */
export const WS_NO_ROOM_CLOSE_CODE = 4429;
/** What the node asks: 5 minutes. */
export const WS_NO_ROOM_RETRY_SEC = 300;
/** A node asking for less than this is asked for this: a wait a crowd can't turn back into a flood. */
export const WS_NO_ROOM_MIN_SEC = 30;
/** Each refusal in a row doubles the wait, up to 30 minutes (before the spread). */
export const WS_NO_ROOM_CAP_MS = 30 * 60_000;

/** The reason a node closes a socket with, for `retryAfterSec` (whole seconds). Well under a close reason's 123 bytes. */
export function wsNoRoomReason(retryAfterSec: number): string {
    return `retry=${Math.max(1, Math.round(retryAfterSec))}`;
}

/**
 * The seconds a close asks the app to wait, when it is the node's "no room" close; null for any other close. A "no
 * room" close whose reason can't be read asks for WS_NO_ROOM_RETRY_SEC.
 */
export function wsNoRoomRetrySec(code: unknown, reason: unknown): number | null {
    if (code !== WS_NO_ROOM_CLOSE_CODE) return null;
    const m = typeof reason === 'string' ? /^retry=(\d{1,6})$/.exec(reason) : null;
    return m ? Number(m[1]) : WS_NO_ROOM_RETRY_SEC;
}

/**
 * The wait before trying again after the `refusals`-th "no room" close in a row (1 for the first), when the node asked
 * for `retryAfterSec`: that (at least WS_NO_ROOM_MIN_SEC), doubled for each refusal after the first, at most
 * WS_NO_ROOM_CAP_MS, plus a random half of it again, so phones refused together do not all come back together.
 */
export function wsNoRoomDelayMs(refusals: number, retryAfterSec: number, random: () => number = Math.random): number {
    const n = Number.isFinite(refusals) && refusals > 1 ? Math.floor(refusals) - 1 : 0;
    const asked = Number.isFinite(retryAfterSec) ? Math.max(WS_NO_ROOM_MIN_SEC, retryAfterSec) : WS_NO_ROOM_RETRY_SEC;
    const window = Math.min(WS_NO_ROOM_CAP_MS, asked * 1000 * 2 ** Math.min(n, 16));
    return Math.floor(window + random() * window / 2);
}
