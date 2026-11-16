/**
 * Forum posts on an Ask to join (slice F11; scratch/fable-design/DESIGN-forums-fable.md §13, §21 F11), for the node and both
 * apps. forum.ts holds the proof itself (forumPostProof); this file holds what travels around it and the admins' check.
 *
 * - **The asker** reads their own public posts on the worldwide community, and their secret, from GET /api/forum/ask-posts
 *   there (signed, theirs only), and picks up to {@link FORUM_ASK_POSTS}. The request to join names each pick (the post, its
 *   topic and its number there: {@link ForumAskNamed}, no words of any kind) and carries the secret, as `forumPosts` and
 *   `forumSecret`. Anything else sent with a pick (a title, words) is read by nobody and kept nowhere.
 * - **The community asked** never calls the worldwide community (a member's request never makes a server call another, and
 *   a local community never needs global: §12). It makes, at once, the proof the asking key and that secret give for each
 *   post (forumPostProof, with the key that SIGNED the request, never a body field), keeps those proofs, and keeps the
 *   secret nowhere. So the admins never hold the asker's secret, and can't test it against the asker's other posts.
 * - **The admins** read each row under the request ({@link KnockForum}). A tap reads the post from the worldwide forum's
 *   public JSON, from their own app ({@link checkKnockForumPost}): the proof there equals the kept one only when the same key,
 *   with the same secret, wrote it. Anything else reads "Could not check", or that the post isn't there now. The request is
 *   taken whatever the worldwide community does: only the tick depends on it.
 * - **What a row shows** ({@link knockForumRowView}, both apps): every title, word, topic and number beside or under the tick
 *   is the worldwide forum's, read from its answer at that check ({@link ForumAskShown}), never the request's. Before a check
 *   answers, and when it can't, the row says only that a post was named, and the check's line.
 *
 * No score, no count, no "member since": only the forum's title, the words of the post when it is read, and the check.
 *
 * Pure and universal (the barrel is bundled for the phone): the network is the caller's `fetch`, given in.
 */
import { t, word, type WordKey } from './words.js';
import { FORUM_LIMITS } from './forum.js';

/** At most this many forum posts on one Ask to join (design §13). The community refuses a fourth. */
export const FORUM_ASK_POSTS = 3;
/** How many of their own public posts the worldwide community offers the asker to pick from, newest first. */
export const FORUM_ASK_OFFERED = 20;
/** How long an admin's app waits for the worldwide forum before it says "Could not check". */
export const FORUM_ASK_CHECK_MS = 8_000;

/**
 * A post as a request to join names it: the post, its topic, and its number in the topic (where the admins' check reads it).
 * Nothing a person reads: the apps show only what the worldwide forum answers for it at check time.
 */
export interface ForumAskNamed {
    postId: string;
    topicId: string;
    number: number;
}

/** One of the asker's own posts as the worldwide community offers it to them: the post, and its topic's title there. */
export interface ForumAskPick extends ForumAskNamed {
    title: string;
}

/** What the worldwide community answers the asker: their secret (64 lower-case hex), and their own public posts. */
export interface ForumAskPosts {
    secret: string;
    posts: ForumAskPick[];
}

/** A row under a request: the post it names, and the proof the community made of it with the asking key and the asker's secret. */
export interface KnockForumPost extends ForumAskNamed {
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
/** A post's number in its topic: a whole number from 1. */
const isPostNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

/** A topic's title as it travels: one line, trimmed, at most the forum's own title length. */
export function cleanForumAskTitle(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return Array.from(raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).slice(0, FORUM_LIMITS.title).join('');
}

/** A post a request names, read whole, or null: an id, a topic, a whole number from 1. Anything else sent with it is dropped. */
export function readForumAskNamed(raw: unknown): ForumAskNamed | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (!isForumAskId(o.postId) || !isForumAskId(o.topicId) || !isPostNumber(o.number)) return null;
    return { postId: o.postId, topicId: o.topicId, number: o.number };
}

/** One of the asker's own posts as the worldwide community offers it, read whole, or null: a named post and a title. */
export function readForumAskPick(raw: unknown): ForumAskPick | null {
    const named = readForumAskNamed(raw);
    const title = named ? cleanForumAskTitle((raw as { title?: unknown }).title) : '';
    return named && title ? { ...named, title } : null;
}

/** The worldwide community's answer to the asker, or null when it isn't one. Posts that don't read are left out. */
export function readForumAskPosts(raw: unknown): ForumAskPosts | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (!isForumAskHex(o.secret) || !Array.isArray(o.posts)) return null;
    const posts = o.posts.map(readForumAskPick).filter((p): p is ForumAskPick => p !== null).slice(0, FORUM_ASK_OFFERED);
    return { secret: o.secret, posts };
}

