/**
 * Restore points' names, the list and the lookup (services/restore-points.ts keeps them; this reads them). No database
 * and no logger here, so `beanpool restore-point list` (restore-point-command.ts) can run beside a running node without
 * opening its database the way the node does (db/db.ts swaps a standby's staged copy in when imported).
 */
import fs from 'node:fs';
import path from 'node:path';

export const DAY_MS = 24 * 60 * 60_000;
export const RESTORE_POINTS_KEPT = 5;
export const RESTORE_POINT_MIN_AGE_DAYS = 7;
export const RESTORE_POINT_MAX_AGE_DAYS = 30;
export const RESTORE_POINT_DB = 'state.db';
export const RESTORE_POINT_SERVER_TAR = 'server-files.tar.gz';

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

export function parseRestorePointName(name: string): { takenAt: number; why: RestorePointWhy } | null {
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
    if (typeof name !== 'string' || !parseRestorePointName(name)) return null;
    const p = path.join(restorePointsDir(), name);
    try {
        return fs.lstatSync(p).isDirectory() ? p : null;
    } catch {
        return null;
    }
}

function sizeOf(p: string): number {
    try { return fs.statSync(p).size; } catch { return 0; }
}

export function describeRestorePoint(name: string): RestorePointInfo | null {
    const parsed = parseRestorePointName(name);
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
        .map((n) => describeRestorePoint(n)!)
        .sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt));
}
