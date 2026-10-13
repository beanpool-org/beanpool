/**
 * The phone remembers which key each name had (line-display design §10 pick 3): a name that moves to another key with no
 * statement from the new key reaching the old one is marked "(key changed)"; a confirmed re-key is no change; the mark
 * stays until a statement is served.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }));

import { noteRosterNames, markKeyChanged, KEY_CHANGED_DETAILS, KEY_CHANGED_HINT } from '../name-key-memory';
import { makeKeySuccession } from '../group-chat-crypto';

const person = () => { const seed = randomBytes(32); return { seedHex: bytesToHex(seed), pub: bytesToHex(ed25519.getPublicKey(seed)) }; };

describe('name ↔ key memory', () => {
    const ana1 = person();
    const ana2 = person();
    const mal = person();

    it('remembers a name first seen, and marks nothing', () => {
        const { memory, changed } = noteRosterNames({}, [{ memberPubkey: ana1.pub, callsign: 'Ana' }]);
        expect(memory).toEqual({ ana: { key: ana1.pub } });
        expect(changed.size).toBe(0);
    });

    it('marks a name the node moved to another key with no statement, and keeps the mark', () => {
        const first = noteRosterNames({}, [{ memberPubkey: ana1.pub, callsign: 'Ana' }]).memory;
        const moved = noteRosterNames(first, [{ memberPubkey: mal.pub, callsign: 'ana' }]);
        expect([...moved.changed]).toEqual([mal.pub]);
        expect(moved.memory.ana).toEqual({ key: mal.pub, changedFrom: ana1.pub });
        expect([...noteRosterNames(moved.memory, [{ memberPubkey: mal.pub, callsign: 'Ana' }]).changed]).toEqual([mal.pub]);
        expect(KEY_CHANGED_HINT).toBe('(key changed)');
    });

    it('a re-key the member confirmed is no change; a statement served later clears the mark', () => {
        const first = noteRosterNames({}, [{ memberPubkey: ana1.pub, callsign: 'Ana' }]).memory;
        const s = makeKeySuccession({ newEdPrivHex: ana2.seedHex, oldPubHex: ana1.pub, at: '2026-10-03T04:00:00.000Z' });
        const confirmed = noteRosterNames(first, [{ memberPubkey: ana2.pub, callsign: 'Ana', formerKeys: [{ pubkey: s.pubkey, at: s.at, sig: s.sig }] }]);
        expect(confirmed.changed.size).toBe(0);
        expect(confirmed.memory.ana).toEqual({ key: ana2.pub });
        const unconfirmed = noteRosterNames(first, [{ memberPubkey: ana2.pub, callsign: 'Ana' }]);
        expect([...unconfirmed.changed]).toEqual([ana2.pub]);
        const later = noteRosterNames(unconfirmed.memory, [{ memberPubkey: ana2.pub, callsign: 'Ana', formerKeys: [{ pubkey: s.pubkey, at: s.at, sig: s.sig }] }]);
        expect(later.changed.size).toBe(0);
        expect(later.memory.ana).toEqual({ key: ana2.pub });
    });

    it('a statement signed by anyone but the new key does not clear it', () => {
        const first = noteRosterNames({}, [{ memberPubkey: ana1.pub, callsign: 'Ana' }]).memory;
        const byMal = makeKeySuccession({ newEdPrivHex: mal.seedHex, oldPubHex: ana1.pub, at: '2026-10-03T04:00:00.000Z' });
        const forged = noteRosterNames(first, [{ memberPubkey: ana2.pub, callsign: 'Ana', formerKeys: [{ pubkey: byMal.pubkey, at: byMal.at, sig: byMal.sig }] }]);
        expect([...forged.changed]).toEqual([ana2.pub]);
    });

    it('a marked key\'s lines carry the mark and the details; other lines and nameless ones are left as they are', () => {
        const changed = new Set([mal.pub]);
        const lines = [
            { id: '1', senderId: mal.pub, authorName: 'Ana', integrityNote: null, unattributed: false },
            { id: '2', senderId: ana1.pub, authorName: 'Ana', integrityNote: 'Sent from an earlier key of Ana\'s, replaced 3 Oct 2026.', unattributed: false },
            { id: '3', senderId: '', authorName: 'Unverified', integrityNote: 'x', unattributed: true },
            { id: '4', senderId: mal.pub, authorName: 'Ana', integrityNote: 'Sent from an earlier key of Ana\'s, replaced 3 Oct 2026.', unattributed: false },
        ];
        const shown = markKeyChanged(lines, changed);
        expect(shown[0]).toMatchObject({ authorName: 'Ana (key changed)', integrityNote: KEY_CHANGED_DETAILS });
        expect(shown[1]).toBe(lines[1]);
        expect(shown[2]).toBe(lines[2]);
        expect(shown[3].integrityNote).toBe(`Sent from an earlier key of Ana's, replaced 3 Oct 2026. ${KEY_CHANGED_DETAILS}`);
        expect(markKeyChanged(lines, new Set())).toEqual(lines);
    });
});
