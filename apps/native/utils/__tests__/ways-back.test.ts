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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import type { SealedShare } from '@beanpool/core';
import { draftIdentity, importIdentity, type BeanPoolIdentity } from '../identity';
import { oneWayBackFromNode, oneWayBackPlace, startOneWayBack, finishOneWayBack } from '../one-way-back';
import { SAVED_NODES_STORE_KEY, vaultCopyKnownStoreKey, vaultMoveUnfinishedStoreKey } from '../storage-keys';
import { vaultCopyKnowledge, vaultCopyKnown } from '../vault';
import { retryCommunityRemovals, vaultMoveOffer } from '../vault-move';
import {
    beforeRemoving, everyoneAnswered, knownCopies, listWaysBack, noteWordsWrittenDown, removeCommunityCopyFrom, removeEverything,
    removeVaultCopy, vaultCopiesBySignIn, wordsOnly, wordsWrittenDown, type WaysBack,
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
        copies: new Set(copies), generation, down: false, deletesFail: false, deletesFailFor: new Set(),
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
        if (c.down) throw new TypeError('Network request failed');
        // The node's own check of a member-signed request: Kim's key, for this community's host.
        if (!boundSignatureValid({ url, method: req.method, headers: req.headers, body: raw }, kim.publicKey)) {
            return json(401, { error: 'This request must be signed by an active member of this node.' });
        }
        if (req.method === 'POST' && u.pathname === '/api/recovery/shares/status') {
            if (net.statusGate) await net.statusGate;
            return json(200, { generation: c.generation, enrolledSso: [...c.copies], keepers: [], total: c.copies.size, threshold: 1 });
        }
        const del = /^\/api\/recovery\/shares\/sso\/([a-z]+)$/.exec(u.pathname);
        if (req.method === 'DELETE' && del) {
            if (c.deletesFail || c.deletesFailFor.has(del[1])) return json(503, { error: 'Try again later.' });
            if (!c.copies.delete(del[1])) return json(404, { error: `Provider '${del[1]}' is not connected for this account.` });
            // As the node answers: the new generation its copies are at, or 0 once it removed the last one.
            c.generation = c.copies.size ? c.generation + 1 : 0;
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
