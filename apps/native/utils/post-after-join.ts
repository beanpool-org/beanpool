/**
 * The listing an invite was sent from (invite-and-share: `{community}/?invite={code}&post={id}`), opened once the friend
 * has joined and landed on Home.
 *
 * The join takes minutes (a name, a photo, the 12 words) and the app may be closed in between, so the listing is kept on the
 * phone from the join until the root guard lands the new member (app/_layout.tsx), which takes it once. Kept as the
 * community and the id and nothing else, for a day: past that, or for another community than the one the phone is in, it is
 * dropped. Only an id is ever kept (core landingPostId), and the screen it opens (app/post/[id].tsx) shows nothing for a
 * post this member can't see, with no error: the invite gave no read the friend didn't have.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { landingPostId } from '@beanpool/core';

export const POST_AFTER_JOIN_KEY = 'beanpool_post_after_join';

/** How long a listing waits for its friend to finish joining. */
export const POST_AFTER_JOIN_MS = 24 * 60 * 60_000;

export interface PostStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

const sameCommunity = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

/** The screen a listing opens on, or null where `postId` is no id. */
export function postRoute(postId: unknown): `/post/${string}` | null {
    const id = landingPostId(postId);
    return id ? `/post/${encodeURIComponent(id)}` : null;
}

/** The friend has joined `community` from an invite sent from `postId`: keep it for the landing. Anything else keeps nothing. */
export async function holdPostAfterJoin(community: string, postId: unknown, now: number = Date.now(), store: PostStore = AsyncStorage): Promise<void> {
    const id = landingPostId(postId);
    if (!id || !community) return;
    try {
        await store.setItem(POST_AFTER_JOIN_KEY, JSON.stringify({ community, id, at: now }));
    } catch { /* the member lands on Home */ }
}

/**
 * The route of the kept listing, taken out: once, then never again. Null when none is kept, when it was kept for another
 * community or longer ago than a join takes, or when the slot holds anything but a community, an id and a time. With no
 * community to compare (not heard yet) nothing is read and nothing is lost.
 */
export async function takePostAfterJoin(community: string | null, now: number = Date.now(), store: PostStore = AsyncStorage): Promise<`/post/${string}` | null> {
    // The community in use isn't known yet (the phone is still asking): leave it for the next landing, never read it away.
    if (!community) return null;
    let raw: string | null;
    try {
        raw = await store.getItem(POST_AFTER_JOIN_KEY);
        if (raw === null) return null;
        const held = JSON.parse(raw) as { community?: unknown; id?: unknown; at?: unknown } | null;
        if (!held || typeof held !== 'object') { await store.removeItem(POST_AFTER_JOIN_KEY); return null; }
        const expired = typeof held.at !== 'number' || !Number.isFinite(held.at) || held.at > now || now - held.at > POST_AFTER_JOIN_MS;
        if (expired) { await store.removeItem(POST_AFTER_JOIN_KEY); return null; }
        // Read once whatever it says: one for another community than the one the phone landed in is dropped, not kept for later.
        await store.removeItem(POST_AFTER_JOIN_KEY);
        if (typeof held.community !== 'string' || !sameCommunity(held.community, community)) return null;
        return postRoute(held.id);
    } catch {
        try { await store.removeItem(POST_AFTER_JOIN_KEY); } catch { /* nothing more to do */ }
        return null;
    }
}
