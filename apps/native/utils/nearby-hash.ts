/**
 * The node's hash of a member's nearby set (apps/server engine/nearby-set-memory.ts nearbySetHash), computed the same way
 * here, so the phone can check a set it built from a diff (`setAdd`/`setDrop`) is the set the node hashed before it writes
 * it (utils/posts-nearby.ts nearbyLastSet). The ids and `tied` each deduped and sorted by UTF-16 code unit (the same on
 * Hermes and V8; never localeCompare), as JSON (injective, where a join is not: a client-minted id may hold a comma),
 * sha256, the first 24 hex. A pinned vector in both suites holds the two together. Apart from posts-nearby.ts, which stays
 * import-free.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (ids: readonly string[]) => [...new Set(ids)].sort(byCodeUnit);

export function nearbySetHash(ids: readonly string[], tied: readonly string[]): string {
    return bytesToHex(sha256(utf8ToBytes(JSON.stringify([canonical(ids), canonical(tied)])))).slice(0, 24);
}
