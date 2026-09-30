/**
 * The open door's key (engine/open-join.ts): the HMAC key its `join_hash` is made with, over a provider and the
 * provider's `sub`, and the limiters' address hashes. Kept in a file beside the recovery seal's key, never in the
 * database (report C12, recommendation b; director 2026-09-30).
 *
 * ## Why a file
 *
 * While the key was a `node_config` row (`openJoinSalt`), it rode every replication payload, every snapshot and every
 * backup beside the rows it keys, so anyone holding any copy of the global node's database (a standby's host, anyone
 * with a backup, the hosting provider) could test a known Google or Apple `sub` against `open_joins` and learn which
 * BeanPool account that person is. The key now follows `recovery-seal.key` (services/recovery-seal-key.ts):
 *
 *   - `data/open-join.key`, the key's raw bytes, 0600. Made on first use by a main server, never by a standby: a standby
 *     must not hold a key of its own that a later take-over would overwrite or, worse, keep.
 *   - Never in the database, so never in a replication payload, a snapshot or a plain backup (a plain backup is state.db,
 *     node_config.json and images: sealed-backup.ts).
 *   - It travels only inside the take-over bundle (takeover-envelope.ts BUNDLED_FILES), so inside the take-over envelope
 *     and a sealed backup, and nowhere else. A take-over's `open-door` step and a sealed-backup restore install it with
 *     {@link installCarriedOpenJoinKey}, which never writes over a different key: that one is kept beside it as
 *     `open-join-retired-<id>.key`.
 *
 * A standby still copies the `open_joins` rows: they are hashes, and without the key they match nothing.
 *
 * ## Which key made the rows
 *
 * The database records WHICH key its records were made with, never the key: `node_config.openJoinKeyId`, a hash of the
 * key ({@link openJoinKeyId}). It travels in every replication payload (`openJoinKeyId`), so a standby's copy knows it
 * too. The door checks a sign-in only with that key ({@link openJoinKeyState}):
 *
 *   - the file here is the recorded key: the door recognises every account that joined;
 *   - no live record (none, or only released ones, which match nothing): whatever key is here is adopted, and a main
 *     server with none makes one;
 *   - live records and no key, or another key: recognition is OFF. The door refuses every join with a sign-in, a new
 *     account's included, since without the key it cannot tell one from an account already here (routes/open-join.ts,
 *     503 `door_key_missing`). A second identity for someone already here is the one outcome this rules out; a new
 *     account waits until the key is back. It comes back with a take-over, a locked backup's restore, or the file
 *     copied from the server that made it, and the door opens again at the next join, without a restart.
 *
 * So a plain backup restored on a new server, a copy of a standby promoted by hand without the take-over keys (as the
 * recovery seal's key, it holds none: a take-over brings it), and a server whose file was lost all keep the door shut
 * rather than let a known account join twice. Each says so at boot, in one line.
 *
 * ## Moving the old row out (at boot, {@link installOpenJoinKeyAtBoot})
 *
 * An `openJoinSalt` row is moved to the file byte for byte (the key is the row's base64url, decoded: every hash made with
 * it still matches), its id is recorded, and the row is deleted. The file is written and synced first, then the row goes
 * in one transaction with the id, then the WAL is checkpointed so the row's bytes do not linger beside the database. A
 * crash between the two leaves both, and the next boot finishes: a file equal to the row is used, and the row goes. A
 * file that DIFFERS from the row is a loud error: the file stays the key here, the row's key is kept as
 * `open-join-retired-<id>.key` (never lost), the row goes, and the id recorded is the row's, the key the records were
 * made with, so the door stays shut until an operator puts the right key in place. A standby records the row's id and
 * deletes the row, and writes no file.
 *
 * Snapshots and readable backups made before this version hold the row. Every copy made from now on (services/
 * address-retention.ts copyWithoutAddresses), and every such copy this server keeps on disk, at the next boot, loses it.
 *
 * ## Rolling back past this version (the command below)
 *
 * An older version reads the key from the row only. Finding none, it makes a new key, so no record matches any more and
 * every account that joined through the open door could join a second time, as a new member. So a rollback past this
 * version needs the key written back as the row first, by the NEW code, with the server stopped:
 *
 *     node dist/services/open-join-key.js --write-key-row          # in the image (/app/apps/server)
 *     pnpm exec tsx src/services/open-join-key.ts --write-key-row  # from a checkout
 *
 * with BEANPOOL_DATA_DIR pointing at the node's data folder (the image sets /data). It writes data/open-join.key into
 * node_config as `openJoinSalt`, byte for byte (base64url, as the older version stored it), and prints counts only. It
 * keeps the file and the recorded id, so coming back to this version later finds the file equal to the row and finishes
 * the move again. It changes nothing, and exits 1, when the file is missing or is not the key the records were made
 * with: an older version would then let those accounts join twice, so the rollback must wait until the right key is in
 * data/open-join.key. It refuses a key longer than an older version takes (192 bytes, 256 base64url characters) too. While the older version runs, the key is in the database, and so in every copy, as it was before.
 *
 * It is run on the main server only: a standby holds no key, and an older standby takes the key again from its main
 * server's copies once that server runs the older version too.
 *
 * ## What this does not do
 *
 * Lock out the operator. The operator's process holds this key and receives the `sub` at every join; that is a stated
 * trade, as for the recovery seal.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { db } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { createKeyFileOnce, fsyncDir, writeExclusive } from './key-files.js';

export const OPEN_JOIN_KEY_FILE = 'open-join.key';

/** A key a carried one replaced, or the old row's when it differed from the file: `open-join-retired-<16 hex>.key`. */
const RETIRED_PREFIX = 'open-join-retired-';

