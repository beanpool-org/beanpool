/**
 * "Where your account can be brought back from" (vault rethink VR1, DESIGN-vault-rethink-fable.md §5.1;
 * utils/ways-back.ts): every place a copy of the key is kept, as far as the phone can ask, since when, Remove one,
 * Remove everything (the vault's copies and every community's, a delete that doesn't land remembered and tried again),
 * and the 12 words asked about before the last way back goes.
 *
 * Measured on main (28 Oct): the phone read only which sign-ins the vault keeps (no since), had no way to list or remove
 * a community's copy outside the move card, never tried a remembered delete again unless the vault answered first and
 * the move card looked, and a Disconnect of everything left the phone believing the vault still kept a copy (so the "one
 * way back" card stayed quiet).
 *
 * Nothing here contacts a node or the vault: fetch is a stub that sends the vault's requests to the in-process fake
 * (fake-vault.ts, which checks each request's signature and signs its answers as the vault does) and answers two
 * communities itself, checking that every request is signed by Kim's key for that community.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../db', () => ({ clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}), initDB: vi.fn(async () => {}) }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

import { VAULT_COMMUNITY_PROVIDER, vaultCopyDigest, type SealedShare } from '@beanpool/core';
import { draftIdentity, importIdentity, type BeanPoolIdentity } from '../identity';
import { oneWayBackFromNode, oneWayBackPlace, startOneWayBack, finishOneWayBack } from '../one-way-back';
import { SAVED_NODES_STORE_KEY, vaultCopyKnownStoreKey, vaultMoveUnfinishedStoreKey } from '../storage-keys';
import { vaultCopyKnowledge, vaultCopyKnown } from '../vault';
import { retryCommunityRemovals, vaultMoveOffer } from '../vault-move';
import { communityRefFor } from '../community-recovery';
import {
    beforeRemoving, everyoneAnswered, knownCopies, listWaysBack, noteWordsWrittenDown, otherHalfMissing, removeAdminsCopyFrom, removeCommunityCopyFrom,
    removeEverything, removeEverythingAsksVault, removeVaultCopy, strayVaultHalves, unopenableAdminsCopies, unplacedVaultHalves, vaultCopiesBySignIn, vaultHalfOf, wordsOnly, wordsWrittenDown,
    type CommunityPart, type WaysBack,
} from '../ways-back';
import { FakeVault, OTHER_KEY, VAULT, noVault, useVault, type SentRequest } from './fake-vault';
import { boundSignatureValid } from './server-signature-check';

const MULLUM = 'https://mullum.beanpool.org';
const GLOBAL = 'https://global.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
/** What a copy holds doesn't matter to a listing or a removal. */
const SOME_COPY = { sealed: 'not opened here' } as unknown as SealedShare;

/** A community as the node answers (routes/keepers.ts): its copies of Kim's key, by sign-in, and their generation. */
interface Community {
    copies: Set<string>;
    generation: number;
    /** No answer at all. */
    down: boolean;
    /** Answers its status, but its deletes fail (a 5xx). */
    deletesFail: boolean;
    /** Only the deletes of these sign-ins' copies fail (a 5xx). */
    deletesFailFor: Set<string>;
    /** The deletes of these sign-ins' copies land, but their answers never reach the phone (a dropped connection). */
    answersLostFor: Set<string>;
    /** The generation its copies were at when it last deleted them all: the next copy goes on from it, as the node's does. */
    deletedAt: number;
    /** When set, each request's fate (the seeded sweep): answered, refused (a 5xx), no answer, or landed with its answer lost. */
    fate: ((req: SentRequest) => Fate) | null;
    /** The copy it keeps for its admins to bring Kim back from (vault rethink VR3), since when; null: none. */
    admins: { since: string; placement?: 'shared'; copy?: string } | null;
    /** A copy it keeps for its admins but can't open now (its seal key gone, or another), since when and why; null: none. */
    adminsUnopenable: { since: string; reason: string } | null;
    /** How its delete of that copy goes: as the node answers, refused (a 5xx), or a proxy's 200 page. */
    adminsDelete: 'answered' | 'refused' | 'proxy';
    /** A server from before VR3: its status never names the copy, and it has no route to delete one. */
    beforeVr3: boolean;
    /** The key its vouchers are signed with, as its status says it (VR4); null: a server still starting; absent: one from before VR4. */
    nodeKey?: string | null;
}

type Fate = 'answered' | 'refused' | 'down' | 'lost';

/** A copy linked at `c` again from another device: a fresh one, a new generation (after a delete of all, on from it). */
function linkAgain(c: Community, provider: string): void {
    c.copies.add(provider);
    c.generation = Math.max(c.generation, c.deletedAt) + 1;
}

interface Net {
    vault: FakeVault;
    communities: Record<string, Community>;
    sent: SentRequest[];
    /** While set, every community's status answer waits for it. */
    statusGate: Promise<void> | null;
}

let kim: BeanPoolIdentity;

function network(): Net {
    const community = (copies: string[], generation: number): Community => ({
        copies: new Set(copies), generation, down: false, deletesFail: false, deletesFailFor: new Set(), answersLostFor: new Set(),
        deletedAt: 0, fate: null, admins: null, adminsUnopenable: null, adminsDelete: 'answered', beforeVr3: false,
    });
    const net: Net = { vault: new FakeVault(), communities: { [MULLUM]: community(['google'], 4), [GLOBAL]: community([], 0) }, sent: [], statusGate: null };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const u = new URL(url);
        const raw = typeof init?.body === 'string' ? init.body : '';
        const req: SentRequest = {
            url, origin: u.origin, path: u.pathname, method: String(init?.method ?? 'GET').toUpperCase(),
            headers: { ...((init?.headers ?? {}) as Record<string, string>) }, raw, body: raw ? JSON.parse(raw) : undefined,
        };
        net.sent.push(req);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (u.origin === VAULT) {
            if (net.vault.unreachable) throw new TypeError('Network request failed');
            const r = net.vault.answer(req);
            return json(r.status, r.body);
        }
        const c = net.communities[u.origin];
        if (!c) throw new Error(`No request expected: ${req.method} ${url}`);
        const fate = c.fate?.(req) ?? 'answered';
        if (c.down || fate === 'down') throw new TypeError('Network request failed');
        // The node's own check of a member-signed request: Kim's key, for this community's host.
        if (!boundSignatureValid({ url, method: req.method, headers: req.headers, body: raw }, kim.publicKey)) {
            return json(401, { error: 'This request must be signed by an active member of this node.' });
        }
        if (req.method === 'POST' && u.pathname === '/api/recovery/shares/status') {
            if (net.statusGate) await net.statusGate;
            const status = { generation: c.generation, enrolledSso: [...c.copies], keepers: [], total: c.copies.size, threshold: 1 };
            return json(200, c.beforeVr3 ? status : { ...status, communityCopy: c.admins, communityCopyUnopenable: c.adminsUnopenable, nodeKey: c.nodeKey });
        }
        if (req.method === 'DELETE' && u.pathname === '/api/recovery/community-copy' && !c.beforeVr3) {
            if (c.adminsDelete === 'refused') return json(503, { error: 'Try again later.', code: 'standby' });
            if (c.adminsDelete === 'proxy') return new Response('<html>Welcome to the cafe wifi</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
            const removed = c.admins || c.adminsUnopenable ? 1 : 0;
            c.admins = null;
            c.adminsUnopenable = null;
            return json(200, { removed, kept: false });
        }
        const del = /^\/api\/recovery\/shares\/sso\/([a-z]+)$/.exec(u.pathname);
        if (req.method === 'DELETE' && del) {
            if (c.deletesFail || c.deletesFailFor.has(del[1]) || fate === 'refused') return json(503, { error: 'Try again later.' });
            if (!c.copies.delete(del[1])) return json(404, { error: `Provider '${del[1]}' is not connected for this account.` });
            // As the node answers: the new generation its copies are at, or 0 once it removed the last one.
            if (!c.copies.size) c.deletedAt = c.generation;
            c.generation = c.copies.size ? c.generation + 1 : 0;
            if (c.answersLostFor.has(del[1]) || fate === 'lost') throw new TypeError('Network request failed');
            return json(200, { removed: del[1], generation: c.generation, enrolledSso: [...c.copies] });
        }
        throw new Error(`No request expected: ${req.method} ${url}`);
    });
    return net;
}

