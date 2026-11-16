/**
 * Forum posts on an Ask to join (slice F11; scratch/fable-design/DESIGN-forums-fable.md §13, §21 F11), for the node and both
 * apps. forum.ts holds the proof itself (forumPostProof); this file holds what travels around it and the admins' check.
 *
 * - **The asker** reads their own public posts on the worldwide community, and their secret, from GET /api/forum/ask-posts
 *   there (signed, theirs only), and picks up to {@link FORUM_ASK_POSTS}. The request to join carries each pick (the post,
 *   its topic, its number and the title as it was) and the secret, as `forumPosts` and `forumSecret`.
 * - **The community asked** never calls the worldwide community (a member's request never makes a server call another, and
 *   a local community never needs global: §12). It makes, at once, the proof the asking key and that secret give for each
 *   post (forumPostProof, with the key that SIGNED the request, never a body field), keeps those proofs, and keeps the
 *   secret nowhere. So the admins never hold the asker's secret, and can't test it against the asker's other posts.
 * - **The admins** read each row under the request ({@link KnockForum}). A tap reads the post from the worldwide forum's
 *   public JSON, from their own app ({@link checkKnockForumPost}): the proof there equals the kept one only when the same key,
 *   with the same secret, wrote it. Anything else reads "Could not check", or that the post isn't there now. The request is
 *   taken whatever the worldwide community does: only the tick depends on it.
 *
 * No score, no count, no "member since": only the title, the words of the post when it is read, and the check.
 *
 * Pure and universal (the barrel is bundled for the phone): the network is the caller's `fetch`, given in.
 */
import { word, type WordKey } from './words.js';
import { FORUM_LIMITS } from './forum.js';

/** At most this many forum posts on one Ask to join (design §13). The community refuses a fourth. */
export const FORUM_ASK_POSTS = 3;
/** How many of their own public posts the worldwide community offers the asker to pick from, newest first. */
export const FORUM_ASK_OFFERED = 20;
/** How long an admin's app waits for the worldwide forum before it says "Could not check". */
export const FORUM_ASK_CHECK_MS = 8_000;

/** One post as the asker picks it: the post, its topic, its number in the topic, and the topic's title as it was. */
export interface ForumAskPick {
    postId: string;
    topicId: string;
    number: number;
    title: string;
}

/** What the worldwide community answers the asker: their secret (64 lower-case hex), and their own public posts. */
export interface ForumAskPosts {
    secret: string;
    posts: ForumAskPick[];
}

/** A row under a request: the pick, and the proof the community made of it with the asking key and the asker's secret. */
export interface KnockForumPost extends ForumAskPick {
    proof: string;
}

/** A request's forum rows: `at`, the worldwide community they are on (this community's own setting), and up to three posts. */
export interface KnockForum {
    at: string;
    posts: KnockForumPost[];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
/** Control characters but none: a title is one line. */
const CONTROL = /\p{Cc}/gu;

/** A forum post's or topic's id as both ends accept it. */
export const isForumAskId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
/** A secret or a proof: 64 lower-case hex. */
export const isForumAskHex = (v: unknown): v is string => typeof v === 'string' && HEX_64.test(v);

/** A topic's title as it travels: one line, trimmed, at most the forum's own title length. */
export function cleanForumAskTitle(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return Array.from(raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).slice(0, FORUM_LIMITS.title).join('');
}

/** One pick, read whole, or null: an id, a topic, a whole number from 1, a title. */
export function readForumAskPick(raw: unknown): ForumAskPick | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const title = cleanForumAskTitle(o.title);
    if (!isForumAskId(o.postId) || !isForumAskId(o.topicId) || !title) return null;
    if (typeof o.number !== 'number' || !Number.isSafeInteger(o.number) || o.number < 1) return null;
    return { postId: o.postId, topicId: o.topicId, number: o.number, title };
}

/** The worldwide community's answer to the asker, or null when it isn't one. Posts that don't read are left out. */
export function readForumAskPosts(raw: unknown): ForumAskPosts | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (!isForumAskHex(o.secret) || !Array.isArray(o.posts)) return null;
    const posts = o.posts.map(readForumAskPick).filter((p): p is ForumAskPick => p !== null).slice(0, FORUM_ASK_OFFERED);
    return { secret: o.secret, posts };
}

