/**
 * Write a file so that no reader, and no crash or power cut, ever sees it half written: the bytes go to a temp file
 * in the same directory, are flushed to disk, and the temp file is renamed over the target (a rename within one
 * filesystem is atomic). The directory is flushed afterwards, where the platform can open and sync one, so the
 * rename itself survives a power cut. A reader sees the old file or the new one, never a part of either.
 *
 * The file keeps its mode: a target that exists keeps the one it has (0600 stays 0600), unless `mode` is given;
 * a new one gets `mode`, else `newMode`, else the default a plain writeFileSync would give it.
 *
 * A crash between the temp file's creation and the rename leaves the temp file behind (the target is untouched):
 * cleanStaleWriteTemps removes such leftovers at the next start.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Flush a directory's entries, where the filesystem lets a directory be opened and synced; elsewhere, nothing. */
export function fsyncDir(dir: string): void {
    let fd: number | null = null;
    try {
        fd = fs.openSync(dir, 'r');
        fs.fsyncSync(fd);
    } catch { /* not every filesystem (or platform) syncs a directory */ } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
    }
}

/** `.<name>.tmp-<pid>-<8 hex>`: the temp file writeFileAtomic writes beside `<name>`. */
const WRITE_TEMP = /^\.(.+)\.tmp-(\d+)-[0-9a-f]{8}$/;

/**
 * Remove the temp files a crash mid-write left in `dir` (not below it), and nothing else: only names of
 * writeFileAtomic's exact pattern, and only one no live writer can still own: its process is this one (at a start,
 * before this process wrote anything: a container restarts with the same pid) or is gone, or it is over an hour old (a
 * write takes milliseconds). Returns the names removed. Never throws.
 */
export function cleanStaleWriteTemps(dir: string): string[] {
    const removed: string[] = [];
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return removed; }
    for (const name of names) {
        const m = WRITE_TEMP.exec(name);
        if (!m) continue;
        const pid = Number(m[2]);
        const file = path.join(dir, name);
        let stale = pid === process.pid;
        if (!stale) {
            try { process.kill(pid, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
        }
        try {
            const st = fs.lstatSync(file);
            if (!st.isFile()) continue;
            if (!stale && Date.now() - st.mtimeMs > 60 * 60_000) stale = true;
            if (!stale) continue;
            fs.unlinkSync(file);
            removed.push(name);
        } catch { /* gone since, or not ours to remove */ }
    }
    return removed;
}

export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number; newMode?: number } = {}): void {
    // A target this process may not write is refused, as a plain write to it would be: a rename would replace a
    // read-only file regardless, and a file made read-only is one its owner meant to stay as it is.
    let exists = true;
    try { fs.accessSync(file, fs.constants.W_OK); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        exists = false;
    }
    let mode = opts.mode;
    if (mode === undefined && exists) {
        try { mode = fs.statSync(file).mode & 0o777; } catch { /* gone since */ }
    }
    if (mode === undefined) mode = opts.newMode;
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    let fd: number | null = null;
    try {
        fs.writeFileSync(tmp, data, { mode: mode ?? 0o666, flag: 'wx' });
        // The umask may have narrowed a mode asked for; a kept mode must come back as it was.
        if (mode !== undefined) fs.chmodSync(tmp, mode);
        fd = fs.openSync(tmp, 'r');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmp, file);
    } catch (e) {
        if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
        try { fs.unlinkSync(tmp); } catch { /* never made, or renamed */ }
        throw e;
    }
    fsyncDir(dir);
}
