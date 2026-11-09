/**
 * The listings the messages of an open chat are about (core chat-about.ts), as THIS member can read them, looked up once
 * each and kept for a minute. The chat screen asks for the ids its messages name and hands each card what came back:
 * the listing, null (gone, or hidden from this member: one answer, so a chat learns nothing about a listing it can't see),
 * or nothing yet (the card then shows the sender's own title, never a refusal).
 */
import { useEffect, useState } from 'react';
import type { AboutPostLike } from '@beanpool/core';
import { lookupAboutListing } from './db';

/** How long an answer is believed. */
export const ABOUT_LOOKUP_MS = 60_000;

type Answer = { at: number; post: AboutPostLike | null };
const found = new Map<string, Answer>();
const asking = new Set<string>();

/** The answer held for each id now; an id never asked, or being asked, is absent. */
export function useAboutListings(ids: readonly string[]): Map<string, AboutPostLike | null> {
    const [, bump] = useState(0);
    const key = [...new Set(ids)].sort().join('|');
    useEffect(() => {
        let alive = true;
        for (const id of key ? key.split('|') : []) {
            const hit = found.get(id);
            if ((hit && Date.now() - hit.at <= ABOUT_LOOKUP_MS) || asking.has(id)) continue;
            asking.add(id);
            void lookupAboutListing(id).then((post) => {
                if (post !== undefined) found.set(id, { at: Date.now(), post });
            }).catch(() => { /* not asked yet: the sender's own title stays */ }).finally(() => {
                asking.delete(id);
                if (alive) bump((n) => n + 1);
            });
        }
        return () => { alive = false; };
    }, [key]);
    const out = new Map<string, AboutPostLike | null>();
    for (const id of key ? key.split('|') : []) {
        const hit = found.get(id);
        if (hit) out.set(id, hit.post);
    }
    return out;
}
