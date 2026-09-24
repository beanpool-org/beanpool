/**
 * Backup, Replication, Sync, Snapshots, and Restore routes.
 */

import Router from '@koa/router';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {
    getNodeRole, exportSyncState,
    getConversationsByMember, getConversationMessages,
    recordReplicationAccess, getReplicationAccessLog,
} from '../state-engine.js';
import {
    getLocalConfig, saveLocalConfig,
    verifyReplicationToken, generateReplicationToken, setReplicationToken,
    clearReplicationToken, hasReplicationToken,
    updateBackupCadence,
} from '../config/local-config.js';
import { getP2PNode } from '../p2p.js';
import { getBackupStatus, requestResync, getStandbyCredentialState } from '../services/backup-puller.js';
import { getHeldEnvelopesStatus } from '../services/standby-envelopes.js';
import { getEnvelopeHolders } from '../services/takeover-envelope.js';
import { startRestoreUnlock, unlockServerUrl } from '../services/owner-unlock.js';
import {
    createSnapshot, listSnapshots, resolveSnapshotPath, snapshotImagesDir,
    getAutoSnapshotConfig, updateAutoSnapshotConfig,
} from '../services/snapshot-scheduler.js';
import { db, getDbDataVersion } from '../db/db.js';
import {
    assertSafeKey, bucketOf, copyObjectReplacing, getImageStore, imagesDir, scanOurObjectsAsync, type ImageStore,
} from '../storage/image-store.js';
import { referencedStorageKeys } from '../storage/image-columns.js';
import type { RouteDeps } from './types.js';
import { clientIp, clientLimiterKey } from '../client-ip.js';
import { acquirePasswordAttempt, refuseBraked, settlePasswordAttempt } from '../password-brake.js';
import {
    checkRecoveryCode, parseRecoveryCode, RecoveryCodeError, SealedEnvelopeError,
    type CodeStanza, type SealedEnvelopeHeader,
} from '@beanpool/core';
import {
    createSealedBackup, createPlainBackup, backupLockState, describeSealedHeader, isGzip, readFileStart,
    readSealedFileHeader, signerCheck, openSealedFileTo, readBundleFrom, applyBundle, checkBackupArchive,
    MISSING_MEMBER, readInBucketMember,
    type BackupLock, type BackupSource, type StagedImages,
} from '../services/sealed-backup.js';

/** After a restore the node restarts to load what was written. Tests replace it. */
let restartAfterRestore: () => void = () => process.exit(0);
export function setRestoreRestartForTests(fn: (() => void) | null): void {
    restartAfterRestore = fn ?? (() => process.exit(0));
}

function restorePaths() {
    const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    return {
        DATA_DIR,
        tmpDir: path.join(DATA_DIR, '.restore-tmp'),
        uploadPath: path.join(DATA_DIR, 'uploaded-backup.upload'),
        openedTarPath: path.join(DATA_DIR, 'uploaded-backup.opened.tar.gz'),
    };
}

/** Where a sealed upload waits for an owner's phone. One name per upload, so a new restore never hits an old one's file. */
const PENDING_PREFIX = 'uploaded-backup.pending-';

function cleanupRestoreTemp(): void {
    const { tmpDir, uploadPath, openedTarPath } = restorePaths();
    for (const p of [tmpDir, uploadPath, openedTarPath]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/**
 * Put the image store back beside the restored database (storage design §7).
 *
 * Three cases, and all three have to work:
 *
 *   - a backup taken by THIS version, `images/` present: the store is replaced by the archive's copy, so the
 *     `storage_key`s in the restored database resolve;
 *   - a backup taken BEFORE this version, no `images/` member: nothing is copied and nothing is removed. The
 *     restored database still carries every photo inline, exactly as it did when the backup was written, and
 *     the evacuation job moves them out afterwards like it does for any upgrading node;
 *   - a backup from this version restored onto a node that already has an images directory: the archive's
 *     objects are laid over the existing ones. What is NOT in the archive is left alone rather than deleted,
 *     because deleting it is irreversible and the orphan sweep in storage-health will reclaim it safely later.
 *
 * ## Never in place, always temp-then-rename
 *
 * Every other part of this design rests on a store object being written once, under a temp name, and renamed
 * into place — {@link DiskImageStore.put} does exactly that — so an object's INODE is never rewritten and a
 * second name for it (a snapshot's hard link, a backup stage's) is a true point-in-time copy. A `copyFileSync`
 * straight onto an existing object breaks that: it opens the live inode and writes through it, so every
 * `snapshot-*.db.images/` tree hard-linked to that object has its bytes rewritten too, silently, at the one
 * moment an operator is restoring because something already went wrong. `posts/…` keys are content-addressed
 * so the bytes would match anyway, but `attachments/<messageId>.bin` is keyed by the message id alone: the
 * same key in two different backups is two different ciphertexts, and the older snapshot's copy would become
 * the newer one's. {@link copyObjectReplacing} is the one way any of this code copies onto a name that may
 * already exist, and the rule it keeps.
 *
 * `checkBackupArchive` has already refused the whole archive if any member could escape the extraction
 * directory or was a link, so the tree being copied here is known to be plain files under `tmpDir`.
 *
 * Exported for the suite that proves the rule above: it is a pure function of two directories, so the test
 * can restore over a live object a snapshot hard-links without standing up a restore and a restart.
 *
 * Returns what it managed to put back AND what stopped it. A half-restored store is still better than none,
 * so a failure here is not fatal — but it used to be a `console.error` and nothing else, and the caller
 * answered `success: true` over the top of it. The operator found out at the first 503.
 */
export function restoreImages(tmpDir: string, dataDir: string): { restored: number; error: string | null } {
    const src = path.join(tmpDir, 'images');
    // A backup from before this version has no `images/` member, and that is not a failure: every photo is
    // still inline in the database it brought, and the evacuation job moves them out afterwards.
    if (!fs.existsSync(src) || !fs.lstatSync(src).isDirectory()) return { restored: 0, error: null };
    const dest = path.join(dataDir, 'images');
    let copied = 0;
    const walk = (from: string, to: string): void => {
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const fromPath = path.join(from, entry.name);
            const toPath = path.join(to, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                fs.mkdirSync(toPath, { recursive: true, mode: 0o700 });
                walk(fromPath, toPath);
            } else if (entry.isFile()) {
                fs.mkdirSync(path.dirname(toPath), { recursive: true, mode: 0o700 });
                copyObjectReplacing(fromPath, toPath);
                copied++;
            }
        }
    };
    try {
        fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
        walk(src, dest);
        console.log(`[Restore] Restored ${copied} image object(s) from the backup.`);
    } catch (e: any) {
        // Loud, and NOT fatal: the database is already in place and a half-restored store is still better
        // than none. The operator needs to know some photos may be missing — so this goes back to the
        // caller as well as to the log, and into the answer the person restoring is looking at.
        console.error('[Restore] ⚠️  Could not restore the image store; some photos may be missing:', e);
        return { restored: copied, error: String(e?.message || e) };
    }
    return { restored: copied, error: null };
}

/** A directory with at least one file somewhere under it (an archive's `images/` that actually carries objects). */
function hasAnyFile(dir: string): boolean {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
        if (e.isFile()) return true;
        if (e.isDirectory() && hasAnyFile(path.join(dir, e.name))) return true;
    }
    return false;
}

/** The host of an endpoint an archive named, for a sentence — never the whole string it carried. */
function safeHost(endpoint: string): string {
    try { return new URL(endpoint).host; } catch { return 'an unreadable endpoint'; }
}

