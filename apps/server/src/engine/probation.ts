/**
 * Probation (global profile G3, design §2.5): the daily limits on a new account, so a stranger who signs up at the
 * open door cannot flood the lobby on day one.
 *
 * ## Who is on probation
 *
 * A member is on probation for their first 72 hours AND while they have fewer than 3 kept posts: it ends only when
 * both are over. A kept post is one they wrote that a moderator has not removed and that is not hidden by reports;
 * a post they took down themselves still counts. By account age and kept posts only, never by tier (tiers are merit
 * badges and gate nothing). Not on probation: anyone holding a node role (owner, admin, moderator), who the owner
 * trusted by granting it, and everyone on a node whose `probation` switch is off, which is every local community.
 *
 * ## The limits, each over a rolling 24 hours
 *
 *   - 3 new posts (any type; one taken down since still counts, or delete-and-repost would reset it)
 *   - 5 photos on posts: the photos now on their posts written in the last 24 hours, the new post's included. An
 *     edit that brings in a photo the post did not have counts it against what is left.
 *   - 10 NEW people messaged: someone they have never written to in a DM, and who has never written to them. A
 *     reply to someone who wrote first is never limited, and neither is anyone they have written to before.
 *   - 1 knock (asking a community to let them in). Knocks are G6: `knockRefusal` is the check it calls.
 *
 * Over a limit: `ProbationLimitError`, which the routes answer 429 with a plain message naming the limit and when
 * it lets up (`resetsAt`, and `Retry-After`). There is no counter table: every count is read from the rows the
 * member wrote, so a restore, a standby or a take-over carries it with them, and there is nothing to keep in step.
 */
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { nodeRoleOf } from './node-roles.js';

const HOUR_MS = 60 * 60 * 1000;

export const PROBATION = {
    /** On probation for this long after joining... */
    hours: 72,
    /** ...and until this many kept posts. */
    keptPosts: 3,
    /** Every limit is over this rolling window. */
    windowMs: 24 * HOUR_MS,
    posts: 3,
    photos: 5,
    newDmRecipients: 10,
    knocks: 1,
} as const;

export type ProbationLimit = 'posts' | 'photos' | 'new_dm_recipients' | 'knocks';

export const PROBATION_LIMIT = 'probation_limit';

export class ProbationLimitError extends Error {
    readonly code = PROBATION_LIMIT;
    readonly status = 429;
    constructor(readonly limit: ProbationLimit, readonly resetsAt: string, message: string) {
        super(message);
        this.name = 'ProbationLimitError';
    }
}