const deletesAt = (net: Net, origin: string) => net.sent.filter((s) => s.origin === origin && s.method === 'DELETE');
const vaultDeletes = (net: Net) => net.sent.filter((s) => s.origin === VAULT && s.path === '/v1/copies/delete');

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    useVault();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Nothing may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    kim = await draftIdentity('Kim');
});

afterEach(() => {
    noVault();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * Kim's phone: set to Mullum, with the global community saved too. The vault keeps Kim's Google copy (since 3 Oct) and
 * Apple copy (since 20 Oct), and Ali's; Mullum keeps a Google copy from before the vault; global keeps none.
 */
async function kimsPhone(net: Net) {
    await importIdentity(kim);
    mem.async.set(ANCHOR, MULLUM);
    mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM, alias: 'Mullumbimby' }, { url: GLOBAL, alias: 'Global community' }]));
    net.vault.keep('google', 'kim-google', kim.publicKey, SOME_COPY, '2026-10-03');
    net.vault.keep('apple', 'kim-apple', kim.publicKey, SOME_COPY, '2026-10-20');
    net.vault.keep('google', 'ali-google', OTHER_KEY, SOME_COPY, '2026-10-05');
    mem.async.set(vaultCopyKnownStoreKey(kim.publicKey), '1');
}

describe('a shared copy is one way back in two places (vault rethink VR4)', () => {
    const half = { ref: 'label-1', copy: 'digest-1', since: '2026-10-01', lastReleasedAt: null };
    const part = (copy: string | null, vaultRef: string | null = 'label-1') => ({
        url: 'https://mullum.test', name: 'Mullum', vaultRef,
        status: { providers: [], generation: 1, ...(copy ? { adminsCopy: { since: '2026-10-01', placement: 'shared' as const, copy } } : {}) },
    });
    const ways = (halves: typeof half[], ...communities: ReturnType<typeof part>[]) => ({ vault: { kind: 'listed' as const, copies: [], communityCopies: halves }, communities, pending: [] });
    const PHONE = { hasWords: true, writtenDown: false };

    it('both halves of one copy count as a way back, once', () => {
        const w = ways([half], part('digest-1'));
        expect(knownCopies(w)).toEqual([{ at: 'admins', url: 'https://mullum.test' }]);
        expect(wordsOnly(w)).toBe(false);
        expect(beforeRemoving(w, { at: 'admins', url: 'https://mullum.test' }, PHONE)).toBe('show-words-first');
    });

    it('half a pair is no way back, but it is kept: never "nothing is kept", and removing it asks nothing about the 12 words', () => {
        for (const w of [ways([], part('digest-1')), ways([half], part('digest-2')), ways([half], part(null))]) {
            expect(knownCopies(w)).toEqual([]);
            expect(wordsOnly(w)).toBe(false);
            expect(beforeRemoving(w, { at: 'admins', url: 'https://mullum.test' }, PHONE)).toBe('confirm');
        }
    });

    it('Remove everything asks the vault for a copy of either kind, or when it couldn\'t say: the one test its delete and its confirm go by', () => {
        expect(removeEverythingAsksVault(ways([half], part('digest-1'))), 'a member whose only vault copy is a shared one').toBe(true);
        expect(removeEverythingAsksVault(ways([half], part(null, 'label-2'))), 'a stray half').toBe(true);
        expect(removeEverythingAsksVault(ways([], part(null))), 'it listed none').toBe(false);
        expect(removeEverythingAsksVault({ vault: { kind: 'listed', copies: [{ provider: 'google', since: '2026-10-01', lastReleasedAt: null }] }, communities: [], pending: [] })).toBe(true);
        expect(removeEverythingAsksVault({ vault: { kind: 'unknown', why: 'paused' }, communities: [], pending: [] })).toBe(true);
        expect(removeEverythingAsksVault({ vault: { kind: 'no-vault' }, communities: [], pending: [] })).toBe(false);
    });

    it('a half no community on this phone says is its own is listed alone, and removes alone', () => {
        const w = ways([half], part(null, 'label-2'));
        expect(strayVaultHalves(w)).toEqual([half]);
        expect(wordsOnly(w)).toBe(false);
        expect(beforeRemoving(w, { at: 'vault-half', ref: half.ref }, PHONE)).toBe('confirm');
        expect(strayVaultHalves(ways([half], part('digest-1')))).toEqual([]);
    });

    it('with the vault unable to say, a half is not counted as a way back', () => {
        const w = { vault: { kind: 'unknown' as const, why: 'paused' as const }, communities: [part('digest-1')], pending: [] };
        expect(knownCopies(w)).toEqual([]);
        expect(wordsOnly(w)).toBe(false);
    });

    describe("a community that hasn't said its label may hold the other half: nothing is stray on a guess (#2683 review)", () => {
        /** A community whose label this phone doesn't have, for whatever reason: only what it answered differs. */
        const unlabelled = (status: CommunityPart['status']): CommunityPart => ({ url: 'https://bell.test', name: 'Bellingen', status });
        const SHARED = { providers: [], generation: 1, adminsCopy: { since: '2026-10-01', placement: 'shared' as const, copy: 'digest-1' } };
        const listed = (...communities: CommunityPart[]): WaysBack => ({ vault: { kind: 'listed', copies: [], communityCopies: [half] }, communities, pending: [] });

        it('one that gave no answer', () => {
            const w = listed(unlabelled(null));
            expect(strayVaultHalves(w)).toEqual([]);
            expect(unplacedVaultHalves(w)).toEqual([half]);
            expect(wordsOnly(w), 'never "nothing is kept"').toBe(false);
        });

        it('one that answered with its half and no node key, as a server still starting does (routes/keepers.ts, `nodeKeyHex`)', () => {
            const w = listed(unlabelled(SHARED));
            expect(everyoneAnswered(w), 'so "did everyone answer" is the wrong test: it did, and it holds the half').toBe(true);
            expect(strayVaultHalves(w)).toEqual([]);
            expect(unplacedVaultHalves(w)).toEqual([half]);
        });

        it("one that answered with a copy it can't open and no node key: that may be the half", () => {
            const w = listed(unlabelled({ providers: [], generation: 1, adminsCopyUnopenable: { since: '2026-10-01', reason: 'recovery_seal_key_missing' } }));
            expect(strayVaultHalves(w)).toEqual([]);
            expect(unplacedVaultHalves(w)).toEqual([half]);
        });

        it('one that says what it keeps, and that is no half, holds none, whatever it said of its key: a server from before VR4 says nothing of it', () => {
            for (const w of [
                listed(unlabelled({ providers: [], generation: 1 })),
                listed(unlabelled({ providers: ['google'], generation: 1 })),
                listed(unlabelled({ providers: [], generation: 1, adminsCopy: { since: '2026-10-01' } })),
            ]) {
                expect(strayVaultHalves(w), 'still removable: one server on an old build must not strand it').toEqual([half]);
                expect(unplacedVaultHalves(w)).toEqual([]);
            }
        });

        it('every community named another label: stray, as before, even beside one that keeps a half of its own', () => {
            const w = listed(part(null, 'label-2'), part('digest-3', 'label-3'));
            expect(strayVaultHalves(w)).toEqual([half]);
            expect(unplacedVaultHalves(w)).toEqual([]);
        });

        it('a half a community claimed is that community\'s, whoever else is silent; only an unclaimed one waits', () => {
            const other = { ref: 'label-2', copy: 'digest-2', since: '2026-10-02', lastReleasedAt: null };
            const w: WaysBack = { vault: { kind: 'listed', copies: [], communityCopies: [half, other] }, communities: [part('digest-1'), unlabelled(null)], pending: [] };
            expect(vaultHalfOf(w, w.communities[0])).toEqual(half);
            expect(unplacedVaultHalves(w)).toEqual([other]);
            expect(strayVaultHalves(w)).toEqual([]);
        });

        it('no half unclaimed: nothing waits, and nothing is stray', () => {
            const w = listed(part('digest-1'), unlabelled(null));
            expect(unplacedVaultHalves(w)).toEqual([]);
            expect(strayVaultHalves(w)).toEqual([]);
        });

        it('a build or a vault that lists no half has nothing to place', () => {
            expect(unplacedVaultHalves({ vault: { kind: 'no-vault' }, communities: [unlabelled(null)], pending: [] })).toEqual([]);
            expect(unplacedVaultHalves({ vault: { kind: 'unknown', why: 'paused' }, communities: [unlabelled(null)], pending: [] })).toEqual([]);
            expect(unplacedVaultHalves({ vault: { kind: 'listed', copies: [] }, communities: [unlabelled(null)], pending: [] })).toEqual([]);
        });

        it("a community's half is called missing only when the phone can tell: no label and a half unclaimed could be the very one", () => {
            const c = unlabelled(SHARED);
            expect(otherHalfMissing(listed(c), c), 'that unclaimed half may be its other half').toBe(false);
            expect(otherHalfMissing({ vault: { kind: 'listed', copies: [] }, communities: [c], pending: [] }, c), 'the vault keeps no half at all').toBe(true);
            expect(otherHalfMissing({ vault: { kind: 'unknown', why: 'paused' }, communities: [c], pending: [] }, c), 'the vault could not say').toBe(false);
            const named = part('digest-1');
            expect(otherHalfMissing(ways([half], named), named), 'the pair').toBe(false);
            const another = part('digest-2');
            expect(otherHalfMissing(ways([half], another), another), 'its label, another copy').toBe(true);
            const elsewhere = part('digest-1', 'label-2');
            expect(otherHalfMissing(ways([half], elsewhere), elsewhere), 'its label, and the half is someone else\'s').toBe(true);
        });
    });
});

