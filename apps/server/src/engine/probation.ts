/**
 * Probation (global profile G3, design §2.5): the daily limits on a new account, so a stranger who signs up at the
 * open door cannot flood the lobby on day one.
 *
 * ## Who is on probation
 *
 * A member is on probation for their first 72 hours AND while they have fewer than 3 kept posts: it ends only when
 * both are over. A member who came in through the 12-words door (an `open_joins` row of provider `words`, engine/
 * open-join.ts) has the words rules instead: 7 days AND 3 kept posts, and smaller limits (below), because twelve words
 * cost nothing where a sign-in costs a provider account (the two-doors design §2.3, scratch/global-node/DESIGN-global-
 * two-doors-fable.md). Every feature is the same for both; only the length and size of the limits differ, and they end
 * by themselves. Adding a sign-in (`POST /api/join/link`) moves the member to the ordinary rules at once, counted from
 * their original join. A kept post is one they wrote that a moderator has not removed and that is not hidden by reports;
 * a post they took down themselves still counts. By account age and kept posts only, never by tier (tiers are merit
 * badges and gate nothing). Not on probation: anyone holding a node role (owner, admin, moderator), who the owner
 * trusted by granting it, and everyone on a node whose `probation` switch is off, which is every local community.
 *
 * ## The limits, each over a rolling 24 hours (ordinary / 12 words)
 *
 *   - 3 / 2 new posts (any type; one taken down since still counts, or delete-and-repost would reset it)
 *   - 5 / 4 photos on posts: the photos now on their posts written in the last 24 hours, the new post's included. An
 *     edit that brings in a photo the post did not have counts it against what is left.
 *   - 10 / 3 NEW people reached in DMs, by opening a conversation with them (message or not: it is a line in their
 *     inbox) or by writing to them, when neither has reached the other before. A reply to someone who wrote or
 *     opened first is never limited, and neither is anyone they have reached before. A trade's conversation is
 *     nobody's opening (`dmContacts`).
 *   - 3 / 3 knocks (asking a community to let them in; Marty, 2026-10-01, from 1; the same for both doors):
 *     `knockRefusal`, for a node that keeps its members' knocks. G6 keeps none on the global node: the app knocks on the community itself (routes/knocks.ts),
 *     which can't see how new the applicant's global account is. There the limits are the community's own
 *     (engine/knocks.ts): one open knock per key and 3 an address a day.
 *
 * Over a limit: `ProbationLimitError`, which the routes answer 429 with a plain message naming the limit and when
 * it lets up (`resetsAt`, and `Retry-After`). There is no counter table: every count is read from the rows the
 * member wrote, so a restore, a standby or a take-over carries it with them, and there is nothing to keep in step.
 */
import { configurePollVoteOrigins } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { nodeRoleOf } from './node-roles.js';

const HOUR_MS = 60 * 60 * 1000;

export interface ProbationRules {
    /** On probation for this long after joining... */
    hours: number;
    /** ...and until this many kept posts. */
    keptPosts: number;
    /** Every limit is over this rolling window. */
    windowMs: number;
    posts: number;
    photos: number;
    newDmRecipients: number;
    knocks: number;
}

/** The ordinary rules: a member who joined with a sign-in, an invite, or any way but the 12-words door. */
export const PROBATION = {
    hours: 72,
    keptPosts: 3,
    windowMs: 24 * HOUR_MS,
    posts: 3,
    photos: 5,
    newDmRecipients: 10,
    knocks: 3,
} as const satisfies ProbationRules;

/** A member who came in with 12 words and has added no sign-in (the header). */
export const WORDS_PROBATION = {
    hours: 7 * 24,
    keptPosts: 3,
    windowMs: 24 * HOUR_MS,
    posts: 2,
    photos: 4,
    newDmRecipients: 3,
    // Knocking on a local community is the same for both doors (design §2.3).
    knocks: PROBATION.knocks,
} as const satisfies ProbationRules;

export type ProbationRuleSet = 'ordinary' | 'words';

/** Which rules a member's probation runs on: the 12-words door's while their `open_joins` row says `words`. */
export function probationRuleSet(pubkey: string): ProbationRuleSet {
    const row = db.prepare('SELECT provider FROM open_joins WHERE member_pubkey = ?').get(pubkey) as { provider: string } | undefined;
    return row?.provider === 'words' ? 'words' : 'ordinary';
}

