/**
 * The Android APK this node serves on its local network (lights-out H3; routes/android.ts serves it), and the daily check
 * that keeps it current while the node is online.
 *
 * Two places can hold one, each a folder with the APK and its apk.json (services/apk-release.ts):
 *   - the image's /beanpool-apk (APK_IMAGE_DIR), put there when the image was built (Dockerfile, `apk` stage);
 *   - data/apk/, where this node puts a NEWER one it fetched itself. Exactly one file is kept there, and none at all once
 *     the image's is as new (an update brought it), so the node never holds two.
 * The served one is the newer of the two. Neither is ever below 1.2.93 (APK_FLOOR).
 *
 * The check (startApkMirror): 10 to 40 minutes after the start, then once a day (give or take an hour), one request for
 * GitHub's releases list; a download only when it names a newer APK than the served one, and only with room on the disk
 * for it above the photo floor (PHOTO_MIN_FREE_DISK_MB, the one "leave this much free" an operator sets). The download is
 * checked (SHA-256 against the release notes, the signature against BeanPool's certificate) before it replaces anything;
 * a bad one is deleted and the old one goes on being served. Offline, nothing changes. It asks nothing but GitHub's public
 * release endpoint, and DISABLE_APK_UPDATE_CHECK=true in .env turns it off (the image's APK is still served).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
    compareApk, downloadApk, githubApkSource, lookUpNewestApk, readApkFolder, writeApkManifest,
    type ApkInfo, type ApkSource,
} from './apk-release.js';
import { getFreeDiskBytes, photoMinFreeDiskMb } from '../engine/photo-upload-budget.js';
import { logger } from '../logger.js';

/** The image's APK folder (the Dockerfile copies it to /beanpool-apk). */
export function imageApkDir(): string {
    return process.env.APK_IMAGE_DIR || '/beanpool-apk';
}

/** This node's own folder for a newer APK it fetched: data/apk/. */
export function dataApkDir(): string {
    return path.join(process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data'), 'apk');
}

export type ServedApk = ApkInfo & { file: string; from: 'image' | 'data' };

/** The APK this node serves: the newer of the image's and data/apk's, or null when it holds none. */
export function servedApk(): ServedApk | null {
    const image = readApkFolder(imageApkDir());
    const data = readApkFolder(dataApkDir());
    if (data && (!image || compareApk(data, image) > 0)) return { ...data, from: 'data' };
    return image ? { ...image, from: 'image' } : null;
}

/** Whether the daily check is off (DISABLE_APK_UPDATE_CHECK=true in .env). */
export function apkUpdateCheckDisabled(): boolean {
    return (process.env.DISABLE_APK_UPDATE_CHECK ?? '').trim().toLowerCase() === 'true';
}

/** Empties data/apk/ of everything but `keep` (a file name and its apk.json), or of everything when `keep` is null. */
async function tidy(keep: string | null): Promise<void> {
    const dir = dataApkDir();
    let names: string[];
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const n of names) {
        if (keep && (n === keep || n === 'apk.json')) continue;
        await fsp.rm(path.join(dir, n), { force: true, recursive: true });
    }
}

export type RefreshOutcome =
    | { outcome: 'updated'; info: ApkInfo }
    | { outcome: 'current' | 'none' }
    | { outcome: 'no-room'; needBytes: number; freeBytes: number }
    | { outcome: 'refused' | 'offline'; reason: string };

let running: Promise<RefreshOutcome> | null = null;

/**
 * One check: GitHub's newest APK, downloaded into data/apk/ when it is newer than the one served and there is room. Never
 * throws: what went wrong is the outcome's reason, and the APK served before is served still.
 */
export function refreshApk(source: ApkSource = githubApkSource(), fetchImpl: typeof fetch = fetch): Promise<RefreshOutcome> {
    running ??= (async (): Promise<RefreshOutcome> => {
        let newest;
        try {
            newest = await lookUpNewestApk(source, fetchImpl, AbortSignal.timeout(30_000));
        } catch (e) {
            return { outcome: 'offline', reason: e instanceof Error ? e.message : String(e) };
        }
        const image = readApkFolder(imageApkDir());
        const served = servedApk();
        // The image's own is as new as the copy here (an update brought it): the copy goes.
        if (served?.from === 'image') await tidy(null);
        if (!newest) return { outcome: 'none' };
        if (served && compareApk(newest, served) <= 0) return { outcome: 'current' };
        if (image && compareApk(newest, image) <= 0) return { outcome: 'current' };
        const dir = dataApkDir();
        await fsp.mkdir(dir, { recursive: true });
        const floorBytes = photoMinFreeDiskMb() * 1024 * 1024;
        const freeBytes = getFreeDiskBytes(dir);
        if (freeBytes - newest.size < floorBytes) return { outcome: 'no-room', needBytes: newest.size + floorBytes, freeBytes };
        try {
            const info = await downloadApk(newest, path.join(dir, newest.fileName), source, fetchImpl, AbortSignal.timeout(30 * 60_000));
            await writeApkManifest(dir, info);
            await tidy(info.fileName);
            return { outcome: 'updated', info };
        } catch (e) {
            await tidy(served?.from === 'data' ? served.fileName : null);
            return { outcome: 'refused', reason: e instanceof Error ? e.message : String(e) };
        }
    })().finally(() => { running = null; });
    return running;
}

/** Logs a check's outcome: one line, never a member's or a key's detail (there is none here). */
function logOutcome(r: RefreshOutcome): void {
    if (r.outcome === 'updated') logger.info('SYS', `[apk] Fetched the Android APK ${r.info.version} (${r.info.versionCode}) into data/apk; it is served on the local network now`);
    else if (r.outcome === 'no-room') logger.warn('SYS', `[apk] A newer Android APK is out, but the disk has ${Math.round(r.freeBytes / 1048576)} MB free and it needs ${Math.round(r.needBytes / 1048576)} MB with the floor; the one held is still served`);
    else if (r.outcome === 'refused') logger.warn('SYS', `[apk] Refused the newer Android APK: ${r.reason}. The one held is still served`);
    else if (r.outcome === 'offline') logger.info('SYS', `[apk] Could not ask GitHub for a newer Android APK (${r.reason}); the one held is still served`);
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Starts the daily check (unless DISABLE_APK_UPDATE_CHECK=true). Its timers never keep the process alive. */
export function startApkMirror(): void {
    if (timer) return;
    const served = servedApk();
    logger.info('SYS', served
        ? `[apk] Serving the Android APK ${served.version} (${served.versionCode}) from the ${served.from === 'image' ? 'image' : 'data folder'}, on the local network only`
        : '[apk] No Android APK held yet');
    if (apkUpdateCheckDisabled()) {
        logger.info('SYS', '[apk] DISABLE_APK_UPDATE_CHECK=true: no daily check for a newer Android APK');
        return;
    }
    const schedule = (ms: number) => {
        timer = setTimeout(async () => {
            logOutcome(await refreshApk());
            schedule(23 * 3600_000 + Math.random() * 2 * 3600_000);
        }, ms);
        timer.unref?.();
    };
    schedule(10 * 60_000 + Math.random() * 30 * 60_000);
}

/** Tests only. */
export function stopApkMirror(): void {
    if (timer) clearTimeout(timer);
    timer = null;
}