/**
 * The short-backup manifest inside the archive, when it carries one.
 *
 * Its presence IS the label: `sealed-backup.ts` writes {@link MISSING_MEMBER} only for a backup that came
 * up short, and puts it inside the archive precisely because that is the copy which outlives the HTTP
 * response. This is the moment it was written for — the `X-Backup-Missing-Images` header that said so went
 * out with the response a year ago, and the operator restoring the file has only what is in it.
 *
 * Never throws: an unreadable manifest is still a label, and a restore does not fail over one.
 */
function readMissingManifest(tmpDir: string): { missing: string[]; referenced: number | null; takenAt: string | null } | null {
    const file = path.join(tmpDir, MISSING_MEMBER);
    try {
        if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return null;
    } catch {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            missing: Array.isArray(parsed?.missing) ? parsed.missing.filter((k: unknown) => typeof k === 'string') : [],
            referenced: Number.isFinite(parsed?.referenced) ? Number(parsed.referenced) : null,
            takenAt: typeof parsed?.takenAt === 'string' ? parsed.takenAt : null,
        };
    } catch {
        // Present but unreadable. Present is the label; an unknown count beats reporting "complete".
        return { missing: [], referenced: null, takenAt: null };
    }
}

/**
 * What the node will actually be missing once this restore finishes, read off the restored data.
 *
 * The manifest is a label the archive carries, and a label is not a measurement. A backup taken with no
 * `images/` at all, or one whose `images/` was stripped in transit, carries no manifest and used to restore
 * as `complete: true, missing: 0` over a database whose every `storage_key` points at nothing — the operator
 * found out at the first 503. So the count that drives the answer comes from the same place a photo request
 * will come from: the `storage_key`s in the database that is now on disk, checked against the store that is
 * now beside it.
 *
 * Runs AFTER {@link restoreImages}, so the archive's objects are already in the store: a key that cannot be
 * found here is one no copy of this node still holds, including the case where `restoreImages` itself failed
 * part-way. A pre-version backup references no keys at all (its photos are inline in the rows it brought),
 * so it truthfully measures as complete.
 *
 * Never throws. A database this cannot read is one the restart will fail on anyway, and a restore does not
 * become an error because the count could not be taken — but `complete` must not be claimed either, so an
 * unreadable database comes back as `null` and the caller says it does not know.
 */
async function missingAfterRestore(dataDir: string, store: ImageStore): Promise<{ referenced: number; missing: string[] } | null> {
    let keys: string[];
    try {
        const handle = new Database(path.join(dataDir, 'state.db'), { readonly: true });
        try {
            keys = referencedStorageKeys(handle);
        } finally {
            try { handle.close(); } catch { /* the read is done */ }
        }
    } catch (e) {
        console.error('[Restore] Could not read the restored database to check its image objects:', e);
        return null;
    }
    // An s3 node: the objects are wherever the bucket says, so the bucket's listing is the measurement —
    // async, one request per thousand objects. A listing that fails is "could not check", never "complete".
    const bucket = bucketOf(store);
    if (bucket) {
        if (keys.length === 0) return { referenced: 0, missing: [] };
        let present: Set<string>;
        try {
            present = new Set((await scanOurObjectsAsync(store)).map((o) => o.key));
        } catch (e) {
            console.error(`[Restore] Could not list ${bucket.where} to check the restored database's photos:`, e);
            return null;
        }
        const missing: string[] = [];
        for (const key of keys) {
            try { assertSafeKey(key); } catch { missing.push(key); continue; }
            if (!present.has(key)) missing.push(key);
        }
        return { referenced: keys.length, missing };
    }
    const root = imagesDir(dataDir);
    const missing: string[] = [];
    for (const key of keys) {
        // A storage_key out of a restored database is attacker-controlled input like any other row value.
        // An unusable one names no object that can ever be served, so it is missing, never a path.
        try { assertSafeKey(key); } catch { missing.push(key); continue; }
        try {
            if (!fs.lstatSync(path.join(root, key)).isFile()) missing.push(key);
        } catch {
            missing.push(key);
        }
    }
    return { referenced: keys.length, missing };
}

/**
 * The restore from an opened (or legacy plain) tar on: the hostile-archive checks, state.db, node_config.json, the
 * take-over bundle when a sealed file carries one, then a restart. Shared by restore-by-code and restore by an
 * owner's phone. Returns the answer body; throws on a bad archive (the caller cleans up).
 */
