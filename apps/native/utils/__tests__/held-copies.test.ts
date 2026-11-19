/**
 * utils/held-copies.ts, the one owner of the read-only handles on other communities' copies (slice S1), on its own: fake
 * handles whose reads this test holds open, and a real SQLite file for the read-only rule. The probe's conditions
 * (scratch/walks/RESULT-s1-second-handle-probe.md "Verdict"): never close with a read in flight (its promise never
 * settles), never open a missing file (the open makes one), one statement per read, never the community in use.
 * The same paths through the real database are utils/__tests__/held-chats-close-paths.test.ts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHeldCopies, InPlaceClosedError, isOneRead, type HeldCopies, type HeldHandle } from '../held-copies';

const SCHEMA = 8;
const B = 'community_hilltop.example_b.db';
const C = 'community_brookside.example_c.db';
/** The statements these worlds' held copies run, by name, as db.ts names its own. */
const STATEMENTS = { one: 'SELECT 1', oneWithSemicolon: 'SELECT 1;' } as const;
type Name = keyof typeof STATEMENTS;

/** A fake handle: each read waits for `release()` when held; a close during a read is recorded (on a phone it hangs it). */
interface Fake extends HeldHandle { file: string; closed: boolean; queryOnly: boolean; reads: number; withTransactionAsync(task: () => Promise<void>): Promise<void> }
function world(files: string[], opts: { schema?: number; statements?: Record<string, string> } = {}) {
    const present = new Set(files);
    const opened: string[] = [];
    const cutMidRead: string[] = [];
    /** Each handle registered under its file (db.ts dbFileOf): the raw connection and, for a copy open in place, its stand-in. */
    const registered: Array<[unknown, string]> = [];
    /** What happened, in order: each native close as it is done ("closed <file>"), and what a test adds. */
    const log: string[] = [];
    let inUse = new Set<string>();
    let hold: { started: () => void; release: Promise<void> } | null = null;
    let closeHold: { started: () => void; release: Promise<void> } | null = null;
    let open: () => void = () => {};
    let openGate: Promise<void> | null = null;
    const fakes: Fake[] = [];
    const held: HeldCopies<Name> = createHeldCopies<Fake, Name>({
        renamed: async () => {},
        exists: async (f) => present.has(f),
        inUse: async (f) => inUse.has(f),
        open: async (f) => {
            if (openGate) await openGate;
            opened.push(f);
            // As expo-sqlite's open on a phone: a file that isn't there is made.
            present.add(f);
            let inFlight = 0;
            const fake: Fake = {
                file: f, closed: false, queryOnly: false, reads: 0,
                execAsync: async (sql) => { if (/query_only\s*=\s*1/i.test(sql)) fake.queryOnly = true; },
                getFirstAsync: async () => ({ user_version: opts.schema ?? SCHEMA }) as any,
                getAllAsync: async () => {
                    if (fake.closed) throw new Error('read on a closed handle');
                    inFlight++;
                    fake.reads++;
                    try {
                        if (hold) {
                            const h = hold;
                            hold = null;
                            h.started();
                            await h.release;
                        }
                        if (fake.closed) throw new Error('cut by a close: on a phone this read never settles');
                        return [{ file: f }] as any;
                    } finally {
                        inFlight--;
                    }
                },
                // A transaction on the connection (a copy open in place writes in one, as the sync does): counted as in flight.
                withTransactionAsync: async (task: () => Promise<void>) => {
                    if (fake.closed) throw new Error('a transaction on a closed handle');
                    inFlight++;
                    try { await task(); } finally { inFlight--; }
                },
                closeAsync: async () => {
                    if (inFlight > 0) cutMidRead.push(f);
                    // A native close that takes its time (on a phone: EXCLUSIVE, a checkpoint, -wal and -shm unlinked).
                    if (closeHold) {
                        const c = closeHold;
                        closeHold = null;
                        c.started();
                        await c.release;
                    }
                    fake.closed = true;
                    log.push(`closed ${f}`);
                },
            };
            fakes.push(fake);
            return fake;
        },
        register: (handle, file) => { registered.push([handle, file]); },
        schema: SCHEMA,
        statements: (opts.statements ?? STATEMENTS) as Record<Name, string>,
    });
    const gate = () => {
        let started!: () => void;
        let release!: () => void;
        const startedP = new Promise<void>((r) => { started = r; });
        return { hold: { started, release: new Promise<void>((r) => { release = r; }) }, started: startedP, release: () => release() };
    };
    return {
        held, opened, cutMidRead, fakes, present, log, registered,
        setInUse: (f: string[]) => { inUse = new Set(f); },
        holdNextRead: () => {
            const g = gate();
            hold = g.hold;
            return { started: g.started, release: g.release };
        },
        /** Hold the next native close until `release()`. */
        holdNextClose: () => {
            const g = gate();
            closeHold = g.hold;
            return { started: g.started, release: g.release };
        },
        holdOpens: () => { openGate = new Promise<void>((r) => { open = r; }); },
        letOpensGo: () => { openGate = null; open(); },
    };
}
const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const pending = async (p: Promise<unknown>) => {
    let done = false;
    void p.then(() => { done = true; }, () => { done = true; });
    await ticks();
    return !done;
};