/** Where the key was kept before this file: a node_config row, moved out at boot. Never written. */
export const LEGACY_OPEN_JOIN_KEY_ROW = 'openJoinSalt';

/** node_config: which key this database's open-door records were made with ({@link openJoinKeyId}), never the key. */
export const OPEN_JOIN_KEY_ID_ROW = 'openJoinKeyId';

const NEW_KEY_BYTES = 32;
/** The shortest key the door ever hashed with (the old row's rule). */
const MIN_KEY_BYTES = 16;
const MAX_KEY_BYTES = 1024;
/**
 * The longest key an older version takes as its row: its usableKey (engine/open-join.ts, #1130 to #1350) took at most 256
 * base64url characters, which is 192 bytes, and a standby on it refused a longer row from its main server's copies. So
 * the rollback command writes no longer key.
 */
const MAX_LEGACY_ROW_KEY_BYTES = 192;

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

export function openJoinKeyPath(): string {
    return path.join(dataDir(), OPEN_JOIN_KEY_FILE);
}

/** Which key this is, as the database records it: a hash of the key, domain-separated. Tells nothing about the key. */
export function openJoinKeyId(key: Buffer): string {
    return crypto.createHash('sha256').update('beanpool-open-join-key-id/v1\n').update(key).digest('hex').slice(0, 32);
}

/** Whether `value` is an id {@link openJoinKeyId} could have made. */
export function isOpenJoinKeyId(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

function isKeyBytes(bytes: Buffer): boolean {
    return bytes.length >= MIN_KEY_BYTES && bytes.length <= MAX_KEY_BYTES;
}

/** The key file's bytes, or null when there is none. A file that cannot be read throws. */
function readKeyFile(): Buffer | null {
    try {
        return fs.readFileSync(openJoinKeyPath());
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
    }
}

/** The key file as base64, for the take-over bundle: null when there is none, or it is not a key. Never makes one. */
export function readOpenJoinKeyForBundle(): string | null {
    const file = readKeyFile();
    return file && isKeyBytes(file) ? file.toString('base64') : null;
}

/** The id this database records for the key its open-door records were made with, or null. */
export function recordedOpenJoinKeyId(): string | null {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(OPEN_JOIN_KEY_ID_ROW) as { value?: string } | undefined;
    return isOpenJoinKeyId(row?.value) ? row!.value! : null;
}

function recordKeyId(id: string): void {
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(OPEN_JOIN_KEY_ID_ROW, id);
}

/**
 * The main server's id, from a replication payload (engine/sync.ts): the key its records, and so this standby's copies
 * of them, were made with. Anything that is not an id changes nothing.
 */
export function noteMainServerOpenJoinKeyId(id: unknown): void {
    if (isOpenJoinKeyId(id) && id !== recordedOpenJoinKeyId()) recordKeyId(id);
}

/** Whether any open-door record here could match a sign-in: a released one's hash matches nothing (releaseOpenJoin). */
function holdsLiveJoins(): boolean {
    return !!db.prepare("SELECT 1 FROM open_joins WHERE join_hash NOT LIKE 'released:%' LIMIT 1").get();
}

/** How many open-door records here could match a sign-in, for what a boot, a restore or a take-over says. */
export function liveOpenJoinRecords(): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM open_joins WHERE join_hash NOT LIKE 'released:%'").get() as { n: number }).n;
}

