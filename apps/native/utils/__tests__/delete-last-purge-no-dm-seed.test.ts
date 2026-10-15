/**
 * #1872 (§3.4 amendment 6 §5): Sign Out keeps the leaving account's DM pins (seeded from each community file before it
 * goes), and the self-delete purge at the member's last community keeps nothing: the account is deleted, so the DM memory
 * goes with it. Main's #1931 moved that wipe into delete-here.ts wipeAtLast (after the vault's copies go); the merge must
 * carry #1872's { purge: true } there, and every other test stays green without it (#1938 confirmation 7, finding 4).
 * Each of the three ways the last delete reaches the wipe is asked here; plain Sign Out is the control that the spies see a seed.
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
vi.mock('../db', () => ({
    clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}), initDB: vi.fn(async () => {}),
    seedDmPinsHere: vi.fn(async () => {}), seedDmPinsBeforeLeaving: vi.fn(async () => {}),
}));
// The copies' removal runs its beforeRemoving hook, as community-cache.ts does before it deletes each file.
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async (_c: unknown, opts?: { beforeRemoving?: (copies: string[]) => Promise<void> }) => { await opts?.beforeRemoving?.(['community_bellingen.db']); }) }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: vi.fn() }));

import type { SealedShare } from '@beanpool/core';
import { clearDB, seedDmPinsBeforeLeaving, seedDmPinsHere } from '../db';
import { signOutOfThisPhone } from '../account-leaves-phone';
import {
    deleteAccountHere, finishLastDelete, lastCommunityLine, planDelete, vaultCopyStaysLine, type DeleteOutcome,
} from '../delete-here';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { SAVED_NODES_STORE_KEY, vaultCopyKnownStoreKey } from '../storage-keys';
import { FakeVault, OTHER_KEY, VAULT, noVault, useVault, type SentRequest } from './fake-vault';
import { boundSignatureValid } from './server-signature-check';

const MULLUM = 'https://mullum.beanpool.org';
const BELLINGEN = 'https://bellingen.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
/** What a copy holds doesn't matter to a delete. */
const SOME_COPY = { sealed: 'not opened here' } as unknown as SealedShare;

interface Net {
    vault: FakeVault;
    sent: SentRequest[];
    /** The key on the phone as each vault request went out. */
    keyAtVault: (string | null)[];
}

/** Bellingen answers the membership probe with `bellingen`; Mullum deletes; the vault is the fake. */
function network(bellingen: 'member' | 'stranger'): Net {
    const net: Net = { vault: new FakeVault(), sent: [], keyAtVault: [] };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const u = new URL(url);
        const raw = typeof init?.body === 'string' ? init.body : '';
        const req: SentRequest = {
            url, origin: u.origin, path: u.pathname, method: String(init?.method ?? 'GET').toUpperCase(),
            headers: { ...((init?.headers ?? {}) as Record<string, string>) }, raw, body: raw ? JSON.parse(raw) : undefined,
        };
        net.sent.push(req);
        if (u.origin === VAULT) {
            net.keyAtVault.push((await loadIdentity())?.publicKey ?? null);
            if (net.vault.unreachable) throw new TypeError('Network request failed');
            const r = net.vault.answer(req);
            return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
        }
        if (u.origin === BELLINGEN && req.method === 'GET' && u.pathname.startsWith('/api/community/membership/')) {
            return new Response(JSON.stringify(bellingen === 'member'
                ? { isMember: true, callsign: 'Kim' }
                : { isMember: false, callsign: null, isRecovering: false, recoveryStatus: null }), { status: 200 });
        }
        if (u.origin === MULLUM && req.method === 'POST' && u.pathname === '/api/member/purge') {
            if (purgeMode === "refuse") return new Response(JSON.stringify({ error: "Active escrow trades" }), { status: 409 });
            if (purgeMode === "ok-false") return new Response(JSON.stringify({ ok: false, error: "x" }), { status: 200 });
            if (purgeMode === "hang") return new Promise<Response>((_, rej) => { init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))); });
            return new Response(JSON.stringify({ ok: true, message: 'Account purged' }), { status: 200 });
        }
        throw new Error(`No request expected: ${req.method} ${url}`);
    });
    return net;
}

