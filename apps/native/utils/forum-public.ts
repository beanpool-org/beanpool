/**
 * The forum for a visitor on the phone (slice F7, the apps' part; core forum-visitors.ts), as the web lobby reads it
 * (apps/pwa/src/lib/forum-public.ts): the node's public reads, unsigned (a visitor's read never carries a key, and is the one
 * the edge keeps for everyone), and nothing kept: a visitor's forum is read while it is on screen.
 *
 * - **Who is a visitor here:** the community in use is one this phone visits as a guest (nodes.ts markGuestNode: a key with no
 *   account there, or no key at all, looking around), and its profile says anyone may read its forum (`forumPublic`).
 * - **The door** (Join to reply): with no key, the look's own door (look-around.ts LOOK_DOOR, Back returns to the look); with a
 *   key, the global community's door for that account (app/join-global.tsx), as the header's Join pill.
 */
import { useEffect, useState } from 'react';
import {
    FORUM_PUBLIC_PATHS, forumPublicOn, type ForumPublicFront, type ForumPublicSectionPage, type ForumPublicTopicPage,
} from '@beanpool/core';

const READ_TIMEOUT_MS = 15_000;

/** The community in use (node-post.ts anchorUrl), loaded when asked: the tab bar imports this file, and the data layer is heavy. */
const anchorUrl = async (): Promise<string | null> => (await import('./node-post')).anchorUrl();

async function publicRead<T>(path: string, fetchImpl: typeof fetch = fetch): Promise<T> {
    const base = (await anchorUrl())?.replace(/\/+$/, '');
    if (!base) throw new Error('no community');
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), READ_TIMEOUT_MS);
    try {
        const res = await fetchImpl(`${base}${path}`, { method: 'GET', headers: { Accept: 'application/json' }, signal: stop.signal });
        if (!res.ok) throw Object.assign(new Error(`forum ${res.status}`), { status: res.status });
        return await res.json() as T;
    } finally {
        clearTimeout(timer);
    }
}
const page = (offset: number) => (offset ? `?offset=${offset}` : '');

/** The sections and every section's topics (30 a page), pinned first then the newest activity. */
export const getPublicForum = (offset = 0) => publicRead<ForumPublicFront>(`${FORUM_PUBLIC_PATHS.front}${page(offset)}`);
/** One section and its topics (30 a page). */
export const getPublicSection = (id: string, offset = 0) => publicRead<ForumPublicSectionPage>(`${FORUM_PUBLIC_PATHS.section(id)}${page(offset)}`);
/** A topic, its section and its posts after number `after` (30 a read). */
export const getPublicTopic = (id: string, after = 0) => publicRead<ForumPublicTopicPage>(`${FORUM_PUBLIC_PATHS.topic(id)}${after ? `?after=${after}` : ''}`);

/** Whether this phone reads the community in use as a visitor whose forum anyone may read. False on any fault. */
export async function visitorForumHere(): Promise<boolean> {
    try {
        const [anchor, { isGuestNode }, { getCachedNodeProfile }] = await Promise.all([anchorUrl(), import('./nodes'), import('./node-profile')]);
        if (!anchor || !(await isGuestNode(anchor))) return false;
        return forumPublicOn((await getCachedNodeProfile(anchor))?.features);
    } catch {
        return false;
    }
}

/** {@link visitorForumHere}, asked again whenever `again` changes (the community switched, say); false until it answers. */
export function useVisitorForum(again?: unknown): boolean {
    const [on, setOn] = useState(false);
    useEffect(() => {
        let live = true;
        void visitorForumHere().then((v) => { if (live) setOn(v); });
        return () => { live = false; };
    }, [again]);
    return on;
}

/** Join to reply: the look's door with no key (Back returns here), else the global community's door for this account. */
export async function openVisitorDoor(push: (to: string | { pathname: string; params: Record<string, string> }) => void): Promise<void> {
    const [{ loadIdentity }, { LOOK_DOOR }] = await Promise.all([import('./identity'), import('./look-around')]);
    const identity = await loadIdentity().catch(() => null);
    push(identity ? '/join-global' : { pathname: LOOK_DOOR.pathname, params: { ...LOOK_DOOR.params } });
}