function rulesOf(set: ProbationRuleSet): ProbationRules {
    return set === 'words' ? WORDS_PROBATION : PROBATION;
}

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
    /** Which rules: `words` for a member who came in with 12 words and has added no sign-in, else `ordinary`. */
    rules: ProbationRuleSet;
    /** When the first 72 hours (7 days by 12 words) end, or null when the join time can't be read (then only kept posts decide). */
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

/**
 * The member's kept posts: written here by them, not removed by a moderator, not hidden by reports. A post hidden by
 * reports stops counting until a moderator keeps it, so reports can hold a newcomer on probation; they can't push an
 * established member back onto it, because reports from members with less than half their standing never hide their
 * posts (engine/auto-moderation.ts).
 */
export function keptPostCount(pubkey: string): number {
    const row = db.prepare(
        `SELECT COUNT(*) AS c FROM posts
          WHERE author_pubkey = ? AND origin_node IS NULL
            AND removed_by_moderator_at IS NULL AND hidden_by_reports_at IS NULL`
    ).get(pubkey) as { c: number };
    return row.c;
}

/**
 * Where the votes on the public board's polls came from (FABLE-sec-global-abuse LOW-7: many cheap accounts voting): per
 * poll and option, the votes of members who are new or came in with 12 words. New is on probation now (`probationState`):
 * the first 72 hours, or fewer than 3 kept posts. 12 words is an `open_joins` row of provider `words` (no sign-in added),
 * however long ago, because such an account cost nothing to make and a patient person can age a thousand of them. A node
 * role (owner, admin, moderator) is neither, as for probation. Read at the time of the read, as a report is weighed:
 * a vote from someone who has since settled in stops being counted here.
 *
 * Every vote still counts in the poll's totals: this only says how many came from such accounts, never whose. A new
 * account votes as anyone does (the review's advice for polls was a label, and tiers and probation gate nothing).
 *
 * One query per 500 polls, with the same rules as `probationState` (the suite checks each voter against it): a node
 * role that acts (node-roles.ts NODE_ROLE_ACTS), a join time that can't be read counts as old, kept posts as
 * `keptPostCount`. Null where the node's probation switch is off (every local community): nobody is new there.
 */
export function pollVotesFromNewOrWords(conn: typeof db, pollIds: string[], now: number = Date.now()): Map<string, Map<string, number>> | null {
    if (!getProfileSwitches().probation) return null;
    const youngSince = iso(now - PROBATION.hours * HOUR_MS);
    const out = new Map<string, Map<string, number>>();
    for (let i = 0; i < pollIds.length; i += 500) {
        const chunk = pollIds.slice(i, i + 500);
        const rows = conn.prepare(pollVoteOriginsSql(chunk.length))
            .all(...chunk, youngSince, PROBATION.keptPosts, PROBATION.keptPosts) as { post_id: string; option_id: string; c: number }[];
        for (const r of rows) {
            let byOption = out.get(r.post_id);
            if (!byOption) out.set(r.post_id, byOption = new Map());
            byOption.set(r.option_id, r.c);
        }
    }
    return out;
}

/**
 * The query pollVotesFromNewOrWords runs for `polls` poll ids; its parameters are the ids, then when the first 72 hours
 * began, then the kept posts needed twice. Each voter is found by key, and each of their rows by index (the suite reads
 * the plan).
 */
export function pollVoteOriginsSql(polls: number): string {
    return `SELECT pv.post_id, pv.option_id, COUNT(*) AS c
              FROM poll_votes pv
              JOIN members m ON m.public_key = pv.voter_pubkey
             WHERE pv.post_id IN (${Array.from({ length: polls }, () => '?').join(',')})
               AND NOT (m.status = 'active' AND m.is_visitor = 0
                        AND EXISTS (SELECT 1 FROM node_roles nr WHERE nr.member_pubkey = m.public_key))
               AND (EXISTS (SELECT 1 FROM open_joins oj WHERE oj.member_pubkey = m.public_key AND oj.provider = 'words')
                    OR julianday(m.joined_at) > julianday(?)
                    OR (SELECT COUNT(*) FROM (SELECT 1 FROM posts p
                          WHERE p.author_pubkey = m.public_key AND p.origin_node IS NULL
                            AND p.removed_by_moderator_at IS NULL AND p.hidden_by_reports_at IS NULL LIMIT ?)) < ?)
             GROUP BY pv.post_id, pv.option_id`;
}

