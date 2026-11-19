/**
 * Held copies: a read-only handle on another community's copy, beside the one in use, so its chats can show in the one
 * Chats list without a switch (slice S1, scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3, §6). This module is
 * the ONE owner of every such handle: a map from a community's file to its handle and the reads in flight on it. Nothing
 * else opens one (db.ts wires it: `heldCopies`).
 *
 * Its rules are the S1 probe's five conditions (scratch/walks/RESULT-s1-second-handle-probe.md "Verdict" and (5), measured
 * on the API 26 emulator):
 * 1. Never close a handle with a read in flight: that read's promise never settles. {@link HeldCopies.close},
 *    {@link HeldCopies.closeAll} and {@link HeldCopies.paused} wait for the reads in flight, then close. A closer that
 *    comes while another one's close is under way waits for that same close, its native close included, before it
 *    returns: a caller that deletes, moves or opens the file next never does so beside a held connection still closing.
 * 2. Never open a file that isn't there: the open makes one. The file is looked for first, and a pause (before a copy is
 *    deleted or moved) waits for an open on its way, so none is opened between the look and the delete.
 * 3. No long read transactions: one holds back the WAL of the community in use. Every read is one statement
 *    ({@link HeldCopies.all}): one of the statements this module was made with (`statements`), asked for by name, never
 *    SQL a caller hands it, and each is let through only as one plain SELECT ({@link isOneRead}), so no transaction
 *    statement, PRAGMA, ATTACH, write or second statement ever reaches a held copy.
 * 4. Every held handle closes wherever the main copy is closed, cleared or deleted (db.ts closeOpenCopy, whileCopyMoves,
 *    community-cache.ts removeCommunityCaches): otherwise it goes on showing a deleted copy's chats.
 * (5, the switch-during-sync write, is #3300's chatCopyForRequest; a held handle writes nothing at all.)
 * And from (5) of the probe:
 * - opened only once the copies have their own names, never for the community in use (nor one being opened, moved or
 *   cleared), and only for a copy at this build's schema number (an older one is cleared at its next open as the copy in
 *   use, and its columns are not today's);
 * - `PRAGMA query_only = 1` straight after the open: a write through a held handle fails ("attempt to write a readonly
 *   database");
 * - registered under its own file (`register`), so the DM pins and the DM guard read that file's, never the anchor's.
 *
 * Slice S2 (a chat read and written in place, without a switch) adds ONE more kind of handle here, so every closer above
 * still covers it: a copy open in place ({@link HeldCopies.inPlace}), a writable connection on one other community's file
 * while a chat of it is on screen. The read-only handles stay as they are. A copy open in place is handed out only as a
 * counted stand-in for the handle: every statement on it (one getAllAsync, one runAsync, one whole withTransactionAsync)
 * is counted in and out as a held read is, so a close waits for the statement under way (rule 1) and every statement after
 * a close began is refused, never run on a handle closing or closed. It writes only the file it was opened on (a
 * connection is one file's for its life), it opens under the same refusals as a read (never a missing file, never the
 * community in use, never another schema number, never during a pause) and one of its own (`placeRefused`: db.ts, a chat
 * left), an open asked while a close of it is under way waits for that close and then opens anew or is refused (#3305
 * review), and nothing but this module can close it.
 */

/** What this module needs of a database handle (expo-sqlite's SQLiteDatabase has all of it). */
export interface HeldHandle {
    execAsync(sql: string): Promise<void>;
    getAllAsync<T>(sql: string, params: any[]): Promise<T[]>;
    getFirstAsync<T>(sql: string): Promise<T | null>;
    closeAsync(): Promise<void>;
}

export interface HeldCopiesDeps<H extends HeldHandle, S extends string> {
    /** Resolves once the phone's copies have their own names (cache-file-migration.ts communityCachesRenamed). */
    renamed(): Promise<unknown>;
    /** Whether `file`'s copy is on the phone. Asked before every open: an open makes a file that isn't there. */
    exists(file: string): Promise<boolean>;
    /** `file` is the community in use, its copy is being opened, or a copy is moving: no held handle for it then. */
    inUse(file: string): Promise<boolean>;
    /** A connection of its own on `file` (expo-sqlite `useNewConnection`). */
    open(file: string): Promise<H>;
    /** Note which file the handle reads (db.ts dbFileOf), straight after the open. */
    register(handle: H, file: string): void;
    /** This build's copy schema number (db.ts COPY_SCHEMA): a held copy at another is not opened. */
    schema: number;
    /**
     * The only statements a held copy runs, by name (db.ts: constants of its own). Each must be one plain SELECT
     * ({@link isOneRead}): one that isn't is refused at its every use, before it reaches a copy.
     */
    statements: Readonly<Record<S, string>>;
    /** What a statement refused on a copy open in place says (db.ts: the chat's own "switched community" sentence). */
    closedText?: string;
    /**
     * True while no copy of `file` may open in place (db.ts: its chat was left, #3305 review). Asked with no await before
     * every open in place begins, a wait for a close under way included, so nothing asked after the leave opens it again.
     */
    placeRefused?(file: string): boolean;
}

