/**
 * Frozen door work (door-work.ts): challenges made from fixed inputs, and their solutions. Shared by the node's tests,
 * the phone's and the browser's, so the three runtimes are held to the SAME bytes: a challenge made from these inputs
 * is exactly `challenge`, and the smallest counters that solve it are exactly `counters`, whichever native SHA-256
 * did the hashing (`node:crypto`, `expo-crypto`, WebCrypto) or the JavaScript one.
 *
 * How they were made: door-work.ts's own `makeDoorWorkChallenge` and `solveDoorWorkSync` with `node:crypto`'s SHA-256,
 * run once (2026-10-01), and the output pasted here. Never regenerate them to make a client pass: a client that no
 * longer finds these counters has changed the puzzle every node checks.
 *
 * Kept out of the main index (import `@beanpool/core/door-work-vectors`) so no app bundle carries it unless a test does.
 */

import type { DoorWorkDoor } from './door-work.js';

/** The work key the vectors were made with: bytes 1 to 32. A node's is random, made at boot. */
export const DOOR_WORK_VECTOR_WORK_KEY_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
/** The 16 "random" bytes in every vector's challenge: 0xa0 to 0xaf. */
export const DOOR_WORK_VECTOR_RANDOM_HEX = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf';
/** The joining key every vector names (the sign-in share vectors' key, sso-share-vectors.ts). */
export const DOOR_WORK_VECTOR_KEY = '2c984dac86ce43aef51c4875274d268fa69e14ae8145efdeff99716620edb4e9';
/** The clock when the vectors were made (2025-10-01T00:00:00Z): each challenge expires ten minutes after. */
export const DOOR_WORK_VECTOR_NOW = 1_759_276_800_000;

export interface DoorWorkVector {
    level: number;
    door: DoorWorkDoor;
    challenge: string;
    /** The smallest counter for each of the 8 parts. */
    counters: readonly number[];
    /** SHA-256 of part 0's winning try, as hex: the first bytes are the zero bits. */
    firstDigestHex: string;
}

export const DOOR_WORK_VECTORS: readonly DoorWorkVector[] = [
    {
        level: 0,
        door: 'words',
        challenge: 'v1.0.1759277400000.oKGio6SlpqeoqaqrrK2urw.NpXFznl0Zv3dbWOFccdcqeQon_tuDyJS4LZdQX8htQk',
        counters: [39, 46, 209, 25, 104, 43, 31, 879],
        firstDigestHex: '013ee24e71c40f5fef6d0805b4e8893352f24da9e0bb01062943cb9becb533e3',
    },
    {
        level: 1,
        door: 'sign-in',
        challenge: 'v1.1.1759277400000.oKGio6SlpqeoqaqrrK2urw.xDFhDc-RKRatSlSP3U56v-JklPPjSwjAybRgPH0b4-c',
        counters: [1495, 231, 271, 139, 213, 3, 268, 203],
        firstDigestHex: '00c006105d0968085d5f112739bccea8b828f46cc84cf549e19f8498f0bbf1f2',
    },
    {
        level: 3,
        door: 'words',
        challenge: 'v1.3.1759277400000.oKGio6SlpqeoqaqrrK2urw.aS7W5ZMzQVbVzvYzQULZrywAwkyoyYqDZh_IjHgAZ3M',
        counters: [27, 758, 2061, 1662, 276, 1479, 634, 391],
        firstDigestHex: '000034d92dd1c5685ea050a674185ee24b2971c0df0e7753274bd876b77d62f8',
    },
];
