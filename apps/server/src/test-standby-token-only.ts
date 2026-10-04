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
 *   7. Copying works end to end with the token, also with token-only switched on; the token gets no /backup, locked or not.
 *   8. A token already present: a stored password is wiped; an env password is warned about.
 *   9. Race: a token replaced by another standby's swap during the re-check keeps the password;
 *      two swaps at once leave exactly one working token.
 *  10. A swap whose config write fails is not reported as done, and nothing is wiped.
 *  11. Node Settings' Replication Access status line (static/settings.js, run against the real
 *      route) says nothing can copy when token-only is on with no token.
 *  12. Recovery seal S2: the replication token gets data/recovery-seal.key on no route (every backup and take-over
 *      route, called with the token, answers without its bytes in any form), while the sealed backup, opened with the
 *      recovery code, carries it; and no log line holds it. The same for the open door's key, data/open-join.key (C12).
 *
 * Main server and standby share one process and one data dir, as in test-backup-topology: the
 * node signs its own snapshot and trusts itself as the `mirror`. The puller talks to the main
 * server's routes over real HTTP on 127.0.0.1.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-token-only.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import Database from 'better-sqlite3';

const ADMIN_PW = 'Standby-Main-Pw-7731!xq';
process.env.ADMIN_PASSWORD = ADMIN_PW;
delete process.env.BACKUP_ADMIN_PASSWORD;
delete process.env.BACKUP_REPLICATION_TOKEN;
delete process.env.BACKUP_PRIMARY_URL;
// The swap re-checks a new token after a pause (race guard); keep it short here.
process.env.BACKUP_SWAP_RECHECK_MS = '150';

// Everything the node prints, so the logs can be checked for the password.
const printed: string[] = [];
/** Sections 6, 9 and 10: the main server answers as one from before step 7c (routeDeps, below). */
let preStep7cPrimary = false;
for (const m of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => {
        printed.push(args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' '));
        orig(...args);
    };
}

