/**
 * Delete account at the member's last community takes the key's copies at BeanPool's key vault with it (utils/delete-here.ts
 * `removeVaultCopies`), before the key leaves the phone.
 *
 * Measured on main (14 Oct): the delete withdrew only the vault push token, then wiped the key. The vault takes a
 * Disconnect signed by the key alone (apps/vault/README.md, `/v1/copies/delete`), so once the key was gone nobody could
 * remove the locked copy, and it stayed at the vault for good. Now, in a build with a vault, once the community deleted
 * the account and before anything on the phone is wiped, the phone signs and sends the Disconnect for every sign-in. If
 * the vault doesn't confirm it, nothing is wiped and the member is told so and chooses: try again, or delete anyway
 * (the copy stays). A delete at one community while another keeps the key sends no Disconnect.
 *
 * Nothing here contacts a node or the vault: fetch is a stub that sends the vault's requests to the in-process fake
 * (fake-vault.ts) and answers the communities itself.
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
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: vi.fn() }));

import type { SealedShare } from '@beanpool/core';
import { clearDB } from '../db';
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
let purgeMode: "ok" | "refuse" | "ok-false" | "hang" = "ok";
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

describe("Delete account at Kim's last community, in a build with BeanPool's key vault", () => {
    it('the phone signs and sends the Disconnect for every sign-in before the wipe, and the vault keeps nothing of Kim', async () => {
        const net = network('stranger');
        await kimsPhone(net);
        const plan = await planDelete(kim.publicKey);
        expect(plan.kind).toBe('last');

        expect(await deleteAccountHere(kim, plan)).toEqual({ kind: 'wiped' });

        // On main the vault still kept both copies after the delete: nothing could ever remove them.
        expect(net.vault.copiesOf(kim.publicKey)).toEqual([]);
        expect(net.vault.copiesOf(OTHER_KEY)).toHaveLength(1);
        const [sent] = disconnects(net);
        expect(disconnects(net)).toHaveLength(1);
        expect(sent.body).toMatchObject({ all: true });
        // Signed by Kim's own key, for the vault's host (the fake refuses any other signature).
        expect(sent.headers['X-Public-Key']).toBe(kim.publicKey);
        expect(boundSignatureValid({ url: sent.url, method: sent.method, headers: sent.headers, body: sent.raw }, kim.publicKey)).toBe(true);
        // After the community deleted the account, while the key was still on the phone, and before the wipe began.
        const purge = net.sent.find((s) => s.path === '/api/member/purge')!;
        expect(fetchOrder(net, sent)).toBeGreaterThan(fetchOrder(net, purge));
        expect(net.keyAtVault[net.sent.filter((s) => s.origin === VAULT).indexOf(sent)]).toBe(kim.publicKey);
        expect(fetchOrder(net, sent)).toBeLessThan(vi.mocked(clearDB).mock.invocationCallOrder[0]);
        expect(await loadIdentity()).toBeNull();
    });

    it('a vault that keeps no copy for Kim answers "none deleted", and the delete goes on as before', async () => {
        const net = network('stranger');
        await kimsPhone(net);
        net.vault.copies.clear();
        mem.async.delete(vaultCopyKnownStoreKey(kim.publicKey));

        expect(await deleteAccountHere(kim, await planDelete(kim.publicKey))).toEqual({ kind: 'wiped' });

        expect(disconnects(net)).toHaveLength(1);
        expect(await loadIdentity()).toBeNull();
    });

    // [what, how, the reason Kim reads, the copies the vault still keeps]. A server at the vault's address whose answer
    // the phone can't check may have deleted them or not: the phone can't tell, so it counts as not done.
    const failures: [string, (v: FakeVault) => void, RegExp, number][] = [
        ['does not answer', (v) => { v.unreachable = true; }, /it didn't answer: check your connection/, 2],
        ['is locked', (v) => { v.locked = true; }, /the vault is paused for a little while/, 2],
        ["answers in a way the phone can't check", (v) => { v.answers = 'forged'; }, /its answer didn't check out/, 0],
    ];
    for (const [what, breakIt, reason, left] of failures) {
        it(`a vault that ${what}: nothing on the phone is wiped, and Kim is told plainly and chooses`, async () => {
            const net = network('stranger');
            await kimsPhone(net);
            breakIt(net.vault);
            const plan = await planDelete(kim.publicKey);

            const outcome = await deleteAccountHere(kim, plan);

            expect(outcome).toMatchObject({ kind: 'vault-copy-stays', copyKnown: true });
            expect((outcome as { reason: string }).reason).toMatch(reason);
            // Never shown as done: the key is still on the phone, so it can still sign the Disconnect.
            expect((await loadIdentity())?.publicKey).toBe(kim.publicKey);
            expect(clearDB).not.toHaveBeenCalled();
            expect(net.vault.copiesOf(kim.publicKey)).toHaveLength(left);
        });
    }

    it('"Try again" asks the vault again, and wipes the phone only once the vault removed the copies', async () => {
        const net = network('stranger');
        await kimsPhone(net);
        net.vault.unreachable = true;
        const plan = await planDelete(kim.publicKey);
        expect((await deleteAccountHere(kim, plan)).kind).toBe('vault-copy-stays');

        // Still down: the same choice again, and still nothing wiped.
        expect((await finishLastDelete(kim, 'try-again')).kind).toBe('vault-copy-stays');
        expect((await loadIdentity())?.publicKey).toBe(kim.publicKey);
        expect(clearDB).not.toHaveBeenCalled();

        net.vault.unreachable = false;
        expect(await finishLastDelete(kim, 'try-again')).toEqual({ kind: 'wiped' });

        expect(net.vault.copiesOf(kim.publicKey)).toEqual([]);
        expect(disconnects(net)).toHaveLength(3);
        expect(await loadIdentity()).toBeNull();
        // The community is asked once: the account there was deleted the first time.
        expect(net.sent.filter((s) => s.path === '/api/member/purge')).toHaveLength(1);
    });

    it('"Delete anyway" wipes the phone and sends no Disconnect: the vault copy stays, as Kim was told', async () => {
        const net = network('stranger');
        await kimsPhone(net);
        net.vault.unreachable = true;
        const plan = await planDelete(kim.publicKey);
        const outcome = await deleteAccountHere(kim, plan);
        expect(outcome.kind).toBe('vault-copy-stays');
        net.vault.unreachable = false;

        expect(await finishLastDelete(kim, 'delete-anyway')).toEqual({ kind: 'wiped' });

        expect(disconnects(net)).toHaveLength(1);
        expect(net.vault.copiesOf(kim.publicKey)).toHaveLength(2);
        expect(await loadIdentity()).toBeNull();
    });

    it('the choice says what happened, what stays, and that only the key can remove the copy', () => {
        const stays = (copyKnown: boolean) =>
            ({ kind: 'vault-copy-stays', reason: "it didn't answer: check your connection", copyKnown }) as Extract<DeleteOutcome, { kind: 'vault-copy-stays' }>;
        expect(vaultCopyStaysLine('Mullum', stays(true))).toBe(
            "Your account at Mullum was deleted, but BeanPool's key vault still keeps a locked copy of your key, from a " +
            "sign-in you linked: it couldn't be removed (it didn't answer: check your connection). Only your key can " +
            'remove it, and your key is still on this phone, so you can try again.\n\n' +
            'Delete Anyway takes your key off this phone and leaves that copy at the vault, locked to your sign-in. To ' +
            'remove it later, you would need your key back (with your 12 words or that sign-in) and a community that has ' +
            'you, to reach Settings → Account Protection → Disconnect.');
        expect(vaultCopyStaysLine('Mullum', stays(false))).toMatch(
            /^Your account at Mullum was deleted, but BeanPool's key vault may keep a locked copy of your key, if you linked Google, Apple or Facebook: it couldn't be removed/);
    });

    it('the confirmation says the vault copy goes first', () => {
        expect(lastCommunityLine({ kind: 'last', here: MULLUM, hereName: 'Mullum' }, true)).toMatch(
            / If BeanPool's key vault keeps a locked copy of your key, from a sign-in you linked, it is removed first\.$/);
    });
});

describe('a delete that leaves the key on the phone, or a build without a vault, sends no Disconnect', () => {
    it('Bellingen still has Kim: Mullum leaves the phone, the key stays, and the vault copies stay', async () => {
        const net = network('member');
        await kimsPhone(net);
        const plan = await planDelete(kim.publicKey);
        expect(plan.kind).toBe('this-one');

        expect(await deleteAccountHere(kim, plan)).toEqual({ kind: 'left' });

        expect(net.sent.filter((s) => s.origin === VAULT)).toEqual([]);
        expect(net.vault.copiesOf(kim.publicKey)).toHaveLength(2);
        expect((await loadIdentity())?.publicKey).toBe(kim.publicKey);
    });

    it('no vault in this build: the community keeps the sign-in copies and its delete took them; nothing goes to a vault', async () => {
        noVault();
        const net = network('stranger');
        await kimsPhone(net);

        expect(await deleteAccountHere(kim, await planDelete(kim.publicKey))).toEqual({ kind: 'wiped' });

        expect(net.sent.filter((s) => s.origin === VAULT)).toEqual([]);
        expect(lastCommunityLine({ kind: 'last', here: MULLUM, hereName: 'Mullum' }, true)).not.toContain('key vault');
    });
});

describe("a purge the community refuses (refused, ok:false, no answer) sends no Disconnect and keeps the key and the copies", () => {
    for (const mode of ["refuse", "ok-false", "hang"] as const) {
        it(mode + ": no vault request, key and copies stay", async () => {
            purgeMode = mode;
            try {
                const net = network("stranger");
                await kimsPhone(net);
                const plan = await planDelete(kim.publicKey);
                expect(plan.kind).toBe("last");
                const out = await deleteAccountHere(kim, plan, 200);
                expect(out.kind).toBe("not-deleted");
                expect(net.sent.filter((x) => x.origin === VAULT)).toEqual([]);
                expect(net.vault.copiesOf(kim.publicKey)).toHaveLength(2);
                expect((await loadIdentity())?.publicKey).toBe(kim.publicKey);
                expect(clearDB).not.toHaveBeenCalled();
            } finally { purgeMode = "ok"; }
        });
    }
});
