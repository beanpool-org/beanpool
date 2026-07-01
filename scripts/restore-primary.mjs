#!/usr/bin/env node
/**
 * BeanPool — Primary Server Restoration
 *
 * Run this ON THE FRESH PRIMARY HOST, NOT on the backup.
 * It connects to an active backup server (mirror node), downloads its latest
 * database snapshot, configuration, and community keys, and restores them
 * locally. It then updates the local .env to run in the 'primary' role.
 *
 * Usage:
 *   node scripts/restore-primary.mjs --backup <https url> --admin-pw <pw> [--data-dir <path>]
 *
 *   --backup     Required. The backup server's HTTPS base URL,
 *                e.g. https://test-mirror.beanpool.org
 *   --admin-pw   Required. The backup server's admin password.
 *   --data-dir   Optional. The node's data directory. Default: ./data
 *
 * Example:
 *   node scripts/restore-primary.mjs --backup https://test-mirror.beanpool.org --admin-pw '<backup admin password>'
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

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

    console.log(`\n🗄️  BeanPool Primary Restoration`);
    console.log(`   Backup Source:  ${backup}`);
    console.log(`   Data dir:       ${dataDir}\n`);

    // 1. Fetch community details & keys from backup server
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

    const { genesis, communityKey } = bundle;
    if (!genesis) {
        die('Genesis configuration is missing from the backup bundle.');
    }

    // 2. Ensure data directory exists
    fs.mkdirSync(dataDir, { recursive: true });

    // 3. Write genesis.json + community.key
    fs.writeFileSync(path.join(dataDir, 'genesis.json'), JSON.stringify(genesis, null, 2));
    console.log('  • wrote genesis.json');
    if (communityKey) {
        fs.writeFileSync(path.join(dataDir, 'community.key'), Buffer.from(communityKey, 'base64'));
        console.log('  • wrote community.key');
    }

    // 4. Download backup tarball from backup server
    const backupUrl = `${backup}/api/local/admin/backup`;
    console.log(`→ Downloading backup archive from ${backupUrl} ...`);
    const tarPath = path.join(dataDir, '.restore-download.tar.gz');
    try {
        const res = await fetch(backupUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPw })
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            die(`Backup download failed. Server returned HTTP ${res.status}: ${body}`);
        }
        const fileStream = fs.createWriteStream(tarPath);
        await finished(Readable.fromWeb(res.body).pipe(fileStream));
        console.log('  • downloaded backup archive successfully');
    } catch (e) {
        if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
        die(`Could not download backup file: ${e?.message || e}`);
    }

    // 5. Validate archive entries BEFORE extracting (path-traversal defence,
    //    mirrors the server's /restore guard, SRV-9a): list the archive and reject
    //    absolute paths, '..' traversal segments, or any non-relative entry. Then
    //    extract with --no-same-owner so a hostile tar can't chown files.
    console.log('→ Validating backup archive...');
    try {
        const listing = execFileSync('tar', ['-tzf', tarPath], { encoding: 'utf8' });
        const entries = listing.split('\n').map((s) => s.trim()).filter(Boolean);
        const unsafe = entries.find((e) =>
            e.startsWith('/') || e.startsWith('~') || e.split('/').includes('..') || /^[A-Za-z]:/.test(e)
        );
        if (unsafe) {
            fs.unlinkSync(tarPath);
            die(`Refusing to extract: backup archive contains an unsafe path entry: ${unsafe}`);
        }
    } catch (e) {
        if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
        die(`Could not read backup archive for validation: ${e?.message || e}`);
    }

    // 6. Extract database and node config from tarball
    console.log('→ Extracting backup archive contents...');
    try {
        execFileSync('tar', ['--no-same-owner', '-xzf', tarPath, '-C', dataDir]);
        fs.unlinkSync(tarPath); // Clean up download tarball
        
        // Copy node_config.json to local-config.json
        const nodeConfigPath = path.join(dataDir, 'node_config.json');
        if (fs.existsSync(nodeConfigPath)) {
            fs.copyFileSync(nodeConfigPath, path.join(dataDir, 'local-config.json'));
            fs.unlinkSync(nodeConfigPath);
            console.log('  • restored local-config.json');
        }
        console.log('  • restored state.db');
    } catch (e) {
        if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
        die(`Extraction failed: ${e?.message || e}`);
    }

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
    });
    console.log(`  • updated ${envPath} (NODE_ROLE=primary, cleared backup configs)\n`);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Primary node restored successfully. NEXT STEPS:\n');
    console.log('  1. BOOT this node as primary:');
    console.log('       docker compose up -d');
    console.log('  2. Reconfigure your backup server (.env) to point to this primary');
    console.log('       and start the backup replication loop again.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch((e) => die(e?.message || String(e)));
