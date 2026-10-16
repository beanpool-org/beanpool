/**
 * How each switched-off feature shows on this node to this reader (scratch/global-node/DESIGN-global-showcase-fable.md §4):
 * `live`, `preview` (from the sample community, with the 🏘️ Local community strip), `read-only` (real data, the marker
 * on the actions) or `hidden` (as today). The rule is @beanpool/core's `featureModeFor`; this file only reads the sets.
 *
 * - **The node's set** is `features` from GET /api/community/info, read once per page load (lib/visitor-lobby-gate.ts).
 * - **The reader's set** is `features` from GET /api/community/me (W1's featuresFor), read once per page load and per
 *   key, and only with a key: a visitor's preview asks the node for nothing but its info. Signed out, before it arrives,
 *   or from a node older than it, the node's set stands for it. Today the two are equal; when BeanID turns Beans on for
 *   one verified member, that member's screens go live from this read alone.
 * - **Only where it can matter.** A node with every feature on and no `showcase` (a local community today, or a node
 *   from before the switches) is never asked: its pages make the same requests as before the showcase. A 401 or 403
 *   (a key that is not a member here) is kept as null for the page load; only a read that failed otherwise is asked again.
 * - **Before the info arrives** every feature reads `hidden`: no screen flashes a preview a live node then takes away.
 */

import { useEffect, useState } from 'react';
import { featureModeFor, readsOwnData, SHOWCASE_FEATURES, START_COMMUNITY_URL_DEFAULT, type FeatureMode, type ShowcaseFeature } from '@beanpool/core';
import { getCommunityMe, getTreasuries, type CommunityInfo, type Treasury } from './api';
import { loadIdentity } from './identity';
import { communityInfoOnce } from './visitor-lobby-gate';

type FeatureSet = Record<string, unknown> | null | undefined;

/** One feature's mode from the node's info and the reader's own set. No info yet: hidden. */
export function modeFor(feature: ShowcaseFeature, info: CommunityInfo | null | undefined, reader?: FeatureSet): FeatureMode {
    if (!info) return 'hidden';
    return featureModeFor(feature, info.features as FeatureSet, reader);
}

/** Where Start a community leads: the node's `startCommunityUrl` (W1) when it names an https page, else beanpool.org's. */
export function startCommunityUrl(info: CommunityInfo | null | undefined): string {
    const url = (info as { startCommunityUrl?: unknown } | null | undefined)?.startCommunityUrl;
    return typeof url === 'string' && /^https:\/\//i.test(url) ? url : START_COMMUNITY_URL_DEFAULT;
}

/**
 * The node's info, read once and shared; null until it arrives, and null for good when the node can't be asked.
 * `enabled` false: nothing is read (a screen that has no use for it this time, as a visitor's map).
 */
export function useCommunityInfo(enabled = true): CommunityInfo | null {
    const [info, setInfo] = useState<CommunityInfo | null>(null);
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        // Inside a promise, so a read that throws at once is a read that failed (as ProjectsPage reads it): hidden.
        Promise.resolve().then(() => communityInfoOnce()).then((i) => { if (!cancelled) setInfo(i); }, () => {});
        return () => { cancelled = true; };
    }, [enabled]);
    return info;
}

/**
 * Whether the reader's own set can change a mode on this node: it shows previews, or has a feature off. A node with
 * every feature on and no `showcase` has nothing a reader's set could change today, so it is never asked. No info: no.
 */
export function readerSetMatters(info: CommunityInfo | null | undefined): boolean {
    if (!info) return false;
    const node = info.features as FeatureSet;
    return node?.showcase === true || SHOWCASE_FEATURES.some((f) => node?.[f] === false);
}

let readerOnce: { key: string; set: Promise<FeatureSet> } | null = null;

/**
 * The signed reader's own `features` (GET /api/community/me), read once per page load for the key in this browser;
 * null with no key, or on a node where it cannot matter (`readerSetMatters`): no request is made. Also null from a node
 * that sends none, or when the read fails: a 401 or 403 is kept for the page load, any other failure is not, so the next
 * caller asks again.
 */
