import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    makeGroupEpochRecord, makeGroupEpochRecordAsync, openGroupLine, sealGroupLine, keySuccessionCanonical, makeKeySuccession,
    verifyKeySuccession, walkKeySuccession, KEY_SUCCESSION_MAX, GroupLineNotVerifiedError, type FormerKey, type GroupLineVerifyMemo,
} from '../group-crypto.js';
import * as core from '../index.js';
import { groupVectorRandom, GROUP_VECTOR_CREATED_AT, GROUP_VECTOR_GROUP, GROUP_VECTOR_PEOPLE, GROUP_VECTOR_RECORD, GROUP_VECTOR_SUCCESSION } from '../group-line-vectors.js';

// What slice 3 (the phone) adds to the shared locks: a rotation that gives the UI a turn (design §15's progress line), a
// once-only verify cache for lines (§7.2), and key succession statements (DESIGN-group-chat-line-display-fable.md §5).

function person(name: string) {
    const seed = sha256(utf8ToBytes(`group-crypto-phone.test ${name}`));
    return { seedHex: bytesToHex(seed), publicKey: bytesToHex(ed25519.getPublicKey(seed)) };
}
const ana1 = person('Ana 1');
const ana2 = person('Ana 2');
const ana3 = person('Ana 3');
const mal = person('Mal');
const AT1 = '2026-10-03T04:00:00.000Z';
const AT2 = '2026-10-08T04:00:00.000Z';

describe('makeGroupEpochRecordAsync: a big rotation that lets the phone draw', () => {
    it('makes the frozen record byte for byte, reporting progress and yielding every 10 wraps by default', async () => {
        const p = GROUP_VECTOR_PEOPLE;
        const seen: [number, number][] = [];
        let yields = 0;
        const made = await makeGroupEpochRecordAsync({
            myEdPrivHex: p.cat.seedHex, groupId: GROUP_VECTOR_GROUP, epoch: 3, reason: 'join', subject: p.cat.publicKey,
            createdAt: GROUP_VECTOR_CREATED_AT, recipients: [p.ana.publicKey, p.ben.publicKey, p.cat.publicKey],
        }, { randomBytesForVectors: groupVectorRandom('epoch 3'), yieldEvery: 1, onProgress: (d, t) => seen.push([d, t]), yieldTo: async () => { yields++; } });
        expect(JSON.stringify(made.record)).toBe(JSON.stringify(GROUP_VECTOR_RECORD));
        expect(seen).toEqual([[1, 3], [2, 3], [3, 3], [3, 3]]);
        expect(yields).toBe(3);
    });

    it('25 recipients: the same record as the sync maker from the same stream, two yields at the default pace', async () => {
        const people = Array.from({ length: 25 }, (_, i) => person(`m${i}`));
        const input = { myEdPrivHex: people[0].seedHex, groupId: GROUP_VECTOR_GROUP, epoch: 7, reason: 'rotate' as const, createdAt: AT1, recipients: people.map((x) => x.publicKey) };
        const sync = makeGroupEpochRecord(input, { randomBytesForVectors: groupVectorRandom('big') });
        let yields = 0;
        const async_ = await makeGroupEpochRecordAsync(input, { randomBytesForVectors: groupVectorRandom('big'), yieldTo: async () => { yields++; } });
        expect(JSON.stringify(async_.record)).toBe(JSON.stringify(sync.record));
        expect(yields).toBe(2);
    });

    it('refuses what the sync maker refuses (a maker outside the recipients), and a fixed stream not minted for vectors', async () => {
        const input = { myEdPrivHex: mal.seedHex, groupId: GROUP_VECTOR_GROUP, epoch: 2, reason: 'rotate' as const, createdAt: AT1, recipients: [ana1.publicKey] };
        await expect(makeGroupEpochRecordAsync(input)).rejects.toThrow(/maker is not a member/);
        await expect(makeGroupEpochRecordAsync({ ...input, recipients: [mal.publicKey] }, { randomBytesForVectors: (n) => new Uint8Array(n) })).rejects.toThrow(/CSPRNG/);
    });
});