/** A request's `forum` as the apps read it, or null: an https address and one to three rows that read whole. */
export function readKnockForum(raw: unknown): KnockForum | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.at !== 'string' || !/^https:\/\/[^\s/?#]+$/.test(o.at) || !Array.isArray(o.posts)) return null;
    const posts: KnockForumPost[] = [];
    for (const p of o.posts.slice(0, FORUM_ASK_POSTS)) {
        const pick = readForumAskPick(p);
        const proof = (p as { proof?: unknown } | null)?.proof;
        if (pick && isForumAskHex(proof)) posts.push({ ...pick, proof });
    }
    return posts.length ? { at: o.at, posts } : null;
}

/** The worldwide forum's public JSON that starts at this post (30 posts after the one before it). */
export function forumAskJsonUrl(at: string, post: Pick<ForumAskPick, 'topicId' | 'number'>): string {
    return `${at}/api/forum/public/topics/${encodeURIComponent(post.topicId)}?after=${post.number - 1}`;
}

/** The worldwide forum's public page for this post, landing on it. */
export function forumAskPageUrl(at: string, post: Pick<ForumAskPick, 'topicId' | 'number'>): string {
    return `${at}/forum/t/${encodeURIComponent(post.topicId)}?after=${post.number - 1}#p${post.number}`;
}

/**
 * What an admin's check found:
 *   - `same`: the worldwide forum shows the post, and its proof is the one the asking key and secret make;
 *   - `other`: it shows the post, and its proof is not (another person's post, or another secret);
 *   - `gone`: it answered, and the post isn't there for anyone to read (removed, hidden while moderators look, a new person's,
 *     a group's, waiting for a first look, or never was);
 *   - `unknown`: it couldn't be asked, didn't answer in time, or answered something that isn't the forum.
 */
export type ForumAskCheck = 'same' | 'other' | 'gone' | 'unknown';

export interface ForumAskResult {
    check: ForumAskCheck;
    /** The post's words as the worldwide forum shows them now, when it showed it; else null. */
    words: string | null;
}

/** The check, given what the worldwide forum answered for {@link forumAskJsonUrl}: its JSON, or null for "not found". */
export function forumAskCheckOf(post: KnockForumPost, answer: unknown): ForumAskResult {
    if (answer === null) return { check: 'gone', words: null };
    const posts = (answer as { posts?: unknown } | undefined)?.posts;
    if (!Array.isArray(posts)) return { check: 'unknown', words: null };
    const shown = posts.find((p) => (p as { id?: unknown } | null)?.id === post.postId) as { proof?: unknown; words?: unknown } | undefined;
    if (!shown) return { check: 'gone', words: null };
    const words = typeof shown.words === 'string' ? shown.words : null;
    return { check: isForumAskHex(shown.proof) && shown.proof === post.proof ? 'same' : 'other', words };
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * An admin's check of one row, from their own app: one unsigned read of the worldwide forum's public JSON, given up after
 * `timeoutMs` (a slow answer is "Could not check", never a wait). Never throws.
 */
export async function checkKnockForumPost(
    at: string, post: KnockForumPost, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<ForumAskResult> {
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!fetchImpl) return { check: 'unknown', words: null };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => { controller?.abort(); resolve('late'); }, opts.timeoutMs ?? FORUM_ASK_CHECK_MS);
    });
    try {
        const read = (async (): Promise<ForumAskResult> => {
            const res = await fetchImpl(forumAskJsonUrl(at, post), { signal: controller?.signal, headers: { Accept: 'application/json' } });
            if (res.status === 404) return forumAskCheckOf(post, null);
            if (!res.ok) return { check: 'unknown', words: null };
            return forumAskCheckOf(post, await res.json());
        })();
        const first = await Promise.race([read, late]);
        return first === 'late' ? { check: 'unknown', words: null } : first;
    } catch {
        return { check: 'unknown', words: null };
    } finally {
        clearTimeout(timer);
    }
}

/** The admins' words, both apps. */
export const FORUM_ASK_WORDS = {
    /** The row under a request; each app draws the "›". */
    fromForum: word('From the worldwide forum: {title}'),
    tapToCheck: word('Tap to read it and check who wrote it'),
    open: word('Open in the forum'),
} as const;

/** The line a check reads as, by what it found (each app: `t(FORUM_ASK_CHECK_WORDS[check])`). */
export const FORUM_ASK_CHECK_WORDS: Readonly<Record<ForumAskCheck | 'checking', WordKey>> = Object.freeze({
    checking: word('Checking…'),
    same: word('Written by the same key that is asking ✓'),
    other: word('Not written by the key that is asking'),
    gone: word('This post isn’t on the worldwide forum now'),
    unknown: word('Could not check'),
});
