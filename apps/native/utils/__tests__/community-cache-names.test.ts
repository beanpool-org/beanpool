/**
 * One phone, several communities: each community's copy in a file of its own (multi-community review F1).
 *
 * The phone keeps one SQLite file per community (utils/nodes.ts getDatabaseFilenameForNode), and the same name keys its
 * sync cursors and identity epoch. The old name blotted every character but a letter or digit to `_`, so
 * `https://mullum.beanpool.org` and `https://mullum-beanpool.org` (a domain anyone can buy) opened ONE file: the second
 * community was shown the first's listings, members, conversations and balances, and overwrote them.
 *
 * And a phone that already has its files under the old names keeps everything when it updates (utils/cache-file-
 * migration.ts): the real database open (utils/db.ts getDb) runs here over real SQLite files on disk (node:sqlite, in a
 * directory of this test's own), copied the way a phone's are left when the app is stopped: the last writes still only
 * in the write-ahead log.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const h = vi.hoisted(() => ({
    dir: '',
    store: new Map<string, string>(),
    opened: [] as string[],
    failMoveOf: null as string | null,
    failSetPrefix: null as string | null,
}));

/** expo-sqlite over node:sqlite, opening files in this test's directory, as expo-sqlite opens them in its own. */
vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    return {
        get defaultDatabaseDirectory() { return `file://${h.dir}`; },
        openDatabaseAsync: vi.fn(async (name: string) => {
            h.opened.push(name);
            const sql = new Sqlite(join(h.dir, name));
            return {
                runAsync: async (q: string, p?: unknown) => {
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                execAsync: async (q: string) => { sql.exec(q); },
                getAllAsync: async (q: string, p?: unknown) => sql.prepare(q).all(...params(p)),
                getFirstAsync: async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null,
                withTransactionAsync: async (cb: () => Promise<void>) => { await cb(); },
                closeAsync: async () => { sql.close(); },
            };
        }),
    };
});
/** expo-file-system over the real files. */
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const local = (uri: string) => decodeURI(uri).replace(/^file:\/\//, '');
    return {
        cacheDirectory: 'file:///tmp/unused-cache/',
        getInfoAsync: vi.fn(async (uri: string) => ({ exists: nodeFs.existsSync(local(uri)) })),
        moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
            if (h.failMoveOf && local(from).endsWith(h.failMoveOf)) throw new Error('disk busy');
            nodeFs.renameSync(local(from), local(to));
        }),
        deleteAsync: vi.fn(async (uri: string) => { nodeFs.rmSync(local(uri), { force: true }); }),
        makeDirectoryAsync: vi.fn(async () => {}),
        writeAsStringAsync: vi.fn(async () => {}),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => h.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => {
            if (h.failSetPrefix && k.startsWith(h.failSetPrefix)) { h.failSetPrefix = null; throw new Error('storage full'); }
            h.store.set(k, String(v));
        }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) h.store.delete(k); }),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { getDatabaseFilenameForNode, legacyDatabaseFilenameForNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY, resetCommunityCachesRenamedForTests } from '../cache-file-migration';
import { closeDB, getDb } from '../db';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const LOOKALIKE = 'https://mullum-beanpool.org';
const BELLINGEN = 'https://bellingen.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const cursor = (dbName: string, id: string) => `pillar_sync_${dbName}_${id}`;

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-cache-names-'));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

let phoneN = 0;
beforeEach(async () => {
    await closeDB();
    resetCommunityCachesRenamedForTests();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.opened = [];
    h.failMoveOf = null;
    h.failSetPrefix = null;
});

const file = (name: string) => path.join(h.dir, name);

/**
 * A community copy as an old build left it on the phone: `rows` in a table the app never touches, in WAL mode, the
 * last of them only in the log (the app was stopped before SQLite folded it into the file). Written in a scratch
 * directory while still open, and copied from there as it stood, as a stopped app leaves it.
 */
function oldCopy(name: string, rows: string[]) {
    const scratch = fs.mkdtempSync(path.join(root, 'scratch-'));
    const db = new DatabaseSync(path.join(scratch, name));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE kept (v TEXT)');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const v of rows) db.prepare('INSERT INTO kept (v) VALUES (?)').run(v);
    for (const side of ['', '-wal']) {
        if (fs.existsSync(path.join(scratch, `${name}${side}`))) fs.copyFileSync(path.join(scratch, `${name}${side}`), file(`${name}${side}`));
    }
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
}