export interface HeldCopies<S extends string = string, H = HeldHandle> {
    /**
     * The statement named `statement` (one of `statements`) on `file`'s held copy, counted in and out. Null when there is
     * none to read (no such file, the community in use, a copy at another schema number, a pause, a close under way).
     * Rejects on a statement SQLite refuses, and on a name with no statement or one that isn't one plain SELECT (refused
     * before it reaches the copy).
     */
    all<T>(file: string, statement: S, params: readonly unknown[]): Promise<T[] | null>;
    /**
     * Close `file`'s held handle, once its reads in flight have settled (db.ts: before the copy in use opens that file).
     * Resolves once its native close is done, a close another closer began included.
     */
    close(file: string): Promise<void>;
    /** Close every held handle, once its reads in flight have settled (db.ts closeOpenCopy), each closed when this resolves. */
    closeAll(): Promise<void>;
    /** Close every held handle and open none until `fn` is done: around anything that moves or deletes a copy. */
    paused<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * As {@link HeldCopies.paused}, for a caller whose work goes on after this returns: every held handle is closed when it
     * resolves, and none opens until `done` settles (community-cache.ts removeCommunityCaches, through db.ts closeDB).
     */
    pauseUntil(done: Promise<unknown>): Promise<void>;
    /** The files a handle is open, opening or closing on, for tests and logs (a copy open in place included). */
    openFiles(): string[];
    /**
     * `file`'s copy open in place (slice S2): a writable connection, opened on the first ask under the same refusals as a
     * read, handed out as a counted stand-in (`handle`) whose every statement a close waits for, and which refuses every
     * statement once a close of it began (`open()` false from then). Null when there is none to open: no such file, the
     * community in use, a copy at another schema number, a pause, `placeRefused`. A close of it under way (or one that cuts
     * this open) is waited for, then the copy opens again under the same refusals (#3305 review: the key code screen asked
     * while the chat's close still ran, and was refused for good). Closed by every closer above.
     */
    inPlace(file: string): Promise<InPlaceCopy<H> | null>;
    /** Close every read-only held handle (Chat is left): a copy open in place stays, its chat is still on screen. */
    closeReads(): Promise<void>;
    /**
     * Resolves once a close of `file`'s read-only handle under way is done; at once when none is (#3305 round 5: a read
     * asked as Chat is left, whose close answers it null, can wait for that close and ask once more). Closes nothing.
     */
    readsSettled(file: string): Promise<void>;
}

/** A copy open in place ({@link HeldCopies.inPlace}). */
export interface InPlaceCopy<H> {
    /** The counted stand-in for the connection: the only way to it. Its every statement is refused once a close began. */
    handle: H;
    /** True until a close of it began: a statement asked from then is refused. */
    open(): boolean;
}

/** A statement asked of a copy open in place once its close began, or its handle's close asked by a caller. */
export class InPlaceClosedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InPlaceClosedError';
    }
}

/**
 * One held handle: the open on its way, the handle once open, its reads in flight, and its close once one has begun. The
 * entry stays in the map until that close is done, so a closer that comes later finds it and waits for the same close.
 */
interface Entry<H> {
    handle: H | null;
    opening: Promise<H | null> | null;
    inFlight: number;
    idle: Array<() => void>;
    closing: boolean;
    /** Set by the first closer, in the same turn as `closing`: every closer awaits it. Settles once the native close is done. */
    closed: Promise<void> | null;
}

/**
 * One plain SELECT: the only statement a held copy runs (rule 3). An allowlist: it starts with SELECT (after white space
 * only, so no comment hides a statement before it) and holds no `;` but one at its very end, so it is one statement, and
 * no transaction statement, PRAGMA (`query_only = 0` would lift the read-only rule), ATTACH or write. WITH is not let
 * through: SQLite takes `WITH … DELETE`.
 */
export function isOneRead(sql: unknown): boolean {
    return typeof sql === 'string' && /^\s*SELECT\b[^;]*;?\s*$/i.test(sql);
}