/** Every way the module closes a handle: each must wait for the read in flight, then close. */
const CLOSERS: Array<[string, (h: HeldCopies<Name>) => Promise<unknown>]> = [
    ['close(file)', (h) => h.close(B)],
    ['closeAll()', (h) => h.closeAll()],
    ['paused(fn)', (h) => h.paused(async () => {})],
    ['pauseUntil(done)', (h) => h.pauseUntil(Promise.resolve())],
];

/**
 * Each state B's held handle can be in as a closer comes: open with nothing on it, a read in flight, still opening, and
 * another closer's close under way with its native close not yet done (#3302 review F1: a second closer returned at once
 * then, and its caller deleted, moved or opened B beside a connection still closing). `start` puts the world in that state
 * and hands back what lets it go on.
 */
const STATES: Array<[string, (w: ReturnType<typeof world>) => Promise<() => void>]> = [
    ['open, nothing on it', async (w) => { await w.held.all(B, 'one', []); return () => {}; }],
    ['with a read in flight', async (w) => {
        await w.held.all(B, 'one', []);
        const g = w.holdNextRead();
        void w.held.all(B, 'one', []);
        await g.started;
        return g.release;
    }],
    ['still opening', async (w) => {
        w.holdOpens();
        void w.held.all(B, 'one', []);
        await ticks();
        return w.letOpensGo;
    }],
    ...CLOSERS.map(([first, closeFirst]): [string, (w: ReturnType<typeof world>) => Promise<() => void>] => [`closing by ${first}, its native close under way`, async (w) => {
        await w.held.all(B, 'one', []);
        const g = w.holdNextClose();
        void closeFirst(w.held);
        await g.started;
        return g.release;
    }]),
];

describe('held copies: every closer x every state of the handle (close the class)', () => {
    for (const [name, close] of CLOSERS) {
        for (const [state, start] of STATES) {
            it(`${name}, the handle ${state}: returns only once B's native close is done, no read cut, nothing left open`, async () => {
                const w = world([B]);
                const goOn = await start(w);
                const closing = close(w.held).then(() => { w.log.push('closer returned'); });
                if (state !== 'open, nothing on it') {
                    // It waits on what is under way: no return before it.
                    expect(await pending(closing)).toBe(true);
                    expect(w.log).not.toContain('closer returned');
                }
                goOn();
                await closing;
                expect(w.log.filter((x) => x.startsWith('closed '))).toEqual([`closed ${B}`]);
                expect(w.log.indexOf(`closed ${B}`)).toBeLessThan(w.log.indexOf('closer returned'));
                expect(w.cutMidRead).toEqual([]);
                expect(w.fakes.every((f) => f.closed)).toBe(true);
                expect(w.held.openFiles()).toEqual([]);
            });
        }
    }

    it('a read asked while a close is under way is refused, and once that close is done a read opens B afresh', async () => {
        const w = world([B]);
        await w.held.all(B, 'one', []);
        const g = w.holdNextClose();
        const closing = w.held.closeAll();
        await g.started;
        expect(w.held.openFiles()).toEqual([B]);
        expect(await w.held.all(B, 'one', [])).toBeNull();
        g.release();
        await closing;
        expect(await w.held.all(B, 'one', [])).toEqual([{ file: B }]);
        expect(w.opened).toEqual([B, B]);
        expect(w.fakes.map((f) => f.closed)).toEqual([true, false]);
    });
});

