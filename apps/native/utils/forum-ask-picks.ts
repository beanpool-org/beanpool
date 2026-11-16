/**
 * The asker's picker on Ask to join, on the phone (forums F11b; DESIGN-forums-fable.md §13): up to three of their own posts
 * on the worldwide forum, sent with the request so the community's admins can read them and check who wrote them (the
 * admins' side is components/KnockForumPosts.tsx). The web's twin is apps/pwa/src/lib/forum-ask-picks.ts.
 *
 * The list is the worldwide community's answer to GET /api/forum/ask-posts, signed with this phone's one key: the asker's
 * own posts anyone on the web can read now, and their secret there. It is asked only by a phone whose community is the
 * worldwide one, as a member (the same rule as the request's `fromNode`, utils/knock-address.ts): a phone with no account,
 * a guest, or one in a local community asks nothing of it. Anything but a list that reads leaves the picker out, and the
 * request goes as before. What the request carries is core's forumAskSend: only posts on that list, at most three.
 */

import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    FORUM_ASK_CHECK_MS, FORUM_ASK_POSTS_PATH, forumAskSend, readForumAskPosts, toggleForumAskPick,
    type ForumAskPosts, type ForumAskSend,
} from '@beanpool/core';
import { signedGet } from './node-post';
import { GLOBAL_NODE_URL } from './global-node-url';
import { knockFromNode } from './knock-address';
import type { BeanPoolIdentity } from './identity';

/**
 * This key's own posts on the worldwide forum, or null: none, or the list couldn't be read (not a member there, the forum
 * off, unreachable, slower than core's check wait, or an answer that isn't one). Never throws.
 */
export async function readMyForumPosts(identity: BeanPoolIdentity): Promise<ForumAskPosts | null> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), FORUM_ASK_CHECK_MS);
    try {
        const res = await signedGet(GLOBAL_NODE_URL, FORUM_ASK_POSTS_PATH, identity, controller?.signal);
        if (!res.ok) return null;
        const list = readForumAskPosts(await res.json());
        return list && list.posts.length ? list : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Whether this phone's community is the worldwide one, as a member (not a guest there). */
async function onWorldwide(): Promise<boolean> {
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
    if (!anchor) return false;
    const guest = await import('./nodes').then((m) => m.isGuestNode(anchor)).catch(() => true);
    return knockFromNode(anchor, guest) !== null;
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
 * The picker's state for an Ask to join form: `formKey` is the form that is open (null when none). Opening a form reads the
 * list once (for `identity`, when there is one); closing it, or opening another, drops the list and the picks.
 */
export function useForumAskPicks(formKey: string | null, identity: BeanPoolIdentity | null): ForumAskPicks {
    const [offered, setOffered] = useState<{ key: string; list: ForumAskPosts } | null>(null);
    const [picked, setPicked] = useState<string[]>([]);
    const signer = identity ?? null;
    useEffect(() => {
        setOffered(null);
        setPicked([]);
        if (!formKey || !signer) return;
        let alive = true;
        void (async () => {
            if (!(await onWorldwide())) return;
            const list = await readMyForumPosts(signer);
            if (alive && list) setOffered({ key: signer.publicKey, list });
        })();
        return () => { alive = false; };
        // Read once per form and key: a new identity object for the same key reads nothing again.
    }, [formKey, signer?.publicKey]);
    const toggle = useCallback((postId: string) => setPicked((p) => toggleForumAskPick(p, postId)), []);
    const sendFor = useCallback(
        (key: string) => (offered && offered.key === key ? forumAskSend(offered.list, picked) : null),
        [offered, picked],
    );
    return { offered: offered?.list ?? null, picked, toggle, sendFor };
}
