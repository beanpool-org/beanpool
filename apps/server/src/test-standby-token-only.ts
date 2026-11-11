/**
 * A standby server copies from its main server with the replication token, and nothing else.
 *
 * The node has no admin password (Marty, 11 Nov 2026). A standby used to be able to copy with the main server's admin
 * password, kept in plain text (local-config.json `backupAdminPassword`), and swapped it for a token when it could; that
 * path, the main server's token-only switch and the swap are gone. Checked here:
 *
 *   1. The copy routes refuse an admin password, and an owner's key session: a copy goes to the replication token only.
 *   2. Live Backup Server (replication-config/save) refuses the admin password, accepts a token; it asks the owner's
 *      fresh proof (design case 18 S2b): an owner's computer session is sent to the phone, nothing stored.
 *   3. A standby with no token copies nothing, whatever password an older install still holds (a stored
 *      `backupAdminPassword`, or BACKUP_ADMIN_PASSWORD in .env): no request goes out, and Settings shows no credential.
 *   4. A main server address that redirects (#1575 review) is never followed with the token, and the reason travels.
 *   5. Backup files and /api responses never carry an older standby's leftover password (the sealed backup is opened
 *      with a recovery code and every file inside it checked); the plain identity bundle is gone (404).
 *   6. Copying works end to end with a token the owner made on the main server and pasted into the standby; the copy
 *      made ready in data/staging carries no leftover password; the token gets no /backup, locked or not.
 *   7. Recovery seal S2: the replication token gets data/recovery-seal.key on no route (every backup and take-over
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
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import Database from 'better-sqlite3';
import { pinMainServerForTests, unpinMainServerForTests } from './standby-pin-test-helper.js';

/** What an older install's admin password looked like: no credential now (sections 1 to 6 send it, or leave it on disk). */
const ADMIN_PW = 'Standby-Main-Pw-7731!xq';
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

