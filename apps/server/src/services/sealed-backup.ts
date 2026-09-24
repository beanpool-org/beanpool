/**
 * Sealed backups (`.bpsealed`) — sealed-keys.md §6 (Fable, 2026-09-19), slice 3.
 *
 * A backup is the tar.gz it always was — `state.db`, `node_config.json` — plus the take-over bundle
 * (`takeover-bundle.json`: node key, community key, genesis, connectors, admin and 2FA fields, roles, the public
 * address), streamed through a `bpseal/v1` envelope of kind `backup` locked to the same people as the take-over
 * envelope: every owner, plus the printed recovery code. One file restores a whole community, and nobody who
 * finds the file can read it.
 *
 * ## When a backup is locked (seal review round 1)
 *
 * Only when this server has a recovery code. The only opener that ships today is the code (restore, and the
 * take-over on a standby); opening with an owner's phone is slice 6. A file locked to owners alone would be
 * a backup nothing can open, so without a code a backup leaves in the readable format it always had — the tar.gz
 * of state.db, node_config.json and the image store — and says so: {@link NOT_LOCKED_MESSAGE} in a
 * response header, in the backup status, and in the log. Never a false "locked".
 *
 * ## A backup is the whole node or it is an error (storage design §7)
 *
 * Since the images left state.db, a database on its own is not a node: its rows carry `storage_key`s and no
 * bytes. So every backup — locked or readable, live or a snapshot — carries the objects ITS OWN database
 * references, taken from the store that database belongs to, and {@link IncompleteBackupError} refuses the
 * whole thing if even one of them cannot be had. The one short backup this will make is the one an operator
 * asked for by name ({@link BackupSource.databaseOnly}), and that one is labelled everywhere it appears.
 *
 * ## What never happens
 *
 * - A backup is produced that no shipped tool can open.
 * - A backup that is missing photos is handed over as a good one.
 * - A snapshot's keys are resolved against the LIVE store: a snapshot ships the objects it captured.
 * - A readable backup carries the node keys. The take-over bundle goes only into a locked file.
 * - A restore trusts the archive inside the envelope. Opening only proves the file was locked to a key someone
 *   here holds; the tar inside goes through exactly the hostile-archive checks a legacy upload does.
 * - A restore takes a file signed by someone else when this server knows who should have signed it (966
 *   follow-up #2). A removed owner who kept a data key can forge an envelope that the remaining owners open
 *   cleanly; only the header signature against a pinned key tells the two apart. See {@link signerCheck}.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { peerIdFromString } from '@libp2p/peer-id';
import {
    sealEnvelopeStream, openEnvelopeStream, readSealedHeader, verifySealedHeader,
    type SealedEnvelopeHeader, type SealedEnvelopeKey, type CodeStanza,
} from '@beanpool/core';
import Database from 'better-sqlite3';
import { getLocalConfig, redactLocalConfig } from '../config/local-config.js';
import { writeDbSnapshot } from './snapshot-scheduler.js';
import { assertSafeKey, copyObjectReplacing, imagesDir } from '../storage/image-store.js';
import { referencedStorageKeys } from '../storage/image-columns.js';
import {
    readSealingInputs, readNodeIdentity, peerIdOfKeyFile, BUNDLED_FILES, BUNDLED_LOCAL_CONFIG_FIELDS,
    type TakeoverBundle,
} from './takeover-envelope.js';

const execFileAsync = promisify(execFile);

export const SEALED_BACKUP_EXT = '.bpsealed';
/** The take-over bundle's name inside the backup tar. */
export const BUNDLE_MEMBER = 'takeover-bundle.json';
/** Read from a file in 1 MiB pieces: one envelope chunk per read. */
const READ_PIECE = 1_048_576;

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

export function isGzip(firstBytes: Uint8Array): boolean {
    return firstBytes.length >= 2 && firstBytes[0] === 0x1f && firstBytes[1] === 0x8b;
}

/** What an operator reads when a backup leaves this server readable. The fix is in the operator manual. */
export const NOT_LOCKED_MESSAGE = 'Backups are not locked yet: make a recovery code to lock them.';

export type BackupLock =
    | { locked: true; codeId: number; message: string }
    | { locked: false; reason: 'no-recovery-code' | 'no-identity' | 'no-genesis'; message: string };

