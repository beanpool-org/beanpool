/**
 * The pending restore (G11-d): the throwaway key a sign-in restore signs with waits beside the identity while the page
 * is at the provider. It expires, it is never an identity by itself, and it changes nothing the pending join's rules
 * guard (a sent join's key above all).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearPendingRestore,
    clearUnsentPendingJoin,
    completePendingJoin,
    importIdentity,
    loadIdentity,
    loadPendingJoin,
    loadPendingRestore,
    markPendingJoinSent,
    savePendingJoin,
    savePendingRestore,
    takePendingRestore,
    wipeIdentity,
    PENDING_JOIN_TTL_MS,
    PENDING_RESTORE_TTL_MS,
    type BeanPoolIdentity,
    type PendingJoin,
    type PendingRestore,
} from './identity';
import { memoryIndexedDB, type MemoryIndexedDB } from './memory-indexeddb';

const EPHEMERAL = { publicKey: 'e'.repeat(64), privateKey: 'f'.repeat(96) };
const ACCOUNT = { publicKey: 'a'.repeat(64), callsign: 'Alice' };

const JOINER: BeanPoolIdentity = {
    publicKey: '1'.repeat(64),
    privateKey: '2'.repeat(96),
    callsign: 'Bea',
    createdAt: '2026-09-26T00:00:00.000Z',
    mnemonic: ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'],
};

function restore(overrides: Partial<PendingRestore> = {}): PendingRestore {
    const now = Date.now();
    return {
        kind: 'restore', ephemeral: EPHEMERAL, account: ACCOUNT, collectionId: 'col-1', provider: 'google', nonce: 'nonce-r',
        startedAt: now, expiresAt: now + PENDING_RESTORE_TTL_MS, ...overrides,
    };
}

function join(overrides: Partial<PendingJoin> = {}): PendingJoin {
    const now = Date.now();
    return { identity: JOINER, provider: 'google', nonce: 'nonce-j', startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false, ...overrides };
}

let idb: MemoryIndexedDB;
const peek = (key: string) => idb.peek('beanpool-identity', 'keys', key);
beforeEach(() => {
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the pending restore', () => {
    it('lives in its own key, and is never an identity or a join', async () => {
        await savePendingRestore(restore());
        expect(peek('pending-restore')).toMatchObject({ kind: 'restore', nonce: 'nonce-r' });
        expect(peek('sovereign-identity')).toBeUndefined();
        expect(peek('pending-join')).toBeUndefined();
        expect(await loadIdentity()).toBeNull();
        expect(await loadPendingJoin()).toBeNull();
        expect((await loadPendingRestore())?.ephemeral.publicKey).toBe(EPHEMERAL.publicKey);
    });

    it('expires: past its time it is dropped on sight, gone from the store, and never taken', async () => {
        const r = restore();
        await savePendingRestore(r);
        expect(await loadPendingRestore(r.expiresAt - 1)).not.toBeNull();
        expect(await loadPendingRestore(r.expiresAt)).toBeNull();
        expect(peek('pending-restore')).toBeUndefined();

        await savePendingRestore(r);
        expect(await takePendingRestore('nonce-r', r.expiresAt)).toBeNull();
        expect(peek('pending-restore')).toBeUndefined();
        expect(await loadIdentity()).toBeNull();
    });

    it('lives as long as the node\'s sign-in nonce', () => {
        expect(PENDING_RESTORE_TTL_MS).toBe(10 * 60 * 1000);
    });

    it('is taken once, by the return whose state is its nonce; another return leaves it', async () => {
        await savePendingRestore(restore());
        expect(await takePendingRestore('someone-elses')).toBeNull();
        expect(await takePendingRestore('')).toBeNull();
        expect(peek('pending-restore')).toBeTruthy();
        expect((await takePendingRestore('nonce-r'))?.collectionId).toBe('col-1');
        expect(peek('pending-restore')).toBeUndefined();
        expect(await takePendingRestore('nonce-r')).toBeNull();
    });

    it('anything in its slot that is not a whole restore is dropped rather than read', async () => {
        await savePendingRestore({ ...restore(), ephemeral: { publicKey: EPHEMERAL.publicKey, privateKey: '' } });
        expect(await loadPendingRestore()).toBeNull();
        expect(peek('pending-restore')).toBeUndefined();
        await savePendingRestore({ ...restore(), kind: 'join' as 'restore' });
        expect(await loadPendingRestore()).toBeNull();
    });

    it('never becomes the identity: completing a join or importing an account leaves it a restore, and it holds no account key', async () => {
        await savePendingRestore(restore());
        await savePendingJoin(join());
        await completePendingJoin(JOINER);
        expect((await loadIdentity())?.publicKey).toBe(JOINER.publicKey);
        expect(peek('pending-restore')).toMatchObject({ kind: 'restore' });
        const stored = peek('pending-restore') as PendingRestore;
        expect(JSON.stringify(stored)).not.toContain(JOINER.privateKey);
        expect(Object.keys(stored).sort()).toEqual(['account', 'collectionId', 'ephemeral', 'expiresAt', 'kind', 'nonce', 'provider', 'startedAt']);
        expect(Object.keys(stored.account).sort()).toEqual(['callsign', 'publicKey']);
    });

    it('wiping the device clears it too', async () => {
        await savePendingRestore(restore());
        await wipeIdentity();
        expect(peek('pending-restore')).toBeUndefined();
    });

    it('clearing it touches nothing else', async () => {
        await importIdentity(JOINER);
        await savePendingJoin(join({ identity: { ...JOINER, publicKey: '3'.repeat(64) } }));
        await savePendingRestore(restore());
        await clearPendingRestore();
        expect(peek('pending-restore')).toBeUndefined();
        expect(peek('pending-join')).toBeTruthy();
        expect((await loadIdentity())?.publicKey).toBe(JOINER.publicKey);
    });
});

describe('a sent join is never touched by a restore', () => {
    it('saving, taking and clearing a restore leave a sent join exactly as stored', async () => {
        const sent = await markPendingJoinSent(join(), 1_000);
        await savePendingRestore(restore());
        await takePendingRestore('nonce-r');
        await savePendingRestore(restore({ nonce: 'nonce-2' }));
        await clearPendingRestore();
        expect(peek('pending-join')).toEqual(sent);
        expect(await clearUnsentPendingJoin()).toEqual(sent);
    });

    it("the join's own writes leave a restore where it is", async () => {
        await savePendingRestore(restore());
        await savePendingJoin(join());
        await markPendingJoinSent(join());
        await clearUnsentPendingJoin();
        expect((await loadPendingRestore())?.nonce).toBe('nonce-r');
    });
});
