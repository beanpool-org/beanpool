/**
 * The members' guide and manual in the web app ("BeanPool: help and how it works").
 *
 * One source: packages/beanpool-guide/content. The web app bundles the SAME generated guide.json as the member app
 * (@beanpool/guide/generated/guide.json), and beanpool.org/guide/guide.json is the same bytes. The logic — checking a
 * copy, the offline cache, the website update, search, related pages, Learn videos — is shared with the member app
 * in @beanpool/core member-guide.ts. This file adds the copy built into this bundle, localStorage as the cache, and
 * the session state the guide screens share.
 */

import { useEffect, useState } from 'react';
import bundledGuide from '@beanpool/guide/generated/guide.json';
import {
    validateGuide, loadLocalGuide, refreshGuideFromWebsite,
    learnVideosFromFeed, type Guide, type GuideStorage, type LoadedGuide, type LearnVideo,
} from '@beanpool/core';
import { getPulseFeed } from './api';

const BUNDLED = validateGuide(bundledGuide);

/** The copy built into this bundle. Works with no connection at all. */
export function getBundledGuide(): Guide {
    // The guide package's tests validate this file, and this app's tests validate it with this function.
    if (!BUNDLED) throw new Error("The bundled members' guide is invalid");
    return BUNDLED;
}

/** localStorage, which can be missing or throw (private windows, blocked site data): every call is guarded. */
export const guideStorage: GuideStorage = {
    getItem(key) {
        try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
    },
    setItem(key, value) {
        try { globalThis.localStorage?.setItem(key, value); } catch { /* shown now; not cached */ }
    },
};

// The website is checked when the guide opens, at most once every 10 minutes.
const RECHECK_MS = 10 * 60 * 1000;
let sessionGuide: LoadedGuide | null = null;
let lastCheckAt = 0;
const listeners = new Set<(g: LoadedGuide) => void>();

function publish(next: LoadedGuide) {
    sessionGuide = next;
    listeners.forEach(l => l(next));
}

async function startRefresh() {
    if (Date.now() - lastCheckAt < RECHECK_MS) return;
    lastCheckAt = Date.now();
    const local = await loadLocalGuide(guideStorage, getBundledGuide());
    if (!sessionGuide || local.guide.version > sessionGuide.guide.version) publish(local);
    if (typeof fetch !== 'function') return;
    const remote = await refreshGuideFromWebsite(local.guide, guideStorage, (url, init) => fetch(url, init));
    if (remote) publish({ guide: remote, source: 'website' });
}

/** The guide: the bundled copy at once, then the cached or a newer website copy when there is one. */
export function useGuide(): LoadedGuide {
    const [loaded, setLoaded] = useState<LoadedGuide>(() => sessionGuide ?? { guide: getBundledGuide(), source: 'bundled' });
    useEffect(() => {
        listeners.add(setLoaded);
        if (sessionGuide) setLoaded(sessionGuide);
        startRefresh().catch(() => { /* keep what is on screen */ });
        return () => { listeners.delete(setLoaded); };
    }, []);
    return loaded;
}

// The videos in this community's Pulse → Learn lane, for the guide's "Watch" links. Extra only: an empty list
// (offline, no community) just hides the link. An empty answer is not remembered, so a later page can try again.
// Each item keeps its `source`: findGuideVideo only links BeanPool's own (curated) videos, never a member's item.
let learnVideos: LearnVideo[] | null = null;
let learnPending: Promise<LearnVideo[]> | null = null;

export function loadLearnVideos(): Promise<LearnVideo[]> {
    if (learnVideos) return Promise.resolve(learnVideos);
    learnPending ??= getPulseFeed({ category: 'learn', limit: 50 })
        .then(res => learnVideosFromFeed(res?.items))
        .catch(() => [] as LearnVideo[])
        .then(list => {
            if (list.length > 0) learnVideos = list;
            learnPending = null;
            return list;
        });
    return learnPending;
}

export function useLearnVideos(): LearnVideo[] {
    const [list, setList] = useState<LearnVideo[]>(() => learnVideos ?? []);
    useEffect(() => {
        let alive = true;
        loadLearnVideos().then(v => { if (alive) setList(v); }).catch(() => {});
        return () => { alive = false; };
    }, []);
    return list;
}

/** Tests only: forget the session state. */
export function resetGuideSessionForTests() {
    sessionGuide = null;
    lastCheckAt = 0;
    learnVideos = null;
    learnPending = null;
}
