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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { noteRosterNames, noteNamesByKey, markKeyChanged, keysThisPhoneKnewFor, KEY_CHANGED_DETAILS, KEY_CHANGED_HINT } from '../name-key-memory';
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
    it('§4 amendment 2 (confirmation 1 of #1844, finding 2): each key keeps the names it was a row under, one per folded name', () => {
        const once = noteNamesByKey({}, [{ memberPubkey: ana1.pub, callsign: ' Ana ' }, { memberPubkey: mal.pub, callsign: 'Mal' }, { memberPubkey: ana2.pub, callsign: null }]);
        expect(once).toEqual({ [ana1.pub]: ['Ana'], [mal.pub]: ['Mal'] });
        // The same name again (any ASCII case) adds nothing; a lookalike ("Аna", Cyrillic А) is another name.
        const again = noteNamesByKey(once, [{ memberPubkey: ana1.pub, callsign: 'ANA' }, { memberPubkey: mal.pub, callsign: 'Аna' }]);
        expect(again).toEqual({ [ana1.pub]: ['Ana'], [mal.pub]: ['Mal', 'Аna'] });
        // At most 8 a key, newest kept: a key with two names keeps two whatever the node adds.
        let many = again;
        for (let i = 0; i < 12; i++) many = noteNamesByKey(many, [{ memberPubkey: mal.pub, callsign: `x${i}` }]);
        expect(many[mal.pub]).toHaveLength(8);
        expect(many[mal.pub].at(-1)).toBe('x11');
    });

    describe('§4 amendment (review of #1844, finding 1): an unconfirmed move taints a name', () => {
        const cat1 = person();
        const cat2 = person();
        const cat3 = person();
        const zed = person();
        const claim = (by: { seedHex: string }, old: string) => {
            const s = makeKeySuccession({ newEdPrivHex: by.seedHex, oldPubHex: old, at: '2026-10-13T04:00:00.000Z' });
            return { pubkey: s.pubkey, at: s.at, sig: s.sig };
        };
        const knew = async (memory: object, current: string) => {
            vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce(JSON.stringify(memory));
            return keysThisPhoneKnewFor('https://n.example', 'Cat', current);
        };

        it('MP: "Cat" shown once on Zed\'s key, then her new key\'s chain reaching only Zed\'s: the mark stays and Zed never enters her history', async () => {
            const first = noteRosterNames({}, [{ memberPubkey: cat1.pub, callsign: 'Cat' }]).memory;
            const relabelled = noteRosterNames(first, [{ memberPubkey: zed.pub, callsign: 'Cat' }]);
            expect(relabelled.memory.cat).toEqual({ key: zed.pub, changedFrom: cat1.pub });
            // Before her new key shows, the phone's knowledge of "Cat" is the key before the move, never the key it moved to.
            expect(await knew(relabelled.memory, cat2.pub)).toEqual([cat1.pub]);
            // Her new key's chain (the node misled her new phone once) reaches Zed's key only; Zed is left out of the roster.
            const misled = noteRosterNames(relabelled.memory, [{ memberPubkey: cat2.pub, callsign: 'Cat', formerKeys: [claim(cat2, zed.pub)] }]);
            expect(misled.memory.cat).toEqual({ key: cat2.pub, changedFrom: cat1.pub });
            expect([...misled.changed]).toEqual([cat2.pub]);
            expect(await knew(misled.memory, cat2.pub)).toEqual([cat1.pub]);
            // Served again, it still confirms nothing.
            const again = noteRosterNames(misled.memory, [{ memberPubkey: cat2.pub, callsign: 'Cat', formerKeys: [claim(cat2, zed.pub)] }]);
            expect(again.memory.cat).toEqual({ key: cat2.pub, changedFrom: cat1.pub });
            expect([...again.changed]).toEqual([cat2.pub]);
        });

        it('a chain that passes through the key the name moved to and reaches the key it left confirms both moves', async () => {
            const first = noteRosterNames({}, [{ memberPubkey: cat1.pub, callsign: 'Cat' }]).memory;
            const unattested = noteRosterNames(first, [{ memberPubkey: cat2.pub, callsign: 'Cat' }]).memory;
            const both = noteRosterNames(unattested, [{ memberPubkey: cat3.pub, callsign: 'Cat', formerKeys: [claim(cat3, cat2.pub), claim(cat2, cat1.pub)] }]);
            expect(both.changed.size).toBe(0);
            expect(both.memory.cat).toEqual({ key: cat3.pub, was: [cat2.pub, cat1.pub] });
            expect(await knew(both.memory, cat3.pub)).toEqual([cat2.pub, cat1.pub]);
        });

        it('the cost: a middle key never attested is not learned; the phone knows only the key before it', async () => {
            const first = noteRosterNames({}, [{ memberPubkey: cat1.pub, callsign: 'Cat' }]).memory;
            const unattested = noteRosterNames(first, [{ memberPubkey: cat2.pub, callsign: 'Cat' }]).memory;
            const after = noteRosterNames(unattested, [{ memberPubkey: cat3.pub, callsign: 'Cat', formerKeys: [claim(cat3, cat2.pub)] }]);
            expect(after.memory.cat).toEqual({ key: cat3.pub, changedFrom: cat1.pub });
            expect([...after.changed]).toEqual([cat3.pub]);
            expect(await knew(after.memory, cat3.pub)).toEqual([cat1.pub]);
        });

        it('confirmation 1, finding 1: a chain that reaches both keys but places the moved-to key OLDER than the key the move left confirms only that key', async () => {
            const pup = person();
            const first = noteRosterNames({}, [{ memberPubkey: cat1.pub, callsign: 'Cat' }]).memory;
            // A puppet's claim over her honest key is the puppet's word, taken as a move; then one roster puts Zed's key under her name.
            const laundered = noteRosterNames(first, [{ memberPubkey: pup.pub, callsign: 'Cat', formerKeys: [claim(pup, cat1.pub)] }]).memory;
            expect(laundered.cat).toEqual({ key: pup.pub, was: [cat1.pub] });
            const relabelled = noteRosterNames(laundered, [{ memberPubkey: zed.pub, callsign: 'Cat' }]).memory;
            expect(relabelled.cat).toEqual({ key: zed.pub, changedFrom: pup.pub, was: [cat1.pub] });
            // Her new phone signs once over the puppet the node named; the puppet's claim over Zed's key completes C2 → P → Z.
            // The chain says Zed's key came before the puppet's; this phone saw the puppet's first. Zed's key never enters.
            const misled = noteRosterNames(relabelled, [{ memberPubkey: cat2.pub, callsign: 'Cat', formerKeys: [claim(cat2, pup.pub), claim(pup, zed.pub)] }]);
            expect(misled.memory.cat).toEqual({ key: cat2.pub, was: [pup.pub, cat1.pub] });
            expect(await knew(misled.memory, cat2.pub)).not.toContain(zed.pub);
            // The order the other way (C2 → Z → P: Zed's key newer than the puppet's) confirms both, as a middle key does.
            const inOrder = noteRosterNames(relabelled, [{ memberPubkey: cat2.pub, callsign: 'Cat', formerKeys: [claim(cat2, zed.pub), claim(zed, pup.pub)] }]);
            expect(inOrder.memory.cat).toEqual({ key: cat2.pub, was: [zed.pub, pup.pub, cat1.pub] });
        });

        it('with no unconfirmed move, the remembered key still counts (the honest re-key)', async () => {
            const first = noteRosterNames({}, [{ memberPubkey: cat1.pub, callsign: 'Cat' }]).memory;
            expect(await knew(first, cat2.pub)).toEqual([cat1.pub]);
            const confirmed = noteRosterNames(first, [{ memberPubkey: cat2.pub, callsign: 'Cat', formerKeys: [claim(cat2, cat1.pub)] }]).memory;
            expect(await knew(confirmed, cat3.pub)).toEqual([cat2.pub, cat1.pub]);
        });
    });
});