describe('the line verify memo (verify once, keep the verdict)', () => {
    const key = new Uint8Array(32).fill(3);
    const MSG = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
    const line = sealGroupLine('hello', { myEdPrivHex: ana1.seedHex, groupKey: key, groupId: GROUP_VECTOR_GROUP, epoch: 2, messageId: MSG });
    const ref = { groupId: GROUP_VECTOR_GROUP, epoch: 2, senderPubHex: ana1.publicKey, messageId: MSG };

    it('remembers a signature only after it verified, and opens the same words from the memo', () => {
        const keys = new Set<string>();
        const memo: GroupLineVerifyMemo = { has: (k) => keys.has(k), add: (k) => { keys.add(k); } };
        expect(openGroupLine(line, ref, key, memo).text).toBe('hello');
        expect(keys.size).toBe(1);
        expect(openGroupLine(line, ref, key, memo).text).toBe('hello');
        expect(keys.size).toBe(1);
    });

    it('a line sealed by Mal naming Ana is refused, memo or not, and adds nothing to it', () => {
        const keys = new Set<string>();
        const memo: GroupLineVerifyMemo = { has: (k) => keys.has(k), add: (k) => { keys.add(k); } };
        openGroupLine(line, ref, key, memo);
        // Mal holds the epoch key, so his line opens by its AEAD under Ana's name: only the signature can refuse it.
        const forged = sealGroupLine('send the hall money to me', { myEdPrivHex: mal.seedHex, groupKey: key, groupId: GROUP_VECTOR_GROUP, epoch: 2, messageId: MSG });
        expect(() => openGroupLine(forged, ref, key, memo)).toThrow(GroupLineNotVerifiedError);
        expect(keys.size).toBe(1);
    });

    it('a verdict is keyed by the exact signature, digest and signer: another sender is verified afresh and refused', () => {
        const keys = new Set<string>();
        const memo: GroupLineVerifyMemo = { has: (k) => keys.has(k), add: (k) => { keys.add(k); } };
        openGroupLine(line, ref, key, memo);
        expect(() => openGroupLine(line, { ...ref, senderPubHex: mal.publicKey }, key, memo)).toThrow(GroupLineNotVerifiedError);
    });
});

