/**
 * The members' guide and manual in the web app ("BeanPool: help and how it works").
 *
 * One source: packages/beanpool-guide/content. The web app bundles the SAME generated guide.json as the member app
 * (@beanpool/guide/generated/guide.json), and beanpool.org/guide/guide.json is the same bytes. The logic — checking a
 * copy, the offline cache, the website update, search, related pages, Learn videos — is shared with the member app
 * in @beanpool/core member-guide.ts. This file adds the copy built into this bundle, localStorage as the cache, and
 * the session state the guide screens share; and the guide's titles in the language the screens are in (slice S5a: the
 * titles arrive with the language's words, lib/guide-titles.ts).
 */

import { useEffect, useMemo, useState } from 'react';
import {
    validateGuide, loadLocalGuide, refreshGuideFromWebsite, guideInLanguage,
    loadCachedLanguageGuide, refreshLanguageGuideFromWebsite,
    learnVideosFromFeed, type Guide, type GuideStorage, type LoadedGuide, type LearnVideo,
} from '@beanpool/core';
import { getPulseFeed } from './api';
import { guideTitlesFor } from './guide-titles';
import { shownLanguage } from './language';
import { useLanguage } from './useLanguage';

let BUNDLED: Guide | null = null;
let bundledPromise: Promise<Guide> | null = null;

/** Lazy-load the bundled guide JSON on demand so it does not inflate the first-screen entry chunk. */
export async function loadBundledGuide(): Promise<Guide> {
    if (BUNDLED) return BUNDLED;
    if (!bundledPromise) {
        bundledPromise = import('@beanpool/guide/generated/guide.json').then((m) => {
            const raw = m.default ?? m;
            const valid = validateGuide(raw);
            if (!valid) throw new Error("The bundled members' guide is invalid");
            BUNDLED = valid;
            return valid;
        });
    }
    return bundledPromise;
}

/** The copy built into this bundle. Works with no connection at all. */
export function getBundledGuide(): Guide {
    if (!BUNDLED) {
        if (typeof process !== 'undefined' && process.versions?.node) {
            try {
                const req = new Function('m', 'return require(m)');
                const raw = req('@beanpool/guide/generated/guide.json');
                BUNDLED = validateGuide(raw);
            } catch {
                // not in node
            }
        }
    }
    if (!BUNDLED) throw new Error("The bundled members' guide is invalid or not yet loaded");
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

// Cached language guides by language code
const sessionLangGuides = new Map<string, Guide | null>();
const langListeners = new Set<(lang: string, g: Guide | null) => void>();
const lastLangCheckAt = new Map<string, number>();

function publish(next: LoadedGuide) {
    sessionGuide = next;
    listeners.forEach(l => l(next));
}

function publishLang(lang: string, next: Guide | null) {
    sessionLangGuides.set(lang, next);
    langListeners.forEach(l => l(lang, next));
}

async function startRefresh() {
    if (Date.now() - lastCheckAt < RECHECK_MS) return;
    lastCheckAt = Date.now();
    const bundled = await loadBundledGuide();
    const local = await loadLocalGuide(guideStorage, bundled);
    if (!sessionGuide || local.guide.version > sessionGuide.guide.version) publish(local);
    if (typeof fetch !== 'function') return;
    const remote = await refreshGuideFromWebsite(local.guide, guideStorage, (url, init) => fetch(url, init));
    if (remote) publish({ guide: remote, source: 'website' });
}

async function startLangRefresh(lang: string) {
    if (lang === 'en' || typeof fetch !== 'function') return;
    const now = Date.now();
    const lastCheck = lastLangCheckAt.get(lang) ?? 0;
    if (now - lastCheck < RECHECK_MS) return;

    let current = sessionLangGuides.get(lang);
    if (current === undefined) {
        current = await loadCachedLanguageGuide(guideStorage, lang);
        publishLang(lang, current);
    }
    lastLangCheckAt.set(lang, now);
    const remote = await refreshLanguageGuideFromWebsite(current, guideStorage, (url, init) => fetch(url, init), lang);
    if (remote) {
        publishLang(lang, remote);
    }
}

/**
 * A guide with its titles, summaries and help lines in the language the screens are in now, wherever that language's
 * titles file has a current translation, else English (core's guideInLanguage). For a reader outside the guide screens
 * (the "?" sheet), redrawn with the app's root when the language changes.
 */
export function inShownLanguage(guide: Guide): Guide {
    const lang = shownLanguage();
    const langGuide = sessionLangGuides.get(lang) ?? null;
    return guideInLanguage(guide, lang, guideTitlesFor(lang), langGuide);
}

/**
 * The guide: the bundled copy at once, then the cached or a newer website copy when there is one; its titles in the
 * member's language (inShownLanguage). Re-renders when the member picks another language.
 */
export function useGuide(): LoadedGuide {
    const [loaded, setLoaded] = useState<LoadedGuide>(() => {
        try {
            return sessionGuide ?? { guide: getBundledGuide(), source: 'bundled' };
        } catch {
            return sessionGuide ?? { guide: { version: 0, schema: 1, hash: '', sections: [], guides: [] }, source: 'bundled' };
        }
    });
    const [lang] = useLanguage();
    const [, setLangGuideTick] = useState(0);

    const langGuide = lang === 'en' ? null : (sessionLangGuides.get(lang) ?? null);

    useEffect(() => {
        listeners.add(setLoaded);
        if (sessionGuide) setLoaded(sessionGuide);
        else {
            loadBundledGuide().then((g) => {
                if (!sessionGuide) setLoaded({ guide: g, source: 'bundled' });
            }).catch(() => {});
        }
        startRefresh().catch(() => { /* keep what is on screen */ });
        return () => { listeners.delete(setLoaded); };
    }, []);

    useEffect(() => {
        const onLangUpdate = (updatedLang: string) => {
            if (updatedLang === lang) setLangGuideTick(t => t + 1);
        };
        langListeners.add(onLangUpdate);
        if (lang !== 'en') {
            startLangRefresh(lang).catch(() => {});
        }
        return () => { langListeners.delete(onLangUpdate); };
    }, [lang]);

    return useMemo(() => ({
        ...loaded,
        guide: guideInLanguage(loaded.guide, lang, guideTitlesFor(lang), langGuide),
    }), [loaded, lang, langGuide]);
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
    sessionLangGuides.clear();
    lastLangCheckAt.clear();
    learnVideos = null;
    learnPending = null;
}
