/**
 * The stager: a whole copy of the main server, built in pages in a staging database beside the live one, checked, and
 * swapped in by rename at the next start (design scratch/global-node/DESIGN-paged-copies-fable.md §4, P2).
 *
 * **Why a separate database, and a separate process.** A whole copy of a big community is more rows than one transaction
 * on the live connection can take without holding the event loop past the watchdog's minute (design §1, §4.1), and a
 * transaction left open across fetches would take in this server's own writes meanwhile and show readers a half-built
 * copy. So the copy is built from nothing in `data/staging/state.db`, never in the live file, by the importer as it is
 * (engine/sync.ts importRemoteState, one page at a time: ImportOptions.part), in a helper process whose data directory is
 * the staging one, so the importer's own `db` is the staging database and this server's event loop stays free. The
 * puller (services/backup-puller.ts) fetches each page, checks its signature and its place in the copy, writes it to
 * `data/staging/pages/<n>.json`, and tells the stager, which imports it in one transaction, deletes the file and answers.
 *
 * **The staging directory** holds the stager's database, copies of genesis.json, connectors.json (the mirror it trusts)
 * and local-config.json, and `images`, a link to the live `data/images`: photos land in the one content-addressed store.
 * Nothing in it is ever written back.
 *
 * **The closing checks** (`finish`, once the last page is in), before the copy may be swapped in:
 *  1. every page arrived once, in order: each category's and plain table's rows, counted as they came, are what the
 *     copy's last page says it sent (`rowsSent`), which are what its opening page counted in its snapshot (`rowCounts`),
 *     but for the listing photos the main server could not read (`photosOmitted`), which it counted and did not send;
 *     and every listing photo it brought has its object in the image store: a photo sent by reference (engine/sync.ts
 *     photoRowsByReference) has its row written as its page comes and its object fetched by the puller once every page
 *     is in (services/backup-puller.ts fetchPhotoObjects);
 *  2. the staging's tables against the copy's own table hashes (engine/replica-hashes.ts): the whole-copy check's verdict,
 *     recorded with the copy (a table this importer writes otherwise than the main server holds it is reported, and asks
 *     for the held force-resync at most every six hours; the values this database's rules refuse are reported alone);
 *  3. the conservation guard: the staging's ledger total against the live one's, within the tolerance, unless the puller
 *     took this copy as a seed; and a copy that is no seed must carry a ledger;
 *  4. then what this standby keeps of its own is carried over from the live database, read-only, in one read: every table
 *     the replication manifest (engine/replication-manifest.ts) keeps on each server (its logs, cursors and records, the
 *     node roles), each node_config key by its class, and the listing photos the copy left out (this standby's may be the
 *     only readable ones). A table or node_config key the manifest doesn't classify fails the copy: nothing is carried
 *     over, or dropped, by accident. Then the copy's records: its cursor, the importer's format, the standby's record of it.
 *
 * **The swap** (db/swap-at-boot.ts): the puller writes `data/staging/READY` and the server restarts; before the database
 * opens, `state.db` becomes `state.previous.db` and the staging database `state.db`. Nothing the copy did touched the live
 * file: a copy that fails anywhere, or a stager or a server that dies anywhere before READY, leaves it as it was, and the
 * staging is deleted (design §4.3).
 *
 * Run as a child: `node <this file> --stage-copy`, with BEANPOOL_DATA_DIR the staging directory.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { PhotoReference } from '../engine/sync.js';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
/** The staging directory, inside the data directory; the swap at boot knows it by this name too (db/swap-at-boot.ts). */
export const STAGING_DIR_NAME = 'staging';
/** Written by the puller once the stager's closing checks pass: the copy may be swapped in. */
export const READY_FILE = 'READY';
/**
 * Written when the staging directory is made: when the copy started (`at`, ms), which the orphan sweep reads (stagedObjects),
 * and which copy made it (`copy`, StagedCopy's stagingId), which a stopped copy reads before it deletes it (removeOwnStaging).
 */
const STARTED_FILE = 'STARTED';
/** Where the database the last swap replaced is kept until the new one passes its first check (services/backup-puller.ts deletePreviousDatabase). */
export const PREVIOUS_DB = 'state.previous.db';
/** The files the stager's boot reads from its data directory, copied in; never written back. */
const FILES_FOR_THE_STAGER = ['genesis.json', 'connectors.json', 'local-config.json'];
/**
 * What the stager's copy of local-config.json leaves out: this server's credentials (config/local-config.ts). The stager
 * signs in to nothing and nothing signs in to it, so data/staging, which a copy made ready keeps until the next start,
 * never holds a second copy of them: the admin password's hash and salt, the two-factor secrets and backup codes, the
 * recovery code's record, the claim code's record, the replication token's hash and a standby's own token, and a legacy standby's stored admin
 * password (test-standby-token-only's step 6 greps the data directory for it).
 */
const CREDENTIALS_LEFT_OUT = [
    'adminHash', 'salt', 'totpSecret', 'totpBackupCodesHashes', 'totpPendingSecret', 'totpPendingBackupCodesHashes', 'recoveryCode',
    'replicationTokenHash', 'replicationTokenSalt', 'backupReplicationToken', 'backupAdminPassword', 'automationTokens', 'claim',
];
/**
 * node_config: the copy this database was swapped in from, written by the stager into the staging database. The puller's
 * first start on it reads it once and deletes it (services/backup-puller.ts).
 */
export const SWAPPED_COPY_KEY = 'standby_swapped_copy';
/** A page the stager takes longer than this to import fails the copy (a stager that hangs). */
const PAGE_TIMEOUT_MS = 15 * 60_000;
/** The listing photos by reference the copy's pages named, a line each (StagedCopy.notePhotoReferences). */
const PHOTO_REFERENCES_FILE = 'photo-references.jsonl';

export function stagingDir(): string {
    return path.join(DATA_DIR, STAGING_DIR_NAME);
}

