/**
 * The one exhaustive table of slice S8, spares (scratch/fable-design/DESIGN-several-addresses-fable.md §6 'Spares'; Marty's
 * pick 6): (do the listed addresses answer?) × (does the spare prove?) × (the spare's take-over count against the one the
 * phone holds) × (does the spare's key match the community's?) → whether the phone takes the spare. Each row runs a whole
 * round (utils/address-verify.ts) against stand-in servers signing with real keys, as address-decide-table.test.ts does.
 *
 * The invariant: a phone never moves to an address that hasn't proved as the community at a count above the one it holds.
 * A spare at an equal or lower count, unproved, or proving another key is never taken; a spare is asked only when no listed
 * address answers as the community; and a spare is never refused for a day (a standby may take over an hour later).
 *
 * And the S8 row: a take-over with only numbers (no names) keeps the members: the community at one number, the owner's
 * spare the standby's number; the main server is lost, the standby takes over, and the phone goes to the spare by itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { createRequire } from 'node:module';
import {
    ADDRESS_LIST_PATH, ADDRESS_PROOF_PATH, signAddressList, signAddressProof, type AddressListFields,
} from '@beanpool/core';
import { takeSpare } from '../address-decide';
import { forgetAddressChecks, verifyAddressInUse, type VerifyDeps } from '../address-verify';
import { resetCommunityIndexForTests, type CommunityRecord } from '../community-index';
import { loadCommunityRecords, parseCommunityRecords, resetCommunityRecordsForTests } from '../community-record';
import { COMMUNITY_RECORDS_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const V = createRequire(import.meta.url)('@beanpool/core/vectors/address-list.json');
const KEY = { seed: hexToBytes(V.keys.community.seedHex), peerId: V.keys.community.peerId as string };
const OTHER_KEY = { seed: hexToBytes(V.keys.other.seedHex), peerId: V.keys.other.peerId as string };
const CID = V.communityIds.community as string;
const OTHER_CID = V.communityIds.other as string;
const ANCHOR = 'beanpool_anchor_url';
const T = Date.UTC(2026, 10, 16, 5);
const origin = (a: string) => `https://${a}`;

// Only numbers: the community's two listed addresses and the owner's spare (a standby's own number).
const USING = '203.0.113.5';
const OTHER = '203.0.113.6';
const SPARE = '198.51.100.7';
const HELD = 2;

const LISTED = ['in-use-proves', 'other-proves', 'none-silent', 'none-other-key'] as const;
const SPARE_SAYS = ['proves', 'silent', '421', 'list-omits-it'] as const;
const COUNT = ['lower', 'equal', 'higher'] as const;
const KEYS = ['same', 'other'] as const;
type Listed = typeof LISTED[number];
type SpareSays = typeof SPARE_SAYS[number];
type Count = typeof COUNT[number];
type Keys = typeof KEYS[number];

const kept = (): AddressListFields => ({ peerId: KEY.peerId, communityId: CID, epoch: HELD, seq: 14, main: USING, addresses: [USING, OTHER], spares: [SPARE] });

type Behaviour = 'proves' | 'silent' | '421' | 'list-omits-it';
/** Per host: what it answers, and with which key, count and list. */
interface Server { b: Behaviour; key: typeof KEY; cid: string; epoch: number; seq: number; listNames: string[]; spares: string[] }
let servers: Record<string, Server>;
const askedHosts: string[] = [];

const listOf = (s: Server, addresses: string[]): AddressListFields => ({
    peerId: s.key.peerId, communityId: s.cid, epoch: s.epoch, seq: s.seq,
    main: addresses[0], addresses: [...addresses].sort(), spares: s.spares.filter((x) => !addresses.includes(x)),
});

const get: VerifyDeps['get'] = async (url) => {
    const u = new URL(url);
    askedHosts.push(u.host);
    const s = servers[u.host];
    if (!s || s.b === 'silent') return null;
    if (s.b === '421') return { status: 421, body: { error: 'not listed', code: 'not_listed' } };
    const sign = (m: Uint8Array) => ed25519.sign(m, s.key.seed);
    // A server that lies: its proof is signed as though the spare were listed, its signed list leaves it out.
    const served = s.b === 'list-omits-it' ? s.listNames.filter((a) => a !== u.host) : s.listNames;
    if (u.pathname === ADDRESS_LIST_PATH) return { status: 200, body: await signAddressList(listOf(s, served.length ? served : [OTHER]), sign) };
    if (u.pathname !== ADDRESS_PROOF_PATH) return { status: 404, body: null };
    const list = { v: 1 as const, ...listOf(s, s.listNames) };
    return { status: 200, body: await signAddressProof({ list, for: u.searchParams.get('for')!, nonce: u.searchParams.get('nonce')!, ts: 1 }, sign) };
};

