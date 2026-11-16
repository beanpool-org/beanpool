/**
 * The member's list of communities inside their sign-in copy (vault rethink VR5, utils/copy-communities.ts): the tick
 * (on unless unticked), the list a connect seals (this phone's communities, the one it is on first), what reaches the
 * vault (only the sealed copy: no name or address of a community in any byte sent), the 21st community left out and
 * said, a copy without a list exactly as before, and a restore saving the copy's communities on the new phone.
 * fake-vault.ts plays the vault with core's real deposit boxes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///docs/',
    EncodingType: { UTF8: 'utf8' },
    writeAsStringAsync: vi.fn(async () => {}),
    deleteAsync: vi.fn(async () => {}),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { createRequire } from 'node:module';
import { openSeedFromSso, signAddressList, signAddressProof, type AddressListFields } from '@beanpool/core';
import { proofAt } from '../address-verify';
import { resetCommunityIndexForTests } from '../community-index';
import { resetCommunityRecordsForTests } from '../community-record';
import { enrolSsoKeeper } from '../keeper-enrolment';
import { vaultTicket } from '../vault';
import {
    communitiesForCopy, communitiesOnPhoneForCopy, copyListsCommunities, RESTORE_PROVE_AT_ONCE, RESTORE_PROVE_CAP_MS, saveCommunitiesFromCopy,
    setCopyListsCommunities,
} from '../copy-communities';
import { getSavedNodes } from '../nodes';
import { COMMUNITY_RECORDS_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';
import { installNetwork, fakeJwt, noVault, useVault, VAULT, type Network } from './fake-vault';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SEED = sha256(sha256(Buffer.from(PHRASE, 'utf8')));
const ID = {
    callsign: 'Alice',
    publicKey: Buffer.from(ed25519.getPublicKey(SEED)).toString('hex'),
    privateKey: Buffer.from(SEED).toString('hex'),
    createdAt: '2026-10-31T00:00:00.000Z',
    mnemonic: PHRASE.split(' '),
} as any;
const SAVED = [
    { url: 'https://castlemaine.beanpool.org', alias: 'Castlemaine' },
    { url: 'https://mullum.beanpool.org', alias: 'Mullumbimby' },
    { url: 'http://192.168.1.20:8080' },
];

let net: Network;
const originalFetch = globalThis.fetch;

async function connect(sub: string, communities: Parameters<typeof enrolSsoKeeper>[0]['communities']) {
    const grant = await vaultTicket(ID, 'deposit', 'google');
    return enrolSsoKeeper({
        identity: ID, provider: 'google', sub, ticket: grant.ticket, idToken: fakeJwt({ sub, nonce: grant.nonce }), communities,
    });
}
const deposited = (): any => [...net.vault.copies.values()].at(-1)?.clientCopy;

beforeEach(() => {
    vi.clearAllMocks();
    mem.async.clear();
    mem.secure.clear();
    useVault();
    net = installNetwork();
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    noVault();
});

describe('the tick', () => {
    // The panel draws the tick from what is kept, and hands what it shows to the sheet (KeeperProtectionPanel onProtectSso).
    const shownTick = () => copyListsCommunities(ID.publicKey);

    it('is on until the member unticks it, per account; off, a connect carries no list', async () => {
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(SAVED));
        expect(await copyListsCommunities(ID.publicKey)).toBe(true);
        expect(await communitiesForCopy(await shownTick())).not.toBeNull();
        await setCopyListsCommunities(ID.publicKey, false);
        expect(await copyListsCommunities(ID.publicKey)).toBe(false);
        expect(await copyListsCommunities('ab'.repeat(32))).toBe(true);
        expect(await communitiesForCopy(await shownTick())).toBeNull();
        await setCopyListsCommunities(ID.publicKey, true);
        expect(await communitiesForCopy(await shownTick())).toHaveLength(3);
    });

    it('the kept tick alone sends no list: only a choice the opener hands over does (#2660 review, finding 1)', async () => {
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(SAVED));
        await setCopyListsCommunities(ID.publicKey, true);
        // An opener with no tick on screen (Settings' move card, welcome's claim-flow Add a sign-in) hands nothing, or false.
        expect(await communitiesForCopy(undefined)).toBeNull();
        expect(await communitiesForCopy(false)).toBeNull();
        expect(await communitiesForCopy(true)).toHaveLength(3);
    });

    it("the list is this phone's communities, the one it is on first, by the names the phone shows; none, no list", async () => {
        expect(await communitiesForCopy(true)).toBeNull();
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(SAVED));
        mem.async.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        expect(await communitiesOnPhoneForCopy()).toEqual([
            { name: 'Mullumbimby', url: 'https://mullum.beanpool.org' },
            { name: 'Castlemaine', url: 'https://castlemaine.beanpool.org' },
            { name: '192.168.1.20:8080', url: 'http://192.168.1.20:8080' },
        ]);
    });
});

describe('a connect with the list', () => {
    it('seals it inside the copy at the vault: the copy opens to the key, the words and the list', async () => {
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(SAVED));
        const result = await connect('google-sub-1', await communitiesForCopy(true));
        expect(result.error).toBeUndefined();
        expect(result.communitiesListed).toBe(3);
        expect(result.communitiesLeftOut).toBe(0);
        const opened = await openSeedFromSso(deposited(), 'google', 'google-sub-1');
        expect(Buffer.from(ed25519.getPublicKey(opened.seed)).toString('hex')).toBe(ID.publicKey);
        expect(opened.words).toEqual(ID.mnemonic);
        expect(opened.communities?.map((c) => c.url)).toEqual(SAVED.map((n) => n.url));
    });

    it('never sends a name or address of a community in the clear: not one byte of any request to the vault', async () => {
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(SAVED));
        await connect('google-sub-1', await communitiesForCopy(true));
        const sent = net.sent.filter((s) => s.origin === VAULT);
        expect(sent.some((s) => s.path === '/v1/copies')).toBe(true);
        for (const s of sent) {
            const bytes = `${s.url} ${JSON.stringify(s.headers)} ${s.raw}`.toLowerCase();
            for (const needle of ['mullum', 'castlemaine', '192.168.1.20', 'beanpool.org']) expect(bytes).not.toContain(needle);
        }
        // What the vault keeps is the sealed copy: the list is in it only as ciphertext.
        expect(JSON.stringify(deposited()).toLowerCase()).not.toMatch(/mullum|castlemaine|192\.168/);
    });

    it('takes 20; the 21st and on are left out, and the result says how many, for the sheet to say', async () => {
        const many = Array.from({ length: 23 }, (_, i) => ({ name: `Community ${i}`, url: `https://c${i}.example.org` }));
        const result = await connect('google-sub-2', many);
        expect(result.communitiesListed).toBe(20);
        expect(result.communitiesLeftOut).toBe(3);
        const opened = await openSeedFromSso(deposited(), 'google', 'google-sub-2');
        expect(opened.communities).toHaveLength(20);
        expect(opened.communities?.[0]).toEqual({ name: 'Community 0', url: 'https://c0.example.org' });
    });

    it('without one, the copy is exactly as before lists: no list field, and nothing said about one', async () => {
        for (const none of [null, undefined, []]) {
            const result = await connect('google-sub-3', none);
            expect(result.error).toBeUndefined();
            expect(result.communitiesListed).toBeUndefined();
            expect(result.communitiesLeftOut).toBeUndefined();
            expect(Object.keys(JSON.parse(deposited().kdfParams))).toEqual(['alg', 'salt', 'N', 'r', 'p', 'words']);
        }
    });
});

describe('a restore from a copy with the list', () => {
    it("saves each community the phone hasn't saved, by the copy's name; keeps the phone's own names; skips what isn't an address", async () => {
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: 'https://mullum.beanpool.org', alias: 'Mullum (mine)' }]));
        const added = await saveCommunitiesFromCopy([
            { name: 'Mullumbimby', url: 'https://mullum.beanpool.org' },
            { name: 'Castlemaine', url: 'https://castlemaine.beanpool.org' },
            { name: 'path', url: 'https://bad.example.org/app' },
            { name: '', url: 'http://192.168.1.20:8080' },
        ]);
        expect(added).toBe(2);
        const saved = await getSavedNodes();
        expect(saved.map((n) => [n.url, n.alias])).toEqual([
            ['https://mullum.beanpool.org', 'Mullum (mine)'],
            ['https://castlemaine.beanpool.org', 'Castlemaine'],
            ['http://192.168.1.20:8080', undefined],
        ]);
    });

    it('registers this phone\'s token once the list is back, only when one came back, and a registration that fails fails nothing', async () => {
        const registerPush = vi.fn(async () => {});
        await saveCommunitiesFromCopy([{ name: 'Castlemaine', url: 'https://castlemaine.beanpool.org' }], registerPush);
        expect(registerPush).toHaveBeenCalledTimes(1);
        await saveCommunitiesFromCopy([{ name: 'Castlemaine', url: 'https://castlemaine.beanpool.org' }], registerPush);
        expect(registerPush).toHaveBeenCalledTimes(1);
        await expect(saveCommunitiesFromCopy([{ name: 'Byron', url: 'https://byron.beanpool.org' }], async () => { throw new Error('no connection'); })).resolves.toBe(1);
    });

    it('a copy without a list saves nothing and never throws', async () => {
        for (const none of [null, undefined, []]) expect(await saveCommunitiesFromCopy(none)).toBe(0);
        expect(await getSavedNodes()).toEqual([]);
        expect(await saveCommunitiesFromCopy([null as any, { url: 7 } as any])).toBe(0);
    });
});

// ── Several addresses S8: each community's key and up to three addresses, and a restore at whichever still answers ──

describe('several addresses S8: the copy carries the key and addresses; a restore finds the community at whichever answers', () => {
    const V = createRequire(import.meta.url)('@beanpool/core/vectors/address-list.json');
    const KEY = { seed: hexToBytes(V.keys.community.seedHex), peerId: V.keys.community.peerId as string };
    const OTHER_KEY = { seed: hexToBytes(V.keys.other.seedHex), peerId: V.keys.other.peerId as string };
    const FIRST = '203.0.113.5';
    const SECOND = '198.51.100.7';
    const list = (): AddressListFields => ({ peerId: KEY.peerId, communityId: V.communityIds.community, epoch: 1, seq: 6, main: SECOND, addresses: [FIRST, SECOND, 'coop.example.org'], spares: [] });

    /** Stand-in servers: who answers at each address, signing real proofs; any other address gives no answer. */
    const proverWith = (who: Record<string, typeof KEY>) => {
        let n = 0;
        const get = async (url: string) => {
            const u = new URL(url);
            const key = who[u.host];
            if (!key) return null;
            const signed = { v: 1 as const, ...list(), peerId: key.peerId };
            return { status: 200, body: await signAddressProof({ list: signed, for: u.searchParams.get('for')!, nonce: u.searchParams.get('nonce')!, ts: 1 }, (m) => ed25519.sign(m, key.seed)) };
        };
        return (address: string, peerId: string) => proofAt(address, peerId, { get, nonce: () => (++n).toString(16).padStart(32, '0') });
    };
    const fromCopy = { name: 'Riverside', url: `https://${FIRST}`, peerId: KEY.peerId, addresses: [FIRST, SECOND] };

    it('the copy lists each community with its key and up to three addresses from its record, the one in use first', async () => {
        const kept = await signAddressList(list(), (m) => ed25519.sign(m, KEY.seed));
        mem.async.set('beanpool_anchor_url', `https://${SECOND}`);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: `https://${SECOND}`, alias: 'Riverside' }, { url: 'https://hill.example' }]));
        mem.async.set(COMMUNITY_RECORDS_STORE_KEY, JSON.stringify({ v: 1, records: [
            { v: 1, id: `https://${FIRST}`, using: `https://${SECOND}`, peerId: KEY.peerId, communityId: V.communityIds.community, epoch: 1, list: kept, proved: {}, refused: {} },
        ] }));
        resetCommunityRecordsForTests();
        resetCommunityIndexForTests();
        expect(await communitiesOnPhoneForCopy()).toEqual([
            { name: 'Riverside', url: `https://${SECOND}`, peerId: KEY.peerId, addresses: [SECOND, FIRST, 'coop.example.org'] },
            { name: 'hill.example', url: 'https://hill.example' },
        ]);
    });

    it('a restore with the first address dead finds the community at the second', async () => {
        const added = await saveCommunitiesFromCopy([fromCopy], async () => {}, proverWith({ [SECOND]: KEY }));
        expect(added).toBe(1);
        expect((await getSavedNodes()).map((n) => [n.url, n.alias])).toEqual([[`https://${SECOND}`, 'Riverside']]);
    });

    it('the first address answering is kept; one answering with another key is never chosen; none answering saves the copy\'s address as before', async () => {
        await saveCommunitiesFromCopy([fromCopy], async () => {}, proverWith({ [FIRST]: KEY, [SECOND]: KEY }));
        expect((await getSavedNodes()).map((n) => n.url)).toEqual([`https://${FIRST}`]);
        mem.async.clear();
        await saveCommunitiesFromCopy([fromCopy], async () => {}, proverWith({ [SECOND]: OTHER_KEY }));
        expect((await getSavedNodes()).map((n) => n.url)).toEqual([`https://${FIRST}`]);
        mem.async.clear();
        await saveCommunitiesFromCopy([fromCopy], async () => {}, proverWith({}));
        expect((await getSavedNodes()).map((n) => n.url)).toEqual([`https://${FIRST}`]);
    });

    it('a community already saved at any of its addresses keeps its row: nothing is asked or added', async () => {
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: `https://${SECOND}`, alias: 'Mine' }]));
        const prove = vi.fn(proverWith({ [SECOND]: KEY }));
        expect(await saveCommunitiesFromCopy([fromCopy], async () => {}, prove)).toBe(0);
        expect(prove).not.toHaveBeenCalled();
        expect((await getSavedNodes()).map((n) => [n.url, n.alias])).toEqual([[`https://${SECOND}`, 'Mine']]);
    });

    // Round 2 of #3260 (the deciding review's non-blocking finding): the restore waits for this step, so it proves the
    // communities at the same time, a few at once, each asking its addresses at once, and the whole step is capped.
    describe('the restore proves at the same time, within the cap', () => {
        /** A dead address: no answer until the phone's own 8-second wait gives up (address-verify.ts ASK_TIMEOUT_MS). */
        const DEAD_MS = 8_000;
        const dead = () => new Promise<{ kind: 'silent' }>((resolve) => setTimeout(() => resolve({ kind: 'silent' }), DEAD_MS));
        const dying = (n: number) => Array.from({ length: n }, (_, i) => ({
            name: `Dead ${i}`, url: `https://dead-${i}.example`, peerId: KEY.peerId, addresses: [`dead-${i}.example`, `dead-${i}b.example`, `dead-${i}c.example`],
        }));
        afterEach(() => { vi.useRealTimers(); });

        it('20 dead communities with 3 addresses each: done within the cap (one at a time it was 8 minutes), each saved at the copy\'s address', async () => {
            vi.useFakeTimers();
            const prove = vi.fn((_a: string, _p: string) => dead());
            const started = Date.now();
            let doneAt: number | null = null;
            const run = saveCommunitiesFromCopy(dying(20), async () => {}, prove).then((n) => { doneAt = Date.now(); return n; });
            await vi.advanceTimersByTimeAsync(RESTORE_PROVE_CAP_MS);
            expect(doneAt).not.toBeNull();
            expect(doneAt! - started).toBeLessThanOrEqual(RESTORE_PROVE_CAP_MS);
            expect(await run).toBe(20);
            expect((await getSavedNodes()).map((n) => n.url)).toEqual(dying(20).map((c) => c.url));
            // A few communities at once, each with its three addresses at once: never 60 asks in flight, never one at a time.
            expect(prove.mock.calls.length).toBeGreaterThanOrEqual(RESTORE_PROVE_AT_ONCE * 3);
            expect(prove.mock.calls.length).toBeLessThan(60);
        });

        it('a community that answers is saved where it answers, though the dead ones around it run into the cap', async () => {
            vi.useFakeTimers();
            const live = { name: 'Riverside', url: `https://${FIRST}`, peerId: KEY.peerId, addresses: [FIRST, SECOND] };
            const real = proverWith({ [SECOND]: KEY });
            const prove = (a: string, p: string) => (a === FIRST || a.startsWith('dead-') ? dead() : real(a, p));
            const run = saveCommunitiesFromCopy([...dying(3), live, ...dying(20).slice(3)], async () => {}, prove);
            await vi.advanceTimersByTimeAsync(RESTORE_PROVE_CAP_MS);
            expect(await run).toBe(21);
            const urls = (await getSavedNodes()).map((n) => n.url);
            expect(urls).toContain(`https://${SECOND}`);
            expect(urls).not.toContain(`https://${FIRST}`);
            expect(urls.indexOf(`https://${SECOND}`)).toBe(3);
        });
    });
});