const { initStateEngine, setNodeRole, getReplicationAccessLog, seedGenesisMember } = await import('./state-engine.js');
const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
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
const { createTakeoverEnvelopeRoutes } = await import('./routes/takeover-envelope.js');
const { openEnvelope } = await import('@beanpool/core');

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
    const node = await startP2P(0, 0);
    const nodeId = node.peerId.toString();
    const mirrorAddr = `/ip4/127.0.0.1/tcp/4063/p2p/${nodeId}`;
    addConnector(mirrorAddr, 'mirror', 'self-test-primary');

    // The main server's backup routes over real HTTP, parsed the way https-server.ts does.
    // checkAdminAuth as https-server.ts hands it over, its options included (replicationAuth's legacyCopy). While
    // `preStep7cPrimary` is set, the main server answers as one from before step 7c did: the password alone (2FA off) opens
    // its admin routes, so the standby's one-time swap can mint a token there (sections 6, 9, 10). Otherwise it is
    // today's: with 2FA off the password opens only the copy routes (section 6a).
    const routeDeps = {
        checkAdminAuth: async (ctx: any, opts?: any) => checkAdminAuth(ctx, preStep7cPrimary ? { ...opts, legacyCopy: true } : opts),
        rateLimit: () => true,
        clampLimit: (_v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    } as any;
    const router = createBackupRoutes(routeDeps);
    // Settings' own calls in this suite come from the owner's key session: the admin password alone opens no admin route
    // while 2FA is off (step 7c), and this suite is about the standby's credential, not the owner's sign-in.
    const ownerPk = crypto.randomBytes(32).toString('hex');
    seedGenesisMember(ownerPk, 'Owner');
    const signedIn = consumeHandshakeToken(mintHandshakeToken(ownerPk, 'owner').handshakeToken);
    if (!signedIn.ok || !signedIn.sessionId) throw new Error(`setup: no owner session: ${signedIn.error}`);
    const asOwner = { 'x-admin-session': signedIn.sessionId };
    // The take-over envelope's routes too (the token fetches the envelope from one of them): section 12.
    const takeoverRouter = createTakeoverEnvelopeRoutes(routeDeps);
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
    app.use(takeoverRouter.routes());
    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (p: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
        resetBrakes();
        const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...asOwner, ...headers }, body: JSON.stringify(body) });
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
        preStep7cPrimary = true; // the token check comes after the password is taken (6a: today's refuses it first)
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

        // ---------- 4b. A main server address that redirects (#1575 review): never followed with a credential ----------
        {
            const elsewhereSeen: { method: string; path: string; password: boolean; token: boolean }[] = [];
            const elsewhere = http.createServer((req, res) => {
                elsewhereSeen.push({ method: req.method || '', path: req.url || '', password: 'x-admin-password' in req.headers, token: 'x-replication-token' in req.headers });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
            });
            await new Promise<void>(r => elsewhere.listen(0, '127.0.0.1', () => r()));
            const elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;
            let code = 302;
            const redirecting = http.createServer((req, res) => {
                res.writeHead(code, { Location: `${elsewhereUrl}${req.url}` });
                res.end();
            });
            await new Promise<void>(r => redirecting.listen(0, '127.0.0.1', () => r()));
            const redirectingUrl = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`;
            try {
                for (const status of [302, 307, 308]) {
                    code = status;
                    // A legacy standby: the swap sends the password.
                    updateLocalConfig({ backupPrimaryUrl: redirectingUrl, backupAdminPassword: ADMIN_PW, backupReplicationToken: null });
                    const swap = await migrateStandbyPassword();
                    assert(swap.lastSwap === 'failed' && (swap.warning || '').includes(`answered HTTP ${status}, a redirect to ${elsewhereUrl}/api/local/admin/replication-token/status.`)
                        && !(swap.warning || '').includes(ADMIN_PW),
                        `4b. a ${status} on the swap is not followed, and the warning names where it pointed (got: ${swap.warning})`);
                    const pwCopy = await requestResync();
                    assert(!pwCopy.ok && (pwCopy.error || '').includes(`answered HTTP ${status}, a redirect to ${elsewhereUrl}/api/local/admin/sync-copy.`)
                        && !(pwCopy.error || '').includes(ADMIN_PW),
                        `4b. a ${status} on a password copy is not followed, and the error names where it pointed (got: ${pwCopy.error})`);
                    // A standby with a token: the copy sends the token.
                    updateLocalConfig({ backupAdminPassword: null, backupReplicationToken: 'redirect-test-token' });
                    const tokCopy = await requestResync();
                    assert(!tokCopy.ok && (tokCopy.error || '').includes(`answered HTTP ${status}, a redirect to ${elsewhereUrl}/api/local/admin/sync-copy.`)
                        && !(tokCopy.error || '').includes('redirect-test-token'),
                        `4b. a ${status} on a token copy is not followed, and the error names where it pointed (got: ${tokCopy.error})`);
                }
                assert(elsewhereSeen.length === 0, `4b. the other origin received nothing: no password, no token, no request (got ${JSON.stringify(elsewhereSeen)})`);
            } finally {
                await new Promise<void>(r => redirecting.close(() => r()));
                await new Promise<void>(r => elsewhere.close(() => r()));
                updateLocalConfig({ backupPrimaryUrl: base, backupAdminPassword: ADMIN_PW, backupReplicationToken: null });
                resetBrakes();
            }
        }

        // ---------- 5. Backup files and API responses ----------
        fs.writeFileSync(path.join(DATA_DIR!, 'genesis.json'), JSON.stringify({ communityId: 'standby-test' }));
        if (!fs.existsSync(path.join(DATA_DIR!, 'community.key'))) fs.writeFileSync(path.join(DATA_DIR!, 'community.key'), 'test-key');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-bundles-'));
        // Backups are sealed (sealed-keys slice 3): the node needs someone to lock them to, and this check opens the
        // file to look inside it — the database, node_config.json and the take-over bundle with the node keys.
        const recovery = await makeRecoveryCode({ replace: true });
        {
            resetBrakes();
            const res = await fetch(base + '/api/local/admin/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', ...asOwner }, body: JSON.stringify({}) });
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
        const idGone = await fetch(base + '/api/local/admin/identity-bundle', { method: 'POST', headers: { 'Content-Type': 'application/json', ...asOwner }, body: JSON.stringify({}) });
        assert(idGone.status === 404, `5. the plain identity bundle is gone: 404 even to an owner (got ${idGone.status})`);
        fs.rmSync(tmp, { recursive: true, force: true });
        for (const p of ['/api/local/admin/replication-config/get', '/api/local/admin/backup-status', '/api/local/admin/replication-token/status', '/api/local/admin/replication-access']) {
            const r = await post(p, { password: ADMIN_PW });
            assert(r.status === 200 && !r.text.includes(ADMIN_PW), `5. ${p} never returns the stored password`);
        }

        preStep7cPrimary = false;
        // ---------- 6a. Step 7c: a main server with 2FA off no longer makes a token for the password alone ----------
        assert(!getLocalConfig().replicationTokenHash, '6a. precondition: the main server has no replication token');
        const printedAt6a = printed.length;
        const noSwap = await migrateStandbyPassword();
        assert(noSwap.lastSwap === 'failed' && noSwap.using === 'password', `6a. today's main server with 2FA off: no swap, the password is kept (${noSwap.lastSwap})`);
        assert(/two-factor sign-in is off/.test(noSwap.warning || '') && /from the owner's phone/.test(noSwap.warning || ''),
            `6a. the warning says to make a replication token from the owner's phone (${noSwap.warning})`);
        assert(!/NOT copying/.test(noSwap.warning || '') && !/refused the stored password/.test(noSwap.warning || ''),
            '6a. it never says the password was refused or that copying stopped');
        const said = printed.slice(printedAt6a).filter(l => l.includes('[Backup]') && l.includes("from the owner's phone")).length;
        assert(said === 1, `6a. one log line says so (${said})`);
        assert(getLocalConfig().backupAdminPassword === ADMIN_PW && !getLocalConfig().replicationTokenHash, '6a. no token was made; the password is still stored');
        resetBrakes();
        const still = await requestResync();
        assert(still.ok && getReplicationAccessLog().lastPullAuth === 'admin-pw', `6a. …and the standby keeps copying with the password (${still.error || 'ok'})`);

        // ---------- 6. Auto-swap: a main server from before step 7c has no token ----------
        preStep7cPrimary = true;
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
        // A force-resync is a whole copy built in data/staging and swapped in at a restart. This process registered no
        // restart (index.ts does, at boot), so the copy waits there for the next start, and this process carries on.
        const staged = (() => {
            if (!fs.existsSync(path.join(DATA_DIR!, 'staging', 'READY'))) return null;
            const copy = new Database(path.join(DATA_DIR!, 'staging', 'state.db'), { readonly: true });
            try {
                return {
                    m: (copy.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c,
                    a: (copy.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c,
                };
            } finally { copy.close(); }
        })();
        assert(pulled.restarting === false && staged?.m === before.m && staged?.a === before.a,
            `7. the copy, made ready in data/staging for the next start, holds the same members and accounts (${JSON.stringify({ staged, before })})`);
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
        // Nor any backup. This step asserted the token downloaded the sealed one; on a server with no recovery code the
        // same call sent the readable database, tunnel token, admin hash and 2FA secret with it (Fable's replication
        // review HIGH-1, 2026-10-01). The token now copies and fetches the take-over envelope, and nothing else: /backup
        // is an owner's, locked or not (test-backup-owner-gate sweeps every route).
        resetBrakes();
        const dbByToken = await fetch(base + '/api/local/admin/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Replication-Token': standbyToken }, body: '{}' });
        const dbByTokenBytes = Buffer.from(await dbByToken.arrayBuffer());
        assert(dbByToken.status === 401 && dbByToken.headers.get('content-type') !== 'application/octet-stream',
            `7. the token downloads no backup, locked or not (got ${dbByToken.status})`);
        assert(!(dbByTokenBytes[0] === 0x1f && dbByTokenBytes[1] === 0x8b) && !dbByTokenBytes.includes(Buffer.from('SQLite format 3')),
            '7. …and nothing of one comes back');

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
        // The other standby is a legacy one too: the password alone, no owner session (post() sends one).
        resetBrakes();
        const otherRes = await fetch(base + '/api/local/admin/replication-token/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': ADMIN_PW }, body: JSON.stringify({ password: ADMIN_PW }) });
        const other = { status: otherRes.status, json: await otherRes.json().catch(() => null) as any };
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

        preStep7cPrimary = false;

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
            // The page's display logic, read with an owner's session: settings.js sends the password per request, which a
            // node with 2FA off refuses (step 7c); the session, checked first, is what gets this read in.
            fetch: (u: string, init: any) => { resetBrakes(); return fetch(u, { ...init, headers: { ...(init?.headers || {}), ...asOwner } }); },
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

        // ---------- 12. The recovery-seal key never reaches the token, nor the open door's key ----------
        {
            const sealKey = fs.readFileSync(path.join(DATA_DIR!, 'recovery-seal.key'));
            // The open door's key (services/open-join-key.ts), which travels the same way: only in the take-over bundle.
            const doorKeyFile = path.join(DATA_DIR!, 'open-join.key');
            if (!fs.existsSync(doorKeyFile)) fs.writeFileSync(doorKeyFile, crypto.randomBytes(32), { mode: 0o600 });
            const doorKey = fs.readFileSync(doorKeyFile);
            const forms = [sealKey, doorKey].flatMap((k) => [k, Buffer.from(k.toString('base64')), Buffer.from(k.toString('hex')), Buffer.from(k.toString('base64url'))]);
            const holdsKey = (b: Buffer) => forms.some((f) => b.includes(f));
            clearReplicationToken();
            setReplicationToken('token-for-the-seal-key-check');
            updateLocalConfig({ replicationTokenOnly: true });
            const answered: string[] = [];
            const leaks: string[] = [];
            for (const layer of [...(router.stack as any[]), ...(takeoverRouter.stack as any[])]) {
                for (const method of (layer.methods as string[]).filter((m) => m === 'GET' || m === 'POST')) {
                    const url = base + String(layer.path).replace(/:[A-Za-z]+/g, 'x');
                    resetBrakes();
                    const res = await fetch(url, {
                        method,
                        headers: { 'X-Replication-Token': 'token-for-the-seal-key-check', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
                        ...(method === 'POST' ? { body: JSON.stringify({ token: 'token-for-the-seal-key-check' }) } : {}),
                    });
                    const bytes = Buffer.from(await res.arrayBuffer());
                    const headerText = Buffer.from(JSON.stringify([...res.headers.entries()]));
                    if (res.status === 200) answered.push(`${method} ${layer.path}`);
                    if (holdsKey(bytes) || holdsKey(headerText)) leaks.push(`${method} ${layer.path} (${res.status})`);
                }
            }
            for (const expected of ['GET /api/local/admin/sync-snapshot', 'GET /api/local/admin/sync-delta', 'GET /api/local/admin/takeover-envelope']) {
                assert(answered.includes(expected), `12. (control) the token reaches ${expected}`);
            }
            // It reached /backup too until 2026-10-01 (step 7); a backup is an owner's now.
            assert(!answered.includes('POST /api/local/admin/backup'), '12. the token no longer reaches /backup');
            assert(leaks.length === 0, `12. no route answers the token with the recovery-seal key or the open door's key, in any form (${answered.length} answered 200; leaks: ${leaks.join(', ') || 'none'})`);
            // What an owner downloads is the sealed backup; opened with the recovery code, its bundle carries the key.
            resetBrakes();
            const dl = await fetch(base + '/api/local/admin/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', ...asOwner }, body: '{}' });
            const sealedBytes = Buffer.from(await dl.arrayBuffer());
            const tmp12 = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-seal-key-'));
            try {
                const tarPath = path.join(tmp12, 'db.tar.gz');
                fs.writeFileSync(tarPath, (await openEnvelope(new Uint8Array(sealedBytes), { type: 'code', code: recovery.code }, { kind: 'backup' })).payload);
                const bundle = JSON.parse(execFileSync('tar', ['-xzOf', tarPath, './takeover-bundle.json'], { encoding: 'utf-8' }));
                assert(bundle.files['recovery-seal.key'] === sealKey.toString('base64') && bundle.files['open-join.key'] === doorKey.toString('base64') && !holdsKey(sealedBytes),
                    '12. (control) the keys do travel, sealed: the backup an owner downloads holds none of their bytes, and opened with the recovery code its bundle carries both');
            } finally {
                fs.rmSync(tmp12, { recursive: true, force: true });
            }
            const keyInLogs = printed.filter((l) => forms.slice(1).some((f) => l.includes(f.toString())));
            assert(keyInLogs.length === 0, `12. no log line holds the recovery-seal key or the open door's key (${keyInLogs.length})`);
            updateLocalConfig({ replicationTokenOnly: false });
        }

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