let n = 0;
let clock = T;
const moves: Array<[string, string]> = [];
const deps = (): VerifyDeps => ({
    get,
    nonce: () => (++n).toString(16).padStart(32, '0'),
    now: () => clock,
    anchor: async () => mem.get(ANCHOR) ?? null,
    inHall: async () => false,
    moveTo: async (from, to) => { moves.push([from, to]); mem.set(ANCHOR, to); },
    followRow: async () => {},
    removeCopy: async () => {},
    takeOffSavedList: async () => {},
});
const records = (): CommunityRecord[] => parseCommunityRecords(mem.get(COMMUNITY_RECORDS_STORE_KEY) ?? null);

async function phoneOn(list: AddressListFields, epoch: number): Promise<void> {
    mem.clear();
    forgetAddressChecks();
    moves.length = 0;
    askedHosts.length = 0;
    const signed = await signAddressList(list, (m) => ed25519.sign(m, KEY.seed));
    mem.set(ANCHOR, origin(list.main));
    mem.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: origin(list.main), alias: 'Riverside' }]));
    const base: CommunityRecord = { v: 1, id: origin(list.main), using: origin(list.main), peerId: KEY.peerId, communityId: CID, epoch, list: signed, proved: {}, refused: {} };
    mem.set(COMMUNITY_RECORDS_STORE_KEY, JSON.stringify({ v: 1, records: [base] }));
    resetCommunityRecordsForTests();
    resetCommunityIndexForTests();
    await loadCommunityRecords();
}

const community = (b: Behaviour): Server => ({ b, key: KEY, cid: CID, epoch: HELD, seq: 14, listNames: [USING, OTHER], spares: [SPARE] });

/** One row, run at an app open: the phone on USING, the kept list naming SPARE as a spare. */
async function runRow(listed: Listed, spare: SpareSays, count: Count, keys: Keys) {
    await phoneOn(kept(), HELD);
    clock = T;
    const spareEpoch = count === 'lower' ? HELD - 1 : count === 'equal' ? HELD : HELD + 1;
    const spareKey = keys === 'same' ? KEY : OTHER_KEY;
    servers = {
        [USING]: listed === 'in-use-proves' ? community('proves') : listed === 'none-other-key' ? community('421') : community('silent'),
        [OTHER]: listed === 'other-proves' ? community('proves') : community('silent'),
        [SPARE]: { b: spare, key: spareKey, cid: keys === 'same' ? CID : OTHER_CID, epoch: spareEpoch, seq: 20, listNames: [SPARE, USING], spares: [] },
    };
    await verifyAddressInUse({ atOpen: true }, deps());
    const r = records()[0];
    return {
        anchor: mem.get(ANCHOR) ?? null,
        tookSpare: moves.some(([, to]) => to === origin(SPARE)),
        askedSpare: askedHosts.includes(SPARE),
        spareRefused: !!r.refused[origin(SPARE)],
        record: r,
    };
}

/** The invariant, in its words: only with nothing listed answering, a spare that proves, at a higher count, with the key. */
const wantTake = (listed: Listed, spare: SpareSays, count: Count, keys: Keys) =>
    (listed === 'none-silent' || listed === 'none-other-key') && spare === 'proves' && count === 'higher' && keys === 'same';

