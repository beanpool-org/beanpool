#!/usr/bin/env node
/**
 * BeanPool — Primary Server Restoration
 *
 * Run this ON THE FRESH PRIMARY HOST, NOT on the backup.
 * It connects to an active backup server (mirror node), downloads its latest
 * backup, opens it, and restores the database and configuration locally. It
 * then updates the local .env to run in the 'primary' role.
 *
 * Backups are sealed (sealed-keys.md §6): the backup server's download is a
 * `.bpsealed` file locked to that server's owners and its printed recovery
 * code, never a plain archive. This script opens it with the recovery code, so
 * make one on the backup server first (Settings → recovery code) if it has
 * none; the download answers with that instruction when it is needed. It is
 * replaced by the in-image take-over (slice 5) and deleted in slice 8.
 *
 * Usage:
 *   node scripts/restore-primary.mjs --backup <https url> --admin-pw <pw> [--data-dir <path>]
 *
 *   --backup     Required. The backup server's HTTPS base URL,
 *                e.g. https://test-mirror.beanpool.org
 *   --admin-pw   Required. The backup server's admin password.
 *   --data-dir   Optional. The node's data directory. Default: ./data
 *
 * The recovery code is read from BEANPOOL_RECOVERY_CODE, or asked for on the
 * terminal — never taken as an argument, so it stays out of shell history.
 * Needs a built @beanpool/core (pnpm --filter @beanpool/core build).
 *
 * Example:
 *   node scripts/restore-primary.mjs --backup https://test-mirror.beanpool.org --admin-pw '<backup admin password>'
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                args[key] = true;
            } else {
                args[key] = next;
                i++;
            }
        }
    }
    return args;
}

function isAllowedBackupUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return false; }
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
        const h = u.hostname.toLowerCase();
        return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
    }
    return false;
}

function die(msg) {
    console.error(`\n❌ ${msg}\n`);
    process.exit(1);
}

function upsertEnv(envPath, kv) {
    let lines = [];
    if (fs.existsSync(envPath)) {
        lines = fs.readFileSync(envPath, 'utf8').split('\n');
    }
    const remaining = { ...kv };
    const out = lines.map((line) => {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m && Object.prototype.hasOwnProperty.call(remaining, m[1])) {
            const key = m[1];
            const val = remaining[key];
            delete remaining[key];
            return `${key}=${val}`;
        }
        return line;
    });
    const appended = Object.entries(remaining).map(([k, v]) => `${k}=${v}`);
    if (appended.length) {
        if (out.length && out[out.length - 1].trim() !== '') out.push('');
        out.push(...appended);
    }
    fs.writeFileSync(envPath, out.join('\n').replace(/\n{3,}/g, '\n\n'));
}

/** @beanpool/core from this checkout: the same code the server seals with. */
async function loadCore() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dist = path.join(here, '..', 'packages', 'beanpool-core', 'dist', 'index.js');
    if (!fs.existsSync(dist)) die(`@beanpool/core is not built (${dist} is missing). Run: pnpm --filter @beanpool/core build`);
    return import(pathToFileURL(dist).href);
}

async function askRecoveryCode() {
    if (process.env.BEANPOOL_RECOVERY_CODE) return process.env.BEANPOOL_RECOVERY_CODE;
    if (!process.stdin.isTTY) die('Set BEANPOOL_RECOVERY_CODE to the backup server\'s recovery code (it is not taken as an argument).');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        return await rl.question('Recovery code (BPRC-n XXXX-…): ');
    } finally {
        rl.close();
    }
}