export type OpenJoinKeyState =
    | { on: true; key: Buffer }
    /**
     * `missing`: no key file, and this server holds live records (or is a standby, which makes none).
     * `other-key`: a key file that is not the one the records were made with. `not-a-key`: a file too short or too long,
     * or one that cannot be read.
     */
    | { on: false; why: 'missing' | 'other-key' | 'not-a-key'; file: Buffer | null };

/**
 * The key the door checks a sign-in with, or why there is none it may use (see the header). Read on every use (a key put
 * back by hand counts at once), and cheap: a file of a few bytes and one row, plus, only when they disagree, whether one
 * live record exists. `create`: a main server with no key and no live record makes one (the default); at boot nothing
 * is made. Only a main server records a key as its records' own: a standby's record is its main server's (every copy
 * carries it).
 */
export function openJoinKeyState(opts: { create?: boolean } = {}): OpenJoinKeyState {
    let file: Buffer | null;
    // A file that is there but cannot be read (its mode, a failing disk) keys nothing: the door stays shut, as for one
    // that is not a key, rather than every join and knock failing on the error.
    try { file = readKeyFile(); } catch { return { on: false, why: 'not-a-key', file: null }; }
    const standby = getNodeRole() === 'backup';
    if (file) {
        if (!isKeyBytes(file)) return { on: false, why: 'not-a-key', file: null };
        const id = openJoinKeyId(file);
        if (recordedOpenJoinKeyId() === id) return { on: true, key: file };
        if (holdsLiveJoins()) return { on: false, why: 'other-key', file };
        if (!standby) recordKeyId(id);
        return { on: true, key: file };
    }
    if (opts.create === false || standby || holdsLiveJoins()) return { on: false, why: 'missing', file: null };
    const key = crypto.randomBytes(NEW_KEY_BYTES);
    let made: boolean;
    try {
        made = createKeyFileOnce(openJoinKeyPath(), key);
    } catch (e) {
        // A data folder that takes no new file (full, read-only): the door stays shut until one can be made.
        console.warn(`🚪 Open door: could not make data/${OPEN_JOIN_KEY_FILE}: ${(e as Error)?.message || e}`);
        return { on: false, why: 'missing', file: null };
    }
    // False when another writer made one first: that one is read back and used.
    if (made) {
        recordKeyId(openJoinKeyId(key));
        return { on: true, key };
    }
    return openJoinKeyState({ create: false });
}

/** The door cannot check a sign-in: no key, or not the key its records were made with. */
export class OpenJoinKeyMissing extends Error {
    readonly code = 'open_join_key_missing';
    constructor(readonly why: 'missing' | 'other-key' | 'not-a-key') {
        super(`The open door's key is ${why === 'missing' ? `missing (data/${OPEN_JOIN_KEY_FILE})` : why === 'other-key'
            ? `not the one its sign-in records were made with (data/${OPEN_JOIN_KEY_FILE})` : `not a key (data/${OPEN_JOIN_KEY_FILE})`}`);
        this.name = 'OpenJoinKeyMissing';
    }
}

/** The key a sign-in's `join_hash` is made with. Throws {@link OpenJoinKeyMissing} when the door cannot check one. */
export function openJoinKey(): Buffer {
    const state = openJoinKeyState();
    if (!state.on) throw new OpenJoinKeyMissing(state.why);
    return state.key;
}

let transientAddressKey: Buffer | null = null;

/**
 * The key the limiters' address hashes are made with: the door's key, or, when the door cannot use one, the file that is
 * here, or else a key of this process's own. An address hash is only ever compared with another made on this server
 * within a day (engine/open-join.ts), so a knock or a stranger's write is never refused for want of the door's key;
 * the limits start again when the key comes back, as they do after a take-over.
 */
export function openJoinAddressKey(): Buffer {
    const state = openJoinKeyState();
    if (state.on) return state.key;
    if (state.file) return state.file;
    return (transientAddressKey ??= crypto.randomBytes(NEW_KEY_BYTES));
}

// ── What travels ─────────────────────────────────────────────────────────────────────────────

/** A retired key's name: a hash of its bytes, never the bytes. */
function retiredNameOf(key: Buffer): string {
    return `${RETIRED_PREFIX}${openJoinKeyId(key).slice(0, 16)}.key`;
}