// ── The puller's side ──────────────────────────────────────────────────────────────────────

/** A copy the stager refused, and why, as the standby's report says it (services/standby-report.ts WhyCode). */
export class StagedCopyRefused extends Error {
    constructor(message: string, readonly why: 'conservation' | 'import-error') {
        super(message);
        this.name = 'StagedCopyRefused';
    }
}

/** What the stager's closing checks found in a copy they let through. */
export interface StagedCopyChecked {
    pages: number;
    rows: number;
    /** Every table hashed as the copy's hashes say: its tables and its values, but the photos the main server left out. */
    exact: boolean;
    /** The tables whose values this database's rules refused (reported, never refused). */
    differs: string[];
    /** The copy carried table hashes. */
    hashed: boolean;
    photosLeftOut: number;
    generatedAt: string | null;
    cursor: string | null;
}

let current: StagedCopy | null = null;

/**
 * Stop a copy being built, and throw its staging away: the stager killed, the staging directory deleted, a swap it had made
 * ready called off. A take-over confirmed while a copy is staging (services/takeover.ts), and the puller on any failure.
 * Never throws. Whether there was one.
 */
export function abortStagedCopy(why: string): boolean {
    const had = current !== null || fs.existsSync(stagingDir());
    if (current) current.abort(why);
    else removeStaging();
    return had;
}

/** Whether a copy is being built now, and its stager's PID. */
export function copyStaging(): { pid: number | null } | null {
    return current ? { pid: current.pid ?? null } : null;
}

/**
 * In the data directory, beside the staging one (which a failed copy deletes): the objects a pull that failed had fetched,
 * kept for the next (keepFetchedObjects).
 */
export const KEPT_OBJECTS_FILE = 'copy-objects-kept.json';

/**
 * The objects kept for the next pull (keepFetchedObjects) at `now`: those written from `since`, and how many the failed
 * pulls fetched. Null: none.
 */
function keptObjects(dataDir: string, now: number): { since: number; until: number; objects: number } | null {
    let kept: { since?: unknown; until?: unknown; objects?: unknown };
    try { kept = JSON.parse(fs.readFileSync(path.join(dataDir, KEPT_OBJECTS_FILE), 'utf-8')); } catch { return null; }
    const since = Number(kept?.since);
    const until = Number(kept?.until);
    // Unreadable, or past its time: nothing kept. No row names these objects, so the sweep deleting one costs only its
    // fetch again.
    if (!Number.isFinite(since) || !Number.isFinite(until) || now >= until) return null;
    const objects = Number(kept?.objects);
    return { since, until, objects: Number.isFinite(objects) && objects > 0 ? Math.floor(objects) : 0 };
}

/**
 * A pull failed after it had fetched listing photos' objects (services/backup-puller.ts): each object this server's store
 * holds that was written from `since` is kept from the orphan sweep until `until`, so the next pull, asked for after the
 * wait a failed one waits (RESYNC_RETRY_MS, an hour, and longer for each copy in a row whose photos could not all be
 * fetched), fetches only what the store still lacks (F5 of the standby review). No row names them, and the staging that
 * did is deleted; the sweep's hour of grace alone would have taken them by then. A delta's are kept too: one whose photo
 * the main server can't send is asked for every minute, for as long as it can't. Kept from the earliest `since` of the
 * pulls that failed since the objects were last let go, to the latest `until`; `objects` (this pull's fetches) added to
 * the count Settings shows. A pull that failed before it fetched anything (`since` null) only moves `until` on, when
 * objects are kept: its next is due later than the kept ones' was. Let go when a whole copy lands (releaseFetchedObjects)
 * or once `until` has passed. Never throws.
 */
export function keepFetchedObjects(since: number | null, until: number, objects = 0): void {
    const prev = keptObjects(DATA_DIR, Date.now());
    if (since === null && !prev) return;
    const kept = {
        since: Math.min(prev?.since ?? Infinity, since ?? Infinity),
        until: Math.max(prev?.until ?? 0, until),
        objects: (prev?.objects ?? 0) + Math.max(0, objects),
    };
    const file = path.join(DATA_DIR, KEPT_OBJECTS_FILE);
    try {
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(kept));
        fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
        console.warn(`[Stager] The objects a failed copy fetched could not be kept for the next: ${(e as Error)?.message || e}`);
    }
}

/** How many objects failed pulls fetched that are kept for the next now (keepFetchedObjects); null: none kept. */
export function fetchedObjectsKept(now = Date.now()): number | null {
    return keptObjects(DATA_DIR, now)?.objects ?? null;
}

/** A whole copy landed, or was made ready: the objects kept for it (keepFetchedObjects) are the sweep's to judge again. */
export function releaseFetchedObjects(): void {
    try { fs.rmSync(path.join(DATA_DIR, KEPT_OBJECTS_FILE), { force: true }); } catch { /* the sweep lets it go at its time */ }
}

/**
 * The image store objects the standby's orphan sweep (engine/storage-health.ts) must keep while a whole copy is staging in
 * `dataDir`'s staging directory, being built or made ready (review 4139589323). The stager puts each listing photo's
 * object into the one image store (data/staging/images is a link to data/images), and until the swap only the staging
 * database names it; a copy that takes longer than the sweep's hour of grace would otherwise lose them. So: every object
 * the staging database names (its listing and chat photos), and every object written since the copy started (a page's
 * photos are put before its rows commit). And, at `now`, those a whole copy that failed fetched, kept for the next
 * (keepFetchedObjects): every object written since the first of them. Null: nothing kept. Throws when the staging database
 * is there and can't be read: the sweep then judges nothing an orphan.
 */