describe("the vault's half when its community can't be heard, on the real listing (#2683 review)", () => {
    const NODE_KEY = 'ab'.repeat(32);
    const SINCE = '2026-10-29T04:05:06.000Z';
    const DIGEST = vaultCopyDigest(SOME_COPY);

    /** Kim's phone after turning the shared copy on at Mullum: the vault keeps the copy and one half, Mullum the other. */
    async function sharedAtMullum(net: Net): Promise<string> {
        await kimsPhone(net);
        const ref = communityRefFor(kim, NODE_KEY);
        net.vault.copies.set(`${VAULT_COMMUNITY_PROVIDER}:${NODE_KEY}:${kim.publicKey}`, {
            provider: VAULT_COMMUNITY_PROVIDER, sub: `${NODE_KEY}:${kim.publicKey}`, pubkey: kim.publicKey, clientCopy: SOME_COPY, pushTokens: [], lastReleasedAt: null,
            day: '2026-10-29', community: { nodeKey: NODE_KEY, half: 'not opened here', ref },
        });
        Object.assign(net.communities[MULLUM], { admins: { since: SINCE, placement: 'shared', copy: DIGEST }, nodeKey: NODE_KEY });
        return ref;
    }
    const HALF = (ref: string) => ({ ref, copy: DIGEST, since: '2026-10-29', lastReleasedAt: null });

    it('Mullum answering: the half is its own, and nothing is left over (the control)', async () => {
        const net = network();
        const ref = await sharedAtMullum(net);
        const ways = await listWaysBack(kim);
        expect(ways.communities[0].vaultRef).toBe(ref);
        expect(vaultHalfOf(ways, ways.communities[0])).toEqual(HALF(ref));
        expect(otherHalfMissing(ways, ways.communities[0])).toBe(false);
        expect(strayVaultHalves(ways)).toEqual([]);
        expect(unplacedVaultHalves(ways)).toEqual([]);
    });

    it("Mullum down: the vault's half is listed as not yet placed, never as stray with a Remove", async () => {
        const net = network();
        const ref = await sharedAtMullum(net);
        net.communities[MULLUM].down = true;
        const ways = await listWaysBack(kim);
        expect(ways.communities[0].status).toBeNull();
        expect(strayVaultHalves(ways)).toEqual([]);
        expect(unplacedVaultHalves(ways)).toEqual([HALF(ref)]);
    });

    it("Mullum refusing with a 5xx: the same (the review's 502/503)", async () => {
        const net = network();
        const ref = await sharedAtMullum(net);
        const realFetch = vi.mocked(fetch).getMockImplementation()!;
        vi.mocked(fetch).mockImplementation(async (input: RequestInfo, init?: RequestInit) => (
            new URL(String(input)).origin === MULLUM ? new Response('<html>502 Bad Gateway</html>', { status: 502 }) : realFetch(input, init)
        ));
        const ways = await listWaysBack(kim);
        expect(ways.communities[0].status).toBeNull();
        expect(strayVaultHalves(ways)).toEqual([]);
        expect(unplacedVaultHalves(ways)).toEqual([HALF(ref)]);
    });

    it("Mullum still starting: it answers with its half and no node key yet, so the phone can't tell which half is its, and says neither stray nor missing", async () => {
        const net = network();
        const ref = await sharedAtMullum(net);
        net.communities[MULLUM].nodeKey = null;
        const ways = await listWaysBack(kim);
        expect(ways.communities[0].status?.adminsCopy).toEqual({ since: SINCE, placement: 'shared', copy: DIGEST });
        expect(ways.communities[0].vaultRef).toBeUndefined();
        expect(everyoneAnswered(ways)).toBe(true);
        expect(strayVaultHalves(ways)).toEqual([]);
        expect(unplacedVaultHalves(ways)).toEqual([HALF(ref)]);
        expect(otherHalfMissing(ways, ways.communities[0])).toBe(false);
    });

    it('Mullum back: the same half is its own again, and nothing was lost', async () => {
        const net = network();
        const ref = await sharedAtMullum(net);
        net.communities[MULLUM].down = true;
        await listWaysBack(kim);
        net.communities[MULLUM].down = false;
        const ways = await listWaysBack(kim);
        expect(vaultHalfOf(ways, ways.communities[0])).toEqual(HALF(ref));
        expect(unplacedVaultHalves(ways)).toEqual([]);
        expect(vaultDeletes(net)).toEqual([]);
    });

    it('a half whose community left this phone, with every community heard: stray, and removable, as Ways back promises', async () => {
        const net = network();
        const ref = await sharedAtMullum(net);
        Object.assign(net.communities[MULLUM], { admins: null, nodeKey: 'cd'.repeat(32) });
        const ways = await listWaysBack(kim);
        expect(strayVaultHalves(ways)).toEqual([HALF(ref)]);
        expect(unplacedVaultHalves(ways)).toEqual([]);
    });
});

describe('the list: every copy, since when, as far as the phone can ask', () => {
    it("the vault's copies with since, from its signed status, and each saved community's; never another key's", async () => {
        const net = network();
        await kimsPhone(net);

        const ways = await listWaysBack(kim);

        expect(ways.vault).toEqual({
            kind: 'listed',
            copies: [
                // The fake lists in the order it keeps them, as the vault lists by row id.
                { provider: 'google', since: '2026-10-03', lastReleasedAt: null },
                { provider: 'apple', since: '2026-10-20', lastReleasedAt: null },
            ],
        });
        expect(ways.communities).toEqual([
            { url: MULLUM, name: 'Mullumbimby', status: { providers: ['google'], generation: 4 } },
            { url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } },
        ]);
        expect(ways.pending).toEqual([]);
        expect(knownCopies(ways)).toHaveLength(3);
        expect(everyoneAnswered(ways)).toBe(true);
        expect(wordsOnly(ways)).toBe(false);
        // Each community was asked with Kim's own signature, for its own host (the stub refuses anything else).
        expect(net.sent.filter((s) => s.path === '/api/recovery/shares/status')).toHaveLength(2);
    });

    it("a vault from before VR1 (no since) is dated from its updatedDay; one that says neither lists the copy with no date", async () => {
        const net = network();
        await kimsPhone(net);
        net.vault.statusDays = 'updatedDay';
        let ways = await listWaysBack(kim);
        expect(ways.vault.kind === 'listed' && ways.vault.copies.map(c => c.since)).toEqual(['2026-10-03', '2026-10-20']);

        net.vault.statusDays = 'none';
        ways = await listWaysBack(kim);
        expect(ways.vault).toEqual({
            kind: 'listed',
            copies: [{ provider: 'google', since: null, lastReleasedAt: null }, { provider: 'apple', since: null, lastReleasedAt: null }],
        });
    });

    const cantSay: [string, (v: FakeVault) => void, string][] = [
        ['is paused', (v) => { v.locked = true; }, 'paused'],
        ['does not answer', (v) => { v.unreachable = true; }, 'unreachable'],
        ["answers in a way the phone can't check", (v) => { v.answers = 'forged'; }, 'unverified'],
    ];
    for (const [what, breakIt, why] of cantSay) {
        it(`a vault that ${what}: "couldn't say", never "keeps none", and the phone's knowledge is left as it was`, async () => {
            const net = network();
            await kimsPhone(net);
            breakIt(net.vault);
            const ways = await listWaysBack(kim);
            expect(ways.vault).toEqual({ kind: 'unknown', why });
            expect(everyoneAnswered(ways)).toBe(false);
            expect(wordsOnly(ways)).toBe(false);
            expect(await vaultCopyKnowledge(kim.publicKey)).toBe('kept');
        });
    }

    it('a community that gives no answer is "couldn\'t say", never "keeps none"', async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[MULLUM].down = true;
        const ways = await listWaysBack(kim);
        expect(ways.communities[0]).toEqual({ url: MULLUM, name: 'Mullumbimby', status: null });
        expect(knownCopies(ways).filter(c => c.at === 'community')).toEqual([]);
        expect(everyoneAnswered(ways)).toBe(false);
    });

    it('a build without a vault asks the communities only, and says nothing of the vault', async () => {
        const net = network();
        await kimsPhone(net);
        noVault();
        const ways = await listWaysBack(kim);
        expect(ways.vault).toEqual({ kind: 'no-vault' });
        expect(net.sent.filter((s) => s.origin === VAULT)).toEqual([]);
        expect(knownCopies(ways)).toEqual([{ at: 'community', url: MULLUM, provider: 'google' }]);
    });
});

