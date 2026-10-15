/**
 * Restore points: the copy of this server taken before a restore replaces it (design case 18 §3.3, amendment 1).
 *
 * A restore replaces the whole database, node_roles with it, and a sealed file whose signer is pinned replaces the node
 * key, the community key, the admin password and the 2FA too. So before it does, the server keeps itself as it was, in
 * `data/restore-points/<ISO time>-before-restore/`:
 *
 *   - `state.db`, a clean copy of the live database (writeDbSnapshot, the snapshots' own mechanism);
 *   - `state.db.images/`, the objects that database references, hard-linked from the store (captureSnapshotImages);
 *   - `server-files.tar.gz`, the per-server files a sealed restore can replace (SERVER_FILES), as they were;
 *   - `point.json`, why and when.
 *
 * The folder is 0700 and every file in it 0600. It is not sealed: it sits beside the live plaintext database, like
 * data/snapshots, so sealing would protect nothing.
 *
 * No route removes a point, lists it for removal, or changes how long it is kept: a session that can restore a hostile
 * file must not also be able to take away the way back. Retention is fixed here: the newest {@link RESTORE_POINTS_KEPT}
 * are kept; none younger than {@link RESTORE_POINT_MIN_AGE_DAYS} days is ever removed (so restoring three times in a row
 * cannot push the good point out); none older than {@link RESTORE_POINT_MAX_AGE_DAYS} days is kept. The hourly snapshot
 * expiry runs {@link expireRestorePoints} (services/snapshot-scheduler.ts).
 *
 * No room, no restore: a point that cannot be written refuses the restore that needed it ({@link RestorePointError}).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { logger } from '../logger.js';
import { bucketOf, getImageStore } from '../storage/image-store.js';
import { captureSnapshotImages, snapshotImagesDir, writeDbSnapshot } from './snapshot-scheduler.js';

const DAY_MS = 24 * 60 * 60_000;
export const RESTORE_POINTS_KEPT = 5;
export const RESTORE_POINT_MIN_AGE_DAYS = 7;
export const RESTORE_POINT_MAX_AGE_DAYS = 30;

/** The per-server files a sealed restore can replace (sealed-backup.ts applyBundle), plus node_config.json. */
export const RESTORE_POINT_SERVER_FILES = [
    'libp2p_key', 'community.key', 'genesis.json', 'connectors.json', 'recovery-seal.key', 'open-join.key',
    'local-config.json', 'node_config.json',
] as const;
export const RESTORE_POINT_DB = 'state.db';
export const RESTORE_POINT_SERVER_TAR = 'server-files.tar.gz';
const RESTORE_POINT_META = 'point.json';

export type RestorePointWhy = 'restore' | 'roll-back';

/** `2026-10-16T02-30-00.123Z-before-restore`: the ISO time with `-` for `:`, so the name is a plain folder name anywhere. */
const NAME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z-before-(restore|roll-back)$/;

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

export function restorePointsDir(): string {
    return path.join(dataDir(), 'restore-points');
}

export interface RestorePointInfo {
    name: string;
    why: RestorePointWhy;
    takenAt: string;
    /** state.db and the server files; the images are hard links to the store, near-zero disk. */
    bytes: number;
    /** No point is removed before this. */
    keptAtLeastUntil: string;
    /** Nor kept after this. */
    keptAtMostUntil: string;
}

/** A point that could not be written: the restore that needed it is refused, in words, with nothing replaced. */
export class RestorePointError extends Error {
    httpStatus: number;
    code: string;
    constructor(cause: any) {
        const code = String(cause?.code || 'unknown');
        const full = code === 'ENOSPC' || code === 'EDQUOT';
        super(
            'Nothing was restored: this server could not keep a restore point first'
            + (full ? ', because its disk is full. Free some space in the data folder and try again.'
                : ` (${code}). Check that the data folder can be written to and try again.`),
        );
        this.code = code;
        this.httpStatus = full ? 507 : 500;
    }
}

function parseName(name: string): { takenAt: number; why: RestorePointWhy } | null {
    const m = NAME_RE.exec(name);
    if (!m) return null;
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    return Number.isFinite(t) ? { takenAt: t, why: m[6] as RestorePointWhy } : null;
}

export function restorePointName(at: number, why: RestorePointWhy): string {
    return `${new Date(at).toISOString().replace(/:/g, '-')}-before-${why}`;
}

/** A caller's point name, as a path inside data/restore-points, or null: only a name of the exact shape, and one that exists. */
export function resolveRestorePoint(name: unknown): string | null {
    if (typeof name !== 'string' || !parseName(name)) return null;
    const p = path.join(restorePointsDir(), name);
    try {
        return fs.lstatSync(p).isDirectory() ? p : null;
    } catch {
        return null;
    }
}