async function restoreFromTar(
    tarPath: string, sealedHeader: SealedEnvelopeHeader | null, signerAcceptedByName: boolean, restartAfterMs = 1000,
): Promise<Record<string, unknown>> {
    const { execFileSync } = await import('node:child_process');
    const { DATA_DIR, tmpDir } = restorePaths();

    // Extract the tar
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    // SECURITY (SRV-9a): a restore archive is fully attacker-controlled input — and so is the archive inside a
    // sealed file: opening it only proves someone holding a key locked it. checkBackupArchive refuses the WHOLE
    // archive if any member would escape the extraction dir or is a link, BEFORE a byte is extracted.
    // Legitimate backups are written with `tar -C <stage> .`, so members are plain `./`-prefixed paths.
    checkBackupArchive(tarPath);

    execFileSync('tar', ['-xzf', tarPath, '-C', tmpDir]);

    // Validate that state.db exists and is a regular file
    const restoredDb = path.join(tmpDir, 'state.db');
    if (!fs.existsSync(restoredDb) || !fs.lstatSync(restoredDb).isFile()) {
        throw new Error('Invalid backup archive: state.db missing');
    }
    // The take-over bundle, when the backup carries one: checked in full BEFORE anything is replaced. Only a
    // sealed file's bundle is used; a plain archive is anyone's to write, so keys in one are never installed.
    // Nor are they from a file let through by X-Accept-Signer: anyone who has seen a header can make one
    // (signerCheck), so naming its signer restores the database only. Harvester-sealed files carry none.
    const bundle = sealedHeader && !signerAcceptedByName ? readBundleFrom(tmpDir, sealedHeader) : null;
    if (sealedHeader && signerAcceptedByName && fs.existsSync(path.join(tmpDir, 'takeover-bundle.json'))) {
        console.warn(`[Restore] Ignored the keys inside a backup signed by ${sealedHeader.nodePeerId}, accepted by name: database only.`);
    }

    // Where this node keeps its photos, and where the backup's are. Decided BEFORE anything is replaced.
    const store = getImageStore();
    const nodeBucket = bucketOf(store);
    const archiveBucket = readInBucketMember(tmpDir);
    if (nodeBucket && hasAnyFile(path.join(tmpDir, 'images'))) {
        // An archive with its photos inside it, onto a node that keeps photos in a bucket. Laying them on this
        // node's disk would put them where an s3 node never looks (and its next boot refuses a disk that holds
        // objects); uploading them is moving a node from disk to a bucket, which is the migration tool's job
        // and not in this version. So nothing is touched, and the operator is told where this file CAN go.
        const err: any = new Error(
            'This backup carries its photos and attachments inside it: it was taken on a node that keeps them on disk. '
            + `This node keeps them in ${nodeBucket.where} (IMAGE_STORE=s3), and moving photos from a backup into a `
            + 'bucket needs the migration tool, which this version does not have. Nothing was changed. Restore this '
            + 'file on a node without IMAGE_STORE set (photos on disk).',
        );
        err.httpStatus = 409;
        throw err;
    }

    // Close current DB connection safely before overwriting
    const { db } = await import('../db/db.js');
    try { db.close(); } catch (e) { console.error('Error closing DB:', e); }

    // Replace files
    fs.copyFileSync(path.join(tmpDir, 'state.db'), path.join(DATA_DIR, 'state.db'));
    // On an s3 node nothing goes to the local disk: the archive has no objects (refused above if it had), and
    // the database's keys resolve against the bucket.
    const images = nodeBucket ? { restored: 0, error: null } : restoreImages(tmpDir, DATA_DIR);
    // Read BEFORE cleanupRestoreTemp deletes tmpDir. A short backup says so inside the archive precisely so
    // that it can be said here, to the person doing the restore, instead of being discovered at the first 503.
    const short = readMissingManifest(tmpDir);
    if (short) {
        console.warn(
            `[Restore] ⚠️  This backup is SHORT: ${short.missing.length || 'an unstated number of'} image `
            + `object(s) were already gone from the node when it was taken${short.takenAt ? ` (${short.takenAt})` : ''}, `
            + `so those photos or attachments are not coming back. First: ${short.missing.slice(0, 3).join(', ') || '(not listed)'}`,
        );
    }
    const nodeConfig = path.join(tmpDir, 'node_config.json');
    if (fs.existsSync(nodeConfig) && fs.lstatSync(nodeConfig).isFile()) {
        fs.copyFileSync(nodeConfig, path.join(DATA_DIR, 'node_config.json'));
    }
    const restoredKeys = bundle ? applyBundle(bundle) : [];
    if (bundle) console.log(`[Restore] Restored the community's keys from the sealed backup: ${restoredKeys.join(', ')}`);

    // What this node is REALLY missing, counted off the restored database and the store now beside it —
    // not read off the archive's label. This is the number that decides `complete`.
    const shortfall = await missingAfterRestore(DATA_DIR, store);
    if (shortfall && shortfall.missing.length > 0) {
        console.warn(
            `[Restore] ⚠️  ${shortfall.missing.length} of the ${shortfall.referenced} image object(s) this `
            + `database references are not in the store after the restore, so those photos or attachments will `
            + `not load: ${shortfall.missing.slice(0, 5).join(', ')}${shortfall.missing.length > 5 ? ', …' : ''}`
            + `${short ? ' The backup itself was labelled short, which explains it.' : ''}`,
        );
    }

    cleanupRestoreTemp();

    // Restart shortly. A restore by phone waits longer: the screen that started it polls to see it finished.
    setTimeout(() => {
        console.log('Restore successful, rebooting node...');
        restartAfterRestore();
    }, restartAfterMs);

    // `complete` is the one an operator reads: the database is in and the node is restarting either way, so
    // `success` stays true — but a restore that could not put every object back must never answer with
    // nothing but `success: true`, which is what it did before.
    //
    // And it is the MEASURED count, not the archive's label: `shortfall` is what the restored database
    // references and the store beside it does not hold. The manifest only explains WHY — already gone when
    // the backup was taken, rather than never in the archive at all, which is what a `databaseOnly` or
    // images-stripped file looks like and what used to restore as "complete".
    const lacking = shortfall ? shortfall.missing.length : 0;
    // A backup from an s3 node carries no objects: they are in the bucket its label names. Said plainly, and
    // differently for where it has landed — on a disk node nothing will load until the photos come back from
    // that bucket; on an s3 node they load from the bucket, and a different bucket is worth naming.
    const archiveWhere = archiveBucket
        ? `the S3 bucket "${archiveBucket.bucket || 'unnamed'}"${archiveBucket.endpoint ? ` at ${safeHost(archiveBucket.endpoint)}` : ''}`
        : null;
    const otherBucket = !!(archiveBucket && nodeBucket && archiveBucket.bucket && archiveBucket.bucket !== nodeBucket.bucket);
    const inBucketWarning = archiveBucket && !nodeBucket
        ? `The database was restored, but its photos and attachments were not in this file: they stay in ${archiveWhere}, `
          + 'where the node this backup came from keeps them. This node keeps photos on its own disk, so '
          + (shortfall ? `${lacking} of the ${shortfall.referenced} photo(s) or attachment(s) the database references ` : 'its photos ')
          + 'will not load here until they are brought back from that bucket.'
        : archiveBucket && nodeBucket && (lacking > 0 || !shortfall)
            ? (shortfall
                ? `The database was restored. Its photos and attachments stay in the bucket, and ${lacking} of the `
                  + `${shortfall.referenced} it references are not in ${nodeBucket.where}`
                : `The database was restored. Its photos and attachments stay in the bucket, but ${nodeBucket.where} `
                  + 'could not be listed to check they are all there')
              + (otherBucket ? ` — the backup was taken from ${archiveWhere}, a different bucket.` : '.')
              + (short ? ' The backup itself was labelled short, which explains some of it.' : '')
            : null;
    // Three different things to say, and the operator needs to be able to tell them apart: the store could
    // not be written; the backup itself was already short when it was taken (the manifest says so); or the
    // archive simply did not carry the objects this database names, which is what a stripped one looks like.
    const warning = inBucketWarning ?? (images.error
        ? `The database was restored, but the image store was not put back in full: ${images.error}. `
          + `${images.restored} object(s) went back`
          + (lacking ? `, and ${lacking} of the ${shortfall!.referenced} the database references are still missing` : '')
          + '; some photos or attachments will be missing.'
        : lacking > 0
            ? short
                ? `The backup was SHORT: ${lacking} of the ${shortfall!.referenced} photo(s) or attachment(s) this `
                  + 'database references were already gone from the node when the backup was taken, and are not '
                  + 'coming back. Everything else came back.'
                : `The database was restored, but ${lacking} of the ${shortfall!.referenced} photo(s) or `
                  + 'attachment(s) it references are not on this node: this archive did not carry them. '
                  + 'Everything else came back.'
            : !shortfall
                ? 'The database was restored, but this node could not check whether its photos and '
                  + 'attachments came with it.'
                : null);
    return {
        success: true,
        complete: !images.error && !!shortfall && lacking === 0,
        images: {
            restored: images.restored,
            error: images.error,
            // Measured, so an archive with no `images/` member and no manifest cannot answer 0.
            referenced: shortfall ? shortfall.referenced : null,
            missing: lacking,
            missingKeys: shortfall ? shortfall.missing.slice(0, 5) : [],
            // The label the archive carried, when it carried one: the explanation, never the count.
            labelledShort: !!short,
            // Where this backup's objects are when it came from an s3 node: not in the file.
            inBucket: archiveBucket ? { bucket: archiveBucket.bucket, endpointHost: safeHost(archiveBucket.endpoint) } : null,
            // Where THIS node keeps them now.
            store: nodeBucket ? { kind: 's3', bucket: nodeBucket.bucket } : { kind: 'disk' },
        },
        ...(warning ? { warning } : {}),
        sealed: !!sealedHeader,
        restoredKeys: restoredKeys.length > 0,
        ...(signerAcceptedByName ? { keysIgnored: true, note: 'Accepted by its signer\'s name: the database came back; keys and passwords inside it were not used.' } : {}),
        ...(sealedHeader ? { backup: describeSealedHeader(sealedHeader) } : {}),
    };
}

