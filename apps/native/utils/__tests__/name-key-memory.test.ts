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
        expect(confirmed.memory.ana).toEqual({ key: ana2.pub, was: [ana1.pub] });
        const unconfirmed = noteRosterNames(first, [{ memberPubkey: ana2.pub, callsign: 'Ana' }]);
        expect([...unconfirmed.changed]).toEqual([ana2.pub]);
        const later = noteRosterNames(unconfirmed.memory, [{ memberPubkey: ana2.pub, callsign: 'Ana', formerKeys: [{ pubkey: s.pubkey, at: s.at, sig: s.sig }] }]);
        expect(later.changed.size).toBe(0);
        expect(later.memory.ana).toEqual({ key: ana2.pub, was: [ana1.pub] });
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
        expect(shown[0]).toMatchObject({ authorName: 'Ana', authorHint: KEY_CHANGED_HINT, integrityNote: KEY_CHANGED_DETAILS });
        expect(shown[1]).toBe(lines[1]);
        expect(shown[2]).toBe(lines[2]);
        expect(shown[3].integrityNote).toBe(`Sent from an earlier key of Ana's, replaced 3 Oct 2026. ${KEY_CHANGED_DETAILS}`);
        expect(markKeyChanged(lines, new Set())).toEqual(lines);
    });

    it('review of #1826 NB4: a chain over a key still in the same roster counts for nothing; a name two rows share is left as it was', () => {
        const pup = person();
        const byPup = makeKeySuccession({ newEdPrivHex: pup.seedHex, oldPubHex: ana1.pub, at: '2026-10-03T04:00:00.000Z' });
        const pupClaim = [{ pubkey: byPup.pubkey, at: byPup.at, sig: byPup.sig }];
        const first = noteRosterNames({}, [{ memberPubkey: ana1.pub, callsign: 'Ana' }]).memory;
        // Shared name: the real Ana and a puppet both "Ana", the puppet claiming her (current) key. Nothing moves or marks.
        const both = [{ memberPubkey: ana1.pub, callsign: 'Ana' }, { memberPubkey: pup.pub, callsign: 'Ana', formerKeys: pupClaim }];
        let m = first;
        for (let i = 0; i < 3; i++) {
            const seen = noteRosterNames(m, both);
            expect(seen.changed.size).toBe(0);
            expect(seen.memory.ana).toEqual({ key: ana1.pub });
            m = seen.memory;
        }
        // The node renames the real Ana and gives "Ana" to the puppet with that claim: a change, marked on the puppet.
        const renamed = noteRosterNames(first, [{ memberPubkey: ana1.pub, callsign: 'Ann' }, { memberPubkey: pup.pub, callsign: 'Ana', formerKeys: pupClaim }]);
        expect([...renamed.changed]).toEqual([pup.pub]);
        expect(renamed.memory.ana).toEqual({ key: pup.pub, changedFrom: ana1.pub });
    });

    it('names fold case as the node does (ASCII only): "Ána" and "ána" are two names', () => {
        const first = noteRosterNames({}, [{ memberPubkey: ana1.pub, callsign: 'Ána' }, { memberPubkey: mal.pub, callsign: 'ána' }]);
        expect(first.changed.size).toBe(0);
        const again = noteRosterNames(first.memory, [{ memberPubkey: ana1.pub, callsign: 'Ána' }, { memberPubkey: mal.pub, callsign: 'ána' }]);
        expect(again.changed.size).toBe(0);
        expect(Object.keys(again.memory).sort()).toEqual(['ána', 'Ána'].sort());
    });
});