describe('Remove one copy: removed only on the keeper\'s own answer', () => {
    it("the vault's Google copy: removed on the vault's signed answer, and the list then shows what is left", async () => {
        const net = network();
        await kimsPhone(net);
        expect(await removeVaultCopy(kim, 'google')).toEqual({ removed: true });
        expect(vaultDeletes(net).map((s) => s.body)).toEqual([expect.objectContaining({ provider: 'google' })]);
        expect(net.vault.copiesOf(kim.publicKey).map(c => c.provider)).toEqual(['apple']);
        expect(net.vault.copiesOf(OTHER_KEY)).toHaveLength(1);
        const ways = await listWaysBack(kim);
        expect(ways.vault.kind === 'listed' && ways.vault.copies.map(c => c.provider)).toEqual(['apple']);
    });

    it('two Google accounts at the vault: both listed, each with its own since; Remove takes both, and the 12 words are asked about first', async () => {
        const net = network();
        await kimsPhone(net);
        net.vault.copies.delete('apple:kim-apple');
        net.communities[MULLUM].copies.clear();
        // "Connect again" signs out of Google first and shows its account chooser: picking another account is an ordinary
        // way to a second Google copy for the same key.
        net.vault.keep('google', 'kim-google-work', kim.publicKey, SOME_COPY, '2026-10-01');

        const ways = await listWaysBack(kim);
        expect(ways.vault).toEqual({
            kind: 'listed',
            copies: [{ provider: 'google', since: '2026-10-03', lastReleasedAt: null }, { provider: 'google', since: '2026-10-01', lastReleasedAt: null }],
        });
        expect(vaultCopiesBySignIn(ways.vault.kind === 'listed' ? ways.vault.copies : [])).toEqual([
            { provider: 'google', copies: [{ provider: 'google', since: '2026-10-03', lastReleasedAt: null }, { provider: 'google', since: '2026-10-01', lastReleasedAt: null }] },
        ]);
        expect(knownCopies(ways)).toHaveLength(2);
        // Removing Google leaves no copy the phone knows of: neither account's.
        expect(beforeRemoving(ways, { at: 'vault', provider: 'google' }, { hasWords: true, writtenDown: false })).toBe('show-words-first');

        expect(await removeVaultCopy(kim, 'google')).toEqual({ removed: true });
        expect(net.vault.copiesOf(kim.publicKey)).toEqual([]);
        expect(net.vault.copiesOf(OTHER_KEY)).toHaveLength(1);
        expect((await listWaysBack(kim)).vault).toEqual({ kind: 'listed', copies: [] });
    });

    it("an answer the phone can't check is \"not removed\", even from a server that did delete it", async () => {
        const net = network();
        await kimsPhone(net);
        net.vault.answers = 'forged';
        expect(await removeVaultCopy(kim, 'google')).toEqual({ removed: false, why: 'unverified' });
        net.vault.answers = 'signed';
        net.vault.locked = true;
        expect(await removeVaultCopy(kim, 'apple')).toEqual({ removed: false, why: 'paused' });
        net.vault.locked = false;
        net.vault.unreachable = true;
        expect(await removeVaultCopy(kim, 'apple')).toEqual({ removed: false, why: 'unreachable' });
    });

    it("Mullum's Google copy: the signed DELETE there, removed on its answer", async () => {
        const net = network();
        await kimsPhone(net);
        const ways = await listWaysBack(kim);
        expect(await removeCommunityCopyFrom(kim, ways.communities[0], 'google')).toEqual({ removed: true });
        const [del] = deletesAt(net, MULLUM);
        expect(del.path).toBe('/api/recovery/shares/sso/google');
        expect(net.communities[MULLUM].copies.size).toBe(0);
        expect(mem.async.get(vaultMoveUnfinishedStoreKey(kim.publicKey))).toBeUndefined();
    });

    // PR #2570 review: any 2xx was taken for Mullum's word. A captive portal's page said "Removed from Mullumbimby.",
    // nothing was remembered, and the list straight after still showed the copy kept. On this branch before the fix the
    // first answer gave { removed: true }.
    it("an answer that isn't Mullum's own (a captive portal's 200 page, a 404 page, a 2xx naming no copy or another): not removed, remembered, and sent again once Mullum answers", async () => {
        const net = network();
        await kimsPhone(net);
        const ways = await listWaysBack(kim);
        const node = vi.mocked(fetch).getMockImplementation()!;
        // Something between the phone and Mullum answers its DELETEs itself: Mullum never sees them.
        let between: (() => Response) | null = null;
        vi.mocked(fetch).mockImplementation(async (input, init) => (
            between && String(init?.method).toUpperCase() === 'DELETE' ? between() : node(input, init)
        ));
        const page = (status: number, html: string) => () => new Response(html, { status, headers: { 'Content-Type': 'text/html' } });
        const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        for (const answer of [
            page(200, '<html><body>Welcome to the hotel Wi-Fi. Accept the terms to continue.</body></html>'),
            page(404, '<html><body>404 Not Found</body></html>'),
            json(200, { ok: true }),
            json(200, { removed: 'facebook', generation: 5 }),
        ]) {
            between = answer;
            expect(await removeCommunityCopyFrom(kim, ways.communities[0], 'google')).toEqual({ removed: false, why: 'remembered' });
            const waiting = await listWaysBack(kim);
            expect(waiting.pending).toEqual([{ url: MULLUM, provider: 'google' }]);
            expect(waiting.communities[0].status).toEqual({ providers: ['google'], generation: 4 });
        }
        expect(net.communities[MULLUM].copies.has('google')).toBe(true);

        // Mullum answers for itself again: the remembered delete is sent and lands.
        between = null;
        await retryCommunityRemovals(kim);
        expect(net.communities[MULLUM].copies.size).toBe(0);
        expect((await listWaysBack(kim)).pending).toEqual([]);
    });

    it("Mullum's own 404 (it keeps no copy for that sign-in) is removed: already gone", async () => {
        const net = network();
        await kimsPhone(net);
        const ways = await listWaysBack(kim);
        // Removed meanwhile from another device: Mullum answers the DELETE with its JSON 404.
        net.communities[MULLUM].copies.clear();
        expect(await removeCommunityCopyFrom(kim, ways.communities[0], 'google')).toEqual({ removed: true });
        expect(deletesAt(net, MULLUM)).toHaveLength(1);
        expect(mem.async.get(vaultMoveUnfinishedStoreKey(kim.publicKey))).toBeUndefined();
    });
});