/** Each public poll says where its votes came from, where the node's probation switch is on (pollVotesFromNewOrWords). */
export function installPollVoteOriginsAtBoot(): void {
    configurePollVoteOrigins((conn, pollIds) => pollVotesFromNewOrWords(conn, pollIds));
}

export function probationState(pubkey: string, now: number = Date.now()): ProbationState {
    const set = probationRuleSet(pubkey);
    const rules = rulesOf(set);
    const kept = keptPostCount(pubkey);
    const joined = joinedAtMs(pubkey);
    const ageEndsAt = joined === null ? null : iso(joined + rules.hours * HOUR_MS);
    const base = { rules: set, ageEndsAt, keptPosts: kept, keptPostsNeeded: rules.keptPosts };
    if (!getProfileSwitches().probation) return { onProbation: false, exemptBecause: 'off', ...base };
    if (nodeRoleOf(pubkey)) return { onProbation: false, exemptBecause: 'role', ...base };
    // A join time that can't be read counts as old: only the kept posts decide then.
    const young = joined !== null && now < joined + rules.hours * HOUR_MS;
    return { onProbation: young || kept < rules.keptPosts, exemptBecause: null, ...base };
}

/**
 * For the checks on every post and message: the rules a member on probation runs on, or null when they are not on it.
 * The switch first, so a node without probation reads nothing more.
 */
function probationRules(pubkey: string, now: number): ProbationRules | null {
    if (!getProfileSwitches().probation) return null;
    const state = probationState(pubkey, now);
    return state.onProbation ? rulesOf(state.rules) : null;
}

/** Whether a member came in with 12 words, has added no sign-in, and is still on probation: one report hides their post. */
export function isWordsNewcomer(pubkey: string, now: number = Date.now()): boolean {
    return probationRules(pubkey, now) === WORDS_PROBATION;
}

