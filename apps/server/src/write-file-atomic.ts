/**
 * Write a file so that no reader, and no crash or power cut, ever sees it half written: the bytes go to a temp file
 * in the same directory, are flushed to disk, and the temp file is renamed over the target (a rename within one
 * filesystem is atomic). The directory is flushed afterwards, where the platform can open and sync one, so the
 * rename itself survives a power cut. A reader sees the old file or the new one, never a part of either.
 *
 * The file keeps its mode: a target that exists keeps the one it has (0600 stays 0600), unless `mode` is given;
 * a new one gets `mode`, or the default a plain writeFileSync would give it.
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

export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
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
