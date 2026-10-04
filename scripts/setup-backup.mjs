#!/usr/bin/env node
/**
 * BeanPool — Backup Server Setup
 *
 * Run this ON THE WOULD-BE BACKUP HOST (the second machine), NOT on the primary.
 * It enrolls a fresh node as a one-directional, read-only backup of an existing
 * primary: it pulls the primary's public community identity (genesis.json and its PeerId,
 * never a key), wipes any stale local state
 * so the backup rebuilds cleanly under a brand-new PeerId, and writes the env +
 * connector config the backup needs to start pulling.
 *
 * State only ever flows primary → backup. The primary imports from nobody.
 *
 * Usage:
 *   BEANPOOL_TOKEN='bp_…' BACKUP_REPLICATION_TOKEN='<replication token>' node scripts/setup-backup.mjs --primary <https url> [--data-dir <path>]
 *   node scripts/setup-backup.mjs --primary <https url> --admin-pw <pw> [--data-dir <path>]   (legacy; BACKUP_REPLICATION_TOKEN optional)
 *
 *   BEANPOOL_TOKEN  An owner's automation token for the primary, read or admin scope (Settings → Automation
 *                tokens, made by an owner signed in with their key). From the environment only, never an
 *                argument: arguments show in `ps`. Used ONCE, in memory, to fetch the community identity, and
 *                never written to this machine. With it, --admin-pw is not sent.
 *   --primary    Required. The primary's public HTTPS base URL,
 *                e.g. https://test.beanpool.org  (http:// only allowed for localhost)
 *   --admin-pw   Legacy, in place of BEANPOOL_TOKEN: the primary's admin password. Used ONCE, in memory. It
 *                is NEVER written to this machine: a standby that kept it held the main server's admin
 *                password in plain text.
 *   BACKUP_REPLICATION_TOKEN
 *                The primary's replication token (Settings → Replication Access), written to
 *                .env as BACKUP_REPLICATION_TOKEN; the standby copies with it. From the environment:
 *                it reads the whole ledger, and arguments show in `ps`. Required with
 *                BEANPOOL_TOKEN: making a replication token is an owner's, signed in with their key or
 *                phone, and no automation token can. With --admin-pw and none given, the primary's is
 *                made if it has none; if it already has one, give it (a new one would cut off any
 *                standby already using it).
 *   --token      The same replication token as an argument, as before. It still works, with a warning:
 *                an argument shows in `ps`. BACKUP_REPLICATION_TOKEN wins when both are set.
 *   --data-dir   Optional. The node's data directory. Default: ./data
 *
 * Example:
 *   BEANPOOL_TOKEN='bp_…' BACKUP_REPLICATION_TOKEN='<token>' node scripts/setup-backup.mjs --primary https://test.beanpool.org
 *
 * After it finishes, set NODE_ROLE=backup is written to a sibling .env — then
 * RESTART the node. On next boot it generates a fresh PeerId, rebuilds state.db,
 * and begins pulling the primary's signed snapshot every 60s.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { automationTokenProblem, headerValueProblem } from './automation-token.mjs';

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

/**
 * Sign-in step 7c: a primary with two-factor sign-in off refuses the admin password sent with a request (403
 * password_needs_2fa). Its words and the way out, or null for any other answer.
 */
function passwordNeeds2faHint(status, body) {
    if (status !== 403 || body?.code !== 'password_needs_2fa') return null;
    return `${body.error || 'The primary refused the admin password.'}\n` +
        'The password alone opens nothing there: turn on two-factor sign-in on the primary, or set BEANPOOL_TOKEN ' +
        '(an owner\'s automation token, read or admin scope) and the primary\'s replication token in BACKUP_REPLICATION_TOKEN.';
}

/**
 * Upsert a set of KEY=VALUE lines into an .env file, preserving other lines. The file holds the replication
 * token, which reads the whole ledger: it is left owner-only (0600), an existing one narrowed before it is written.
 */