const { initStateEngine, setNodeRole, getReplicationAccessLog, seedGenesisMember } = await import('./state-engine.js');
const { mintHandshakeToken, consumeHandshakeToken, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
const { startP2P } = await import('./p2p.js');
const { addConnector, removeConnector } = await import('./connector-manager.js');
const {
    getLocalConfig, updateLocalConfig, setReplicationToken, clearReplicationToken,
} = await import('./config/local-config.js');
const { checkAdminAuth, resetAdminAuthTarpit } = await import('./admin-auth.js');
const { resetPasswordBrake } = await import('./password-brake.js');
const { createBackupRoutes } = await import('./routes/backup.js');
const { requestResync, getBackupStatus } = await import('./services/backup-puller.js');
const { readCopyRecord, standbyReport, whyOf } = await import('./services/standby-copy-record.js');
const { whyInWords, parseStandbyReport, standbyReportHeader, LEDGER_DIFFERS, STANDBY_REPORT_MAX_CHARS, MAX_TABLES_NAMED } = await import('./services/standby-report.js');
const { TABLES } = await import('./engine/replication-manifest.js');

/**
 * parseStandbyReport as main servers up to v1.2.27 run it (git show v1.2.27:apps/server/src/services/standby-report.ts),
 * copied as it was: a report one of them can't read is ignored whole, and its standby looks silent.
 */
function parseStandbyReportV1_2_27(raw: unknown): Record<string, unknown> | null {
    const WHY = /^(conservation|signature|oversized|import-error|timeout|network|unparseable|http-[1-5]\d\d)$/;
    const MAX_AGE_MS = 10 * 365 * 24 * 3600_000;
    const MAX_DIFFERS = 40;
    const tableName = (name: unknown): name is string => {
        if (typeof name !== 'string') return false;
        const entry = Object.prototype.hasOwnProperty.call(TABLES, name) ? TABLES[name] : undefined;
        return !!entry && (entry.kind === 'replicated' || entry.kind === 'replicated-except');
    };
    const differsName = (name: unknown): name is string => {
        if (typeof name !== 'string') return false;
        if ((Object.values(LEDGER_DIFFERS) as string[]).includes(name)) return true;
        return tableName(name);
    };
    const tablesOf = (v: unknown): string[] | null => {
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.length > MAX_TABLES_NAMED || !v.every(tableName)) return null;
        return [...new Set<string>(v)];
    };
    const age = (v: unknown): v is number | null => v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_AGE_MS);
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > STANDBY_REPORT_MAX_CHARS) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const r = parsed as Record<string, unknown>;
    if (r.v !== 1) return null;
    if (typeof r.id !== 'string' || !/^[0-9a-f]{32}$/.test(r.id)) return null;
    const last = r.last;
    if (last !== 'ok' && last !== 'refused' && last !== 'fetch-failed' && last !== 'none') return null;
    if (!(r.why === null || (typeof r.why === 'string' && WHY.test(r.why)))) return null;
    const fails = r.fails;
    if (typeof fails !== 'number' || !Number.isInteger(fails) || fails < 0 || fails > 1_000_000) return null;
    const { okAgo, wholeAgo, exactAgo, exact, differs, hashed, healing } = r;
    if (!age(okAgo) || !age(wholeAgo) || !age(exactAgo)) return null;
    if (!(exact === null || typeof exact === 'boolean')) return null;
    if (!Array.isArray(differs) || differs.length > MAX_DIFFERS || !differs.every(differsName)) return null;
    if (typeof hashed !== 'boolean' || typeof healing !== 'boolean') return null;
    const leftOut = tablesOf(r.leftOut);
    const oversized = tablesOf(r.oversized);
    if (!leftOut || !oversized) return null;
    return {
        v: 1, id: r.id, last, why: r.why, fails, okAgo, wholeAgo,
        exact, exactAgo, differs: [...new Set<string>(differs)], hashed, healing: exact === false && healing, leftOut, oversized,
    };
}
const { RedirectRefusedError } = await import('./services/credential-redirect.js');
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
    initStateEngine();
    const node = await startP2P(0, 0);
    const nodeId = node.peerId.toString();
    const mirrorAddr = `/ip4/127.0.0.1/tcp/4063/p2p/${nodeId}`;
    pinMainServerForTests(mirrorAddr);

    // The main server's backup routes over real HTTP, parsed the way https-server.ts does, with checkAdminAuth as
    // https-server.ts hands it over.
    const routeDeps = {
        checkAdminAuth,
        rateLimit: () => true,
        clampLimit: (_v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    } as any;
    const router = createBackupRoutes(routeDeps);
    // Settings' own calls in this suite come from the owner's key session: the way an owner signs in, and this suite is
    // about the standby's credential, not the owner's sign-in.
    const ownerPk = crypto.randomBytes(32).toString('hex');
    seedGenesisMember(ownerPk, 'Owner');
    const signedIn = consumeHandshakeToken(mintHandshakeToken(ownerPk, 'owner').handshakeToken);
    if (!signedIn.ok || !signedIn.sessionId) throw new Error(`setup: no owner session: ${signedIn.error}`);
    const asOwner = { 'x-admin-session': signedIn.sessionId };
    // The take-over envelope's routes too (the token fetches the envelope from one of them): section 7.
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
    const cfgPath = path.join(DATA_DIR!, 'local-config.json');
    const configOnDisk = () => (fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf-8') : '');

    try {
        // ---------- 1. The copy routes take the replication token, and nothing else ----------
        resetBrakes();
        const refusedBefore = getReplicationAccessLog().totalRejected;
        const pwPull = await fetch(`${base}/api/local/admin/sync-snapshot`, { headers: { 'X-Admin-Password': ADMIN_PW } });
        const pwPullBody = await pwPull.json().catch(() => null) as any;
        assert(pwPull.status === 401 && pwPullBody?.error === 'Replication token required',
            `1. the main server refuses a snapshot pull with an admin password: 401, a replication token is required (got ${pwPull.status} ${JSON.stringify(pwPullBody)})`);
        resetBrakes();
        const sessionPull = await fetch(`${base}/api/local/admin/sync-snapshot`, { headers: asOwner });
        assert(sessionPull.status === 401, `1. …and with an owner's key session: a copy goes to the standby's token only (got ${sessionPull.status})`);
        const accessLog1 = getReplicationAccessLog();
        assert(accessLog1.totalRejected === refusedBefore + 2 && accessLog1.recent[0]?.reason === 'replication token required',
            `1. both are logged for Replication Access as refused, a replication token required (${JSON.stringify(accessLog1.recent[0])})`);

        setNodeRole('backup');

        // ---------- 2. Live Backup Server route ----------
        // Which server a standby copies from is a fresh proof's: the owner's phone, Manage pressed just now.
        const fromPhone = (): Record<string, string> => {
            const s = consumeHandshakeToken(mintHandshakeToken(ownerPk, 'owner').handshakeToken, Date.now(), { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS });
            if (!s.ok || !s.sessionId) throw new Error(`setup: no phone session: ${s.error}`);
            return { 'x-admin-session': s.sessionId };
        };
        const fromComputer = await post('/api/local/admin/replication-config/save', { primaryUrl: base, primaryToken: 'a-pasted-token' });
        assert(fromComputer.status === 403 && fromComputer.json?.code === 'phone_required' && !getLocalConfig().backupReplicationToken,
            `2. from the owner's computer it is sent to the phone, nothing stored (${fromComputer.status})`);
        const refused = await post('/api/local/admin/replication-config/save', { primaryUrl: base, primaryPassword: ADMIN_PW }, fromPhone());
        assert(refused.status === 400, '2. saving the main server admin password is refused (400)');
        assert(/replication token/i.test(refused.json?.error || ''), '2. the refusal says to use a replication token');
        assert(!configOnDisk().includes(ADMIN_PW) && !getLocalConfig().backupReplicationToken, '2. nothing was stored');
        const accepted = await post('/api/local/admin/replication-config/save', { primaryUrl: base, primaryToken: 'a-pasted-token' }, fromPhone());
        assert(accepted.status === 200 && accepted.json?.success && accepted.json?.credential?.using === 'token', '2. saving a token is accepted, and the standby copies with it');
        assert(getLocalConfig().backupReplicationToken === 'a-pasted-token', '2. the token is stored');
        const cleared = await post('/api/local/admin/replication-config/save', { primaryUrl: base, primaryToken: '' }, fromPhone());
        assert(!getLocalConfig().backupReplicationToken && cleared.json?.credential?.using === 'none', '2. an empty token clears it: nothing left to copy with');

        // ---------- 3. No token, no copy: a password an older install still holds is never sent ----------
        // What an older standby's local-config.json and .env may still hold: nothing reads either (no code converts or
        // deletes them; deleting them is the operator's hand step).
        updateLocalConfig({ backupAdminPassword: ADMIN_PW } as any);
        updateLocalConfig({ backupPrimaryUrl: base, backupReplicationToken: null });
        process.env.BACKUP_ADMIN_PASSWORD = ADMIN_PW;
        try {
            const accessBefore = getReplicationAccessLog();
            const noToken = await requestResync();
            assert(!noToken.ok && /replication token/.test(noToken.error || ''),
                `3. a standby with no token does not copy, and says it needs a replication token (${noToken.error || 'ok'})`);
            const accessAfter = getReplicationAccessLog();
            assert(accessAfter.totalPulls === accessBefore.totalPulls && accessAfter.totalRejected === accessBefore.totalRejected,
                '3. …and sends the main server nothing: no pull and no refused attempt');
            const cred = await post('/api/local/admin/replication-config/get', {});
            assert(cred.status === 200 && cred.json?.credential?.using === 'none' && cred.json?.hasToken === false && !('hasPassword' in (cred.json || {})),
                `3. Settings (replication-config/get) shows no credential to copy with, and no password (${cred.text})`);
            assert(!cred.text.includes(ADMIN_PW), '3. …nor the password itself');
        } finally {
            delete process.env.BACKUP_ADMIN_PASSWORD;
        }

        // ---------- 4. A main server address that redirects (#1575 review): never followed with the token ----------
        {
            const elsewhereSeen: { method: string; path: string; password: boolean; token: boolean }[] = [];
            // What the redirecting address itself was sent: the token, never the leftover password section 3 left on disk.
            const redirectSeen: { password: boolean; token: boolean }[] = [];
            const elsewhere = http.createServer((req, res) => {
                elsewhereSeen.push({ method: req.method || '', path: req.url || '', password: 'x-admin-password' in req.headers, token: 'x-replication-token' in req.headers });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
            });
            await new Promise<void>(r => elsewhere.listen(0, '127.0.0.1', () => r()));
            const elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;
            let code = 302;
            const redirecting = http.createServer((req, res) => {
                redirectSeen.push({ password: 'x-admin-password' in req.headers, token: 'x-replication-token' in req.headers });
                res.writeHead(code, { Location: `${elsewhereUrl}${req.url}` });
                res.end();
            });
            await new Promise<void>(r => redirecting.listen(0, '127.0.0.1', () => r()));
            const redirectingUrl = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`;
            const elsewhereHost = (elsewhere.address() as AddressInfo).port ? `127.0.0.1:${(elsewhere.address() as AddressInfo).port}` : new URL(elsewhereUrl).host;
            try {
                for (const status of [302, 307, 308]) {
                    code = status;
                    // The copy sends the token.
                    updateLocalConfig({ backupPrimaryUrl: redirectingUrl, backupReplicationToken: 'redirect-test-token' });
                    const tokCopy = await requestResync();
                    assert(!tokCopy.ok && (tokCopy.error || '').includes(`answered HTTP ${status}, a redirect to ${elsewhereUrl}/api/local/admin/sync-copy.`)
                        && !(tokCopy.error || '').includes('redirect-test-token'),
                        `4. a ${status} on a token copy is not followed, and the error names where it pointed (got: ${tokCopy.error})`);
                    assert(readCopyRecord().lastWhy === `redirect:${elsewhereHost}`,
                        `4. a ${status} token copy codes lastWhy as 'redirect' with host (${readCopyRecord().lastWhy})`);
                    assert(standbyReport().why === `redirect:${elsewhereHost}`,
                        `4. a ${status} token standby report carries why 'redirect' with host (${standbyReport().why})`);
                }
                assert(elsewhereSeen.length === 0, `4. the other origin received nothing: no password, no token, no request (got ${JSON.stringify(elsewhereSeen)})`);
                assert(redirectSeen.length >= 3 && redirectSeen.every(r => r.token && !r.password),
                    `4. the copy sent the redirecting address its token alone, never the leftover password (got ${JSON.stringify(redirectSeen)})`);

                // Mixed versions: the header this standby sends after a refused redirect.
                const header = standbyReportHeader(standbyReport());
                const oldReads = parseStandbyReportV1_2_27(header);
                assert(oldReads !== null && oldReads.why === 'network' && oldReads.last === 'refused',
                    `4. a main server on v1.2.27 still reads the report, and is told 'network' as before (got ${JSON.stringify(oldReads)} from ${header})`);
                const newReads = parseStandbyReport(header);
                assert(newReads?.why === `redirect:${elsewhereHost}` && whyInWords(newReads.why) === `the standby's address redirects to ${elsewhereHost}: point it at the server itself`,
                    `4. a main server with the redirect codes reads 'redirect' and the host (got ${newReads?.why})`);
                const unknownWhy = parseStandbyReport(JSON.stringify({ ...JSON.parse(header), why: 'a-code-from-later', whyDetail: undefined }));
                assert(unknownWhy !== null && unknownWhy.why === null && unknownWhy.last === 'refused',
                    `4. a reason this server doesn't know reads as none; the report is kept (got ${JSON.stringify(unknownWhy)})`);
                const unknownDetail = parseStandbyReport(JSON.stringify({ ...JSON.parse(header), whyDetail: 'call +61 555 0100' }));
                assert(unknownDetail?.why === 'network', `4. a whyDetail that is no code is passed over for why (got ${unknownDetail?.why})`);
                const longHost = `redirect:${'h'.repeat(250)}.example`;
                const ten = Array(10).fill('conversation_participants');
                const crowdedReport = { ...standbyReport(), why: longHost as any, differs: Array(40).fill('conversation_participants'), leftOut: ten, oversized: ten };
                const crowded = standbyReportHeader(crowdedReport);
                assert(JSON.stringify({ ...crowdedReport, why: 'network', whyDetail: longHost }).length > STANDBY_REPORT_MAX_CHARS
                    && crowded.length <= STANDBY_REPORT_MAX_CHARS && !crowded.includes('whyDetail') && JSON.parse(crowded).why === 'network',
                    `4. whyDetail is left out rather than push a report past the length any main server reads (${crowded.length})`);

                // Connection refused: still coded as 'network', never 'redirect'.
                const dummy = http.createServer();
                await new Promise<void>(r => dummy.listen(0, '127.0.0.1', () => r()));
                const closedPort = (dummy.address() as AddressInfo).port;
                await new Promise<void>(r => dummy.close(() => r()));
                updateLocalConfig({ backupPrimaryUrl: `http://127.0.0.1:${closedPort}`, backupReplicationToken: 'network-test-token' });
                const netCopy = await requestResync();
                assert(!netCopy.ok, '4. copy to a closed port fails');
                assert(readCopyRecord().lastWhy === 'network', `4. refused connection still codes lastWhy as 'network' (got: ${readCopyRecord().lastWhy})`);
                assert(standbyReport().why === 'network', `4. standby report carries 'network' for refused connection (got: ${standbyReport().why})`);

                // Direct tests for whyOf: a refused redirect is known by its type, never by its message's words.
                const toOther = 'http://127.0.0.1:1111 answered HTTP 302, a redirect to https://other.example/api/sync-copy. It was not followed: no credential was sent there and nothing from it was read. Set the address the node answers on itself.';
                assert(whyOf('fetch', new RedirectRefusedError(toOther, 'other.example')) === 'redirect:other.example',
                    "4. whyOf codes redirect to other.example with host only");
                assert(whyOf('fetch', new RedirectRefusedError('http://127.0.0.1:1111 answered HTTP 302, a redirect to no address. It was not followed: no credential was sent there and nothing from it was read. Set the address the node answers on itself.', null)) === 'redirect',
                    "4. whyOf codes redirect to no address as 'redirect'");
                assert(whyOf('fetch', new RedirectRefusedError(toOther, 'bad host/with "quotes"')) === 'redirect',
                    "4. whyOf codes a redirect whose host no code can carry as 'redirect'");
                assert(whyOf('fetch', new Error(toOther)) === 'network',
                    "4. whyOf does not read a plain error's words as a redirect");
                assert(whyOf('fetch', new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:1234')) === 'network',
                    "4. whyOf codes connection failure as 'network'");
                assert(whyOf('fetch', Object.assign(new Error('timeout'), { name: 'AbortError' })) === 'timeout',
                    "4. whyOf codes AbortError as 'timeout'");

                // Direct tests for whyInWords:
                assert(whyInWords('redirect:other.example') === "the standby's address redirects to other.example: point it at the server itself",
                    "4. whyInWords formats redirect:other.example naming host only");
                assert(whyInWords('redirect') === "the standby's address redirects: point it at the server itself",
                    "4. whyInWords formats redirect without host");
                assert(whyInWords('network') === "the main server could not be reached",
                    "4. whyInWords formats network reason");
            } finally {
                await new Promise<void>(r => redirecting.close(() => r()));
                await new Promise<void>(r => elsewhere.close(() => r()));
                updateLocalConfig({ backupPrimaryUrl: base, backupReplicationToken: null });
                resetBrakes();
            }
        }

        // ---------- 5. Backup files and API responses ----------
        // The leftover password from section 3 is still in local-config.json (never converted): no backup file carries it.
        fs.writeFileSync(path.join(DATA_DIR!, 'genesis.json'), JSON.stringify({ communityId: 'standby-test' }));
        if (!fs.existsSync(path.join(DATA_DIR!, 'community.key'))) fs.writeFileSync(path.join(DATA_DIR!, 'community.key'), 'test-key');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-bundles-'));
        // Backups are sealed (sealed-keys slice 3): the node needs someone to lock them to, and this check opens the
        // file to look inside it — the database, node_config.json and the take-over bundle with the node keys.
        const recovery = await makeRecoveryCode({ replace: true });
        {
            assert(configOnDisk().includes(ADMIN_PW), "5. (control) this server's own local-config.json still holds the leftover password");
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
            assert(filesContaining(out, ADMIN_PW).length === 0, '5. the db backup file does not contain the leftover password (every file in it, the bundle included)');
            assert(!fs.readFileSync(tarPath).includes(Buffer.from(ADMIN_PW)), '5. nor does the db archive itself');
            assert(!sealed.includes(Buffer.from(ADMIN_PW)), '5. nor the sealed file');
        }
        resetBrakes();
        const idGone = await fetch(base + '/api/local/admin/identity-bundle', { method: 'POST', headers: { 'Content-Type': 'application/json', ...asOwner }, body: JSON.stringify({}) });
        assert(idGone.status === 404, `5. the plain identity bundle is gone: 404 even to an owner (got ${idGone.status})`);
        fs.rmSync(tmp, { recursive: true, force: true });
        for (const p of ['/api/local/admin/replication-config/get', '/api/local/admin/backup-status', '/api/local/admin/replication-token/status', '/api/local/admin/replication-access']) {
            const r = await post(p, {});
            assert(r.status === 200 && !r.text.includes(ADMIN_PW), `5. ${p} never returns the leftover password`);
        }

        // ---------- 6. Copying end to end with the token ----------
        // As an owner sets a standby up: a token made on the main server (Replication Access), pasted into the standby's
        // Live Backup Server. One process plays both here.
        const made = await post('/api/local/admin/replication-token/generate', {});
        assert(made.status === 200 && typeof made.json?.token === 'string' && made.json.token.length >= 32,
            `6. the main server makes a replication token for its owner (${made.status})`);
        const standbyToken = made.json?.token as string;
        const pasted = await post('/api/local/admin/replication-config/save', { primaryUrl: base, primaryToken: standbyToken }, fromPhone());
        assert(pasted.status === 200 && getLocalConfig().backupReplicationToken === standbyToken && pasted.json?.credential?.using === 'token',
            `6. …and the standby keeps it from Live Backup Server (${pasted.status})`);
        const memberCount = () => (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c;
        const accountCount = () => (db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c;
        const before = { m: memberCount(), a: accountCount() };
        const pulled = await requestResync();
        assert(pulled.ok, `6. a full copy with the token succeeds (${pulled.error || 'ok'})`);
        assert(getReplicationAccessLog().lastPullAuth === 'token', '6. the main server logged a token pull');
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
            `6. the copy, made ready in data/staging for the next start, holds the same members and accounts (${JSON.stringify({ staged, before })})`);
        assert(!!getBackupStatus().lastSuccessAt, '6. the standby records a successful pull');
        // The stager's copy of local-config.json leaves the standby's credentials out (services/stager.ts), an older
        // install's leftover password with them: data/staging holds none of it while the live file still does.
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
        const stagingHits = filesContaining(path.join(DATA_DIR!, 'staging'), ADMIN_PW);
        assert(fs.existsSync(path.join(DATA_DIR!, 'staging', 'local-config.json')) && stagingHits.length === 0 && configOnDisk().includes(ADMIN_PW),
            `6. the copy made ready in data/staging carries no leftover password, its local-config.json included${stagingHits.length ? ' — found in ' + stagingHits.join(', ') : ''}`);
        // The standby's token copies the database, never the node keys (sealed-keys slice 0).
        // Since sealed backups (slice 3) the plain identity bundle is gone for every credential, and what the token
        // downloads is the sealed backup: ciphertext, with the keys inside only the owners and the code can open.
        resetBrakes();
        const idByToken = await fetch(base + '/api/local/admin/identity-bundle', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Replication-Token': standbyToken }, body: '{}' });
        const idByTokenBody = Buffer.from(await idByToken.arrayBuffer());
        assert(idByToken.status === 404 && !idByToken.headers.get('x-identity-files'), `6. the token gets no identity bundle: the route is gone (got ${idByToken.status})`);
        assert(!(idByTokenBody[0] === 0x1f && idByTokenBody[1] === 0x8b), '6. …and nothing gzip comes back');
        // Nor any backup. This step asserted the token downloaded the sealed one; on a server with no recovery code the
        // same call sent the readable database, tunnel token, admin hash and 2FA secret with it (Fable's replication
        // review HIGH-1, 2026-10-01). The token now copies and fetches the take-over envelope, and nothing else: /backup
        // is an owner's, locked or not (test-backup-owner-gate sweeps every route).
        resetBrakes();
        const dbByToken = await fetch(base + '/api/local/admin/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Replication-Token': standbyToken }, body: '{}' });
        const dbByTokenBytes = Buffer.from(await dbByToken.arrayBuffer());
        assert(dbByToken.status === 401 && dbByToken.headers.get('content-type') !== 'application/octet-stream',
            `6. the token downloads no backup, locked or not (got ${dbByToken.status})`);
        assert(!(dbByTokenBytes[0] === 0x1f && dbByTokenBytes[1] === 0x8b) && !dbByTokenBytes.includes(Buffer.from('SQLite format 3')),
            '6. …and nothing of one comes back');

        // ---------- 7. The recovery-seal key never reaches the token, nor the open door's key ----------
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
                assert(answered.includes(expected), `7. (control) the token reaches ${expected}`);
            }
            // It reached /backup too until 2026-10-01 (section 6); a backup is an owner's now.
            assert(!answered.includes('POST /api/local/admin/backup'), '7. the token no longer reaches /backup');
            assert(leaks.length === 0, `7. no route answers the token with the recovery-seal key or the open door's key, in any form (${answered.length} answered 200; leaks: ${leaks.join(', ') || 'none'})`);
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
                    '7. (control) the keys do travel, sealed: the backup an owner downloads holds none of their bytes, and opened with the recovery code its bundle carries both');
            } finally {
                fs.rmSync(tmp12, { recursive: true, force: true });
            }
            const keyInLogs = printed.filter((l) => forms.slice(1).some((f) => l.includes(f.toString())));
            assert(keyInLogs.length === 0, `7. no log line holds the recovery-seal key or the open door's key (${keyInLogs.length})`);
        }

        // ---------- Logs ----------
        const leaked = printed.filter(l => l.includes(ADMIN_PW));
        assert(leaked.length === 0, `logs never contain the password${leaked.length ? ' — ' + leaked.length + ' line(s)' : ''}`);
    } finally {
        unpinMainServerForTests();
        server.close();
        await node.stop();
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Standby token-only checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e?.message || e); process.exit(1); });
