/**
 * Key files kept outside the database, beside `libp2p_key`: the recovery seal's (services/recovery-seal-key.ts) and the
 * open door's (services/open-join-key.ts). How one is written, so neither a crash nor a second writer ever leaves half a
 * key, or writes one key over another.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Write a file exclusively (never over another), 0600, synced. False when a file is already there. */
export function writeExclusive(target: string, bytes: Buffer): boolean {
    let fd: number;
    try {
        fd = fs.openSync(target, 'wx', 0o600);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
    }
    try {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
    } catch (e) {
        try { fs.closeSync(fd); } catch { /* closed */ }
        fs.rmSync(target, { force: true });
        throw e;
    }
    fs.closeSync(fd);
    return true;
}

/**
 * What `link()` says on a data folder that has no hard links: FAT/exFAT, many SMB/CIFS and some FUSE mounts (Linux gives
 * EPERM, macOS ENOTSUP). The same list sealed-backup.ts falls back on, with ENOTSUP.
 */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EMLINK', 'ENOSYS', 'EXDEV']);

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

/**
 * Make the key file `target` holding `key`, if there is none. Written to a temporary file and linked into place, so a
 * crash leaves no half a key and an existing file (a key, or something that is not one) is never overwritten. On a data
 * folder without hard links, the key is created in place instead, exclusively (`wx`), so that still never overwrites a
 * file: a crash in the moment between the create and the one write would leave an empty file, which the key's reader
 * then names. False when a file was already there.
 */
export function createKeyFileOnce(target: string, key: Buffer): boolean {
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try {
            fs.writeSync(fd, key);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.chmodSync(tmp, 0o600);
        try {
            fs.linkSync(tmp, target);
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code ?? '';
            if (code === 'EEXIST') return false;
            if (!NO_HARD_LINKS.has(code)) throw e;
            return createKeyInPlace(target, key);
        }
        fsyncDir(dir);
        return true;
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

/** The fallback without hard links: create the key file exclusively and write it. False if a file is already there. */
function createKeyInPlace(target: string, key: Buffer): boolean {
    let fd: number;
    try {
        fd = fs.openSync(target, 'wx', 0o600);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
    }
    try {
        fs.writeSync(fd, key);
        fs.fsyncSync(fd);
    } catch (e) {
        // This process made the file a moment ago and nothing has used it: a key that did not go down whole is removed,
        // so the next boot makes one rather than finding a file that is not a key.
        try { fs.closeSync(fd); } catch { /* closed */ }
        fs.rmSync(target, { force: true });
        throw e;
    }
    fs.closeSync(fd);
    fsyncDir(path.dirname(target));
    return true;
}