export function createHeldCopies<H extends HeldHandle, S extends string>(deps: HeldCopiesDeps<H, S>): HeldCopies<S, H> {
    const entries = new Map<string, Entry<H>>();
    /** The copies open in place (slice S2), by file: one writable connection each, beside any read-only one. */
    const places = new Map<string, Entry<H>>();
    /** Each copy open in place's one stand-in, made once per connection (its entry). */
    const stand = new Map<string, { entry: Entry<H>; handle: H }>();
    let pauses = 0;

    /** No await from this check to what follows it: a close or a pause that starts later waits for this entry. */
    const refused = (entry: Entry<H>) => pauses > 0 || entry.closing;

    async function openFor(file: string, entry: Entry<H>, writable = false): Promise<H | null> {
        await deps.renamed();
        if (refused(entry) || await deps.inUse(file)) return null;
        if (!(await deps.exists(file))) return null;
        const busy = await deps.inUse(file);
        if (refused(entry) || busy) return null;
        // From the check above to this call there is no await: a pause that deletes the file waits for this open first.
        const handle = await deps.open(file);
        deps.register(handle, file);
        try {
            // A copy open in place writes (S2); a held read handle never does.
            await handle.execAsync(writable ? 'PRAGMA busy_timeout = 5000;' : 'PRAGMA query_only = 1; PRAGMA busy_timeout = 5000;');
            const version = await handle.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
            if (!version || version.user_version !== deps.schema) throw new Error(`held copy ${file} is at schema ${version?.user_version ?? '?'}, not ${deps.schema}`);
            const busyNow = await deps.inUse(file);
            if (refused(entry) || busyNow) throw new Error(`held copy ${file} is wanted by the copy in use, or a close began`);
        } catch (e) {
            await handle.closeAsync().catch(() => {});
            if (!refused(entry)) console.log(`[Held] ${String(e instanceof Error ? e.message : e)}`);
            return null;
        }
        // No await since the last check: a close that starts from here on finds the handle and waits for its reads.
        entry.handle = handle;
        return handle;
    }

    function handleFor(file: string, map: Map<string, Entry<H>> = entries): Promise<H | null> {
        if (pauses > 0) return Promise.resolve(null);
        const held = map.get(file);
        if (held) {
            if (held.closing) return Promise.resolve(null);
            return held.handle ? Promise.resolve(held.handle) : (held.opening ?? Promise.resolve(null));
        }
        const entry: Entry<H> = { handle: null, opening: null, inFlight: 0, idle: [], closing: false, closed: null };
        map.set(file, entry);
        const opening = openFor(file, entry, map === places)
            .catch((e) => {
                console.warn(`[Held] Could not open the copy ${file}`, e);
                return null;
            })
            .then((handle) => {
                entry.opening = null;
                // A close under way takes the entry out itself, once it is done.
                if (!handle && !entry.closing && map.get(file) === entry) map.delete(file);
                return handle;
            });
        entry.opening = opening;
        return opening;
    }

    /**
     * Close `entry`, or wait for the close already under way: one close per entry, which every closer awaits, so none
     * returns before the native close is done (#3302 review F1: a second closer returned at once while the first one's
     * close still ran, and its caller could delete or open the file beside it). The entry leaves the map only then.
     */
    function closeEntry(file: string, entry: Entry<H>, map: Map<string, Entry<H>> = entries): Promise<void> {
        if (entry.closed) return entry.closed;
        entry.closing = true;
        entry.closed = (async () => {
            try {
                if (entry.opening) await entry.opening;
                while (entry.inFlight > 0) await new Promise<void>((resolve) => { entry.idle.push(resolve); });
                const handle = entry.handle;
                entry.handle = null;
                if (handle) await handle.closeAsync().catch((e) => console.warn(`[Held] Close warning for ${file}:`, e));
            } finally {
                if (map.get(file) === entry) map.delete(file);
                if (map === places && stand.get(file)?.entry === entry) stand.delete(file);
            }
        })();
        return entry.closed;
    }

    async function closeReads(): Promise<void> {
        await Promise.all([...entries].map(([file, entry]) => closeEntry(file, entry)));
    }

    /** Every held handle, a copy open in place included: each closed when this resolves. */
    async function closeAll(): Promise<void> {
        await Promise.all([closeReads(), ...[...places].map(([file, entry]) => closeEntry(file, entry, places))]);
    }

    /** Settle one statement on `entry`: a close waiting for the last one goes on. */
    function settle(entry: Entry<H>): void {
        entry.inFlight--;
        if (entry.inFlight === 0) for (const settled of entry.idle.splice(0)) settled();
    }

    /**
     * The counted stand-in for a copy open in place: each method call on it is one statement counted in and out on its
     * entry (a whole withTransactionAsync is one: its own statements are counted inside it), refused once a close began
     * or once the connection under it is not the entry's any more. Its close (and a statement prepared to outlive the
     * count) is refused: only this module closes it.
     */
    function standIn(file: string, entry: Entry<H>, handle: H): H {
        const closed = () => new InPlaceClosedError(deps.closedText ?? `The copy ${file} open in place was closed.`);
        return new Proxy(handle, {
            get(target, prop) {
                if (prop === 'closeAsync' || prop === 'closeSync' || prop === 'prepareAsync' || prop === 'prepareSync') {
                    return () => { throw new InPlaceClosedError(`A copy open in place takes no ${String(prop)} from a caller.`); };
                }
                const value = Reflect.get(target, prop, target);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                    // Counted in with no await since this check: a close that began has the statement refused, never cut.
                    if (entry.handle !== target || refused(entry)) {
                        if (/Sync$/.test(String(prop))) throw closed();
                        return Promise.reject(closed());
                    }
                    entry.inFlight++;
                    let out: unknown;
                    try {
                        out = (value as (...a: unknown[]) => unknown).apply(target, args);
                    } catch (e) {
                        settle(entry);
                        throw e;
                    }
                    if (out && typeof (out as Promise<unknown>).then === 'function') {
                        return (out as Promise<unknown>).finally(() => settle(entry));
                    }
                    settle(entry);
                    return out;
                };
            },
        }) as H;
    }

    /**
     * `file`'s copy open in place and its entry, open and not closing as this returns (no await after its last check), or
     * null when there is none to open. A close of it under way, or one that cuts this open, with no pause, is waited for
     * and the copy asked again: it opens anew, or is refused (`placeRefused`, a pause, the file gone, the community in use).
     */
    async function placeOpenFor(file: string): Promise<{ entry: Entry<H>; handle: H } | null> {
        for (;;) {
            const closing = places.get(file);
            if (closing?.closing && pauses === 0) {
                await closing.closed;
                continue;
            }
            // No await from this check to the open's start: handleFor makes its entry in the same turn.
            if (deps.placeRefused?.(file)) return null;
            const asked = handleFor(file, places);
            const mine = places.get(file);
            const handle = await asked;
            const entry = places.get(file);
            if (handle && entry && entry === mine && entry.handle === handle && !refused(entry)) return { entry, handle };
            // Cut by a close that began meanwhile (no pause): waited for as above. Any other refusal is final.
            if (mine?.closing && pauses === 0) {
                await mine.closed;
                continue;
            }
            return null;
        }
    }

    return {
        async all<T>(file: string, statement: S, params: readonly unknown[]): Promise<T[] | null> {
            const sql = Object.prototype.hasOwnProperty.call(deps.statements, statement) ? deps.statements[statement] : undefined;
            if (typeof sql !== 'string' || !isOneRead(sql)) throw new Error('A held copy takes one read statement at a time, never a transaction.');
            const handle = await handleFor(file);
            if (!handle) return null;
            const entry = entries.get(file);
            // Counted in with no await since this check: a close that began meanwhile has the read refused, never cut.
            if (!entry || entry.handle !== handle || refused(entry)) return null;
            entry.inFlight++;
            try {
                return await handle.getAllAsync<T>(sql, [...params]);
            } finally {
                settle(entry);
            }
        },
        async close(file: string): Promise<void> {
            const entry = entries.get(file);
            const place = places.get(file);
            await Promise.all([entry ? closeEntry(file, entry) : null, place ? closeEntry(file, place, places) : null]);
        },
        closeAll,
        closeReads,
        readsSettled(file: string): Promise<void> {
            const entry = entries.get(file);
            return entry?.closing && entry.closed ? entry.closed : Promise.resolve();
        },
        async paused<T>(fn: () => Promise<T>): Promise<T> {
            pauses++;
            try {
                await closeAll();
                return await fn();
            } finally {
                pauses--;
            }
        },
        async pauseUntil(done: Promise<unknown>): Promise<void> {
            pauses++;
            void done.catch(() => {}).finally(() => { pauses--; });
            await closeAll();
        },
        openFiles: () => [...new Set([...entries.keys(), ...places.keys()])],
        async inPlace(file: string): Promise<InPlaceCopy<H> | null> {
            const opened = await placeOpenFor(file);
            if (!opened) return null;
            const { entry, handle } = opened;
            // No await from placeOpenFor's last check to the hand-out: a close that begins later refuses the stand-in's statements.
            let made = stand.get(file);
            if (!made || made.entry !== entry) {
                made = { entry, handle: standIn(file, entry, handle) };
                stand.set(file, made);
                // The stand-in reads that file's DM pins and guard list, never the anchor's (db.ts dbFileOf).
                deps.register(made.handle, file);
            }
            return { handle: made.handle, open: () => entry.handle === handle && !refused(entry) && places.get(file) === entry };
        },
    };
}
