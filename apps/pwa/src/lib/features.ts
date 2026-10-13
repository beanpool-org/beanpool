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
 * - **Before the info arrives** every feature reads `hidden`: no screen flashes a preview a live node then takes away.
 */

import { useEffect, useState } from 'react';
import { featureModeFor, START_COMMUNITY_URL_DEFAULT, type FeatureMode, type ShowcaseFeature } from '@beanpool/core';
import { getCommunityMe, type CommunityInfo } from './api';
import { loadIdentity } from './identity';
import { communityInfoOnce } from './visitor-lobby-gate';

type FeatureSet = Record<string, unknown> | null | undefined;

/** One feature's mode from the node's info and the reader's own set. No info yet: hidden. */
export function modeFor(feature: ShowcaseFeature, info: CommunityInfo | null | undefined, reader?: FeatureSet): FeatureMode {
    if (!info) return 'hidden';
    return featureModeFor(feature, info.features as FeatureSet, reader);
}

/** Where Start a community leads: the node's `startCommunityUrl` (W1) when it names one, else beanpool.org's. */
export function startCommunityUrl(info: CommunityInfo | null | undefined): string {
    const url = (info as { startCommunityUrl?: unknown } | null | undefined)?.startCommunityUrl;
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : START_COMMUNITY_URL_DEFAULT;
}

/** The node's info, read once and shared; null until it arrives, and null for good when the node can't be asked. */
export function useCommunityInfo(): CommunityInfo | null {
    const [info, setInfo] = useState<CommunityInfo | null>(null);
    useEffect(() => {
        let cancelled = false;
        // Inside a promise, so a read that throws at once is a read that failed (as ProjectsPage reads it): hidden.
        Promise.resolve().then(() => communityInfoOnce()).then((i) => { if (!cancelled) setInfo(i); }, () => {});
        return () => { cancelled = true; };
    }, []);
    return info;
}

let readerOnce: { key: string; set: Promise<FeatureSet> } | null = null;

/**
 * The signed reader's own `features` (GET /api/community/me), read once per page load for the key in this browser;
 * null with no key (no request is made), from a node that sends none, or when the read fails (not kept, so the next
 * caller asks again).
 */
export async function readerFeaturesOnce(): Promise<FeatureSet> {
    const identity = await loadIdentity().catch(() => null);
    if (!identity?.publicKey) return null;
    if (readerOnce?.key !== identity.publicKey) {
        const key = identity.publicKey;
        const set = getCommunityMe().then(
            (me) => {
                const f = (me as { features?: unknown }).features;
                return f && typeof f === 'object' ? f as Record<string, unknown> : null;
            },
            () => {
                if (readerOnce?.key === key) readerOnce = null;
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

/** The reader's own set; null until it arrives, and for a visitor. */
export function useReaderFeatures(): FeatureSet {
    const [set, setSet] = useState<FeatureSet>(null);
    useEffect(() => {
        let cancelled = false;
        readerFeaturesOnce().then((s) => { if (!cancelled) setSet(s); }, () => {});
        return () => { cancelled = true; };
    }, []);
    return set;
}

/** One feature's mode for this reader: the node's info and the reader's own set (the node's until it arrives). */
export function useFeatureMode(feature: ShowcaseFeature): FeatureMode {
    return modeFor(feature, useCommunityInfo(), useReaderFeatures());
}