describe('a community that can\'t be reached: "not yet removed", remembered, and tried again at the next open', () => {
    it('the delete is remembered and listed as waiting; at the next app open it is sent again and lands', async () => {
        const net = network();
        await kimsPhone(net);
        const ways = await listWaysBack(kim);
        net.communities[MULLUM].down = true;

        expect(await removeCommunityCopyFrom(kim, ways.communities[0], 'google')).toEqual({ removed: false, why: 'remembered' });
        // Never shown as removed: the community still keeps it, and the list says it is waiting.
        expect(net.communities[MULLUM].copies.has('google')).toBe(true);
        const waiting = await listWaysBack(kim);
        expect(waiting.pending).toEqual([{ url: MULLUM, provider: 'google' }]);
        expect(waiting.communities[0].status).toBeNull();
        // A waiting delete is not a way back the member is counting on.
        expect(knownCopies(waiting).filter(c => c.at === 'community')).toEqual([]);

        // The next open (app/_layout.tsx runs this at app open and at each return): Mullum answers now. One delete is
        // sent (the stub records the one that didn't get through as well).
        net.communities[MULLUM].down = false;
        const tried = deletesAt(net, MULLUM).length;
        await retryCommunityRemovals(kim);
        expect(net.communities[MULLUM].copies.size).toBe(0);
        expect(deletesAt(net, MULLUM).length - tried).toBe(1);
        expect((await listWaysBack(kim)).pending).toEqual([]);
    });

    it('a delete that is refused (a 5xx) is remembered the same way, and the list read retries it first', async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[MULLUM].deletesFail = true;
        const ways = await listWaysBack(kim);
        expect(await removeCommunityCopyFrom(kim, ways.communities[0], 'google')).toEqual({ removed: false, why: 'remembered' });
        expect((await listWaysBack(kim)).pending).toEqual([{ url: MULLUM, provider: 'google' }]);
        net.communities[MULLUM].deletesFail = false;
        const after = await listWaysBack(kim);
        expect(after.pending).toEqual([]);
        expect(after.communities[0].status).toEqual({ providers: [], generation: 0 });
    });

    it("tried again after the member linked Google there again (Mullum's copies changed): nothing is deleted, and the copy is listed as kept", async () => {
        const net = network();
        await kimsPhone(net);
        const ways = await listWaysBack(kim);
        net.communities[MULLUM].down = true;
        await removeCommunityCopyFrom(kim, ways.communities[0], 'google');

        // Meanwhile Kim linked Google at Mullum again from another device: a fresh copy, a new generation.
        net.communities[MULLUM].down = false;
        net.communities[MULLUM].generation = 6;
        const tried = deletesAt(net, MULLUM).length;
        await retryCommunityRemovals(kim);

        // Not one delete sent at the retry: only the status asked.
        expect(deletesAt(net, MULLUM).length - tried).toBe(0);
        expect(net.communities[MULLUM].copies.has('google')).toBe(true);
        const after = await listWaysBack(kim);
        expect(after.pending).toEqual([]);
        expect(knownCopies(after)).toContainEqual({ at: 'community', url: MULLUM, provider: 'google' });
    });

    it('a delete remembered while a retry is under way is kept: the retry writes back only what it tried', async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[GLOBAL].copies.add('facebook');
        const ways = await listWaysBack(kim);
        net.communities[MULLUM].down = true;
        await removeCommunityCopyFrom(kim, ways.communities[0], 'google');
        net.communities[MULLUM].down = false;

        // The app-open retry and a new delete that doesn't land, at the same time.
        net.communities[GLOBAL].deletesFail = true;
        await Promise.all([retryCommunityRemovals(kim), removeCommunityCopyFrom(kim, ways.communities[1], 'facebook')]);

        expect(net.communities[MULLUM].copies.size).toBe(0);
        expect((await listWaysBack(kim)).pending).toEqual([{ url: GLOBAL, provider: 'facebook' }]);
    });

    // PR #2570 review: the node writes a new generation for every single-sign-in delete that leaves another copy, so the
    // member's own first delete made every sibling's remembered generation stale, and the retry dropped them unsent.
    describe("two copies at one community: the member's own deletes are never taken for a change made there since", () => {
        const mullumPending = async () => (await listWaysBack(kim)).pending.filter((p) => p.url === MULLUM);

        it('Remove everything while it is down: at the next open both deletes are sent and land', async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].copies.add('facebook');
            const ways = await listWaysBack(kim);
            net.communities[MULLUM].down = true;
            await removeEverything(kim, ways);
            net.communities[MULLUM].down = false;

            await retryCommunityRemovals(kim);

            expect(net.communities[MULLUM].copies.size).toBe(0);
            expect(await mullumPending()).toEqual([]);
        });

        it('the first delete lands and the second gets a 5xx: the second goes at the next open', async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].copies.add('facebook');
            const ways = await listWaysBack(kim);
            net.communities[MULLUM].deletesFailFor.add('facebook');
            const done = await removeEverything(kim, ways);
            expect(done.communities.map((c) => [c.provider, c.removal.removed])).toEqual([['google', true], ['facebook', false]]);
            net.communities[MULLUM].deletesFailFor.clear();

            await retryCommunityRemovals(kim);

            expect(net.communities[MULLUM].copies.size).toBe(0);
            expect(await mullumPending()).toEqual([]);
        });

        it('the first delete gets a 5xx and the second lands: the first goes at the next open', async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].copies.add('facebook');
            const ways = await listWaysBack(kim);
            net.communities[MULLUM].deletesFailFor.add('google');
            const done = await removeEverything(kim, ways);
            expect(done.communities.map((c) => [c.provider, c.removal.removed])).toEqual([['google', false], ['facebook', true]]);
            net.communities[MULLUM].deletesFailFor.clear();

            await retryCommunityRemovals(kim);

            expect(net.communities[MULLUM].copies.size).toBe(0);
            expect(await mullumPending()).toEqual([]);
        });

        it('in one retry the first lands and the second fails: the second waits at the generation the first moved to, and goes at the next', async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].copies.add('facebook');
            const ways = await listWaysBack(kim);
            net.communities[MULLUM].down = true;
            await removeEverything(kim, ways);
            net.communities[MULLUM].down = false;
            net.communities[MULLUM].deletesFailFor.add('facebook');

            await retryCommunityRemovals(kim);
            expect([...net.communities[MULLUM].copies]).toEqual(['facebook']);
            expect(JSON.parse(mem.async.get(vaultMoveUnfinishedStoreKey(kim.publicKey))!)).toEqual([{ url: MULLUM, provider: 'facebook', generation: 5 }]);

            net.communities[MULLUM].deletesFailFor.clear();
            await retryCommunityRemovals(kim);
            expect(net.communities[MULLUM].copies.size).toBe(0);
            expect(await mullumPending()).toEqual([]);
        });

        it('a change someone made there since (Google linked again from another device): neither delete is sent, both copies are listed as kept', async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].copies.add('facebook');
            const ways = await listWaysBack(kim);
            net.communities[MULLUM].down = true;
            await removeEverything(kim, ways);
            net.communities[MULLUM].down = false;
            net.communities[MULLUM].generation = 5;
            const tried = deletesAt(net, MULLUM).length;

            await retryCommunityRemovals(kim);

            expect(deletesAt(net, MULLUM).length - tried).toBe(0);
            expect([...net.communities[MULLUM].copies]).toEqual(['google', 'facebook']);
            const after = await listWaysBack(kim);
            expect(after.pending).toEqual([]);
            expect(knownCopies(after).filter((c) => c.at === 'community')).toEqual([
                { at: 'community', url: MULLUM, provider: 'google' },
                { at: 'community', url: MULLUM, provider: 'facebook' },
            ]);
        });

        it("one status read for each community however many deletes wait there, and every community at once", async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].copies.add('facebook');
            net.communities[GLOBAL].copies.add('google');
            net.communities[GLOBAL].generation = 2;
            const ways = await listWaysBack(kim);
            net.communities[MULLUM].down = true;
            net.communities[GLOBAL].down = true;
            await removeEverything(kim, ways);
            net.communities[MULLUM].down = false;
            net.communities[GLOBAL].down = false;
            const from = net.sent.length;
            const statusAsked = () => net.sent.slice(from).filter((s) => s.path === '/api/recovery/shares/status').map((s) => s.origin).sort();
            let open!: () => void;
            net.statusGate = new Promise<void>((r) => { open = r; });

            const retry = retryCommunityRemovals(kim);
            try {
                // Both are asked before either answers: a community that hangs holds the others up no longer than itself.
                await vi.waitFor(() => expect(statusAsked()).toEqual([GLOBAL, MULLUM]));
            } finally {
                open();
            }
            await retry;

            expect(statusAsked()).toEqual([GLOBAL, MULLUM]);
            expect(net.communities[MULLUM].copies.size + net.communities[GLOBAL].copies.size).toBe(0);
        });

        it('two retries at once (app open, and the screen opening): each delete is sent once', async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].copies.add('facebook');
            const ways = await listWaysBack(kim);
            net.communities[MULLUM].down = true;
            await removeEverything(kim, ways);
            net.communities[MULLUM].down = false;
            const tried = deletesAt(net, MULLUM).length;

            await Promise.all([retryCommunityRemovals(kim), retryCommunityRemovals(kim)]);

            expect(deletesAt(net, MULLUM).length - tried).toBe(2);
            expect(net.communities[MULLUM].copies.size).toBe(0);
            expect(await mullumPending()).toEqual([]);
        });

        // PR #2570 review 4402938538: the guard followed only the deletes whose answers the phone read. One that landed
        // while its answer was lost (a timeout, a dropped connection) moved Mullum's generation all the same, so the
        // sibling waiting at the generation Kim saw was dropped unsent: Mullum kept it and nothing waited. Both of these
        // left that copy at Mullum on this branch before the fix.
        it('the first delete lands with its answer lost, and the second gets a 5xx: the second goes at the next open', async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].copies.add('facebook');
            const ways = await listWaysBack(kim);
            net.communities[MULLUM].answersLostFor.add('google');
            net.communities[MULLUM].deletesFailFor.add('facebook');
            const done = await removeEverything(kim, ways);
            expect(done.communities.map((c) => [c.provider, c.removal.removed])).toEqual([['google', false], ['facebook', false]]);
            expect([...net.communities[MULLUM].copies]).toEqual(['facebook']);
            net.communities[MULLUM].answersLostFor.clear();
            net.communities[MULLUM].deletesFailFor.clear();

            await retryCommunityRemovals(kim);

            expect(net.communities[MULLUM].copies.size).toBe(0);
            expect(await mullumPending()).toEqual([]);
        });

        it('the first delete gets a 5xx, and the second lands with its answer lost: the first goes at the next open', async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].copies.add('facebook');
            const ways = await listWaysBack(kim);
            net.communities[MULLUM].deletesFailFor.add('google');
            net.communities[MULLUM].answersLostFor.add('facebook');
            const done = await removeEverything(kim, ways);
            expect(done.communities.map((c) => [c.provider, c.removal.removed])).toEqual([['google', false], ['facebook', false]]);
            expect([...net.communities[MULLUM].copies]).toEqual(['google']);
            net.communities[MULLUM].deletesFailFor.clear();
            net.communities[MULLUM].answersLostFor.clear();

            await retryCommunityRemovals(kim);

            expect(net.communities[MULLUM].copies.size).toBe(0);
            expect(await mullumPending()).toEqual([]);
        });

        it('the same with Remove one at a time from one list: the one waiting goes at the next open', async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].copies.add('facebook');
            const ways = await listWaysBack(kim);
            net.communities[MULLUM].deletesFailFor.add('google');
            net.communities[MULLUM].answersLostFor.add('facebook');
            expect(await removeCommunityCopyFrom(kim, ways.communities[0], 'google')).toEqual({ removed: false, why: 'remembered' });
            expect(await removeCommunityCopyFrom(kim, ways.communities[0], 'facebook')).toEqual({ removed: false, why: 'remembered' });
            net.communities[MULLUM].deletesFailFor.clear();
            net.communities[MULLUM].answersLostFor.clear();

            await retryCommunityRemovals(kim);

            expect(net.communities[MULLUM].copies.size).toBe(0);
            expect(await mullumPending()).toEqual([]);
        });

        /** The same trials every run (mulberry32). */
        function seeded(seed: number): () => number {
            let a = seed >>> 0;
            return () => {
                a = (a + 0x6d2b79f5) >>> 0;
                let t = a;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        /**
         * One trial of the review's sweep: Mullum keeps two or three of Kim's copies; Kim removes them (Remove everything,
         * or one at a time from one list) while each delete is answered, refused, unanswered or lands with its answer lost;
         * up to three passes follow where Mullum's status can't be asked either, then two where everything is answered.
         * With `linkAgain`, another device links one of them at Mullum again before one of those passes. What went wrong,
         * or null.
         */
        async function sweepTrial(random: () => number, relink: boolean): Promise<string | null> {
            function pick<T>(xs: readonly T[]): T {
                return xs[Math.floor(random() * xs.length)];
            }
            mem.async.clear();
            mem.secure.clear();
            const net = network();
            await kimsPhone(net);
            net.vault.copies.clear();
            const mullum = net.communities[MULLUM];
            mullum.copies = new Set(pick([['google', 'facebook'], ['google', 'facebook', 'apple']]));
            const ways = await listWaysBack(kim);
            const listed = ways.communities[0];
            let failing = true;
            mullum.fate = (req) => !failing
                ? 'answered'
                : req.method === 'DELETE' ? pick(['answered', 'refused', 'down', 'lost'] as const) : pick(['answered', 'down'] as const);
            const oneByOne = random() < 0.5;
            if (oneByOne) for (const p of listed.status!.providers) await removeCommunityCopyFrom(kim, listed, p);
            else await removeEverything(kim, ways);
            const passes = Math.floor(random() * 4);
            const linkedAgain = relink ? pick(listed.status!.providers) : null;
            const linkBefore = Math.floor(random() * (passes + 1));
            let sentAtLink = net.sent.length;
            for (let pass = 0; pass < passes + 2; pass++) {
                if (pass === passes) failing = false;
                if (linkedAgain && pass === linkBefore) {
                    linkAgain(mullum, linkedAgain);
                    sentAtLink = net.sent.length;
                }
                await retryCommunityRemovals(kim);
            }
            const trial = `${oneByOne ? 'one by one' : 'everything'}, ${passes} failing passes${linkedAgain ? `, ${linkedAgain} linked again before pass ${linkBefore}` : ''}`;
            const waiting = (await listWaysBack(kim)).pending;
            if (waiting.length) return `${trial}: still waiting ${waiting.map((w) => w.provider).join('+')}`;
            if (!linkedAgain) return mullum.copies.size ? `${trial}: Mullum still keeps ${[...mullum.copies].join('+')}, with nothing waiting` : null;
            const deletedAgain = net.sent.slice(sentAtLink).some((s) => s.origin === MULLUM && s.method === 'DELETE' && s.path.endsWith(`/${linkedAgain}`));
            if (deletedAgain || !mullum.copies.has(linkedAgain)) return `${trial}: the copy linked again was sent a delete`;
            return null;
        }

        describe("a seeded sweep with nobody else changing Mullum's copies: every one goes, and nothing waits", () => {
            let random: () => number;
            beforeAll(() => {
                random = seeded(2570);
            });
            for (let chunk = 0; chunk < 5; chunk++) {
                const start = chunk * 50;
                const end = start + 50;
                it(`trials ${start}–${end - 1}`, async () => {
                    const wrong: string[] = [];
                    for (let i = start; i < end; i++) {
                        const w = await sweepTrial(random, false);
                        if (w) wrong.push(`trial ${i}: ${w}`);
                    }
                    expect(wrong).toEqual([]);
                }, 60_000);
            }
        });

        describe('a seeded sweep with a copy linked again from another device meanwhile: that copy is never sent a delete, and nothing waits', () => {
            let random: () => number;
            beforeAll(() => {
                random = seeded(4402938538);
            });
            for (let chunk = 0; chunk < 5; chunk++) {
                const start = chunk * 50;
                const end = start + 50;
                it(`trials ${start}–${end - 1}`, async () => {
                    const wrong: string[] = [];
                    for (let i = start; i < end; i++) {
                        const w = await sweepTrial(random, true);
                        if (w) wrong.push(`trial ${i}: ${w}`);
                    }
                    expect(wrong).toEqual([]);
                }, 60_000);
            }
        });
    });

    it('the move card never offers to move a copy that is waiting to be removed', async () => {
        const net = network();
        await kimsPhone(net);
        net.vault.copies.clear();
        const ways = await listWaysBack(kim);
        net.communities[MULLUM].deletesFail = true;
        await removeCommunityCopyFrom(kim, ways.communities[0], 'google');
        // Mullum still lists the copy (its delete failed again), and the vault keeps none: on main, the card offered it.
        expect(await vaultMoveOffer(kim, MULLUM)).toBeNull();
    });
});

