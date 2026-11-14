/**
 * The forum on the phone (slice F3; scratch/fable-design/DESIGN-forums-fable.md §2 to §6, §14, §18): the node's routes as they
 * are (apps/server/src/routes/forum.ts, slices F1, F2, F5), the shapes they answer, as the web app reads them
 * (apps/pwa/src/lib/forum.ts), and the copies this phone keeps (utils/forum-kept.ts).
 *
 * - **Kept copies.** Each read is written to this community's file as the node answered it, for this member's key only; a
 *   screen draws from the copy at once, then asks the node again. With no connection the copy is what shows.
 * - Every call is signed by the member's key (db.ts signedRequestWithMethod); the node decides who may do what, and its
 *   refusal comes back in the member's language, with its `status` and `code`.
 * - **Blocks** (design §4): the phone hides what the member blocked itself, as it does listings. A block goes to the community
 *   without waiting (utils/blocklist.ts), so until the node has it, and in every kept copy, the phone leaves out their topics
 *   and posts here; a topic of theirs reads as gone, with the web's line.
 */
import { FORUM_LIMITS, t, type ForumFollow, type ForumSectionStarts } from '@beanpool/core';
import { forumKept, signedRequestWithMethod } from './db';
import { getBlockedUsers } from './blocklist';
import { TOPIC_WORDS } from '../components/forum/forum-words';
import { loadIdentity } from './identity';
import { anchorUrl, signedGet } from './node-post';
import type { ForumKeptStore } from './forum-kept';

export interface ForumSection { id: string; starter: string | null; name: string | null; about: string | null; position: number; starts: ForumSectionStarts; listed: boolean; archived: boolean }
export interface ForumWriter { publicKey: string; name: string }
export interface ForumTopic {
    id: string; sectionId: string; title: string; writer: ForumWriter; place: string | null; lang: string | null; replyCount: number;
    lastActivityAt: string; createdAt: string; pinned: boolean; closed: string | null; removed: boolean; hidden: boolean;
    follow: ForumFollow | null; unread: boolean;
}
export interface ForumPost {
    id: string; topicId: string; number: number; writer: ForumWriter; words: string; quotes: number | null; lang: string | null;
    createdAt: string; editedAt: string | null; removed: string | null; photos: number; hidden: boolean; linksOn: boolean;
}
export interface ForumFront {
    sections: ForumSection[]; public: boolean; told: boolean; moderator: boolean; firstLooksWaiting: number | null;
    firstTopicWaits: boolean; linksOn: boolean;
}
export interface ForumWaiting {
    id: string; sectionId: string; title: string; words: string; place: string | null; lang: string | null; photos: number;
    writer: ForumWriter; createdAt: string;
}
export interface ForumList { topics: ForumTopic[]; next: number | null }
export interface ForumTopicPage { topic: ForumTopic; posts: ForumPost[]; next: number | null; lastRead: number }

/** The five reasons a moderator's No gives, as the node takes them (engine/moderation-notices.ts normaliseRemovalReason). */
export const FIRST_LOOK_NO_REASONS = ['spam', 'offensive', 'misleading', 'unsafe', 'rules'] as const;
export type FirstLookNoReason = typeof FIRST_LOOK_NO_REASONS[number];

const call = <T>(method: string, path: string, body?: unknown): Promise<T> => signedRequestWithMethod(method, path, body, { withStatus: true });
const enc = encodeURIComponent;

// ── Kept copies ──────────────────────────────────────────────────────────────────────────────────────────────────

/** This member's kept copies on this community, or null with no account here. Nothing kept is ever a reason to fail. */
async function kept(): Promise<{ me: string; store: ForumKeptStore } | null> {
    const [url, identity] = await Promise.all([anchorUrl(), loadIdentity()]);
    if (!url || !identity) return null;
    return { me: identity.publicKey, store: forumKept(url) };
}
async function keptRead<T>(kind: 'front' | 'list' | 'topic', id?: string | null): Promise<T | null> {
    try {
        const k = await kept();
        return k ? await k.store.get<T>(k.me, kind, id) : null;
    } catch {
        return null;
    }
}
async function keep(fn: (k: { me: string; store: ForumKeptStore }) => Promise<void>): Promise<void> {
    try {
        const k = await kept();
        if (k) await fn(k);
    } catch { /* a copy not written is read from the node next time */ }
}
// ── Blocks, on the phone ─────────────────────────────────────────────────────────────────────────────────────────

