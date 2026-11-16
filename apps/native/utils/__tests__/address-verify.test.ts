/**
 * The phone verifies its community's addresses and follows by itself (utils/address-verify.ts; scratch/fable-design/
 * DESIGN-several-addresses-fable.md §3.2 to §3.5, §7, slice S4). Stand-in servers sign lists and proofs with real Ed25519
 * keys through core's own code (@beanpool/core address-list.ts, the keys of its shared vectors); the phone's records,
 * saved list and storage are the real modules over an in-memory store. Each attacker case of §7 is named.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mem = vi.hoisted(() => new Map<string, string>());
/** The watchdog sees each write before it lands; a test's switch can land just after one. */
const hooks = vi.hoisted(() => ({
    before: null as null | ((key: string, old: string | null, next: string) => void),
    after: null as null | ((key: string, next: string) => void),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { hooks.before?.(k, mem.get(k) ?? null, v); mem.set(k, v); hooks.after?.(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));
/** The member's real switch (reconnect.ts switchPhoneTo) waits in closeDB, as it waits there for the sync lock. */
const copy = vi.hoisted(() => ({ closing: null as null | Promise<void> }));
vi.mock('../db', () => ({
    closeDB: vi.fn(async () => { await copy.closing; }),
    initDB: vi.fn(async () => {}),
    whileCopyMoves: vi.fn(async (_to: string, move: () => Promise<unknown>) => move()),
}));
vi.mock('../community-switch', () => ({ communitySwitched: vi.fn() }));

import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { createRequire } from 'node:module';
import {
    ADDRESS_LIST_PATH, ADDRESS_PROOF_PATH, signAddressList, signAddressProof, type AddressListFields, type SignedAddressList,
} from '@beanpool/core';
import { answerToProof, forgetAddressChecks, takeAddressLine, verifyAddressInUse, type VerifyDeps } from '../address-verify';
import {
    addressSpelling, communityKeyOf, communityRecordOf, recordHolds, resetCommunityIndexForTests, type CommunityRecord,
} from '../community-index';
import { keepCommunityRecord, loadCommunityRecords, parseCommunityRecords, resetCommunityRecordsForTests } from '../community-record';
import { followSavedRow, getDatabaseFilenameForNode, takeOffSavedList } from '../nodes';
import { switchPhoneTo } from '../reconnect';
import { COMMUNITY_RECORDS_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const V = createRequire(import.meta.url)('@beanpool/core/vectors/address-list.json');
const KEY = { seed: hexToBytes(V.keys.community.seedHex), peerId: V.keys.community.peerId as string };
const OTHER_KEY = { seed: hexToBytes(V.keys.other.seedHex), peerId: V.keys.other.peerId as string };
const CID = V.communityIds.community as string;

const A = 'riverside.example';
const M = 'coop.example.org';
const L = 'lost.example.net';
/** A third community on the phone, never asked: the member's switch can go there. */
const C = 'hilltop.example';
const ANCHOR = 'beanpool_anchor_url';
const T0 = Date.UTC(2026, 10, 16, 2);

type Key = typeof KEY;
interface Server { key: Key; fields: AddressListFields; listKey?: Key; listFields?: AddressListFields; proofFor?: string; replay?: unknown; silent?: boolean; status?: number }
let servers: Record<string, Server>;
let asked: string[];
let now: number;

function fields(over: Partial<AddressListFields> = {}): AddressListFields {
    return { peerId: KEY.peerId, communityId: CID, epoch: 2, seq: 14, main: A, addresses: [A, M], spares: [], ...over };
}

async function signedList(f: AddressListFields, key: Key): Promise<SignedAddressList> {
    // A list signed by another key than it names is built by hand: signAddressList refuses to make one.
    if (key.peerId === f.peerId) return signAddressList(f, (b) => ed25519.sign(b, key.seed));
    const good = await signAddressList({ ...f, peerId: key.peerId }, (b) => ed25519.sign(b, key.seed));
    return { list: { ...good.list, peerId: f.peerId }, sig: good.sig };
}

/** The stand-in network: each address answers as its server says. */
const get: VerifyDeps['get'] = async (url) => {
    const u = new URL(url);
    const address = u.host;
    asked.push(`${address}${u.pathname}`);
    const s = servers[address];
    if (!s || s.silent) return null;
    if (s.status) return { status: s.status, body: { error: 'Too many requests from this address; try again shortly.' } };
    if (u.pathname === ADDRESS_LIST_PATH) return { status: 200, body: await signedList(s.listFields ?? s.fields, s.listKey ?? s.key) };
    if (u.pathname === ADDRESS_PROOF_PATH) {
        if (s.replay) return { status: 200, body: s.replay };
        const forAddress = s.proofFor ?? u.searchParams.get('for')!;
        if (!s.fields.addresses.includes(forAddress)) return { status: 421, body: { error: 'not listed' } };
        const proof = await signAddressProof({ list: { v: 1, ...s.fields }, for: forAddress, nonce: u.searchParams.get('nonce')!, ts: 1 }, (b) => ed25519.sign(b, s.key.seed));
        return { status: 200, body: proof };
    }
    return { status: 404, body: null };
};

let n = 0;
const moves: Array<[string, string]> = [];
/** The copies a round removed (a second record of the same community), by the record id they are kept under. */
const dupes: string[] = [];
/** What the watchdog saw break the round-3 invariant, in words. */
const violations: string[] = [];

/** Every address each record holds (its id, `using`, proved), by spelling: one held by two records is a crossing. */
function crossings(rs: readonly CommunityRecord[]): string[] {
    const by = new Map<string, string>();
    const out: string[] = [];
    for (const r of rs) {
        for (const a of new Set([r.id, r.using, ...Object.keys(r.proved)].map(addressSpelling))) {
            if (by.has(a) && by.get(a) !== r.id) out.push(`${a} is held by ${by.get(a)} and ${r.id}`);
            else by.set(a, r.id);
        }
    }
    return out;
}

/**
 * The round-3 invariant (PR #3236), watched at every write and removal, in every test of this file: no step touches the
 * copy, the saved row or the record that holds the anchor at that moment, and no write leaves two records holding one
 * address.
 */
function watchdog(key: string, old: string | null, next: string): void {
    const anchor = mem.get(ANCHOR) ?? null;
    if (!anchor) return;
    if (key === SAVED_NODES_STORE_KEY) {
        const urls = (raw: string | null) => { try { return (JSON.parse(raw ?? '[]') as Array<{ url?: unknown }>).map((r) => r?.url); } catch { return []; } };
        const at = (u: unknown) => typeof u === 'string' && addressSpelling(u) === addressSpelling(anchor);
        if (urls(old).some(at) && !urls(next).some(at)) violations.push(`the row at the anchor ${anchor} went`);
    }
    if (key === COMMUNITY_RECORDS_STORE_KEY) {
        const before = parseCommunityRecords(old);
        const after = parseCommunityRecords(next);
        const anchored = before.find((r) => recordHolds(r, anchor));
        if (anchored && !after.some((r) => r.id === anchored.id)) violations.push(`the record ${anchored.id} holding the anchor went`);
        violations.push(...crossings(after));
    }
}

function deps(): VerifyDeps {
    return {
        get,
        nonce: () => (++n).toString(16).padStart(32, '0'),
        now: () => now,
        anchor: async () => mem.get(ANCHOR) ?? null,
        inHall: async () => false,
        moveTo: async (from, to) => { moves.push([from, to]); mem.set(ANCHOR, to); },
        followRow: followSavedRow,
        removeCopy: async (id) => {
            if (getDatabaseFilenameForNode(id) === getDatabaseFilenameForNode(mem.get(ANCHOR) ?? null)) violations.push(`the copy at the anchor (${id}) went`);
            dupes.push(id);
        },
        takeOffSavedList,
    };
}

const records = (): CommunityRecord[] => parseCommunityRecords(mem.get(COMMUNITY_RECORDS_STORE_KEY) ?? null);
const recordAt = (origin: string) => records().find((r) => r.id === origin)!;
const saved = () => JSON.parse(mem.get(SAVED_NODES_STORE_KEY) ?? '[]') as Array<{ url: string; alias?: string }>;

async function phoneAt(origin: string, over: Partial<CommunityRecord> = {}, rows: Array<{ url: string; alias?: string }> = [{ url: origin, alias: 'Riverside' }]) {
    mem.set(ANCHOR, origin);
    mem.set(SAVED_NODES_STORE_KEY, JSON.stringify(rows));
    const base: CommunityRecord = { v: 1, id: origin, using: origin, proved: {}, refused: {}, ...over };
    mem.set(COMMUNITY_RECORDS_STORE_KEY, JSON.stringify({ v: 1, records: [base] }));
    resetCommunityRecordsForTests();
    resetCommunityIndexForTests();
    await loadCommunityRecords();
}

const round = (atOpen = false) => verifyAddressInUse({ atOpen }, deps());

beforeEach(() => {
    mem.clear();
    forgetAddressChecks();
    asked = [];
    moves.length = 0;
    dupes.length = 0;
    violations.length = 0;
    hooks.before = watchdog;
    hooks.after = null;
    now = T0;
    servers = { [A]: { key: KEY, fields: fields() }, [M]: { key: KEY, fields: fields() } };
});

afterEach(() => {
    hooks.before = null;
    hooks.after = null;
    expect(violations).toEqual([]);
});

describe('S4: two addresses, the main changes, the phone follows by itself with one line', () => {
    it('a copy opened during the move saves the old address again: the rows still end as one, at the new address', async () => {
        // Measured on the emulator (two-address walk, 16 Nov): the list read [new, old] after the follow until the next app
        // open. switchPhoneTo closes the copy before it writes the new address, and a copy opened in between (db.ts
        // openAndMakeCopy) saves the address it read, the old one, again.
        await phoneAt(`https://${A}`);
        await round(true);
        for (const s of Object.values(servers)) s.fields = fields({ seq: 15, main: M });
        now += 61 * 60 * 1000;
        const real = deps();
        await verifyAddressInUse({}, {
            ...real,
            moveTo: async (from, to) => {
                mem.set(SAVED_NODES_STORE_KEY, JSON.stringify([...saved(), { url: from }]));
                await real.moveTo(from, to);
            },
        });
        expect(mem.get(ANCHOR)).toBe(`https://${M}`);
        expect(saved()).toEqual([{ url: `https://${M}`, alias: 'Riverside' }]);
    });

    it('learns the key from the first list, proves both, then follows the new main with no tap; nothing is copied', async () => {
        await phoneAt(`https://${A}`);
        const fileBefore = getDatabaseFilenameForNode(`https://${A}`);
        await round(true);
        const r = recordAt(`https://${A}`);
        expect(r.peerId).toBe(KEY.peerId);
        expect(r.communityId).toBe(CID);
        expect(Object.keys(r.proved).sort()).toEqual([`https://${M}`, `https://${A}`]);
        expect(moves).toEqual([]);

        // The owner makes M main: the list's number goes up, both servers say so.
        for (const s of Object.values(servers)) s.fields = fields({ seq: 15, main: M });
        now += 61 * 60 * 1000;
        await round();
        expect(moves).toEqual([[`https://${A}`, `https://${M}`]]);
        expect(mem.get(ANCHOR)).toBe(`https://${M}`);
        const after = recordAt(`https://${A}`);
        expect(after.using).toBe(`https://${M}`);
        expect(after.list?.list.seq).toBe(15);
        // The same record, the same file and saved things: M keys to the record's id.
        expect(communityKeyOf(`https://${M}`)).toBe(`https://${A}`);
        expect(getDatabaseFilenameForNode(`https://${M}`)).toBe(fileBefore);
        // One saved row, at M, with its name.
        expect(saved()).toEqual([expect.objectContaining({ url: `https://${M}`, alias: 'Riverside' })]);
        // The line, once.
        expect(await takeAddressLine(`https://${M}`)).toEqual({ kind: 'followed', from: `https://${A}`, to: `https://${M}` });
        expect(await takeAddressLine(`https://${M}`)).toBeNull();
    });

    it('asks the address in use at most hourly while it answers, and never anything before the list names it', async () => {
        await phoneAt(`https://${A}`);
        await round(true);
        const first = asked.length;
        now += 10 * 60 * 1000;
        await round();
        expect(asked).toHaveLength(first);
        expect(asked.every((a) => a.startsWith(A) || a.startsWith(M))).toBe(true);
    });

    it('the address in use stops answering: at app open it switches by itself to the proved main, with a line', async () => {
        await phoneAt(`https://${A}`);
        for (const s of Object.values(servers)) s.fields = fields({ main: M });
        servers[A].fields = fields({ main: M });
        await round(true);
        // Followed to M already (M main and proved). Now M goes quiet, and A is main again.
        for (const s of Object.values(servers)) s.fields = fields({ seq: 16, main: A });
        servers[M].silent = true;
        now += 2 * 60 * 60 * 1000;
        moves.length = 0;
        await takeAddressLine(`https://${M}`);
        await round(true);
        expect(moves).toEqual([[`https://${M}`, `https://${A}`]]);
        expect((await takeAddressLine(`https://${A}`))?.kind).toBe('not-answering');
    });
});

describe('S4: the attacker cases of §7, by name', () => {
    it('a list from another key: refused; nothing is followed, and the address serving it counts as answering as something else', async () => {
        await phoneAt(`https://${A}`, { peerId: KEY.peerId, communityId: CID, epoch: 2 });
        servers[A].fields = fields({ seq: 20 });
        servers[A].listKey = OTHER_KEY;
        servers[A].listFields = fields({ seq: 20, main: M });
        await round(true);
        const r = recordAt(`https://${A}`);
        expect(r.list).toBeUndefined();
        expect(r.refused[`https://${A}`]?.why).toBe('list bad-signature');
        expect(moves).toEqual([]);
    });

    it('an older (epoch, seq): a kept list is never replaced by a lower one, and an address proving a lower take-over count is dropped', async () => {
        await phoneAt(`https://${A}`);
        servers[A].fields = fields({ seq: 30 });
        await round(true);
        expect(recordAt(`https://${A}`).list?.list.seq).toBe(30);
        // A serves an older list naming M as main: the proof names 31 so the list is asked, and 29 is refused.
        servers[A].fields = fields({ seq: 31 });
        servers[A].listFields = fields({ seq: 29, main: M });
        now += 61 * 60 * 1000;
        await round();
        expect(recordAt(`https://${A}`).list?.list.seq).toBe(30);
        expect(moves).toEqual([]);
        // M answers at take-over count 1, below the 2 held: dropped, never used.
        servers[A].listFields = undefined;
        servers[A].fields = fields({ seq: 32, main: M });
        servers[M].fields = fields({ epoch: 1, seq: 32, main: M });
        now += 61 * 60 * 1000;
        await round();
        expect(recordAt(`https://${A}`).refused[`https://${M}`]?.why).toBe('older');
        expect(moves).toEqual([]);
    });

    it('a proof for another address: the main signs for the address in use instead; refused, never followed', async () => {
        await phoneAt(`https://${A}`);
        for (const s of Object.values(servers)) s.fields = fields({ main: M });
        servers[M].proofFor = A;
        await round(true);
        expect(recordAt(`https://${A}`).refused[`https://${M}`]?.why).toBe('other-address');
        expect(moves).toEqual([]);
    });

    it('a replayed nonce: the main hands back a proof made for an earlier question; refused, never followed', async () => {
        await phoneAt(`https://${A}`);
        const old = await signAddressProof({ list: { v: 1, ...fields({ main: M }) }, for: M, nonce: 'f'.repeat(32), ts: 1 }, (b) => ed25519.sign(b, KEY.seed));
        for (const s of Object.values(servers)) s.fields = fields({ main: M });
        servers[M].replay = old;
        await round(true);
        expect(recordAt(`https://${A}`).refused[`https://${M}`]?.why).toBe('other-nonce');
        expect(moves).toEqual([]);
    });

    it('a lost name: not on the list, so never asked and never used, even when it passes every question through', async () => {
        await phoneAt(`https://${A}`);
        servers[L] = { key: KEY, fields: fields({ addresses: [A, L, M], main: L }) };
        await round(true);
        expect(asked.some((a) => a.startsWith(L))).toBe(false);
        expect(Object.keys(recordAt(`https://${A}`).proved)).not.toContain(`https://${L}`);
        expect(communityRecordOf(`https://${L}`)).toBeNull();
    });

    it('the address in use answers with another key: dropped at once, and the phone goes to the proved main with a line', async () => {
        await phoneAt(`https://${A}`, { peerId: KEY.peerId, communityId: CID, epoch: 2 });
        await round(true);
        // Somebody else's server at A now: it signs with its own key, as its own community.
        servers[A] = { key: OTHER_KEY, fields: fields({ peerId: OTHER_KEY.peerId, communityId: V.communityIds.other }) };
        now += 61 * 60 * 1000;
        await round();
        expect(moves).toEqual([[`https://${A}`, `https://${M}`]]);
        expect(recordAt(`https://${A}`).refused[`https://${A}`]?.why).toBe('other-key');
        expect((await takeAddressLine(`https://${M}`))?.kind).toBe('left');
    });
});

describe('S4: the same community saved twice (Marty\'s pick 5: the phone keeps the copy it is on, the other goes)', () => {
    it('the second record at an address just proved goes before any move, so that address keys to the record in use', async () => {
        mem.set(ANCHOR, `https://${A}`);
        mem.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: `https://${A}` }, { url: `https://${M}` }]));
        resetCommunityRecordsForTests();
        resetCommunityIndexForTests();
        await loadCommunityRecords();
        expect(records().map((r) => r.id)).toEqual([`https://${A}`, `https://${M}`]);
        await round(true);
        expect(dupes).toEqual([`https://${M}`]);
    });

    it('a server from before proofs, with the key the phone first read there: nothing is written, its address is never refused', async () => {
        await phoneAt(`https://${A}`);
        mem.set('beanpool_community_identity', JSON.stringify({ [`https://${A}`]: { peerId: KEY.peerId, communityId: CID, epoch: 0 } }));
        const old: VerifyDeps['get'] = async () => ({ status: 404, body: null });
        await verifyAddressInUse({ atOpen: true }, { ...deps(), get: old });
        const r = recordAt(`https://${A}`);
        expect(r.peerId).toBeUndefined();
        expect(r.refused).toEqual({});
        expect(moves).toEqual([]);
    });

    it('an older server with no list: nothing changes, nothing is followed', async () => {
        await phoneAt(`https://${A}`);
        servers[A] = { ...servers[A], silent: false };
        const plain = get;
        const noList: VerifyDeps['get'] = async (url) => (url.includes(ADDRESS_LIST_PATH) ? { status: 404, body: null } : plain(url));
        await verifyAddressInUse({ atOpen: true }, { ...deps(), get: noList });
        expect(recordAt(`https://${A}`).peerId).toBeUndefined();
        expect(moves).toEqual([]);
    });
});