export interface ProbationState {
    onProbation: boolean;
    /** Why a member is not on probation: the switch is off here, they hold a node role, or they are past both. */
    exemptBecause: 'off' | 'role' | null;
    /** When the first 72 hours end, or null when the join time can't be read (then only kept posts decide). */
    ageEndsAt: string | null;
    keptPosts: number;
    keptPostsNeeded: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

function joinedAtMs(pubkey: string): number | null {
    const row = db.prepare('SELECT joined_at FROM members WHERE public_key = ?').get(pubkey) as { joined_at?: string | null } | undefined;
    const ms = row?.joined_at ? Date.parse(row.joined_at) : NaN;
    return Number.isFinite(ms) ? ms : null;
}

/** The member's kept posts: written here by them, not removed by a moderator, not hidden by reports. */
export function keptPostCount(pubkey: string): number {
    const row = db.prepare(
        `SELECT COUNT(*) AS c FROM posts
          WHERE author_pubkey = ? AND origin_node IS NULL
            AND removed_by_moderator_at IS NULL AND hidden_by_reports_at IS NULL`
    ).get(pubkey) as { c: number };
    return row.c;
}

export function probationState(pubkey: string, now: number = Date.now()): ProbationState {
    const kept = keptPostCount(pubkey);
    const joined = joinedAtMs(pubkey);
    const ageEndsAt = joined === null ? null : iso(joined + PROBATION.hours * HOUR_MS);
    const base = { ageEndsAt, keptPosts: kept, keptPostsNeeded: PROBATION.keptPosts };
    if (!getProfileSwitches().probation) return { onProbation: false, exemptBecause: 'off', ...base };
    if (nodeRoleOf(pubkey)) return { onProbation: false, exemptBecause: 'role', ...base };
    // A join time that can't be read counts as old: only the kept posts decide then.
    const young = joined !== null && now < joined + PROBATION.hours * HOUR_MS;
    return { onProbation: young || kept < PROBATION.keptPosts, exemptBecause: null, ...base };
}

/** "in about 5 hours", from now to the moment a limit lets up. */
function inAbout(resetsAtMs: number, now: number): string {
    const mins = Math.max(1, Math.ceil((resetsAtMs - now) / 60_000));
    if (mins < 60) return mins === 1 ? 'in about a minute' : `in about ${mins} minutes`;
    const hours = Math.round(mins / 60);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

const WHY = 'New accounts have these limits for their first 3 days, and until 3 of their posts have stayed up.';

function refusal(limit: ProbationLimit, resetsAtMs: number, now: number): ProbationLimitError {
    const when = inAbout(resetsAtMs, now);
    const message = {
        posts: `While your account is new you can make ${PROBATION.posts} posts in any 24 hours. You can post again ${when}. ${WHY}`,
        photos: `While your account is new you can add ${PROBATION.photos} photos to posts in any 24 hours. You can add more ${when}. ${WHY}`,
        new_dm_recipients: `While your account is new you can message ${PROBATION.newDmRecipients} new people in any 24 hours. You can message someone new again ${when}. Replying to someone who wrote to you first is not limited. ${WHY}`,
        knocks: `While your account is new you can ask ${PROBATION.knocks} community a day to let you in. You can ask again ${when}. ${WHY}`,
    }[limit];
    return new ProbationLimitError(limit, iso(resetsAtMs), message);
}

/**
 * The limit's use in the window: how many, and when the oldest one counted leaves it (null when none counted).
 * `times` are the ISO instants of what counts.
 */
function inWindow(times: readonly (string | null | undefined)[], now: number): { used: number; resetsAtMs: number | null } {
    const since = now - PROBATION.windowMs;
    const ms = times.map(t => (t ? Date.parse(t) : NaN)).filter(t => Number.isFinite(t) && t > since).sort((a, b) => a - b);
    return { used: ms.length, resetsAtMs: ms.length ? ms[0] + PROBATION.windowMs : null };
}

function postTimes(pubkey: string, now: number): string[] {
    return (db.prepare(
        `SELECT created_at FROM posts WHERE author_pubkey = ? AND origin_node IS NULL AND created_at > ?`
    ).all(pubkey, iso(now - PROBATION.windowMs)) as { created_at: string }[]).map(r => r.created_at);
}

/** One entry per photo now on a post the member wrote in the window, at the post's creation time. */
function photoTimes(pubkey: string, now: number, exceptPostId?: string): string[] {
    return (db.prepare(
        `SELECT p.created_at FROM post_photos ph JOIN posts p ON p.id = ph.post_id
          WHERE p.author_pubkey = ? AND p.origin_node IS NULL AND p.created_at > ? AND p.id IS NOT ?`
    ).all(pubkey, iso(now - PROBATION.windowMs), exceptPostId ?? null) as { created_at: string }[]).map(r => r.created_at);
}

/**
 * Before a new post: throws ProbationLimitError when a member on probation has made 3 posts in the last 24 hours,
 * or when its `photoCount` photos would take them past 5.
 */
export function assertMayPost(pubkey: string, photoCount: number, now: number = Date.now()): void {
    if (!probationState(pubkey, now).onProbation) return;
    const posts = inWindow(postTimes(pubkey, now), now);
    if (posts.used >= PROBATION.posts) throw refusal('posts', posts.resetsAtMs!, now);
    assertPhotosFit(pubkey, photoCount, now);
}

function assertPhotosFit(pubkey: string, adding: number, now: number, exceptPostId?: string): void {
    if (adding <= 0) return;
    const photos = inWindow(photoTimes(pubkey, now, exceptPostId), now);
    if (photos.used + adding > PROBATION.photos) {
        // Nothing counted yet (one post with more photos than the whole allowance): a day from now.
        throw refusal('photos', photos.resetsAtMs ?? now + PROBATION.windowMs, now);
    }
}

/**
 * Before an edit that sets a post's photos. `newPhotoCount` is how many of the edit's photos the post does not
 * already have. A post written in the window counts its whole new set against the allowance; an older one, only
 * what it brings in.
 */
export function assertMayEditPhotos(pubkey: string, postId: string, photoSetSize: number, newPhotoCount: number, now: number = Date.now()): void {
    if (newPhotoCount <= 0) return;
    if (!probationState(pubkey, now).onProbation) return;
    const row = db.prepare('SELECT created_at FROM posts WHERE id = ?').get(postId) as { created_at?: string } | undefined;
    const createdMs = row?.created_at ? Date.parse(row.created_at) : NaN;
    const inside = Number.isFinite(createdMs) && createdMs > now - PROBATION.windowMs;
    assertPhotosFit(pubkey, inside ? photoSetSize : newPhotoCount, now, inside ? postId : undefined);
}

/**
 * Who the member has written to in DMs, and who has written to them: per other person, the first line each way.
 * Read from the member's own conversations (indexed), a handful for anyone on probation.
 */
function dmContacts(pubkey: string): Map<string, { mineFirst: string | null; theirsFirst: string | null }> {
    const rows = db.prepare(
        `SELECT other.public_key AS other,
                (SELECT MIN(m.timestamp) FROM messages m WHERE m.conversation_id = mine.conversation_id AND m.author_pubkey = mine.public_key) AS mine_first,
                (SELECT MIN(m.timestamp) FROM messages m WHERE m.conversation_id = mine.conversation_id AND m.author_pubkey = other.public_key) AS theirs_first
           FROM conversation_participants mine
           JOIN conversations c ON c.id = mine.conversation_id AND c.type = 'dm'
           JOIN conversation_participants other ON other.conversation_id = mine.conversation_id AND other.public_key != mine.public_key
          WHERE mine.public_key = ?`
    ).all(pubkey) as { other: string; mine_first: string | null; theirs_first: string | null }[];
    const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
    const byOther = new Map<string, { mineFirst: string | null; theirsFirst: string | null }>();
    for (const r of rows) {
        const had = byOther.get(r.other);
        byOther.set(r.other, {
            mineFirst: earliest(had?.mineFirst ?? null, r.mine_first),
            theirsFirst: earliest(had?.theirsFirst ?? null, r.theirs_first),
        });
    }
    return byOther;
}

/** When the member first wrote to each person they started a conversation with (they wrote before the other did). */
function newRecipientTimes(contacts: Map<string, { mineFirst: string | null; theirsFirst: string | null }>): string[] {
    const out: string[] = [];
    for (const { mineFirst, theirsFirst } of contacts.values()) {
        if (mineFirst && (!theirsFirst || theirsFirst > mineFirst)) out.push(mineFirst);
    }
    return out;
}

/**
 * Before a DM line from `sender` to `recipient`: throws ProbationLimitError when `recipient` would be the 11th new
 * person the sender on probation messages in 24 hours. Someone the sender has written to before, or who wrote
 * first, is never limited.
 */
export function assertMayMessage(sender: string, recipient: string, now: number = Date.now()): void {
    if (!probationState(sender, now).onProbation) return;
    const contacts = dmContacts(sender);
    const known = contacts.get(recipient);
    if (known?.mineFirst || known?.theirsFirst) return;
    const fresh = inWindow(newRecipientTimes(contacts), now);
    if (fresh.used >= PROBATION.newDmRecipients) throw refusal('new_dm_recipients', fresh.resetsAtMs!, now);
}

/**
 * G6 (knocks) calls this with the times of the member's knocks in the last 24 hours, wherever it keeps them: the
 * refusal to answer 429 with, or null. Probation is read on the node the member belongs to.
 */
export function knockRefusal(pubkey: string, knockTimes: readonly string[], now: number = Date.now()): ProbationLimitError | null {
    if (!probationState(pubkey, now).onProbation) return null;
    const knocks = inWindow(knockTimes, now);
    return knocks.used >= PROBATION.knocks ? refusal('knocks', knocks.resetsAtMs!, now) : null;
}

export interface ProbationSummary extends ProbationState {
    /** Per limit: the allowance, what is used in the last 24 hours, and when the oldest use leaves the window. */
    limits: Record<Exclude<ProbationLimit, 'knocks'>, { limit: number; used: number; resetsAt: string | null }>
        & { knocks: { limit: number } };
}

/** A member's own probation, for `GET /api/community/me`: whether, until when, and what is left today. */
export function probationSummary(pubkey: string, now: number = Date.now()): ProbationSummary {
    const state = probationState(pubkey, now);
    const posts = inWindow(postTimes(pubkey, now), now);
    const photos = inWindow(photoTimes(pubkey, now), now);
    const dms = inWindow(newRecipientTimes(dmContacts(pubkey)), now);
    const at = (ms: number | null) => (ms === null ? null : iso(ms));
    return {
        ...state,
        limits: {
            posts: { limit: PROBATION.posts, used: posts.used, resetsAt: at(posts.resetsAtMs) },
            photos: { limit: PROBATION.photos, used: photos.used, resetsAt: at(photos.resetsAtMs) },
            new_dm_recipients: { limit: PROBATION.newDmRecipients, used: dms.used, resetsAt: at(dms.resetsAtMs) },
            knocks: { limit: PROBATION.knocks },
        },
    };
}