export function createBackupRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    // Helper: resolve the public URL for backup enrollment
    function resolvePrimaryUrl(ctx: any): string {
        if (process.env.CF_RECORD_NAME) return 'https://' + process.env.CF_RECORD_NAME;
        const host = ctx.request.header['x-forwarded-host'] || ctx.request.header['host'] || ctx.host;
        const proto = (ctx.request.header['x-forwarded-proto'] as string) || ctx.protocol || 'https';
        return proto + '://' + host;
    }

    /** Real client IP for replication logging (client-ip.ts: forwarding headers only from our own tunnel/proxy) */
    function replicationClientIp(ctx: any): string {
        return clientIp(ctx);
    }

    // Conditional pull state for sync-snapshot
    let lastSnapshotExport: { generatedAt: string; dataVersion: number } | null = null;

// ======================== DATABASE BACKUP ========================

// Backups (sealed-keys.md §6.1, seal review round 1). With a recovery code the response is a `.bpsealed` envelope —
// the tar of state.db, node_config.json and the take-over bundle, locked to every owner and the code — whichever
// credential asked; the replication token may fetch it, because what it gets is ciphertext. Without a code the only
// opener that ships (the code) could not open a locked file, so the response is the readable backup this route
// always sent — the tar.gz of state.db and node_config.json, no keys — marked as such: X-Backup-Locked: no, the
// reason in X-Backup-Not-Locked, and a log line. Never a file nothing can open, and never a false "locked".
function markLock(ctx: any, lock: BackupLock): void {
    ctx.set('X-Backup-Locked', lock.locked ? 'yes' : 'no');
    if (!lock.locked) ctx.set('X-Backup-Not-Locked', lock.message);
}

/**
 * Say what the file actually holds, so a short backup is visible on the wire and not only at restore time
 * (storage design §7). The harvester copies these into its log for every node it pulls, and both UIs show
 * the shortfall from them.
 *
 * `X-Backup-Contents` is `database+images`, or `database+images-partial` when the store could not supply
 * every object the database references. `X-Backup-Images` is always `<staged>/<referenced>` — equal for a
 * whole backup, deliberately unequal for a short one — and `X-Backup-Missing-Images` counts what is not
 * there. A short backup is still a 200: these headers are how the caller learns it is short.
 */
function markContents(ctx: any, what: { images: StagedImages }): void {
    const short = what.images.missing.length > 0;
    if (what.images.inBucket) {
        // An s3 node: the objects are in the bucket, not in the file. `in-bucket` rather than `0/N`, so no
        // reader can take this for a backup that lost every photo — or for one that carries them.
        const b = what.images.inBucket;
        ctx.set('X-Backup-Contents', 'database+images-in-bucket');
        ctx.set('X-Backup-Images', 'in-bucket');
        ctx.set('X-Backup-Image-Bytes', '0');
        ctx.set('X-Backup-Images-Bucket', b.bucket.replace(/[^\x20-\x7E]/g, '?'));
        ctx.set('X-Backup-Images-Referenced', String(what.images.referenced));
        ctx.set('X-Backup-Images-Checked', b.checked ? 'yes' : 'no');
        if (short) ctx.set('X-Backup-Missing-Images', String(what.images.missing.length));
        return;
    }
    ctx.set('X-Backup-Contents', short ? 'database+images-partial' : 'database+images');
    ctx.set('X-Backup-Images', `${what.images.staged}/${what.images.referenced}`);
    ctx.set('X-Backup-Image-Bytes', String(what.images.bytes));
    if (short) ctx.set('X-Backup-Missing-Images', String(what.images.missing.length));
}

/** For the log: 'database + 412 image object(s)', or the short version spelled out. */
function describeBackup(what: { images: StagedImages }): string {
    const images = what.images;
    if (images.inBucket) {
        const where = images.inBucket.where;
        if (!images.inBucket.checked) return `database only — its ${images.referenced} image object(s) stay in ${where} (NOT checked: the bucket could not be listed)`;
        if (images.missing.length === 0) return `database only — its ${images.referenced} image object(s) stay in ${where}, all present`;
        return `database only — its ${images.referenced} image object(s) stay in ${where}; SHORT by ${images.missing.length} the bucket does not hold, `
            + `listed in ${MISSING_MEMBER} inside the archive`;
    }
    if (images.missing.length === 0) return `database + ${images.staged} image object(s)`;
    return `database + ${images.staged}/${images.referenced} image object(s) — SHORT by ${images.missing.length}; `
        + `the missing keys are listed in ${MISSING_MEMBER} inside the archive`;
}

/**
 * Send a backup: locked when there is a recovery code, readable when there is not, and in both cases the
 * WHOLE node — the database and the image objects that database references.
 *
 * The readable branch is a tar.gz whatever the source. It used to stream a snapshot's bare `.db`, which since
 * the evacuation is a database whose every photo and attachment is a `storage_key` pointing at bytes the file
 * does not carry: a download that looks like a backup and restores an empty gallery.
 */
async function sendBackup(ctx: any, opts: BackupSource = {}): Promise<void> {
    const lock = backupLockState();
    /**
     * A short backup is NOT an error (confirmation round 4). It used to be — and since no shipped UI could
     * send the `allowMissing=1` the refusal named, one object lost for good made this node un-backupable
     * from the Backup tab, the fleet manager and every snapshot download, for good. So the shortfall is
     * reported and the file is sent: loudly in the log here, in the headers `markContents` sets, and in the
     * manifest inside the archive. Only a real I/O error still fails a backup.
     */
    const shout = (what: { images: StagedImages }, filename: string): void => {
        if (what.images.missing.length === 0) return;
        if (what.images.inBucket) {
            console.warn(
                `[Backup] ⚠️  ${filename} is SHORT: ${what.images.missing.length} of the ${what.images.referenced} image `
                + `object(s) its database references are not in ${what.images.inBucket.where}, and are listed in `
                + `${MISSING_MEMBER} inside the archive: ${what.images.missing.slice(0, 5).join(', ')}`
                + `${what.images.missing.length > 5 ? ', …' : ''}. Those photos or attachments are gone from the bucket.`,
            );
            return;
        }
        console.warn(
            `[Backup] ⚠️  ${filename} is SHORT: ${what.images.staged} of ${what.images.referenced} referenced `
            + `image object(s) went in. ${what.images.missing.length} are not in this node's store and are `
            + `listed in ${MISSING_MEMBER} inside the archive: ${what.images.missing.slice(0, 5).join(', ')}`
            + `${what.images.missing.length > 5 ? ', …' : ''}. Those photos or attachments are gone from this `
            + `node; the backup carries everything else.`,
        );
    };
    try {
        if (!lock.locked) {
            console.warn(`[Backup] ${lock.message} Sent an unlocked backup (${opts.dbFile ? 'snapshot ' + path.basename(opts.dbFile) : 'database'}).`);
            const plain = await createPlainBackup(opts);
            markLock(ctx, lock);
            markContents(ctx, plain);
            ctx.set('Cache-Control', 'no-store');
            ctx.set('Content-Type', 'application/gzip');
            ctx.set('Content-Disposition', `attachment; filename="${plain.filename}"`);
            ctx.res.on('close', () => plain.cleanup());
            ctx.body = plain.body;
            console.log(`[Backup] ${plain.filename}: ${describeBackup(plain)}`);
            shout(plain, plain.filename);
            return;
        }
        const backup = await createSealedBackup(opts);
        const who = describeSealedHeader(backup.header);
        markLock(ctx, lock);
        markContents(ctx, backup);
        ctx.set('Cache-Control', 'no-store');
        ctx.set('Content-Type', 'application/octet-stream');
        ctx.set('Content-Disposition', `attachment; filename="${backup.filename}"`);
        ctx.set('X-Envelope-Id', backup.header.envelopeId);
        ctx.set('X-Sealed-To', who.opensWith.replace(/[^\x20-\x7E]/g, '?'));
        ctx.res.on('close', () => backup.cleanup());
        ctx.body = backup.body;
        console.log(`[Backup] ${backup.filename}: ${describeBackup(backup)}`);
        shout(backup, backup.filename);
    } catch (e: any) {
        // Only a real failure gets here now: ENOSPC, EACCES, a read error on an object that IS there, a
        // truncated write, a tar that did not run. A file of unknown contents is not a backup, so it is an
        // error — where a KNOWN shortfall is a 200 with the counts.
        console.error('Backup failed:', e);
        ctx.status = 500;
        ctx.body = { error: 'Backup failed: ' + (e?.message || 'unknown error') };
    }
}