describe('held copies: never closed with a read in flight', () => {
    for (const [name, close] of CLOSERS) {
        it(`${name} waits for the read in flight, the read settles with its rows, then the handle closes`, async () => {
            const w = world([B]);
            expect(await w.held.all(B, 'one', [])).toEqual([{ file: B }]);
            const gate = w.holdNextRead();
            const read = w.held.all(B, 'one', []);
            await gate.started;
            const closing = close(w.held);
            // The close waits on the read: it has not closed the handle under it.
            expect(await pending(closing)).toBe(true);
            expect(w.fakes[0].closed).toBe(false);
            gate.release();
            expect(await read).toEqual([{ file: B }]);
            await closing;
            expect(w.cutMidRead).toEqual([]);
            expect(w.fakes[0].closed).toBe(true);
            expect(w.held.openFiles()).toEqual([]);
        });

        it(`a read asked once ${name} has begun is refused, never started on the closing handle`, async () => {
            const w = world([B]);
            await w.held.all(B, 'one', []);
            const gate = w.holdNextRead();
            const first = w.held.all(B, 'one', []);
            await gate.started;
            const closing = close(w.held);
            await ticks();
            expect(await w.held.all(B, 'one', [])).toBeNull();
            gate.release();
            await first;
            await closing;
            expect(w.fakes[0].reads).toBe(2);
            expect(w.cutMidRead).toEqual([]);
        });

        it(`${name} while the handle is still opening: the open is let finish, then closed, and nothing reads it`, async () => {
            const w = world([B]);
            w.holdOpens();
            const read = w.held.all(B, 'one', []);
            await ticks();
            const closing = close(w.held);
            w.letOpensGo();
            expect(await read).toBeNull();
            await closing;
            expect(w.fakes.every((f) => f.closed)).toBe(true);
            expect(w.fakes.every((f) => f.reads === 0)).toBe(true);
        });
    }

    it('closeAll waits for every handle\'s reads, each on its own file', async () => {
        const w = world([B, C]);
        await w.held.all(B, 'one', []);
        await w.held.all(C, 'one', []);
        const gate = w.holdNextRead();
        const read = w.held.all(C, 'one', []);
        await gate.started;
        const closing = w.held.closeAll();
        expect(await pending(closing)).toBe(true);
        gate.release();
        expect(await read).toEqual([{ file: C }]);
        await closing;
        expect(w.fakes.map((f) => [f.file, f.closed])).toEqual([[B, true], [C, true]]);
        expect(w.cutMidRead).toEqual([]);
    });
});

describe('held copies: never a file that is not there, never the community in use', () => {
    it('a missing file is never opened (an open would make it), and a read of it is null', async () => {
        const w = world([]);
        expect(await w.held.all(B, 'one', [])).toBeNull();
        expect(w.opened).toEqual([]);
        expect(w.present.has(B)).toBe(false);
    });

    it('the community in use is never opened as a held copy', async () => {
        const w = world([B]);
        w.setInUse([B]);
        expect(await w.held.all(B, 'one', [])).toBeNull();
        expect(w.opened).toEqual([]);
    });

    it('a copy taken into use while its held handle opens is closed before anything reads it', async () => {
        const w = world([B]);
        w.holdOpens();
        const read = w.held.all(B, 'one', []);
        await ticks();
        // The copy in use opens B now (db.ts openAndMakeCopy): B is in use, and it closes the held handle first.
        w.setInUse([B]);
        const closing = w.held.close(B);
        w.letOpensGo();
        expect(await read).toBeNull();
        await closing;
        expect(w.fakes.map((f) => [f.closed, f.reads])).toEqual([[true, 0]]);
    });

    it('a pause before a delete: an open on its way is let finish and closed; one asked during the pause never opens, so no deleted file is made again', async () => {
        const w = world([B]);
        w.holdOpens();
        const onItsWay = w.held.all(B, 'one', []);
        await ticks();
        let deleted = false;
        const removing = w.held.paused(async () => {
            // Asked during the pause: refused before any open.
            expect(await w.held.all(C, 'one', [])).toBeNull();
            w.present.delete(B);
            deleted = true;
        });
        w.letOpensGo();
        expect(await onItsWay).toBeNull();
        await removing;
        expect(deleted).toBe(true);
        expect(w.opened).toEqual([B]);
        // After the delete: B is not there, so it is never opened again (and so never made again).
        expect(await w.held.all(B, 'one', [])).toBeNull();
        expect(w.opened).toEqual([B]);
        expect(w.present.has(B)).toBe(false);
    });

    it('pauseUntil holds every open off until its promise settles, a rejection included', async () => {
        const w = world([B]);
        let settle!: (e: Error) => void;
        const done = new Promise<void>((_r, rej) => { settle = rej; });
        await w.held.pauseUntil(done);
        expect(await w.held.all(B, 'one', [])).toBeNull();
        settle(new Error('the removal failed'));
        await ticks();
        expect(await w.held.all(B, 'one', [])).toEqual([{ file: B }]);
    });

    it('a copy at another schema number is not opened for reading (its columns are not this build\'s)', async () => {
        const w = world([B], { schema: 7 });
        expect(await w.held.all(B, 'one', [])).toBeNull();
        expect(w.fakes.map((f) => [f.closed, f.reads])).toEqual([[true, 0]]);
    });

    it('query_only is set straight after the open, before the first read', async () => {
        const w = world([B]);
        await w.held.all(B, 'one', []);
        expect(w.fakes[0].queryOnly).toBe(true);
    });
});