describe('Remove everything', () => {
    it("the vault's copies and every community's go, each on its own answer; the phone knows the vault keeps none", async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[GLOBAL].copies.add('google');
        const ways = await listWaysBack(kim);

        const done = await removeEverything(kim, ways);

        expect(done).toEqual({
            vault: { removed: true },
            communities: [
                { url: MULLUM, name: 'Mullumbimby', provider: 'google', removal: { removed: true } },
                { url: GLOBAL, name: 'Global community', provider: 'google', removal: { removed: true } },
            ],
            // Neither keeps a copy for its admins (vault rethink VR3): nothing to remove there.
            admins: [],
            notAsked: [],
        });
        expect(vaultDeletes(net).map((s) => s.body)).toEqual([expect.objectContaining({ all: true })]);
        expect(net.vault.copiesOf(kim.publicKey)).toEqual([]);
        expect(net.vault.copiesOf(OTHER_KEY)).toHaveLength(1);
        expect(net.communities[MULLUM].copies.size + net.communities[GLOBAL].copies.size).toBe(0);
        // On main the phone went on believing the deposit it last heard of ('kept').
        expect(await vaultCopyKnowledge(kim.publicKey)).toBe('none');

        const after = await listWaysBack(kim);
        expect(wordsOnly(after)).toBe(true);
    });

    it("a community that couldn't be asked has nothing removed, and says so; a vault that couldn't say is asked to remove all", async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[MULLUM].down = true;
        net.vault.locked = true;
        const ways = await listWaysBack(kim);
        net.vault.locked = false;

        const done = await removeEverything(kim, ways);

        expect(done.vault).toEqual({ removed: true });
        expect(done.communities).toEqual([]);
        expect(done.notAsked).toEqual([{ url: MULLUM, name: 'Mullumbimby' }]);
        // Never a delete sent to a community whose copies the phone was never shown.
        expect(deletesAt(net, MULLUM)).toHaveLength(0);
        expect(net.communities[MULLUM].copies.has('google')).toBe(true);
        expect(mem.async.get(vaultMoveUnfinishedStoreKey(kim.publicKey))).toBeUndefined();
    });

    it('a vault that does not remove them is "not removed" with why; a community whose delete fails is remembered', async () => {
        const net = network();
        await kimsPhone(net);
        const ways = await listWaysBack(kim);
        net.vault.locked = true;
        net.communities[MULLUM].deletesFail = true;

        const done = await removeEverything(kim, ways);

        expect(done.vault).toEqual({ removed: false, why: 'paused' });
        expect(done.communities).toEqual([{ url: MULLUM, name: 'Mullumbimby', provider: 'google', removal: { removed: false, why: 'remembered' } }]);
        expect(net.vault.copiesOf(kim.publicKey)).toHaveLength(2);
        expect(await vaultCopyKnowledge(kim.publicKey)).toBe('kept');
        net.vault.locked = false;
        expect((await listWaysBack(kim)).pending).toEqual([{ url: MULLUM, provider: 'google' }]);
    });

    it('a vault that listed none is not asked again', async () => {
        const net = network();
        await kimsPhone(net);
        net.vault.copies.clear();
        const ways = await listWaysBack(kim);
        const done = await removeEverything(kim, ways);
        expect(done.vault).toBeNull();
        expect(vaultDeletes(net)).toEqual([]);
    });
});

