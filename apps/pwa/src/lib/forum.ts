/**
 * The forum on the web (slice F4; scratch/fable-design/DESIGN-forums-fable.md §2 to §6, §14, §18): the node's routes as they
 * are (apps/server/src/routes/forum.ts, slices F1, F2, F5), the shapes they answer, and the copies the page keeps.
 *
 * - **Kept copies, web.** The design's offline reading is the phone's; on the web the forum is read "while the page is open"
 *   (§18). So the last front, each section's list and each topic read are kept here, in memory, for this page's life: going
 *   to Chats and back, or to a topic and back, draws at once from them, then asks the node again. Nothing is written to the
 *   browser's storage, so nothing of a members-only forum outlives the tab.
 * - **Photos** are members' bytes behind a signed read, so an <img> can't fetch them itself: each is read signed and drawn
 *   from an object address, kept for the page's life too.
 * - Every write is signed by the member's key (lib/api.ts request); the node decides who may do what, and its refusal comes
 *   back in the member's language with its `code`.
 */
import { FORUM_LIMITS, type ForumFollow, type ForumSectionStarts } from '@beanpool/core';
import { request, signedFetch } from './api';

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
export interface ForumTopicPage { topic: ForumTopic; posts: ForumPost[]; next: number | null; lastRead: number }
/** A search's hit (slice F6): the post, its topic's title ('' for a topic its writer removed, its replies kept), its words around the find. */
export interface ForumSearchHit {
    topicId: string; sectionId: string; title: string; postId: string; number: number; writer: ForumWriter; createdAt: string; excerpt: string;
}
export interface ForumSearchAnswer { q: string; hits: ForumSearchHit[]; next: number | null }

/** The five reasons a moderator's No gives, as the node takes them (engine/moderation-notices.ts normaliseRemovalReason). */
export const FIRST_LOOK_NO_REASONS = ['spam', 'offensive', 'misleading', 'unsafe', 'rules'] as const;
export type FirstLookNoReason = typeof FIRST_LOOK_NO_REASONS[number];

// ── Kept copies, for this page's life ──────────────────────────────────────────────────────────────────────────

