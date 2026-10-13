/**
 * A member's key code: 20 digits in five groups of four, the same on both phones, for two people to compare in person
 * (DESIGN-dm-peer-key-pin, slice 2). It is the one thing on the "key changed" banner a node can't rename: the node can
 * put any name on any key, but not make another key give this code.
 *
 * One code per key in the whole app (#1873 review, finding 1): this is core's namesKeyCode, the code the names list shows
 * as "Your code" and owners read aloud to check each other. SHA-256 of a labelled hex key, five 4-byte slices of the
 * digest each mod 10,000 (about 66 bits). Nothing is stored: it is worked out from the key each time it is shown.
 */

import { namesKeyCode } from '@beanpool/core';

const KEY_HEX = /^[0-9a-f]{64}$/;

/** The key code for a public key (64 hex characters, any case), or null for anything that isn't one. */
export function keyCodeOf(publicKeyHex: string | null | undefined): string | null {
    const hex = typeof publicKeyHex === 'string' ? publicKeyHex.trim().toLowerCase() : '';
    if (!KEY_HEX.test(hex)) return null;
    return namesKeyCode(hex);
}
