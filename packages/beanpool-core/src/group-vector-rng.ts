/**
 * The only randomness group-crypto.ts takes from outside the platform CSPRNG: a fixed stream minted here, by the frozen
 * vectors (group-line-vectors.ts) and core's tests. Not in the core barrel, so an app or the node can't mint one; any
 * function handed in without being minted here is refused. (Review of #1749, finding 4: a stray zero RNG made an all-zero
 * epoch key with no error.)
 */
const minted = new WeakSet<object>();

/** Mark `fn` as a vectors or test stream that group-crypto.ts will take in place of the platform CSPRNG. */
export function mintGroupVectorRng(fn: (n: number) => Uint8Array): (n: number) => Uint8Array {
    minted.add(fn);
    return fn;
}

/** True only for a stream mintGroupVectorRng made. */
export function isGroupVectorRng(fn: unknown): fn is (n: number) => Uint8Array {
    return typeof fn === 'function' && minted.has(fn);
}
