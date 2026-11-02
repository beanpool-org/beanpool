/**
 * A pin (scratch/fable-design/DESIGN-pinning-fable.md): an owner's or admin's choice to hold one public post at the top of the
 * Market for a day, three days or a week, three at most for the whole community. It changes the order and nothing else:
 * no Bean, no balance, no push, no limit.
 *
 * - Who: by the role the signed actor holds now (nodeRoleOf), never a value from the request. Not a moderator: their job is
 *   reports and takedowns, and a pin is the community's editorial voice. Not a token or an assistant: the routes are signed
 *   member routes, which neither reaches, and the assistant has no tool for it (§0.3 question 4).
 * - What: a post of this community's, on the board and public (@beanpool/core pinLive, PIN_ON_BOARD_SQL). Refused in words
 *   otherwise, each with a code.
 * - How many: the pin write counts and writes in one transaction that holds SQLite's write lock from its first statement, so
 *   two racing writes are one after the other. It first takes off any pin that no longer stands (clearEndedPins), so what it
 *   counts is the stamps left, and a post whose author comes back from holiday can't return past the three.
 * - How it ends: by the clock on every read (the rule and the route's ETag need no sweep), when its post leaves the board
 *   (schema.sql posts_pin_ends_off_board), when a repeating event moves on (engine/event-series-roll.ts), or when an owner,
 *   an admin or the post's author takes it off. The hourly hygiene clears what time ended (runMarketplaceHygiene).
 *
 * Every write moves the row's `updated_at` and the listings' version, so every app's next read and a standby's delta carry it.
 */
import { PINS_MAX, isPinDays, word } from '@beanpool/core';
import { PIN_ON_BOARD_SQL, clearEndedPins } from '@beanpool/engine';
import { db } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { assertNotMuted } from './auto-moderation.js';
import { nodeRoleOf } from './node-roles.js';
import { bumpPostsVersion } from './versions.js';

/** A pin refused: its status (400, 403, 404 or 409), its sentence and its code, so an app can say why. */
export class PinRefusal extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'PinRefusal';
    }
}

export const PIN_NOT_ALLOWED = word('Only an owner or admin can pin a post.');
export const UNPIN_NOT_ALLOWED = word("Only an owner, an admin or the post's author can take a pin off.");
export const PIN_BAD_DAYS = word('A pin lasts 1 day, 3 days or 1 week.');
export const PIN_NOT_FOUND = word('That post is no longer here.');
export const PIN_NOT_PUBLIC = word('Only a public post can be pinned.');
export const PIN_NOT_LOCAL = word("Only this community's own posts can be pinned.");
export const PIN_ENDED = word("This post has ended, so it can't be pinned.");
export const PINS_FULL = word('Three posts are pinned already. Take one off first.');

const DAY_MS = 86_400_000;
const POST_ID_MAX = 200;

/** An owner or an admin, by the role this key holds now. A key with no active member row holds none. */
function mayPin(actor: string): boolean {
    const role = nodeRoleOf(actor);
    return role === 'owner' || role === 'admin';
}

interface PinRow {
    id: string;
    author_pubkey: string;
    audience_scope: string | null;
    origin_node: string | null;
    pinned_until: string | null;
    is_treasury: number | null;
    /** 1 when the row is on the board and its time rule holds (PIN_ON_BOARD_SQL). */
    on_board: number;
}

function pinRow(postId: unknown, nowIso: string): PinRow | undefined {
    if (typeof postId !== 'string' || postId === '' || postId.length > POST_ID_MAX) return undefined;
    return db.prepare(`
        SELECT p.id, p.author_pubkey, p.audience_scope, p.origin_node, p.pinned_until, m.is_treasury,
               CASE WHEN ${PIN_ON_BOARD_SQL} THEN 1 ELSE 0 END AS on_board
          FROM posts p LEFT JOIN members m ON m.public_key = p.author_pubkey
         WHERE p.id = ?`).get(nowIso, nowIso, postId) as PinRow | undefined;
}

export interface PinAnswer {
    postId: string;
    pinnedUntil: string | null;
    pinnedAt: string | null;
    changed: boolean;
}

