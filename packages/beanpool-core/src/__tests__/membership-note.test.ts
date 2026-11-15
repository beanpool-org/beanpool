/**
 * "Show my community on global" in core (slice F10; scratch/fable-design/DESIGN-forums-fable.md §12, the joint design §2.6):
 * the note's bytes, its shape, the check, and the name line, held to a frozen vector made independently with Node's own
 * Ed25519 (crypto.sign) and libp2p's PeerId for the same seed, not with the code under test.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    MEMBERSHIP_NOTE_MAX_MS, MEMBERSHIP_NOTE_SKEW_MS, checkMembershipNote, forumWriterNameLine, membershipNoteBytes, nameLine,
    readMembershipNote, signMembershipNote, type MembershipNote,
} from '../index.js';

// Seed 32 × 0x07; its PeerId and a note for member 32 × 0xab, signed by Node's crypto.sign (frozen 15 Nov 2026).
const SEED = new Uint8Array(32).fill(7);
const PUB = 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c';
const VECTOR: MembershipNote = {
    v: 1,
    community: '12D3KooWRawPbxPtP1eZaJpumGnyWX2DcUyd3RQnydr3eAto4Az7',
    name: 'Riverside',
    member: 'ab'.repeat(32),
    issuedAt: 1_800_000_000_000,
    expiresAt: 1_802_592_000_000,
    sig: '521556d7c9d634f091e6d9a7d63f7d191c59c7e5c92573469bc873f622abecb58e9d4821beeaa6aaa667d3ef1bd506eda89229e6d8339bafa5d87a9d840a0403',
};
const pub = Uint8Array.from(Buffer.from(PUB, 'hex'));
const sign = (bytes: Uint8Array) => ed25519.sign(bytes, SEED);
const NOW = VECTOR.issuedAt + 60_000;
const check = (raw: unknown, over: Partial<{ member: string; communityPublicKey: Uint8Array | null; now: number }> = {}) =>
    checkMembershipNote(raw, { member: VECTOR.member, communityPublicKey: pub, now: NOW, ...over });

describe('membership note: the bytes and the vector', () => {
    it('signs to the frozen vector, byte for byte', () => {
        expect(bytesToHex(ed25519.getPublicKey(SEED))).toBe(PUB);
        expect(Buffer.from(membershipNoteBytes(VECTOR)).toString('utf8'))
            .toBe(`["beanpool-membership-note",1,"${VECTOR.community}","Riverside","${VECTOR.member}",1800000000000,1802592000000]`);
        const { v: _v, sig: _sig, ...fields } = VECTOR;
        expect(signMembershipNote(fields, sign)).toEqual(VECTOR);
    });

    it('the frozen note shows a label for its own member, while it lasts', () => {
        expect(check(VECTOR)).toEqual({ ok: true, note: VECTOR });
        expect(check(VECTOR, { now: VECTOR.expiresAt - 1 }).ok).toBe(true);
    });
});

describe('membership note: no label, never a wrong one', () => {
    it('a note for another key', () => {
        expect(check(VECTOR, { member: 'cd'.repeat(32) })).toEqual({ ok: false, problem: 'other_key' });
    });
    it('past its 30 days, or promising more than 30, or from the future', () => {
        expect(check(VECTOR, { now: VECTOR.expiresAt })).toEqual({ ok: false, problem: 'expired' });
        const { v: _v, sig: _sig, ...fields } = VECTOR;
        const long = signMembershipNote({ ...fields, expiresAt: fields.issuedAt + MEMBERSHIP_NOTE_MAX_MS + 1 }, sign);
        expect(check(long)).toEqual({ ok: false, problem: 'too_long' });
        const ahead = signMembershipNote({ ...fields, issuedAt: NOW + MEMBERSHIP_NOTE_SKEW_MS + 1, expiresAt: NOW + MEMBERSHIP_NOTE_SKEW_MS + 2 }, sign);
        expect(check(ahead)).toEqual({ ok: false, problem: 'not_yet' });
        const justAhead = signMembershipNote({ ...fields, issuedAt: NOW + MEMBERSHIP_NOTE_SKEW_MS, expiresAt: NOW + MEMBERSHIP_NOTE_SKEW_MS + 1 }, sign);
        expect(check(justAhead).ok).toBe(true);
    });
    it('a bad signature: any field changed, another key, or no key', () => {
        for (const changed of [
            { ...VECTOR, name: 'Hillside' }, { ...VECTOR, community: '12D3KooWRawPbxPtP1eZaJpumGnyWX2DcUyd3RQnydr3eAto4Az8' },
            { ...VECTOR, expiresAt: VECTOR.expiresAt - 1 }, { ...VECTOR, sig: VECTOR.sig.replace(/^5/, '6') },
        ]) expect(check(changed)).toEqual({ ok: false, problem: 'bad_signature' });
        const other = ed25519.getPublicKey(new Uint8Array(32).fill(8));
        expect(check(VECTOR, { communityPublicKey: other })).toEqual({ ok: false, problem: 'bad_signature' });
        expect(check(VECTOR, { communityPublicKey: null })).toEqual({ ok: false, problem: 'bad_signature' });
    });
    it('not a note: an extra field, a missing one, a time as text, a key in capitals, a name that turns text', () => {
        const { sig: _s, ...noSig } = VECTOR;
        for (const bad of [
            null, [], 'note', { ...VECTOR, extra: 1 }, noSig, { ...VECTOR, v: 2 }, { ...VECTOR, issuedAt: String(VECTOR.issuedAt) },
            { ...VECTOR, member: VECTOR.member.toUpperCase() }, { ...VECTOR, sig: VECTOR.sig.toUpperCase() }, { ...VECTOR, name: '' },
            { ...VECTOR, name: ' Riverside' }, { ...VECTOR, name: 'River‮side' }, { ...VECTOR, name: 'x'.repeat(81) },
            { ...VECTOR, community: 'riverside.example' }, { ...VECTOR, issuedAt: 1.5 },
        ]) {
            expect(readMembershipNote(bad)).toBeNull();
            expect(check(bad)).toEqual({ ok: false, problem: 'malformed' });
        }
    });
});

describe('the name line from a forum writer', () => {
    it('community, waiting, or the name alone', () => {
        expect(nameLine(forumWriterNameLine({ name: 'Marty', label: { kind: 'community', community: 'Riverside' } }))).toBe('Marty · Riverside');
        expect(nameLine(forumWriterNameLine({ name: 'Asha', label: { kind: 'waiting' } }))).toBe('Asha · waiting to join');
        expect(nameLine(forumWriterNameLine({ name: 'Marty', label: null }))).toBe('Marty');
        expect(nameLine(forumWriterNameLine({ name: 'Marty' }))).toBe('Marty');
    });
});
