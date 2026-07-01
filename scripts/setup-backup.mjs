#!/usr/bin/env node
/**
 * BeanPool — Backup Server Setup
 *
 * Run this ON THE WOULD-BE BACKUP HOST (the second machine), NOT on the primary.
 * It enrolls a fresh node as a one-directional, read-only backup of an existing
 * primary: it pulls the primary's community identity, wipes any stale local state
 * so the backup rebuilds cleanly under a brand-new PeerId, and writes the env +
 * connector config the backup needs to start pulling.
 *
 * State only ever flows primary → backup. The primary imports from nobody.
 *
 * Usage:
 *   node scripts/setup-backup.mjs --primary <https url> --admin-pw <pw> [--data-dir <path>]
 *
 *   --primary    Required. The primary's public HTTPS base URL,
 *                e.g. https://test.beanpool.org  (http:// only allowed for localhost)
 *   --admin-pw   Required. The primary's admin password (shared operator secret).
 *                Also stored locally as BACKUP_ADMIN_PASSWORD so the puller can pull.
 *   --data-dir   Optional. The node's data directory. Default: ./data
 *
 * Example:
 *   node scripts/setup-backup.mjs --primary https://test.beanpool.org --admin-pw 'S3cr3t!pass'
 *
 * After it finishes, set NODE_ROLE=backup is written to a sibling .env — then
 * RESTART the node. On next boot it generates a fresh PeerId, rebuilds state.db,
 * and begins pulling the primary's signed snapshot every 60s.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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

/** Mirror the server's A2-9 rule: https only, except http://localhost for dev. */
function isAllowedPrimaryUrl(rawUrl) {
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

/** Upsert a set of KEY=VALUE lines into an .env file, preserving other lines. */
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
    // Append any keys not already present.
    const appended = Object.entries(remaining).map(([k, v]) => `${k}=${v}`);
    if (appended.length) {
        // Ensure a clean separation if the file didn't end in a blank line.
        if (out.length && out[out.length - 1].trim() !== '') out.push('');
        out.push(...appended);
    }
    fs.writeFileSync(envPath, out.join('\n').replace(/\n{3,}/g, '\n\n'));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const primary = typeof args.primary === 'string' ? args.primary.replace(/\/$/, '') : null;
    const adminPw = typeof args['admin-pw'] === 'string' ? args['admin-pw'] : null;
    const dataDir = path.resolve(typeof args['data-dir'] === 'string' ? args['data-dir'] : './data');

    if (!primary || !adminPw) {
        die('Usage: node scripts/setup-backup.mjs --primary <https url> --admin-pw <pw> [--data-dir <path>]');
    }
    if (!isAllowedPrimaryUrl(primary)) {
        die(`--primary must be an https:// URL (http:// allowed only for localhost). Got: ${primary}\n` +
            'Pulling over cleartext to a public host would leak the admin password and full ledger.');
    }

    console.log(`\n🗄️  BeanPool backup setup`);
    console.log(`   Primary:  ${primary}`);
    console.log(`   Data dir: ${dataDir}\n`);

    // 1. Pull the enrollment bundle from the primary.
    const enrollUrl = `${primary}/api/local/admin/backup-enroll`;
    console.log(`→ Fetching enrollment bundle from ${enrollUrl} ...`);
    let bundle;
    try {
        const res = await fetch(enrollUrl, {
            method: 'GET',
            headers: { 'X-Admin-Password': adminPw },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            die(`Primary returned HTTP ${res.status}. ${res.status === 401 ? 'Check --admin-pw.' : body}`);
        }
        bundle = await res.json();
    } catch (e) {
        die(`Could not reach the primary: ${e?.message || e}\n` +
            '(For a self-signed-CA LAN primary, set NODE_EXTRA_CA_CERTS to its CA pem.)');
    }

    const { communityId, genesis, communityKey, primaryPeerId, primaryUrl } = bundle;
    if (!genesis || !primaryPeerId) {
        die('Enrollment bundle is incomplete (missing genesis or primaryPeerId). Is the primary fully booted?');
    }
    console.log(`✅ Enrolled into community ${communityId} (primary PeerId ${primaryPeerId.slice(0, 16)}…)\n`);

    // 2. Ensure the data dir exists.
    fs.mkdirSync(dataDir, { recursive: true });

    // 3. Write genesis.json + decoded community.key.
    fs.writeFileSync(path.join(dataDir, 'genesis.json'), JSON.stringify(genesis, null, 2));
    console.log('  • wrote genesis.json');
    if (communityKey) {
        fs.writeFileSync(path.join(dataDir, 'community.key'), Buffer.from(communityKey, 'base64'));
        console.log('  • wrote community.key');
    } else {
        console.log('  • (primary did not expose community.key — continuing without it)');
    }

    // 4. Delete libp2p_key so the backup boots a FRESH PeerId (must not share the
    //    primary's identity).
    const keyPath = path.join(dataDir, 'libp2p_key');
    if (fs.existsSync(keyPath)) {
        fs.unlinkSync(keyPath);
        console.log('  • deleted libp2p_key (fresh PeerId will be generated on boot)');
    }

    // 5. Delete state.db* so the backup rebuilds from scratch and pulls fresh.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const p = path.join(dataDir, `state.db${suffix}`);
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            console.log(`  • deleted state.db${suffix}`);
        }
    }

    // 6. Write connectors.json — a single PASSIVE mirror pointing at the primary.
    //    enabled:false → the backup never dials; the connector exists only so the
    //    import signature gate recognizes the primary's signing key.
    const connectors = [{
        address: `/p2p/${primaryPeerId}`,
        trustLevel: 'mirror',
        enabled: false,
        callsign: 'primary',
        publicUrl: primaryUrl || primary,
        addedAt: Date.now(),
    }];
    fs.writeFileSync(path.join(dataDir, 'connectors.json'), JSON.stringify(connectors, null, 2));
    console.log('  • wrote connectors.json (passive mirror → primary)');

    // 7. Write/update the sibling .env (one level up from the data dir, where the
    //    node's root .env lives).
    const envPath = path.join(path.dirname(dataDir), '.env');
    upsertEnv(envPath, {
        NODE_ROLE: 'backup',
        BACKUP_PRIMARY_URL: primaryUrl || primary,
        BACKUP_ADMIN_PASSWORD: adminPw,
    });
    console.log(`  • updated ${envPath} (NODE_ROLE=backup, BACKUP_PRIMARY_URL, BACKUP_ADMIN_PASSWORD)\n`);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Backup enrolled. NEXT STEPS:\n');
    console.log('  1. RESTART this node so it boots as a backup:');
    console.log('       docker compose up -d   (or your process manager)');
    console.log('  2. It will generate a fresh PeerId, rebuild state.db, and begin');
    console.log('       pulling the primary every 60s over HTTPS.');
    console.log('  3. Watch the primary\'s Settings → 🗄️ Backup tab for live health,');
    console.log('       or this node\'s logs for "[Backup] ⬇️ Pulled snapshot".');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch((e) => die(e?.message || String(e)));