describe('S8: the table, (listed addresses answer?) × (spare proves?) × (spare count vs held) × (key matches?) → take the spare or not', () => {
    beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

    it(`every row (${LISTED.length} × ${SPARE_SAYS.length} × ${COUNT.length} × ${KEYS.length} = ${LISTED.length * SPARE_SAYS.length * COUNT.length * KEYS.length}) does what the invariant says`, async () => {
        const wrong: string[] = [];
        let rows = 0;
        let taken = 0;
        for (const listed of LISTED) for (const spare of SPARE_SAYS) for (const count of COUNT) for (const keys of KEYS) {
            rows++;
            const name = `${listed} | spare ${spare} | count ${count} | key ${keys}`;
            const got = await runRow(listed, spare, count, keys);
            const want = wantTake(listed, spare, count, keys);
            if (got.tookSpare !== want) wrong.push(`${name}: took the spare ${got.tookSpare}, want ${want}`);
            // A spare is asked only when no listed address answers as the community.
            const listedAnswers = listed === 'in-use-proves' || listed === 'other-proves';
            if (listedAnswers && got.askedSpare) wrong.push(`${name}: asked the spare while a listed address answers`);
            if (!listedAnswers && !got.askedSpare) wrong.push(`${name}: never asked the spare with nothing listed answering`);
            // A spare is never refused for a day.
            if (got.spareRefused) wrong.push(`${name}: refused the spare`);
            if (want) {
                taken++;
                // Taken: requests go there; the count and the newer list the spare served are kept; Home says so once.
                const r = got.record;
                if (got.anchor !== origin(SPARE) || r.using !== origin(SPARE)) wrong.push(`${name}: the anchor is ${got.anchor}, using ${r.using}`);
                if (r.epoch !== HELD + 1) wrong.push(`${name}: kept count ${r.epoch}`);
                if (r.list?.list.main !== SPARE || r.list?.list.epoch !== HELD + 1) wrong.push(`${name}: kept list ${JSON.stringify(r.list?.list)}`);
                const line = listed === 'none-silent' ? 'not-answering' : 'left';
                if (r.line?.kind !== line) wrong.push(`${name}: line ${JSON.stringify(r.line)}, want ${line}`);
                if (!r.proved[origin(SPARE)] || r.proved[origin(SPARE)].epoch !== HELD + 1) wrong.push(`${name}: the spare's proof was not kept`);
            } else if (got.anchor === origin(SPARE)) {
                wrong.push(`${name}: the phone is on the spare`);
            } else if (got.record.epoch !== HELD) {
                wrong.push(`${name}: the count moved to ${got.record.epoch} with the spare not taken`);
            }
        }
        expect(rows).toBe(LISTED.length * SPARE_SAYS.length * COUNT.length * KEYS.length);
        expect(taken).toBe(2);
        expect(wrong).toEqual([]);
    }, 60_000);

    it('takeSpare alone: the same rule, from the answers', () => {
        const proved = (epoch: number) => ({ kind: 'proved' as const, epoch, seq: 20 });
        const list = (epoch: number, names = [SPARE]) => ({ epoch, seq: 20, addresses: names });
        expect(takeSpare({ listedAnswers: false, epoch: 2, spare: SPARE, answer: { proof: proved(3), list: list(3) } })).toBe(true);
        expect(takeSpare({ listedAnswers: true, epoch: 2, spare: SPARE, answer: { proof: proved(3), list: list(3) } })).toBe(false);
        expect(takeSpare({ listedAnswers: false, epoch: 2, spare: SPARE, answer: { proof: proved(2), list: list(2) } })).toBe(false);
        expect(takeSpare({ listedAnswers: false, epoch: 2, spare: SPARE, answer: { proof: proved(3), list: null } })).toBe(false);
        expect(takeSpare({ listedAnswers: false, epoch: 2, spare: SPARE, answer: { proof: proved(3), list: list(3, [OTHER]) } })).toBe(false);
        expect(takeSpare({ listedAnswers: false, epoch: 2, spare: SPARE, answer: { proof: { kind: 'other-key', why: 'other-key' }, list: list(3) } })).toBe(false);
        expect(takeSpare({ listedAnswers: false, epoch: 2, spare: SPARE, answer: { proof: { kind: 'silent' }, list: list(3) } })).toBe(false);
        // A list older than the proof names: not the list the proof speaks for.
        expect(takeSpare({ listedAnswers: false, epoch: 2, spare: SPARE, answer: { proof: { kind: 'proved', epoch: 4, seq: 1 }, list: list(3) } })).toBe(false);
    });
});

describe('S8 row: a take-over with only numbers (no names) keeps the members', () => {
    beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

    it('the main server at a number is lost; the standby at the spare number takes over; the phone goes there by itself, and never back to the old one', async () => {
        // The community lives at one number; the owner named the standby's number as a spare.
        const only: AddressListFields = { peerId: KEY.peerId, communityId: CID, epoch: 0, seq: 5, main: USING, addresses: [USING], spares: [SPARE] };
        await phoneOn(only, 0);
        const promoted: Server = { b: 'proves', key: KEY, cid: CID, epoch: 1, seq: 6, listNames: [SPARE, USING], spares: [] };
        const lost: Server = { b: 'proves', key: KEY, cid: CID, epoch: 0, seq: 5, listNames: [USING], spares: [SPARE] };

        // Before the loss the standby has no key: the spare answers as another server, and the main answers. Nothing moves.
        clock = T;
        servers = { [USING]: lost, [SPARE]: { ...promoted, key: OTHER_KEY, cid: OTHER_CID, epoch: 0 } };
        await verifyAddressInUse({ atOpen: true }, deps());
        expect(moves).toEqual([]);
        expect(askedHosts).not.toContain(SPARE);

        // The main server is lost: nothing answers at the number, and the standby has not taken over yet. Nothing moves.
        clock = T + 60 * 60_000;
        servers = { [SPARE]: { ...promoted, key: OTHER_KEY, cid: OTHER_CID, epoch: 0 } };
        await verifyAddressInUse({ atOpen: true }, deps());
        expect(moves).toEqual([]);
        expect(records()[0].refused[origin(SPARE)]).toBeUndefined();

        // The standby takes over (take-over count 1, its list names its own number): the next app open goes there.
        clock = T + 2 * 60 * 60_000;
        servers = { [SPARE]: promoted };
        await verifyAddressInUse({ atOpen: true }, deps());
        expect(moves).toEqual([[origin(USING), origin(SPARE)]]);
        expect(mem.get(ANCHOR)).toBe(origin(SPARE));
        const r = records()[0];
        expect(r.id).toBe(origin(USING)); // the same record, file and saved things: nobody signs in again
        expect(r.using).toBe(origin(SPARE));
        expect(r.epoch).toBe(1);
        expect(r.line?.kind).toBe('not-answering');

        // The old server comes back at its number, still at count 0: the phone stays on the promoted one.
        clock = T + 3 * 60 * 60_000;
        moves.length = 0;
        servers = { [SPARE]: promoted, [USING]: lost };
        forgetAddressChecks();
        await verifyAddressInUse({ atOpen: true }, deps());
        expect(moves).toEqual([]);
        expect(mem.get(ANCHOR)).toBe(origin(SPARE));
    });
});