/**
 * Pins a post for `days` (@beanpool/core PIN_CHOICES), for an owner or an admin. Pinning a pinned post again sets a new end
 * from now. Refused, writing nothing: 403 pin_not_allowed, 400 pin_bad_days, 404 pin_not_found, 400 pin_not_local,
 * 400 pin_not_public, 400 pin_ended (off the board, for any reason), 409 pins_full, and a muted pinner's own refusal: a pin
 * publishes, as a featured Offer does. On a standby, its 409 (config/node-role.ts): a pin there would be one no delta
 * replaces, past the three after a take-over.
 */
export function pinPost(postId: unknown, actor: string, days: unknown, now: number = Date.now()): PinAnswer {
    assertPlainTablesWritable();
    if (!mayPin(actor)) throw new PinRefusal(403, 'pin_not_allowed', PIN_NOT_ALLOWED);
    if (!isPinDays(days)) throw new PinRefusal(400, 'pin_bad_days', PIN_BAD_DAYS);
    assertNotMuted(actor, now);
    const nowIso = new Date(now).toISOString();
    const until = new Date(now + days * DAY_MS).toISOString();
    const done = db.transaction((): PinAnswer => {
        const post = pinRow(postId, nowIso);
        if (!post) throw new PinRefusal(404, 'pin_not_found', PIN_NOT_FOUND);
        if (post.origin_node !== null) throw new PinRefusal(400, 'pin_not_local', PIN_NOT_LOCAL);
        if ((post.audience_scope ?? 'public') !== 'public') throw new PinRefusal(400, 'pin_not_public', PIN_NOT_PUBLIC);
        if (post.on_board !== 1) throw new PinRefusal(400, 'pin_ended', PIN_ENDED);
        clearEndedPins(db, nowIso);
        const others = (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE pinned_until IS NOT NULL AND id != ?').get(post.id) as { n: number }).n;
        if (others >= PINS_MAX) throw new PinRefusal(409, 'pins_full', PINS_FULL);
        db.prepare('UPDATE posts SET pinned_until = ?, pinned_at = ?, updated_at = ? WHERE id = ?').run(until, nowIso, nowIso, post.id);
        return { postId: post.id, pinnedUntil: until, pinnedAt: nowIso, changed: true };
    }).immediate();
    // Only here: a refusal takes the tidying back with the rest of the transaction, so it moved nothing.
    bumpPostsVersion();
    return done;
}

/**
 * Takes a pin off, for an owner, an admin, the post's author, or a keeper of the enterprise that posted it. Their post,
 * their say. Anyone else hears one refusal, whether or not the post is there or pinned: 403 pin_off_not_allowed. Taking off
 * one that isn't pinned is nothing.
 */
export function unpinPost(postId: unknown, actor: string, mayKeep: (actor: string, enterprise: string) => boolean, now: number = Date.now()): PinAnswer {
    assertPlainTablesWritable();
    const nowIso = new Date(now).toISOString();
    const done = db.transaction((): PinAnswer => {
        const post = pinRow(postId, nowIso);
        const theirs = !!post && (post.author_pubkey === actor || (post.is_treasury === 1 && mayKeep(actor, post.author_pubkey)));
        if (!theirs && !mayPin(actor)) throw new PinRefusal(403, 'pin_off_not_allowed', UNPIN_NOT_ALLOWED);
        if (!post) throw new PinRefusal(404, 'pin_not_found', PIN_NOT_FOUND);
        if (post.pinned_until === null) return { postId: post.id, pinnedUntil: null, pinnedAt: null, changed: false };
        db.prepare('UPDATE posts SET pinned_until = NULL, pinned_at = NULL, updated_at = ? WHERE id = ?').run(nowIso, post.id);
        return { postId: post.id, pinnedUntil: null, pinnedAt: null, changed: true };
    }).immediate();
    if (done.changed) bumpPostsVersion();
    return done;
}

/** The hygiene's turn (state-engine.ts runMarketplaceHygiene, a main server's alone): clears the pins that ended. */
export function tidyEndedPins(now: number = Date.now()): number {
    const cleared = clearEndedPins(db, new Date(now).toISOString());
    if (cleared > 0) bumpPostsVersion();
    return cleared;
}