function upsertEnv(envPath, kv) {
    let lines = [];
    if (fs.existsSync(envPath)) {
        ownerOnly(envPath);
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
    fs.writeFileSync(envPath, out.join('\n').replace(/\n{3,}/g, '\n\n'), { mode: 0o600 });
    ownerOnly(envPath);
}

/** chmod 600, or a warning when this user may write the file but not change its mode (another owner). */
function ownerOnly(file) {
    try {
        fs.chmodSync(file, 0o600);
    } catch (e) {
        console.warn(`  ⚠️  Could not make ${file} owner-only (${e.code || e.message}): run chmod 600 on it. It holds the replication token.`);
    }
}

/**
 * No replication token given: make one on the primary, but only if it has none. Making a token replaces
 * the primary's current one, which would cut off any standby already copying with it.
 */
async function mintTokenIfNone(primary, adminPw) {
    const post = async (p) => {
        const res = await fetch(`${primary}${p}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Password': adminPw },
            body: JSON.stringify({ password: adminPw }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) die(`Primary refused ${p} (HTTP ${res.status}). ${passwordNeeds2faHint(res.status, body) ?? (body?.totpRequired ? 'Two-factor sign-in is on: make a token in Settings → Replication Access and set it in BACKUP_REPLICATION_TOKEN.' : '')}`);
        return body;
    };
    const status = await post('/api/local/admin/replication-token/status');
    if (status.hasToken) {
        die('The primary already has a replication token, and it shows a token only once. If you saved it when it was made, set it in BACKUP_REPLICATION_TOKEN.\n' +
            'If not, make a new one in Settings → Replication Access, paste it into every standby of that primary, and set it here in BACKUP_REPLICATION_TOKEN.\n' +
            '(This script will not make one itself: that would cut off any standby already using the current one.)');
    }
    const gen = await post('/api/local/admin/replication-token/generate');
    if (!gen.token) die('The primary did not return a replication token.');
    console.log('  • made a replication token on the primary (it has none before). It is saved in this machine\'s .env only.');
    return gen.token;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const primary = typeof args.primary === 'string' ? args.primary.replace(/\/$/, '') : null;
    const automationToken = process.env.BEANPOOL_TOKEN || null;
    const adminPw = typeof args['admin-pw'] === 'string' ? args['admin-pw'] : null;
    // The replication token from the environment first: it reads the whole ledger, and an argument shows in `ps`.
    const envReplicationToken = process.env.BACKUP_REPLICATION_TOKEN?.trim() || null;
    const argReplicationToken = typeof args.token === 'string' ? args.token.trim() : null;
    let replicationToken = envReplicationToken || argReplicationToken;
    if (argReplicationToken && envReplicationToken) console.log('  • BACKUP_REPLICATION_TOKEN is set: --token is not used.');
    else if (argReplicationToken) console.warn('  ⚠️  --token shows in `ps` to anyone on this machine: set BACKUP_REPLICATION_TOKEN in the environment instead.');
    const dataDir = path.resolve(typeof args['data-dir'] === 'string' ? args['data-dir'] : './data');

    if (!primary || (!automationToken && !adminPw)) {
        die('Usage: BEANPOOL_TOKEN=bp_... BACKUP_REPLICATION_TOKEN=<replication token> node scripts/setup-backup.mjs --primary <https url> [--data-dir <path>]\n' +
            '   or (legacy): node scripts/setup-backup.mjs --primary <https url> --admin-pw <pw> [--data-dir <path>]   (BACKUP_REPLICATION_TOKEN optional)');
    }
    // Each credential checked before any request, in words that never repeat it (automation-token.mjs). The replication
    // token goes into .env as well as a header: a line break in it would add a line there.
    const credentialProblem = (automationToken ? automationTokenProblem('BEANPOOL_TOKEN', automationToken) : headerValueProblem('--admin-pw', adminPw))
        ?? headerValueProblem('The replication token', replicationToken);
    if (credentialProblem) die(`${credentialProblem}${automationToken ? ' (On the primary: read or admin scope.)' : ''}`);
    // Said now, before anything is fetched or written: the step that makes the primary's replication token is an owner's.
    if (automationToken && !replicationToken) {
        die('With BEANPOOL_TOKEN, set the primary\'s replication token in BACKUP_REPLICATION_TOKEN.\n' +
            'Making one is an owner\'s change: no automation token can. An owner makes it on their phone or in Settings → Replication Access\n' +
            '(signed in with their key), copies it once, and it goes here in BACKUP_REPLICATION_TOKEN (not --token: an argument shows in `ps`).');
    }
    if (automationToken && adminPw) console.log('  • BEANPOOL_TOKEN is set: --admin-pw is not sent.');
    // The token alone, or the password alone: never both.
    const auth = automationToken ? { Authorization: `Bearer ${automationToken}` } : { 'X-Admin-Password': adminPw };
    if (!isAllowedPrimaryUrl(primary)) {
        die(`--primary must be an https:// URL (http:// allowed only for localhost). Got: ${primary}\n` +
            'Pulling over cleartext to a public host would leak the admin credential and full ledger.');
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
            headers: auth,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            let parsed = null;
            try { parsed = JSON.parse(body); } catch { /* not JSON: printed as it came */ }
            die(`Primary returned HTTP ${res.status}. ${res.status === 401 ? (automationToken ? 'Check BEANPOOL_TOKEN (revoked or expired?).' : 'Check --admin-pw.') : (passwordNeeds2faHint(res.status, parsed) ?? body)}`);
        }
        bundle = await res.json();
    } catch (e) {
        die(`Could not reach the primary: ${e?.message || e}\n` +
            '(For a self-signed-CA LAN primary, set NODE_EXTRA_CA_CERTS to its CA pem.)');
    }

    const { communityId, genesis, primaryPeerId, primaryUrl } = bundle;
    if (!genesis || !primaryPeerId) {
        die('Enrollment bundle is incomplete (missing genesis or primaryPeerId). Is the primary fully booted?');
    }
    console.log(`✅ Enrolled into community ${communityId} (primary PeerId ${primaryPeerId.slice(0, 16)}…)\n`);

    // 1b. The standby copies with a replication token, never the admin password.
    replicationToken = replicationToken || await mintTokenIfNone(primary, adminPw);

    // 2. Ensure the data dir exists.
    fs.mkdirSync(dataDir, { recursive: true });

    // 3. Write genesis.json. No key comes with it: a standby never needed community.key, and the main
    //    server's keys reach a standby only sealed to the owners (sealed-keys.md §1.1, §6.1). A stale
    //    community.key from an earlier install is removed, so this machine holds no key of another server.
    fs.writeFileSync(path.join(dataDir, 'genesis.json'), JSON.stringify(genesis, null, 2));
    console.log('  • wrote genesis.json');
    const staleCommunityKey = path.join(dataDir, 'community.key');
    if (fs.existsSync(staleCommunityKey)) {
        fs.unlinkSync(staleCommunityKey);
        console.log('  • removed an old community.key (a standby holds no key of the main server)');
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
        BACKUP_REPLICATION_TOKEN: replicationToken,
        // Blank any password an older version of this script wrote.
        BACKUP_ADMIN_PASSWORD: '',
    });
    console.log(`  • updated ${envPath} (NODE_ROLE=backup, BACKUP_PRIMARY_URL, BACKUP_REPLICATION_TOKEN; no admin password)\n`);

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
