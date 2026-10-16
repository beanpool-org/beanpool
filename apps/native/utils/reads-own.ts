/**
 * The phone's one guard for reading the reader's own data (scratch/global-node/DESIGN-global-showcase-fable.md §6, "a
 * marked feature reads nothing of the reader's"; the global previews audit's P3): their balance, ledger, deals and the
 * enterprises they keep. The rule is @beanpool/core's `readsOwnData`: never where the feature is in preview, which
 * draws Example Valley and needs nothing of the reader's. Live, read-only and hidden read as they always have.
 *
 * - `readsOwn(feature, publicKey)`: for an effect, a load on focus or a service (pillar-sync). It reads this phone's
 *   own copy of the node's profile (no network), as `useReaderFeatures` does, and the account's own set as the node
 *   last answered it. No community or no copy yet: the node's set is unknown, and a node with none reads as a local
 *   one (featureModeFor), so it reads as before.
 * - `readsOwnWith(feature, node, reader)`: the same rule for a caller that already holds the sets.
 * - A screen that holds the sets in state (market.tsx's `readsOwnDeals`) asks core's `readsOwnData` of its mode, and
 *   reads nothing until that mode is known.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readsOwnData, type ShowcaseFeature } from '@beanpool/core';
import { getCachedNodeProfile, showcaseMode, type NodeFeatures } from './node-profile';

/** Each account's own features as its node last answered (GET /api/community/me, use-reader-features.ts), by node and key. */
export const readerFeaturesHeld = new Map<string, { features: NodeFeatures | null; at: number; freshMs: number }>();
export const readerFeaturesKey = (url: string, publicKey: string) => `${url.trim().replace(/\/+$/, '').toLowerCase()}|${publicKey}`;

/** Whether the reader's own data for `feature` may be asked for, from the node's set and the reader's. */
export function readsOwnWith(feature: ShowcaseFeature, node: NodeFeatures | null | undefined, reader?: NodeFeatures | null): boolean {
    return readsOwnData(showcaseMode(feature, node, reader));
}

/** `readsOwnWith` for the community this phone is on, from its own copy of the node's profile and the account's set. */
export async function readsOwn(feature: ShowcaseFeature, publicKey?: string | null): Promise<boolean> {
    const url = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
    if (!url) return true;
    const profile = await getCachedNodeProfile(url).catch(() => null);
    const reader = publicKey ? readerFeaturesHeld.get(readerFeaturesKey(url, publicKey))?.features ?? null : null;
    return readsOwnWith(feature, profile?.features, reader);
}