/** The same refusal the server's /restore makes (SRV-9a): no absolute or `..` path, no link, before extracting. */
function checkArchive(tarPath) {
    const entries = execFileSync('tar', ['-tzf', tarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').map((s) => s.trim()).filter(Boolean);
    const unsafe = entries.find((e) =>
        e.startsWith('/') || e.startsWith('~') || e.split('/').includes('..') || /^[A-Za-z]:/.test(e)
    );
    if (unsafe) throw new Error(`the backup archive contains an unsafe path entry: ${unsafe}`);
    const verbose = execFileSync('tar', ['-tvzf', tarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').map((s) => s.trim()).filter(Boolean);
    if (verbose.some((l) => l[0] === 'l' || l[0] === 'h')) throw new Error('the backup archive contains a link');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const backup = typeof args.backup === 'string' ? args.backup.replace(/\/$/, '') : null;
    const adminPw = typeof args['admin-pw'] === 'string' ? args['admin-pw'] : null;
    const dataDir = path.resolve(typeof args['data-dir'] === 'string' ? args['data-dir'] : './data');

    if (!backup || !adminPw) {
        die('Usage: node scripts/restore-primary.mjs --backup <https url> --admin-pw <pw> [--data-dir <path>]');
    }
    if (!isAllowedBackupUrl(backup)) {
        die(`--backup must be an https:// URL (http:// allowed only for localhost). Got: ${backup}`);
    }
    const core = await loadCore();

    console.log(`\n🗄️  BeanPool Primary Restoration`);
    console.log(`   Backup Source:  ${backup}`);
    console.log(`   Data dir:       ${dataDir}\n`);

    // 1. Fetch the community's public details from the backup server (no key comes with them).
    const enrollUrl = `${backup}/api/local/admin/backup-enroll`;
    console.log(`→ Fetching community details from ${enrollUrl} ...`);
    let bundle;
    try {
        const res = await fetch(enrollUrl, {
            method: 'GET',
            headers: { 'X-Admin-Password': adminPw },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            die(`Backup server returned HTTP ${res.status}. ${res.status === 401 ? 'Check --admin-pw.' : body}`);
        }
        bundle = await res.json();
    } catch (e) {
        die(`Could not reach the backup server: ${e?.message || e}`);
    }

    const { genesis } = bundle;
    if (!genesis) {
        die('Genesis configuration is missing from the backup bundle.');
    }

    // 2. Ensure data directory exists
    fs.mkdirSync(dataDir, { recursive: true });

    // 3. Download the sealed backup from the backup server.
    const backupUrl = `${backup}/api/local/admin/backup`;
    console.log(`→ Downloading the sealed backup from ${backupUrl} ...`);
    const work = path.join(dataDir, `.restore-work-${process.pid}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
    const sealedPath = path.join(work, 'backup.bpsealed');
    const tarPath = path.join(work, 'backup.tar.gz');
    try {
        const res = await fetch(backupUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPw })
        });
        if (!res.ok) {
            const body = await res.json().then((j) => j?.error).catch(() => null);
            cleanup();
            die(`Backup download failed (HTTP ${res.status}): ${body || res.statusText}`);
        }
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(sealedPath, { mode: 0o600 }));
        console.log('  • downloaded the sealed backup');
    } catch (e) {
        cleanup();
        die(`Could not download backup file: ${e?.message || e}`);
    }

    // 4. Open it with the recovery code. A plain archive here means the backup server predates sealed backups.
    // The first 256 KiB hold the whole header (its cap); the body is never read into memory.
    const start = Buffer.alloc(4 + 256 * 1024 + 1);
    const fd = fs.openSync(sealedPath, 'r');
    const startLen = fs.readSync(fd, start, 0, start.length, 0);
    fs.closeSync(fd);
    const first = start.subarray(0, 2);
    if (first[0] === 0x1f && first[1] === 0x8b) {
        cleanup();
        die('The backup server sent an unlocked archive: it runs a BeanPool older than sealed backups. Update it first.');
    }
    try {
        const header = core.readSealedHeader(new Uint8Array(start.subarray(0, startLen)));
        const codes = header.recipients.filter((r) => r.type === 'code').map((r) => `#${r.codeId}`);
        console.log(`  • locked to ${header.recipients.filter((r) => r.type === 'owner').length} owner(s)` +
            (codes.length ? ` and recovery code ${codes.join(', ')}` : ' and no recovery code'));
        if (!codes.length) {
            cleanup();
            die('This backup has no recovery code to open it with. Make one on the backup server (Settings), then run this again.');
        }
        const code = await askRecoveryCode();
        const { chunks } = await core.openEnvelopeStream(fs.createReadStream(sealedPath, { highWaterMark: 1 << 20 }),
            { type: 'code', code }, { kind: 'backup' });
        await pipeline(Readable.from(chunks, { objectMode: false }), fs.createWriteStream(tarPath, { mode: 0o600 }));
        console.log('  • opened the backup');
    } catch (e) {
        cleanup();
        die(`Could not open the backup: ${e?.message || e}`);
    }

    // 5. Validate archive entries BEFORE extracting (SRV-9a, as the server's /restore does), then extract into a
    //    work folder and take only the database and node config from it. The take-over bundle inside is the
    //    BACKUP server's own keys, not this community's main server's, so it is not installed here.
    console.log('→ Validating backup archive...');
    const extract = path.join(work, 'extract');
    try {
        checkArchive(tarPath);
        fs.mkdirSync(extract, { recursive: true });
        execFileSync('tar', ['--no-same-owner', '-xzf', tarPath, '-C', extract]);
        const db = path.join(extract, 'state.db');
        if (!fs.existsSync(db) || !fs.lstatSync(db).isFile()) throw new Error('the backup has no state.db');
        fs.writeFileSync(path.join(dataDir, 'genesis.json'), JSON.stringify(genesis, null, 2));
        console.log('  • wrote genesis.json');
        fs.copyFileSync(db, path.join(dataDir, 'state.db'));
        console.log('  • restored state.db');
        const nodeConfig = path.join(extract, 'node_config.json');
        if (fs.existsSync(nodeConfig) && fs.lstatSync(nodeConfig).isFile()) {
            fs.copyFileSync(nodeConfig, path.join(dataDir, 'local-config.json'));
            console.log('  • restored local-config.json');
        }
    } catch (e) {
        cleanup();
        die(`Restore failed: ${e?.message || e}`);
    }
    cleanup();

    // 6. Clean up conflicting configs (ensure a clean start and fresh PeerId)
    const keyPath = path.join(dataDir, 'libp2p_key');
    if (fs.existsSync(keyPath)) {
        fs.unlinkSync(keyPath);
        console.log('  • deleted libp2p_key (fresh PeerId will generate on boot)');
    }
    const connPath = path.join(dataDir, 'connectors.json');
    if (fs.existsSync(connPath)) {
        fs.unlinkSync(connPath);
        console.log('  • cleared connectors.json');
    }

    // 7. Update sibling .env file to be a primary role
    const envPath = path.join(path.dirname(dataDir), '.env');
    upsertEnv(envPath, {
        NODE_ROLE: 'primary',
        BACKUP_PRIMARY_URL: '',
        BACKUP_ADMIN_PASSWORD: '',
        BACKUP_REPLICATION_TOKEN: '',
    });
    console.log(`  • updated ${envPath} (NODE_ROLE=primary, cleared backup configs)\n`);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Primary node restored successfully. NEXT STEPS:\n');
    console.log('  1. BOOT this node as primary:');
    console.log('       docker compose up -d');
    console.log('  2. Reconfigure your backup server (.env) to point to this primary');
    console.log('       and start the backup replication loop again.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  The recovery code you typed was the BACKUP server\'s. Make a new one on this server once it is up.\n');
}

main().catch((e) => die(e?.message || String(e)));