/**
 * Will the next backup be locked? Yes only with a recovery code to lock it to (and a node key to sign it with),
 * because the code is the only opener that ships. For a status line, and for every route that sends a backup.
 */
export function backupLockState(): BackupLock {
    const code = (getLocalConfig() as any).recoveryCode ?? null;
    if (!code) return { locked: false, reason: 'no-recovery-code', message: NOT_LOCKED_MESSAGE };
    const inputs = readSealingInputs();
    if (!inputs.ok || !inputs.code) {
        const reason = inputs.ok ? 'no-recovery-code' : inputs.state === 'no-genesis' ? 'no-genesis' : 'no-identity';
        return { locked: false, reason, message: `Backups are not locked yet: ${inputs.ok ? 'there is no recovery code' : inputs.message}.` };
    }
    return {
        locked: true, codeId: inputs.code.codeId,
        message: `Backups are locked to recovery code #${inputs.code.codeId}`
            + (inputs.owners.length ? ` and ${inputs.owners.length} owner${inputs.owners.length === 1 ? '' : 's'}.` : '.'),
    };
}

export function sealedBackupFilename(prefix = 'beanpool-backup', at = new Date()): string {
    return `${prefix}-${at.toISOString().replace(/[:.]/g, '-').slice(0, 19)}${SEALED_BACKUP_EXT}`;
}

/** Who can open a file, from its public header — for a status line or a restore screen. */
export function describeSealedHeader(header: SealedEnvelopeHeader): {
    envelopeId: string; communityId: string; createdAt: string; sealedBy: string;
    owners: string[]; codeIds: number[]; opensWith: string;
} {
    const owners = header.recipients.filter((r) => r.type === 'owner').map((r) => (r as any).callsign as string);
    const codeIds = header.recipients.filter((r): r is CodeStanza => r.type === 'code').map((r) => r.codeId);
    const opensWith = [
        ...owners.map((c) => '@' + c),
        ...codeIds.map((id) => `recovery code #${id}`),
    ].join(', ');
    return {
        envelopeId: header.envelopeId, communityId: header.communityId, createdAt: header.createdAt,
        sealedBy: header.nodePeerId, owners, codeIds, opensWith,
    };
}

// ── Making one ─────────────────────────────────────────────────────────────────────────────

export interface SealedBackup {
    header: SealedEnvelopeHeader;
    filename: string;
    /** The sealed bytes, header first. Consume once. */
    body: Readable;
    /** Remove the staging files. Safe to call more than once. */
    cleanup(): void;
    /** What went into `images/`, or null when the caller asked for the database alone. */
    images: StagedImages | null;
    databaseOnly: boolean;
}

/** Thrown by {@link createSealedBackup} when the backup may not be locked; callers check {@link backupLockState}. */
export class BackupNotLockableError extends Error {
    constructor(public readonly lock: Extract<BackupLock, { locked: false }>) {
        super(lock.message);
        this.name = 'BackupNotLockableError';
    }
}

/** What a backup's `images/` member ended up holding. Reported in the response headers and the log. */
export interface StagedImages {
    /** Objects the database in THIS archive references. */
    referenced: number;
    /** Objects actually in the archive. */
    staged: number;
    /** Of those, how many cost no disk because they were hard-linked out of the store. */
    linked: number;
    bytes: number;
    /** Referenced keys the store did not hold. A backup with any of these is refused. */
    missing: string[];
}

/** A backup that would have been short. Never sent: the operator gets an error, not two-thirds of a node. */
export class IncompleteBackupError extends Error {
    constructor(public readonly images: StagedImages) {
        super(
            `Backup refused: the image store holds ${images.staged} of the ${images.referenced} object(s) this `
            + `database references, so the backup would be missing ${images.missing.length} photo(s) or attachment(s). `
            + `First missing: ${images.missing.slice(0, 3).join(', ')}. `
            + 'Ask for a database-only backup if you want one anyway — it will be labelled as such.',
        );
        this.name = 'IncompleteBackupError';
    }
}