export function stagedObjects(dataDir: string, now = Date.now()): { since: number; keys: Set<string> } | null {
    const dir = path.join(dataDir, STAGING_DIR_NAME);
    const kept = keptObjects(dataDir, now);
    if (!fs.existsSync(dir)) return kept ? { since: kept.since, keys: new Set() } : null;
    // No start written yet (the directory being made), or unreadable: every object is newer than it.
    let since = 0;
    try { since = Number(JSON.parse(fs.readFileSync(path.join(dir, STARTED_FILE), 'utf-8'))?.at) || 0; } catch { since = 0; }
    const keys = new Set<string>();
    const file = path.join(dir, 'state.db');
    if (fs.existsSync(file)) {
        const conn = new Database(file, { readonly: true, fileMustExist: true });
        try {
            for (const t of ['post_photos', 'message_attachments']) {
                if ((conn.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = 'storage_key'`).get(t) as { n: number }).n === 0) continue;
                for (const [key] of conn.prepare(`SELECT storage_key FROM ${t} WHERE storage_key IS NOT NULL`).raw().iterate() as Iterable<[string]>) keys.add(key);
            }
        } finally {
            conn.close();
        }
    }
    return { since: kept ? Math.min(kept.since, since) : since, keys };
}

function removeStaging(): void {
    try { fs.rmSync(stagingDir(), { recursive: true, force: true }); } catch (e) {
        console.warn(`[Stager] The staging directory could not be deleted: ${(e as Error)?.message || e}`);
    }
}

/**
 * The staging directory deleted by the copy that made it (`stagingId`, STARTED's `copy`), never by one before it. A stopped
 * copy's stager is seen to exit only once this process's event loop gets to it, tens of ms after the kill on a busy machine,
 * and the next pull's copy can make its own staging sooner: a pull that follows a failed one at once (the next tick, an
 * operator's resync) needs only an answer from the main server. That copy, its staging deleted under it, failed at its
 * first page (ENOENT) or wherever it was (CI runs 36794955035, 36808165404, 36807832381, 36809568179). A staging that
 * names no copy (unreadable, or made again by a stager killed as it wrote) is nobody's, and goes. Never throws.
 */
function removeOwnStaging(stagingId: string): void {
    let maker: unknown = null;
    try { maker = JSON.parse(fs.readFileSync(path.join(stagingDir(), STARTED_FILE), 'utf-8'))?.copy; } catch { /* none: nobody's */ }
    if (typeof maker === 'string' && maker !== stagingId) return;
    removeStaging();
}

/** The staging directory, made afresh by the copy `stagingId`: the stager's files copied in, and the one image store linked. */
function prepareStagingDir(stagingId: string): string {
    const dir = stagingDir();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(dir, STARTED_FILE), JSON.stringify({ at: Date.now(), copy: stagingId }));
    for (const name of FILES_FOR_THE_STAGER) {
        const from = path.join(DATA_DIR, name);
        if (!fs.existsSync(from)) continue;
        if (name !== 'local-config.json') {
            fs.copyFileSync(from, path.join(dir, name));
            continue;
        }
        // One this server can't read gives the stager none: it runs on the defaults, as a server with no local config does.
        let config: Record<string, unknown>;
        try { config = JSON.parse(fs.readFileSync(from, 'utf-8')); } catch { continue; }
        for (const k of CREDENTIALS_LEFT_OUT) delete config[k];
        fs.writeFileSync(path.join(dir, name), JSON.stringify(config, null, 2), { mode: 0o600 });
    }
    fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });
    fs.symlinkSync(path.join('..', 'images'), path.join(dir, 'images'), 'dir');
    return dir;
}

/**
 * Room for a second copy of the database: the live file and its WAL, and a margin. The database the last swap replaced
 * (PREVIOUS_DB, `previous`) counts as room: the puller deletes it first when the copy needs it. A copy that would fill the
 * disk is not started, and says so. One that fills it anyway fails in the stager, which says the disk refused it, and
 * leaves the live file as it was: another writer, or a first copy, whose size nothing here knows before it comes (the live
 * database is then a new standby's own, nearly empty).
 */
export function roomForStaging(): { ok: boolean; need: number; free: number; previous: number } {
    const size = (files: string[]) => files.reduce((n, f) => {
        try { return n + fs.statSync(path.join(DATA_DIR, f)).size; } catch { return n; }
    }, 0);
    const live = size(['state.db', 'state.db-wal']);
    const previous = size([PREVIOUS_DB, `${PREVIOUS_DB}-wal`, `${PREVIOUS_DB}-shm`]);
    const need = Math.ceil(live * 1.1) + 64 * 1024 * 1024;
    const free = freeBytesForTests ?? (() => {
        try {
            const s = fs.statfsSync(DATA_DIR);
            return s.bavail * s.bsize;
        } catch { return Number.MAX_SAFE_INTEGER; }
    })();
    return { ok: free + previous >= need, need, free, previous };
}
let freeBytesForTests: number | null = null;
export function _setFreeBytesForTests(n: number | null): void { freeBytesForTests = n; }

/** A whole copy being built: its stager process, and the pages sent to it. */
export class StagedCopy {
    private readonly waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private seq = 0;
    private aborted: string | null = null;
    /** Why the stager is gone, once it has stopped and everything it wrote has been read. */
    private gone: string | null = null;
    private readonly exited: Promise<number | null>;
    /** The stager has stopped, and its output is read to the end (its last answer included). */
    private readonly closed: Promise<number | null>;

    private constructor(
        readonly copyId: string, readonly dir: string, private readonly proc: ChildProcess, private readonly ready: Promise<void>,
        /** This copy's own mark on the staging directory it made (STARTED's `copy`): it deletes that one only. */
        private readonly stagingId: string,
    ) {
        this.exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve(code ?? (signal ? -1 : null))));
        this.closed = new Promise((resolve) => proc.on('close', (code, signal) => resolve(code ?? (signal ? -1 : null))));
        // A page written to a stager that has stopped fails (EPIPE); what the copy reports is the stop itself, below.
        proc.stdin?.on('error', () => { /* the stager stopped */ });
        // Every page or check waiting fails, and so does any sent after: a stager that dies between two pages (while the
        // next is fetched) fails the copy at that page, not PAGE_TIMEOUT_MS later (review 4139589571).
        void this.closed.then((code) => {
            this.gone = this.aborted ?? `the stager stopped (${code})`;
            for (const w of this.waiting.values()) w.reject(new StagedCopyRefused(`The copy could not be built: ${this.gone}`, 'import-error'));
            this.waiting.clear();
        });
    }

    /** The staging directory made afresh, and a stager started on it. One at a time. */
    static async start(copyId: string): Promise<StagedCopy> {
        if (current) throw new Error('A whole copy is already being built');
        const stagingId = crypto.randomUUID();
        const dir = prepareStagingDir(stagingId);
        const script = fileURLToPath(import.meta.url);
        const proc = spawn(process.execPath, [...process.execArgv, script, '--stage-copy'], {
            // A standby, whatever told this process so (its .env, its local config, or a role set while it runs).
            env: { ...process.env, BEANPOOL_DATA_DIR: dir, NODE_ROLE: 'backup' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let readyResolve!: () => void;
        let readyReject!: (e: Error) => void;
        const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        const staged = new StagedCopy(copyId, dir, proc, ready, stagingId);
        current = staged;
        readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
            if (!line.startsWith('@@ ')) {
                console.log(`[Stager] ${line}`);
                return;
            }
            let msg: any;
            try { msg = JSON.parse(line.slice(3)); } catch { return; }
            if (msg.ready) { readyResolve(); return; }
            const w = staged.waiting.get(msg.reply);
            if (!w) return;
            staged.waiting.delete(msg.reply);
            if (msg.error) w.reject(new StagedCopyRefused(msg.error, msg.why === 'conservation' ? 'conservation' : 'import-error'));
            else w.resolve(msg.result);
        });
        readline.createInterface({ input: proc.stderr! }).on('line', (line) => console.warn(`[Stager] ${line}`));
        void staged.closed.then((code) => readyReject(new StagedCopyRefused(`The stager stopped before it was ready (${code})`, 'import-error')));
        try {
            await ready;
        } catch (e) {
            staged.abort('its stager did not start');
            throw e;
        }
        return staged;
    }

    get pid(): number | undefined {
        return this.proc.pid;
    }

    private send<T>(cmd: string, args: Record<string, unknown>, timeoutMs = PAGE_TIMEOUT_MS): Promise<T> {
        if (this.aborted) return Promise.reject(new StagedCopyRefused(`The copy was stopped: ${this.aborted}`, 'import-error'));
        if (this.gone) return Promise.reject(new StagedCopyRefused(`The copy could not be built: ${this.gone}`, 'import-error'));
        const id = ++this.seq;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new StagedCopyRefused(`The stager did not answer in ${Math.round(timeoutMs / 1000)} s`, 'import-error'));
            }, timeoutMs);
            timer.unref();
            this.waiting.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            this.proc.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n');
        });
    }

    /** Page `n` of the copy, as the main server sent it (checked by the puller), imported by the stager. */
    async page(n: number, text: string): Promise<void> {
        const file = path.join(this.dir, 'pages', `${n}.json`);
        fs.writeFileSync(file, text);
        await this.send('page', { n, file });
    }

    /**
     * The listing photos a page names by reference (engine/sync.ts photoRowsByReference), kept in the staging directory, not
     * in memory, until every page is in and the puller fetches the objects this server's store lacks (photoReferences).
     */
    notePhotoReferences(refs: readonly PhotoReference[]): void {
        if (refs.length === 0) return;
        fs.appendFileSync(path.join(this.dir, PHOTO_REFERENCES_FILE), refs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }

    /**
     * Every listing photo by reference the copy's pages named, in page order (notePhotoReferences). The file is closed however
     * the reading ends: read to its end, or returned early (a fetch that failed, services/backup-puller.ts fetchPhotoObjects),
     * or a line that doesn't parse. Left open, each failed copy would hold a descriptor on its deleted file, and its blocks,
     * until this process restarts (review 4148896385).
     */
    async *photoReferences(): AsyncGenerator<PhotoReference> {
        const file = path.join(this.dir, PHOTO_REFERENCES_FILE);
        if (!fs.existsSync(file)) return;
        const input = fs.createReadStream(file, 'utf-8');
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        try {
            for await (const line of lines) if (line) yield JSON.parse(line) as PhotoReference;
        } finally {
            lines.close();
            input.destroy();
        }
    }

    /**
     * The closing checks, and what this standby keeps of its own carried over from `live` (its database), read-only. `seed`:
     * the puller took this copy as a seed (the conservation guard lets it in whatever it sums to). `resync`: a force-resync
     * of any kind, which owes nothing any more for the deletes the main server pruned. Refused: StagedCopyRefused.
     */
    finish(args: { seed: boolean; resync: boolean }): Promise<StagedCopyChecked> {
        return this.send('finish', { ...args, live: path.join(DATA_DIR, 'state.db') });
    }

    /** The copy is checked and complete: READY written, so the next start swaps it in (db/swap-at-boot.ts). */
    markReady(info: Record<string, unknown>): void {
        if (this.aborted) throw new StagedCopyRefused(`The copy was stopped: ${this.aborted}`, 'import-error');
        fs.writeFileSync(path.join(this.dir, READY_FILE), JSON.stringify({ copyId: this.copyId, ...info }, null, 2));
        if (current === this) current = null;
    }

    /** Stopped: the stager killed by its PID, the staging deleted. Never throws. */
    abort(why: string): void {
        if (this.aborted) return;
        this.aborted = why;
        if (current === this) current = null;
        if (this.proc.exitCode === null && this.proc.signalCode === null) {
            try { this.proc.kill('SIGKILL'); } catch { /* gone */ }
        }
        removeOwnStaging(this.stagingId);
        // What the stager was writing when it was killed goes too, once it has stopped: unless the next copy has made its
        // own staging by then (removeOwnStaging).
        void this.exited.then(() => { if (!fs.existsSync(path.join(stagingDir(), READY_FILE))) removeOwnStaging(this.stagingId); });
        console.warn(`[Stager] The whole copy being built was stopped and its staging deleted: ${why}`);
    }

    /** Why this copy was stopped (abort: a take-over confirmed, or any failure) or can't be built (its stager gone); null while it goes on. */
    get stoppedBecause(): string | null {
        return this.aborted ?? this.gone;
    }

    /** The stager has stopped. */
    stopped(): Promise<number | null> {
        return this.exited;
    }
}

// ── The stager process ─────────────────────────────────────────────────────────────────────

/**
 * node_config keys whose value the copy decides, though each server keeps its own (the manifest's `per-server`): the
 * importer, or the stager's records of the copy, write them into the staging database, and a copy that brings none keeps
 * the live database's.
 */
const FROM_THE_COPY = new Set([
    'replica_main_ledger', 'replica_community_settings', 'replicated_member_blocks_v1', 'replicated_invalidated_keys_v1', 'replica_format',
]);

function reply(msg: Record<string, unknown>, then?: () => void): void {
    process.stdout.write('@@ ' + JSON.stringify(msg) + '\n', () => then?.());
}

/** A copy's rows per category, and per plain table under `plainTables`, as a page carries them. */
type Counts = Record<string, number> & { plainTables?: Record<string, number> };

async function stagerChild(): Promise<void> {
    const { ensureGenesis } = await import('../genesis.js');
    const { initStateEngine, importCopyPart, setSyncCursor, getNodeRole } = await import('../state-engine.js');
    const { loadConnectors } = await import('../connector-manager.js');
    const { db } = await import('../db/db.js');
    const { TABLES, nodeConfigKeyEntry, isInternalTable, travellingRows } = await import('../engine/replication-manifest.js');
    const { copyPartOf, noteMainLedger, noteReplicaFormat, valueLeftOutName, LEDGER_CONSERVATION_TOLERANCE } = await import('../engine/sync.js');
    const { isWellFormedKey } = await import('@beanpool/engine');
    const { tableContentHashes, readTableHashes } = await import('../engine/replica-hashes.js');
    const { emptyCopiedTables } = await import('../engine/copied-tables.js');
    const { noteMainServerEpoch } = await import('./recovery-seal-key.js');
    const { keepMainServerRecords, LEDGER_RESYNC_EVERY_MS } = await import('./backup-puller.js');
    const { noteCopyLanded, noteWholeCopyCheck, noteUncomparedCheck, noteWholeCopyTaken, readCopyRecord } = await import('./standby-copy-record.js');
    const { LEDGER_DIFFERS } = await import('./standby-report.js');
    const { getImageStore, scanOurObjectsAsync } = await import('../storage/image-store.js');

    await ensureGenesis();
    initStateEngine();
    loadConnectors();
    if (getNodeRole() !== 'backup') throw new Error('the stager runs on a standby only');

    // The staging holds the copy and nothing else: what this start seeded of the copied tables goes (engine/copied-tables.ts).
    const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
    const has = (conn: InstanceType<typeof Database>, table: string) =>
        (conn.prepare('SELECT COUNT(*) AS n FROM pragma_table_info(?)').get(table) as { n: number }).n > 0;
    const seeded = emptyCopiedTables(db);
    if (seeded > 0) console.log(`[Stager] ${seeded} row(s) this start seeded in the copied tables removed: the copy brings its own.`);

    let part: ReturnType<typeof copyPartOf> | null = null;
    let copyId: string | null = null;
    let opening: Record<string, any> | null = null;
    let closing: Record<string, any> | null = null;
    let next = 0;
    const received: Counts = {};
    const accounts: { publicKey: string; balance: number }[] = [];
    // The values this database's rules refused, as the copy named them, for the hash check (engine/replica-hashes.ts).
    const membersLeftOut = new Map<string, Record<string, unknown>>();
    const valuesLeftOutNames: string[] = [];
    const plainLeftOut = new Set<string>();
    const plainLeftOutEntries: string[] = [];
    let unreadableAccounts = 0;

    const count = (page: Record<string, any>) => {
        for (const key of Object.keys(part!.rowCounts)) {
            if (key === 'plainTables') continue;
            if (Array.isArray(page[key])) received[key] = (received[key] ?? 0) + page[key].length;
        }
        if (page.plainTables && typeof page.plainTables === 'object') {
            for (const [t, rows] of Object.entries(page.plainTables)) {
                if (Array.isArray(rows)) (received.plainTables ??= {})[t] = ((received.plainTables ??= {})[t] ?? 0) + rows.length;
            }
        }
    };

    const importPage = async (a: { n: number; file: string }) => {
        const page = JSON.parse(fs.readFileSync(a.file, 'utf-8'));
        if (a.n !== next || page?.n !== a.n) throw new Error(`page ${page?.n} came as page ${a.n}, where page ${next} was next`);
        if (a.n === 0) {
            if (typeof page.copyId !== 'string' || !page.rowCounts || typeof page.rowCounts !== 'object') throw new Error('the first page is no copy\'s opening page');
            part = copyPartOf(page);
            copyId = page.copyId;
            opening = page;
        } else if (page.copyId !== copyId) {
            throw new Error(`page ${a.n} is another copy's (${String(page.copyId).slice(0, 8)})`);
        }
        const result = await importCopyPart(page, part!);
        count(page);
        for (const acc of Array.isArray(page.accounts) ? page.accounts : []) {
            if (typeof acc?.publicKey === 'string') accounts.push({ publicKey: acc.publicKey, balance: acc.balance });
            if (typeof acc?.publicKey !== 'string' || !acc.publicKey || !isWellFormedKey(acc.publicKey) || typeof acc.balance !== 'number') unreadableAccounts++;
        }
        for (const v of result.valuesLeftOut) valuesLeftOutNames.push(valueLeftOutName(v));
        plainLeftOutEntries.push(...result.plainTablesLeftOut);
        if (result.valuesLeftOut.length > 0) {
            const standingOf = new Map((Array.isArray(page.members) ? page.members : []).map((m: any) => [m?.publicKey, m?.standing]));
            for (const v of result.valuesLeftOut) {
                const standing = standingOf.get(v.publicKey) as Record<string, unknown> | undefined;
                if (!standing || !Object.hasOwn(standing, v.column)) continue;
                membersLeftOut.set(v.publicKey, { ...(membersLeftOut.get(v.publicKey) ?? {}), [v.column]: standing[v.column] });
            }
        }
        for (const x of result.plainTablesLeftOut) {
            const t = x.slice(0, x.indexOf(':'));
            if (t) plainLeftOut.add(t);
        }
        if (page.last === true) closing = page;
        next++;
        fs.rmSync(a.file, { force: true });
        return { n: a.n };
    };

    const finish = async (a: { seed: boolean; resync: boolean; live: string }): Promise<Record<string, unknown>> => {
        if (!part || !opening || !closing) throw new Error('the copy\'s last page never came');
        const refused = (msg: string, why: 'conservation' | 'import-error' = 'import-error') => Object.assign(new Error(msg), { why });

        // 1. Every page once, in order: the rows that came are the rows the copy says it sent, which are the rows it
        //    counted in its snapshot, but for the photos it could not read (counted, and not sent).
        const photosOmitted: string[] = (Array.isArray(closing.photosOmitted) ? closing.photosOmitted : []).filter((k: unknown): k is string => typeof k === 'string');
        const sent: Counts = closing.rowsSent && typeof closing.rowsSent === 'object' ? closing.rowsSent : {};
        const counted = part.rowCounts as Counts;
        const off: string[] = [];
        const compare = (name: string, got: number, said: unknown, snap: unknown, omitted = 0) => {
            if (got !== said || (typeof snap === 'number' && snap !== got + omitted) || typeof said !== 'number') {
                off.push(`${name} ${got} came, ${String(said)} sent, ${String(snap)} in the copy${omitted ? ` (${omitted} left out)` : ''}`);
            }
        };
        for (const key of new Set([...Object.keys(counted), ...Object.keys(sent)])) {
            if (key === 'plainTables') continue;
            compare(key, received[key] ?? 0, sent[key], counted[key], key === 'photos' ? photosOmitted.length : 0);
        }
        const plainSent = sent.plainTables ?? {};
        const plainCounted = counted.plainTables ?? {};
        for (const t of new Set([...Object.keys(plainCounted), ...Object.keys(plainSent), ...Object.keys(received.plainTables ?? {})])) {
            compare(`plainTables.${t}`, received.plainTables?.[t] ?? 0, plainSent[t], plainCounted[t]);
        }
        const pages = Number(closing.pages);
        if (pages !== next) off.push(`${next} page(s) came, the copy says ${String(closing.pages)}`);
        if (off.length > 0) throw refused(`The copy's pages don't add up to what it says it holds: ${off.slice(0, 6).join('; ')}`);
        const rows = Object.entries(received).reduce((n, [k, v]) => n + (k === 'plainTables' ? 0 : v as number), 0)
            + Object.values(received.plainTables ?? {}).reduce((n, v) => n + v, 0);

        // 1b. Every listing photo the copy brought has its object in the image store: the importer put it before its row
        //     committed, or, sent by reference, the puller fetched it once every page was in, and nothing may have removed it
        //     since (the standby's orphan sweep keeps a staging's objects: stagedObjects). Swapped in without them, those
        //     listings would show no photo, the check would call the copy exact, and no delta would bring them back (review
        //     4139589323). The photos the main server left out are this standby's own rows, carried over below, as they were.
        const named = db.prepare('SELECT storage_key FROM post_photos WHERE storage_key IS NOT NULL').pluck().all() as string[];
        if (named.length > 0) {
            let stored: Set<string>;
            try {
                stored = new Set((await scanOurObjectsAsync(getImageStore())).map((o) => o.key));
            } catch (e: any) {
                throw refused(`The image store could not be listed to check the copy's listing photos: ${e?.message || e}`);
            }
            const missing = named.filter((k) => !stored.has(k));
            if (missing.length > 0) {
                throw refused(`${missing.length} of the copy's ${named.length} listing photo(s) have no object in this server's image store `
                    + `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`);
            }
        }

        // 2. The copy's table hashes, made in its snapshot, against the staging's: the whole-copy check's verdict
        //    (services/backup-puller.ts checkWholeCopy), recorded with the copy. Every page came once, signed, and the counts
        //    add up, so a table that differs is one this importer writes otherwise than the main server holds it: reported,
        //    and the held force-resync asked for at most every six hours, as for any whole copy that doesn't match; never a
        //    reason to keep the older copy, which the same importer wrote. The values this database's rules refuse are
        //    reported on their own and ask for none. A copy with no hashes gives no verdict.
        const theirs = readTableHashes(closing.tableHashes);
        const valuesDiffer = new Set<string>([...plainLeftOut, ...(membersLeftOut.size > 0 ? ['members'] : [])]);
        const mendable: string[] = [];
        if (theirs) {
            const mine = tableContentHashes({ photosLeftOut: new Set(photosOmitted), membersLeftOut }).tables;
            for (const [t, h] of Object.entries(theirs)) {
                if (mine[t] === undefined || plainLeftOut.has(t) || (mine[t].rows === h.rows && mine[t].hash === h.hash)) continue;
                mendable.push(t === 'accounts' ? LEDGER_DIFFERS.ledger : t);
                console.warn(`[Stager] ${t} differs from the copy's own hash of it (${mine[t].rows} rows here, ${h.rows} there): not exact.`);
            }
        }
        const differs = new Set<string>([...valuesDiffer, ...mendable]);

        /**
         * The whole-copy check's report of this copy (engine audit.ts ReplicaConsistency), as the status shows it after the
         * swap (services/backup-puller.ts): each copied table's rows here against the rows the copy counted in its snapshot
         * (the photos it left out apart), the ledger (every account the copy's own, by construction; its entries with no key
         * this server can store counted), and the values this database's rules refused.
         */
        const consistencyOf = (now: number) => {
            const tables: { name: string; primary: number; backup: number; match: boolean }[] = [];
            for (const [t, e] of Object.entries(TABLES)) {
                if ((e.kind !== 'replicated' && e.kind !== 'replicated-except') || e.inRowOf || !has(db, t)) continue;
                const snap = e.payload === 'plainTables' ? counted.plainTables?.[t] : counted[e.payload];
                if (typeof snap !== 'number') continue;
                const primary = t === 'post_photos' ? snap - photosOmitted.length : snap;
                const where = travellingRows(t);
                const backup = (db.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}${where ? ` WHERE (${where})` : ''}`).get() as { n: number }).n;
                tables.push({ name: t, primary, backup, match: primary === backup });
            }
            const copyTotal = accounts.reduce((n, x) => n + (typeof x.balance === 'number' && Number.isFinite(x.balance) ? x.balance : 0), 0);
            const hereTotal = (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s;
            return {
                checkedAt: new Date(now).toISOString(),
                snapshotGeneratedAt: typeof opening!.generatedAt === 'string' ? opening!.generatedAt : null,
                tables,
                sumBalances: { primary: copyTotal, backup: hereTotal, match: Math.abs(copyTotal - hereTotal) < 0.005 },
                commons: null,
                ledger: accounts.length > 0
                    ? { compared: accounts.length - unreadableAccounts, differing: 0, unreadable: unreadableAccounts, examples: [], match: unreadableAccounts === 0 }
                    : null,
                valuesLeftOut: valuesLeftOutNames.length > 0 ? { count: valuesLeftOutNames.length, examples: valuesLeftOutNames.slice(0, 5) } : null,
                plainTablesLeftOut: plainLeftOutEntries.length > 0
                    ? { count: plainLeftOutEntries.length, tables: [...plainLeftOut].sort(), examples: plainLeftOutEntries.slice(0, 5) } : null,
                ok: differs.size === 0 && !!theirs && tables.every((t) => t.match),
            };
        };

        // 3. The conservation guard, against this standby's live ledger, and what it keeps of its own, read in one read.
        const live = new Database(a.live, { readonly: true, fileMustExist: true });
        try {
            live.exec('BEGIN');
            const stagedTotal = (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s;
            const liveTotal = (live.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s;
            const stagedAccounts = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
            if (!a.seed && stagedAccounts === 0) {
                throw refused('[Sync] Conservation violation: a whole copy that carries no ledger; rejecting it', 'conservation');
            }
            if (!a.seed && Math.abs(stagedTotal - liveTotal) > LEDGER_CONSERVATION_TOLERANCE) {
                throw refused(`[Sync] Conservation violation: the copy's ledger totals ${stagedTotal.toFixed(4)} and this standby's ${liveTotal.toFixed(4)}, `
                    + `a shift of ${(stagedTotal - liveTotal).toFixed(4)} (> ${LEDGER_CONSERVATION_TOLERANCE}); rejecting value-creating copy`, 'conservation');
            }

            // 4. What this standby keeps of its own. Every table is classified, and every node_config key.
            const tablesOf = (conn: InstanceType<typeof Database>) => (conn.prepare(
                `SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'shadow', 'virtual')`,
            ).all() as { name: string; type: string }[]);
            const unclassified: string[] = [];
            const keep: string[] = [];
            const liveTables = new Map(tablesOf(live).map((t) => [t.name, t.type]));
            for (const [name, type] of new Map([...tablesOf(db).map((t) => [t.name, t.type] as const), ...liveTables])) {
                if (isInternalTable(name, type) || type === 'virtual') continue;
                const entry = TABLES[name];
                if (!entry) { unclassified.push(`table ${name}`); continue; }
                if ((entry.kind === 'local' || entry.kind === 'takeover-bundle') && name !== 'node_config') keep.push(name);
            }
            const liveConfig = new Map((live.prepare('SELECT key, value FROM node_config').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
            const stagedConfig = new Map((db.prepare('SELECT key, value FROM node_config').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
            for (const key of new Set([...liveConfig.keys(), ...stagedConfig.keys()])) {
                if (!nodeConfigKeyEntry(key)) unclassified.push(`node_config ${key}`);
            }
            if (unclassified.length > 0) {
                throw refused(`The replication manifest does not say whether a standby keeps these of its own: ${unclassified.slice(0, 6).join(', ')}. `
                    + 'Nothing is carried over from the live copy, or dropped, by accident: the copy is refused');
            }

            db.transaction(() => {
                const columnsOf = (conn: InstanceType<typeof Database>, t: string) =>
                    (conn.prepare('SELECT name FROM pragma_table_info(?)').all(t) as { name: string }[]).map((c) => c.name);
                for (const t of keep) {
                    if (has(db, t)) db.prepare(`DELETE FROM ${q(t)}`).run();
                    if (!has(db, t) || !liveTables.has(t)) continue;
                    const here = new Set(columnsOf(db, t));
                    const cols = columnsOf(live, t).filter((c) => here.has(c));
                    if (cols.length === 0) continue;
                    const insert = db.prepare(`INSERT INTO ${q(t)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
                    for (const row of live.prepare(`SELECT ${cols.map(q).join(', ')} FROM ${q(t)}`).raw().iterate() as Iterable<unknown[]>) insert.run(...row);
                }
                // Each node_config key by its class: what the copy decides (the payload's records, and a standby's own records
                // of its copy), from the copy, or this standby's when the copy brings none; this database's own boot markers,
                // the staging's; everything else this standby's, as it is.
                const set = db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)');
                const drop = db.prepare('DELETE FROM node_config WHERE key = ?');
                for (const key of new Set([...liveConfig.keys(), ...stagedConfig.keys()])) {
                    const entry = nodeConfigKeyEntry(key)!;
                    const theDatabase = key.startsWith('migration_') && entry.kind === 'per-server';
                    const fromCopy = entry.kind === 'payload' || FROM_THE_COPY.has(key);
                    if (theDatabase) continue;
                    if (fromCopy && stagedConfig.has(key)) continue;
                    if (liveConfig.has(key)) set.run(key, liveConfig.get(key)!);
                    else drop.run(key);
                }
                // The listing photos the main server could not read: this standby's own rows of them, which may be the only
                // readable ones left (engine/sync.ts photoRowsByReference).
                if (photosOmitted.length > 0 && has(live, 'post_photos')) {
                    const here = new Set(columnsOf(db, 'post_photos'));
                    const cols = columnsOf(live, 'post_photos').filter((c) => here.has(c));
                    const insert = db.prepare(`INSERT OR REPLACE INTO post_photos (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
                    let kept = 0;
                    for (const row of live.prepare(`SELECT ${cols.map(q).join(', ')} FROM post_photos WHERE (post_id || '|' || order_num) IN (SELECT value FROM json_each(?))`)
                        .raw().iterate(JSON.stringify(photosOmitted)) as Iterable<unknown[]>) {
                        insert.run(...row);
                        kept++;
                    }
                    console.log(`[Stager] The main server could not read ${photosOmitted.length} listing photo(s) of its own: kept this standby's ${kept}.`);
                }

                // The copy's records, over what was carried: its main server's profile and settings, and each whole set it
                // carries (services/backup-puller.ts keepMainServerRecords); its ledger; the importer's format; its cursor.
                // Read as the whole payload read: each category the copy carries named, with or without rows on page 0.
                const carried = Object.fromEntries(Object.keys(part!.rowCounts).filter((k) => k !== 'plainTables').map((k) => [k, []]));
                keepMainServerRecords({ ...carried, ...opening } as any, true);
                noteMainLedger(accounts as any, typeof opening!.generatedAt === 'string' ? opening!.generatedAt : null);
                // The seal epoch the copy names, as an import keeps it (services/recovery-seal-key.ts): the recovery seal's
                // look at the start on this database (before the puller's) then clears under it.
                noteMainServerEpoch(opening!.sealEpoch);
                noteReplicaFormat();
                if (typeof opening!.cursor === 'string') setSyncCursor('backup:primary', opening!.cursor);
                const now = Date.now();
                const exact = differs.size === 0 && !!theirs;
                const generatedAt = typeof opening!.generatedAt === 'string' ? opening!.generatedAt : null;
                noteCopyLanded(now, { whole: true, leftOut: [], resync: a.resync });
                if (theirs) {
                    // The held force-resync, as the whole-copy check asks for it: at most one in six hours, restarts
                    // included (the record's last ask); the puller takes it at its first pull (nextMode).
                    const resyncAsked = mendable.length > 0 && now - (readCopyRecord().lastMismatchResyncAt ?? 0) >= LEDGER_RESYNC_EVERY_MS;
                    noteWholeCopyCheck({
                        at: now, exact, differs: [...differs].sort(), ledgerDiffering: 0, hashed: true, photosLeftOut: photosOmitted.length,
                        resyncAsked, snapshotGeneratedAt: generatedAt,
                    });
                } else {
                    noteUncomparedCheck({ at: now, notCompared: ['content'], photosLeftOut: photosOmitted.length, snapshotGeneratedAt: generatedAt });
                }
                noteWholeCopyTaken({ at: now, pages, generatedAt: typeof opening!.generatedAt === 'string' ? opening!.generatedAt : null });
                set.run(SWAPPED_COPY_KEY, JSON.stringify({
                    copyId, generatedAt: opening!.generatedAt ?? null, cursor: opening!.cursor ?? null, sealEpoch: opening!.sealEpoch ?? null,
                    pages, rows, at: now, consistency: consistencyOf(now),
                }));
            })();
            live.exec('COMMIT');
            return {
                pages, rows, exact: differs.size === 0 && !!theirs, differs: [...differs].sort(), hashed: !!theirs, photosLeftOut: photosOmitted.length,
                generatedAt: opening.generatedAt ?? null, cursor: opening.cursor ?? null,
            };
        } finally {
            live.close();
        }
    };

    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', async (line) => {
        let id = 0;
        try {
            const msg = JSON.parse(line);
            id = msg.id;
            if (msg.cmd === 'page') {
                reply({ reply: id, result: await importPage(msg.args) });
            } else if (msg.cmd === 'finish') {
                const result = await finish(msg.args);
                db.pragma('wal_checkpoint(TRUNCATE)');
                db.close();
                reply({ reply: id, result }, () => process.exit(0));
            } else {
                throw new Error(`no such command ${msg.cmd}`);
            }
        } catch (e: any) {
            console.error(`[Stager] ${e?.message || e}`);
            const message = e?.message || String(e);
            // A write the disk refused (full, or this process's files capped), SQLite's or the image store's: said as what it
            // is, since a first copy's size is known to nothing before it comes (roomForStaging), with the error after.
            const refusedByDisk = /^SQLITE_(FULL|IOERR)|^(ENOSPC|EFBIG|EDQUOT)$/.test(String(e?.code ?? ''));
            reply({
                reply: id,
                error: refusedByDisk ? `This server's disk refused the whole copy being built: no room on it for a second copy of its database, or a failing disk (${message})` : message,
                why: e?.why ?? (/conservation/i.test(String(e?.message)) ? 'conservation' : 'import-error'),
            });
        }
    });
    // The puller gone, the copy is gone: nothing here outlives it.
    rl.on('close', () => process.exit(1));
    reply({ ready: true });
}

if (process.argv.includes('--stage-copy') && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    stagerChild().catch((e) => {
        console.error(`[Stager] It could not start: ${e?.stack || e}`);
        process.exit(1);
    });
}
