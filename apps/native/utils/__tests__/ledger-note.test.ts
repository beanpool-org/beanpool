import { describe, it, expect, vi, beforeAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// The Ledger tab's lines, read from the phone's own cache (db.ts getTransactions, the phone's real schema in an in-memory
// SQLite) and given their note as the tab gives it (utils/ledger-note.ts): Beans from someone blocked on this phone show
// the neutral line in place of their note (Marty on the board, 2026-10-01: "Drop the note, keep the Beans").

const sql = new DatabaseSync(':memory:');
const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
/** getTransactions passes seven values for its five placeholders; node:sqlite refuses the extra ones, so bind what it takes. */
const taken = (q: string, p: unknown) => params(p).slice(0, (q.match(/\?/g) ?? []).length);
const adapter = {
    runAsync: vi.fn(async (q: string, p?: unknown) => {
        const r = sql.prepare(q).run(...params(p));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    }),
    execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
    getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...taken(q, p))),
    getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
    closeAsync: vi.fn(async () => {}),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
};
const store = new Map<string, string>();
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) store.delete(k); }),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: ME, privateKey: 'aa', callsign: 'Ann' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn(() => 'beanpool_none.db'),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { getDb, getTransactions } from '../db';
import { ledgerItemNote } from '../ledger-note';
import { BLOCKED_BEANS_NOTE } from '@beanpool/core';

const ME = 'a'.repeat(64);
const BO = 'b'.repeat(64);
const CY = 'c'.repeat(64);

/** The tab's lines: getTransactions, which tells the screens through `require('react-native')`, stood in for here. */
async function lines(): Promise<any[]> {
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: () => {} } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        return await getTransactions(ME);
    } finally {
        (Module as any)._load = nodeLoad;
    }
}

beforeAll(async () => {
    await getDb();
    const put = (id: string, from: string, to: string, memo: string, at: string) =>
        sql.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, ?, 3, 0, ?, ?)').run(id, from, to, memo, at);
    put('from-bo', BO, ME, 'meet me behind the shed', '2026-10-01T10:00:00.000Z');
    put('from-cy', CY, ME, 'thanks for the eggs', '2026-10-01T09:00:00.000Z');
    put('to-bo', ME, BO, 'for the bread', '2026-10-01T08:00:00.000Z');
    put('kept', BO, ME, BLOCKED_BEANS_NOTE, '2026-10-01T07:00:00.000Z');
});

describe('the Ledger tab, with Bo blocked on this phone', () => {
    const blocked = new Set([BO]);

    it('each line carries the other account, so the tab can tell who sent the Beans', async () => {
        const byId = Object.fromEntries((await lines()).map(l => [l.id, l]));
        expect(byId['from-bo']).toMatchObject({ type: 'credit', peerPubkey: BO });
        expect(byId['to-bo']).toMatchObject({ type: 'debit', peerPubkey: BO });
    });

    it("Bo's Beans show the neutral line, muted, and never his note", async () => {
        const fromBo = (await lines()).find(l => l.id === 'from-bo');
        expect(ledgerItemNote(fromBo, blocked)).toEqual({ text: BLOCKED_BEANS_NOTE, fromBlocked: true });
    });

    it("Cy's Beans show his note, and Ann's own send to Bo shows hers", async () => {
        const byId = Object.fromEntries((await lines()).map(l => [l.id, l]));
        expect(ledgerItemNote(byId['from-cy'], blocked)).toEqual({ text: 'thanks for the eggs', fromBlocked: false });
        expect(ledgerItemNote(byId['to-bo'], blocked)).toEqual({ text: 'for the bread', fromBlocked: false });
    });

    it('a note the community kept from her (a block made in the web app) shows the same line, muted, with Bo not blocked here', async () => {
        const kept = (await lines()).find(l => l.id === 'kept');
        expect(ledgerItemNote(kept, new Set())).toEqual({ text: BLOCKED_BEANS_NOTE, fromBlocked: true });
    });

    it('with nobody blocked, every note shows', async () => {
        const fromBo = (await lines()).find(l => l.id === 'from-bo');
        expect(ledgerItemNote(fromBo, new Set())).toEqual({ text: 'meet me behind the shed', fromBlocked: false });
    });
});