async function blockedKeys(): Promise<Set<string>> {
    try { return new Set(await getBlockedUsers()); } catch { return new Set(); }
}
/** A list without the topics of anyone the member blocked. */
export function listWithoutBlocked(list: ForumList, blocked: Set<string>): ForumList {
    return blocked.size ? { ...list, topics: list.topics.filter((x) => !blocked.has(x.writer.publicKey)) } : list;
}
/**
 * A topic without the posts of anyone the member blocked; null when its writer is one of them (it isn't there for this member,
 * as the node answers once it has the block).
 */
export function topicWithoutBlocked(page: ForumTopicPage, blocked: Set<string>): ForumTopicPage | null {
    if (!blocked.size) return page;
    if (blocked.has(page.topic.writer.publicKey)) return null;
    return { ...page, posts: page.posts.filter((p) => !blocked.has(p.writer.publicKey)) };
}
/** The node's "not here for you", for a topic whose writer the member blocked: the topic screen goes back and says so. */
function blockedTopicGone(page: ForumTopicPage): Error {
    return Object.assign(new Error(t(TOPIC_WORDS.goneBlocked, { name: page.topic.writer.name || t(TOPIC_WORDS.member) })), { status: 404, code: 'not_found' });
}

export const keptForumFront = () => keptRead<ForumFront>('front');
export const keptForumList = async (sectionId: string | null) => {
    const list = await keptRead<ForumList>('list', sectionId);
    return list ? listWithoutBlocked(list, await blockedKeys()) : null;
};
export const keptForumTopic = async (id: string) => {
    const page = await keptRead<ForumTopicPage>('topic', id);
    return page ? topicWithoutBlocked(page, await blockedKeys()) : null;
};
export const forgetForumTopic = (id: string) => keep((k) => k.store.forgetTopic(k.me, id));

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function getForumFront(): Promise<ForumFront> {
    const front = await call<ForumFront>('GET', '/api/forum');
    await keep((k) => k.store.keepFront(k.me, front));
    return front;
}

/** One page of topics (30), pinned first then the newest activity; `offset` 0 replaces the kept list, a later page adds. */
export async function getForumTopics(sectionId: string | null, offset = 0): Promise<ForumList> {
    const q = [sectionId ? `section=${enc(sectionId)}` : '', offset ? `offset=${offset}` : ''].filter(Boolean).join('&');
    const page = await call<ForumList>('GET', `/api/forum/topics${q ? `?${q}` : ''}`);
    const before = offset ? (await keptForumList(sectionId))?.topics ?? [] : [];
    const merged = { topics: [...before.filter((t) => !page.topics.some((p) => p.id === t.id)), ...page.topics], next: page.next };
    await keep((k) => k.store.keepList(k.me, sectionId, merged));
    return listWithoutBlocked(merged, await blockedKeys());
}

/** A topic and its posts after number `after` (30 a read); `after` 0 replaces the kept read, a later one adds its posts. */
export async function getForumTopic(id: string, after = 0): Promise<ForumTopicPage> {
    const page = await call<ForumTopicPage>('GET', `/api/forum/topics/${enc(id)}${after ? `?after=${after}` : ''}`);
    const before = after ? (await keptForumTopic(id))?.posts ?? [] : [];
    const merged = { ...page, posts: [...before.filter((p) => p.number <= after), ...page.posts] };
    const shown = topicWithoutBlocked(merged, await blockedKeys());
    if (!shown) {
        await forgetForumTopic(id);
        throw blockedTopicGone(merged);
    }
    await keep((k) => k.store.keepTopic(k.me, id, merged, merged.topic.follow === 'following'));
    return shown;
}