/** Keep `key` as a retired key file (0600, synced), never over another file. The name it is kept under. */
function retire(key: Buffer): string {
    const dir = dataDir();
    let name = retiredNameOf(key);
    if (!writeExclusive(path.join(dir, name), key) && !fs.readFileSync(path.join(dir, name)).equals(key)) {
        // Not ours: left alone. The key is kept under a name nothing else has.
        do name = `${RETIRED_PREFIX}${crypto.randomBytes(8).toString('hex')}.key`;
        while (!writeExclusive(path.join(dir, name), key));
    }
    fsyncDir(dir);
    return name;
}

/** What {@link installCarriedOpenJoinKey} did. `retiredAs`: where the key it replaced is kept. */
export type CarriedOpenJoinKeyOutcome =
    | { outcome: 'absent' }
    | { outcome: 'invalid' }
    | { outcome: 'same' }
    | { outcome: 'installed' }
    | { outcome: 'replaced'; retiredAs: string };

/**
 * Install the open door's key a take-over bundle carried (the take-over's `open-door` step, a sealed-backup restore), as
 * base64, as the recovery seal's key is installed (services/recovery-seal-key.ts installCarriedRecoverySealKey):
 *
 * - None, or not a key: nothing is written ('absent', 'invalid'). A key this server already has stays.
 * - The same key: nothing to do, so running the step again changes nothing.
 * - No key here: written atomically, 0600 (a temporary file, synced, renamed into place, the directory synced).
 * - A different file here: never deleted. It is kept, byte for byte and 0600, as `open-join-retired-<id>.key` BEFORE the
 *   carried key takes its place, so a crash between the two leaves the old key in both places and the next run finishes.
 *
 * Writes nothing in the database: whether the records here were made with this key is {@link adoptCarriedOpenJoinKey}'s.
 * An I/O error is thrown, as for the other identity files. Never logs or returns a key's bytes.
 */
export function installCarriedOpenJoinKey(b64: string | null | undefined): CarriedOpenJoinKeyOutcome {
    if (!b64) return { outcome: 'absent' };
    const carried = Buffer.from(b64, 'base64');
    if (!isKeyBytes(carried)) return { outcome: 'invalid' };
    const target = openJoinKeyPath();
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const existing = readKeyFile();
    if (existing && existing.equals(carried)) return { outcome: 'same' };
    const retiredAs = existing ? retire(existing) : null;
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        if (!writeExclusive(tmp, carried)) throw new Error('a temporary key file was already there');
        fs.renameSync(tmp, target);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
    fsyncDir(dir);
    return retiredAs ? { outcome: 'replaced', retiredAs } : { outcome: 'installed' };
}

/**
 * After a take-over installed the main server's key: record it as the key this database's records were made with, unless
 * the database already records another one for live records (then the door stays shut, and the result says so). The
 * records here are the main server's, copied or brought by the same bundle, so with no id recorded (a copy that never
 * carried one) the carried key is theirs.
 */
export function adoptCarriedOpenJoinKey(b64: string): 'recorded' | 'same' | 'other-key-recorded' {
    const id = openJoinKeyId(Buffer.from(b64, 'base64'));
    const recorded = recordedOpenJoinKeyId();
    if (recorded === id) return 'same';
    if (recorded && holdsLiveJoins()) return 'other-key-recorded';
    recordKeyId(id);
    return 'recorded';
}

// ── At boot ──────────────────────────────────────────────────────────────────────────────────

/** What a take-over, a restore or a boot says when the door cannot check a sign-in (one line, plain). */
export function openJoinKeyOffLine(records: number, why: 'missing' | 'other-key' | 'not-a-key', where: 'here' | 'envelope' | 'backup' = 'here'): string {
    const held = `${records} sign-in record${records === 1 ? '' : 's'} of members who joined through the open door`;
    const cause = where === 'envelope' ? 'the take-over keys do not carry the key they were made with'
        : where === 'backup' ? 'this backup does not carry the key they were made with'
            : why === 'missing' ? `data/${OPEN_JOIN_KEY_FILE} is missing`
                : why === 'other-key' ? `data/${OPEN_JOIN_KEY_FILE} is not the key they were made with` : `data/${OPEN_JOIN_KEY_FILE} is not a key`;
    return `Open door: this server holds ${held}, but ${cause}, so it cannot tell a returning account from a new one. `
        + `Joining with a sign-in is refused until that key is back (a take-over or a locked backup brings it, or copy data/${OPEN_JOIN_KEY_FILE} `
        + 'from the server that made them). Members already here are not affected.';
}