/**
 * Put the image store into the backup stage as `images/` (storage design §7).
 *
 * A backup used to be the whole node because the whole node was in state.db. Now most of a node's bytes sit
 * beside it, so a tar of state.db alone would restore a database full of `storage_key`s pointing at nothing:
 * every photo and every attachment gone, silently, and only discovered when somebody opened a post.
 *
 * ## Exactly what the database references, and nothing else
 *
 * Driven by the keys in the archive's OWN database file rather than by a walk of the store, so the archive is
 * self-consistent by construction: what it carries is what it needs, an orphan the sweep has not reclaimed yet
 * is not shipped, and the count to check against comes out of the same pass.
 *
 * ## Hard links, not copies
 *
 * An object is content-addressed and written temp-then-rename, so a file is never rewritten in place and a
 * second name for it is a true point-in-time copy. `link(2)` is one syscall and no bytes, where the copy this
 * replaced wrote a second full copy of the node's largest component — on the event loop, on a 1 vCPU VM, at
 * the moment an operator is trying to back up a disk that may be nearly full. A filesystem that cannot link
 * (EXDEV across a mount, EPERM, EMLINK) falls back to copying that object.
 *
 * ## It fails rather than coming up short
 *
 * This used to swallow every error and return counts nobody read, so ENOSPC a thousand objects in produced a
 * tar that looked exactly like a complete one and was discovered at restore time. Now any I/O error throws,
 * and a referenced object the store does not hold is collected in `missing` for the caller to refuse on.
 */
function stageImages(stage: string, sourceRoot: string, dbInStage: string): StagedImages {
    const out: StagedImages = { referenced: 0, staged: 0, linked: 0, bytes: 0, missing: [] };
    const handle = new Database(dbInStage, { readonly: true });
    let keys: string[];
    try {
        keys = referencedStorageKeys(handle);
    } finally {
        try { handle.close(); } catch { /* the read is done */ }
    }
    out.referenced = keys.length;
    if (keys.length === 0) return out;

    const dest = path.join(stage, 'images');
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const key of keys) {
        // A storage_key comes out of a row, and rows arrive from federation peers and restored backups.
        // An unusable one is a missing object, never a path this turns into a write.
        try { assertSafeKey(key); } catch { out.missing.push(key); continue; }
        const from = path.join(sourceRoot, key);
        const to = path.join(dest, key);
        // Never carry a link INTO the tar: checkBackupArchive refuses link members on the way back in, so one
        // here would make the whole backup unrestorable. A hard link to a regular file is a regular file to
        // tar, which is why this is safe — but a symlink in the store is not followed.
        let st: fs.Stats;
        try {
            st = fs.lstatSync(from);
        } catch (e: any) {
            if (e?.code === 'ENOENT') { out.missing.push(key); continue; }
            throw e;
        }
        if (!st.isFile()) { out.missing.push(key); continue; }
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        let linked = true;
        try {
            fs.linkSync(from, to);
        } catch (e: any) {
            if (e?.code === 'ENOENT') { out.missing.push(key); continue; }
            if (e?.code === 'EEXIST') { /* two rows, one object: already staged */ }
            else if (e?.code === 'EXDEV' || e?.code === 'EPERM' || e?.code === 'EMLINK' || e?.code === 'ENOSYS') {
                linked = false;
                try {
                    // Never a bare copyFileSync: `to` is a name in a tree whose other entries are hard links
                    // to LIVE store inodes, so an in-place write here would rewrite the store itself.
                    copyObjectReplacing(from, to);
                } catch (copyErr: any) {
                    if (copyErr?.code === 'ENOENT') { out.missing.push(key); continue; }
                    throw copyErr;
                }
            } else {
                throw e;
            }
        }
        out.staged++;
        if (linked) out.linked++;
        out.bytes += st.size;
    }
    return out;
}

/**
 * Stage the images for a backup whose database is already at `dbInStage`, or refuse the backup.
 *
 * `databaseOnly` is the one way to get a backup without them, and every path that offers it labels the
 * result: a short backup must be something the operator ASKED for, never something they discover at restore.
 *
 * One window worth naming. A snapshot's objects were captured when it was taken, so its download is exact.
 * A LIVE backup is `VACUUM INTO` and then this, and a photo replaced between the two unlinks an object the
 * copied database still names — so the backup fails where it could have succeeded a second earlier. That is
 * the safe side of the trade: a retry (the operator's, or the harvester's back-off) takes a consistent one,
 * where the alternative is shipping a file that is quietly missing a photo. The window is one VACUUM long.
 */