export async function readerFeaturesOnce(info: CommunityInfo | null | undefined): Promise<FeatureSet> {
    if (!readerSetMatters(info)) return null;
    const identity = await loadIdentity().catch(() => null);
    if (!identity?.publicKey) return null;
    if (readerOnce?.key !== identity.publicKey) {
        const key = identity.publicKey;
        const set = getCommunityMe().then(
            (me) => {
                const f = (me as { features?: unknown }).features;
                return f && typeof f === 'object' ? f as Record<string, unknown> : null;
            },
            (e: unknown) => {
                const status = (e as { status?: number } | null)?.status;
                if (status !== 401 && status !== 403 && readerOnce?.key === key) readerOnce = null;
                return null;
            },
        );
        readerOnce = { key, set };
    }
    return readerOnce.set;
}

/** Tests only: forget the reader's set, as a new page load would. */
export function resetReaderFeaturesOnce(): void {
    readerOnce = null;
}

/**
 * The reader's own set on the node `info` describes; null until it arrives, until `info` does, for a visitor, where
 * it cannot matter, and when `enabled` is false (nothing is read).
 */
export function useReaderFeatures(info: CommunityInfo | null | undefined, enabled = true): FeatureSet {
    const [set, setSet] = useState<FeatureSet>(null);
    useEffect(() => {
        if (!enabled || !info) return;
        let cancelled = false;
        readerFeaturesOnce(info).then((s) => { if (!cancelled) setSet(s); }, () => {});
        return () => { cancelled = true; };
    }, [enabled, info]);
    return set;
}

/**
 * One feature's mode for this reader: the node's info and the reader's own set (the node's until it arrives).
 * `enabled` false: nothing is read and the mode is `hidden`, as before (a visitor's map, which composes nothing).
 */
export function useFeatureMode(feature: ShowcaseFeature, enabled = true): FeatureMode {
    const info = useCommunityInfo(enabled);
    return modeFor(feature, info, useReaderFeatures(info, enabled));
}

/**
 * Whether a screen may ask the node for the reader's own data that belongs to `feature` (their balance, deals, voice
 * credits, invites): the one guard every such read on the web goes through (design §6 W2, "a marked feature reads
 * nothing of the reader's"; core's `readsOwnData`). It waits for the node's info, then answers no only where the
 * feature is in preview: the page draws Example Valley and needs nothing of the reader's. Live, read-only and hidden
 * read as before, and a node whose info can't be read is hidden here, so it reads as before too: a local community
 * makes the same requests as it always has, and never waits on the reader's own set.
 *
 * The reader's own set can only turn a preview live (BeanID's verified member: `featureModeFor`), so it is waited for
 * only where the node's set alone says preview.
 */
export async function readsOwn(feature: ShowcaseFeature): Promise<boolean> {
    // Inside a promise, so a read that throws at once is a read that failed: hidden, as useCommunityInfo reads it.
    const info = await Promise.resolve().then(() => communityInfoOnce()).catch(() => null);
    if (readsOwnData(modeFor(feature, info))) return true;
    const reader = await readerFeaturesOnce(info).catch(() => null);
    return readsOwnData(modeFor(feature, info, reader));
}

/**
 * `readsOwn` for a component: false until it has answered, so an effect that reads the reader's own data waits for it
 * and runs again when it turns true. `enabled` false: false, and nothing is asked.
 */
export function useReadsOwn(feature: ShowcaseFeature, enabled = true): boolean {
    const [reads, setReads] = useState(false);
    useEffect(() => {
        if (!enabled) { setReads(false); return; }
        let cancelled = false;
        readsOwn(feature).then((r) => { if (!cancelled) setReads(r); }, () => {});
        return () => { cancelled = true; };
    }, [feature, enabled]);
    return reads;
}

/**
 * The whole enterprise list, read only where the light statuses read (GET /api/enterprises/statuses) failed: an older
 * node. Not where the node refused that read as `feature_off`, and not where enterprises are a preview for this reader
 * (the global node, whose list answers the same refusal): there is no enterprise to hide (review of #2035, N1). Null
 * where it is not read; an empty list where the read fails, as before.
 */
export async function treasuriesFallback(statusesError: unknown): Promise<{ treasuries: Treasury[] } | null> {
    const refusal = statusesError as { status?: number; code?: string } | null;
    if (refusal?.status === 404 && refusal.code === 'feature_off') return null;
    if (!(await readsOwn('enterprises'))) return null;
    return getTreasuries().catch(() => ({ treasuries: [] }));
}

/** Preview or read-only: the feature lives in a local community for this reader, so its actions carry the marker. */
export function marked(mode: FeatureMode): boolean {
    return mode === 'preview' || mode === 'read-only';
}
