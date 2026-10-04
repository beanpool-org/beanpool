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
 */

import fs from 'node:fs';
import path from 'node:path';
import { cleanStaleWriteTemps } from './write-file-atomic.js';
import { ensureLocalConfigBackup } from './config/local-config.js';

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

    ensureLocalConfigBackup();
}