function stageImagesOrRefuse(
    stage: string, dbInStage: string, opts: { imagesDir?: string; dbFile?: string; databaseOnly?: boolean },
): StagedImages | null {
    if (opts.databaseOnly) return null;
    // A caller sealing a database that is not the live one (a snapshot) MUST say where that database's
    // objects are. Falling back to the live store here is precisely the bug this replaced: the snapshot's
    // keys would be resolved against whatever the node happens to hold today.
    if (opts.dbFile && !opts.imagesDir) {
        throw new Error('Backup refused: a backup of a database other than the live one must say where its image store is.');
    }
    const sourceRoot = opts.imagesDir ?? imagesDir(dataDir());
    const staged = stageImages(stage, sourceRoot, dbInStage);
    if (staged.missing.length > 0) throw new IncompleteBackupError(staged);
    return staged;
}

/** What a backup was asked to carry, and where the database's objects are when it is not the live one. */
export interface BackupSource {
    /** Seal this SQLite file as the database (a snapshot being downloaded) instead of a fresh copy of the live one. */
    dbFile?: string;
    /** The image store that `dbFile`'s `storage_key`s belong to. Required whenever `dbFile` is given. */
    imagesDir?: string;
    filenamePrefix?: string;
    /** Deliberately leave the images out. The only way to get a short backup, and every caller labels it. */
    databaseOnly?: boolean;
}

/**
 * Build and seal a backup. `dbFile` seals that SQLite file as the database (a snapshot being downloaded), and
 * must come with the `imagesDir` its keys belong to; without either, a consistent copy of the live database
 * and the live store is taken. Refuses ({@link BackupNotLockableError}) unless there is a recovery code to
 * lock it to, and ({@link IncompleteBackupError}) if the store cannot supply every object the database
 * references. Anything else that fails throws before a byte is produced, so a caller can still answer with an
 * error rather than a truncated file.
 */