/**
 * Move an old `openJoinSalt` row out of the database (the header, "Moving the old row out"). Idempotent; a crash at any
 * step leaves a state the next boot finishes.
 */
function moveLegacyKeyRow(standby: boolean): void {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(LEGACY_OPEN_JOIN_KEY_ROW) as { value?: unknown } | undefined;
    if (!row) return;
    const legacy = Buffer.from(String(row.value ?? ''), 'base64url');
    const dropRow = db.prepare('DELETE FROM node_config WHERE key = ?');
    const finish = (id: string | null) => {
        db.transaction(() => {
            if (id) recordKeyId(id);
            dropRow.run(LEGACY_OPEN_JOIN_KEY_ROW);
        })();
        // The row's bytes are zeroed in the database (secure_delete, db/db.ts); the WAL still holds the page as it was.
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* the next checkpoint writes over it */ }
    };
    if (!isKeyBytes(legacy)) {
        // The door never hashed with it (the old code refused a key this short), so there is nothing to keep.
        finish(null);
        console.error(`🚪 Open door: node_config ${LEGACY_OPEN_JOIN_KEY_ROW} was not a usable key; it was removed. `
            + 'It never keyed a sign-in record, so nothing is lost.');
        return;
    }
    const legacyId = openJoinKeyId(legacy);
    if (standby) {
        // The main server's key, copied by an older version: this standby keeps which key it was, never the key.
        finish(recordedOpenJoinKeyId() ? null : legacyId);
        console.log(`🚪 Open door: removed the main server's key for the door's hashes from this standby's database. `
            + 'A standby holds none; a take-over brings it inside the locked keys.');
        return;
    }
    let file = readKeyFile();
    if (!file) {
        if (!createKeyFileOnce(openJoinKeyPath(), legacy)) file = readKeyFile();
        else file = legacy;
    }
    if (file && file.equals(legacy)) {
        if (process.env.BEANPOOL_TEST_OPEN_JOIN_KEY_CRASH === 'after-file') {
            // Tests only: a power cut between the file and the row's delete. Unset in every real deployment.
            console.warn('🚪 Open door: test crash after the key file was written');
            process.kill(process.pid, 'SIGKILL');
        }
        finish(recordedOpenJoinKeyId() ? null : legacyId);
        console.log(`🚪 Open door: moved the key for the door's hashes out of the database into data/${OPEN_JOIN_KEY_FILE} (0600).`);
        return;
    }
    const retiredAs = retire(legacy);
    finish(recordedOpenJoinKeyId() ? null : legacyId);
    console.error(`🚨 Open door: data/${OPEN_JOIN_KEY_FILE} and the key the database held (node_config ${LEGACY_OPEN_JOIN_KEY_ROW}) differ. `
        + `The file stays this server's key; the database's is kept as data/${retiredAs} and removed from the database. `
        + `The sign-in records here were made with the database's, so joining with a sign-in is refused until the right key is in `
        + `data/${OPEN_JOIN_KEY_FILE}: if nothing else made that file, move data/${retiredAs} into its place.`);
}

let installedAs: 'main' | 'standby' | null = null;

/**
 * At boot: move an old key row out of the database, then say, once, when the door cannot check a sign-in. Called from
 * initStateEngine and again once the role is final (index.ts, after a take-over may have changed it); does nothing when
 * the role did not change. Makes no key: a main server makes one at the door's first use. Never throws.
 */
export function installOpenJoinKeyAtBoot(opts: { standby: boolean }): void {
    const as = opts.standby ? 'standby' : 'main';
    if (installedAs === as) return;
    installedAs = as;
    try {
        moveLegacyKeyRow(opts.standby);
        const state = openJoinKeyState({ create: false });
        if (state.on) return;
        const records = liveOpenJoinRecords();
        if (state.why === 'not-a-key' && !opts.standby) {
            // Nothing makes a key over a file that is here, even with no record to check (a crash can leave one empty).
            console.warn(`⚠️ Open door: data/${OPEN_JOIN_KEY_FILE} is not a key, so joining with a sign-in is refused. `
                + (records === 0 ? `No sign-in record here needs it: remove the file and a new key is made at the next join.`
                    : openJoinKeyOffLine(records, state.why)));
            return;
        }
        if (records === 0) return;
        if (opts.standby) {
            console.log(`🚪 Open door: a standby holds no key of its own for its ${records} sign-in record(s). A take-over brings its `
                + `main server's data/${OPEN_JOIN_KEY_FILE} inside the locked keys.`);
            return;
        }
        console.warn(`⚠️ ${openJoinKeyOffLine(records, state.why)}`);
    } catch (e) {
        installedAs = null;
        console.error(`🚨 Open door: ${(e as Error)?.message || e}. The server runs; the next boot tries again.`);
    }
}