router.post('/api/local/admin/backup', async (ctx) => {
    const token = ctx.request.header['x-replication-token'];
    const isTokenValid = token && (await verifyReplicationToken(String(token)));
    if (!isTokenValid && !(await checkAdminAuth(ctx as any))) return;
    await sendBackup(ctx);
});

// The plain-text identity bundle (`/api/local/admin/identity-bundle`) is gone (§6.1): the node keys now travel
// only inside a locked backup, which needs a recovery code. The route is not mounted: every credential gets a 404.

// ======================== BACKUP TAB ========================
// Read-only enrollment bundle for standing up a NEW backup server that joins
// THIS node's community. The operator runs `scripts/setup-backup.mjs` on the
// would-be backup machine; it GETs this with the X-Admin-Password header,
// writes genesis.json into the backup's data dir, and configures the backup to
// pull from this primary. Returns ONLY public material the backup needs to
// recognize this primary's identity — no key (a standby never needed
// community.key; sealed-keys.md §1.1, §6.1) — and it mutates nothing.


router.get('/api/local/admin/backup-enroll', async (ctx) => {
    const headerPassword = ctx.request.header['x-admin-password'];
    if (headerPassword) (ctx as any).requestBody = { password: headerPassword };
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        const genesisPath = path.join(DATA_DIR, 'genesis.json');
        if (!fs.existsSync(genesisPath)) {
            ctx.status = 503;
            ctx.body = { error: 'Genesis not initialized yet' };
            return;
        }
        const genesis = JSON.parse(fs.readFileSync(genesisPath, 'utf-8'));
        const node = getP2PNode();
        const primaryPeerId = node?.peerId?.toString() ?? null;
        if (!primaryPeerId) {
            ctx.status = 503;
            ctx.body = { error: 'Node signing identity not ready yet — try again shortly' };
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = {
            communityId: genesis.communityId,
            genesis,
            primaryPeerId,
            primaryUrl: resolvePrimaryUrl(ctx),
        };
    } catch (e: any) {
        console.error('[Backup] backup-enroll failed:', e);
        ctx.status = 500;
        ctx.body = { error: 'Failed to build enrollment bundle' };
    }
});

// Live health tile for the Backup tab: this node's role + (if a backup) the
// primary it's pulling, plus the puller's last-success / failure-streak state.
router.post('/api/local/admin/backup-status', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const config = getLocalConfig();
    ctx.body = {
        role: getNodeRole(),
        primaryUrl: config.backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL || null,
        intervalMs: Number(process.env.BACKUP_PULL_INTERVAL_MS) || 60000,
        ...getBackupStatus(),
        credential: getNodeRole() === 'backup' ? getStandbyCredentialState() : null,
        // A standby: the main server's locked take-over keys it holds (never opened here), and whether they changed.
        takeoverEnvelopes: getNodeRole() === 'backup' ? getHeldEnvelopesStatus() : null,
        // Whether the next backup leaves locked, and if not why, in words the manager can show as they are.
        backupLock: backupLockState(),
    };
});

// Booleans and an operator-facing warning only. Never a secret.
router.post('/api/local/admin/replication-config/get', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const config = getLocalConfig();
    const credential = getStandbyCredentialState();
    ctx.body = {
        primaryUrl: config.backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL || '',
        hasPassword: credential.passwordStored || credential.passwordInEnv,
        hasToken: !!(config.backupReplicationToken || process.env.BACKUP_REPLICATION_TOKEN),
        credential,
    };
});

// A standby copies with a replication token only. The main server's admin password is
// refused: a standby that kept it held it in plain text, so anyone with the standby's disk,
// or a backup of it, had the main server's admin password.
router.post('/api/local/admin/replication-config/save', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { primaryUrl, primaryPassword, primaryToken } = (ctx as any).requestBody || {};
    if (primaryPassword) {
        ctx.status = 400;
        ctx.body = {
            error: "A standby copies with a replication token, not the main server's admin password. " +
                'On the main server open Replication Access, make a token, and paste it here.',
        };
        return;
    }
    if (typeof primaryUrl !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'primaryUrl is required' };
        return;
    }

    const config = getLocalConfig();
    config.backupPrimaryUrl = primaryUrl.trim() || null;
    // Replication token this standby presents to its main server. Empty string clears it
    // (copying stops until a new one is saved); undefined leaves it unchanged.
    if (primaryToken !== undefined) {
        config.backupReplicationToken = (typeof primaryToken === 'string' && primaryToken.trim()) ? primaryToken.trim() : null;
    }
    // A saved token supersedes a legacy stored admin password: wipe it.
    if (config.backupReplicationToken) config.backupAdminPassword = null;
    saveLocalConfig(config);
    ctx.body = { success: true, credential: getStandbyCredentialState() };
});

// ---------- Replication token (primary side) ----------
// A dedicated, scoped credential for the snapshot-pull endpoint, distinct from the
// admin password: least-privilege (read-only replication only) and independently
// rotatable. Stored hashed; the plaintext is shown to the operator exactly once.
router.post('/api/local/admin/replication-token/status', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const config = getLocalConfig();
    ctx.body = {
        hasToken: hasReplicationToken(),
        tokenOnly: !!config.replicationTokenOnly,
        createdAt: config.replicationTokenCreatedAt || null,
    };
});

router.post('/api/local/admin/replication-token/generate', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const token = generateReplicationToken();
    setReplicationToken(token);
    // Returned ONCE — only the hash is persisted, so it can never be shown again.
    ctx.body = { success: true, token };
});

router.post('/api/local/admin/replication-token/mode', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { tokenOnly } = (ctx as any).requestBody || {};
    const config = getLocalConfig();
    if (tokenOnly && !hasReplicationToken()) {
        ctx.status = 400;
        ctx.body = { error: 'Generate a replication token before enabling token-only mode.' };
        return;
    }
    config.replicationTokenOnly = !!tokenOnly;
    saveLocalConfig(config);
    ctx.body = { success: true, tokenOnly: config.replicationTokenOnly };
});

router.post('/api/local/admin/replication-token/clear', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    clearReplicationToken();
    ctx.body = { success: true };
});

// ---------- Replication access log (primary side) ----------
router.post('/api/local/admin/replication-access', async (ctx) => {
    const token = ctx.request.header['x-replication-token'] || (ctx as any).requestBody?.token;
    const isTokenValid = token && (await verifyReplicationToken(String(token)));
    if (!isTokenValid && !(await checkAdminAuth(ctx as any))) return;
    ctx.body = {
        ...getReplicationAccessLog(),
        tokenOnly: !!getLocalConfig().replicationTokenOnly,
        hasToken: hasReplicationToken(),
        // Which standby last fetched which take-over envelope.
        envelopeHolders: getEnvelopeHolders(),
    };
});