const kept = {
    front: null as ForumFront | null,
    lists: new Map<string, { topics: ForumTopic[]; next: number | null }>(),
    topics: new Map<string, ForumTopicPage>(),
    /** The last search and what it found, so back from a hit it shows again without asking (each search counts, 100 a day). */
    search: null as ForumSearchAnswer | null,
};
/** The key a section's list is kept under: '' for every section. */
const listKey = (sectionId: string | null) => sectionId ?? '';
export const keptFront = (): ForumFront | null => kept.front;
export const keptList = (sectionId: string | null) => kept.lists.get(listKey(sectionId)) ?? null;
export const keptTopic = (id: string): ForumTopicPage | null => kept.topics.get(id) ?? null;
export const keptSearch = (): ForumSearchAnswer | null => kept.search;
/** The member cleared the search: the list shows again, and nothing of it is kept. */
export function forgetForumSearch(): void {
    kept.search = null;
}
/** Whose copies these are: another account in this tab starts with none (keepForumFor). */
let keptFor: string | null = null;
/** The copies are this member's: when the account in this tab changed, the last one's are dropped first. Idempotent. */
export function keepForumFor(me: string): void {
    if (keptFor === me) return;
    forgetForum();
    keptFor = me;
}
/** A topic that isn't there for this member any more (removed, or its writer blocked): out of the kept read and every kept list. */
export function forgetForumTopic(id: string): void {
    kept.topics.delete(id);
    for (const [key, list] of kept.lists) kept.lists.set(key, { ...list, topics: list.topics.filter((t) => t.id !== id) });
}
/** For tests, and for a new account in this tab: nothing kept. */
export function forgetForum(): void {
    keptFor = null;
    kept.front = null;
    kept.lists.clear();
    kept.topics.clear();
    kept.search = null;
    for (const url of photoUrls.values()) void url.then((u) => { if (u) URL.revokeObjectURL(u); });
    photoUrls.clear();
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function getForumFront(): Promise<ForumFront> {
    kept.front = await request<ForumFront>('GET', '/api/forum');
    return kept.front;
}

/** One page of topics (30), pinned first then the newest activity; `offset` 0 replaces the kept list, a later page adds. */
export async function getForumTopics(sectionId: string | null, offset = 0): Promise<{ topics: ForumTopic[]; next: number | null }> {
    const q = new URLSearchParams();
    if (sectionId) q.set('section', sectionId);
    if (offset) q.set('offset', String(offset));
    const qs = q.toString();
    const page = await request<{ topics: ForumTopic[]; next: number | null }>('GET', `/api/forum/topics${qs ? `?${qs}` : ''}`);
    const before = offset ? kept.lists.get(listKey(sectionId))?.topics ?? [] : [];
    const merged = { topics: [...before.filter((t) => !page.topics.some((p) => p.id === t.id)), ...page.topics], next: page.next };
    kept.lists.set(listKey(sectionId), merged);
    return merged;
}

/** A topic and its posts after number `after` (30 a read); `after` 0 replaces the kept read, a later one adds its posts. */
export async function getForumTopic(id: string, after = 0): Promise<ForumTopicPage> {
    const page = await request<ForumTopicPage>('GET', `/api/forum/topics/${encodeURIComponent(id)}${after ? `?after=${after}` : ''}`);
    const before = after ? kept.topics.get(id)?.posts ?? [] : [];
    const merged = { ...page, posts: [...before.filter((p) => p.number <= after), ...page.posts] };
    kept.topics.set(id, merged);
    return merged;
}

/**
 * A search of the forum (slice F6): every word typed, newest first, 20 a page; `offset` 0 replaces the kept search, a later
 * page adds its hits. Each call is one of the member's 100 searches a day (the node refuses past them with 429), so the page
 * asks only when they press Search, never as they type.
 */
export async function searchForum(q: string, offset = 0): Promise<ForumSearchAnswer> {
    const page = await request<{ hits: ForumSearchHit[]; next: number | null }>('GET', `/api/forum/search?q=${encodeURIComponent(q)}${offset ? `&offset=${offset}` : ''}`);
    const before = offset && kept.search?.q === q ? kept.search.hits : [];
    kept.search = { q, hits: [...before.filter((h) => !page.hits.some((x) => x.postId === h.postId)), ...page.hits], next: page.next };
    return kept.search;
}

const photoUrls = new Map<string, Promise<string | null>>();
/** A post's photo (or a waiting topic's, `waiting`) as an object address the page can draw, read signed once; null if gone. */
export function forumPhotoUrl(id: string, n: number, waiting = false): Promise<string | null> {
    const path = waiting ? `/api/forum/first-looks/${encodeURIComponent(id)}/photos/${n}` : `/api/forum/posts/${encodeURIComponent(id)}/photos/${n}`;
    let url = photoUrls.get(path);
    if (!url) {
        url = signedFetch('GET', path)
            .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
            .catch(() => null);
        photoUrls.set(path, url);
        // A failed read is asked again next time, not kept as gone.
        void url.then((u) => { if (!u) photoUrls.delete(path); });
    }
    return url;
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NewTopicInput { sectionId: string; title: string; words: string; place?: string; lang?: string; photos?: string[] }

/** A new topic: up at once ({ topic, post }), or a new member's first topic waiting for a moderator's look ({ waiting }). */
export async function startForumTopic(input: NewTopicInput): Promise<{ topic: ForumTopic } | { waiting: ForumWaiting }> {
    const out = await request<{ topic: ForumTopic; post: ForumPost } | { waiting: ForumWaiting }>('POST', '/api/forum/topics', input);
    kept.lists.clear();
    return out;
}

export async function replyInForum(topicId: string, input: { words: string; quotes?: number | null; lang?: string; photos?: string[] }): Promise<ForumPost> {
    const body: Record<string, unknown> = { words: input.words };
    if (input.quotes) body.quotes = input.quotes;
    if (input.lang) body.lang = input.lang;
    if (input.photos?.length) body.photos = input.photos;
    const { post } = await request<{ post: ForumPost }>('POST', `/api/forum/topics/${encodeURIComponent(topicId)}/replies`, body);
    return post;
}

/** The member read that anyone on the web can read this forum with their name (a public forum's first post waits on it). */
export async function markForumTold(): Promise<void> {
    await request('POST', '/api/forum/told', {});
    if (kept.front) kept.front = { ...kept.front, told: true };
}

export async function followForumTopic(topicId: string, follow: ForumFollow | null): Promise<ForumFollow | null> {
    return (await request<{ follow: ForumFollow | null }>('POST', `/api/forum/topics/${encodeURIComponent(topicId)}/follow`, { follow })).follow;
}

/** They opened it up to post `upTo`: the unread dot moves, and the forum's own bell rows for it come off (slice F5). */
export async function readForumTopic(topicId: string, upTo: number): Promise<number> {
    return (await request<{ lastRead: number }>('POST', `/api/forum/topics/${encodeURIComponent(topicId)}/read`, { upTo })).lastRead;
}

export async function closeForumTopic(topicId: string): Promise<ForumTopic> {
    return (await request<{ topic: ForumTopic }>('POST', `/api/forum/topics/${encodeURIComponent(topicId)}/close`, {})).topic;
}

export async function removeForumPost(postId: string): Promise<void> {
    await request('POST', `/api/forum/posts/${encodeURIComponent(postId)}/remove`, {});
    kept.lists.clear();
}

/** A report of a forum post (slice F2): about its writer, whoever the page names; answered in Settings. */
export async function reportForumPost(postId: string, reason: string): Promise<void> {
    await request('POST', '/api/reports', { targetForumPostId: postId, reason });
}

// ── First looks (slice F2) ───────────────────────────────────────────────────────────────────────────────────────

export const listFirstLooks = () => request<{ waiting: ForumWaiting[] }>('GET', '/api/forum/first-looks');
export const myFirstLook = () => request<{ waiting: ForumWaiting | null; usuallyWithinHours: number | null }>('GET', '/api/forum/first-looks/mine');
export async function okFirstLook(id: string): Promise<string> {
    const { topicId } = await request<{ topicId: string }>('POST', `/api/forum/first-looks/${encodeURIComponent(id)}/ok`, {});
    kept.lists.clear();
    return topicId;
}
export async function noFirstLook(id: string, reason: FirstLookNoReason): Promise<void> {
    await request('POST', `/api/forum/first-looks/${encodeURIComponent(id)}/no`, { reason });
}
export async function withdrawFirstLook(id: string): Promise<void> {
    await request('POST', `/api/forum/first-looks/${encodeURIComponent(id)}/withdraw`, {});
}

/** Whether a reply's or an opening's words fit (the node holds the same numbers and refuses past them). */
export const forumWordsFit = (words: string, opening: boolean): boolean =>
    Array.from(words.trim()).length <= (opening ? FORUM_LIMITS.opening : FORUM_LIMITS.reply);