describe('S4 round 2: the deciding review\'s three reproductions (PR #3236, 7ff6ef8f), kept', () => {
    it('1. a main that just gave no answer is never followed back to on its older proof, at any reopen inside the wait', async () => {
        // On main M with A listed; the round at open proves both. M stops answering: the next open switches to A. Two minutes
        // later another open (every return from the background is one) must keep the phone on A: at 7ff6ef8f it went back to
        // M on the proof from before M went quiet, and flipped at every reopen during the outage.
        for (const s of Object.values(servers)) s.fields = fields({ main: M });
        await phoneAt(`https://${M}`);
        await round(true);
        expect(Object.keys(recordAt(`https://${M}`).proved).sort()).toEqual([`https://${M}`, `https://${A}`]);
        servers[M].silent = true;
        now += 60_000;
        await round(true);
        expect(moves).toEqual([[`https://${M}`, `https://${A}`]]);
        now += 2 * 60_000;
        await round(true);
        expect(moves).toEqual([[`https://${M}`, `https://${A}`]]);
        expect(mem.get(ANCHOR)).toBe(`https://${A}`);
        // Still quiet after the wait: asked again, still no answer, still on A.
        now += 5 * 60_000;
        await round(true);
        expect(mem.get(ANCHOR)).toBe(`https://${A}`);
        // M answers again: asked once its hour is up, it proves fresh, and the phone goes back quietly.
        servers[M].silent = false;
        now += 61 * 60_000;
        await round();
        expect(mem.get(ANCHOR)).toBe(`https://${M}`);
    });

    it('2. a busy gateway (429) is not answering, never "answers as something else": no day\'s refusal, even of the main', async () => {
        for (const s of Object.values(servers)) s.fields = fields({ main: M });
        await phoneAt(`https://${M}`);
        await round(true);
        servers[M].status = 429;
        // An hourly round: not answering for a moment, so the phone stays and nothing is refused.
        now += 61 * 60_000;
        await round();
        expect(moves).toEqual([]);
        expect(recordAt(`https://${M}`).refused).toEqual({});
        // At an open, no answer makes the switch due (the 2 Nov card): to A, with the not-answering line, M never refused.
        now += 60_000;
        await round(true);
        expect(moves).toEqual([[`https://${M}`, `https://${A}`]]);
        expect(recordAt(`https://${M}`).refused).toEqual({});
        expect((await takeAddressLine(`https://${A}`))?.kind).toBe('not-answering');
        // M answers again within the hour: it was never refused, so it is asked and followed back to.
        servers[M].status = undefined;
        now += 61 * 60_000;
        await round();
        expect(mem.get(ANCHOR)).toBe(`https://${M}`);
    });

    it('3. the member\'s own switch while a round is out wins: the phone stays where the member put it, with no line', async () => {
        await phoneAt(`https://${A}`);
        await round(true);
        for (const s of Object.values(servers)) s.fields = fields({ seq: 15, main: M });
        now += 61 * 60_000;
        const real = deps();
        await verifyAddressInUse({}, {
            ...real,
            get: async (url) => {
                // The member switches community while M's proof is out (the community sheet, a link, joining).
                if (url.includes(M) && url.includes(ADDRESS_PROOF_PATH)) mem.set(ANCHOR, 'https://elsewhere.example');
                return get(url);
            },
        });
        expect(moves).toEqual([]);
        expect(mem.get(ANCHOR)).toBe('https://elsewhere.example');
        const r = recordAt(`https://${A}`);
        expect(r.using).toBe(`https://${A}`);
        expect(r.line).toBeUndefined();
        // What it learned about the addresses is kept: M proved, the newer list.
        expect(Object.keys(r.proved)).toContain(`https://${M}`);
        expect(r.list?.list.seq).toBe(15);
    });

    it('a member\'s switch that lands while the record is written: the record goes back, the phone never moves', async () => {
        await phoneAt(`https://${A}`);
        await round(true);
        for (const s of Object.values(servers)) s.fields = fields({ seq: 15, main: M });
        now += 61 * 60_000;
        const real = deps();
        let reads = 0;
        await verifyAddressInUse({}, {
            ...real,
            // The round reads the anchor at its start, once after the network and once before the move: the switch lands
            // between the second and third reads.
            anchor: async () => { reads++; const a = mem.get(ANCHOR) ?? null; if (reads === 2) mem.set(ANCHOR, 'https://elsewhere.example'); return a; },
        });
        expect(moves).toEqual([]);
        expect(mem.get(ANCHOR)).toBe('https://elsewhere.example');
        expect(recordAt(`https://${A}`).using).toBe(`https://${A}`);
        expect(recordAt(`https://${A}`).line).toBeUndefined();
    });
});