// ── The asker's picker (F11b): what a request to join sends ─────────────────────────────────────────────────────

/** The path both apps read the asker's own posts from, on the worldwide community, signed with the asker's key. */
export const FORUM_ASK_POSTS_PATH = '/api/forum/ask-posts';

/** What a request to join carries of the asker's picks (POST /api/join/knock `forumPosts` and `forumSecret`). */
export interface ForumAskSend {
    forumPosts: ForumAskNamed[];
    forumSecret: string;
}

/**
 * The picks after a tap on `postId`: a picked post is taken off; another is added, unless {@link FORUM_ASK_POSTS} are
 * picked already (then nothing changes: the picker says how to pick another).
 */
export function toggleForumAskPick(picked: readonly string[], postId: string): string[] {
    if (picked.includes(postId)) return picked.filter((p) => p !== postId);
    return picked.length >= FORUM_ASK_POSTS ? [...picked] : [...picked, postId];
}

/**
 * What a request to join sends of the asker's picks, or null to send none (the request goes plain). Only posts the worldwide
 * community offered this asker as their own (`offered`: its answer to {@link FORUM_ASK_POSTS_PATH}, read with the key that
 * will sign the request) go: a pick that isn't on that list (another writer's post, one gone from it, an id made up) is never
 * sent. In the order picked, each once, at most {@link FORUM_ASK_POSTS}, and named by post, topic and number only: no title.
 */
export function forumAskSend(offered: ForumAskPosts | null, picked: readonly string[]): ForumAskSend | null {
    if (!offered || !isForumAskHex(offered.secret)) return null;
    const own = new Map<string, ForumAskNamed>();
    for (const p of offered.posts) {
        const named = readForumAskNamed(p);
        if (named && !own.has(named.postId)) own.set(named.postId, named);
    }
    const forumPosts: ForumAskNamed[] = [];
    for (const id of new Set(picked)) {
        const named = own.get(id);
        if (named && forumPosts.length < FORUM_ASK_POSTS) forumPosts.push(named);
    }
    return forumPosts.length ? { forumPosts, forumSecret: offered.secret } : null;
}

/** The picker's words, both apps (on the Ask to join form, under "A few words about yourself"). */
export const FORUM_ASK_PICKER_WORDS = {
    heading: word('Add up to three of your worldwide forum posts (optional)'),
    about: word('The community’s admins can read them and see that you wrote them.'),
    /** Under a post's topic title: where the post is in that topic (1 is the post that started it). */
    post: word('Post {number}'),
    full: word('Three picked. Tap one to take it off.'),
} as const;

/**
 * A request's `forum` as the apps read it, or null: an https address and one to three rows that read whole. Each row is the
 * post it names and its proof, nothing else: any other field in the answer (a title, words) is dropped here.
 */
export function readKnockForum(raw: unknown): KnockForum | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.at !== 'string' || !/^https:\/\/[^\s/?#]+$/.test(o.at) || !Array.isArray(o.posts)) return null;
    const posts: KnockForumPost[] = [];
    for (const p of o.posts.slice(0, FORUM_ASK_POSTS)) {
        const named = readForumAskNamed(p);
        const proof = (p as { proof?: unknown } | null)?.proof;
        if (named && isForumAskHex(proof)) posts.push({ ...named, proof });
    }
    return posts.length ? { at: o.at, posts } : null;
}

/** The worldwide forum's public JSON that starts at this post (30 posts after the one before it). */
export function forumAskJsonUrl(at: string, post: Pick<ForumAskNamed, 'topicId' | 'number'>): string {
    return `${at}/api/forum/public/topics/${encodeURIComponent(post.topicId)}?after=${post.number - 1}`;
}