export async function createSealedBackup(opts: BackupSource = {}): Promise<SealedBackup> {
    const lock = backupLockState();
    if (!lock.locked) throw new BackupNotLockableError(lock);
    const inputs = readSealingInputs();
    if (!inputs.ok || !inputs.code) throw new BackupNotLockableError({ locked: false, reason: 'no-recovery-code', message: NOT_LOCKED_MESSAGE });

    const work = path.join(dataDir(), `.backup-tmp-${crypto.randomBytes(6).toString('hex')}`);
    const stage = path.join(work, 'stage');
    const tarPath = path.join(work, 'backup.tar.gz');
    const cleanup = () => {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    try {
        fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
        // Only these names go in the tar — the database, the config, the take-over bundle and the image
        // store — so it never swallows data/snapshots/ or anything else in data/.
        const dbPath = path.join(stage, 'state.db');
        if (opts.dbFile) fs.copyFileSync(opts.dbFile, dbPath);
        else writeDbSnapshot(dbPath);
        const configPath = path.join(dataDir(), 'node_config.json');
        if (fs.existsSync(configPath)) {
            fs.copyFileSync(configPath, path.join(stage, 'node_config.json'));
        } else {
            // Without a standby's legacy plain-text admin password.
            fs.writeFileSync(path.join(stage, 'node_config.json'), JSON.stringify(redactLocalConfig(getLocalConfig()), null, 2));
        }
        fs.writeFileSync(path.join(stage, BUNDLE_MEMBER), JSON.stringify(inputs.bundle), { mode: 0o600 });
        // From the staged database, not the live one: what the archive carries is what the archive needs.
        const images = stageImagesOrRefuse(stage, dbPath, opts);
        // Async: gzip of a large database must not hold the event loop.
        await execFileAsync('tar', ['-czf', tarPath, '-C', stage, '.']);
        fs.rmSync(stage, { recursive: true, force: true });

        const sealed = sealEnvelopeStream(fs.createReadStream(tarPath, { highWaterMark: READ_PIECE }), {
            kind: 'backup',
            communityId: inputs.communityId,
            nodePeerId: inputs.identity.peerId,
            recipients: { owners: inputs.owners, codes: inputs.code ? [inputs.code] : [] },
            signingKey: inputs.identity.seed,
        });
        // Draw the header now: a sealing error surfaces here, before any response has started.
        const first = await sealed.next();
        if (first.done) throw new Error('The sealer produced no header.');
        const header = readSealedHeader(first.value);
        async function* all(): AsyncGenerator<Uint8Array> {
            try {
                yield first.value as Uint8Array;
                yield* sealed;
            } finally {
                cleanup();
            }
        }
        const body = Readable.from(all(), { objectMode: false });
        return { header, filename: sealedBackupFilename(opts.filenamePrefix), body, cleanup, images, databaseOnly: !!opts.databaseOnly };
    } catch (e) {
        cleanup();
        throw e;
    }
}

export interface PlainBackup {
    filename: string;
    body: Readable;
    cleanup(): void;
    /** What went into `images/`, or null when the caller asked for the database alone. */
    images: StagedImages | null;
    databaseOnly: boolean;
}

/**
 * The readable backup this server made before sealed backups: a tar.gz of a consistent copy of state.db and
 * node_config.json — no node keys — and, since the image store, the objects that database references.
 * Sent only while {@link backupLockState} says the backup cannot be locked.
 *
 * `dbFile` puts a snapshot in the archive instead of a fresh copy of the live database, and then `imagesDir`
 * must name that snapshot's own captured objects. This is what makes the unlocked snapshot download a whole
 * node: it used to hand over the bare `.db`, which after the evacuation is a database with no photos in it.
 */
export async function createPlainBackup(opts: BackupSource = {}): Promise<PlainBackup> {
    const work = path.join(dataDir(), `.backup-tmp-${crypto.randomBytes(6).toString('hex')}`);
    const stage = path.join(work, 'stage');
    const tarPath = path.join(work, 'backup.tar.gz');
    const cleanup = () => {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    try {
        fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
        const dbPath = path.join(stage, 'state.db');
        if (opts.dbFile) fs.copyFileSync(opts.dbFile, dbPath);
        else writeDbSnapshot(dbPath);
        const configPath = path.join(dataDir(), 'node_config.json');
        if (fs.existsSync(configPath)) {
            fs.copyFileSync(configPath, path.join(stage, 'node_config.json'));
        } else {
            fs.writeFileSync(path.join(stage, 'node_config.json'), JSON.stringify(redactLocalConfig(getLocalConfig()), null, 2));
        }
        const images = stageImagesOrRefuse(stage, dbPath, opts);
        await execFileAsync('tar', ['-czf', tarPath, '-C', stage, '.']);
        fs.rmSync(stage, { recursive: true, force: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const body = fs.createReadStream(tarPath);
        body.on('close', cleanup);
        const prefix = opts.filenamePrefix || 'beanpool-backup';
        return { filename: `${prefix}-${timestamp}.tar.gz`, body, cleanup, images, databaseOnly: !!opts.databaseOnly };
    } catch (e) {
        cleanup();
        throw e;
    }
}

/**
 * The hostile-archive checks (SRV-9a) every backup tar goes through before a byte is extracted, whether it came
 * as a plain upload or out of a sealed file (opening only proves someone holding a key locked it). `tar -x` does
 * NOT sanitise member paths — GNU tar (the prod image) follows `../` and absolute names and materialises links —
 * so a crafted archive could write anywhere the process can reach. Refuses the whole archive on any member that
 * would escape, or that is a link. Also used by the harvester to check an old backup it sealed before it deletes
 * the plaintext. Returns the member list.
 */
export function checkBackupArchive(tarPath: string, opts: { requireStateDb?: boolean } = {}): string[] {
    const listing = execFileSync('tar', ['-tzf', tarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').map((s: string) => s.trim()).filter(Boolean);
    for (const entry of listing) {
        // POSIX/Windows-absolute paths and any `..` traversal segment.
        if (path.isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.split('/').some(seg => seg === '..')) {
            throw new Error('Invalid backup archive: unsafe member path');
        }
    }
    // Symlink/hardlink members (type char 'l'/'h' in the verbose listing), so a link can't redirect a later write.
    const verbose = execFileSync('tar', ['-tvzf', tarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').map((s: string) => s.trim()).filter(Boolean);
    for (const line of verbose) {
        if (line[0] === 'l' || line[0] === 'h') throw new Error('Invalid backup archive: links are not permitted');
    }
    if (opts.requireStateDb && !listing.some((e) => e === 'state.db' || e === './state.db')) {
        throw new Error('Invalid backup archive: state.db missing');
    }
    return listing;
}

// ── Reading one ────────────────────────────────────────────────────────────────────────────

/** The first bytes of a file (fewer if it is shorter). */
export function readFileStart(file: string, n: number): Buffer {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(n);
        const got = fs.readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, got);
    } finally {
        fs.closeSync(fd);
    }
}

/** A sealed file's public header, reading only the header's bytes. Throws SealedEnvelopeError when it is not one. */
export function readSealedFileHeader(file: string): SealedEnvelopeHeader {
    const prefix = readFileStart(file, 4);
    const len = prefix.length === 4 ? prefix.readUInt32BE(0) : 0;
    // readSealedHeader enforces the 256 KiB cap; asking for a little more than that is harmless.
    return readSealedHeader(new Uint8Array(readFileStart(file, 4 + Math.min(len, 256 * 1024 + 1))));
}

/**
 * Open a sealed file into `outFile`, streaming. Everything written is untrusted until this resolves: a truncated
 * or altered file throws partway, and then `outFile` is removed.
 */
export async function openSealedFileTo(
    file: string, key: SealedEnvelopeKey, outFile: string,
): Promise<SealedEnvelopeHeader> {
    const { header, chunks } = await openEnvelopeStream(
        fs.createReadStream(file, { highWaterMark: READ_PIECE }), key, { kind: 'backup' },
    );
    try {
        await pipeline(Readable.from(chunks, { objectMode: false }), fs.createWriteStream(outFile, { mode: 0o600 }));
    } catch (e) {
        try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
        throw e;
    }
    return header;
}

/**
 * Seal a local backup tar (the harvester's seal-old pass, §6.4) and prove the file on disk opens before
 * returning: `outFile` is read back from disk, its header must verify against the signer and still carry a
 * recovery-code stanza (the opener a restore uses), it is opened with the data key through the same
 * {@link openSealedFileTo} a restore uses, the result must match the input byte for byte, and it must pass
 * {@link checkBackupArchive} — the restore's own checks, with state.db present when `requireStateDb`. Only then
 * does this resolve; on any failure `outFile` is removed and this throws, so a caller deletes plaintext only
 * after a resolve. The data key lives in this function's memory only.
 */
export async function sealFileVerified(
    inFile: string, outFile: string,
    opts: { communityId: string; nodePeerId: string; signingKey: Uint8Array;
            recipients: { owners: { pubkey: string; callsign: string }[]; codes: any[] };
            requireStateDb?: boolean },
): Promise<{ header: SealedEnvelopeHeader; sha256: string }> {
    const { requireStateDb, ...sealOpts } = opts;
    if (!sealOpts.recipients.codes.length) throw new Error('refusing to seal without a recovery code: nothing that ships could open it');
    let dataKey: Uint8Array | null = null;
    const tmp = `${outFile}.tmp-${process.pid}`;
    const reopened = `${outFile}.reopened-${process.pid}`;
    const inHash = crypto.createHash('sha256');
    let placed = false;
    try {
        const source = fs.createReadStream(inFile, { highWaterMark: READ_PIECE });
        source.on('data', (b) => inHash.update(b as Buffer));
        await pipeline(
            Readable.from(sealEnvelopeStream(source, { kind: 'backup', ...sealOpts, onDataKey: (k) => { dataKey = k; } }), { objectMode: false }),
            fs.createWriteStream(tmp, { mode: 0o600 }),
        );
        const expected = inHash.digest('hex');
        if (!dataKey) throw new Error('the sealer did not hand back its data key');
        fs.renameSync(tmp, outFile);
        placed = true;

        // From here on, only what is on disk counts.
        const onDisk = readSealedFileHeader(outFile);
        const signerKey = publicKeyOfPeerId(onDisk.nodePeerId);
        if (onDisk.nodePeerId !== sealOpts.nodePeerId || !signerKey || !verifySealedHeader(onDisk, signerKey)) {
            throw new Error('the sealed file\'s header does not verify against the key that sealed it');
        }
        if (!onDisk.recipients.some((r) => r.type === 'code')) throw new Error('the sealed file has no recovery-code stanza');
        const header = await openSealedFileTo(outFile, { type: 'dataKey', dataKey }, reopened);
        const got = crypto.createHash('sha256').update(fs.readFileSync(reopened)).digest('hex');
        if (got !== expected) throw new Error(`re-opened to different bytes (${got.slice(0, 12)} ≠ ${expected.slice(0, 12)})`);
        checkBackupArchive(reopened, { requireStateDb });
        return { header, sha256: expected };
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        if (placed) try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
        throw e;
    } finally {
        try { fs.rmSync(reopened, { force: true }); } catch { /* ignore */ }
        if (dataKey) (dataKey as Uint8Array).fill(0);
    }
}

// ── Who may have signed it ─────────────────────────────────────────────────────────────────

/**
 * The keys this server can hold a restore to (966 follow-up #2): its own node key when the file is from its own
 * community, and a standby's pinned main server (the `mirror` connector). A fresh server restoring someone's
 * community has none, and then opening is the whole proof, as §2.2 allows for an owner.
 */
export function restorePins(header: SealedEnvelopeHeader): string[] {
    const pins = new Set<string>();
    try {
        const genesis = JSON.parse(fs.readFileSync(path.join(dataDir(), 'genesis.json'), 'utf-8'));
        if (genesis?.communityId === header.communityId) {
            const me = readNodeIdentity();
            if (me) pins.add(me.peerId);
        }
    } catch { /* no genesis: no own pin */ }
    try {
        const connectors = JSON.parse(fs.readFileSync(path.join(dataDir(), 'connectors.json'), 'utf-8'));
        for (const c of Array.isArray(connectors) ? connectors : []) {
            if (c?.trustLevel !== 'mirror' || typeof c.address !== 'string') continue;
            const m = c.address.match(/\/p2p\/([^/]+)$/);
            if (m) pins.add(m[1]);
        }
    } catch { /* no connectors */ }
    return [...pins];
}

/** The Ed25519 public key a PeerId embeds, or null when it embeds none. */
function publicKeyOfPeerId(peerId: string): Uint8Array | null {
    try {
        const raw = (peerIdFromString(peerId) as any).publicKey?.raw as Uint8Array | undefined;
        return raw && raw.length === 32 ? raw : null;
    } catch {
        return null;
    }
}

export type SignerCheck =
    /** `acceptedByName`: this server has pins, the signer is not one, and the operator named it (X-Accept-Signer).
     *  Such a file restores its database only; its bundle is never applied (see {@link signerCheck}). */
    | { ok: true; pinned: boolean; acceptedByName: boolean }
    | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Does the header's signature hold up? Always: it must verify against the key its own `nodePeerId` names — no
 * sealer this code ships writes anything else. Where this server has pins, the signer must also be one of them,
 * unless the operator has named that exact signer (`acceptSigner`): a backup the fleet manager locked (its
 * seal-old pass signs with its own key) is legitimate, and the screen asks rather than refuses.
 *
 * Who can make a file that passes by name: ANYONE who has seen one header of this community. Sealing needs only
 * the public stanzas (owner public keys, the code's public record), so they can lock any tar to the same
 * recovery code and sign it with a key of their own. The code opens it cleanly. Naming the signer therefore
 * vouches for nothing but "I know this machine", so such a file brings back its database only: its take-over
 * bundle (node key, admin password hash, 2FA) is never applied. Harvester-sealed files never carry one anyway.
 */
export function signerCheck(header: SealedEnvelopeHeader, acceptSigner?: string | null): SignerCheck {
    const signerKey = publicKeyOfPeerId(header.nodePeerId);
    if (!signerKey || !verifySealedHeader(header, signerKey)) {
        return {
            ok: false, status: 400,
            body: { error: 'This backup file has been altered: its signature does not match the server it names.', badSignature: true },
        };
    }
    const pins = restorePins(header);
    if (pins.length === 0) return { ok: true, pinned: false, acceptedByName: false };
    if (pins.includes(header.nodePeerId)) return { ok: true, pinned: true, acceptedByName: false };
    if (acceptSigner && acceptSigner === header.nodePeerId) return { ok: true, pinned: false, acceptedByName: true };
    return {
        ok: false, status: 409,
        body: {
            error: `This backup of your community was locked by ${header.nodePeerId}, not by this community's server. `
                + "If you know that machine (the fleet manager locks old backups with its own key), restore again and "
                + 'confirm it by name; its database comes back, never keys or passwords from inside it. Otherwise do not '
                + 'restore it: anyone who has seen one of your backup files can make one like it.',
            signerNotPinned: true,
            signer: header.nodePeerId,
            pins,
        },
    };
}

// ── Applying the bundle on restore (§6.2 step 3, §5.4 step 3) ──────────────────────────────

/** Read and check the bundle from an extracted backup. Returns null when the backup has none (a legacy tar, or a
 *  harvester-sealed old database). Throws when it is there and wrong. */
export function readBundleFrom(extractDir: string, header: SealedEnvelopeHeader | null): TakeoverBundle | null {
    const p = path.join(extractDir, BUNDLE_MEMBER);
    if (!fs.existsSync(p)) return null;
    if (!fs.lstatSync(p).isFile()) throw new Error(`Invalid backup archive: ${BUNDLE_MEMBER} is not a file`);
    let bundle: TakeoverBundle;
    try {
        bundle = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
        throw new Error(`Invalid backup archive: ${BUNDLE_MEMBER} is not readable`);
    }
    return checkBundle(bundle, header, 'Invalid backup archive: ');
}

/**
 * Check an opened take-over bundle before any of it is written: version 1, base64 files, a readable genesis and an
 * Ed25519 node key, and (given the header it came in) the same community and the same key that locked it. Shared
 * by restore and take-over (services/takeover.ts). `prefix` begins each error message.
 */
export function checkBundle(bundle: TakeoverBundle, header: SealedEnvelopeHeader | null, prefix = ''): TakeoverBundle {
    if (bundle?.v !== 1 || !bundle.files || typeof bundle.files !== 'object' || !bundle.localConfig) {
        throw new Error(`${prefix}the take-over bundle is not a version 1 bundle`);
    }
    for (const f of BUNDLED_FILES) {
        const v = (bundle.files as any)[f];
        if (v !== null && v !== undefined && (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v))) {
            throw new Error(`${prefix}the bundle's ${f} is not base64`);
        }
    }
    const genesisB64 = bundle.files['genesis.json'];
    if (!genesisB64) throw new Error(`${prefix}the bundle has no genesis.json`);
    let genesis: any;
    try { genesis = JSON.parse(Buffer.from(genesisB64, 'base64').toString('utf-8')); } catch { genesis = null; }
    if (!genesis?.communityId) throw new Error(`${prefix}the bundle's genesis.json is unreadable`);
    const keyB64 = bundle.files.libp2p_key;
    if (!keyB64) throw new Error(`${prefix}the bundle has no node key`);
    let bundlePeerId: string;
    try {
        bundlePeerId = peerIdOfKeyFile(Buffer.from(keyB64, 'base64'));
    } catch {
        throw new Error(`${prefix}the bundle's node key is not an Ed25519 key`);
    }
    if (header) {
        // The bundle belongs to the server that sealed the file, and to the community the header names.
        if (genesis.communityId !== header.communityId) {
            throw new Error(`${prefix}the bundle is from a different community than the file says`);
        }
        if (bundlePeerId !== header.nodePeerId) {
            throw new Error(`${prefix}the bundle's node key is not the key that locked the file`);
        }
    }
    return bundle;
}

function writeAtomic(file: string, data: Buffer, mode: number): void {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
}

/**
 * Write the bundle's identity files and admin fields into this server's data dir. The database already carries
 * the roles and the public address (they are rows in state.db). Names come from the fixed list, never the file.
 * Returns what was written, for the log.
 */
export function applyBundle(bundle: TakeoverBundle): string[] {
    const dir = dataDir();
    const written: string[] = [];
    for (const f of BUNDLED_FILES) {
        const b64 = bundle.files[f];
        if (!b64) continue;
        writeAtomic(path.join(dir, f), Buffer.from(b64, 'base64'), f === 'genesis.json' || f === 'connectors.json' ? 0o644 : 0o600);
        written.push(f);
    }
    // local-config.json: the community's admin and 2FA credentials, and its recovery code's public record, so this
    // server signs owners in with the community's password and keeps locking to the same paper. Everything else
    // in this server's config (its own replication token, callsign, gateway) stays.
    const configPath = path.join(dir, 'local-config.json');
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { config = {}; }
    for (const f of BUNDLED_LOCAL_CONFIG_FIELDS) config[f] = (bundle.localConfig as any)[f] ?? null;
    if (bundle.recoveryCode) {
        config.recoveryCode = bundle.recoveryCode;
        config.recoveryCodeLastId = Math.max(Number(config.recoveryCodeLastId) || 0, bundle.recoveryCode.codeId);
    }
    writeAtomic(configPath, Buffer.from(JSON.stringify(config, null, 2)), 0o600);
    written.push('local-config.json (admin, 2FA, recovery code record)');
    return written;
}
