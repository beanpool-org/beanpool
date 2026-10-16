/**
 * The data dir's files, made safe at every start, before anything reads or writes them (index.ts, before step 1):
 *
 * - Temp files a crash mid-write left behind (write-file-atomic.ts) are removed: each is a whole copy of its target,
 *   secrets included. Nothing else is touched.
 * - The files that hold a key or the admin's secrets are made 0600 when a group or other user can read or write them:
 *   an older install made them 0644. The container runs the node as the data dir's owner (entrypoint.sh chowns /data
 *   and drops to PUID with su-exec; bin/beanpool does the same), so the node and the CLI still read them.
 * - local-config.json gets its last good copy (.bak) when it parses and the copy is missing, broken or older: a node
 *   upgraded from before .bak existed has one from its first start, not only from its first save.
 * - What a restore or roll-back that was cut off (a crash, a kill, a restart mid-upload) left in the data dir is removed
 *   (verified review M1): its unpack and candidate folders, the upload and the opened file, and a file kept for an owner's
 *   phone once that unlock's window has passed. Each can be a whole unlocked copy of a community.
 */

import fs from 'node:fs';
import path from 'node:path';
import { cleanStaleWriteTemps } from './write-file-atomic.js';
import { ensureLocalConfigBackup } from './config/local-config.js';
import { OWNER_UNLOCK_SESSION_TTL_MS } from '@beanpool/core';

/** The fixed names a restore or roll-back works under in the data dir (routes/backup.ts restorePaths). */
export const RESTORE_WORK_NAMES = {
    tmp: '.restore-tmp',
    candidate: '.restore-candidate',
    upload: 'uploaded-backup.upload',
    opened: 'uploaded-backup.opened.tar.gz',
} as const;
/** Where a sealed upload waits for an owner's phone, one name per upload (routes/backup.ts). */
export const RESTORE_PENDING_PREFIX = 'uploaded-backup.pending-';

/**
 * Remove what a cut-off restore or roll-back left (see the top of this file). Run at start, before the HTTPS server, when
 * no restore can be running; a phone's file goes only once its unlock window has passed. Returns the names removed.
 */
export function sweepRestoreLeftovers(dataDir: string, now = Date.now()): string[] {
    let names: string[];
    try { names = fs.readdirSync(dataDir); } catch { return []; }
    const fixed = new Set<string>(Object.values(RESTORE_WORK_NAMES));
    const removed: string[] = [];
    for (const n of names) {
        const p = path.join(dataDir, n);
        try {
            if (!fixed.has(n)) {
                if (!n.startsWith(RESTORE_PENDING_PREFIX)) continue;
                if (now - fs.lstatSync(p).mtimeMs <= OWNER_UNLOCK_SESSION_TTL_MS) continue;
            }
            fs.rmSync(p, { recursive: true, force: true });
            removed.push(n);
        } catch (e) {
            console.error(`[Files] Could not remove ${p}, left by a restore that was cut off:`, (e as Error).message);
        }
    }
    return removed;
}

/** Files that hold a key or the admin's secrets, relative to the data dir. Each must be 0600. */
export const SECRET_FILES = [
    'community.key',
    'libp2p_key',
    'local-config.json',
    'local-config.json.bak',
    'tls/ca-key.pem',
    'tls/server-key.pem',
    'tls/le-key.pem',
    'tls/acme-account.json',
    'alerts.json',
];

export function secureDataDirAtBoot(dataDir: string): void {
    for (const dir of [dataDir, path.join(dataDir, 'tls')]) {
        const removed = cleanStaleWriteTemps(dir);
        if (removed.length) console.warn(`🧹 [Files] Removed ${removed.length} temp file(s) a stop mid-write left in ${dir}: ${removed.join(', ')}`);
    }

    let brokenCopies: string[] = [];
    try { brokenCopies = fs.readdirSync(dataDir).filter((n) => n.startsWith('local-config.json.broken-')); } catch { /* no dir yet */ }
    for (const rel of [...SECRET_FILES, ...brokenCopies]) {
        const file = path.join(dataDir, rel);
        let st: fs.Stats;
        try { st = fs.lstatSync(file); } catch { continue; }
        if (!st.isFile()) continue;
        const mode = st.mode & 0o777;
        if ((mode & 0o077) === 0) continue;
        try {
            fs.chmodSync(file, mode & 0o700);
            console.warn(`🔒 [Files] ${file} was readable by other users (${mode.toString(8).padStart(4, '0')}): now ${(mode & 0o700).toString(8).padStart(4, '0')}.`);
        } catch (e) {
            console.error(`[Files] Could not make ${file} private (${mode.toString(8)}):`, (e as Error).message);
        }
    }

    const leftovers = sweepRestoreLeftovers(dataDir);
    if (leftovers.length) console.warn(`🧹 [Files] Removed ${leftovers.length} file(s) a restore that was cut off left in ${dataDir}: ${leftovers.join(', ')}`);

    ensureLocalConfigBackup();
}