/** "in about 5 hours", from now to the moment a limit lets up. */
function inAbout(resetsAtMs: number, now: number): string {
    const mins = Math.max(1, Math.ceil((resetsAtMs - now) / 60_000));
    if (mins < 60) return mins === 1 ? 'in about a minute' : `in about ${mins} minutes`;
    const hours = Math.round(mins / 60);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

const communities = (n: number) => (n === 1 ? '1 community' : `${n} communities`);

function why(rules: ProbationRules): string {
    return rules === WORDS_PROBATION
        ? 'Accounts made with 12 words have these limits for their first 7 days, and until 3 of their posts have stayed up. Adding a sign-in lifts them to the usual new-account limits.'
        : 'New accounts have these limits for their first 3 days, and until 3 of their posts have stayed up.';
}

function refusal(rules: ProbationRules, limit: ProbationLimit, resetsAtMs: number, now: number): ProbationLimitError {
    const when = inAbout(resetsAtMs, now);
    const WHY = why(rules);
    const message = {
        posts: `While your account is new you can make ${rules.posts} posts in any 24 hours. You can post again ${when}. ${WHY}`,
        photos: `While your account is new you can add ${rules.photos} photos to posts in any 24 hours. You can add more ${when}. ${WHY}`,
        new_dm_recipients: `While your account is new you can message ${rules.newDmRecipients} new people in any 24 hours. You can message someone new again ${when}. Replying to someone who wrote to you first is not limited. ${WHY}`,
        knocks: `While your account is new you can ask ${communities(rules.knocks)} in any 24 hours to let you in. You can ask again ${when}. ${WHY}`,
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
 * Before a new post: throws ProbationLimitError when a member on probation has made 3 posts (2 by 12 words) in the last
 * 24 hours, or when its `photoCount` photos would take them past 5 (4).
 */
export function assertMayPost(pubkey: string, photoCount: number, now: number = Date.now()): void {
    const rules = probationRules(pubkey, now);
    if (!rules) return;
    const posts = inWindow(postTimes(pubkey, now), now);
    if (posts.used >= rules.posts) throw refusal(rules, 'posts', posts.resetsAtMs!, now);
    assertPhotosFit(rules, pubkey, photoCount, now);
}

function assertPhotosFit(rules: ProbationRules, pubkey: string, adding: number, now: number, exceptPostId?: string): void {
    if (adding <= 0) return;
    const photos = inWindow(photoTimes(pubkey, now, exceptPostId), now);
    if (photos.used + adding > rules.photos) {
        // Nothing counted yet (one post with more photos than the whole allowance): a day from now.
        throw refusal(rules, 'photos', photos.resetsAtMs ?? now + rules.windowMs, now);
    }
}

/**
 * Before an edit that sets a post's photos. `newPhotoCount` is how many of the edit's photos the post does not
 * already have. A post written in the window counts its whole new set against the allowance; an older one, only
 * what it brings in.
 */
export function assertMayEditPhotos(pubkey: string, postId: string, photoSetSize: number, newPhotoCount: number, now: number = Date.now()): void {
    if (newPhotoCount <= 0) return;
    const rules = probationRules(pubkey, now);
    if (!rules) return;
    const row = db.prepare('SELECT created_at FROM posts WHERE id = ?').get(postId) as { created_at?: string } | undefined;
    const createdMs = row?.created_at ? Date.parse(row.created_at) : NaN;
    const inside = Number.isFinite(createdMs) && createdMs > now - rules.windowMs;
    assertPhotosFit(rules, pubkey, inside ? photoSetSize : newPhotoCount, now, inside ? postId : undefined);
}

/**
 * Who the member has reached in DMs, and who has reached them: per other person, the first time each way. Reaching
 * someone is opening a conversation with them or writing them a line, whichever came first: an opened conversation
 * is a line in the other person's inbox, message or not. Read from the member's own conversations (indexed), a
 * handful for anyone on probation.
 *
 * A conversation a trade opened is nobody's opening. Escrow opens it in the buyer's name without asking this limit,
 * so counting it would let a buyer write freely to everyone they accepted an offer from; between two people with a
 * trade (any row in marketplace_transactions, either way round) only a line counts, as it always has.
 */
function dmContacts(pubkey: string): Map<string, { mineFirst: string | null; theirsFirst: string | null }> {
    const rows = db.prepare(
        `SELECT other.public_key AS other, c.created_by, c.created_at,
                (SELECT MIN(t) FROM (SELECT m.timestamp AS t FROM messages m WHERE m.conversation_id = mine.conversation_id AND m.author_pubkey = mine.public_key
                                     UNION ALL SELECT w.timestamp FROM withheld_lines w WHERE w.conversation_id = mine.conversation_id AND w.author_pubkey = mine.public_key)) AS mine_first,
                (SELECT MIN(m.timestamp) FROM messages m WHERE m.conversation_id = mine.conversation_id AND m.author_pubkey = other.public_key) AS theirs_first,
                EXISTS (SELECT 1 FROM marketplace_transactions t
                         WHERE (t.buyer_pubkey = mine.public_key AND t.seller_pubkey = other.public_key)
                            OR (t.buyer_pubkey = other.public_key AND t.seller_pubkey = mine.public_key)) AS traded
           FROM conversation_participants mine
           JOIN conversations c ON c.id = mine.conversation_id AND c.type = 'dm'
           JOIN conversation_participants other ON other.conversation_id = mine.conversation_id AND other.public_key != mine.public_key
          WHERE mine.public_key = ?`
    ).all(pubkey) as { other: string; created_by: string | null; created_at: string | null; mine_first: string | null; theirs_first: string | null; traded: number }[];
    // A conversation the member opened with someone who has blocked them (engine/withheld-lines.ts) is one they reached all
    // the same, at its opening and at their first line in it: it counts as an opened one does, so their count moves as it does
    // for any chat and shows nothing of the block (#1403 re-review).
    const kept = db.prepare(
        `SELECT c.other_pubkey AS other, c.created_at,
                (SELECT MIN(w.timestamp) FROM withheld_lines w WHERE w.conversation_id = c.id AND w.author_pubkey = c.owner_pubkey) AS mine_first,
                EXISTS (SELECT 1 FROM marketplace_transactions t
                         WHERE (t.buyer_pubkey = c.owner_pubkey AND t.seller_pubkey = c.other_pubkey)
                            OR (t.buyer_pubkey = c.other_pubkey AND t.seller_pubkey = c.owner_pubkey)) AS traded
           FROM withheld_conversations c WHERE c.owner_pubkey = ?`
    ).all(pubkey) as { other: string; created_at: string | null; mine_first: string | null; traded: number }[];
    const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
    const byOther = new Map<string, { mineFirst: string | null; theirsFirst: string | null }>();
    for (const r of rows) {
        const opened = r.traded ? null : r.created_at;
        const had = byOther.get(r.other);
        byOther.set(r.other, {
            mineFirst: earliest(had?.mineFirst ?? null, earliest(r.mine_first, r.created_by === pubkey ? opened : null)),
            theirsFirst: earliest(had?.theirsFirst ?? null, earliest(r.theirs_first, r.created_by === r.other ? opened : null)),
        });
    }
    for (const r of kept) {
        const had = byOther.get(r.other);
        byOther.set(r.other, {
            mineFirst: earliest(had?.mineFirst ?? null, earliest(r.mine_first, r.traded ? null : r.created_at)),
            theirsFirst: had?.theirsFirst ?? null,
        });
    }
    return byOther;
}

/** When the member first reached each person they reached before that person reached them. */
function newRecipientTimes(contacts: Map<string, { mineFirst: string | null; theirsFirst: string | null }>): string[] {
    const out: string[] = [];
    for (const { mineFirst, theirsFirst } of contacts.values()) {
        if (mineFirst && (!theirsFirst || theirsFirst > mineFirst)) out.push(mineFirst);
    }
    return out;
}

/**
 * Before a DM line from `sender` to `recipient`, or a conversation opened with them: throws ProbationLimitError when
 * `recipient` would be the 11th (4th by 12 words) new person the sender on probation reaches in 24 hours. Someone the
 * sender has reached before, or who reached them first, is never limited.
 */
export function assertMayMessage(sender: string, recipient: string, now: number = Date.now()): void {
    const rules = probationRules(sender, now);
    if (!rules) return;
    const contacts = dmContacts(sender);
    const known = contacts.get(recipient);
    if (known?.mineFirst || known?.theirsFirst) return;
    const fresh = inWindow(newRecipientTimes(contacts), now);
    if (fresh.used >= rules.newDmRecipients) throw refusal(rules, 'new_dm_recipients', fresh.resetsAtMs!, now);
}

/**
 * The probation knock limit, given the times of the member's knocks in the last 24 hours: the refusal to answer 429
 * with, or null. Probation is read on the node the member belongs to. Not called yet: G6 keeps knocks on the community
 * knocked on, not on the applicant's node (see the list above).
 */
export function knockRefusal(pubkey: string, knockTimes: readonly string[], now: number = Date.now()): ProbationLimitError | null {
    const rules = probationRules(pubkey, now);
    if (!rules) return null;
    const knocks = inWindow(knockTimes, now);
    return knocks.used >= rules.knocks ? refusal(rules, 'knocks', knocks.resetsAtMs!, now) : null;
}

export interface ProbationSummary extends ProbationState {
    /**
     * Per limit: the allowance, what is used in the last 24 hours, what is left, and when the oldest use leaves the
     * window (one more comes back then; null when nothing is used). Knocks are G6's and kept elsewhere: the allowance only.
     */
    limits: Record<Exclude<ProbationLimit, 'knocks'>, { limit: number; used: number; remaining: number; resetsAt: string | null }>
        & { knocks: { limit: number } };
    /** The rule itself, as data: probation ends once the first `hours` are over AND `keptPosts` posts have stayed up. */
    endsWhen: { hours: number; keptPosts: number };
}

/** A member's own probation, for `GET /api/community/me`: whether, until when, and what is left today. */
export function probationSummary(pubkey: string, now: number = Date.now()): ProbationSummary {
    const state = probationState(pubkey, now);
    const rules = rulesOf(state.rules);
    const posts = inWindow(postTimes(pubkey, now), now);
    const photos = inWindow(photoTimes(pubkey, now), now);
    const dms = inWindow(newRecipientTimes(dmContacts(pubkey)), now);
    const at = (ms: number | null) => (ms === null ? null : iso(ms));
    const limit = (allowance: number, w: { used: number; resetsAtMs: number | null }) =>
        ({ limit: allowance, used: w.used, remaining: Math.max(0, allowance - w.used), resetsAt: at(w.resetsAtMs) });
    return {
        ...state,
        limits: {
            posts: limit(rules.posts, posts),
            photos: limit(rules.photos, photos),
            new_dm_recipients: limit(rules.newDmRecipients, dms),
            knocks: { limit: rules.knocks },
        },
        endsWhen: { hours: rules.hours, keptPosts: rules.keptPosts },
    };
}
