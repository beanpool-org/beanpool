/**
 * The pending join (design G11 §4.1): the key a browser join makes waits beside the identity, where the app's
 * identity gate never looks, until the node has said yes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearPendingJoin,
    clearUnsentPendingJoin,
    completePendingJoin,
    loadIdentity,
    loadPendingJoin,
    savePendingJoin,
    wipeIdentity,
    importIdentity,
    PENDING_JOIN_TTL_MS,
    type BeanPoolIdentity,
    type PendingJoin,
} from './identity';
import { memoryIndexedDB, type MemoryIndexedDB } from './memory-indexeddb';

const IDENTITY: BeanPoolIdentity = {
    publicKey: 'a'.repeat(64),
    privateKey: 'b'.repeat(96),
    callsign: 'Alice',
    createdAt: '2026-09-25T00:00:00.000Z',
    mnemonic: ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'],
};

function pending(overrides: Partial<PendingJoin> = {}): PendingJoin {
    const now = Date.now();
    return { identity: IDENTITY, provider: 'google', nonce: 'nonce-1', startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false, ...overrides };
}

let idb: MemoryIndexedDB;
beforeEach(() => {
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the pending join slot', () => {
    it('loadIdentity never returns a pending join: the app stays on the welcome page', async () => {
        await savePendingJoin(pending());
        expect(await loadIdentity()).toBeNull();
        expect((await loadPendingJoin())?.identity.publicKey).toBe(IDENTITY.publicKey);
    });

    it('lives in its own key, apart from the identity', async () => {
        await savePendingJoin(pending());
        expect(idb.peek('beanpool-identity', 'keys', 'sovereign-identity')).toBeUndefined();
        expect(idb.peek('beanpool-identity', 'keys', 'pending-join')).toBeTruthy();
    });

    it('is dropped once it has expired, and never returned', async () => {
        const p = pending();
        await savePendingJoin(p);
        expect(await loadPendingJoin(p.expiresAt - 1)).not.toBeNull();
        expect(await loadPendingJoin(p.expiresAt)).toBeNull();
        // Gone from storage, not just hidden.
        expect(idb.peek('beanpool-identity', 'keys', 'pending-join')).toBeUndefined();
        expect(await loadPendingJoin(p.startedAt)).toBeNull();
    });

    it('a pending join with no key in it is dropped', async () => {
        await savePendingJoin(pending({ identity: { ...IDENTITY, privateKey: '' } }));
        expect(await loadPendingJoin()).toBeNull();
    });

    it('wiping the identity clears the pending join too: it holds a key and 12 words', async () => {
        await importIdentity(IDENTITY);
        await savePendingJoin(pending());
        await wipeIdentity();
        expect(await loadIdentity()).toBeNull();
        expect(await loadPendingJoin()).toBeNull();
        expect(idb.peek('beanpool-identity', 'keys', 'pending-join')).toBeUndefined();
    });

    it('completing moves the identity across and removes the pending join in one go', async () => {
        await savePendingJoin(pending());
        await completePendingJoin({ ...IDENTITY, callsign: 'Alice2' });
        expect(await loadIdentity()).toMatchObject({ publicKey: IDENTITY.publicKey, callsign: 'Alice2', mnemonic: IDENTITY.mnemonic });
        expect(await loadPendingJoin()).toBeNull();
    });

    it('clearPendingJoin leaves the identity alone', async () => {
        await importIdentity(IDENTITY);
        await savePendingJoin(pending());
        await clearPendingJoin();
        expect(await loadPendingJoin()).toBeNull();
        expect((await loadIdentity())?.publicKey).toBe(IDENTITY.publicKey);
    });
});

describe('a sent pending join (a join with its key has gone to the node): only the node lets it go', () => {
    const OTHER: BeanPoolIdentity = { ...IDENTITY, publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(96), callsign: 'Bob' };

    it('is never dropped on its clock: it is returned whatever its age, and stays stored', async () => {
        const p = pending({ nonce: null, sentAt: Date.now() });
        await savePendingJoin(p);
        expect(await loadPendingJoin(p.expiresAt + 24 * 60 * 60_000)).toMatchObject({ sentAt: p.sentAt, identity: { publicKey: IDENTITY.publicKey } });
        expect(idb.peek('beanpool-identity', 'keys', 'pending-join')).toBeTruthy();
    });

    it('one with no key in it is still dropped: there is nothing in it to lose', async () => {
        await savePendingJoin(pending({ sentAt: Date.now(), identity: { ...IDENTITY, privateKey: '' } }));
        expect(await loadPendingJoin()).toBeNull();
    });

    it('another key never takes its place, and nothing changes; the same key may update it', async () => {
        const p = pending({ nonce: null, sentAt: Date.now() });
        await savePendingJoin(p);
        await expect(savePendingJoin(pending({ identity: OTHER, sentAt: undefined }))).rejects.toMatchObject({ name: 'PendingJoinHeldError' });
        expect((await loadPendingJoin())?.identity.publicKey).toBe(IDENTITY.publicKey);

        await savePendingJoin({ ...p, nonce: 'fresh' });
        expect(await loadPendingJoin()).toMatchObject({ nonce: 'fresh', sentAt: p.sentAt });
    });

    it('once cleared (after the node said the key is not a member), another key may take the slot', async () => {
        await savePendingJoin(pending({ sentAt: Date.now() }));
        await clearPendingJoin();
        await savePendingJoin(pending({ identity: OTHER }));
        expect((await loadPendingJoin())?.identity.publicKey).toBe(OTHER.publicKey);
    });

    it('an unsent one is replaced as before', async () => {
        await savePendingJoin(pending());
        await savePendingJoin(pending({ identity: OTHER }));
        expect((await loadPendingJoin())?.identity.publicKey).toBe(OTHER.publicKey);
    });

    it('clearUnsentPendingJoin clears one that never went out, and keeps one that did', async () => {
        await savePendingJoin(pending());
        await clearUnsentPendingJoin();
        expect(idb.peek('beanpool-identity', 'keys', 'pending-join')).toBeUndefined();

        await savePendingJoin(pending({ sentAt: Date.now() }));
        await clearUnsentPendingJoin();
        expect((await loadPendingJoin())?.identity.publicKey).toBe(IDENTITY.publicKey);

        // Nothing there: nothing to do.
        await clearPendingJoin();
        await clearUnsentPendingJoin();
        expect(await loadPendingJoin()).toBeNull();
    });
});

describe('a write the browser could not commit (a full disk aborts the transaction: `abort` fires, `error` never does)', () => {
    it('completing the join rejects rather than never answering, and the pending join is still there to finish from', async () => {
        await savePendingJoin(pending());
        idb.failNextCommit();
        await expect(completePendingJoin({ ...IDENTITY, callsign: 'Alice2' })).rejects.toMatchObject({ name: 'QuotaExceededError' });
        expect(await loadIdentity()).toBeNull();
        expect((await loadPendingJoin())?.identity.publicKey).toBe(IDENTITY.publicKey);
    }, 2000);

    it('saving, clearing, wiping and importing reject too', async () => {
        idb.failNextCommit();
        await expect(savePendingJoin(pending())).rejects.toMatchObject({ name: 'QuotaExceededError' });
        expect(await loadPendingJoin()).toBeNull();

        await savePendingJoin(pending());
        idb.failNextCommit();
        await expect(clearPendingJoin()).rejects.toMatchObject({ name: 'QuotaExceededError' });
        expect(await loadPendingJoin()).not.toBeNull();

        await importIdentity(IDENTITY);
        idb.failNextCommit();
        await expect(wipeIdentity()).rejects.toMatchObject({ name: 'QuotaExceededError' });
        expect((await loadIdentity())?.publicKey).toBe(IDENTITY.publicKey);

        idb.failNextCommit();
        await expect(importIdentity({ ...IDENTITY, callsign: 'Bob' })).rejects.toMatchObject({ name: 'QuotaExceededError' });
        expect((await loadIdentity())?.callsign).toBe('Alice');
    }, 2000);

    it('an abort that names no error still rejects', async () => {
        idb.failNextCommit(null);
        await expect(clearPendingJoin()).rejects.toBeInstanceOf(Error);
    }, 2000);
});