describe('S5: a switch started but not yet written (the S4 leftover race; one lock for the switch and the check)', () => {
    /** Ticks enough for a round's proofs and record read to finish and reach its first writing step. */
    const settle = () => new Promise((r) => setTimeout(r, 30));

    for (const kind of ['a follow to the new main', 'a second record of the same community'] as const) {
        it(`the member's switch waits in closeDB while the round would make ${kind}: no destructive step, the phone ends where the member put it`, async () => {
            if (kind === 'a follow to the new main') {
                await phoneAt(`https://${A}`);
                await round(true);
                for (const s of Object.values(servers)) s.fields = fields({ seq: 15, main: M });
                now += 61 * 60_000;
            } else {
                // The same community saved at A and at M (two records), and a third community to switch to.
                mem.set(ANCHOR, `https://${A}`);
                mem.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: `https://${A}`, alias: 'Riverside' }, { url: `https://${M}` }, { url: `https://${C}`, alias: 'Hilltop' }]));
                resetCommunityRecordsForTests();
                resetCommunityIndexForTests();
                await loadCommunityRecords();
            }
            const before = recordAt(`https://${A}`);
            let release!: () => void;
            copy.closing = new Promise<void>((r) => { release = r; });
            // The member taps another community: the switch has started, the copy is closing, the address is not yet written.
            const switching = switchPhoneTo(`https://${C}`);
            const checking = verifyAddressInUse({ atOpen: true }, deps());
            await settle();
            expect(mem.get(ANCHOR)).toBe(`https://${A}`);
            release();
            await Promise.all([switching, checking]);
            copy.closing = null;

            expect(mem.get(ANCHOR)).toBe(`https://${C}`);
            expect(moves).toEqual([]);
            expect(dupes).toEqual([]);
            const after = recordAt(`https://${A}`);
            expect(after.using).toBe(before.using);
            expect(after.line).toBeUndefined();
            // Nothing came off the saved list: a second record's row stays while the member is leaving.
            expect(saved().map((r) => r.url)).toEqual(kind === 'a follow to the new main' ? [`https://${A}`] : [`https://${A}`, `https://${M}`, `https://${C}`]);
        });
    }

    it('a switch tapped while the round writes waits for it, then wins: the phone ends where the member put it', async () => {
        await phoneAt(`https://${A}`);
        await round(true);
        for (const s of Object.values(servers)) s.fields = fields({ seq: 15, main: M });
        now += 61 * 60_000;
        let switching: Promise<unknown> | null = null;
        const real = deps();
        await verifyAddressInUse({}, {
            ...real,
            // The round is inside its writing steps (it has just moved the phone to M): the member taps another community.
            moveTo: async (from, to) => { await real.moveTo(from, to); switching = switchPhoneTo(`https://${C}`); await settle(); },
        });
        // The switch waited for the round's last step (the rows following), so it never interleaved with it.
        expect(mem.get(ANCHOR)).toBe(`https://${M}`);
        await switching;
        expect(mem.get(ANCHOR)).toBe(`https://${C}`);
        expect(saved().map((r) => r.url)).toEqual([`https://${M}`]);
    });
});