const disconnects = (net: Net) => net.sent.filter((s) => s.origin === VAULT && s.path === '/v1/copies/delete');
const fetchOrder = (net: Net, req: SentRequest) => vi.mocked(fetch).mock.invocationCallOrder[net.sent.indexOf(req)];

let kim: BeanPoolIdentity;
const purgeMode: "ok" | "refuse" | "ok-false" | "hang" = "ok";
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    useVault();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Nothing may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string'
            && (args[0].startsWith('Failed to migrate legacy identity') || args[0].startsWith('Failed to fully wipe native identity state'))) return;
        quietError(...args);
    });
    kim = await draftIdentity('Kim');
});

afterEach(() => {
    noVault();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Kim's phone: set to Mullum, with Bellingen saved too; the vault keeps Kim's Google and Apple copies, and Ali's. */
async function kimsPhone(net: Net) {
    await importIdentity(kim);
    mem.async.set(ANCHOR, MULLUM);
    mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM, alias: 'Mullum' }, { url: BELLINGEN, alias: 'Bellingen' }]));
    net.vault.keep('google', 'kim-google', kim.publicKey, SOME_COPY);
    net.vault.keep('apple', 'kim-apple', kim.publicKey, SOME_COPY);
    net.vault.keep('google', 'ali-google', OTHER_KEY, SOME_COPY);
    // Kim linked a sign-in on this phone, so it knows the vault keeps a copy (vault.ts noteVaultCopy).
    mem.async.set(vaultCopyKnownStoreKey(kim.publicKey), '1');
}


const seeds = () => vi.mocked(seedDmPinsHere).mock.calls.length + vi.mocked(seedDmPinsBeforeLeaving).mock.calls.length;

describe('the delete at the last community keeps no DM memory of the deleted account (#1872 purge, after main\'s #1931)', () => {
    it('control: plain Sign Out seeds the DM memory, the open file and every other one', async () => {
        const net = network('stranger');
        await kimsPhone(net);
        await signOutOfThisPhone(kim);
        expect(vi.mocked(seedDmPinsHere).mock.calls).toEqual([[kim.publicKey]]);
        expect(vi.mocked(seedDmPinsBeforeLeaving).mock.calls).toEqual([[kim.publicKey, ['community_bellingen.db']]]);
    });

    it('the vault removes the copies: wiped, and no seed', async () => {
        const net = network('stranger');
        await kimsPhone(net);
        const plan = await planDelete(kim.publicKey);
        expect(plan.kind).toBe('last');
        expect(await deleteAccountHere(kim, plan)).toEqual({ kind: 'wiped' });
        expect(vi.mocked(clearDB)).toHaveBeenCalled();
        expect(seeds()).toBe(0);
    });

    for (const choice of ['try-again', 'delete-anyway'] as const) {
        it(`the vault couldn't be reached, then ${choice}: wiped, and no seed`, async () => {
            const net = network('stranger');
            await kimsPhone(net);
            net.vault.unreachable = true;
            const plan = await planDelete(kim.publicKey);
            expect((await deleteAccountHere(kim, plan)).kind).toBe('vault-copy-stays');
            expect(seeds()).toBe(0);
            if (choice === 'try-again') net.vault.unreachable = false;
            expect(await finishLastDelete(kim, choice)).toEqual({ kind: 'wiped' });
            expect(vi.mocked(clearDB)).toHaveBeenCalled();
            expect(seeds()).toBe(0);
        });
    }

    it('a build with no vault: wiped, and no seed', async () => {
        noVault();
        const net = network('stranger');
        await kimsPhone(net);
        expect(await deleteAccountHere(kim, await planDelete(kim.publicKey))).toEqual({ kind: 'wiped' });
        expect(seeds()).toBe(0);
    });
});