describe('held copies: one plain SELECT of its own per read, never caller SQL (an allowlist)', () => {
    // The denylist's misses (#3302 review F5) first: a comment before a transaction statement, the read-only rule lifted,
    // another file attached, and a WITH that writes.
    const REFUSED = [
        '-- c\nBEGIN', '/* c */ BEGIN', 'PRAGMA query_only = 0', "ATTACH 'x.db' AS x", 'WITH x AS (SELECT 1) DELETE FROM messages',
        'BEGIN', 'BEGIN IMMEDIATE', '  savepoint s', 'COMMIT', 'END', 'ROLLBACK', 'RELEASE s', 'SELECT 1; SELECT 2', "SELECT 1;\nDELETE FROM messages",
        "INSERT INTO conversations VALUES ('x')", 'DELETE FROM messages', 'UPDATE messages SET id = 1', 'DROP TABLE messages', 'VACUUM', '',
    ];
    for (const sql of REFUSED) {
        it(`a statement ${JSON.stringify(sql)} is no read: refused at its use, before any copy is opened`, async () => {
            expect(isOneRead(sql)).toBe(false);
            const w = world([B], { statements: { one: sql } });
            await expect(w.held.all(B, 'one', [])).rejects.toThrow(/one read statement/);
            expect(w.opened).toEqual([]);
        });
    }

    it('SQL a caller hands it is no name of its statements: refused before any copy is opened', async () => {
        const w = world([B]);
        for (const sql of ['SELECT 1', 'BEGIN', 'toString', '__proto__', 'constructor']) {
            await expect(w.held.all(B, sql as Name, [])).rejects.toThrow(/one read statement/);
        }
        expect(w.opened).toEqual([]);
    });

    it('takes its own statement, a trailing semicolon allowed', async () => {
        const w = world([B]);
        expect(await w.held.all(B, 'oneWithSemicolon', [])).toEqual([{ file: B }]);
        for (const sql of ['SELECT 1', ' select id from conversations ;', 'SELECT c.id\n  FROM conversations c\n  WHERE c.id = ?\n']) expect(isOneRead(sql)).toBe(true);
    });
});