describe('S4 round 2: what an answer to a proof says (only what says so is "answers as something else")', () => {
    const q = { peerId: KEY.peerId, for: A, nonce: '0'.repeat(32) };
    const rows: Array<[string, Parameters<typeof answerToProof>[0], string]> = [
        ['no answer (offline, a timeout)', null, 'silent'],
        ['429, the gateway\'s limit', { status: 429, body: { error: 'Too many requests' } }, 'silent'],
        ['a proxy\'s 503 page', { status: 503, body: null, unparsed: true }, 'silent'],
        ['a 503 that is not the server\'s replaced', { status: 503, body: { error: 'down' } }, 'silent'],
        ['502, 500, 403, 400', { status: 502, body: null, unparsed: true }, 'silent'],
        ['a 200 whose body did not parse', { status: 200, body: null, unparsed: true }, 'silent'],
        ['a 421 that is not the server\'s', { status: 421, body: null, unparsed: true }, 'silent'],
        ['the server\'s 421, not on its list', { status: 421, body: { error: 'not listed', code: 'not_listed' } }, 'other-key'],
        ['the server\'s 503, replaced', { status: 503, body: { error: 'replaced', code: 'replaced' } }, 'other-key'],
        ['404, no proof route', { status: 404, body: null, unparsed: true }, 'other-key'],
        ['a 200 that parsed and is not a proof', { status: 200, body: { hello: 1 } }, 'other-key'],
    ];
    for (const [name, answer, kind] of rows) {
        it(`${name}: ${kind}`, () => { expect(answerToProof(answer, q).kind).toBe(kind); });
    }
    it('each other status below 600 that is not 200, 404, the server\'s 421 or 503 is not answering', () => {
        const odd: number[] = [];
        for (let status = 100; status < 600; status++) {
            if ([200, 404].includes(status)) continue;
            if (answerToProof({ status, body: { error: 'x' } }, q).kind !== 'silent') odd.push(status);
        }
        expect(odd).toEqual([]);
    });
});