const photoUris = new Map<string, Promise<string | null>>();
/** A post's photo (or a waiting topic's, `waiting`) as a data address an <Image> can draw, read signed once; null if gone. */
export function forumPhotoUri(id: string, n: number, waiting = false): Promise<string | null> {
    const path = waiting ? `/api/forum/first-looks/${enc(id)}/photos/${n}` : `/api/forum/posts/${enc(id)}/photos/${n}`;
    let uri = photoUris.get(path);
    if (!uri) {
        uri = (async () => {
            const [url, identity] = await Promise.all([anchorUrl(), loadIdentity()]);
            if (!url || !identity) return null;
            const res = await signedGet(url, path, identity);
            if (!res.ok) return null;
            const blob = await res.blob();
            return await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(new Error('unreadable photo'));
                reader.readAsDataURL(blob);
            });
        })().catch(() => null);
        photoUris.set(path, uri);
        // A failed read is asked again next time, not kept as gone.
        void uri.then((u) => { if (!u) photoUris.delete(path); });
    }
    return uri;
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NewTopicInput { sectionId: string; title: string; words: string; place?: string; lang?: string; photos?: string[] }

/** A new topic: up at once ({ topic, post }), or a new member's first topic waiting for a moderator's look ({ waiting }). */
export const startForumTopic = (input: NewTopicInput) =>
    call<{ topic: ForumTopic; post: ForumPost } | { waiting: ForumWaiting }>('POST', '/api/forum/topics', input);

export async function replyInForum(topicId: string, input: { words: string; quotes?: number | null; lang?: string }): Promise<ForumPost> {
    const body: Record<string, unknown> = { words: input.words };
    if (input.quotes) body.quotes = input.quotes;
    if (input.lang) body.lang = input.lang;
    return (await call<{ post: ForumPost }>('POST', `/api/forum/topics/${enc(topicId)}/replies`, body)).post;
}

/** The member read that anyone on the web can read this forum with their name (a public forum's first post waits on it). */
export async function markForumTold(): Promise<void> {
    await call('POST', '/api/forum/told', {});
    const front = await keptForumFront();
    if (front) await keep((k) => k.store.keepFront(k.me, { ...front, told: true }));
}

export const followForumTopic = async (topicId: string, follow: ForumFollow | null) =>
    (await call<{ follow: ForumFollow | null }>('POST', `/api/forum/topics/${enc(topicId)}/follow`, { follow })).follow;
/** They opened it up to post `upTo`: the unread dot moves, and the forum's own bell rows for it come off (slice F5). */
export const readForumTopic = async (topicId: string, upTo: number) =>
    (await call<{ lastRead: number }>('POST', `/api/forum/topics/${enc(topicId)}/read`, { upTo })).lastRead;
export const closeForumTopic = async (topicId: string) => (await call<{ topic: ForumTopic }>('POST', `/api/forum/topics/${enc(topicId)}/close`, {})).topic;
export const removeForumPost = (postId: string) => call('POST', `/api/forum/posts/${enc(postId)}/remove`, {});
/** A report of a forum post (slice F2): about its writer; answered in Settings. */
export const reportForumPost = (postId: string, reason: string) => call('POST', '/api/reports', { targetForumPostId: postId, reason });

// ── First looks (slice F2) ───────────────────────────────────────────────────────────────────────────────────────

export const listFirstLooks = () => call<{ waiting: ForumWaiting[] }>('GET', '/api/forum/first-looks');
export const myFirstLook = () => call<{ waiting: ForumWaiting | null; usuallyWithinHours: number | null }>('GET', '/api/forum/first-looks/mine');
export const okFirstLook = async (id: string) => (await call<{ topicId: string }>('POST', `/api/forum/first-looks/${enc(id)}/ok`, {})).topicId;
export const noFirstLook = (id: string, reason: FirstLookNoReason) => call('POST', `/api/forum/first-looks/${enc(id)}/no`, { reason });
export const withdrawFirstLook = (id: string) => call('POST', `/api/forum/first-looks/${enc(id)}/withdraw`, {});

/** Whether a reply's or an opening's words fit (the node holds the same numbers and refuses past them). */
export const forumWordsFit = (words: string, opening: boolean): boolean =>
    Array.from(words.trim()).length <= (opening ? FORUM_LIMITS.opening : FORUM_LIMITS.reply);

// ── What the list says on the member's way back ──────────────────────────────────────────────────────────────────

let backLine: { kind: 'sent' } | { kind: 'gone'; words: string } | null = null;
/** A first topic sent for a look, or a topic gone by the member's own action: the list's one line when they are back on it. */
export function noteForumBack(line: { kind: 'sent' } | { kind: 'gone'; words: string }): void { backLine = line; }
/** That line, once. */
export function takeForumBack(): typeof backLine { const line = backLine; backLine = null; return line; }
