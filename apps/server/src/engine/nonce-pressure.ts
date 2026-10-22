/**
 * What a nonce store (engine/member-signature.ts NonceStore) turned away for room, per class of signer: written by the
 * store, read by the alert tick (services/alerts.ts `requests.flood`) through {@link requestNoncePressure}, the process
 * store's. It imports nothing, so alerts.ts never pulls in the verifier, which reaches own-addresses.ts and
 * state-engine.ts (the separation services/security-signal.ts keeps from alerts.ts).
 *
 * It holds counts and times. The keys refused for their own share are kept, in memory only, so the tick can say how
 * many there were; nothing here ever leaves the process.
 */

/**
 * Whose a refused nonce was (scratch/fable-design/DESIGN-nonce-store-3-fable.md): `member`, an established member
 * (engine/probation.ts isEstablishedMember); `newcomer`, any other key with a row that acts here (a member in their first
 * days or with 12 words alone, on the global node one on probation, a visitor's row); `stranger`, any other verified key.
 */
export type NonceClass = 'member' | 'newcomer' | 'stranger';

/** One class's refusals. */
export interface RegionPressure {
    /**
     * When the class's ceiling was last reached, and how many times since the start: the rows' region full for a member,
     * the newer accounts' line for a newcomer, the strangers' region for a stranger.
     */
    regionAt: number | null;
    regionRefusals: number;
    /** When an owner (a key, a stranger's address) was last refused for its own share, and how many times. */
    ownerAt: number | null;
    ownerRefusals: number;
    /** At the last refusal: the nonces in flight in its region, their owners, the class's ceiling and an owner's share. */
    live: number;
    owners: number;
    ceiling: number;
    share: number;
}

export interface NoncePressure {
    member: RegionPressure;
    newcomer: RegionPressure;
    stranger: RegionPressure;
    /** Keys (members' and newcomers') refused for their own share, by when they last were: oldest first. */
    keysAtShare: Map<string, { at: number; cls: 'member' | 'newcomer' }>;
}

/** Keys refused at their share are remembered this long, and at most this many (the oldest go first). */
const KEYS_AT_SHARE_KEPT_MS = 15 * 60_000;
const KEYS_AT_SHARE_MAX = 10_000;

const emptyRegion = (): RegionPressure => ({
    regionAt: null, regionRefusals: 0, ownerAt: null, ownerRefusals: 0, live: 0, owners: 0, ceiling: 0, share: 0,
});

export function emptyNoncePressure(): NoncePressure {
    return { member: emptyRegion(), newcomer: emptyRegion(), stranger: emptyRegion(), keysAtShare: new Map() };
}

/** The signed requests' and `/ws` tokens' store's (member-signature.ts requestNonces): what the alert tick reads. */
export const requestNoncePressure: NoncePressure = emptyNoncePressure();

/**
 * A refusal for room: `why` says whose room ran out (the owner's share, the newer accounts' line, the region), `owner`
 * is whose request it was.
 */
export function noteRoomRefusal(
    p: NoncePressure, cls: NonceClass, why: 'owner' | 'line' | 'region', owner: string, at: number,
    held: { live: number; owners: number; ceiling: number; share: number },
): void {
    const r = p[cls];
    if (why === 'owner') {
        r.ownerAt = at;
        r.ownerRefusals++;
    } else {
        r.regionAt = at;
        r.regionRefusals++;
    }
    Object.assign(r, held);
    if (cls === 'stranger' || why !== 'owner') return;
    const keys = p.keysAtShare;
    keys.delete(owner);
    keys.set(owner, { at, cls });
    for (const [key, k] of keys) {
        if (keys.size <= KEYS_AT_SHARE_MAX && at - k.at < KEYS_AT_SHARE_KEPT_MS) break;
        keys.delete(key);
    }
}

/** How many keys of `cls` were refused for their own share at `since` or later. */
export function keysAtShareSince(p: NoncePressure, since: number, cls: 'member' | 'newcomer'): number {
    let n = 0;
    for (const k of p.keysAtShare.values()) if (k.at >= since && k.cls === cls) n++;
    return n;
}