describe('held copies: a write through a held handle fails (PRAGMA query_only, real SQLite)', () => {
    it('an INSERT is refused as a readonly database and the copy is unchanged', async () => {
        const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-held-ro-'));
        try {
            const seed = new DatabaseSync(path.join(dir, B));
            seed.exec(`PRAGMA journal_mode = WAL; CREATE TABLE conversations (id TEXT PRIMARY KEY); INSERT INTO conversations VALUES ('kept'); PRAGMA user_version = ${SCHEMA};`);
            seed.close();
            const params = (p: any[]) => p as any[];
            // The very connection the module opened: no statement of its own writes, so a write is tried on it past the
            // module, as a slip that handed the handle on would.
            let connection: DatabaseSync | null = null;
            const held = createHeldCopies<any, 'ids'>({
                renamed: async () => {},
                exists: async (f) => fs.existsSync(path.join(dir, f)),
                inUse: async () => false,
                open: async (f) => {
                    const sql = new DatabaseSync(path.join(dir, f));
                    connection = sql;
                    return {
                        execAsync: async (q: string) => { sql.exec(q); },
                        getFirstAsync: async (q: string) => sql.prepare(q).get() ?? null,
                        getAllAsync: async (q: string, p: any[]) => sql.prepare(q).all(...params(p)),
                        closeAsync: async () => { sql.close(); },
                    };
                },
                register: () => {},
                schema: SCHEMA,
                statements: { ids: 'SELECT id FROM conversations' },
            });
            expect(await held.all(B, 'ids', [])).toEqual([{ id: 'kept' }]);
            expect(() => connection!.exec("INSERT INTO conversations VALUES ('written')")).toThrow(/readonly/i);
            expect(() => connection!.exec('DELETE FROM conversations')).toThrow(/readonly/i);
            expect(await held.all(B, 'ids', [])).toEqual([{ id: 'kept' }]);
            await held.closeAll();
            const check = new DatabaseSync(path.join(dir, B));
            expect(check.prepare('SELECT id FROM conversations').all().map((r: any) => r.id)).toEqual(['kept']);
            check.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── Slice S2: a copy open in place ──────────────────────────────────────────────────────────────────────────────────

/** Each state a copy open in place can be in as a closer comes: idle, a statement in flight, a transaction in flight. */
const PLACE_STATES: Array<[string, (w: ReturnType<typeof world>, standIn: Fake) => Promise<{ goOn: () => void; settled: Promise<unknown> }>]> = [
    ['idle', async () => ({ goOn: () => {}, settled: Promise.resolve() })],
    ['with a statement in flight', async (w, standIn) => {
        const g = w.holdNextRead();
        const settled = standIn.getAllAsync('SELECT 1', []);
        await g.started;
        return { goOn: g.release, settled };
    }],
    ['with a transaction in flight, its next statement asked after the close began', async (w, standIn) => {
        let release!: () => void;
        const inside = new Promise<void>((r) => { release = r; });
        let started!: () => void;
        const begun = new Promise<void>((r) => { started = r; });
        const settled = standIn.withTransactionAsync(async () => {
            started();
            await inside;
            await standIn.getAllAsync('SELECT 1', []);
        });
        await begun;
        return { goOn: release, settled };
    }],
];

describe('held copies: a copy open in place (slice S2), under every closer', () => {
    for (const [name, close] of CLOSERS) {
        for (const [state, start] of PLACE_STATES) {
            it(`${name}, the copy open in place ${state}: returns only once its native close is done, nothing cut, every statement after refused`, async () => {
                const w = world([B]);
                const place = (await w.held.inPlace(B))!;
                expect(place).not.toBeNull();
                expect(place.open()).toBe(true);
                const { goOn, settled } = await start(w, place.handle as Fake);
                const closing = close(w.held).then(() => { w.log.push('closer returned'); });
                if (state !== 'idle') expect(await pending(closing)).toBe(true);
                // From the moment the close began: refused, never run on a connection closing.
                expect(place.open()).toBe(false);
                await expect((place.handle as Fake).getAllAsync('SELECT 1', [])).rejects.toBeInstanceOf(InPlaceClosedError);
                goOn();
                const outcome = await settled.then(() => 'settled', (e) => e);
                await closing;
                if (state.startsWith('with a transaction')) expect(outcome).toBeInstanceOf(InPlaceClosedError);
                else expect(outcome).toBe('settled');
                expect(w.log.filter((x) => x.startsWith('closed '))).toEqual([`closed ${B}`]);
                expect(w.log.indexOf(`closed ${B}`)).toBeLessThan(w.log.indexOf('closer returned'));
                expect(w.cutMidRead).toEqual([]);
                expect(w.held.openFiles()).toEqual([]);
            });
        }
    }

    it('it is writable (no query_only), its stand-in is registered under its file, and asked again it is the same copy', async () => {
        const w = world([B]);
        const first = (await w.held.inPlace(B))!;
        const again = (await w.held.inPlace(B))!;
        expect(again.handle).toBe(first.handle);
        expect(w.opened).toEqual([B]);
        expect(w.fakes[0].queryOnly).toBe(false);
        expect(w.registered.filter(([, f]) => f === B).map(([h]) => h)).toContain(first.handle);
        // The stand-in is not the connection: nothing past this module holds the connection itself.
        expect(first.handle).not.toBe(w.fakes[0]);
    });

    it('beside a read-only handle on the same file: two connections, the read-only one query_only', async () => {
        const w = world([B]);
        await w.held.all(B, 'one', []);
        await w.held.inPlace(B);
        expect(w.opened).toEqual([B, B]);
        expect(w.fakes.map((f) => f.queryOnly)).toEqual([true, false]);
    });

    it('closeReads (Chat left) closes the read-only handles and leaves the copy open in place, whose chat is on screen', async () => {
        const w = world([B, C]);
        await w.held.all(C, 'one', []);
        const place = (await w.held.inPlace(B))!;
        await w.held.closeReads();
        expect(place.open()).toBe(true);
        expect(w.held.openFiles()).toEqual([B]);
        expect(await (place.handle as Fake).getAllAsync('SELECT 1', [])).toEqual([{ file: B }]);
    });

    it('a missing file, the community in use, another schema number or a pause: no copy in place, and no file made', async () => {
        const missing = world([]);
        expect(await missing.held.inPlace(B)).toBeNull();
        expect(missing.present.has(B)).toBe(false);
        const inUse = world([B]);
        inUse.setInUse([B]);
        expect(await inUse.held.inPlace(B)).toBeNull();
        const older = world([B], { schema: SCHEMA - 1 });
        expect(await older.held.inPlace(B)).toBeNull();
        expect(older.fakes.every((f) => f.closed)).toBe(true);
        const paused = world([B]);
        let place: unknown = 'not asked';
        await paused.held.paused(async () => { place = await paused.held.inPlace(B); });
        expect(place).toBeNull();
        expect(paused.opened).toEqual([]);
    });

    it('its stand-in refuses a close and a prepared statement from a caller: only this module closes it', async () => {
        const w = world([B]);
        const place = (await w.held.inPlace(B))!;
        expect(() => (place.handle as Fake).closeAsync()).toThrow(InPlaceClosedError);
        expect(() => (place.handle as any).prepareAsync('SELECT 1')).toThrow(InPlaceClosedError);
        expect(w.fakes[0].closed).toBe(false);
        expect(place.open()).toBe(true);
    });

    it('closed, its old stand-in stays refused; asked again, a new connection and a new stand-in', async () => {
        const w = world([B]);
        const first = (await w.held.inPlace(B))!;
        await w.held.close(B);
        await expect((first.handle as Fake).getAllAsync('SELECT 1', [])).rejects.toBeInstanceOf(InPlaceClosedError);
        const second = (await w.held.inPlace(B))!;
        expect(second.handle).not.toBe(first.handle);
        expect(second.open()).toBe(true);
        expect(first.open()).toBe(false);
        await expect((first.handle as Fake).getAllAsync('SELECT 1', [])).rejects.toBeInstanceOf(InPlaceClosedError);
        expect(w.opened).toEqual([B, B]);
    });
});

describe('held copies: a copy open in place writes its own file and no other (real SQLite)', () => {
    it('a write through it lands in its file; the community in use and a third copy are as they were', async () => {
        const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-held-place-'));
        try {
            for (const f of [B, C, 'community_in_use.db']) {
                const seed = new DatabaseSync(path.join(dir, f));
                seed.exec(`PRAGMA journal_mode = WAL; CREATE TABLE messages (id TEXT PRIMARY KEY); PRAGMA user_version = ${SCHEMA};`);
                seed.close();
            }
            const params = (p: any) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
            const held = createHeldCopies<any, 'ids'>({
                renamed: async () => {},
                exists: async (f) => fs.existsSync(path.join(dir, f)),
                inUse: async (f) => f === 'community_in_use.db',
                open: async (f) => {
                    const sql = new DatabaseSync(path.join(dir, f));
                    return {
                        execAsync: async (q: string) => { sql.exec(q); },
                        getFirstAsync: async (q: string) => sql.prepare(q).get() ?? null,
                        getAllAsync: async (q: string, p: any) => sql.prepare(q).all(...params(p)),
                        runAsync: async (q: string, p: any) => { sql.prepare(q).run(...params(p)); },
                        closeAsync: async () => { sql.close(); },
                    };
                },
                register: () => {},
                schema: SCHEMA,
                statements: { ids: 'SELECT id FROM messages' },
            });
            expect(await held.inPlace('community_in_use.db')).toBeNull();
            const place = (await held.inPlace(B))!;
            await place.handle.runAsync('INSERT INTO messages (id) VALUES (?)', ['written in place']);
            await held.closeAll();
            const idsOf = (f: string) => {
                const check = new DatabaseSync(path.join(dir, f));
                try { return check.prepare('SELECT id FROM messages').all().map((r: any) => r.id); } finally { check.close(); }
            };
            expect(idsOf(B)).toEqual(['written in place']);
            expect(idsOf(C)).toEqual([]);
            expect(idsOf('community_in_use.db')).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
