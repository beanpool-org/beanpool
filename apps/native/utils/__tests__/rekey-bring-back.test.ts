/**
 * A bring-back on the phone (vault rethink VR3; utils/rekey-redeem.ts): a `BB-` code takes the re-key's ask, and the
 * `released` answer opens, with the key the phone asked with, to the member's SAME key and 12 words. The sibling of
 * rekey-redeem.test.ts: storage, signing and the network are fakes; the copy, the release and their keys are real
 * (@beanpool/core), made as the community's server makes them. No node is contacted. Test keys only.
 */

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { communityCopyForRelease, sealReleaseToDevice, sealSeedToCopyKey } from '@beanpool/core';
import {
    askRekey, beginRekey, cleanRekeyCode, isBringBackCode, isRekeyCode, openBringBack, parseRekeyLink, pollRekey,
    BRING_BACK_NOT_OPENED, type RekeyDeps, type RekeySlot,
} from '../rekey-redeem';
import type { BeanPoolIdentity } from '../identity';

// Test phrases only (a BIP-39 vector), never a real account's: the apps' derivation, seed = SHA256(SHA256(words)).
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const MEMBER_SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const MEMBER_KEY = bytesToHex(ed25519.getPublicKey(MEMBER_SEED));
const OTHER_SEED = new Uint8Array(32).fill(7);

const keyOf = (seed: Uint8Array): BeanPoolIdentity => ({
    publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), callsign: '', createdAt: '2026-10-30T00:00:00.000Z',
});

const MULLUM = 'https://mullum.example.org';
const CODE = 'BB-AB12-CD34';

function world(answers: Array<{ status: number; body: unknown }>, phone: BeanPoolIdentity | null = null) {
    let slot: RekeySlot | null = null;
    const draft = keyOf(new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff));
    const queue = [...answers];
    const deps: RekeyDeps = {
        slot: { get: async () => slot, set: async (s) => { slot = JSON.parse(JSON.stringify(s)); }, clear: async () => { slot = null; } },
        loadIdentity: async () => phone,
        draftIdentity: async () => draft,
        importIdentity: async () => { throw new Error('a bring-back never imports the key it asked with'); },
        signStatement: async (url) => ({ signature: 'sig', signedFor: new URL(url).hostname }),
        signedHeaders: async (_m, url) => ({ 'X-Signed-For': new URL(url).hostname }),
        fetch: (async () => {
            const a = queue.shift();
            if (!a) throw new TypeError('Network request failed');
            return new Response(JSON.stringify(a.body), { status: a.status });
        }) as typeof fetch,
    };
    return { deps, draft, slot: () => slot };
}

/** What the community's server answers the phone's poll with, made as engine/bring-back.ts makes it. */
function released(to: string, seed = MEMBER_SEED, words: string[] | null = WORDS, memberKey = MEMBER_KEY, code = CODE) {
    const made = sealSeedToCopyKey(seed, { words });
    return {
        status: 200,
        body: {
            state: 'released', callsign: 'MiaMember', communityName: 'Mullum', memberKey,
            release: sealReleaseToDevice(communityCopyForRelease(made), to, { collectionId: code, holderType: 'community' }),
        },
    };
}
const waiting = { status: 200, body: { state: 'waiting', match: '47', expiresAt: '2026-10-31T00:00:00.000Z' } };

describe('a bring-back code', () => {
    it('keeps its BB- prefix; eight digits alone are still a re-key code', () => {
        expect(cleanRekeyCode(' bb-ab12-cd34 ')).toBe(CODE);
        expect(cleanRekeyCode('bbab12cd34')).toBe(CODE);
        expect(cleanRekeyCode('BB12CD34')).toBe('RK-BB12-CD34');
        expect(cleanRekeyCode('AB12 CD34')).toBe('RK-AB12-CD34');
        expect(isRekeyCode(CODE)).toBe(true);
        expect(isBringBackCode(CODE)).toBe(true);
        expect(isBringBackCode('RK-AB12-CD34')).toBe(false);
        expect(isBringBackCode('BB-AB12-CD3')).toBe(false);
    });

    it('is read from the dashboard\'s QR, on any domain', () => {
        expect(parseRekeyLink(`${MULLUM}/?rekey=bb-ab12-cd34`)).toEqual({ community: MULLUM, code: CODE });
    });
});

describe('the release', () => {
    it('opens with the key the phone asked with, to the member\'s SAME key and words; nothing is imported', async () => {
        const w = world([]);
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        expect(slot.publicKey).toBe(w.draft.publicKey);
        (w.deps as any).fetch = (async () => new Response(JSON.stringify(waiting.body), { status: 200 })) as typeof fetch;
        expect((await askRekey(slot, w.deps)).state).toBe('waiting');
        const answer = released(w.draft.publicKey);
        (w.deps as any).fetch = (async () => new Response(JSON.stringify(answer.body), { status: 200 })) as typeof fetch;
        const polled = await pollRekey(slot, w.deps);
        expect(polled.state).toBe('released');
        if (polled.state !== 'released') return;
        const back = await openBringBack(slot, polled, w.deps);
        expect(back.publicKey).toBe(MEMBER_KEY);
        expect(back.privateKey).toBe(bytesToHex(MEMBER_SEED));
        expect(back.mnemonic).toEqual(WORDS);
    });

    it('a copy without words brings the key alone', async () => {
        const w = world([]);
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        const answer = released(w.draft.publicKey, MEMBER_SEED, null);
        const back = await openBringBack(slot, answer.body as any, w.deps);
        expect(back.publicKey).toBe(MEMBER_KEY);
        expect(back.mnemonic).toBeUndefined();
    });

    it('refuses a release sealed to another key, another account\'s copy, or another code: nothing to save', async () => {
        const w = world([]);
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        const toAnother = released(keyOf(OTHER_SEED).publicKey);
        await expect(openBringBack(slot, toAnother.body as any, w.deps)).rejects.toThrow(BRING_BACK_NOT_OPENED);
        // A server handing out another member's copy and key under this member's name.
        const theirs = released(w.draft.publicKey, OTHER_SEED, null, MEMBER_KEY);
        await expect(openBringBack(slot, theirs.body as any, w.deps)).rejects.toThrow(BRING_BACK_NOT_OPENED);
        const otherCode = released(w.draft.publicKey, MEMBER_SEED, WORDS, MEMBER_KEY, 'BB-0000-1111');
        await expect(openBringBack(slot, otherCode.body as any, w.deps)).rejects.toThrow(BRING_BACK_NOT_OPENED);
    });

    it('a phone with an account asks with that account\'s key, and the release opens with it', async () => {
        const mine = keyOf(new Uint8Array(32).fill(3));
        const w = world([], mine);
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        expect(slot.madeHere).toBe(false);
        expect(slot.publicKey).toBe(mine.publicKey);
        const back = await openBringBack(slot, released(mine.publicKey).body as any, w.deps);
        expect(back.publicKey).toBe(MEMBER_KEY);
    });

    it('an older answer shape is never read as a release', async () => {
        const w = world([{ status: 200, body: { state: 'released', memberKey: 'not-a-key', release: {} } }]);
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        expect((await pollRekey(slot, w.deps)).state).toBe('unreachable');
    });
});
