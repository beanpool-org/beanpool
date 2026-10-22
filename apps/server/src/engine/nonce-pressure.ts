/**
 * What a nonce store (engine/member-signature.ts NonceStore) turned away for room, per scope: written by the store,
 * read by the alert tick (services/alerts.ts `requests.flood`) through {@link requestNoncePressure}, the process store's.
 * It imports nothing, so alerts.ts never pulls in the verifier, which reaches own-addresses.ts and state-engine.ts (the
 * separation services/security-signal.ts keeps from alerts.ts).
 *
 * It holds counts and times. The member keys refused for their own share are kept, in memory only, so the tick can say
 * how many there were; nothing here ever leaves the process.
 */

/** `member`: a key that acts here (isNodeMember or isLiveVisitor). `stranger`: any other verified key. */
export type NonceScope = 'member' | 'stranger';

/** One region's refusals. */
export interface RegionPressure {
    /** When the region itself last had no room (its ceiling reached), and how many times since the start. */
    regionAt: number | null;
    regionRefusals: number;
    /** When an owner (a member's key, a stranger's address) was last refused for its own share, and how many times. */
    ownerAt: number | null;
    ownerRefusals: number;
    /** At the last refusal: the nonces in flight in the region, their owners, the region's ceiling and an owner's share. */
    live: number;
    owners: number;
    ceiling: number;
    share: number;
}

export interface NoncePressure {
    member: RegionPressure;
    stranger: RegionPressure;
    /** Member keys refused for their own share, by when they last were: oldest first. */
    keysAtShare: Map<string, number>;
}

/** Member keys refused at their share are remembered this long, and at most this many (the oldest go first). */
const KEYS_AT_SHARE_KEPT_MS = 15 * 60_000;
const KEYS_AT_SHARE_MAX = 10_000;

const emptyRegion = (): RegionPressure => ({
    regionAt: null, regionRefusals: 0, ownerAt: null, ownerRefusals: 0, live: 0, owners: 0, ceiling: 0, share: 0,
});

export function emptyNoncePressure(): NoncePressure {
    return { member: emptyRegion(), stranger: emptyRegion(), keysAtShare: new Map() };
}

/** The signed requests' and `/ws` tokens' store's (member-signature.ts requestNonces): what the alert tick reads. */
export const requestNoncePressure: NoncePressure = emptyNoncePressure();

/** A refusal for room: `why` says whose room ran out, `owner` is whose request it was. */
export function noteRoomRefusal(
    p: NoncePressure, scope: NonceScope, why: 'owner' | 'region', owner: string, at: number,
    held: { live: number; owners: number; ceiling: number; share: number },
): void {
    const r = p[scope];
    if (why === 'region') {
        r.regionAt = at;
        r.regionRefusals++;
    } else {
        r.ownerAt = at;
        r.ownerRefusals++;
    }
    Object.assign(r, held);
    if (scope !== 'member' || why !== 'owner') return;
    const keys = p.keysAtShare;
    keys.delete(owner);
    keys.set(owner, at);
    for (const [key, when] of keys) {
        if (keys.size <= KEYS_AT_SHARE_MAX && at - when < KEYS_AT_SHARE_KEPT_MS) break;
        keys.delete(key);
    }
}

/** How many member keys were refused for their own share at `since` or later. */
export function keysAtShareSince(p: NoncePressure, since: number): number {
    let n = 0;
    for (const when of p.keysAtShare.values()) if (when >= since) n++;
    return n;
}
