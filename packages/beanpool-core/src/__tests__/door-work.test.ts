/**
 * Door work (door-work.ts): the challenge, the puzzle, the check, and the frozen vectors every runtime is held to.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import {
    DOOR_WORK_MAX_LEVEL,
    DOOR_WORK_MESSAGE_BYTES,
    DOOR_WORK_PARTS,
    DOOR_WORK_TTL_MS,
    checkDoorWorkChallenge,
    checkDoorWorkSolution,
    doorWorkBits,
    doorWorkMessage,
    doorWorkSha256,
    makeDoorWorkChallenge,
    meetsDoorWorkBits,
    parseDoorWorkChallenge,
    setDoorWorkTry,
    solveDoorWork,
    solveDoorWorkSync,
} from '../door-work.js';
import {
    DOOR_WORK_VECTORS,
    DOOR_WORK_VECTOR_KEY,
    DOOR_WORK_VECTOR_NOW,
    DOOR_WORK_VECTOR_RANDOM_HEX,
    DOOR_WORK_VECTOR_WORK_KEY_HEX,
} from '../door-work-vectors.js';

const native = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const workKey = hexToBytes(DOOR_WORK_VECTOR_WORK_KEY_HEX);
const random = hexToBytes(DOOR_WORK_VECTOR_RANDOM_HEX);
const key = DOOR_WORK_VECTOR_KEY;
const otherKey = 'ab'.repeat(32);

describe('door work vectors', () => {
    for (const v of DOOR_WORK_VECTORS) {
        it(`level ${v.level} (${v.door}): the same challenge from the same inputs, and the same smallest counters`, () => {
            expect(makeDoorWorkChallenge({ workKey, level: v.level, key, door: v.door, now: DOOR_WORK_VECTOR_NOW, random })).toBe(v.challenge);
            expect(solveDoorWorkSync(v.challenge, native)).toEqual(v.counters);
            expect(checkDoorWorkSolution(v.challenge, v.counters, native)).toEqual({ ok: true, hashes: DOOR_WORK_PARTS });
            const m = doorWorkMessage(v.challenge);
            setDoorWorkTry(m, 0, v.counters[0]);
            expect(bytesToHex(native(m))).toBe(v.firstDigestHex);
        });
    }

    it('the JavaScript SHA-256 and the native one agree on a solution', () => {
        const v = DOOR_WORK_VECTORS[0];
        expect(checkDoorWorkSolution(v.challenge, v.counters, doorWorkSha256)).toEqual({ ok: true, hashes: DOOR_WORK_PARTS });
        expect(solveDoorWorkSync(v.challenge)).toEqual(v.counters);
    });

    it('the async solver (a promise per try, as WebCrypto and expo-crypto answer) finds the same counters and reports each part', async () => {
        const v = DOOR_WORK_VECTORS[1];
        const parts: number[] = [];
        const counters = await solveDoorWork(v.challenge, {
            digest: async (b) => native(b).buffer as ArrayBuffer,
            sliceMs: 1,
            onPart: (done, of) => { parts.push(done); expect(of).toBe(DOOR_WORK_PARTS); },
        });
        expect(counters).toEqual(v.counters);
        expect(parts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('a cancelled solve answers null', async () => {
        let tries = 0;
        const out = await solveDoorWork(DOOR_WORK_VECTORS[2].challenge, { digest: native, cancelled: () => ++tries > 50 });
        expect(out).toBeNull();
    });
});

describe('the challenge', () => {
    const challenge = makeDoorWorkChallenge({ workKey, level: 2, key, door: 'words', now: 1_000_000 });

    it('has the documented shape, and the bits grow by one a level', () => {
        const parts = parseDoorWorkChallenge(challenge)!;
        expect(parts).toMatchObject({ level: 2, expires: 1_000_000 + DOOR_WORK_TTL_MS });
        expect(parts.random).toHaveLength(22);
        expect(parts.mac).toHaveLength(43);
        expect(doorWorkBits(0)).toBe(7);
        expect(doorWorkBits(DOOR_WORK_MAX_LEVEL)).toBe(12);
        expect(DOOR_WORK_MESSAGE_BYTES).toBe(32 + 1 + 8 + 65_536);
    });

    it('is this node\'s, for this key at this door, until it expires', () => {
        expect(checkDoorWorkChallenge(challenge, { workKey, key, door: 'words', now: 1_000_000 })).toMatchObject({ ok: true });
        expect(checkDoorWorkChallenge(challenge, { workKey, key, door: 'words', now: 1_000_000 + DOOR_WORK_TTL_MS })).toMatchObject({ ok: true });
        expect(checkDoorWorkChallenge(challenge, { workKey, key, door: 'words', now: 1_000_001 + DOOR_WORK_TTL_MS })).toEqual({ ok: false, reason: 'expired' });
    });

    it('is refused for another key, the other door, another work key (a restart), or with any part changed', () => {
        const now = 1_000_000;
        expect(checkDoorWorkChallenge(challenge, { workKey, key: otherKey, door: 'words', now })).toEqual({ ok: false, reason: 'forged' });
        expect(checkDoorWorkChallenge(challenge, { workKey, key, door: 'sign-in', now })).toEqual({ ok: false, reason: 'forged' });
        expect(checkDoorWorkChallenge(challenge, { workKey: new Uint8Array(32), key, door: 'words', now })).toEqual({ ok: false, reason: 'forged' });
        const [v, , expires, r, mac] = challenge.split('.');
        expect(checkDoorWorkChallenge([v, '0', expires, r, mac].join('.'), { workKey, key, door: 'words', now })).toEqual({ ok: false, reason: 'forged' });
        expect(checkDoorWorkChallenge([v, '2', String(Number(expires) + 60_000), r, mac].join('.'), { workKey, key, door: 'words', now })).toEqual({ ok: false, reason: 'forged' });
        const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A');
        expect(checkDoorWorkChallenge([v, '2', expires, r, flipped].join('.'), { workKey, key, door: 'words', now })).toEqual({ ok: false, reason: 'forged' });
    });

    it('anything else is not a challenge', () => {
        const [v, level, , r, mac] = challenge.split('.');
        for (const junk of [undefined, null, 7, '', 'v1', challenge + '.', 'v2' + challenge.slice(2), challenge.replace('v1.2.', 'v1.6.'),
            challenge.replace('v1.2.', 'v1.02.'), [v, level, '0', r, mac].join('.'), [v, level, '01000000', r, mac].join('.'),
            [v, level, '9'.repeat(16), r, mac].join('.'), ' ' + challenge]) {
            expect(checkDoorWorkChallenge(junk, { workKey, key, door: 'words', now: 1_000_000 })).toEqual({ ok: false, reason: 'malformed' });
        }
    });

    it('refuses to make one past the cap, for a key in another spelling, or for no door', () => {
        expect(() => makeDoorWorkChallenge({ workKey, level: DOOR_WORK_MAX_LEVEL + 1, key, door: 'words' })).toThrow();
        expect(() => makeDoorWorkChallenge({ workKey, level: 0, key: key.toUpperCase(), door: 'words' })).toThrow();
        expect(() => makeDoorWorkChallenge({ workKey, level: 0, key, door: 'sso' as never })).toThrow();
    });
});

describe('the check', () => {
    const v = DOOR_WORK_VECTORS[0];

    it('stops at the first wrong part: one hash for junk', () => {
        // Any counter below the smallest that works is one that doesn't.
        const bad = [0, ...v.counters.slice(1)];
        expect(v.counters[0]).toBeGreaterThan(0);
        expect(checkDoorWorkSolution(v.challenge, bad, native)).toEqual({ ok: false, hashes: 1 });
        const lastWrong = [...v.counters.slice(0, 7), 0];
        expect(checkDoorWorkSolution(v.challenge, lastWrong, native)).toEqual({ ok: false, hashes: 8 });
    });

    it('a solution for one challenge does not solve another', () => {
        expect(checkDoorWorkSolution(DOOR_WORK_VECTORS[2].challenge, v.counters, native).ok).toBe(false);
    });

    it('anything but 8 whole counters is refused without a hash', () => {
        for (const junk of [undefined, null, {}, [], v.counters.slice(0, 7), [...v.counters, 1], [...v.counters.slice(0, 7), -1],
            [...v.counters.slice(0, 7), 1.5], [...v.counters.slice(0, 7), '879'], [...v.counters.slice(0, 7), 2 ** 53]]) {
            expect(checkDoorWorkSolution(v.challenge, junk, native)).toEqual({ ok: false, hashes: 0 });
        }
        expect(checkDoorWorkSolution('not a challenge', v.counters, native)).toEqual({ ok: false, hashes: 0 });
    });

    it('a counter past 32 bits is written in all 8 bytes, big-endian', () => {
        const m = doorWorkMessage(v.challenge);
        setDoorWorkTry(m, 5, 2 ** 40 + 0x01020304);
        expect([...m.slice(32, 41)]).toEqual([5, 0, 0, 1, 0, 1, 2, 3, 4]);
        setDoorWorkTry(m, 7, Number.MAX_SAFE_INTEGER);
        expect([...m.slice(32, 41)]).toEqual([7, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        expect(m.slice(41).every((b) => b === 0)).toBe(true);
    });

    it('meets the bits exactly', () => {
        expect(meetsDoorWorkBits(new Uint8Array([0x01, 0xff]), 7)).toBe(true);
        expect(meetsDoorWorkBits(new Uint8Array([0x02, 0x00]), 7)).toBe(false);
        expect(meetsDoorWorkBits(new Uint8Array([0x00, 0x0f]), 12)).toBe(true);
        expect(meetsDoorWorkBits(new Uint8Array([0x00, 0x1f]), 12)).toBe(false);
        expect(meetsDoorWorkBits(new Uint8Array([0x00, 0xff]), 8)).toBe(true);
    });
});