// ---------- Force resync (backup side) ----------
router.post('/api/local/admin/replication-resync', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const result = await requestResync();
    if (!result.ok) {
        ctx.status = 400;
        ctx.body = { error: result.error || 'Resync failed' };
        return;
    }
    ctx.body = { success: true };
});

// ---------- Auto-snapshots (local point-in-time archive) ----------
// All snapshot file ops are path-traversal-safe: a caller-supplied `name` is
// resolved via resolveSnapshotPath(), which accepts only a bare basename that
// resolves directly inside data/snapshots/.
router.post('/api/local/admin/snapshots/list', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { success: true, snapshots: listSnapshots(), config: getAutoSnapshotConfig() };
});

router.post('/api/local/admin/snapshots/create', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const info = createSnapshot();
        ctx.body = { success: true, snapshot: info };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e?.message || 'Snapshot failed' };
    }
});

router.post('/api/local/admin/snapshots/delete', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { name } = (ctx as any).requestBody || {};
    const target = resolveSnapshotPath(name);
    if (!target) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid snapshot name' };
        return;
    }
    try {
        // The captured objects go with it, as they do when pruning: a snapshot's images are part of the
        // snapshot, and a directory left behind belongs to nothing and is swept by nothing.
        fs.rmSync(snapshotImagesDir(target), { recursive: true, force: true });
        if (fs.existsSync(target)) fs.unlinkSync(target);
        ctx.body = { success: true };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e?.message || 'Delete failed' };
    }
});

// Download via GET so the browser can stream it; auth via the X-Admin-Password
// header (the name is in the query string, never the password). Locked like /backup when there is a code.
router.get('/api/local/admin/snapshots/download', async (ctx) => {
    const headerPassword = ctx.request.header['x-admin-password'];
    if (headerPassword) (ctx as any).requestBody = { password: headerPassword };
    if (!(await checkAdminAuth(ctx as any))) return;
    const name = ctx.query.name as string;
    const target = resolveSnapshotPath(name);
    if (!target || !fs.existsSync(target)) {
        ctx.status = 404;
        ctx.body = { error: 'Snapshot not found' };
        return;
    }
    // Locked on the way out, like /backup (§6.1): the snapshot becomes the backup's state.db. The file in
    // data/snapshots/ stays as it is — it sits beside the live plaintext database, so sealing it protects nothing.
    // Without a code: a readable tar.gz of the same contents, marked not locked.
    //
    // `imagesDir` is the snapshot's OWN captured objects, never the live store: that is what makes the file
    // the point-in-time recovery point it claims to be, whatever has been replaced or deleted since.
    const base = path.basename(target, '.db').replace(/[^A-Za-z0-9_-]/g, '_');
    await sendBackup(ctx, {
        dbFile: target,
        imagesDir: snapshotImagesDir(target),
        filenamePrefix: `beanpool-${base}`,
    });
});

// Get (no body) or set (with {enabled,intervalHours,keep}) the auto-snapshot config.
router.post('/api/local/admin/snapshots/config', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    const hasUpdate = body.enabled !== undefined || body.intervalHours !== undefined || body.keep !== undefined;
    const config = hasUpdate
        ? updateAutoSnapshotConfig({ enabled: body.enabled, intervalHours: body.intervalHours, keep: body.keep })
        : getAutoSnapshotConfig();
    ctx.body = { success: true, config };
});

// Verify SQLite integrity check on active database or snapshot (PRAGMA integrity_check)
router.post('/api/local/admin/backup/verify', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { name } = (ctx as any).requestBody || {};
    try {
        if (name) {
            const target = resolveSnapshotPath(name);
            if (!target || !fs.existsSync(target)) {
                ctx.status = 404;
                ctx.body = { error: 'Snapshot not found' };
                return;
            }
            const snapDb = new Database(target, { readonly: true });
            let check: any[];
            try {
                check = snapDb.pragma('integrity_check') as any[];
            } finally {
                snapDb.close();
            }
            const ok = Array.isArray(check) && check.length === 1 && check[0]?.integrity_check === 'ok';
            ctx.body = { success: true, ok, result: check, verifiedAt: new Date().toISOString() };
        } else {
            const check = db.pragma('integrity_check') as any[];
            const ok = Array.isArray(check) && check.length === 1 && check[0]?.integrity_check === 'ok';
            ctx.body = { success: true, ok, result: check, verifiedAt: new Date().toISOString() };
        }
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e.message || 'Integrity check failed' };
    }
});

// Backup pull cadence — operator-tunable from the fleet manager. GET returns the
// effective values (config → env → default) + live puller status; POST overrides
// them in local-config, read live by the backup puller on its next tick (no restart).
// pullSeconds = how often to ask "what changed?" (cheap delta). reconcileMinutes =
// how often to do a full re-read (0 = off; drift-triggered fulls still run).
router.post('/api/local/admin/backup-config', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    if (body.pullSeconds !== undefined || body.reconcileMinutes !== undefined) {
        updateBackupCadence({ pullSeconds: body.pullSeconds, reconcileMinutes: body.reconcileMinutes });
    }
    ctx.body = { success: true, status: getBackupStatus() };
});

// Phase 1 (one-directional live backup): the read-only snapshot the BACKUP
// pulls over HTTPS. This is the entire inbound channel of the new topology —
// state flows primary → backup ONLY, so the primary never imports peer data
// and the SRV-20/21 ledger-forgery vector has no trusted writer.
//
// It is a pure EXPORT: it returns the same signed `SyncPayload` the P2P sync
// path produces (exportSyncState already signs with the node's libp2p key),
// and calls NOTHING that mutates state — serving it adds zero inbound trust.
// Gated by the admin password (shared operator secret, sent in the
// X-Admin-Password header like /restore, never in the URL); routes under
// /api/local/* bypass the member-signature middleware. The backup verifies
// the signature against its single configured `mirror` connector (the
// primary) inside importRemoteState, so a forged snapshot is rejected there.
// The last full snapshot this primary exported: its signed generatedAt stamp and
// the DB data_version at build time. Lets the handler below answer "unchanged"
// (304) to the mirror's every-60s pull without rebuilding the whole ledger.


