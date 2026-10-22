/**
 * The community's place: the manager's one map pin (NodeIdentityPanel), saved as the service area's centre (node config
 * `serviceRadius`) and as the node's own place (local config `location`). An operator may have set it at home.
 *
 * Who gets it, from every read that says it (Marty, 23 Oct 2026, board card share-location-off: "Yes, OFF means hidden"):
 *   - an owner or admin of this node: exact, as the manager's Node Identity screen edits it (a save never writes a
 *     rounded pin back);
 *   - a member here who reads as one (readsAsMember, the verified signer): to two decimals (~1 km), whatever the switch
 *     says. A suspended or disabled member reads what a non-member reads while it lasts, as the Home answer's
 *     community.place already has it;
 *   - anyone else: to two decimals while "Share Location & Radius" (`publishLocation`) is on, and nothing at all while it
 *     is off. The directory is told what anyone else is (state-engine getDirectoryInfo), so a community finds its place
 *     on global's map only with the switch on, as its label says.
 * A read that can't tell who is asking passes no signer, and its reader is anyone else: /api/local/* is never
 * signature-checked (https-server isSignatureBypassed), so there a member's signed read is a stranger's.
 *
 * Never an oracle: a signer is told only whether it itself reads as a member here, which its own key already knows.
 */
import { getNodeConfig, readsAsMember } from '../state-engine.js';

/** How a reader gets the place: exact, to two decimals, or not at all. */
export type PlaceShown = 'exact' | 'rounded' | 'none';

/** How this reader gets the place: an owner or admin, the verified signer (if any), and the switch as saved now. */
export function placeShownTo(reader: { ownerOrAdmin: boolean; signer?: string | null }): PlaceShown {
    if (reader.ownerOrAdmin) return 'exact';
    if (getNodeConfig().publishLocation) return 'rounded';
    return readsAsMember(reader.signer) ? 'rounded' : 'none';
}

const twoDecimals = (n: number) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);

/**
 * `place` as `shown` has it: its lat and lng, exact or to two decimals, and the service area's radiusKm if it has one; or
 * null. Only those fields, never the stored object: the manager's save of the service area is not shape-checked. No place
 * set is null.
 */
export function placeAs<T extends { lat: number; lng: number; radiusKm?: number }>(place: T | null | undefined, shown: PlaceShown): T | null {
    if (!place || typeof place !== 'object' || shown === 'none') return null;
    const at = shown === 'exact' ? (n: number) => n : twoDecimals;
    return { lat: at(place.lat), lng: at(place.lng), ...('radiusKm' in place ? { radiusKm: place.radiusKm } : {}) } as T;
}
