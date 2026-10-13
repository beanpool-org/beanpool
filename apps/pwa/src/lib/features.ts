/**
 * How each switched-off feature shows on this node to this reader (scratch/global-node/DESIGN-global-showcase-fable.md §4):
 * `live`, `preview` (from the sample community, with the 🏘️ Local community strip), `read-only` (real data, the marker
 * on the actions) or `hidden` (as today). The rule is @beanpool/core's `featureModeFor`; this file only reads the sets.
 *
 * - **The node's set** is `features` from GET /api/community/info, read once per page load (lib/visitor-lobby-gate.ts).
 * - **The reader's set** is `features` from /api/community/me or /api/home, today equal to the node's (W1). A screen
 *   that already holds it passes it in; signed out, or before it arrives, the node's stands for it. Nothing here asks
 *   for it, so a preview asks the node for nothing but its info.
 * - **Before the info arrives** every feature reads `hidden`: no screen flashes a preview a live node then takes away.
 */

import { useEffect, useState } from 'react';
import { featureModeFor, START_COMMUNITY_URL_DEFAULT, type FeatureMode, type ShowcaseFeature } from '@beanpool/core';
import type { CommunityInfo } from './api';
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

/** One feature's mode, read from the node's info (and the reader's set when a screen has it). */
export function useFeatureMode(feature: ShowcaseFeature, reader?: FeatureSet): FeatureMode {
    return modeFor(feature, useCommunityInfo(), reader);
}
