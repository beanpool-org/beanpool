/**
 * Forum posts on an Ask to join (slice F11; scratch/fable-design/DESIGN-forums-fable.md §13; @beanpool/core forum-ask.ts says
 * what travels and how the admins check it). Both halves, since every server can be either:
 *
 * **On the worldwide forum** (`forumPublic`): each member who writes there has a secret (`forum_members.proof_secret`, 32 random
 * bytes), and each public post of theirs carries, in its public JSON, the proof their key and that secret make for it
 * (engine/forum-public.ts). The secret is made by the main server when they are told the forum is public (engine/forum.ts
 * markForumTold, before any post of theirs can exist), or the first time they ask for it. Only they read it, with their own
 * public posts to pick from (routes/forum-ask-posts.ts, GET /api/forum/ask-posts). A standby holds the same rows, so it shows
 * the same proofs, and makes none (503 `standby` for a member who has none yet).
 *
 * **On the community asked** (routes/knocks.ts): the knock's `forumPosts` (at most three) and `forumSecret` are read whole, and
 * the proof the SIGNING key and that secret make is kept for each post (`join_requests.forum_posts`); the secret is not kept.
 * No call goes to the worldwide community, so the request is taken whether it is up, down or slow (§12: a member's request
 * never makes a server call another; a local community never needs global). The members who answer read each row with the
 * worldwide community this server points its members to (config/global-community.ts) as `forum.at`; where it points to none,
 * the posts are not kept, since no admin's app would know where to read them.
 */
import crypto from 'node:crypto';
import {
    FORUM_ASK_OFFERED, FORUM_ASK_POSTS, isForumAskHex, readForumAskPick, readKnockForum,
    word, type ForumAskPick, type KnockForum, type KnockForumPost,
} from '@beanpool/core';
import { db } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { getGlobalCommunityUrl } from '../config/global-community.js';
import { PUBLIC_POST, PUBLIC_TOPIC, publicPostProof } from './forum-public.js';

const iso = (ms: number) => new Date(ms).toISOString();

// ── The worldwide forum: the member's secret, and their posts to pick from ─────────────────────────────────────

function storedSecret(member: string): string | null {
    const row = db.prepare('SELECT proof_secret FROM forum_members WHERE member_pubkey = ?').get(member) as { proof_secret: string | null } | undefined;
    return row?.proof_secret ?? null;
}

/**
 * The member's secret, made now if they have none and this is the main server; null on a standby for a member who has none
 * (nothing is made there: its rows are its main server's). Never changes once made.
 */
export function forumProofSecret(member: string, now = Date.now()): string | null {
    const kept = storedSecret(member);
    if (kept || getNodeRole() !== 'primary') return kept;
    db.prepare(`INSERT INTO forum_members (member_pubkey, proof_secret, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(member_pubkey) DO UPDATE SET proof_secret = COALESCE(forum_members.proof_secret, excluded.proof_secret)`)
        .run(member, crypto.randomBytes(32).toString('hex'), iso(now));
    return storedSecret(member);
}

/**
 * The member's own posts anyone on the web can read now (engine/forum-public.ts's own rule: stamped, up, not hidden, in a
 * public topic), newest first, FORUM_ASK_OFFERED at most: what they may pick for an Ask to join. Each with its topic's title.
 */
export function forumAskPostsOf(member: string): ForumAskPick[] {
    const rows = db.prepare(`SELECT p.id AS postId, p.topic_id AS topicId, p.number AS number, t.title AS title
        FROM forum_posts p JOIN forum_topics t ON t.id = p.topic_id
        WHERE p.writer_pubkey = ? AND ${PUBLIC_POST('p')} AND ${PUBLIC_TOPIC('t')}
        ORDER BY p.created_at DESC, p.id DESC LIMIT ?`).all(member, FORUM_ASK_OFFERED) as ForumAskPick[];
    return rows.map(readForumAskPick).filter((p): p is ForumAskPick => p !== null);
}

// ── The community asked: what a knock keeps, and what its answerers read ───────────────────────────────────────

export const FORUM_ASK_REFUSALS = {
    tooMany: word('You can add up to 3 of your forum posts.'),
    malformed: word('One of the forum posts sent with this request can’t be read. Please pick them again.'),
} as const;

export type KnockForumOutcome = { ok: true; kept: string | null } | { ok: false; code: 'too_many_forum_posts' | 'bad_forum_posts'; error: string };

/** The worldwide community this server points its members to, as an origin (`https://host[:port]`), or null for none. */
function forumOrigin(): string | null {
    const url = getGlobalCommunityUrl();
    if (!url) return null;
    try {
        const origin = new URL(url).origin;
        return origin.startsWith('https://') ? origin : null;
    } catch {
        return null;
    }
}

/**
 * What a knock keeps of `forumPosts` and `forumSecret`: none sent, nothing; more than {@link FORUM_ASK_POSTS}, a post that
 * doesn't read, the same post twice, or posts without a secret, refused; else each post with the proof `applicant` (the key
 * that signed the knock) and the secret make, as the JSON `join_requests.forum_posts` holds. Where this server points its
 * members to no worldwide community, nothing is kept and the knock is taken plain. The secret is in no answer and no row.
 */
export function knockForumPosts(rawPosts: unknown, rawSecret: unknown, applicant: string): KnockForumOutcome {
    if (rawPosts === undefined || rawPosts === null) return { ok: true, kept: null };
    if (!Array.isArray(rawPosts)) return { ok: false, code: 'bad_forum_posts', error: FORUM_ASK_REFUSALS.malformed };
    if (rawPosts.length === 0) return { ok: true, kept: null };
    if (rawPosts.length > FORUM_ASK_POSTS) return { ok: false, code: 'too_many_forum_posts', error: FORUM_ASK_REFUSALS.tooMany };
    const picks = rawPosts.map(readForumAskPick);
    if (picks.some((p) => p === null) || new Set(picks.map((p) => p!.postId)).size !== picks.length || !isForumAskHex(rawSecret)) {
        return { ok: false, code: 'bad_forum_posts', error: FORUM_ASK_REFUSALS.malformed };
    }
    if (!forumOrigin()) return { ok: true, kept: null };
    const kept: KnockForumPost[] = [];
    for (const p of picks as ForumAskPick[]) {
        const proof = publicPostProof(p.postId, applicant, rawSecret);
        if (!proof) return { ok: false, code: 'bad_forum_posts', error: FORUM_ASK_REFUSALS.malformed };
        kept.push({ ...p, proof });
    }
    return { ok: true, kept: JSON.stringify(kept) };
}

/** A knock's forum rows as its answerers read them (`forum` in GET /api/join/knocks), or null. */
export function knockForumOf(kept: string | null): KnockForum | null {
    const at = kept ? forumOrigin() : null;
    if (!kept || !at) return null;
    try {
        return readKnockForum({ at, posts: JSON.parse(kept) });
    } catch {
        return null;
    }
}