/** A minimal ustar of regular files, gzipped: read back by restore-checks.ts extractBackupArchive, the hostile-archive reader. */
function tarGzOf(files: Array<{ name: string; content: Buffer }>): Buffer {
    const blocks: Buffer[] = [];
    for (const f of files) {
        const h = Buffer.alloc(512);
        h.write(`./${f.name}`, 0, 100, 'utf8');
        h.write('0000600\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write(f.content.length.toString(8).padStart(11, '0') + '\0', 124);
        h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
        h.write('        ', 148);
        h.write('0', 156);
        h.write('ustar\0', 257);
        h.write('00', 263);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(h, f.content, Buffer.alloc((512 - (f.content.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

/** Tests make the next point's write fail as a full disk does. */
let failNextWriteForTests: string | null = null;
export function failNextRestorePointForTests(code: string | null): void {
    failNextWriteForTests = code;
}

/**
 * Keep this server as it is now, before a restore or a roll-back replaces it. Runs while the database is still open
 * (writeDbSnapshot copies it live). Built under a dot-name and renamed into place when whole, so a half-made point is
 * never one. Throws {@link RestorePointError} when it cannot be written; nothing is left behind then.
 */
export function takeRestorePoint(why: RestorePointWhy, now = Date.now()): RestorePointInfo {
    const root = restorePointsDir();
    let at = now;
    let name = restorePointName(at, why);
    const work = () => path.join(root, `.${name}.partial`);
    try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        fs.chmodSync(root, 0o700);
        while (fs.existsSync(path.join(root, name)) || fs.existsSync(work())) name = restorePointName(++at, why);
        if (failNextWriteForTests) {
            const code = failNextWriteForTests;
            failNextWriteForTests = null;
            throw Object.assign(new Error(`${code}: refused in tests`), { code });
        }
        const dir = work();
        fs.mkdirSync(dir, { mode: 0o700 });
        const dbPath = path.join(dir, RESTORE_POINT_DB);
        writeDbSnapshot(dbPath);
        fs.chmodSync(dbPath, 0o600);
        // On a node that keeps photos in a bucket a restore never touches them (routes/backup.ts): nothing to keep here.
        const images = bucketOf(getImageStore()) ? null : captureSnapshotImages(dbPath);
        const kept: Array<{ name: string; content: Buffer }> = [];
        for (const f of RESTORE_POINT_SERVER_FILES) {
            const p = path.join(dataDir(), f);
            try {
                if (fs.lstatSync(p).isFile()) kept.push({ name: f, content: fs.readFileSync(p) });
            } catch (e: any) {
                if (e?.code !== 'ENOENT') throw e;
            }
        }
        fs.writeFileSync(path.join(dir, RESTORE_POINT_SERVER_TAR), tarGzOf(kept), { mode: 0o600 });
        fs.writeFileSync(path.join(dir, RESTORE_POINT_META), JSON.stringify({
            name, why, takenAt: new Date(at).toISOString(), serverFiles: kept.map((k) => k.name),
            images: images ? { referenced: images.referenced, captured: images.captured, missing: images.missing.length } : null,
        }, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(dir, path.join(root, name));
    } catch (e: any) {
        try { fs.rmSync(work(), { recursive: true, force: true }); } catch { /* the refusal is what matters */ }
        logger.error('SYS', `[Restore] Could not keep a restore point before a ${why}; it is refused: ${e?.message || e}`);
        throw new RestorePointError(e);
    }
    const info = describe(name)!;
    logger.info('SYS', `[Restore] Restore point ${name} kept (at least until ${info.keptAtLeastUntil}).`);
    return info;
}

function sizeOf(p: string): number {
    try { return fs.statSync(p).size; } catch { return 0; }
}

function describe(name: string): RestorePointInfo | null {
    const parsed = parseName(name);
    if (!parsed) return null;
    const dir = path.join(restorePointsDir(), name);
    return {
        name,
        why: parsed.why,
        takenAt: new Date(parsed.takenAt).toISOString(),
        bytes: sizeOf(path.join(dir, RESTORE_POINT_DB)) + sizeOf(path.join(dir, RESTORE_POINT_SERVER_TAR)),
        keptAtLeastUntil: new Date(parsed.takenAt + RESTORE_POINT_MIN_AGE_DAYS * DAY_MS).toISOString(),
        keptAtMostUntil: new Date(parsed.takenAt + RESTORE_POINT_MAX_AGE_DAYS * DAY_MS).toISOString(),
    };
}

/** Every point, newest first. Read-only. */
export function listRestorePoints(): RestorePointInfo[] {
    let names: string[];
    try {
        names = fs.readdirSync(restorePointsDir());
    } catch {
        return [];
    }
    return names
        .filter((n) => resolveRestorePoint(n) !== null)
        .map((n) => describe(n)!)
        .sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt));
}

/** The server files a point kept, as point.json names them (the tar is the bytes). */
export function restorePointServerFiles(pointDir: string): string[] {
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(pointDir, RESTORE_POINT_META), 'utf-8'));
        const listed = Array.isArray(meta?.serverFiles) ? meta.serverFiles : [];
        return RESTORE_POINT_SERVER_FILES.filter((f) => listed.includes(f));
    } catch {
        return [];
    }
}

/** Where a point keeps its images: the snapshot layout, beside its state.db. */
export function restorePointImagesDir(pointDir: string): string {
    return snapshotImagesDir(path.join(pointDir, RESTORE_POINT_DB));
}

/**
 * Remove the points past their time: older than {@link RESTORE_POINT_MAX_AGE_DAYS} days, or beyond the newest
 * {@link RESTORE_POINTS_KEPT} and at least {@link RESTORE_POINT_MIN_AGE_DAYS} days old. Never one younger than that,
 * whatever the count. Half-made ones (a dot-name a crash left) older than a day go too. Never throws; returns how many went.
 */
export function expireRestorePoints(now = Date.now()): number {
    const root = restorePointsDir();
    let names: string[];
    try {
        names = fs.readdirSync(root);
    } catch {
        return 0;
    }
    let removed = 0;
    const points = names
        .map((n) => ({ n, p: parseName(n) }))
        .filter((x): x is { n: string; p: { takenAt: number; why: RestorePointWhy } } => !!x.p)
        .sort((a, b) => b.p.takenAt - a.p.takenAt);
    points.forEach(({ n, p }, i) => {
        const age = now - p.takenAt;
        const tooOld = age > RESTORE_POINT_MAX_AGE_DAYS * DAY_MS;
        const pastCount = i >= RESTORE_POINTS_KEPT && age >= RESTORE_POINT_MIN_AGE_DAYS * DAY_MS;
        if (!tooOld && !pastCount) return;
        try {
            fs.rmSync(path.join(root, n), { recursive: true, force: true });
            removed++;
            logger.info('SYS', `[Restore] Restore point ${n} removed: ${tooOld ? `older than ${RESTORE_POINT_MAX_AGE_DAYS} days` : `more than ${RESTORE_POINTS_KEPT} kept`}.`);
        } catch (e: any) {
            logger.warn('SYS', `[Restore] Could not remove restore point ${n}: ${e?.message || e}`);
        }
    });
    for (const n of names) {
        if (!n.startsWith('.') || !n.endsWith('.partial')) continue;
        try {
            if (now - fs.statSync(path.join(root, n)).mtimeMs > DAY_MS) fs.rmSync(path.join(root, n), { recursive: true, force: true });
        } catch { /* next hour */ }
    }
    return removed;
}

// ── The notice: everyone is told at the next boot, on the restored database ────────────────────────────────────

const NOTICE_PREFIX = 'restore-notice-';

export interface RestoreNotice {
    kind: RestorePointWhy;
    at: string;
    /** When the backup was made (a restore), or when the point was taken (a roll-back). */
    madeAt: string | null;
    /** The point kept before it. */
    point: string;
}

/**
 * Leave the notice the next boot delivers. A restore replaces the database, so the announcement cannot be written before
 * the restart: it would be in the database that is going. Written before the restart is scheduled; never throws.
 */
export function leaveRestoreNotice(notice: RestoreNotice): void {
    try {
        const file = path.join(dataDir(), `${NOTICE_PREFIX}${Date.now()}-${process.pid}.json`);
        fs.writeFileSync(file, JSON.stringify(notice) + '\n', { mode: 0o600 });
    } catch (e: any) {
        logger.error('SYS', `[Restore] Could not leave the notice for the next boot: ${e?.message || e}`);
    }
}

function day(iso: string | null): string {
    if (!iso) return 'an earlier date';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : 'an earlier date';
}

export interface RestoreNoticeDeps {
    announce: (title: string, body: string, severity: 'critical') => void;
    log: (message: string) => void;
}

/** Each notice a restore or roll-back left: the announcement and the log line, once. Returns how many. Never throws. */
export function deliverRestoreNotices(deps: RestoreNoticeDeps, dir = dataDir()): number {
    let files: string[];
    try {
        files = fs.readdirSync(dir).filter((f) => f.startsWith(NOTICE_PREFIX) && f.endsWith('.json')).sort();
    } catch {
        return 0;
    }
    let delivered = 0;
    for (const f of files) {
        let notice: RestoreNotice | null = null;
        try {
            notice = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch { /* told below as unreadable */ }
        // Gone before it is announced: a crash between the two loses one announcement, never repeats one.
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* already gone */ }
        if (!notice || (notice.kind !== 'restore' && notice.kind !== 'roll-back')) {
            deps.log(`[RESTORE] An unreadable restore notice ${f} was removed; this server was restored or rolled back before this start.`);
            continue;
        }
        const title = notice.kind === 'restore' ? 'This community was restored from a backup' : 'This community was rolled back';
        const body = notice.kind === 'restore'
            ? `This community was restored from a backup made ${day(notice.madeAt)}, by an owner. Anything since then is gone. `
              + "If you did not expect this, tell your community's owners."
            : `This community was rolled back to how it was on ${day(notice.madeAt)}, by an owner. Anything since then is gone. `
              + "If you did not expect this, tell your community's owners.";
        try {
            deps.announce(title, body, 'critical');
        } catch { /* the log line below still records it */ }
        deps.log(`[RESTORE] ${body} Restore point kept before it: ${notice.point} (at ${notice.at}).`);
        delivered++;
    }
    return delivered;
}

/** In the node: deliver at boot. Never blocks the boot. */
export function startRestoreNoticeWatch(deps: RestoreNoticeDeps): void {
    try { deliverRestoreNotices(deps); } catch { /* never blocks boot */ }
}