describe('the last way back: the 12 words are asked about first, and only then', () => {
    const phone = (hasWords: boolean, writtenDown: boolean) => ({ hasWords, writtenDown });

    it('a removal that leaves another copy: an ordinary confirm', async () => {
        const net = network();
        await kimsPhone(net);
        const ways = await listWaysBack(kim);
        expect(beforeRemoving(ways, { at: 'vault', provider: 'google' }, phone(true, false))).toBe('confirm');
        expect(beforeRemoving(ways, { at: 'community', url: MULLUM, provider: 'google' }, phone(false, false))).toBe('confirm');
    });

    it('the last copy, or everything: "Show my 12 words first?" with words on the phone; plainly said without; a confirm once written down', async () => {
        const net = network();
        await kimsPhone(net);
        net.vault.copies.clear();
        net.vault.keep('google', 'kim-google', kim.publicKey, SOME_COPY);
        net.communities[MULLUM].copies.clear();
        const ways = await listWaysBack(kim);
        const last = { at: 'vault', provider: 'google' } as const;
        expect(beforeRemoving(ways, last, phone(true, false))).toBe('show-words-first');
        expect(beforeRemoving(ways, last, phone(false, false))).toBe('no-words-on-phone');
        expect(beforeRemoving(ways, last, phone(true, true))).toBe('confirm');
        expect(beforeRemoving(ways, last, phone(false, true))).toBe('confirm');
        const full = await listWaysBack(kim);
        expect(beforeRemoving(full, 'everything', phone(true, false))).toBe('show-words-first');
    });

    it('a copy waiting to be removed, or a keeper that couldn\'t say, is not counted as a way back that stays', async () => {
        const net = network();
        await kimsPhone(net);
        net.vault.copies.clear();
        net.vault.keep('apple', 'kim-apple', kim.publicKey, SOME_COPY);
        const first = await listWaysBack(kim);
        net.communities[MULLUM].down = true;
        await removeCommunityCopyFrom(kim, first.communities[0], 'google');
        net.communities[MULLUM].down = false;
        net.communities[MULLUM].deletesFail = true;
        const ways = await listWaysBack(kim);
        // Mullum's Google copy is physically still there, but Kim asked for it to go.
        expect(ways.pending).toEqual([{ url: MULLUM, provider: 'google' }]);
        expect(beforeRemoving(ways, { at: 'vault', provider: 'apple' }, phone(true, false))).toBe('show-words-first');

        // The vault can't say: its copies aren't counted on either.
        net.vault.locked = true;
        const blind: WaysBack = await listWaysBack(kim);
        expect(beforeRemoving(blind, { at: 'community', url: MULLUM, provider: 'google' }, phone(true, false))).toBe('show-words-first');
    });

    it("written down is the member's say-so, per account; the one-way-back card's \"I still have my 12 words\" counts until taken back", async () => {
        const net = network();
        await kimsPhone(net);
        expect(await wordsWrittenDown(kim.publicKey)).toBe(false);
        await startOneWayBack(kim.publicKey, GLOBAL);
        await finishOneWayBack(kim.publicKey, 'checked');
        expect(await wordsWrittenDown(kim.publicKey)).toBe(true);
        await noteWordsWrittenDown(kim.publicKey, false);
        expect(await wordsWrittenDown(kim.publicKey)).toBe(false);
        await noteWordsWrittenDown(kim.publicKey, true);
        expect(await wordsWrittenDown(kim.publicKey)).toBe(true);
        expect(await wordsWrittenDown(OTHER_KEY)).toBe(false);
    });
});

