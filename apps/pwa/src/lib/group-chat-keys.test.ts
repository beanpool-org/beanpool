/**
 * The web's group-chat keyring (group-chat-keys.ts) against a node in memory (group-chat-fake-node.test-support.ts),
 * honest and dishonest: the phone's rules from #1788 and its three reviews, held on the web. The real node is driven by
 * e2e/group-chat-check.mjs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    groupKeyring, forgetGroupKeys, memoryGroupLockStore, GroupChatKeyError, GROUP_KEY_ROLLBACK_TEXT, GROUP_KEY_ROSTER_TEXT,
    GROUP_KEY_STORE_UNREAD_TEXT, type GroupLockStore,
} from './group-chat-keys';
import { makeEpochRecord } from './group-chat-crypto';
import { fakeGroupNode, person } from './group-chat-fake-node.test-support';

const G = '6f1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';

beforeEach(() => forgetGroupKeys());

/** A store whose reads fail until `heal()`: IndexedDB that won't open. */
function failingStore(): GroupLockStore & { heal(): void; loads: number } {
    const inner = memoryGroupLockStore();
    let broken = true;
    const s = {
        loads: 0,
        heal() { broken = false; },
        async load(k: string) { s.loads++; if (broken) throw new Error('IndexedDB would not open'); return inner.load(k); },
        raiseHighest: inner.raiseHighest,
        markLocked: inner.markLocked,
    };
    return s;
}