/** The worldwide forum's public page for this post, landing on it. */
export function forumAskPageUrl(at: string, post: Pick<ForumAskNamed, 'topicId' | 'number'>): string {
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

/**
 * The post as the worldwide forum showed it at a check: every field read from its answer, none from the request. The topic
 * and number are the post's own there, so "Open in the forum" lands where the forum has it, whatever number was named.
 */
export interface ForumAskShown {
    /** The topic's title as the forum shows it (one line), or null when its answer gave none for this post's topic. */
    title: string | null;
    /** The post's words as the forum shows them now, or null when its answer gave none. */
    words: string | null;
    topicId: string;
    number: number;
}

export interface ForumAskResult {
    check: ForumAskCheck;
    /** What the forum showed of the post: only for `same` and `other`; else null. */
    shown: ForumAskShown | null;
}

const UNKNOWN: ForumAskResult = Object.freeze({ check: 'unknown', shown: null });
const GONE: ForumAskResult = Object.freeze({ check: 'gone', shown: null });

/**
 * The check, given what the worldwide forum answered for {@link forumAskJsonUrl}: its JSON, or null for "not found". A post
 * shown without a topic or a number that reads is an answer that isn't the forum's: "Could not check".
 */
export function forumAskCheckOf(post: KnockForumPost, answer: unknown): ForumAskResult {
    if (answer === null) return GONE;
    if (!answer || typeof answer !== 'object') return UNKNOWN;
    const { posts, topic } = answer as { posts?: unknown; topic?: unknown };
    if (!Array.isArray(posts)) return UNKNOWN;
    const found = posts.find((p) => (p as { id?: unknown } | null)?.id === post.postId) as
        { topicId?: unknown; number?: unknown; proof?: unknown; words?: unknown } | undefined;
    if (!found) return GONE;
    if (!isForumAskId(found.topicId) || !isPostNumber(found.number)) return UNKNOWN;
    const its = topic && typeof topic === 'object' ? topic as { id?: unknown; title?: unknown } : null;
    const shown: ForumAskShown = {
        title: (its?.id === found.topicId && cleanForumAskTitle(its.title)) || null,
        words: typeof found.words === 'string' ? found.words : null,
        topicId: found.topicId,
        number: found.number,
    };
    return { check: isForumAskHex(found.proof) && found.proof === post.proof ? 'same' : 'other', shown };
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
    if (!fetchImpl) return UNKNOWN;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => { controller?.abort(); resolve('late'); }, opts.timeoutMs ?? FORUM_ASK_CHECK_MS);
    });
    try {
        const read = (async (): Promise<ForumAskResult> => {
            const res = await fetchImpl(forumAskJsonUrl(at, post), { signal: controller?.signal, headers: { Accept: 'application/json' } });
            if (res.status === 404) return forumAskCheckOf(post, null);
            if (!res.ok) return UNKNOWN;
            return forumAskCheckOf(post, await res.json());
        })();
        const first = await Promise.race([read, late]);
        return first === 'late' ? UNKNOWN : first;
    } catch {
        return UNKNOWN;
    } finally {
        clearTimeout(timer);
    }
}

/** The admins' words, both apps. */
export const FORUM_ASK_WORDS = {
    /** A row's headline once a check has read the post: the topic's title as the forum shows it. Each app draws the "›". */
    fromForum: word('From the worldwide forum: {title}'),
    /** A row's headline before a check has read the post, or when it couldn't: only that a post was named. */
    named: word('A post on the worldwide forum'),
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

/** A row's check, as each app holds it: not asked yet, asked and waiting, or what it found. */
export type KnockForumRowState = ForumAskResult | 'checking' | undefined;

/** Everything one row under a request shows, both apps (each draws it its own way, and draws nothing else on the row). */
export interface KnockForumRowView {
    /** "From the worldwide forum: {the forum's title}" once a check has read the post; until then "A post on the worldwide forum". */
    headline: string;
    /** "Tap to read it…", "Checking…", or what the check found. */
    line: string;
    /** `same` and `other` are drawn in their colours; null is the plain line. */
    tone: 'same' | 'other' | null;
    /** The post's words as the forum showed them at the check, or null. */
    words: string | null;
    /**
     * "Open in the forum": where the forum has the post, after a check that read it; the named place after one that couldn't
     * ask (the forum's own page, so the admin can look there themselves); none for a post not there, or before a check.
     */
    openUrl: string | null;
    /** The row's accessible name: the headline and the line, so a screen reader says the check's answer with the row. */
    label: string;
}

/**
 * What a row shows, from the forum's answer only ({@link ForumAskShown}): the request names a post and carries a proof, and
 * nothing it carried is drawn as the forum's.
 */
export function knockForumRowView(at: string, post: KnockForumPost, state: KnockForumRowState): KnockForumRowView {
    const done = state && state !== 'checking' ? state : null;
    const shown = done?.shown ?? null;
    const headline = shown?.title ? t(FORUM_ASK_WORDS.fromForum, { title: shown.title }) : t(FORUM_ASK_WORDS.named);
    const line = state === undefined ? t(FORUM_ASK_WORDS.tapToCheck) : t(FORUM_ASK_CHECK_WORDS[state === 'checking' ? 'checking' : state.check]);
    const tone = done?.check === 'same' || done?.check === 'other' ? done.check : null;
    const openUrl = shown ? forumAskPageUrl(at, shown) : done?.check === 'unknown' ? forumAskPageUrl(at, post) : null;
    return { headline, line, tone, words: shown?.words ?? null, openUrl, label: `${headline}. ${line}` };
}
