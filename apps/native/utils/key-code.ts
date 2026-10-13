/**
 * A member's key code: 20 digits in five groups of four, the same on both phones, for two people to compare in person
 * (DESIGN-dm-peer-key-pin, slice 2). It is the one thing on the "key changed" banner a node can't rename: the node can
 * put any name on any key, but not make another key give this code.
 *
 * SHA-256 of the public key's 32 bytes; each group is a 5-byte slice of the digest taken mod 10,000 (about 66 bits in
 * all, as Signal's safety numbers slice theirs). Nothing is stored: it is worked out from the key each time it is shown.
 */

import { sha256 } from '@noble/hashes/sha2.js';

const KEY_HEX = /^[0-9a-f]{64}$/;

/** The key code for a public key (64 hex characters, any case), or null for anything that isn't one. */
export function keyCodeOf(publicKeyHex: string | null | undefined): string | null {
    const hex = typeof publicKeyHex === 'string' ? publicKeyHex.trim().toLowerCase() : '';
    if (!KEY_HEX.test(hex)) return null;
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const digest = sha256(bytes);
    const groups: string[] = [];
    for (let g = 0; g < 5; g++) {
        let n = 0;
        // 5 bytes = 40 bits: below 2^53, so plain numbers hold it exactly.
        for (let i = 0; i < 5; i++) n = n * 256 + digest[g * 5 + i];
        groups.push(String(n % 10000).padStart(4, '0'));
    }
    return groups.join(' ');
}