describe('group chat keys on the web', () => {
    it('the first sender starts epoch 1 for both members; the other opens the same key from its wrap (PKCS8 identity)', async () => {
        const ana = person(true);
        const ben = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const store = memoryGroupLockStore();
        const a = await groupKeyring(node.as(ana.publicKey), ana, G, store).prepareToSeal();
        expect(a.epoch).toBe(1);
        expect(node.epochs.get(1)?.reason).toBe('start');
        forgetGroupKeys();
        const b = await groupKeyring(node.as(ben.publicKey), ben, G, store).prepareToSeal();
        expect(b.epoch).toBe(1);
        expect(Buffer.from(b.key).toString('hex')).toBe(Buffer.from(a.key).toString('hex'));
        // Both remember the highest epoch and that the group is locked, per identity: nothing else, nothing secret.
        expect(store.rows.get(`${ana.publicKey}/${G}`)).toEqual({ highest: 1, locked: true });
        expect(store.rows.get(`${ben.publicKey}/${G}`)).toEqual({ highest: 1, locked: true });
    });

    it('a lock store that cannot be read fails closed, and is read again next time (never memoized as "never held")', async () => {
        const ana = person();
        const node = fakeGroupNode(G, [ana.publicKey]);
        const store = failingStore();
        const ring = groupKeyring(node.as(ana.publicKey), ana, G, store);
        expect(await ring.seenLocked()).toBe(true);
        await expect(ring.prepareToSeal()).rejects.toMatchObject({ code: 'store', message: GROUP_KEY_STORE_UNREAD_TEXT });
        expect(node.calls.filter((c) => c.method === 'POST')).toEqual([]);
        store.heal();
        expect(await ring.seenLocked()).toBe(false);
        expect((await ring.prepareToSeal()).epoch).toBe(1);
        expect(store.loads).toBeGreaterThanOrEqual(3);
    });

    it('a node serving an older current than this browser holds is refused, and so is one that lost its key tables', async () => {
        const ana = person();
        const ben = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const store = memoryGroupLockStore();
        await store.raiseHighest(`${ana.publicKey}/${G}`, 3);
        // The node holds epoch 1 only.
        node.epochs.set(1, (await makeEpochRecord({ myEdPrivHex: ben.privateKey, groupId: G, epoch: 1, reason: 'start', subject: null, createdAt: new Date().toISOString(), recipients: node.roster })).record);
        const ring = groupKeyring(node.as(ana.publicKey), ana, G, store);
        await expect(ring.prepareToSeal()).rejects.toMatchObject({ code: 'rollback', message: GROUP_KEY_ROLLBACK_TEXT });
        node.epochs.clear();
        forgetGroupKeys();
        await expect(groupKeyring(node.as(ana.publicKey), ana, G, store).prepareToSeal()).rejects.toMatchObject({ code: 'rollback' });
        expect(node.calls.filter((c) => c.method === 'POST')).toEqual([]);
    });

    it("never wraps a key to someone the members list doesn't show (finding 2): the keys roster naming Eve is refused", async () => {
        const ana = person();
        const ben = person();
        const eve = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        node.roster = [ana.publicKey, ben.publicKey, eve.publicKey].sort();
        const ring = groupKeyring(node.as(ana.publicKey), ana, G, memoryGroupLockStore());
        const err = await ring.prepareToSeal().catch((e) => e);
        expect(err).toBeInstanceOf(GroupChatKeyError);
        expect(err.message).toBe(GROUP_KEY_ROSTER_TEXT);
        expect(node.calls.some((c) => c.path.endsWith('/keys/epoch'))).toBe(false);
    });

    it("never seals under a current epoch already wrapped to Eve, whom the members list doesn't show", async () => {
        const ana = person();
        const ben = person();
        const eve = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        node.roster = [ana.publicKey, ben.publicKey, eve.publicKey].sort();
        node.epochs.set(1, (await makeEpochRecord({ myEdPrivHex: ben.privateKey, groupId: G, epoch: 1, reason: 'start', subject: null, createdAt: new Date().toISOString(), recipients: node.roster })).record);
        const err = await groupKeyring(node.as(ana.publicKey), ana, G, memoryGroupLockStore()).prepareToSeal().catch((e) => e);
        expect(err?.message).toBe(GROUP_KEY_ROSTER_TEXT);
    });

    it("a 409 naming Eve is never taken as the roster: the retry re-reads both and wraps to the shown members only", async () => {
        const ana = person();
        const eve = person();
        const node = fakeGroupNode(G, [ana.publicKey]);
        let lied = false;
        node.lie = (method, path) => {
            if (method === 'POST' && path.endsWith('/keys/epoch') && !lied) {
                lied = true;
                return new Response(JSON.stringify({ code: 'epoch_conflict', current: null, roster: [ana.publicKey, eve.publicKey] }), { status: 409 });
            }
            return undefined;
        };
        const sealed = await groupKeyring(node.as(ana.publicKey), ana, G, memoryGroupLockStore()).prepareToSeal();
        expect(sealed.epoch).toBe(1);
        expect(node.epochs.get(1)?.wraps?.map((w) => w.recipient)).toEqual([ana.publicKey]);
    });

    it("hands a key only to a shown member its epoch's record was wrapped to (finding 1; decision a)", async () => {
        const ana = person();
        const ben = person();
        const cat = person();
        const eve = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const ring = groupKeyring(node.as(ana.publicKey), ana, G, memoryGroupLockStore());
        await ring.prepareToSeal();
        // Cat joins later (her first epoch is 2), and the node lists her, and a stranger Eve, as missing epoch 1.
        node.roster = [ana.publicKey, ben.publicKey, cat.publicKey].sort();
        node.shown = [ana.publicKey, ben.publicKey, cat.publicKey];
        node.lie = (method, path) => (method === 'GET' && path.endsWith('/keys/missing')
            ? new Response(JSON.stringify({ epoch: 1, missing: [{ pubkey: eve.publicKey, fromEpoch: 1, epochs: [1] }, { pubkey: cat.publicKey, fromEpoch: 1, epochs: [1] }] }), { status: 200 })
            : undefined);
        expect(await ring.serveMissing()).toBe(0);
        expect(node.topUps).toEqual([]);
        // The honest repair: Ben, in epoch 1's record, has lost his wrap. Ana hands him the key.
        node.lie = (method, path) => (method === 'GET' && path.endsWith('/keys/missing')
            ? new Response(JSON.stringify({ epoch: 1, missing: [{ pubkey: ben.publicKey, fromEpoch: 1, epochs: [1] }] }), { status: 200 })
            : undefined);
        expect(await ring.serveMissing()).toBe(1);
        expect(node.topUps.map((t) => t.recipient)).toEqual([ben.publicKey]);
    });

    it("a record made by a key the screen doesn't show never raises the highest epoch (finding 6)", async () => {
        const ana = person();
        const eve = person();
        const node = fakeGroupNode(G, [ana.publicKey]);
        const store = memoryGroupLockStore();
        const ring = groupKeyring(node.as(ana.publicKey), ana, G, store);
        await ring.prepareToSeal();
        node.roster = [ana.publicKey, eve.publicKey].sort();
        const { record } = await makeEpochRecord({ myEdPrivHex: eve.privateKey, groupId: G, epoch: 9000, reason: 'rotate', subject: null, createdAt: new Date().toISOString(), recipients: node.roster });
        node.epochs.set(9000, record);
        await ring.sync([9000]);
        expect(await ring.highestEpoch()).toBe(1);
    });
});
