/**
 * What VR1 changes in the phone's vault and move-card modules, pinned on their own (vault rethink VR1; the screen's
 * module, utils/ways-back.ts, is ways-back.test.ts's). Each of these failed on main (28 Oct), as an assertion, not a
 * missing import:
 * - the vault's status was read as sign-in names only: no copy, no since (`readVaultStatus`);
 * - a Disconnect of everything left the phone believing the vault kept a copy (`disconnectFromVault('all')`);
 * - a remembered delete was sent again blindly, even after the member linked that sign-in at that community again;
 * - the move card offered to move a copy the member had asked to remove, while its delete hadn't landed.
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

import type { SealedShare } from '@beanpool/core';
import { draftIdentity, type BeanPoolIdentity } from '../identity';
import { vaultCopyKnownStoreKey, vaultMoveUnfinishedStoreKey } from '../storage-keys';
import { disconnectFromVault, readVaultStatus, vaultCopyKnowledge } from '../vault';
import { vaultMoveOffer } from '../vault-move';
import { FakeVault, VAULT, noVault, useVault, type SentRequest } from './fake-vault';

const MULLUM = 'https://mullum.beanpool.org';
const SOME_COPY = { sealed: 'not opened here' } as unknown as SealedShare;

let kim: BeanPoolIdentity;
let vault: FakeVault;
let sent: SentRequest[];
/** Mullum's copies of Kim's key, their generation, and whether its deletes fail (a 5xx). */
const mullum = { copies: new Set<string>(), generation: 4, deletesFail: false };

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    useVault();
    vault = new FakeVault();
    sent = [];
    mullum.copies = new Set(['google']);
    mullum.generation = 4;
    mullum.deletesFail = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const u = new URL(url);
        const raw = typeof init?.body === 'string' ? init.body : '';
        const req: SentRequest = {
            url, origin: u.origin, path: u.pathname, method: String(init?.method ?? 'GET').toUpperCase(),
            headers: { ...((init?.headers ?? {}) as Record<string, string>) }, raw, body: raw ? JSON.parse(raw) : undefined,
        };
        sent.push(req);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (u.origin === VAULT) {
            const r = vault.answer(req);
            return json(r.status, r.body);
        }
        if (u.origin === MULLUM && req.method === 'POST' && u.pathname === '/api/recovery/shares/status') {
            return json(200, { generation: mullum.generation, enrolledSso: [...mullum.copies] });
        }
        const del = /^\/api\/recovery\/shares\/sso\/([a-z]+)$/.exec(u.pathname);
        if (u.origin === MULLUM && req.method === 'DELETE' && del) {
            if (mullum.deletesFail) return json(503, { error: 'Try again later.' });
            if (!mullum.copies.delete(del[1])) return json(404, { error: 'not connected' });
            return json(200, { removed: del[1] });
        }
        throw new Error(`No request expected: ${req.method} ${url}`);
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    kim = await draftIdentity('Kim');
});

