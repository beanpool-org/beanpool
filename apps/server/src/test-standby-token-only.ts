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
 *      With token-only on as well, the banner says it is NOT copying, and the pull does fail.
 *   4. Warning path: two-factor sign-in on the main server, or a stored password it refuses —
 *      no token made, and the banner says the standby is NOT copying (the pull really fails).
 *   5. Backup files and /api responses never carry the stored password (the sealed backup is opened with a
 *      recovery code and every file inside it checked); the plain identity bundle is gone (404).
 *   6. Auto-swap: a legacy standby whose main server has no token mints one with the password,
 *      stores only the token, and the password is nowhere in the data dir (grep, incl. state.db).
 *   7. Copying works end to end with the token, also with token-only switched on; the token's /backup is sealed.
 *   8. A token already present: a stored password is wiped; an env password is warned about.
 *   9. Race: a token replaced by another standby's swap during the re-check keeps the password;
 *      two swaps at once leave exactly one working token.
 *  10. A swap whose config write fails is not reported as done, and nothing is wiped.
 *  11. Node Settings' Replication Access status line (static/settings.js, run against the real
 *      route) says nothing can copy when token-only is on with no token.
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
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';

const ADMIN_PW = 'Standby-Main-Pw-7731!xq';
process.env.ADMIN_PASSWORD = ADMIN_PW;
delete process.env.BACKUP_ADMIN_PASSWORD;
delete process.env.BACKUP_REPLICATION_TOKEN;
delete process.env.BACKUP_PRIMARY_URL;
// The swap re-checks a new token after a pause (race guard); keep it short here.
process.env.BACKUP_SWAP_RECHECK_MS = '150';

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
const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
const { openEnvelope, readSealedHeader } = await import('@beanpool/core');

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
        assert(/^This standby still copies with the main server's admin password/.test(warned.warning || '') && !/NOT copying/.test(warned.warning || ''),
            '3. token-only off: the warning says it still copies (true: the pull below works)');
        assert(!/copy its replication token/i.test(warned.warning || '') && /make a new token, and paste it into every standby/.test(warned.warning || ''),
            '3. the fix steps say to reuse a saved token or make a new one for every standby (the main server shows a token only once)');
        const status = await post('/api/local/admin/backup-status', { password: ADMIN_PW });
        assert(/admin password/.test(status.json?.credential?.warning || ''), '3. Settings (backup-status) carries the warning for the banner');
        const cfgGet = await post('/api/local/admin/replication-config/get', { password: ADMIN_PW });
        assert(cfgGet.json?.credential?.passwordStored === true && typeof cfgGet.json?.credential?.warning === 'string', '3. replication-config/get carries the warning too');

        // Token-only on as well: the main server refuses the password, so nothing is copying.
        updateLocalConfig({ replicationTokenOnly: true });
        const tokOnly = await migrateStandbyPassword();
        assert(tokOnly.lastSwap === 'failed' && /^This standby is NOT copying/.test(tokOnly.warning || '') && !/still copies/.test(tokOnly.warning || ''),
            '3. token already there and token-only on: the warning says NOT copying');
        resetBrakes();
        const tokOnlyPull = await requestResync();
        assert(!tokOnlyPull.ok && /401/.test(tokOnlyPull.error || ''), `3. …and that is true: the password pull is refused (${tokOnlyPull.error || 'ok'})`);
        updateLocalConfig({ replicationTokenOnly: false });

        // ---------- 4. Warning path: two-factor sign-in on the main server ----------
        clearReplicationToken();
        updateLocalConfig({ totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' });
        const tfa = await migrateStandbyPassword();
        assert(tfa.lastSwap === 'failed' && /two-factor/.test(tfa.warning || ''), '4. two-factor on: no swap, and the warning says so');
        assert(/^This standby is NOT copying: the main server refuses its stored admin password/.test(tfa.warning || ''), '4. two-factor on: the warning says this standby is NOT copying');
        assert(!/still copies/.test(tfa.warning || ''), '4. two-factor on: the warning never says it still copies');
        assert(/Live Backup Server/.test(tfa.warning || '') && /Replication Access, make a new token/.test(tfa.warning || ''), '4. two-factor on: the warning gives the fix steps');
        assert(!getLocalConfig().replicationTokenHash, '4. no token was made on the main server');
        assert(getLocalConfig().backupAdminPassword === ADMIN_PW, '4. the password is kept (not wiped on a guess), though it no longer copies');
        resetBrakes();
        const tfaPull = await requestResync();
        assert(!tfaPull.ok && /401/.test(tfaPull.error || ''), `4. …and NOT copying is true: the password pull gets 401 with two-factor on (${tfaPull.error || 'ok'})`);
        updateLocalConfig({ totpEnabled: false, totpSecret: null }); // so this test can sign in to read Settings
        const tfaStatus = await post('/api/local/admin/backup-status', { password: ADMIN_PW });
        assert(/NOT copying/.test(tfaStatus.json?.credential?.warning || ''), '4. Settings (backup-status) carries the NOT copying banner');

        // A stored password the main server refuses (e.g. it was changed since).
        updateLocalConfig({ backupAdminPassword: 'an-old-admin-password-9!' });
        resetBrakes();
        const refusedPw = await migrateStandbyPassword();
        assert(refusedPw.lastSwap === 'failed' && /refused the stored password/.test(refusedPw.warning || '') && /^This standby is NOT copying/.test(refusedPw.warning || ''),
            '4. a refused password: the warning says NOT copying, and why');
        assert(!/still copies/.test(refusedPw.warning || ''), '4. a refused password: the warning never says it still copies');
        updateLocalConfig({ backupAdminPassword: ADMIN_PW });
        resetBrakes();

        // ---------- 5. Backup files and API responses ----------
        fs.writeFileSync(path.join(DATA_DIR!, 'genesis.json'), JSON.stringify({ communityId: 'standby-test' }));
        if (!fs.existsSync(path.join(DATA_DIR!, 'community.key'))) fs.writeFileSync(path.join(DATA_DIR!, 'community.key'), 'test-key');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-bundles-'));
        // Backups are sealed (sealed-keys slice 3): the node needs someone to lock them to, and this check opens the
        // file to look inside it — the database, node_config.json and the take-over bundle with the node keys.
        const recovery = await makeRecoveryCode({ replace: true });
        {
            resetBrakes();
            const res = await fetch(base + '/api/local/admin/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': ADMIN_PW }, body: JSON.stringify({ password: ADMIN_PW }) });
            assert(res.status === 200, '5. /api/local/admin/backup answers 200');
            const sealed = Buffer.from(await res.arrayBuffer());
            assert(!(sealed[0] === 0x1f && sealed[1] === 0x8b), '5. …with a sealed file, not a plain archive');
            const tarPath = path.join(tmp, 'db.tar.gz');
            fs.writeFileSync(tarPath, (await openEnvelope(new Uint8Array(sealed), { type: 'code', code: recovery.code }, { kind: 'backup' })).payload);
            const out = path.join(tmp, 'db');
            fs.mkdirSync(out);
            execFileSync('tar', ['-xzf', tarPath, '-C', out]);
            assert(fs.existsSync(path.join(out, 'takeover-bundle.json')), '5. the opened backup carries the take-over bundle (the node keys)');
            assert(filesContaining(out, ADMIN_PW).length === 0, '5. the db backup file does not contain the stored password (every file in it, the bundle included)');
            assert(!fs.readFileSync(tarPath).includes(Buffer.from(ADMIN_PW)), '5. nor does the db archive itself');
            assert(!sealed.includes(Buffer.from(ADMIN_PW)), '5. nor the sealed file');
        }
        resetBrakes();
        const idGone = await fetch(base + '/api/local/admin/identity-bundle', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': ADMIN_PW }, body: JSON.stringify({ password: ADMIN_PW }) });
        assert(idGone.status === 404, `5. the plain identity bundle is gone: 404 even with the admin password (got ${idGone.status})`);
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
        // The standby's token copies the database, never the node keys (sealed-keys slice 0).
        const standbyToken = getLocalConfig().backupReplicationToken as string;
        // Since sealed backups (slice 3) the plain identity bundle is gone for every credential, and what the token
        // downloads is the sealed backup: ciphertext, with the keys inside only the owners and the code can open.
        resetBrakes();
        const idByToken = await fetch(base + '/api/local/admin/identity-bundle', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Replication-Token': standbyToken }, body: '{}' });
        const idByTokenBody = Buffer.from(await idByToken.arrayBuffer());
        assert(idByToken.status === 404 && !idByToken.headers.get('x-identity-files'), `7. the token gets no identity bundle: the route is gone (got ${idByToken.status})`);
        assert(!(idByTokenBody[0] === 0x1f && idByTokenBody[1] === 0x8b), '7. …and nothing gzip comes back');
        resetBrakes();
        const dbByToken = await fetch(base + '/api/local/admin/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Replication-Token': standbyToken }, body: '{}' });
        const dbByTokenBytes = Buffer.from(await dbByToken.arrayBuffer());
        assert(dbByToken.status === 200 && dbByToken.headers.get('content-type') === 'application/octet-stream', `7. the token still downloads the database backup (got ${dbByToken.status})`);
        assert(!(dbByTokenBytes[0] === 0x1f && dbByTokenBytes[1] === 0x8b) && readSealedHeader(new Uint8Array(dbByTokenBytes)).kind === 'backup', '7. …sealed, never a plain archive');

        // ---------- 8. Token already present ----------
        updateLocalConfig({ backupAdminPassword: ADMIN_PW });
        const wiped = await migrateStandbyPassword();
        assert(wiped.lastSwap === 'wiped-unused-password' && !getLocalConfig().backupAdminPassword, '8. a token already present: the unused stored password is wiped');
        process.env.BACKUP_ADMIN_PASSWORD = ADMIN_PW;
        const envWarn = await migrateStandbyPassword();
        assert(envWarn.using === 'token' && /BACKUP_ADMIN_PASSWORD/.test(envWarn.warning || ''), '8. a password left in .env is warned about, and not used');
        delete process.env.BACKUP_ADMIN_PASSWORD;

        // ---------- 9. Race: two old standbys swapping on one tokenless main server ----------
        const legacyStandby = () => {
            clearReplicationToken();
            updateLocalConfig({ replicationTokenOnly: false, backupAdminPassword: ADMIN_PW, backupReplicationToken: null });
        };
        // (a) Deterministic: another standby makes a token while this one is re-checking its own.
        legacyStandby();
        process.env.BACKUP_SWAP_RECHECK_MS = '1500';
        const racing = migrateStandbyPassword();
        for (let i = 0; i < 100 && !getLocalConfig().replicationTokenHash; i++) await new Promise(r => setTimeout(r, 10));
        assert(!!getLocalConfig().replicationTokenHash, '9. precondition: this standby made a token and is re-checking it');
        const other = await post('/api/local/admin/replication-token/generate', { password: ADMIN_PW }, { 'X-Admin-Password': ADMIN_PW });
        assert(other.status === 200 && typeof other.json?.token === 'string', '9. another standby makes a token meanwhile (replacing it)');
        const lost = await racing;
        assert(lost.lastSwap === 'failed' && /another standby made a replication token/.test(lost.warning || ''), '9. the re-check notices its token was replaced, and says so');
        assert(getLocalConfig().backupAdminPassword === ADMIN_PW && !getLocalConfig().backupReplicationToken, '9. it keeps its password and stores no dead token');
        assert(await verifyReplicationToken(other.json.token), '9. the other standby\'s token still works');

        // (b) Two swaps at the same moment: exactly one ends with a working token.
        legacyStandby();
        process.env.BACKUP_SWAP_RECHECK_MS = '300';
        const pair = await Promise.all([migrateStandbyPassword(), migrateStandbyPassword()]);
        const winners = pair.filter(r => r.lastSwap === 'minted-token').length;
        const losers = pair.filter(r => r.lastSwap === 'failed').length;
        assert(winners === 1 && losers === 1, `9. two swaps at once: one mints, one backs off (got ${pair.map(r => r.lastSwap).join(', ')})`);
        const kept = getLocalConfig().backupReplicationToken;
        assert(typeof kept === 'string' && await verifyReplicationToken(kept), '9. the token stored at the end is the one the main server accepts');
        process.env.BACKUP_SWAP_RECHECK_MS = '150';

        // ---------- 10. A config write that fails is not reported as a swap ----------
        legacyStandby();
        const cfgPath = path.join(DATA_DIR!, 'local-config.json');
        // Main server and standby share this file here, so make it read-only only once the main
        // server has stored its new token (during the re-check pause); the standby's write then fails.
        process.env.BACKUP_SWAP_RECHECK_MS = '800';
        let unsaved;
        const printedBefore = printed.length;
        try {
            const pending = migrateStandbyPassword();
            for (let i = 0; i < 100 && !getLocalConfig().replicationTokenHash; i++) await new Promise(r => setTimeout(r, 10));
            fs.chmodSync(cfgPath, 0o444);
            unsaved = await pending;
        } finally { fs.chmodSync(cfgPath, 0o644); process.env.BACKUP_SWAP_RECHECK_MS = '150'; }
        const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
        if (isRoot) {
            console.log('  (10 skipped: running as root, a read-only file is still writable)');
        } else {
            assert(unsaved.lastSwap === 'failed' && /could not be saved/.test(unsaved.warning || ''), `10. a write that fails is reported as a failure, not "Swapped" (${unsaved.lastSwap}: ${unsaved.warning})`);
            assert(!printed.slice(printedBefore).some(l => l.includes('Swapped the main server')), '10. no "Swapped…" log line for it');
            assert(getLocalConfig().backupAdminPassword === ADMIN_PW, '10. the password on disk is untouched');
        }

        // ---------- 11. Node Settings: Replication Access status line ----------
        const settingsSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'static', 'settings.js'), 'utf-8');
        const start = settingsSrc.indexOf('async function loadReplicationAccess()');
        let depth = 0, end = settingsSrc.indexOf('{', start);
        for (let i = end; i < settingsSrc.length; i++) {
            if (settingsSrc[i] === '{') depth++;
            else if (settingsSrc[i] === '}' && --depth === 0) { end = i + 1; break; }
        }
        const els: Record<string, any> = {};
        for (const id of ['rep-token-state', 'rep-token-only', 'rep-token-only-notice']) els[id] = { textContent: '', style: {}, checked: false };
        const settingsCtx = vm.createContext({
            API: `${base}/api/local`, authToken: ADMIN_PW, relativeTime: () => 'now', JSON,
            fetch: (u: string, init: any) => { resetBrakes(); return fetch(u, init); },
            document: { getElementById: (id: string) => els[id] || null },
        });
        vm.runInContext(settingsSrc.slice(start, end) + '\nthis.loadReplicationAccess = loadReplicationAccess;', settingsCtx);
        clearReplicationToken();
        updateLocalConfig({ replicationTokenOnly: true }); // a fresh install, or a token cleared on a token-only server
        await settingsCtx.loadReplicationAccess();
        assert(els['rep-token-state'].textContent === 'not set · nothing can copy until you make a token',
            `11. Settings, token-only with no token: "nothing can copy" (got "${els['rep-token-state'].textContent}")`);
        assert(!/admin password in use/.test(els['rep-token-state'].textContent), '11. …and never "admin password in use"');
        updateLocalConfig({ replicationTokenOnly: false });
        await settingsCtx.loadReplicationAccess();
        assert(els['rep-token-state'].textContent === 'not set · standbys copy with the admin password', '11. Settings, token-only off with no token: standbys copy with the admin password');
        assert(els['rep-token-only-notice'].style.display === 'block', '11. …with the token-only-off notice shown');

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
