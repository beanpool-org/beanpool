/**
 * The forum for a visitor with no account (slice F7, the apps' part; DESIGN-forums-fable.md §4, §7, §14, §18). Marty, 16 Nov
 * 2026: "we dont want joining to be a barrier to seeing what beanpool is about". One rule for both apps: where a visitor
 * sees the forum (its tab, read only, and the Home card "From the forum"), the public JSON they read, and the words.
 *
 * - **Only the global community's.** `features.forumPublic` (with `features.forum`) is present only where anyone on the web
 *   may read the forum. A local community's forum is for its members: a visitor there gets no tab and no card.
 * - **What a visitor reads** is the node's public answer and nothing else, unsigned: the fields of `FORUM_PUBLIC_FIELDS`
 *   (forum.ts). A name and words, never a picture of a person, a key or a profile.
 * - **Never a wall, never a false empty.** The tab is there whatever the answer; where the reply box would be, a door (Join to
 *   reply). The card shows the three newest topics, or, while the forum has none public (or can't be reached), the members'
 *   guide's "How BeanPool works", which every app carries: never an empty card, and never "nothing here" for an answer that
 *   did not come.
 *
 * Pure and universal (bundled for the phone).
 */
import { forumOn } from './forum.js';
import { forumWriterNameLine, type ForumWriterLabel } from './membership-note.js';
import { nameLine } from './name-line.js';
import { word } from './words.js';

/**
 * The public reads (the server's routes/forum-public.ts, slice F7 server). Unsigned; visitors' answers are cached 60 s at the
 * edge. Each answers 404 `not_found` where the forum is not public, or for a topic or section that isn't (or is no longer).
 */
export const FORUM_PUBLIC_PATHS = {
    /** The sections, and every section's topics, 30 a page, pinned first then the newest activity; `?offset=<n>`. */
    front: '/api/forum/public',
    /** One section and its topics, 30 a page; `?offset=<n>`. */
    section: (id: string) => `/api/forum/public/sections/${encodeURIComponent(id)}`,
    /** A topic, its section and its posts, 30 a read; `?after=<number>`. */
    topic: (id: string) => `/api/forum/public/topics/${encodeURIComponent(id)}`,
} as const;

/** A writer on a public page: a name, and the community label they switched on (slice F10), else null. */
export interface ForumPublicWriter { name: string; community: ForumWriterLabel | null }
export interface ForumPublicSection { id: string; starter: string | null; name: string | null; about: string | null; position: number; topicCount: number }
export interface ForumPublicTopic {
    id: string; sectionId: string; title: string; writer: ForumPublicWriter | null; createdAt: string; lastActivityAt: string;
    replyCount: number; pinned: boolean; closed: string | null; place: string | null; lang: string | null; indexable?: boolean;
}
/** A public post: only a known writer's, up and not hidden (a removed or hidden one is not in the answer at all). */
export interface ForumPublicPost {
    id: string; topicId: string; number: number; writer: ForumPublicWriter | null; words: string; quotes: number | null;
    createdAt: string; edited: boolean; photos: number; lang: string | null;
}
export interface ForumPublicList { topics: ForumPublicTopic[]; next: number | null }
export interface ForumPublicFront extends ForumPublicList { sections: ForumPublicSection[] }
export interface ForumPublicSectionPage extends ForumPublicList { section: ForumPublicSection }
export interface ForumPublicTopicPage { section?: ForumPublicSection; topic: ForumPublicTopic; posts: ForumPublicPost[]; next: number | null }

/** Both apps' words for a visitor's forum (the rest are the members' forum's own lines). */
export const FORUM_VISITOR_WORDS = {
    /** The visitor Home card's title, beside "Near you" and "What people post". */
    card: word('From the forum'),
    /** Where the reply box would be: the door. */
    joinToReply: word('Join to reply'),
    /** A forum with no public topic yet: true, and a door. */
    none: word('No topics here yet. Join to start the first one.'),
} as const;

/** The members' guide page the card shows while the forum has nothing public to show (bundled in both apps). */
export const FORUM_VISITOR_GUIDE_PAGE = 'how-it-works';

/** Whether a node's `features` says anyone may read its forum: the global community's, with the forum on. */
export function forumPublicOn(features: { forum?: unknown; forumPublic?: unknown } | null | undefined): boolean {
    return forumOn(features) && features?.forumPublic === true;
}

/** What the public read gave: topics, none public, or no answer (yet, or at all). */
export type ForumPublicAnswer = 'topics' | 'none' | 'unreachable';

/**
 * What a reader sees of the visitors' forum: its tab, and what the Home card "From the forum" holds. A member reads the
 * members' forum instead (the Chat tab's Forum side, the Forum card), so neither shows for them. `card` is never an empty
 * box: the topics, else the guide's page.
 */
export function visitorForumShows(
    reader: 'visitor' | 'member',
    features: { forum?: unknown; forumPublic?: unknown } | null | undefined,
    answer: ForumPublicAnswer,
): { tab: boolean; card: 'topics' | 'guide' | null } {
    if (reader !== 'visitor' || !forumPublicOn(features)) return { tab: false, card: null };
    return { tab: true, card: answer === 'topics' ? 'topics' : 'guide' };
}

/** The three newest topics of a public list (by when each was started). */
export function newestPublicTopics(topics: readonly ForumPublicTopic[], n = 3): ForumPublicTopic[] {
    return topics.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, n);
}

/**
 * A writer's line on a public page, as the members' forum says it (core nameLine): their name, and the label they switched
 * on ("Asha · Riverside", "Asha · waiting to join"). `fallback` where the answer has no name.
 */
export function publicWriterLine(writer: ForumPublicWriter | null | undefined, fallback: string): string {
    return nameLine(forumWriterNameLine({ name: writer?.name?.trim() || fallback, label: writer?.community ?? null }));
}

/** The first line of an opening post, for a card: up to `max` characters, cut at a word, with "…" when cut. */
export function firstLineOf(words: string | null | undefined, max = 120): string {
    const line = (words ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    const chars = Array.from(line);
    if (chars.length <= max) return line;
    const cut = chars.slice(0, max).join('');
    const space = cut.lastIndexOf(' ');
    return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The web app's door to one topic (`/?topic=<id>`): the lobby opens it read only; a member's app opens it in the Forum. */
export function forumTopicDoor(id: string): string {
    return `/?topic=${encodeURIComponent(id)}`;
}

/** The topic a web address names (`?topic=<id>`), or null. Ids are the node's own: letters, digits, `-` and `_`, at most 64. */
export function forumTopicOfSearch(search: string | null | undefined): string | null {
    const raw = new URLSearchParams(search ?? '').get('topic');
    return raw && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}
