/**
 * The forum's public pages' "Open in the app" (apps/server forum-public-pages.ts forumPageDoors, slice F7):
 * `beanpool://forum?node=<that community's address>[&topic=<id>]`, the front and a section page without a topic, a topic page
 * with one. The phone's router (app/+native-intent.ts) reads it here, and never hands any `forum` path on to Expo Router:
 * there it would match whatever screen sits at /forum, which reads the community in use, whichever community the link named.
 *
 * The one rule: a forum link opens a forum only when it names the community in use, and only as this phone reads that
 * community.
 *   - a visitor there (a guest, its forum public): the visitors' topic (app/forum-public/[id].tsx), or the visitors' Forum tab;
 *   - a member there: the members' topic (app/forum/[id].tsx), or the Chat tab's Forum side;
 *   - anyone else (a member of another community, a phone signed out and not looking around, a link that names nothing this
 *     phone may read): nothing new, as an unusable peek: the app opens as from its icon (cold) or stays where it is (warm).
 * So the forum a link opens is always the community it named, never a different community's. No address is ours alone: the
 * rule compares the link's community with the one in use, so a self-hosted worldwide community's pages work the same.
 *
 * Kept free of the screens' imports and of the phone's storage, so the router can tell the link without loading either.
 */
import { isForumTopicId } from '@beanpool/core';

/** The visitors' Forum tab: in Chat's place for a visitor ((tabs)/_layout.tsx). Not at /forum, the members' forum's path. */
export const VISITOR_FORUM_TAB = '/(tabs)/visitor-forum';
/** The Chat tab on its Forum side: a member's forum list (as the forum's notices land, utils/push-notice-check.ts). */
export const MEMBER_FORUM_LIST = '/(tabs)/chats?view=forum';

/**
 * Every system path into a forum screen, in the spellings a system hands over (`beanpool://forum…`, `beanpool:///forum…`,
 * `/forum…`, `forum…`): the link itself, and the screens' own paths, which no page or app links to.
 */
const FORUM_PATH = /^(?:beanpool:\/\/\/?|\/)?(forum|forum-public|visitor-forum)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i;

/** What a forum link names: the community, and a topic or none (the front, or a section page). */
export interface ForumLink { origin: string; topic: string | null }

/**
 * A topic id as the node makes it (apps/server engine/forum.ts: `ft-` and hex), within core's id rule. A bare word is never
 * one: `new` or `first-looks` would open the members' forum's own screens (app/forum/new.tsx, first-looks.tsx) in its place.
 */
const isLinkTopic = (id: string) => isForumTopicId(id) && id.startsWith('ft-');

/** How this phone reads the community in use: a visitor there, a member there, or neither. */
export type ForumReader = 'visitor' | 'member' | 'elsewhere';

/** The phone as the router reads it for a forum link. */
export interface ForumPhone { anchor: string | null; reader: ForumReader }

/**
 * A community's address as a forum link names it, and as the phone keeps the community in use, in one spelling: http(s), a
 * host (a name, or a number) and maybe a port, nothing after it but slashes, no login. Null for anything else.
 */
export function forumOrigin(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const m = /^(https?):\/\/([a-z0-9.-]+)(?::(\d{1,5}))?\/*$/i.exec(raw.trim());
    if (!m || !/[a-z0-9]/i.test(m[2])) return null;
    const scheme = m[1].toLowerCase();
    const port = m[3] && !(scheme === 'https' && m[3] === '443') && !(scheme === 'http' && m[3] === '80') ? `:${m[3]}` : '';
    return `${scheme}://${m[2].toLowerCase().replace(/\.$/, '')}${port}`;
}

/** Whether `path` reaches a forum screen at all: the router then decides by {@link forumLinkRoute} and hands nothing on. */
export function isForumPath(path: unknown): boolean {
    return typeof path === 'string' && FORUM_PATH.test(path.trim());
}

/**
 * The community and topic a forum link names, each checked, or null: exactly one `node` that is a community's address, and at
 * most one `topic`, an id the node could have made ({@link isLinkTopic}). The screens' own paths (`forum/<id>`, `forum-public/<id>`,
 * `visitor-forum`) are no link: null.
 */
export function forumLinkFromSystemPath(path: unknown): ForumLink | null {
    if (typeof path !== 'string') return null;
    const m = FORUM_PATH.exec(path.trim());
    if (!m || m[1].toLowerCase() !== 'forum' || (m[2] !== undefined && m[2] !== '/')) return null;
    const q = new URLSearchParams(m[3] ?? '');
    const nodes = q.getAll('node');
    const topics = q.getAll('topic');
    const origin = nodes.length === 1 ? forumOrigin(nodes[0]) : null;
    if (!origin || topics.length > 1 || (topics.length === 1 && !isLinkTopic(topics[0]))) return null;
    return { origin, topic: topics[0] ?? null };
}

/**
 * Where a forum link goes for the phone as it is ({@link ForumPhone}): the named community's forum only when it is the
 * community in use, as a visitor's or a member's; else nothing new ('/' on a cold start, null warm).
 */
export function forumLinkRoute(link: ForumLink | null, phone: ForumPhone, initial: boolean): string | null {
    const nothing = initial ? '/' : null;
    if (!link || forumOrigin(phone.anchor) !== link.origin) return nothing;
    const topic = link.topic ? encodeURIComponent(link.topic) : null;
    if (phone.reader === 'visitor') return topic ? `/forum-public/${topic}` : VISITOR_FORUM_TAB;
    if (phone.reader === 'member') return topic ? `/forum/${topic}` : MEMBER_FORUM_LIST;
    return nothing;
}
