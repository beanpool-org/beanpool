/**
 * What the keyring makes of the former keys a node serves on its members list (utils/group-chat-keys.ts; review of #1826):
 *
 * - NB8: each row's chain is walked ONCE (verifiedFormerKeys: exactly the keys core's walkKeySuccession accepts, each
 *   statement verified once), and a members list read again with the same chains verifies nothing more;
 * - finding 1: a key that is this phone's own, a shown member's current key, or one two shown rows claim is nobody's
 *   former key here;
 * - NB7: an honest re-key's completion of an epoch's wraps is found whatever the roster's order, however many other shown
 *   members hold verified former keys (smallest completions first; the 256-set cap is never reached for one re-key).
 *
 * The node is a stand-in here (signedGet mocked); the statements are core's real ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((n: number) => new Uint8Array(randomBytes(n))), randomUUID: vi.fn(() => 'x'), digest: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}), deleteItemAsync: vi.fn(async () => {}) }));
const counts = vi.hoisted(() => ({ verify: 0, walk: 0 }));
vi.mock('@beanpool/core', async (importOriginal) => {
    const core = await importOriginal<typeof import('@beanpool/core')>();
    return {
        ...core,
        verifyKeySuccession: (...a: Parameters<typeof core.verifyKeySuccession>) => { counts.verify++; return core.verifyKeySuccession(...a); },
        walkKeySuccession: (...a: Parameters<typeof core.walkKeySuccession>) => { counts.walk++; return core.walkKeySuccession(...a); },
    };
});
const served = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../node-post', () => ({
    signedGet: vi.fn(async () => new Response(JSON.stringify(served.rows), { status: 200, headers: { 'content-type': 'application/json' } })),
    signedPost: vi.fn(async () => new Response('{}', { status: 500 })),
}));

import { groupMembersDigest, walkKeySuccession as coreWalk, makeKeySuccession, type FormerKey } from '@beanpool/core';
import { groupKeyring, memoryGroupKeyStore } from '../group-chat-keys';
import { verifiedFormerKeys } from '../group-chat-crypto';

const person = () => { const s = randomBytes(32); return { priv: bytesToHex(s), pub: bytesToHex(ed25519.getPublicKey(s)) }; };
const AT = '2026-10-03T04:00:00.000Z';
/** A member re-keyed `len` times: their current key, and the chain newest first, each statement signed by its successor. */
function rekeyedMember(len: number) {
    const keys = Array.from({ length: len + 1 }, person); // keys[0] the oldest … keys[len] the current
    const chain: FormerKey[] = [];
    for (let i = len - 1; i >= 0; i--) {
        const s = makeKeySuccession({ newEdPrivHex: keys[i + 1].priv, oldPubHex: keys[i].pub, at: AT });
        chain.push({ pubkey: s.pubkey, at: s.at, sig: s.sig });
    }
    return { keys, row: { memberPubkey: keys[len].pub, status: 'active', callsign: 'M', formerKeys: chain } };
}
let n = 0;
const ringFor = (me: { pub: string; priv: string }) => groupKeyring('https://node.test', { publicKey: me.pub, privateKey: me.priv }, `g-${n++}`, memoryGroupKeyStore()) as any;

