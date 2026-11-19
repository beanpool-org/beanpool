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
import { createHeldCopies, type HeldCopies, type HeldHandle } from '../held-copies';

const SCHEMA = 8;
const B = 'community_hilltop.example_b.db';
const C = 'community_brookside.example_c.db';

/** A fake handle: each read waits for `release()` when held; a close during a read is recorded (on a phone it hangs it). */
interface Fake extends HeldHandle { file: string; closed: boolean; queryOnly: boolean; reads: number }
function world(files: string[], opts: { schema?: number } = {}) {
    const present = new Set(files);
    const opened: string[] = [];
    const cutMidRead: string[] = [];
    let inUse = new Set<string>();
    let hold: { started: () => void; release: Promise<void> } | null = null;
    let open: () => void = () => {};
    let openGate: Promise<void> | null = null;
    const fakes: Fake[] = [];
    const held: HeldCopies = createHeldCopies<Fake>({
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
                closeAsync: async () => {
                    if (inFlight > 0) cutMidRead.push(f);
                    fake.closed = true;
                },
            };
            fakes.push(fake);
            return fake;
        },
        register: () => {},
        schema: SCHEMA,
    });
    return {
        held, opened, cutMidRead, fakes, present,
        setInUse: (f: string[]) => { inUse = new Set(f); },
        holdNextRead: () => {
            let started!: () => void;
            let release!: () => void;
            const startedP = new Promise<void>((r) => { started = r; });
            hold = { started, release: new Promise<void>((r) => { release = r; }) };
            return { started: startedP, release };
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
const CLOSERS: Array<[string, (h: HeldCopies) => Promise<unknown>]> = [
    ['close(file)', (h) => h.close(B)],
    ['closeAll()', (h) => h.closeAll()],
    ['paused(fn)', (h) => h.paused(async () => {})],
    ['pauseUntil(done)', (h) => h.pauseUntil(Promise.resolve())],
];

describe('held copies: never closed with a read in flight', () => {
    for (const [name, close] of CLOSERS) {
        it(`${name} waits for the read in flight, the read settles with its rows, then the handle closes`, async () => {
            const w = world([B]);
            expect(await w.held.all(B, 'SELECT 1', [])).toEqual([{ file: B }]);
            const gate = w.holdNextRead();
            const read = w.held.all(B, 'SELECT 1', []);
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
            await w.held.all(B, 'SELECT 1', []);
            const gate = w.holdNextRead();
            const first = w.held.all(B, 'SELECT 1', []);
            await gate.started;
            const closing = close(w.held);
            await ticks();
            expect(await w.held.all(B, 'SELECT 1', [])).toBeNull();
            gate.release();
            await first;
            await closing;
            expect(w.fakes[0].reads).toBe(2);
            expect(w.cutMidRead).toEqual([]);
        });

        it(`${name} while the handle is still opening: the open is let finish, then closed, and nothing reads it`, async () => {
            const w = world([B]);
            w.holdOpens();
            const read = w.held.all(B, 'SELECT 1', []);
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
        await w.held.all(B, 'SELECT 1', []);
        await w.held.all(C, 'SELECT 1', []);
        const gate = w.holdNextRead();
        const read = w.held.all(C, 'SELECT 1', []);
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
        expect(await w.held.all(B, 'SELECT 1', [])).toBeNull();
        expect(w.opened).toEqual([]);
        expect(w.present.has(B)).toBe(false);
    });

    it('the community in use is never opened as a held copy', async () => {
        const w = world([B]);
        w.setInUse([B]);
        expect(await w.held.all(B, 'SELECT 1', [])).toBeNull();
        expect(w.opened).toEqual([]);
    });

    it('a copy taken into use while its held handle opens is closed before anything reads it', async () => {
        const w = world([B]);
        w.holdOpens();
        const read = w.held.all(B, 'SELECT 1', []);
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
        const onItsWay = w.held.all(B, 'SELECT 1', []);
        await ticks();
        let deleted = false;
        const removing = w.held.paused(async () => {
            // Asked during the pause: refused before any open.
            expect(await w.held.all(C, 'SELECT 1', [])).toBeNull();
            w.present.delete(B);
            deleted = true;
        });
        w.letOpensGo();
        expect(await onItsWay).toBeNull();
        await removing;
        expect(deleted).toBe(true);
        expect(w.opened).toEqual([B]);
        // After the delete: B is not there, so it is never opened again (and so never made again).
        expect(await w.held.all(B, 'SELECT 1', [])).toBeNull();
        expect(w.opened).toEqual([B]);
        expect(w.present.has(B)).toBe(false);
    });

    it('pauseUntil holds every open off until its promise settles, a rejection included', async () => {
        const w = world([B]);
        let settle!: (e: Error) => void;
        const done = new Promise<void>((_r, rej) => { settle = rej; });
        await w.held.pauseUntil(done);
        expect(await w.held.all(B, 'SELECT 1', [])).toBeNull();
        settle(new Error('the removal failed'));
        await ticks();
        expect(await w.held.all(B, 'SELECT 1', [])).toEqual([{ file: B }]);
    });

    it('a copy at another schema number is not opened for reading (its columns are not this build\'s)', async () => {
        const w = world([B], { schema: 7 });
        expect(await w.held.all(B, 'SELECT 1', [])).toBeNull();
        expect(w.fakes.map((f) => [f.closed, f.reads])).toEqual([[true, 0]]);
    });

    it('query_only is set straight after the open, before the first read', async () => {
        const w = world([B]);
        await w.held.all(B, 'SELECT 1', []);
        expect(w.fakes[0].queryOnly).toBe(true);
    });
});

describe('held copies: one statement per read, never a transaction', () => {
    for (const sql of ['BEGIN', 'BEGIN IMMEDIATE', '  savepoint s', 'COMMIT', 'END', 'ROLLBACK', 'RELEASE s', 'SELECT 1; SELECT 2', "SELECT 1;\nDELETE FROM messages"]) {
        it(`refuses ${JSON.stringify(sql)} before it reaches the copy`, async () => {
            const w = world([B]);
            await expect(w.held.all(B, sql, [])).rejects.toThrow(/one read statement/);
            expect(w.opened).toEqual([]);
        });
    }
    it('takes one statement, a trailing semicolon allowed', async () => {
        const w = world([B]);
        expect(await w.held.all(B, 'SELECT 1;', [])).toEqual([{ file: B }]);
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
            const held = createHeldCopies<any>({
                renamed: async () => {},
                exists: async (f) => fs.existsSync(path.join(dir, f)),
                inUse: async () => false,
                open: async (f) => {
                    const sql = new DatabaseSync(path.join(dir, f));
                    return {
                        execAsync: async (q: string) => { sql.exec(q); },
                        getFirstAsync: async (q: string) => sql.prepare(q).get() ?? null,
                        getAllAsync: async (q: string, p: any[]) => sql.prepare(q).all(...params(p)),
                        closeAsync: async () => { sql.close(); },
                    };
                },
                register: () => {},
                schema: SCHEMA,
            });
            await expect(held.all(B, "INSERT INTO conversations VALUES ('written')", [])).rejects.toThrow(/readonly/i);
            await expect(held.all(B, "DELETE FROM conversations", [])).rejects.toThrow(/readonly/i);
            expect(await held.all(B, 'SELECT id FROM conversations', [])).toEqual([{ id: 'kept' }]);
            await held.closeAll();
            const check = new DatabaseSync(path.join(dir, B));
            expect(check.prepare('SELECT id FROM conversations').all().map((r: any) => r.id)).toEqual(['kept']);
            check.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