// ── the rollback command ──────────────────────────────────────────────────────────────────────────

/**
 * Write data/open-join.key back as the node_config row an older version reads (`openJoinSalt`, base64url), for a
 * rollback past this version (the header). Keeps the file and the recorded id. Throws, having changed nothing, when an
 * older version could not recognise the accounts that joined: the file is missing, is not a key, is longer than an older
 * version takes (MAX_LEGACY_ROW_KEY_BYTES), is not the key the records were made with, or the row already holds another
 * key. Never returns or logs a key's bytes.
 */
export function writeLegacyKeyRow(): { records: number; outcome: 'written' | 'same' | 'no-key-needed' } {
    const records = liveOpenJoinRecords();
    const file = readKeyFile();
    if (!file) {
        if (records === 0) return { records, outcome: 'no-key-needed' };
        throw new Error(`data/${OPEN_JOIN_KEY_FILE} is missing, and ${records} sign-in record${records === 1 ? ' needs' : 's need'} it. `
            + 'An older version would make a new key and let each of those accounts join a second time. Put the key back first '
            + `(copy data/${OPEN_JOIN_KEY_FILE} from the server that made it, or restore a locked backup).`);
    }
    if (!isKeyBytes(file)) throw new Error(`data/${OPEN_JOIN_KEY_FILE} is not a key (${file.length} bytes).`);
    if (file.length > MAX_LEGACY_ROW_KEY_BYTES) {
        throw new Error(`data/${OPEN_JOIN_KEY_FILE} is ${file.length} bytes; an older version takes a key of at most ${MAX_LEGACY_ROW_KEY_BYTES} `
            + `(${MAX_LEGACY_ROW_KEY_BYTES / 3 * 4} base64url characters), and its standby would refuse the row. This key cannot go back past this version.`);
    }
    if (records > 0 && recordedOpenJoinKeyId() !== openJoinKeyId(file)) {
        throw new Error(`data/${OPEN_JOIN_KEY_FILE} is not the key the ${records} sign-in record${records === 1 ? ' here was' : 's here were'} made with. `
            + 'An older version using it would let each of those accounts join a second time. Put the right key in place first '
            + '(a data/open-join-retired-….key may be it).');
    }
    const value = file.toString('base64url');
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(LEGACY_OPEN_JOIN_KEY_ROW) as { value?: unknown } | undefined;
    if (row) {
        if (String(row.value ?? '') === value) return { records, outcome: 'same' };
        throw new Error(`node_config ${LEGACY_OPEN_JOIN_KEY_ROW} already holds another key. Start this version once, which moves it out, then run this again.`);
    }
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(LEGACY_OPEN_JOIN_KEY_ROW, value);
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* the older version's first checkpoint does it */ }
    return { records, outcome: 'written' };
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
    if (!process.argv.includes('--write-key-row')) {
        console.error('Usage: open-join-key --write-key-row   (with the server stopped; BEANPOOL_DATA_DIR = its data folder)');
        process.exit(2);
    }
    try {
        const done = writeLegacyKeyRow();
        const held = `${done.records} sign-in record${done.records === 1 ? '' : 's'} of members who joined through the open door`;
        console.log(done.outcome === 'no-key-needed'
            ? `There is no data/${OPEN_JOIN_KEY_FILE} and no sign-in record needs one, so nothing was written. An older version makes a key at its door's first use.`
            : `${done.outcome === 'same' ? 'The database already held' : 'Wrote'} data/${OPEN_JOIN_KEY_FILE} as node_config ${LEGACY_OPEN_JOIN_KEY_ROW}, `
                + `for the ${held}. An older version recognises them now; start it before this one, which would move the key out again at boot.`);
        process.exit(0);
    } catch (e) {
        console.error(`Nothing was changed: ${(e as Error)?.message || e}`);
        process.exit(1);
    }
}