/** What a copy holds, read straight from its file (its log folded in as SQLite does on opening). */
function rowsOf(name: string): string[] {
    if (!fs.existsSync(file(name))) return [];
    const db = new DatabaseSync(file(name));
    try {
        const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'kept'").get();
        return has ? db.prepare('SELECT v FROM kept ORDER BY rowid').all().map((r: any) => r.v) : [];
    } finally {
        db.close();
    }
}

function phoneWith(anchor: string, saved: Array<{ url: string; lastConnected?: string }>) {
    h.store.set(ANCHOR, anchor);
    h.store.set(SAVED_NODES_STORE_KEY, JSON.stringify(saved));
    // A phone that has run a build since the trust-system sync (db.ts): that one-off reset of every cursor is behind it.
    h.store.set('bp_trust_sync_v3', 'true');
}

describe('every community gets a file of its own', () => {
    it('two hosts whose names collide today get different files (and different cursors)', () => {
        const pairs = [
            [MULLUM, LOOKALIKE],
            ['https://mullum.beanpool.org', 'https://mullum.beanpool-org'],
            ['https://a.org:8443', 'https://a.org.8443'],
            ['http://10.0.0.1:8080', 'http://10.0.0.1.8080'],
            // The two old Beanpool addresses that shared the no-community file on purpose.
            ['https://review.beanpool.org:8443', 'https://beanpool.org:8443'],
        ];
        for (const [a, b] of pairs) {
            expect(legacyDatabaseFilenameForNode(a), `${a} / ${b} collided before`).toBe(legacyDatabaseFilenameForNode(b));
            expect(getDatabaseFilenameForNode(a), `${a} / ${b}`).not.toBe(getDatabaseFilenameForNode(b));
        }
        expect(getDatabaseFilenameForNode('https://review.beanpool.org:8443')).not.toBe(getDatabaseFilenameForNode(null));
    });

    it('one community is one file however its address is spelled; any domain, address or port', () => {
        const same = [MULLUM, 'https://Mullum.BeanPool.org', `${MULLUM}/`, `${MULLUM}:443`, 'HTTPS://mullum.beanpool.org//'];
        for (const url of same) expect(getDatabaseFilenameForNode(url), url).toBe(getDatabaseFilenameForNode(MULLUM));
        const different = [
            'http://mullum.beanpool.org', 'https://mullum.beanpool.org:8443', 'https://beans.mycommunity.nz', 'http://192.168.1.10:8080',
            'http://[::1]:8080', 'https://[fe80::1]', 'http://localhost:8080', 'https://mullum.beanpool.org.evil.example',
        ];
        const names = new Set([MULLUM, ...different].map(getDatabaseFilenameForNode));
        expect(names.size).toBe(different.length + 1);
    });

    it('a name the phone can open: letters, digits, dots, dashes and underscores, short however long the host', () => {
        const long = `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.org:65535`;
        for (const url of [MULLUM, LOOKALIKE, 'http://[::1]:8080', long, 'https://a.test\\@evil.test']) {
            const name = getDatabaseFilenameForNode(url);
            expect(name, url).toMatch(/^community_[a-z0-9._-]+_[0-9a-f]{32}\.db$/);
            expect(name.length, url).toBeLessThanOrEqual(90);
        }
        expect(getDatabaseFilenameForNode(MULLUM)).toMatch(/^community_mullum\.beanpool\.org_[0-9a-f]{32}\.db$/);
        // No community open: the same file as before.
        expect(getDatabaseFilenameForNode(null)).toBe('beanpool.db');
    });
});