router.get('/api/local/admin/sync-snapshot', async (ctx) => {
    // This endpoint emits the ENTIRE ledger (incl. DMs + recovery data). It is
    // authenticated with a dedicated, scoped replication TOKEN (least privilege,
    // independently rotatable). The all-powerful admin password is still accepted
    // during rollout — until the operator enables token-only — so existing backups
    // keep working. Every pull (and every rejected attempt) is logged for the
    // primary's Replication Access panel.
    const ip = replicationClientIp(ctx);
    const token = ctx.request.header['x-replication-token'];
    const headerPassword = ctx.request.header['x-admin-password'];
    const cfg = getLocalConfig();
    let authMode: 'token' | 'admin-pw' | null = null;

    if (token) {
        if (await verifyReplicationToken(String(token))) {
            authMode = 'token';
        } else {
            recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'invalid replication token' });
            ctx.status = 401;
            ctx.body = { error: 'Invalid replication token' };
            return;
        }
    } else if (headerPassword && !cfg.replicationTokenOnly) {
        (ctx as any).requestBody = { password: headerPassword };
        if (await checkAdminAuth(ctx as any)) {
            authMode = 'admin-pw';
        } else {
            // checkAdminAuth already set 401 + applied the brute-force tarpit delay.
            recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'invalid admin password' });
            return;
        }
    } else {
        recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: cfg.replicationTokenOnly ? 'replication token required' : 'no credentials' });
        ctx.status = 401;
        ctx.body = { error: cfg.replicationTokenOnly ? 'Replication token required' : 'Authentication required' };
        return;
    }

    try {
        // Conditional pull: the mirror sends the generatedAt of its last successful
        // import. If the DB hasn't changed since we built that exact snapshot,
        // answer 304 with no body. Without this, every 60s pull exported, signed
        // and streamed the ENTIRE ledger (~19MB observed = ~27GB/day of transfer)
        // and stalled the event loop for every API client while doing it.
        const cursor = String(ctx.request.header['x-snapshot-cursor'] || '');
        const dataVersionNow = getDbDataVersion();
        if (cursor && lastSnapshotExport &&
            cursor === lastSnapshotExport.generatedAt &&
            dataVersionNow === lastSnapshotExport.dataVersion) {
            ctx.set('Cache-Control', 'no-store');
            ctx.set('X-Node-Role', getNodeRole());
            ctx.status = 304;
            recordReplicationAccess({ at: Date.now(), ip, auth: authMode, reason: 'not modified (304)' });
            return;
        }

        const node = getP2PNode();
        const nodeId = node?.peerId?.toString() ?? 'unknown';
        // data_version is read BEFORE the export: a write that lands mid-export
        // bumps it, so the next conditional check conservatively rebuilds rather
        // than ever serving a stale 304.
        const payload = await exportSyncState(nodeId);
        if (!payload.signature || !payload.publicKey) {
            // No libp2p identity loaded → the backup couldn't verify authorship.
            ctx.status = 503;
            ctx.body = { error: 'Snapshot unavailable: node signing identity not ready' };
            return;
        }
        if (payload.generatedAt) {
            lastSnapshotExport = { generatedAt: payload.generatedAt, dataVersion: dataVersionNow };
        }
        ctx.set('Cache-Control', 'no-store');
        // Advertise our role so a puller can warn if it is replicating from
        // another backup (chained replication is a misconfiguration).
        ctx.set('X-Node-Role', getNodeRole());
        ctx.body = payload;
        recordReplicationAccess({ at: Date.now(), ip, auth: authMode });
    } catch (e: any) {
        console.error('[Backup] Snapshot export failed:', e);
        ctx.status = 500;
        ctx.body = { error: 'Snapshot export failed' };
    }
});

// Cursor-based delta pull. Same scoped replication auth as sync-snapshot, but the
// caller passes X-Since-Cursor (the `cursor` it last imported) and gets back only
// rows mutated since — plus tombstones deleted since — instead of the whole ledger.
// An empty/absent cursor seeds the replica with a full export (its `cursor` is then
// used for subsequent delta pulls). This is the path that scales past the 10 MB
// full-snapshot import cap as DBs grow toward GB. See docs/delta-backup-plan.md.
router.get('/api/local/admin/sync-delta', async (ctx) => {
    const ip = replicationClientIp(ctx);
    const token = ctx.request.header['x-replication-token'];
    const headerPassword = ctx.request.header['x-admin-password'];
    const cfg = getLocalConfig();
    let authMode: 'token' | 'admin-pw' | null = null;

    if (token) {
        if (await verifyReplicationToken(String(token))) {
            authMode = 'token';
        } else {
            recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'invalid replication token' });
            ctx.status = 401;
            ctx.body = { error: 'Invalid replication token' };
            return;
        }
    } else if (headerPassword && !cfg.replicationTokenOnly) {
        (ctx as any).requestBody = { password: headerPassword };
        if (await checkAdminAuth(ctx as any)) {
            authMode = 'admin-pw';
        } else {
            recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'invalid admin password' });
            return;
        }
    } else {
        recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: cfg.replicationTokenOnly ? 'replication token required' : 'no credentials' });
        ctx.status = 401;
        ctx.body = { error: cfg.replicationTokenOnly ? 'Replication token required' : 'Authentication required' };
        return;
    }

    try {
        const since = String(ctx.request.header['x-since-cursor'] || '');
        const node = getP2PNode();
        const nodeId = node?.peerId?.toString() ?? 'unknown';
        // Empty since → no cursor yet → full seed export (its payload.cursor drives
        // subsequent deltas). Otherwise ship only rows with watermark >= since.
        const payload = await exportSyncState(nodeId, since || null);
        if (!payload.signature || !payload.publicKey) {
            ctx.status = 503;
            ctx.body = { error: 'Delta unavailable: node signing identity not ready' };
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.set('X-Node-Role', getNodeRole());
        ctx.body = payload;
        recordReplicationAccess({ at: Date.now(), ip, auth: authMode, reason: since ? 'delta' : 'delta (full seed)' });
    } catch (e: any) {
        console.error('[Backup] Delta export failed:', e);
        ctx.status = 500;
        ctx.body = { error: 'Delta export failed' };
    }
});

