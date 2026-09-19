/**
 * A standby server never keeps the main server's admin password.
 *
 * A standby used to be set up with the main server's admin password and kept it in plain text
 * (local-config.json `backupAdminPassword`). Anyone with the standby's disk, or a backup of it,
 * then had the main server's admin password. Checked here:
 *
 *   1. A fresh install is token-only; an existing install keeps its setting.
 *   2. Live Backup Server (replication-config/save) refuses the admin password, accepts a token.
 *   3. Warning path: a legacy standby whose main server already has a token keeps copying with
 *      the password (no other standby is cut off), warns, and Settings carries the warning.
 *   4. Warning path: two-factor sign-in on the main server — no token made, warning says why.
 *   5. Backup files and /api responses never carry the stored password.
 *   6. Auto-swap: a legacy standby whose main server has no token mints one with the password,
 *      stores only the token, and the password is nowhere in the data dir (grep, incl. state.db).
 *   7. Copying works end to end with the token, also with token-only switched on.
 *   8. A token already present: a stored password is wiped; an env password is warned about.
 *
 * Main server and standby share one process and one data dir, as in test-backup-topology: the
 * node signs its own snapshot and trusts itself as the `mirror`. The puller talks to the main
 * server's routes over real HTTP on 127.0.0.1.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-token-only.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';

const ADMIN_PW = 'Standby-Main-Pw-7731!xq';
process.env.ADMIN_PASSWORD = ADMIN_PW;
delete process.env.BACKUP_ADMIN_PASSWORD;
delete process.env.BACKUP_REPLICATION_TOKEN;
delete process.env.BACKUP_PRIMARY_URL;

// Everything the node prints, so the logs can be checked for the password.
const printed: string[] = [];
for (const m of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => {
        printed.push(args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' '));
        orig(...args);
    };
}

const { initStateEngine, setNodeRole, getReplicationAccessLog } = await import('./state-engine.js');
const { startP2P } = await import('./p2p.js');
const { addConnector, removeConnector } = await import('./connector-manager.js');
const {
    initAdminPassword, getLocalConfig, updateLocalConfig, setReplicationToken, clearReplicationToken,
    verifyReplicationToken,
} = await import('./config/local-config.js');
const { checkAdminAuth, resetAdminAuthTarpit } = await import('./admin-auth.js');
const { resetPasswordBrake } = await import('./password-brake.js');
const { createBackupRoutes } = await import('./routes/backup.js');
const { migrateStandbyPassword, requestResync, getBackupStatus } = await import('./services/backup-puller.js');
const { db } = await import('./db/db.js');

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}

const DATA_DIR = process.env.BEANPOOL_DATA_DIR;
if (!DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

/** Every file under dir whose bytes contain needle (state.db and its WAL included). */
function filesContaining(dir: string, needle: string): string[] {
    const hits: string[] = [];
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && fs.readFileSync(p).includes(Buffer.from(needle))) hits.push(path.relative(dir, p));
        }
    };
    walk(dir);
    return hits;
}

function resetBrakes() {
    resetAdminAuthTarpit();
    try { resetPasswordBrake(); } catch { /* not every build exports a reset */ }
}