describe('the former keys a phone accepts from the members list', () => {
    beforeEach(() => { counts.verify = 0; counts.walk = 0; served.rows = []; });

    it('NB8: one walk is exactly what the walker accepts, key by key, for honest, broken, cyclic and over-long chains', () => {
        const honest = rekeyedMember(3);
        const broken = rekeyedMember(3);
        broken.row.formerKeys[1] = { ...broken.row.formerKeys[1], sig: broken.row.formerKeys[2].sig };
        const cyclic = rekeyedMember(2);
        cyclic.row.formerKeys.push({ ...cyclic.row.formerKeys[0] });
        const nine = rekeyedMember(9);
        const eight = rekeyedMember(8);
        const junk = rekeyedMember(2);
        (junk.row.formerKeys as unknown[]).splice(1, 0, null);
        for (const { row } of [honest, broken, cyclic, nine, eight, junk, { row: { memberPubkey: 'not hex', formerKeys: honest.row.formerKeys } }]) {
            const byWalker = (row.formerKeys as (FormerKey | null)[]).map((f) => f?.pubkey).filter((k): k is string => typeof k === 'string' && coreWalk(row, k));
            expect(verifiedFormerKeys(row)).toEqual([...new Set(byWalker)]); // a cycle's repeat is one key
        }
        expect(verifiedFormerKeys(honest.row)).toEqual(honest.keys.slice(0, 3).map((k) => k.pub).reverse());
        expect(verifiedFormerKeys(broken.row)).toEqual([broken.keys[2].pub]);
        expect(verifiedFormerKeys(eight.row)).toHaveLength(8);
        expect(verifiedFormerKeys(nine.row)).toEqual([]);
    });

    it('NB8: the members list read twice verifies each statement once, and the second read verifies nothing', async () => {
        const me = person();
        const members = Array.from({ length: 5 }, () => rekeyedMember(8));
        served.rows = [{ memberPubkey: me.pub, status: 'active', callsign: 'Me', formerKeys: [] }, ...members.map((m) => m.row)];
        const ring = ringFor(me);
        await ring.readShownRoster();
        expect({ verify: counts.verify, walk: counts.walk }).toEqual({ verify: 5 * 8, walk: 0 });
        expect(ring.formerOf.get(members[0].row.memberPubkey)).toEqual(members[0].keys.slice(0, 8).map((k) => k.pub).reverse());
        counts.verify = 0;
        await ring.readShownRoster();
        expect({ verify: counts.verify, walk: counts.walk }).toEqual({ verify: 0, walk: 0 });
    });

    it('finding 1: this phone\'s own key, a shown member\'s current key, and a key two rows claim are nobody\'s former key', async () => {
        const me = person();
        const ben = person();
        const gone = person();
        const p1 = person(); const p2 = person(); const p3 = person(); const p4 = person(); const honest = person();
        const claim = (by: typeof me, old: string) => { const s = makeKeySuccession({ newEdPrivHex: by.priv, oldPubHex: old, at: AT }); return [{ pubkey: s.pubkey, at: s.at, sig: s.sig }]; };
        const goneOnly = person();
        // The node leaves this phone out of the list, so only "it is mine" refuses the first claim.
        served.rows = [
            { memberPubkey: ben.pub, status: 'active', formerKeys: [] },
            { memberPubkey: p1.pub, status: 'active', formerKeys: claim(p1, me.pub) },     // my own key
            { memberPubkey: p2.pub, status: 'active', formerKeys: claim(p2, ben.pub) },    // Ben's current key
            { memberPubkey: p3.pub, status: 'active', formerKeys: claim(p3, gone.pub) },   // one old key, claimed twice
            { memberPubkey: p4.pub, status: 'active', formerKeys: claim(p4, gone.pub) },
            { memberPubkey: honest.pub, status: 'active', formerKeys: claim(honest, goneOnly.pub) }, // claimed once
        ];
        const ring = ringFor(me);
        expect(await ring.readShownRoster()).toEqual(new Set(served.rows.map((r: any) => r.memberPubkey)));
        expect([...ring.formerOf.entries()]).toEqual([[honest.pub, [goneOnly.pub]]]);
    });

    it('NB7: one re-key\'s completion is found with any number of other re-keyed members, listed first or last', () => {
        const ana = person().pub; const ben = person().pub; const cat1 = person().pub; const cat2 = person().pub;
        const record = { membersDigest: groupMembersDigest([ana, ben, cat1]) } as any;
        const wraps = new Set([ana, ben]); // the record's own wraps once the node dropped Cat₁'s at her re-key
        for (const others of [0, 4, 7, 8, 9, 12, 40]) {
            for (const catFirst of [true, false]) {
                const ring = ringFor(person());
                const noise = Array.from({ length: others }, () => [person().pub, [person().pub]] as [string, string[]]);
                ring.formerOf = new Map(catFirst ? [[cat2, [cat1]], ...noise] : [...noise, [cat2, [cat1]]]);
                const found = ring.completedBySuccession(record, wraps);
                expect(found ? [...found].sort() : `none with ${others} others, Cat₂ ${catFirst ? 'first' : 'last'}`).toEqual([ana, ben, cat1].sort());
            }
        }
    });

    it('NB7: a completion whose only candidates don\'t make the signed set is refused', () => {
        const ana = person().pub; const ben = person().pub; const cat1 = person().pub; const cat2 = person().pub; const dan1 = person().pub; const dan2 = person().pub;
        const record = { membersDigest: groupMembersDigest([ana, ben, cat1]) } as any;
        const ring = ringFor(person());
        ring.formerOf = new Map([[cat2, [cat1]], [dan2, [dan1]]]);
        expect(ring.completedBySuccession(record, new Set([ana]))).toBeNull(); // Ben's wrap hidden too: no set of candidates makes it
        expect(ring.completedBySuccession(record, new Set([ana, ben]))).toEqual(new Set([ana, ben, cat1]));
    });
});