afterEach(() => {
    noVault();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const mullumDeletes = () => sent.filter((s) => s.origin === MULLUM && s.method === 'DELETE');

describe("the vault's status, read with since", () => {
    it('each copy, with since; a vault before VR1 dated from updatedDay; nothing malformed guessed', () => {
        expect(readVaultStatus({
            copies: [
                { provider: 'google', lastReleasedAt: 1_760_000_000_000, updatedDay: '2026-10-03', since: '2026-10-03' },
                { provider: 'apple', lastReleasedAt: null, updatedDay: '2026-10-20' },
                { provider: 'facebook', lastReleasedAt: 'yesterday', since: '2026-02-30' },
                { provider: 'github', since: '2026-10-01' },
                { provider: 'google', since: '2026-10-09' },
            ],
            holds: [],
        })).toEqual({
            providers: ['google', 'apple', 'facebook'],
            copies: [
                { provider: 'google', since: '2026-10-03', lastReleasedAt: 1_760_000_000_000 },
                { provider: 'apple', since: '2026-10-20', lastReleasedAt: null },
                // A day that isn't one, and a time that isn't a number: no date, never a guess.
                { provider: 'facebook', since: null, lastReleasedAt: null },
                // A second Google account's copy: the vault keeps one per sign-in account, and each is listed with its own
                // since, never folded into the first (PR #2570 review: folded, the screen hid it and its Remove deleted it).
                { provider: 'google', since: '2026-10-09', lastReleasedAt: null },
            ],
            holds: [],
        });
    });
});

describe('Remove everything at the vault: the phone learns there is none', () => {
    it("after the vault's signed delete of all, the phone's knowledge is 'none', not the deposit it last heard of", async () => {
        vault.keep('google', 'kim-google', kim.publicKey, SOME_COPY);
        mem.async.set(vaultCopyKnownStoreKey(kim.publicKey), '1');
        expect(await disconnectFromVault(kim, 'all')).toBe(1);
        expect(await vaultCopyKnowledge(kim.publicKey)).toBe('none');
    });

    it('a delete the vault does not sign leaves the knowledge as it was', async () => {
        vault.keep('google', 'kim-google', kim.publicKey, SOME_COPY);
        mem.async.set(vaultCopyKnownStoreKey(kim.publicKey), '1');
        vault.answers = 'forged';
        await expect(disconnectFromVault(kim, 'all')).rejects.toMatchObject({ code: 'unverified' });
        expect(await vaultCopyKnowledge(kim.publicKey)).toBe('kept');
    });
});

describe('a remembered delete of a community copy', () => {
    it("is not sent again once that community's copies changed (a newer copy), and is dropped", async () => {
        // Kim asked to remove Mullum's Google copy at generation 4; the delete didn't land. Since then Kim linked Google
        // at Mullum again from another device: generation 6.
        mem.async.set(vaultMoveUnfinishedStoreKey(kim.publicKey), JSON.stringify([{ url: MULLUM, provider: 'google', generation: 4 }]));
        mullum.generation = 6;
        await vaultMoveOffer(kim, null);
        expect(mullumDeletes()).toEqual([]);
        expect(mullum.copies.has('google')).toBe(true);
        expect(mem.async.get(vaultMoveUnfinishedStoreKey(kim.publicKey))).toBeUndefined();
    });

    it('is sent again while the generation is the one the member saw, and then forgotten', async () => {
        mem.async.set(vaultMoveUnfinishedStoreKey(kim.publicKey), JSON.stringify([{ url: MULLUM, provider: 'google', generation: 4 }]));
        await vaultMoveOffer(kim, null);
        expect(mullumDeletes()).toHaveLength(1);
        expect(mullum.copies.size).toBe(0);
        expect(mem.async.get(vaultMoveUnfinishedStoreKey(kim.publicKey))).toBeUndefined();
    });

    it("the move card's own (no generation) is sent again as it always was", async () => {
        mem.async.set(vaultMoveUnfinishedStoreKey(kim.publicKey), JSON.stringify([{ url: MULLUM, provider: 'google' }]));
        mullum.generation = 9;
        await vaultMoveOffer(kim, null);
        expect(mullumDeletes()).toHaveLength(1);
        expect(mem.async.get(vaultMoveUnfinishedStoreKey(kim.publicKey))).toBeUndefined();
    });
});

describe('the move card', () => {
    it('never offers to move a copy the member asked to remove, while its delete has not landed', async () => {
        mem.async.set(vaultMoveUnfinishedStoreKey(kim.publicKey), JSON.stringify([{ url: MULLUM, provider: 'google', generation: 4 }]));
        mullum.deletesFail = true;
        expect(await vaultMoveOffer(kim, MULLUM)).toBeNull();
        expect(JSON.parse(mem.async.get(vaultMoveUnfinishedStoreKey(kim.publicKey))!)).toEqual([{ url: MULLUM, provider: 'google', generation: 4 }]);
    });

    it('still offers to move a copy nobody asked to remove', async () => {
        expect(await vaultMoveOffer(kim, MULLUM)).toEqual({ kind: 'move', provider: 'google', communityUrl: MULLUM });
    });
});