describe('after Remove everything, the "one way back" card learns there is no vault copy', () => {
    it("a 12-words account of the global community that had linked Google at the vault: quiet before, the card after", async () => {
        const net = network();
        await kimsPhone(net);
        net.vault.copies.clear();
        net.vault.keep('google', 'kim-google', kim.publicKey, SOME_COPY);
        net.communities[MULLUM].copies.clear();
        // The node's word: Kim came in with 12 words (`probation.rules: 'words'`); the card's record is not on this phone.
        const standing = { words: true, joinedAt: Date.now() - 60_000 };

        expect(await vaultCopyKnown(kim.publicKey)).toBe(true);
        const before = await oneWayBackFromNode(kim.publicKey, GLOBAL, standing, Date.now(), { vaultCopy: await vaultCopyKnown(kim.publicKey) });
        // With a vault copy, nothing is written and the card stays quiet (OneWayBackCard `quiet`).
        expect(mem.async.has(`beanpool_one_way_back:${kim.publicKey.toLowerCase()}`)).toBe(false);
        expect(before).not.toBeNull();

        await removeEverything(kim, await listWaysBack(kim));

        expect(await vaultCopyKnown(kim.publicKey)).toBe(false);
        const after = await oneWayBackFromNode(kim.publicKey, GLOBAL, standing, Date.now(), { vaultCopy: await vaultCopyKnown(kim.publicKey) });
        expect(oneWayBackPlace(after, Date.now(), false)).toBe('card');
        expect(mem.async.has(`beanpool_one_way_back:${kim.publicKey.toLowerCase()}`)).toBe(true);
    });
});

describe("your community's admins (vault rethink VR3): their copy is listed, since when, and removed like the others", () => {
    const SINCE = '2026-10-29T04:05:06.000Z';
    const adminsAt = (net: Net, origin: string) => deletesAt(net, origin).filter((s) => s.path === '/api/recovery/community-copy');

    it("listed under its community with since when, from the same signed status; a way back, so never 'words only'", async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[MULLUM].admins = { since: SINCE };
        const ways = await listWaysBack(kim);
        expect(ways.communities[0]).toEqual({ url: MULLUM, name: 'Mullumbimby', status: { providers: ['google'], generation: 4, adminsCopy: { since: SINCE } } });
        expect(ways.communities[1].status).toEqual({ providers: [], generation: 0 });
        expect(knownCopies(ways)).toContainEqual({ at: 'admins', url: MULLUM });
        // One status per community, as before: the copy rides in the answer the list already asks for.
        expect(net.sent.filter((s) => s.path === '/api/recovery/community-copy/status')).toEqual([]);
        expect(net.sent.filter((s) => s.path === '/api/recovery/shares/status')).toHaveLength(2);

        // With nothing else kept anywhere, the admins' copy alone still keeps the list from saying "words only".
        net.vault.copies.clear();
        net.communities[MULLUM].copies.clear();
        const alone = await listWaysBack(kim);
        expect(knownCopies(alone)).toEqual([{ at: 'admins', url: MULLUM }]);
        expect(wordsOnly(alone)).toBe(false);
        // ...and removing it is removing the last way back: the 12 words are asked about first.
        expect(beforeRemoving(alone, { at: 'admins', url: MULLUM }, { hasWords: true, writtenDown: false })).toBe('show-words-first');
        expect(beforeRemoving(ways, { at: 'admins', url: MULLUM }, { hasWords: true, writtenDown: false })).toBe('confirm');
    });

    it("a server from before it never names the copy: nothing listed for it, and nothing sent to remove one", async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[MULLUM].beforeVr3 = true;
        const ways = await listWaysBack(kim);
        expect(ways.communities[0].status).toEqual({ providers: ['google'], generation: 4 });
        expect(knownCopies(ways).some((c) => c.at === 'admins')).toBe(false);
        await removeEverything(kim, ways);
        expect(adminsAt(net, MULLUM)).toEqual([]);
    });

    it("Remove: the signed delete, removed on the community's own answer, and gone from the list", async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[MULLUM].admins = { since: SINCE };
        const ways = await listWaysBack(kim);
        expect(await removeAdminsCopyFrom(kim, ways.communities[0])).toEqual({ removed: true });
        expect(adminsAt(net, MULLUM)).toHaveLength(1);
        expect(net.communities[MULLUM].admins).toBeNull();
        // The sign-in copy there is untouched.
        expect([...net.communities[MULLUM].copies]).toEqual(['google']);
        expect(knownCopies(await listWaysBack(kim)).some((c) => c.at === 'admins')).toBe(false);
    });

    for (const [what, how] of [['refuses it (a standby, a 5xx)', 'refused'], ["answers with a proxy's page", 'proxy']] as const) {
        it(`a community that ${what}: not removed, still listed, and not remembered as waiting`, async () => {
            const net = network();
            await kimsPhone(net);
            net.communities[MULLUM].admins = { since: SINCE };
            net.communities[MULLUM].adminsDelete = how;
            const ways = await listWaysBack(kim);
            const r = await removeAdminsCopyFrom(kim, ways.communities[0]);
            expect(r.removed).toBe(false);
            expect(net.communities[MULLUM].admins).toEqual({ since: SINCE });
            const again = await listWaysBack(kim);
            expect(knownCopies(again)).toContainEqual({ at: 'admins', url: MULLUM });
            expect(again.pending).toEqual([]);
            expect(mem.async.get(vaultMoveUnfinishedStoreKey(kim.publicKey))).toBeUndefined();
        });
    }

    it("Remove everything takes it too, beside the vault's copies and the sign-ins'; after it, the words only", async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[MULLUM].admins = { since: SINCE };
        const done = await removeEverything(kim, await listWaysBack(kim));
        expect(done.admins).toEqual([{ url: MULLUM, name: 'Mullumbimby', removal: { removed: true } }]);
        expect(done.communities.map((c) => c.provider)).toEqual(['google']);
        expect(done.vault).toEqual({ removed: true });
        expect(adminsAt(net, MULLUM)).toHaveLength(1);
        // Global keeps no copy for its admins (never offered there): nothing is sent to remove one.
        expect(adminsAt(net, GLOBAL)).toEqual([]);
        expect(wordsOnly(await listWaysBack(kim))).toBe(true);
    });

    it("Remove everything with that delete refused: said as not removed, and the list still shows the copy", async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[MULLUM].admins = { since: SINCE };
        net.communities[MULLUM].adminsDelete = 'refused';
        const done = await removeEverything(kim, await listWaysBack(kim));
        expect(done.admins).toEqual([{ url: MULLUM, name: 'Mullumbimby', removal: { removed: false, why: 'unreachable' } }]);
        const after = await listWaysBack(kim);
        expect(knownCopies(after)).toEqual([{ at: 'admins', url: MULLUM }]);
        expect(wordsOnly(after)).toBe(false);
    });

    it("a copy its server keeps but can't open: listed as that and removable, never a way back (#2626 deciding pass)", async () => {
        const net = network();
        await kimsPhone(net);
        net.vault.copies.clear();
        net.communities[MULLUM].copies.clear();
        net.communities[MULLUM].adminsUnopenable = { since: SINCE, reason: 'recovery_seal_key_missing' };
        const ways = await listWaysBack(kim);
        expect(ways.communities[0].status).toEqual({ providers: [], generation: 4, adminsCopyUnopenable: { since: SINCE, reason: 'recovery_seal_key_missing' } });
        expect(knownCopies(ways), 'it brings nobody back: not counted').toEqual([]);
        expect(unopenableAdminsCopies(ways).map((c) => c.url)).toEqual([MULLUM]);
        // It is kept, so the list never says nothing is (its row says the 12 words still work).
        expect(wordsOnly(ways)).toBe(false);
        // Removing it takes no way back away: an ordinary confirm, not "show my 12 words first".
        expect(beforeRemoving(ways, { at: 'admins', url: MULLUM }, { hasWords: true, writtenDown: false })).toBe('confirm');
        // Remove everything takes it too: it is still the member's key, on that server.
        const done = await removeEverything(kim, ways);
        expect(done.admins).toEqual([{ url: MULLUM, name: 'Mullumbimby', removal: { removed: true } }]);
        expect(adminsAt(net, MULLUM)).toHaveLength(1);
        expect(net.communities[MULLUM].adminsUnopenable).toBeNull();
        expect(wordsOnly(await listWaysBack(kim))).toBe(true);
    });

    it("a reason this phone doesn't know is still 'can't open', never kept", async () => {
        const net = network();
        await kimsPhone(net);
        net.communities[MULLUM].adminsUnopenable = { since: SINCE, reason: 'a_reason_from_a_later_server' };
        const ways = await listWaysBack(kim);
        expect(ways.communities[0].status?.adminsCopyUnopenable).toEqual({ since: SINCE, reason: 'recovery_seal_unopenable' });
        expect(ways.communities[0].status?.adminsCopy).toBeUndefined();
        expect(knownCopies(ways).some((c) => c.at === 'admins')).toBe(false);
    });
});