describe('key succession (a re-keyed member names their old key with their new one)', () => {
    const s12 = makeKeySuccession({ newEdPrivHex: ana2.seedHex, oldPubHex: ana1.publicKey, at: AT1 });
    const s23 = makeKeySuccession({ newEdPrivHex: ana3.seedHex, oldPubHex: ana2.publicKey, at: AT2 });
    const f = (s: FormerKey): FormerKey => ({ pubkey: s.pubkey, at: s.at, sig: s.sig });

    it('the vector re-derives from the primitives: sign(sha256(canonical)) by the new key', () => {
        const v = GROUP_VECTOR_SUCCESSION;
        const canon = keySuccessionCanonical(v.former.pubkey, v.newPubkey, v.former.at);
        expect(canon).toBe(JSON.stringify(['beanpool-key-succession/1', v.former.pubkey, v.newPubkey, v.former.at]));
        const sig = Buffer.from(ed25519.sign(sha256(utf8ToBytes(canon)), hexToBytes(v.newSeedHex))).toString('base64');
        expect(sig).toBe(v.former.sig);
    });

    it('verifies by the new key only; a statement signed by the old key, or over another old key or date, is refused', () => {
        expect(verifyKeySuccession(f(s12), ana2.publicKey)).toBe(true);
        const byOld = ed25519.sign(sha256(utf8ToBytes(keySuccessionCanonical(ana1.publicKey, ana2.publicKey, AT1))), hexToBytes(ana1.seedHex));
        expect(verifyKeySuccession({ pubkey: ana1.publicKey, at: AT1, sig: Buffer.from(byOld).toString('base64') }, ana2.publicKey)).toBe(false);
        expect(verifyKeySuccession({ ...f(s12), pubkey: mal.publicKey }, ana2.publicKey)).toBe(false);
        expect(verifyKeySuccession({ ...f(s12), at: AT2 }, ana2.publicKey)).toBe(false);
        expect(verifyKeySuccession(f(s12), mal.publicKey)).toBe(false);
        expect(() => makeKeySuccession({ newEdPrivHex: ana2.seedHex, oldPubHex: ana2.publicKey, at: AT1 })).toThrow();
    });

    it('walks Ana₁ → Ana₂ → Ana₃ from her row; the middle statement dropped breaks it', () => {
        const row = { memberPubkey: ana3.publicKey, formerKeys: [f(s23), f(s12)] };
        expect(walkKeySuccession(row, ana2.publicKey)).toBe(true);
        expect(walkKeySuccession(row, ana1.publicKey)).toBe(true);
        expect(walkKeySuccession(row, mal.publicKey)).toBe(false);
        expect(walkKeySuccession({ memberPubkey: ana3.publicKey, formerKeys: [f(s12)] }, ana1.publicKey)).toBe(false);
        expect(walkKeySuccession({ memberPubkey: ana3.publicKey }, ana1.publicKey)).toBe(false);
    });

    it('the pin attack: Mal\'s old key on Ana\'s row, signed by Mal\'s key, by a node key, or by Ana over another key, is refused', () => {
        const node = person('node owner');
        const byMal = makeKeySuccession({ newEdPrivHex: mal.seedHex, oldPubHex: ana1.publicKey, at: AT1 });
        expect(walkKeySuccession({ memberPubkey: ana2.publicKey, formerKeys: [{ pubkey: mal.publicKey, at: AT1, sig: byMal.sig }] }, mal.publicKey)).toBe(false);
        const byNode = ed25519.sign(sha256(utf8ToBytes(keySuccessionCanonical(mal.publicKey, ana2.publicKey, AT1))), hexToBytes(node.seedHex));
        expect(walkKeySuccession({ memberPubkey: ana2.publicKey, formerKeys: [{ pubkey: mal.publicKey, at: AT1, sig: Buffer.from(byNode).toString('base64') }] }, mal.publicKey)).toBe(false);
        expect(walkKeySuccession({ memberPubkey: ana2.publicKey, formerKeys: [{ pubkey: mal.publicKey, at: AT1, sig: s12.sig }] }, mal.publicKey)).toBe(false);
    });

    it('refuses a cycle and a chain longer than KEY_SUCCESSION_MAX', () => {
        const back = makeKeySuccession({ newEdPrivHex: ana1.seedHex, oldPubHex: ana3.publicKey, at: AT2 });
        // Ana₃ ← Ana₂ ← Ana₁ ← Ana₃ again: the walk meets Ana₃ twice and stops before it can name anyone further.
        expect(walkKeySuccession({ memberPubkey: ana3.publicKey, formerKeys: [f(s23), f(s12), f(back), f(s23)] }, mal.publicKey)).toBe(false);
        const keys = Array.from({ length: KEY_SUCCESSION_MAX + 2 }, (_, i) => person(`k${i}`));
        const chain: FormerKey[] = [];
        for (let i = 1; i < keys.length; i++) chain.push(f(makeKeySuccession({ newEdPrivHex: keys[i - 1].seedHex, oldPubHex: keys[i].publicKey, at: AT1 })));
        expect(walkKeySuccession({ memberPubkey: keys[0].publicKey, formerKeys: chain.slice(0, KEY_SUCCESSION_MAX) }, keys[KEY_SUCCESSION_MAX].publicKey)).toBe(true);
        expect(walkKeySuccession({ memberPubkey: keys[0].publicKey, formerKeys: chain }, keys[1].publicKey)).toBe(false);
    });

    it('is in the core barrel, and the raw wrap opener still is not', () => {
        expect(typeof core.walkKeySuccession).toBe('function');
        expect(typeof core.makeGroupEpochRecordAsync).toBe('function');
        expect((core as any).openGroupKeyWrapUnverified).toBeUndefined();
    });
});