async function main() {
    // ---------- 1. Primary default ----------
    initAdminPassword();
    assert(getLocalConfig().replicationTokenOnly === true, '1. a fresh install starts token-only');
    updateLocalConfig({ replicationTokenOnly: undefined });
    initAdminPassword(); // locked now: an existing install is left alone
    assert(getLocalConfig().replicationTokenOnly === undefined, '1. an existing install (locked) keeps its unset token-only flag (reads as off)');

    initStateEngine();
    const node = await startP2P(4062, 4063);
    const nodeId = node.peerId.toString();
    const mirrorAddr = `/ip4/127.0.0.1/tcp/4063/p2p/${nodeId}`;
    addConnector(mirrorAddr, 'mirror', 'self-test-primary');

    // The main server's backup routes over real HTTP, parsed the way https-server.ts does.
    const router = createBackupRoutes({
        checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
        rateLimit: () => true,
        clampLimit: (_v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    } as any);
    const app = new Koa();
    app.use(async (ctx, next) => {
        if (ctx.method === 'POST' && (ctx.get('content-type') || '').includes('application/json')) {
            const raw = await new Promise<string>((resolve) => {
                let s = ''; ctx.req.on('data', (c) => { s += c; }); ctx.req.on('end', () => resolve(s));
            });
            try { (ctx as any).requestBody = raw ? JSON.parse(raw) : {}; } catch { (ctx as any).requestBody = {}; }
        } else {
            (ctx as any).requestBody = {};
        }
        await next();
    });
    app.use(router.routes());
    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (p: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
        resetBrakes();
        const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        const text = await res.text();
        let json: any = null; try { json = JSON.parse(text); } catch { /* binary */ }
        return { status: res.status, text, json };
    };

    try {
        // Password pulls refused while token-only is on (the fresh-install default).
        updateLocalConfig({ replicationTokenOnly: true });
        resetBrakes();
        const pwPull = await fetch(`${base}/api/local/admin/sync-snapshot`, { headers: { 'X-Admin-Password': ADMIN_PW } });
        assert(pwPull.status === 401, '1. token-only main server refuses an admin-password snapshot pull (401)');
        // From here the main server is an EXISTING install: admin-password pulls still allowed.
        updateLocalConfig({ replicationTokenOnly: false });

        setNodeRole('backup');

        // ---------- 2. Live Backup Server route ----------
        const refused = await post('/api/local/admin/replication-config/save', { password: ADMIN_PW, primaryUrl: base, primaryPassword: ADMIN_PW });
        assert(refused.status === 400, '2. saving the main server admin password is refused (400)');
        assert(/replication token/i.test(refused.json?.error || ''), '2. the refusal says to use a replication token');
        assert(!getLocalConfig().backupAdminPassword, '2. nothing was stored');
        const accepted = await post('/api/local/admin/replication-config/save', { password: ADMIN_PW, primaryUrl: base, primaryToken: 'a-pasted-token' });
        assert(accepted.status === 200 && accepted.json?.success, '2. saving a token is accepted');
        assert(getLocalConfig().backupReplicationToken === 'a-pasted-token', '2. the token is stored');
        await post('/api/local/admin/replication-config/save', { password: ADMIN_PW, primaryUrl: base, primaryToken: '' });
        assert(!getLocalConfig().backupReplicationToken, '2. an empty token clears it');

        // ---------- 3. Warning path: main server already has a token ----------
        setReplicationToken('token-of-another-standby');
        const hashBefore = getLocalConfig().replicationTokenHash;
        updateLocalConfig({ backupPrimaryUrl: base, backupAdminPassword: ADMIN_PW, backupReplicationToken: null }); // legacy standby
        const warned = await migrateStandbyPassword();
        assert(warned.lastSwap === 'failed' && warned.using === 'password', '3. with a token already on the main server, no swap: keeps copying with the password');
        assert(/already has a replication token/.test(warned.warning || ''), '3. the warning says why');
        assert(/Replication Access/.test(warned.warning || '') && /Live Backup Server/.test(warned.warning || ''), '3. the warning says what to do');
        assert(getLocalConfig().replicationTokenHash === hashBefore, '3. the other standby\'s token was NOT replaced');
        assert(await verifyReplicationToken('token-of-another-standby'), '3. the other standby can still copy');
        const stillCopies = await requestResync();
        assert(stillCopies.ok, `3. copying still works with the password (${stillCopies.error || 'ok'})`);
        assert(getReplicationAccessLog().lastPullAuth === 'admin-pw', '3. that pull used the admin password');
        const status = await post('/api/local/admin/backup-status', { password: ADMIN_PW });
        assert(/admin password/.test(status.json?.credential?.warning || ''), '3. Settings (backup-status) carries the warning for the banner');
        const cfgGet = await post('/api/local/admin/replication-config/get', { password: ADMIN_PW });
        assert(cfgGet.json?.credential?.passwordStored === true && typeof cfgGet.json?.credential?.warning === 'string', '3. replication-config/get carries the warning too');

        // ---------- 4. Warning path: two-factor sign-in on the main server ----------
        clearReplicationToken();
        updateLocalConfig({ totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' });
        const tfa = await migrateStandbyPassword();
        assert(tfa.lastSwap === 'failed' && /two-factor/.test(tfa.warning || ''), '4. two-factor on: no swap, and the warning says so');
        assert(!getLocalConfig().replicationTokenHash, '4. no token was made on the main server');
        assert(getLocalConfig().backupAdminPassword === ADMIN_PW, '4. the password is kept so nothing breaks silently');
        updateLocalConfig({ totpEnabled: false, totpSecret: null });

        // ---------- 5. Backup files and API responses ----------
        fs.writeFileSync(path.join(DATA_DIR!, 'genesis.json'), JSON.stringify({ communityId: 'standby-test' }));
        if (!fs.existsSync(path.join(DATA_DIR!, 'community.key'))) fs.writeFileSync(path.join(DATA_DIR!, 'community.key'), 'test-key');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-bundles-'));
        for (const [route, name] of [['/api/local/admin/identity-bundle', 'identity'], ['/api/local/admin/backup', 'db']] as const) {
            resetBrakes();
            const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': ADMIN_PW }, body: JSON.stringify({ password: ADMIN_PW }) });
            assert(res.status === 200, `5. ${route} answers 200`);
            const tarPath = path.join(tmp, `${name}.tar.gz`);
            fs.writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));
            const out = path.join(tmp, name);
            fs.mkdirSync(out);
            execFileSync('tar', ['-xzf', tarPath, '-C', out]);
            assert(filesContaining(out, ADMIN_PW).length === 0, `5. the ${name} backup file does not contain the stored password`);
            assert(!fs.readFileSync(tarPath).includes(Buffer.from(ADMIN_PW)), `5. nor does the ${name} archive itself`);
        }
        fs.rmSync(tmp, { recursive: true, force: true });
        for (const p of ['/api/local/admin/replication-config/get', '/api/local/admin/backup-status', '/api/local/admin/replication-token/status', '/api/local/admin/replication-access']) {
            const r = await post(p, { password: ADMIN_PW });
            assert(r.status === 200 && !r.text.includes(ADMIN_PW), `5. ${p} never returns the stored password`);
        }

        // ---------- 6. Auto-swap: main server has no token ----------
        assert(!getLocalConfig().replicationTokenHash, '6. precondition: the main server has no replication token');
        const swapped = await migrateStandbyPassword();
        assert(swapped.lastSwap === 'minted-token' && swapped.using === 'token' && swapped.warning === null, '6. the password was swapped for a token, no warning');
        const cfg = getLocalConfig();
        assert(!cfg.backupAdminPassword, '6. the stored password is wiped from local-config');
        assert(typeof cfg.backupReplicationToken === 'string' && cfg.backupReplicationToken.length >= 32, '6. a token is stored instead');
        assert(await verifyReplicationToken(cfg.backupReplicationToken as string), '6. the main server accepts that token');
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
        const hits = filesContaining(DATA_DIR!, ADMIN_PW);
        assert(hits.length === 0, `6. no plain-text password anywhere in the data dir after the swap${hits.length ? ' — found in ' + hits.join(', ') : ''}`);

        // ---------- 7. Copying end to end with the token ----------
        const memberCount = () => (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c;
        const accountCount = () => (db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c;
        const before = { m: memberCount(), a: accountCount() };
        const pulled = await requestResync();
        assert(pulled.ok, `7. a full copy with the token succeeds (${pulled.error || 'ok'})`);
        assert(getReplicationAccessLog().lastPullAuth === 'token', '7. the main server logged a token pull');
        assert(memberCount() === before.m && accountCount() === before.a, '7. the copy rebuilt the same members and accounts');
        assert(!!getBackupStatus().lastSuccessAt, '7. the standby records a successful pull');
        updateLocalConfig({ replicationTokenOnly: true });
        const pulledTokenOnly = await requestResync();
        assert(pulledTokenOnly.ok, '7. copying still works once the main server is token-only');

        // ---------- 8. Token already present ----------
        updateLocalConfig({ backupAdminPassword: ADMIN_PW });
        const wiped = await migrateStandbyPassword();
        assert(wiped.lastSwap === 'wiped-unused-password' && !getLocalConfig().backupAdminPassword, '8. a token already present: the unused stored password is wiped');
        process.env.BACKUP_ADMIN_PASSWORD = ADMIN_PW;
        const envWarn = await migrateStandbyPassword();
        assert(envWarn.using === 'token' && /BACKUP_ADMIN_PASSWORD/.test(envWarn.warning || ''), '8. a password left in .env is warned about, and not used');
        delete process.env.BACKUP_ADMIN_PASSWORD;

        // ---------- Logs ----------
        const leaked = printed.filter(l => l.includes(ADMIN_PW));
        assert(leaked.length === 0, `logs never contain the password${leaked.length ? ' — ' + leaked.length + ' line(s)' : ''}`);
    } finally {
        removeConnector(mirrorAddr);
        server.close();
        await node.stop();
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Standby token-only checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e?.message || e); process.exit(1); });
