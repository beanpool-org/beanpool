/**
 * The forum for a visitor in the lobby (slice F7, the apps' part; core forum-visitors.ts): the node's public reads, unsigned,
 * so a visitor's read is the one the edge may keep for everyone (60 s), and never carries a key. Nothing is written to the
 * browser's storage but the one topic a visitor came for, kept in this tab for after the join (as a shared listing is).
 */
import {
    FORUM_PUBLIC_PATHS, type ForumPublicFront, type ForumPublicList, type ForumPublicTopicPage,
} from '@beanpool/core';
import { getNodeApiUrl } from './api';

async function publicRead<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${getNodeApiUrl()}${path}`, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-cache', ...(signal ? { signal } : {}) });
    if (!res.ok) throw Object.assign(new Error(`forum ${res.status}`), { status: res.status });
    return await res.json() as T;
}

export const getPublicForum = (signal?: AbortSignal) => publicRead<ForumPublicFront>(FORUM_PUBLIC_PATHS.front, signal);

export function getPublicTopics(sectionId: string | null, offset = 0, signal?: AbortSignal): Promise<ForumPublicList> {
    const q = new URLSearchParams();
    if (sectionId) q.set('section', sectionId);
    if (offset) q.set('offset', String(offset));
    const qs = q.toString();
    return publicRead<ForumPublicList>(`${FORUM_PUBLIC_PATHS.topics}${qs ? `?${qs}` : ''}`, signal);
}

export const getPublicTopic = (id: string, after = 0, signal?: AbortSignal) =>
    publicRead<ForumPublicTopicPage>(`${FORUM_PUBLIC_PATHS.topic(id)}${after ? `?after=${after}` : ''}`, signal);

const KEPT_TOPIC = 'beanpool_lobby_topic';

/** The topic a visitor came for, kept in this tab so they land on it once joined (a join by a sign-in leaves the page). */
export function keepLinkedTopic(id: string): void {
    try { sessionStorage.setItem(KEPT_TOPIC, id); } catch { /* a tab that keeps nothing lands on the forum's list */ }
}

/** The kept topic, once: read and forgotten. */
export function takeKeptLinkedTopic(): string | null {
    try {
        const id = sessionStorage.getItem(KEPT_TOPIC);
        sessionStorage.removeItem(KEPT_TOPIC);
        return id;
    } catch {
        return null;
    }
}