describe("a phone's copies under the old names move to the new ones, with nothing lost", () => {
    it("each saved community's rows, the ones still only in the log too, and its cursors, under its new name", async () => {
        phoneWith(MULLUM, [{ url: MULLUM }, { url: BELLINGEN }]);
        const oldM = legacyDatabaseFilenameForNode(MULLUM);
        const oldB = legacyDatabaseFilenameForNode(BELLINGEN);
        oldCopy(oldM, ['mullum 1', 'mullum 2', 'mullum 3']);
        oldCopy(oldB, ['bellingen 1']);
        expect(fs.existsSync(file(`${oldM}-wal`))).toBe(true);
        h.store.set(cursor(oldM, 'last-sync'), '1727740800000');
        h.store.set(cursor(oldM, 'identity-epoch'), '4');
        h.store.set(cursor(oldM, 'members_last_sync'), '1727740000000');
        h.store.set(cursor(oldB, 'last-sync'), '1727700000000');

        await getDb();

        const newM = getDatabaseFilenameForNode(MULLUM);
        const newB = getDatabaseFilenameForNode(BELLINGEN);
        // The app opened Mullum's copy under its new name, and nothing under an old one.
        expect(h.opened.filter(n => n !== oldM && n !== oldB)).toEqual([newM]);
        await closeDB();
        expect(rowsOf(newM)).toEqual(['mullum 1', 'mullum 2', 'mullum 3']);
        expect(rowsOf(newB)).toEqual(['bellingen 1']);
        for (const old of [oldM, oldB]) {
            for (const side of ['', '-wal', '-shm', '-journal']) expect(fs.existsSync(file(`${old}${side}`)), `${old}${side}`).toBe(false);
        }
        // The sync carries on where it was: the same cursors and epoch, under the new names, none under the old.
        expect(h.store.get(cursor(newM, 'last-sync'))).toBe('1727740800000');
        expect(h.store.get(cursor(newM, 'identity-epoch'))).toBe('4');
        expect(h.store.get(cursor(newM, 'members_last_sync'))).toBe('1727740000000');
        expect(h.store.get(cursor(newB, 'last-sync'))).toBe('1727700000000');
        expect([...h.store.keys()].filter(k => k.includes(oldM) || k.includes(oldB))).toEqual([]);
        // Still signed in: the anchor and the saved list are as they were.
        expect(h.store.get(ANCHOR)).toBe(MULLUM);
        expect(JSON.parse(h.store.get(SAVED_NODES_STORE_KEY)!).map((n: any) => n.url)).toEqual([MULLUM, BELLINGEN]);
        expect(h.store.get(CACHE_NAMES_DONE_KEY)).toBe('1');
    });

    it("the sync's cursor read waits for the move: the cursor it reads is the one the phone had", async () => {
        phoneWith(MULLUM, [{ url: MULLUM }]);
        const oldM = legacyDatabaseFilenameForNode(MULLUM);
        oldCopy(oldM, ['mullum 1']);
        h.store.set(cursor(oldM, 'last-sync'), '1727740800000');

        const { getSyncCursorKey } = await import('../../services/pillar-sync');
        const key = await getSyncCursorKey('last-sync');

        expect(key).toBe(cursor(getDatabaseFilenameForNode(MULLUM), 'last-sync'));
        expect(h.store.get(key)).toBe('1727740800000');
    });

    it('two communities that shared one old file: it goes to the one the phone is on; the other starts fresh, with no cursor', async () => {
        // The collision itself: a member who followed a look-alike's invite has one file for both.
        phoneWith(MULLUM, [{ url: LOOKALIKE, lastConnected: '2026-09-30T00:00:00Z' }, { url: MULLUM, lastConnected: '2026-09-01T00:00:00Z' }]);
        const shared = legacyDatabaseFilenameForNode(MULLUM);
        oldCopy(shared, ['mullum 1']);
        h.store.set(cursor(shared, 'last-sync'), '1727740800000');

        await getDb();
        await closeDB();

        expect(rowsOf(getDatabaseFilenameForNode(MULLUM))).toEqual(['mullum 1']);
        expect(h.store.get(cursor(getDatabaseFilenameForNode(MULLUM), 'last-sync'))).toBe('1727740800000');
        // The look-alike has no copy and no cursor of Mullum's: its first sync is a whole one, into its own file.
        expect(fs.existsSync(file(getDatabaseFilenameForNode(LOOKALIKE)))).toBe(false);
        expect(h.store.get(cursor(getDatabaseFilenameForNode(LOOKALIKE), 'last-sync'))).toBeUndefined();

        // Switched to the look-alike: its own file, with none of Mullum's rows in it.
        h.store.set(ANCHOR, LOOKALIKE);
        const db = await getDb();
        expect(h.opened.at(-1)).toBe(getDatabaseFilenameForNode(LOOKALIKE));
        expect(await db.getFirstAsync("SELECT 1 FROM sqlite_master WHERE name = 'kept'")).toBeNull();
        await closeDB();
        expect(rowsOf(getDatabaseFilenameForNode(MULLUM))).toEqual(['mullum 1']);
    });

    it('never overwrites a copy already under the new name, and a phone with nothing to move is done at once', async () => {
        phoneWith(MULLUM, [{ url: MULLUM }]);
        const oldM = legacyDatabaseFilenameForNode(MULLUM);
        const newM = getDatabaseFilenameForNode(MULLUM);
        oldCopy(oldM, ['old build']);
        oldCopy(newM, ['new build']);

        await getDb();
        await closeDB();

        expect(rowsOf(newM)).toEqual(['new build']);
        expect(rowsOf(oldM)).toEqual(['old build']);
        expect(h.store.get(CACHE_NAMES_DONE_KEY)).toBe('1');
    });

    it('a move that fails part way is finished on the next start, and nothing is opened under the wrong name meanwhile', async () => {
        phoneWith(MULLUM, [{ url: MULLUM }, { url: BELLINGEN }]);
        const oldB = legacyDatabaseFilenameForNode(BELLINGEN);
        oldCopy(legacyDatabaseFilenameForNode(MULLUM), ['mullum 1']);
        oldCopy(oldB, ['bellingen 1', 'bellingen 2']);
        h.store.set(cursor(oldB, 'last-sync'), '1727700000000');
        h.failMoveOf = oldB;

        await getDb();
        await closeDB();
        expect(rowsOf(getDatabaseFilenameForNode(MULLUM))).toEqual(['mullum 1']);
        // Bellingen's stayed where it was, cursor and all; not done, so the next start tries again.
        expect(rowsOf(oldB)).toEqual(['bellingen 1', 'bellingen 2']);
        expect(h.store.get(cursor(oldB, 'last-sync'))).toBe('1727700000000');
        expect(h.store.get(CACHE_NAMES_DONE_KEY)).toBeUndefined();

        // The next start.
        h.failMoveOf = null;
        resetCommunityCachesRenamedForTests();
        await getDb();
        await closeDB();
        expect(rowsOf(getDatabaseFilenameForNode(BELLINGEN))).toEqual(['bellingen 1', 'bellingen 2']);
        expect(h.store.get(cursor(getDatabaseFilenameForNode(BELLINGEN), 'last-sync'))).toBe('1727700000000');
        expect(h.store.get(CACHE_NAMES_DONE_KEY)).toBe('1');

        // Once done, a later start moves nothing, even an old-named file that turns up.
        resetCommunityCachesRenamedForTests();
        oldCopy(oldB, ['stray']);
        await getDb();
        await closeDB();
        expect(rowsOf(oldB)).toEqual(['stray']);
        expect(rowsOf(getDatabaseFilenameForNode(BELLINGEN))).toEqual(['bellingen 1', 'bellingen 2']);
    });

    it('a run cut off after the rename, before the cursors moved, moves them on the next start', async () => {
        phoneWith(MULLUM, [{ url: MULLUM }]);
        const oldM = legacyDatabaseFilenameForNode(MULLUM);
        const newM = getDatabaseFilenameForNode(MULLUM);
        oldCopy(oldM, ['mullum 1']);
        h.store.set(cursor(oldM, 'last-sync'), '1727740800000');
        h.store.set(cursor(oldM, 'identity-epoch'), '4');
        h.store.set(cursor(oldM, 'members_last_sync'), '1727740000000');
        h.failSetPrefix = `pillar_sync_${newM}_`;

        await getDb();
        await closeDB();
        // Run 1: the file was renamed, the first cursor write threw; not done.
        expect(rowsOf(newM)).toEqual(['mullum 1']);
        expect(fs.existsSync(file(oldM))).toBe(false);
        expect(h.store.get(CACHE_NAMES_DONE_KEY)).toBeUndefined();

        // The next start: the old file is gone, the cursors still are not.
        resetCommunityCachesRenamedForTests();
        await getDb();
        await closeDB();
        expect(h.store.get(cursor(newM, 'last-sync'))).toBe('1727740800000');
        expect(h.store.get(cursor(newM, 'identity-epoch'))).toBe('4');
        expect(h.store.get(cursor(newM, 'members_last_sync'))).toBe('1727740000000');
        expect([...h.store.keys()].filter(k => k.includes(oldM))).toEqual([]);
        expect(h.store.get(CACHE_NAMES_DONE_KEY)).toBe('1');
    });
});
