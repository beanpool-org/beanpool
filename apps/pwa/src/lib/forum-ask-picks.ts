/**
 * The asker's picker on Ask to join, on the web (forums F11b; DESIGN-forums-fable.md §13): up to three of their own posts on
 * the worldwide forum, sent with the request so the community's admins can read them and check who wrote them (the admins'
 * side is components/KnockForumPosts.tsx). The phone's twin is apps/native/utils/forum-ask-picks.ts.
 *
 * The list is GET /api/forum/ask-posts from the server this web app talks to, signed with this browser's key: the worldwide
 * community answers with the asker's own posts anyone on the web can read now, and their secret there; any other community
 * answers 404 `not_here`, a visitor 403, and the picker is left out. The route is not open to other websites (its answer
 * carries the secret), so a web app never asks another server for it. A community's own web door (components/AskHere.tsx)
 * signs with a key made for that request, which has no posts, so it offers none (§13). What the request carries is core's
 * forumAskSend: only posts on that list, at most three.
 */

import { useCallback, useEffect, useState } from 'react';
import {
    FORUM_ASK_CHECK_MS, FORUM_ASK_POSTS_PATH, forumAskSend, readForumAskPosts, toggleForumAskPick,
    type ForumAskPosts, type ForumAskSend,
} from '@beanpool/core';
import { getNodeApiUrl, signedFetchAt } from './api';
import type { BeanPoolIdentity } from './identity';

/** This web app's own server, as an origin. */
function ownServer(): string {
    return getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
}

/**
 * This key's own posts on the worldwide forum, or null: none, or the list couldn't be read (this server isn't the worldwide
 * community, not a member there, unreachable, slower than core's check wait, or an answer that isn't one). Never throws.
 */
export async function readMyForumPosts(identity: BeanPoolIdentity): Promise<ForumAskPosts | null> {
    const server = ownServer();
    if (!server) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), FORUM_ASK_CHECK_MS); });
    try {
        const read = (async () => {
            const res = await signedFetchAt('GET', server, FORUM_ASK_POSTS_PATH, '', identity);
            if (!res.ok) return null;
            const list = readForumAskPosts(await res.json());
            return list && list.posts.length ? list : null;
        })();
        return await Promise.race([read, late]);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export interface ForumAskPicks {
    /** The asker's own posts, or null: the picker is drawn only with a list. */
    offered: ForumAskPosts | null;
    picked: string[];
    toggle: (postId: string) => void;
    /** What the request carries, for the key that signs it: nothing when another key signs it than the one the list is for. */
    sendFor: (signer: string) => ForumAskSend | null;
}

/**
 * The picker's state while an Ask to join form is open: opening it reads the list once (for `identity`); closing it drops
 * the list and the picks.
 */
export function useForumAskPicks(open: boolean, identity: BeanPoolIdentity | null): ForumAskPicks {
    const [offered, setOffered] = useState<{ key: string; list: ForumAskPosts } | null>(null);
    const [picked, setPicked] = useState<string[]>([]);
    useEffect(() => {
        setOffered(null);
        setPicked([]);
        if (!open || !identity) return;
        let alive = true;
        void readMyForumPosts(identity).then((list) => { if (alive && list) setOffered({ key: identity.publicKey, list }); });
        return () => { alive = false; };
        // Read once per open form and key: a new identity object for the same key reads nothing again.
    }, [open, identity?.publicKey]);
    // Only a post on the list can be picked: an id that isn't (another writer's, one gone, a stale tap) takes no place.
    const toggle = useCallback((postId: string) => {
        if (offered?.list.posts.some((p) => p.postId === postId)) setPicked((p) => toggleForumAskPick(p, postId));
    }, [offered]);
    const sendFor = useCallback(
        (key: string) => (offered && offered.key === key ? forumAskSend(offered.list, picked) : null),
        [offered, picked],
    );
    return { offered: offered?.list ?? null, picked, toggle, sendFor };
}