describe('S4 round 3: the member\'s switch beats every step that removes or writes (PR #3236, e205f94f)', () => {
    /** The same community saved twice (rows at A and M, so two records), and a third community: the phone on A. */
    async function twoCopies(main: string) {
        mem.set(ANCHOR, `https://${A}`);
        mem.set(SAVED_NODES_STORE_KEY, JSON.stringify([
            { url: `https://${A}`, alias: 'Riverside' }, { url: `https://${M}` }, { url: `https://${C}`, alias: 'Hilltop' },
        ]));
        resetCommunityRecordsForTests();
        resetCommunityIndexForTests();
        await loadCommunityRecords();
        expect(records().map((r) => r.id)).toEqual([`https://${A}`, `https://${M}`, `https://${C}`]);
        for (const s of Object.values(servers)) s.fields = fields({ main });
    }
    const isProof = (url: string, address: string) => url.includes(`//${address}/`) && url.includes(ADDRESS_PROOF_PATH);
    const holders = (origin: string) => records().filter((r) => recordHolds(r, origin)).map((r) => r.id);

    it('the reviewer\'s reproduction: the member switches to the duplicate while its proof is out; no copy goes, this round or the next', async () => {
        // At e205f94f: dupes = [M] with the anchor at M (the copy just switched to went), the round wrote M's proof into A's
        // record, and the next round, on M's record, removed A's copy too: both copies gone, against pick 5.
        await twoCopies(A);
        await verifyAddressInUse({ atOpen: true }, {
            ...deps(),
            get: async (url) => {
                if (isProof(url, M)) mem.set(ANCHOR, `https://${M}`);
                return get(url);
            },
        });
        expect(dupes).toEqual([]);
        expect(moves).toEqual([]);
        expect(mem.get(ANCHOR)).toBe(`https://${M}`);
        // M stays its own record's: the round never wrote M's proof into A's record.
        expect(holders(`https://${M}`)).toEqual([`https://${M}`]);
        expect(saved().map((r) => r.url)).toEqual([`https://${A}`, `https://${M}`, `https://${C}`]);
        // The next round runs on M's record, the one the phone is on: it keeps that copy, and A's is the other one. A is
        // the list's main, so the phone then follows there, on the copy it kept: A keys to M's record and file.
        const fileOnM = getDatabaseFilenameForNode(`https://${M}`);
        now += 61 * 60_000;
        await round();
        expect(dupes).toEqual([`https://${A}`]);
        expect(moves).toEqual([[`https://${M}`, `https://${A}`]]);
        expect(holders(`https://${A}`)).toEqual([`https://${M}`]);
        expect(getDatabaseFilenameForNode(mem.get(ANCHOR)!)).toBe(fileOnM);
        expect(saved().map((r) => r.url)).toEqual([`https://${A}`, `https://${C}`]);
    });

    it('a record made while the proofs are out (a community joined meanwhile) never makes the record in use its own duplicate', async () => {
        // The index is rebuilt by any record write, so the record read at the round's start is not the object read later:
        // the round must know its own record by id, never by object (found in this round's self-check).
        await phoneAt(`https://${A}`);
        await verifyAddressInUse({ atOpen: true }, {
            ...deps(),
            get: async (url) => {
                if (isProof(url, M)) await keepCommunityRecord('https://lakeside.example');
                return get(url);
            },
        });
        expect(dupes).toEqual([]);
        expect(saved().map((r) => r.url)).toEqual([`https://${A}`]);
        expect(recordAt(`https://${A}`).proved[`https://${M}`]).toBeDefined();
    });

    /**
     * Where the member's switch lands, from before the duplicate's proof to the last step: just before each step that
     * removes or writes (the copy, the rows, the record, the record write, the move, the rows following). Each is a hook
     * on the step before it. One round, with main M, does them all: the duplicate at M goes, then the phone follows to M.
     */
    type Where = 'before the proof' | 'during the proof' | 'after the proof, before the copy goes' | 'before the rows go'
        | 'before the record goes' | 'before the record is written' | 'before the move' | 'before the rows follow';
    const WHERE: readonly Where[] = [
        'before the proof', 'during the proof', 'after the proof, before the copy goes', 'before the rows go',
        'before the record goes', 'before the record is written', 'before the move', 'before the rows follow',
    ];
    const TARGETS: Record<string, string> = {
        'the duplicate': `https://${M}`, 'the original': `https://${A}`, 'another community': `https://${C}`,
    };

    for (const where of WHERE) {
        for (const [targetName, target] of Object.entries(TARGETS)) {
            it(`the switch to ${targetName} lands ${where}: the copy, rows and record at the anchor stay; records never cross`, async () => {
                await twoCopies(M);
                const warn = vi.spyOn(console, 'warn');
                /** `real`: the switch changed the anchor (a switch to where the phone already is changes nothing). */
                const landed: { real?: boolean } = {};
                const land = () => {
                    if (landed.real !== undefined) return;
                    landed.real = mem.get(ANCHOR) !== target;
                    mem.set(ANCHOR, target);
                };
                const real = deps();
                const injected: VerifyDeps = {
                    ...real,
                    get: async (url) => {
                        if (where === 'before the proof' && isProof(url, A)) land();
                        if (where === 'during the proof' && isProof(url, M)) land();
                        const answer = await get(url);
                        if (where === 'after the proof, before the copy goes' && isProof(url, M)) land();
                        return answer;
                    },
                    removeCopy: async (id) => { await real.removeCopy(id); if (where === 'before the rows go') land(); },
                    takeOffSavedList: async (address, isGone) => {
                        await real.takeOffSavedList(address, isGone);
                        if (where === 'before the record is written') land();
                    },
                    moveTo: async (from, to) => { await real.moveTo(from, to); if (where === 'before the rows follow') land(); },
                };
                hooks.after = (key, next) => {
                    if (where === 'before the record goes' && key === SAVED_NODES_STORE_KEY) land();
                    if (where === 'before the move' && key === COMMUNITY_RECORDS_STORE_KEY
                        && parseCommunityRecords(next).find((r) => r.id === `https://${A}`)?.using === `https://${M}`) land();
                };
                await verifyAddressInUse({ atOpen: true }, injected);
                const warned = warn.mock.calls.map((c) => String(c[0]));
                warn.mockRestore();

                // The switch landed, and the round finished (a throw would pass every check below vacuously).
                expect(landed.real).toBeDefined();
                expect(warned.filter((w) => w.includes('Could not verify'))).toEqual([]);
                // The member's act wins: the phone ends where the switch put it; a switch to where it already was changes
                // nothing, and the round follows to M as it would have.
                expect(mem.get(ANCHOR)).toBe(landed.real ? target : `https://${M}`);
                // The anchor's community still has its record, and no address is held by two records.
                expect(records().some((r) => recordHolds(r, mem.get(ANCHOR)!))).toBe(true);
                expect(crossings(records())).toEqual([]);
                // The third community is never touched.
                expect(saved().some((r) => r.url === `https://${C}`)).toBe(true);
                expect(holders(`https://${C}`)).toEqual([`https://${C}`]);
                // (The watchdog checks each removal and write against the anchor at that moment: afterEach.)
            });
        }
    }
});
