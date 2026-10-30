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
import { openSeedFromSso } from '@beanpool/core';
import { enrolSsoKeeper } from '../keeper-enrolment';
import { vaultTicket } from '../vault';
import {
    communitiesForCopy, communitiesOnPhoneForCopy, copyListsCommunities, saveCommunitiesFromCopy, setCopyListsCommunities,
} from '../copy-communities';
import { getSavedNodes } from '../nodes';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';
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
    it('is on until the member unticks it, per account; off, a connect carries no list', async () => {
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(SAVED));
        expect(await copyListsCommunities(ID.publicKey)).toBe(true);
        expect(await communitiesForCopy(ID.publicKey)).not.toBeNull();
        await setCopyListsCommunities(ID.publicKey, false);
        expect(await copyListsCommunities(ID.publicKey)).toBe(false);
        expect(await copyListsCommunities('ab'.repeat(32))).toBe(true);
        expect(await communitiesForCopy(ID.publicKey)).toBeNull();
        await setCopyListsCommunities(ID.publicKey, true);
        expect(await communitiesForCopy(ID.publicKey)).toHaveLength(3);
    });

    it("the list is this phone's communities, the one it is on first, by the names the phone shows; none, no list", async () => {
        expect(await communitiesForCopy(ID.publicKey)).toBeNull();
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
        const result = await connect('google-sub-1', await communitiesForCopy(ID.publicKey));
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
        await connect('google-sub-1', await communitiesForCopy(ID.publicKey));
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

    it('a copy without a list saves nothing and never throws', async () => {
        for (const none of [null, undefined, []]) expect(await saveCommunitiesFromCopy(none)).toBe(0);
        expect(await getSavedNodes()).toEqual([]);
        expect(await saveCommunitiesFromCopy([null as any, { url: 7 } as any])).toBe(0);
    });
});