// Restore (sealed-keys.md §6.2). Takes either:
//   - a `.bpsealed` backup, opened with the printed recovery code in the X-Recovery-Code header, or with an owner's
//     phone (X-Unlock-With: phone → 202 with the QR; the phone's unlock finishes it, services/owner-unlock.ts).
//     With neither, the answer is 400 with who can open the file, which is the "inspect" step;
//   - a legacy plain `.tar.gz` backup, as before: reading a file someone already has, and refusing it would brick
//     the only backup a self-hoster may own (§9).
// Either way the archive then goes through the SAME hostile-archive checks (SRV-9a) before a byte is extracted.
// A sealed backup that carries the take-over bundle also brings back the node key, community key, genesis,
// connectors and the community's admin/2FA credentials, so the server comes back as itself.
router.post('/api/local/admin/restore', async (ctx) => {
    // Handle auth via custom header for binary uploads to prevent password exposure in query string
    const headerPassword = ctx.request.header['x-admin-password'];
    if (headerPassword) {
        (ctx as any).requestBody = { password: headerPassword };
    }
    if (!(await checkAdminAuth(ctx as any))) return;

    const { DATA_DIR, uploadPath, openedTarPath } = restorePaths();
    const cleanupAll = cleanupRestoreTemp;
    /** Answer without restoring anything. */
    const refuse = (status: number, body: Record<string, unknown>) => {
        cleanupAll();
        ctx.status = status;
        ctx.body = body;
    };

    try {
        // SECURITY (SRV-11): cap the restore upload so an oversized archive can't
        // exhaust disk. Reject an over-limit Content-Length up front, then enforce
        // the cap on the bytes actually streamed (a lying/absent length is the real
        // attack vector), aborting on overflow. The catch below already removes the
        // partial upload + tmpDir.
        const MAX_RESTORE_BYTES = 500 * 1024 * 1024; // 500 MB
        const declaredLen = Number(ctx.request.header['content-length']);
        if (Number.isFinite(declaredLen) && declaredLen > MAX_RESTORE_BYTES) {
            ctx.status = 413;
            ctx.body = { error: 'Backup archive too large (max 500 MB)' };
            return;
        }
        // Read binary body to file
        const bodyStream = ctx.req;
        const writeStream = fs.createWriteStream(uploadPath, { mode: 0o600 });
        let received = 0;
        await new Promise<void>((resolve, reject) => {
            bodyStream.on('data', (chunk: Buffer) => {
                received += chunk.length;
                if (received > MAX_RESTORE_BYTES) {
                    bodyStream.destroy();
                    writeStream.destroy();
                    reject(Object.assign(new Error('Backup archive too large (max 500 MB)'), { httpStatus: 413 }));
                }
            });
            bodyStream.pipe(writeStream);
            writeStream.on('finish', () => resolve());
            bodyStream.on('error', reject);
            writeStream.on('error', reject);
        });

        // Which kind of file is it? gzip magic → a legacy plain backup; otherwise it must be a sealed one.
        let tarPath: string;
        let sealedHeader: SealedEnvelopeHeader | null = null;
        let signerAcceptedByName = false;
        if (isGzip(readFileStart(uploadPath, 2))) {
            tarPath = uploadPath;
        } else {
            try {
                sealedHeader = readSealedFileHeader(uploadPath);
            } catch {
                return refuse(400, { error: 'This is not a BeanPool backup file (.bpsealed or .tar.gz).' });
            }
            if (sealedHeader.kind !== 'backup') {
                return refuse(400, { error: 'This sealed file is a take-over envelope, not a backup.' });
            }
            const backup = describeSealedHeader(sealedHeader);
            // Restore-by-code checks the header signature wherever this server holds a pin (966 follow-up #2).
            const signer = signerCheck(sealedHeader, ctx.request.header['x-accept-signer'] as string | undefined);
            if (!signer.ok) return refuse(signer.status, { ...signer.body, backup });
            signerAcceptedByName = signer.acceptedByName;

            // Open with an owner's phone (§6.2 step 2): keep the file, start a session, answer with the QR. The
            // phone's unlock finishes the restore (services/owner-unlock.ts), through restoreFromTar like the code.
            const hasOwners = sealedHeader.recipients.some((r) => r.type === 'owner');
            if (String(ctx.request.header['x-unlock-with'] || '').toLowerCase() === 'phone') {
                if (!hasOwners) {
                    return refuse(400, { error: "This backup is locked to the recovery code only: no owner's phone can open it. Type the code.", noOwnerStanza: true, backup });
                }
                for (const n of fs.readdirSync(DATA_DIR)) {
                    if (n.startsWith(PENDING_PREFIX)) fs.rmSync(path.join(DATA_DIR, n), { force: true });
                }
                const pending = path.join(DATA_DIR, PENDING_PREFIX + crypto.randomBytes(8).toString('hex'));
                fs.renameSync(uploadPath, pending);
                const header = sealedHeader;
                const databaseOnly = signerAcceptedByName;
                let session: ReturnType<typeof startRestoreUnlock>;
                try {
                    session = startRestoreUnlock({
                        serverUrl: unlockServerUrl(ctx.request.header['x-unlock-server-url'], ctx.origin),
                        file: pending, header, describe: backup, databaseOnly,
                        finish: async (dataKey) => {
                            try {
                                await openSealedFileTo(pending, { type: 'dataKey', dataKey }, openedTarPath);
                            } catch (e: any) {
                                cleanupRestoreTemp();
                                if (e instanceof SealedEnvelopeError) {
                                    return { ok: false, status: 400, body: { error: 'The backup file did not open: it has been altered or cut short.', backup } };
                                }
                                return { ok: false, status: 500, body: { error: 'Restore failed: ' + (e?.message || e) } };
                            } finally {
                                fs.rmSync(pending, { force: true });
                            }
                            try {
                                return { ok: true, status: 200, body: await restoreFromTar(openedTarPath, header, databaseOnly, 6000) };
                            } catch (e: any) {
                                console.error('Restore failed:', e);
                                cleanupRestoreTemp();
                                return { ok: false, status: e?.httpStatus || 500, body: { error: 'Restore failed: ' + e.message } };
                            }
                        },
                    });
                } catch (e: any) {
                    fs.rmSync(pending, { force: true });
                    return refuse(e?.status || 400, { error: e?.message || 'Could not start the unlock.', backup });
                }
                cleanupAll();
                ctx.status = 202;
                ctx.set('Cache-Control', 'no-store');
                ctx.body = { needsOwnerPhone: true, phone: session, backup, ...(databaseOnly ? { databaseOnly: true } : {}) };
                return;
            }

            const code = ctx.request.header['x-recovery-code'];
            const codeStanzas = sealedHeader.recipients.filter((r): r is CodeStanza => r.type === 'code');
            const needed = codeStanzas.map((c) => `#${c.codeId}`).join(' or ');
            if (typeof code !== 'string' || !code.trim()) {
                const opensWith = [
                    ...(codeStanzas.length ? [`type recovery code ${needed}`] : []),
                    ...(hasOwners ? ["open it with an owner's phone"] : []),
                ].join(', or ');
                return refuse(400, {
                    error: `This backup is locked. To open it, ${opensWith}.`,
                    needsRecoveryCode: codeStanzas.length > 0,
                    ownerPhoneCanOpen: hasOwners,
                    backup,
                });
            }
            // A typo costs nothing and is not a guess: answered before the brake.
            let parsed: ReturnType<typeof parseRecoveryCode>;
            try {
                parsed = parseRecoveryCode(code);
            } catch (e: any) {
                return refuse(400, {
                    error: e instanceof RecoveryCodeError ? e.message : 'That is not a recovery code: check what you typed.',
                    typo: true, backup,
                });
            }
            const stanza = parsed.codeId !== undefined
                ? codeStanzas.find((c) => c.codeId === parsed.codeId)
                : codeStanzas.length === 1 ? codeStanzas[0] : undefined;
            if (!stanza) {
                return refuse(400, {
                    error: !codeStanzas.length
                        ? 'This backup is not locked to any recovery code.'
                        : parsed.codeId !== undefined
                            ? `This backup needs recovery code ${needed}; the code typed is #${parsed.codeId}.`
                            : `This backup takes recovery code ${needed}. Type it with its BPRC number.`,
                    wrongCodeNumber: true,
                    backup,
                });
            }
            // A well-formed code is a guess at a secret: through the password brake, like the check-code route.
            const brakeKey = clientLimiterKey(ctx as any);
            const admission = await acquirePasswordAttempt(brakeKey);
            if (!admission.admitted) {
                cleanupAll();
                refuseBraked(ctx, admission);
                return;
            }
            let matches = false;
            try {
                const { codeId, codePub, salt, N, r, p, createdAt } = stanza;
                matches = await checkRecoveryCode(code, { codeId, codePub, salt, N, r, p, createdAt });
            } catch {
                matches = false;
            } finally {
                settlePasswordAttempt(brakeKey, matches, false);
            }
            if (!matches) {
                return refuse(403, { error: `That is not recovery code #${stanza.codeId}.`, wrongCode: true, backup });
            }
            try {
                await openSealedFileTo(uploadPath, { type: 'code', code }, openedTarPath);
            } catch (e: any) {
                if (e instanceof SealedEnvelopeError) {
                    return refuse(400, { error: 'The backup file did not open: it has been altered or cut short.', backup });
                }
                throw e;
            }
            fs.rmSync(uploadPath, { force: true });
            tarPath = openedTarPath;
        }

        ctx.body = await restoreFromTar(tarPath, sealedHeader, signerAcceptedByName);

    } catch (e: any) {
        console.error('Restore failed:', e);
        cleanupAll();
        ctx.status = e?.httpStatus || 500;
        ctx.body = { error: e?.httpStatus === 413 ? e.message : ('Restore failed: ' + e.message) };
    }
});

    return router;
}
