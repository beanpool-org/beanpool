/**
 * Nothing of an account that has left is written back to the lock store (#3362's review, W1). Every way the keyring
 * writes (lib/group-chat-keys.ts GroupKeyring put: a locked answer's mark, the mark put again, the highest epoch raised
 * by a sync, a send, a key made, and a key opened from a maker the screen doesn't show), against every way the account
 * can leave while an answer is on its way: a Sign Out in this tab, one in another tab this page has heard, and one it
 * hasn't heard yet. A Force Clear keeps the account, so the rows still go in; so does a ring made after signing in again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { groupKeyring, forgetGroupKeys, memoryGroupLockStore, type GroupKeyring, type GroupKeysTransport, type GroupLockState } from './group-chat-keys';
import { makeEpochRecord } from './group-chat-crypto';
import { fakeGroupNode, person, type FakeGroupNode } from './group-chat-fake-node.test-support';
import { beginAccountEpoch, endAccountEpoch, resetAccountEpochForTest } from './account-epoch';
import { epochEndsInAnotherTab } from './another-tab';

const G = '9a1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const ana = person(true);
const ben = person();
const KEY = `${ana.publicKey}/${G}`;

beforeEach(() => {
    localStorage.clear();
    resetAccountEpochForTest();
    forgetGroupKeys();
});
afterEach(() => { localStorage.clear(); resetAccountEpochForTest(); });

/** Run as each request's answer comes back from the node, before the keyring takes it in. */
let onAnswer: ((method: string, path: string) => void) | null = null;
function net(node: FakeGroupNode): GroupKeysTransport {
    const inner = node.as(ana.publicKey);
    return {
        get: async (p) => { const r = await inner.get(p); onAnswer?.('GET', p); return r; },
        post: async (p, b) => { const r = await inner.post(p, b); onAnswer?.('POST', p); return r; },
    };
}

/** The group's first epoch, made by Ben for both members. */
async function epochByBen(node: FakeGroupNode): Promise<void> {
    const { record } = await makeEpochRecord({ myEdPrivHex: ben.privateKey, groupId: G, epoch: 1, reason: 'start', subject: null, createdAt: new Date().toISOString(), recipients: node.roster });
    node.epochs.set(1, record);
}

interface Write {
    name: string;
    /** Before the account leaves. */
    arrange: (ring: GroupKeyring, node: FakeGroupNode) => Promise<unknown>;
    /** The request whose answer is on its way as the account leaves; none: it has left before `land` starts. */
    during?: (method: string, path: string) => boolean;
    land: (ring: GroupKeyring) => Promise<unknown>;
    /** The row put when the account is still here. */
    kept: GroupLockState;
}

const keysAnswer = (m: string, p: string) => m === 'GET' && p.includes('/keys');
const WRITES: Write[] = [
    { name: 'a locked chat answer (noteLocked)', arrange: async () => {}, land: (r) => r.noteLocked(), kept: { highest: 0, locked: true } },
    { name: 'the mark put again (keepMark)', arrange: (r) => r.noteLocked(), land: (r) => r.keepMark(), kept: { highest: 0, locked: true } },
    {
        name: 'the keys answer raises the highest (sync)', arrange: async (r, n) => { await epochByBen(n); r.noteShownRoster([ana.publicKey, ben.publicKey]); },
        during: keysAnswer, land: (r) => r.sync(), kept: { highest: 1, locked: true },
    },
    {
        name: 'a send under the current epoch (prepareToSeal)', arrange: async (r, n) => { await epochByBen(n); r.noteShownRoster([ana.publicKey, ben.publicKey]); },
        during: keysAnswer, land: (r) => r.prepareToSeal(), kept: { highest: 1, locked: true },
    },
    {
        name: 'the first key made (rotate, adopt)', arrange: async (r) => { r.noteShownRoster([ana.publicKey, ben.publicKey]); },
        during: (m, p) => m === 'POST' && p.endsWith('/keys/epoch'), land: (r) => r.prepareToSeal(), kept: { highest: 1, locked: true },
    },
    {
        // No members list read: Ben's record raises nothing, and the key that opens only marks.
        name: "a key opened from a maker the screen doesn't show (keyFor)", arrange: async (r, n) => { await epochByBen(n); await r.sync(); },
        land: (r) => r.keyFor(1), kept: { highest: 0, locked: true },
    },
];

interface Change {
    name: string;
    signsOut: boolean;
    happen: (store: ReturnType<typeof memoryGroupLockStore>) => void;
}

/** A Sign Out deletes the lock rows (lib/device-prefs.ts clearAccountStorage), after ending the epoch. */
const CHANGES: Change[] = [
    { name: 'nothing', signsOut: false, happen: () => {} },
    { name: 'a Force Clear in another tab (the account stays)', signsOut: false, happen: () => { epochEndsInAnotherTab('cleared'); } },
    { name: 'a Sign Out in this tab', signsOut: true, happen: (s) => { endAccountEpoch('signed-out'); s.rows.clear(); } },
    { name: 'a Sign Out in another tab, heard', signsOut: true, happen: (s) => { epochEndsInAnotherTab('signed-out'); s.rows.clear(); } },
    { name: "a Sign Out in another tab, not heard here yet", signsOut: true, happen: (s) => { epochEndsInAnotherTab('signed-out', { heard: false }); s.rows.clear(); } },
];

describe('a late answer after the account left writes nothing of it back', () => {
    let rows = 0;
    for (const w of WRITES) {
        for (const c of CHANGES) {
            rows += 1;
            it(`${w.name} | ${c.name} | ${c.signsOut ? 'no row' : 'the row kept'}`, async () => {
                const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
                const store = memoryGroupLockStore();
                const ring = groupKeyring(net(node), ana, G, store);
                await w.arrange(ring, node);
                let happened = false;
                const happen = () => { happened = true; c.happen(store); };
                onAnswer = w.during ? (m, p) => { if (!happened && w.during!(m, p)) happen(); } : null;
                if (!w.during) happen();
                try {
                    await w.land(ring).catch(() => null);
                } finally {
                    onAnswer = null;
                }
                expect(happened).toBe(true);
                if (c.signsOut) expect([...store.rows.entries()]).toEqual([]);
                else expect(store.rows.get(KEY)).toEqual(w.kept);
            });
        }
    }
    it('the rows are whole', () => expect(rows).toBe(30));

    it('a ring asked for after a Sign Out writes nothing until a sign-in without a reload, then writes again', async () => {
        const store = memoryGroupLockStore();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        endAccountEpoch('signed-out');
        await groupKeyring(net(node), ana, G, store).noteLocked();
        expect(store.rows.size).toBe(0);
        beginAccountEpoch();
        await groupKeyring(net(node), ana, G, store).noteLocked();
        expect(store.rows.get(KEY)).toEqual({ highest: 0, locked: true });
    });
});
