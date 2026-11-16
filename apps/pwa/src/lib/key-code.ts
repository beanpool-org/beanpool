/**
 * A member's key code on the web (DESIGN-dm-key-signal-model §5, slice S3): the same 20 digits, in five groups of four, that
 * the phone shows for the same key (apps/native/utils/key-code.ts). Both apps work it out with core's namesKeyCode, the one
 * code per key in the whole app, so a web member and a phone member reading out their codes compare like for like.
 *
 * Read only: nothing is stored or sent. The web keeps no record of anyone's key, so it never says whether a code changed or
 * whether a person was checked; the phone app is where a member marks someone as verified.
 */

import { namesKeyCode } from '@beanpool/core';

const KEY_HEX = /^[0-9a-f]{64}$/;

/** The key code for a public key (64 hex characters, any case), or null for anything that isn't one. */
export function keyCodeOf(publicKeyHex: string | null | undefined): string | null {
    const hex = typeof publicKeyHex === 'string' ? publicKeyHex.trim().toLowerCase() : '';
    if (!KEY_HEX.test(hex)) return null;
    return namesKeyCode(hex);
}

/**
 * The code as a screen reader says it: every digit on its own, a pause between groups ("4 8 2 1, 0 9 3 7, …"), never
 * "four thousand eight hundred…", as the phone says it. The visible code stays the five groups of four.
 */
export function keyCodeSpoken(code: string): string {
    return code.trim().split(/\s+/).map((group) => group.split('').join(' ')).join(', ');
}
