/**
 * The pending join (design G11 §4.1): the key a browser join makes waits beside the identity, where the app's
 * identity gate never looks, until the node has said yes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearUnsentPendingJoin,
    completePendingJoin,
    createIdentity,
    createIdentityFromMnemonic,
    loadIdentity,
    loadPendingJoin,
    markPendingJoinSent,
    releaseSentPendingJoin,
    savePendingJoin,
    updateCallsign,
    wipeIdentity,
    importIdentity,
    IdentityHeldError,
    SentJoinWaitingError,
    PENDING_JOIN_TTL_MS,
    type BeanPoolIdentity,
    type NodeRefusedJoin,
    type PendingJoin,
} from './identity';
import { generateMnemonic } from './mnemonic';
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

    it('clearUnsentPendingJoin leaves the identity alone', async () => {
        await importIdentity(IDENTITY);
        await savePendingJoin(pending());
        await clearUnsentPendingJoin();
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

    it('once released (the door refused its join, then the node said the key is not a member), another key may take the slot', async () => {
        const sentAt = Date.now();
        await savePendingJoin(pending({ sentAt }));
        const out = await releaseSentPendingJoin({
            kind: 'refused',
            refusal: { publicKey: IDENTITY.publicKey, sentAt, answeredAt: sentAt + 1, status: 409, code: 'already_joined' },
            notMember: { publicKey: IDENTITY.publicKey, askedAt: sentAt + 2 },
        });
        expect(out.released).toBe(true);
        await clearUnsentPendingJoin();
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
        await wipeIdentity();
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
        await expect(clearUnsentPendingJoin()).rejects.toMatchObject({ name: 'QuotaExceededError' });
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
        await expect(clearUnsentPendingJoin()).rejects.toBeInstanceOf(Error);
    }, 2000);
});

describe("a sent key's fate is decided in one place, on the stored record (PR #1154 review round 2)", () => {
    const OTHER: BeanPoolIdentity = { ...IDENTITY, publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(96), callsign: 'Bob' };
    const peek = () => idb.peek('beanpool-identity', 'keys', 'pending-join') as PendingJoin | undefined;
    const T = 1_800_000_000_000;
    const refusal = (overrides: Partial<NodeRefusedJoin> = {}): NodeRefusedJoin => ({
        publicKey: IDENTITY.publicKey, sentAt: T, answeredAt: T + 1_000, status: 403, code: 'removed' as const, ...overrides,
    });
    const notMember = (overrides: Partial<{ publicKey: string; askedAt: number }> = {}) => ({ publicKey: IDENTITY.publicKey, askedAt: T + 2_000, ...overrides });

    it('a copy without the mark (a second tab) never takes it off: the stored sentAt stays, whatever else the copy changes', async () => {
        await savePendingJoin(pending({ nonce: null, sentAt: T }));
        const saved = await savePendingJoin(pending({ nonce: 'from-tab-b', identity: { ...IDENTITY, callsign: 'Bea' } }));
        expect(saved).toMatchObject({ sentAt: T, nonce: 'from-tab-b' });
        expect(peek()).toMatchObject({ sentAt: T, nonce: 'from-tab-b', identity: { publicKey: IDENTITY.publicKey, callsign: 'Bea' } });
        // Nor does a copy carrying another sentAt move it: only markPendingJoinSent does.
        await savePendingJoin(pending({ sentAt: T + 5 }));
        expect(peek()?.sentAt).toBe(T);
    });

    it('marking a key sent again remembers the join before it, which may land too', async () => {
        await markPendingJoinSent(pending(), T);
        expect(peek()).toMatchObject({ sentAt: T });
        expect(peek()?.earlierSentAt).toBeUndefined();
        const again = await markPendingJoinSent(pending(), T + 60_000);
        expect(again).toMatchObject({ sentAt: T + 60_000, earlierSentAt: T });
        // From a tab whose copy is the sent one while the store lost its mark, the copy's time counts as earlier too.
        await wipeIdentity();
        await markPendingJoinSent(pending({ sentAt: T }), T + 120_000);
        expect(peek()).toMatchObject({ sentAt: T + 120_000, earlierSentAt: T });
    });

    it('marking sent is refused when another key has a sent join in the slot', async () => {
        await markPendingJoinSent(pending(), T);
        await expect(markPendingJoinSent(pending({ identity: OTHER }), T + 1)).rejects.toMatchObject({ name: 'PendingJoinHeldError', held: { identity: { publicKey: IDENTITY.publicKey } } });
        expect(peek()?.identity.publicKey).toBe(IDENTITY.publicKey);
    });

    it('released after a definite refusal of the latest join and the node then saying "not a member": unsent again, on its own clock', async () => {
        await markPendingJoinSent(pending(), T);
        const out = await releaseSentPendingJoin({ kind: 'refused', refusal: refusal(), notMember: notMember() });
        expect(out.released).toBe(true);
        expect(out.pending?.sentAt).toBeUndefined();
        expect(peek()?.sentAt).toBeUndefined();
        expect(peek()?.identity.publicKey).toBe(IDENTITY.publicKey);
    });

    it.each([
        ['a refusal about another key', { refusal: refusal({ publicKey: OTHER.publicKey }) }],
        ['a "not a member" about another key', { notMember: notMember({ publicKey: OTHER.publicKey }) }],
        ['a refusal of an older join than the latest (another tab sent it again since)', { refusal: refusal({ sentAt: T - 1 }) }],
        ['"not a member" asked before the refusal came back', { notMember: notMember({ askedAt: T + 500 }) }],
        ['an answer dated before its join went', { refusal: refusal({ answeredAt: T - 1 }), notMember: notMember({ askedAt: T }) }],
        ['a status the door does not give that code with', { refusal: refusal({ status: 400 }) }],
        ['a code the door never refuses with', { refusal: refusal({ code: 'join_failed' as never, status: 503 }) }],
        ['a code inherited by every object', { refusal: refusal({ code: 'toString' as never }) }],
        ['already_member, which is a yes', { refusal: refusal({ code: 'already_member' as never, status: 409 }) }],
    ])('never released on %s', async (_what, parts) => {
        await markPendingJoinSent(pending(), T);
        const out = await releaseSentPendingJoin({ kind: 'refused', refusal: refusal(), notMember: notMember(), ...parts } as Parameters<typeof releaseSentPendingJoin>[0]);
        expect(out.released).toBe(false);
        expect(peek()).toMatchObject({ identity: { publicKey: IDENTITY.publicKey }, sentAt: T });
    });

    it('a refusal settles nothing while an earlier join with the key can still land', async () => {
        await markPendingJoinSent(pending(), T);
        await markPendingJoinSent(pending(), T + 60_000);
        const later = { sentAt: T + 60_000, answeredAt: T + 61_000 };
        const early = await releaseSentPendingJoin({ kind: 'refused', refusal: refusal(later), notMember: notMember({ askedAt: T + 62_000 }) });
        expect(early.released).toBe(false);
        expect(peek()).toMatchObject({ sentAt: T + 60_000, earlierSentAt: T });
        const late = await releaseSentPendingJoin({ kind: 'refused', refusal: refusal(later), notMember: notMember({ askedAt: T + 11 * 60_000 }) });
        expect(late.released).toBe(true);
        expect(peek()?.sentAt).toBeUndefined();
        expect(peek()?.earlierSentAt).toBeUndefined();
    });

    it('a time that cannot be read is never judged unable to land', async () => {
        await savePendingJoin(pending({ sentAt: Number.NaN }));
        const out = await releaseSentPendingJoin({ kind: 'refused', refusal: refusal({ sentAt: Number.NaN }), notMember: notMember() });
        expect(out.released).toBe(false);
        expect(Number.isNaN(peek()?.sentAt)).toBe(true);
    });

    it('abandoned by the member: only the record they were shown goes', async () => {
        await markPendingJoinSent(pending(), T);
        // Another key, or the same key sent again since: nothing changes.
        expect((await releaseSentPendingJoin({ kind: 'abandoned', publicKey: OTHER.publicKey, sentAt: T })).released).toBe(false);
        expect((await releaseSentPendingJoin({ kind: 'abandoned', publicKey: IDENTITY.publicKey, sentAt: T - 1 })).released).toBe(false);
        expect(peek()?.sentAt).toBe(T);
        expect(await releaseSentPendingJoin({ kind: 'abandoned', publicKey: IDENTITY.publicKey, sentAt: T })).toEqual({ released: true, pending: null });
        expect(peek()).toBeUndefined();
    });

    it("clearUnsentPendingJoin decides on the stored record, never a tab's copy, and hands back the sent one it kept", async () => {
        await savePendingJoin(pending());
        // Another tab sends it: this tab still thinks it is unsent.
        await markPendingJoinSent(pending(), T);
        expect(await clearUnsentPendingJoin(IDENTITY.publicKey)).toMatchObject({ identity: { publicKey: IDENTITY.publicKey }, sentAt: T });
        expect(peek()?.sentAt).toBe(T);
        // Another key's pending join is not this caller's to clear.
        await wipeIdentity();
        await savePendingJoin(pending({ identity: OTHER }));
        expect(await clearUnsentPendingJoin(IDENTITY.publicKey)).toBeNull();
        expect(peek()?.identity.publicKey).toBe(OTHER.publicKey);
    });

    it("loadPendingJoin's clock decides on the stored record: a join another tab has just sent is not dropped", async () => {
        const p = pending();
        await savePendingJoin(p);
        await markPendingJoinSent(p, T);
        expect(await loadPendingJoin(p.expiresAt + 60 * 60_000)).toMatchObject({ sentAt: T });
        expect(peek()).toBeTruthy();
    });

    it("completing a join removes only the pending join holding that key", async () => {
        await markPendingJoinSent(pending({ identity: OTHER }), T);
        await completePendingJoin(IDENTITY);
        expect((await loadIdentity())?.publicKey).toBe(IDENTITY.publicKey);
        expect(peek()).toMatchObject({ identity: { publicKey: OTHER.publicKey }, sentAt: T });
    });
});

describe('one browser, one identity: nothing writes a different key over the one stored (review 4106962020)', () => {
    const OTHER: BeanPoolIdentity = { ...IDENTITY, publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(96), callsign: 'Bea' };
    const peek = () => idb.peek('beanpool-identity', 'keys', 'pending-join') as PendingJoin | undefined;
    const T = 1_800_000_000_000;

    it('completing a join for another key is refused: the stored identity stays, and so does that join, sent mark and all', async () => {
        await importIdentity(IDENTITY);
        await markPendingJoinSent(pending({ identity: OTHER }), T);
        const refused = await completePendingJoin(OTHER).then(() => null, (e: unknown) => e);
        expect(refused).toBeInstanceOf(IdentityHeldError);
        expect((refused as IdentityHeldError).held).toMatchObject({ publicKey: IDENTITY.publicKey, callsign: 'Alice' });
        expect(await loadIdentity()).toEqual(IDENTITY);
        expect(peek()).toMatchObject({ identity: { publicKey: OTHER.publicKey, mnemonic: OTHER.mnemonic }, sentAt: T });
    });

    it('making, restoring and importing another key are refused too, and change nothing', async () => {
        await importIdentity(IDENTITY);
        await expect(createIdentity('Rowan')).rejects.toBeInstanceOf(IdentityHeldError);
        await expect(createIdentityFromMnemonic(generateMnemonic(), '')).rejects.toBeInstanceOf(IdentityHeldError);
        await expect(importIdentity(OTHER)).rejects.toBeInstanceOf(IdentityHeldError);
        expect(await loadIdentity()).toEqual(IDENTITY);
    });

    it('the same key may be written again (a new name), and keeps the words stored with it when the new copy has none', async () => {
        await importIdentity(IDENTITY);
        await importIdentity({ ...IDENTITY, callsign: 'Alice2', mnemonic: undefined });
        expect(await loadIdentity()).toMatchObject({ publicKey: IDENTITY.publicKey, callsign: 'Alice2', mnemonic: IDENTITY.mnemonic });
        await savePendingJoin(pending());
        await completePendingJoin({ ...IDENTITY, callsign: 'Alice3' });
        expect(await loadIdentity()).toMatchObject({ publicKey: IDENTITY.publicKey, callsign: 'Alice3', mnemonic: IDENTITY.mnemonic });
        expect(peek()).toBeUndefined();
    });

    it('a name change renames the stored identity, and makes none where there is none', async () => {
        expect(await updateCallsign('Nobody')).toBeNull();
        expect(await loadIdentity()).toBeNull();
        await importIdentity(IDENTITY);
        expect(await updateCallsign('Alicia')).toMatchObject({ publicKey: IDENTITY.publicKey, callsign: 'Alicia', mnemonic: IDENTITY.mnemonic });
        expect(await loadIdentity()).toMatchObject({ callsign: 'Alicia' });
    });

    it('a refused write still answers when the disk is full, and a full disk still rejects', async () => {
        await importIdentity(IDENTITY);
        idb.failNextCommit();
        await expect(completePendingJoin(OTHER)).rejects.toMatchObject({ name: 'QuotaExceededError' });
        idb.failNextCommit();
        await expect(updateCallsign('Alicia')).rejects.toMatchObject({ name: 'QuotaExceededError' });
        expect(await loadIdentity()).toEqual(IDENTITY);
    }, 2000);
});

describe('a save told to wait for a sent join decides it in the transaction that writes (#1171 deciding pass)', () => {
    const OTHER: BeanPoolIdentity = { ...IDENTITY, publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(96), callsign: 'Bea' };
    const peek = () => idb.peek('beanpool-identity', 'keys', 'pending-join') as PendingJoin | undefined;
    const T = 1_800_000_000_000;
    const WAIT = { refuseWhileSentJoinWaits: { except: null } };

    it('refused while a join that went out from this browser is stored, whichever way the key comes, and nothing changes', async () => {
        await markPendingJoinSent(pending({ identity: OTHER }), T);
        for (const save of [
            () => importIdentity(IDENTITY, WAIT),
            () => createIdentityFromMnemonic(generateMnemonic(), '', WAIT),
            () => createIdentity('Rowan', WAIT),
        ]) {
            const refused = await save().then(() => null, (e: unknown) => e);
            expect(refused).toBeInstanceOf(SentJoinWaitingError);
            expect((refused as SentJoinWaitingError).pending).toMatchObject({ identity: { publicKey: OTHER.publicKey }, sentAt: T });
        }
        expect(await loadIdentity()).toBeNull();
        expect(peek()).toMatchObject({ identity: { publicKey: OTHER.publicKey, mnemonic: OTHER.mnemonic }, sentAt: T });
    });

    it('goes ahead past a pending join never sent, and past the sent one the node settled; not once it is sent again', async () => {
        await savePendingJoin(pending({ identity: OTHER }));
        await importIdentity(IDENTITY, WAIT);
        expect((await loadIdentity())?.publicKey).toBe(IDENTITY.publicKey);

        await wipeIdentity();
        await markPendingJoinSent(pending({ identity: OTHER }), T);
        const settled = { refuseWhileSentJoinWaits: { except: { publicKey: OTHER.publicKey, sentAt: T } } };
        await markPendingJoinSent(pending({ identity: OTHER }), T + 1000); // another tab sends it again
        await expect(importIdentity(IDENTITY, settled)).rejects.toBeInstanceOf(SentJoinWaitingError);
        expect(await loadIdentity()).toBeNull();
        await importIdentity(IDENTITY, { refuseWhileSentJoinWaits: { except: { publicKey: OTHER.publicKey, sentAt: T + 1000 } } });
        expect((await loadIdentity())?.publicKey).toBe(IDENTITY.publicKey);
        expect(peek()).toMatchObject({ identity: { publicKey: OTHER.publicKey }, sentAt: T + 1000 });
    });

    it("the two-tab gap: a check read in its own transaction is stale once another tab marks a join sent; the save's own check refuses", async () => {
        // This tab reads the slot on its own first (as the welcome page did), and finds no sent join...
        expect(await loadPendingJoin()).toBeNull();
        // ...another tab sends one...
        await markPendingJoinSent(pending({ identity: OTHER }), T);
        // ...and the save, deciding again on what is stored as it writes, is refused.
        await expect(importIdentity(IDENTITY, WAIT)).rejects.toBeInstanceOf(SentJoinWaitingError);
        expect(await loadIdentity()).toBeNull();
        expect(peek()).toMatchObject({ identity: { publicKey: OTHER.publicKey }, sentAt: T });
    });

    it('with a sent join waiting and another account here, the sent join is named first, as the page settles it first', async () => {
        await importIdentity(OTHER);
        await markPendingJoinSent(pending({ identity: { ...OTHER, publicKey: 'e'.repeat(64) } }), T);
        await expect(importIdentity(IDENTITY, WAIT)).rejects.toBeInstanceOf(SentJoinWaitingError);
        await expect(importIdentity(IDENTITY)).rejects.toBeInstanceOf(IdentityHeldError);
    });
});

describe('a write that throws before it commits (review 4108355843)', () => {
    /** Errors that escaped to the window, as an uncaught throw in an IndexedDB callback does. */
    function watchEscapes() {
        const escaped: unknown[] = [];
        const onError = (e: ErrorEvent) => { escaped.push(e.error); e.preventDefault(); };
        window.addEventListener('error', onError);
        return { escaped, stop: () => window.removeEventListener('error', onError) };
    }

    it('a decision that throws: the caller gets that error, not an abort, nothing is written, and nothing escapes', async () => {
        await importIdentity(IDENTITY);
        const watch = watchEscapes();
        try {
            // No identity to compare with: the decision itself throws.
            const refused = await importIdentity(null as unknown as BeanPoolIdentity).then(() => null, (e: unknown) => e);
            expect(refused).toBeInstanceOf(TypeError);
            expect(await loadIdentity()).toEqual(IDENTITY);
            expect(watch.escaped).toEqual([]);
        } finally {
            watch.stop();
        }
    });

    it("a value the store can't take (DataCloneError from put): that error, nothing written, nothing escapes", async () => {
        const watch = watchEscapes();
        try {
            const unsaveable = { ...IDENTITY, sign: () => 'not cloneable' } as unknown as BeanPoolIdentity;
            await expect(importIdentity(unsaveable)).rejects.toMatchObject({ name: 'DataCloneError' });
            expect(await loadIdentity()).toBeNull();
            expect(watch.escaped).toEqual([]);
        } finally {
            watch.stop();
        }
    });
});
