/**
 * Test Suite: a community server keeps nobody's internet address longer than 7 days, and its logs never record one
 * (the privacy policy's words; found by #1283's deciding review, inline 4123829044).
 *
 *  1. The copying routes over real HTTP, from made-up internet addresses (a local proxy's CF-Connecting-IP, as the
 *     tunnel sends it): a pull with no credentials, one with a wrong token, one with a wrong admin password and one
 *     from an IPv6 address (all refused); a token pull (allowed); a standby's pull that reports three refused copies (an
 *     incident for the owners); a take-over envelope fetch with the token; and a standby fetching the take-over keys.
 *     Within the 7 days the owner sees each fresh address (the Replication Access route, node Settings' panel, the
 *     standby banner, the take-over keys' holders).
 *  2. Wrong admin passwords from one address, past the free ones, and from an IPv6 /64: the brake still says wait. A
 *     proxy that forwards for others without being trusted is warned about, and so is the brake it shares. A gateway
 *     429. Every one of those log lines names the address only by its daily keyed hash, and the brake's names the
 *     same source each time.
 *     Then: no made-up address in system_logs or in anything the node printed (stdout and stderr, Docker's log).
 *  3. A log line with addresses in its text (the net under every line): both kinds redacted, in the table and in stdout.
 *  4. Six days on, nothing is forgotten yet. Seven days on (the sweep, run with the clock moved): no address in
 *     node_config; each entry keeps its time and outcome; the owner's screens say "address no longer kept".
 *  5. Day zero: rows as an older version wrote them (addresses 8 to 30 days old, and fresh ones), and a log line
 *     with an address from before this version. The first boot's sweep clears the old ones and every address in the
 *     old log line, keeps the fresh ones, and the hourly timer clears one that comes of age later.
 *  6. A snapshot (writeDbSnapshot makes every snapshot and backup) holds no address, even a fresh one, read through
 *     SQL or in the file's bytes (its free space included); nor the sign-up and knock limiters' address hashes, whose
 *     key is in the same file; the live database keeps its fresh address and its hashes; nothing is left beside the
 *     file. A snapshot made before this version (a plain copy, addresses in it), downloaded as a backup: the backup's
 *     database holds none, in its bytes either.
 *  6b. Copies already on disk from before this version: a snapshot holding addresses of any age, hashes and main's log
 *     at its 2,500-line cap (1 line in 10 names an address, IPv4 or IPv6, as main wrote them), the same database as a
 *     fleet harvester's latest and daily copies of a server, a clean snapshot, and a twin a crash left. The boot run
 *     takes every address out of each (bytes too: a page's gap keeps none), keeps each file's name, mode and mtime (so
 *     the snapshot list and its rotation are unchanged) and every log line, removes the twin, and leaves the clean one
 *     unread and unwritten; a second boot rewrites nothing. The same old snapshot downloaded as a readable backup and
 *     as a locked one (opened with the recovery code): neither backup's database holds an address, in its bytes either.
 *  7. The daily hash: the same address, the same tag all day; another address, another tag; the next day, another tag.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-address-retention.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import Database from 'better-sqlite3';

const ADMIN_PW = 'Address-Retention-Pw-5528!q';
process.env.ADMIN_PASSWORD = ADMIN_PW;
delete process.env.TRUSTED_PROXIES;

const DATA_DIR = process.env.BEANPOOL_DATA_DIR;
if (!DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

// Everything the node prints, stdout and stderr: Docker's log. This suite's own lines (which name the made-up
// addresses) go around it, straight to the terminal.
const rawOut = process.stdout.write.bind(process.stdout) as (s: string) => boolean;
const rawErr = process.stderr.write.bind(process.stderr) as (s: string) => boolean;
const say = (line: string) => rawOut(`${line}\n`);
const printed: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...a: any[]) => boolean;
    (stream as any).write = (chunk: any, ...rest: any[]) => {
        printed.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return write(chunk, ...rest);
    };
}

const { initStateEngine } = await import('./state-engine.js');
const { setNodeRole } = await import('./config/node-role.js');
const { startP2P } = await import('./p2p.js');
const { initAdminPassword, setReplicationToken, updateLocalConfig } = await import('./config/local-config.js');
const { checkAdminAuth, resetAdminAuthTarpit } = await import('./admin-auth.js');
const { checkAdminPassword, notePasswordFailure, acquirePasswordAttempt, settlePasswordAttempt, resetPasswordBrake } = await import('./password-brake.js');
const { resolveClientIp, resetUntrustedForwardersForTests } = await import('./client-ip.js');
const { gatewayAdmit, resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
const { createBackupRoutes } = await import('./routes/backup.js');
const { createTakeoverEnvelopeRoutes } = await import('./routes/takeover-envelope.js');
const { getStandbyHealthBanner } = await import('./services/standby-health.js');
const { noteEnvelopeFetch, getEnvelopeHolders, makeRecoveryCode } = await import('./services/takeover-envelope.js');
const { writeDbSnapshot } = await import('./services/snapshot-scheduler.js');
const { createPlainBackup, createSealedBackup } = await import('./services/sealed-backup.js');
const { ensureGenesis } = await import('./genesis.js');
const { openEnvelope } = await import('@beanpool/core');
const { logger } = await import('./logger.js');
const { db } = await import('./db/db.js');
// This change's own modules: absent on a build from before it, where the checks that need them fail instead of crashing.
const retention = await import('./services/address-retention.js').catch(() => null) as null | {
    forgetOldAddresses(now?: number): number; startForgettingOldAddresses(everyMs?: number): Promise<number> | void;
};
const { listSnapshots } = await import('./services/snapshot-scheduler.js');
const { openJoinAddressHash, knockAddressHash } = await import('./engine/open-join.js');
const logTag = await import('./log-address.js').catch(() => null) as null | { logAddressTag(key: string, now?: number): string };

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; say(`✓ ${msg}`); } else { rawErr(`✗ ${msg}\n`); }
}

const DAY = 24 * 60 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every made-up address used here: TEST-NET-3, TEST-NET-2 and the IPv6 documentation prefix. None is anyone's. */
const MADE_UP = /203\.0\.113\.\d{1,3}|198\.51\.100\.\d{1,3}|2001:db8:/i;
const addressesIn = (text: string) => [...new Set(text.match(new RegExp(MADE_UP.source, 'gi')) ?? [])];
const logText = () => (db.prepare(`SELECT group_concat(message || ' ' || COALESCE(metadata, ''), '\n') AS t FROM system_logs`).get() as { t: string | null }).t ?? '';
const configRow = (key: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '';
const ADDRESS_ROWS = ['replication_access', 'standby_health', 'takeover_envelope_holders'];
const addressRowsText = () => ADDRESS_ROWS.map(configRow).join('\n');
/** A file's bytes as text, free pages and freed cells included: what `strings` on it would find. */
const bytesOf = (file: string) => fs.readFileSync(file).toString('latin1');
/** The two limiters' address hashes, as the rows of `conn` hold them. */
const addressHashes = (conn: Database.Database) => (conn.prepare(
    "SELECT ip_hash FROM open_joins WHERE ip_hash IS NOT NULL UNION ALL SELECT ip_hash FROM join_requests WHERE ip_hash IS NOT NULL",
).all() as { ip_hash: string }[]).map((r) => r.ip_hash);
const resetBrakes = () => { resetAdminAuthTarpit(); resetPasswordBrake(); };

/** A report from a standby whose last three copies were refused: the owners' incident opens on it. */
const STANDBY_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const refusedReport = JSON.stringify({
    v: 1, id: STANDBY_ID, last: 'refused', why: 'conservation', fails: 3, okAgo: 5 * 60_000, wholeAgo: null,
    exact: null, exactAgo: null, differs: [], hashed: false, healing: false,
});

async function main() {
    initAdminPassword();
    updateLocalConfig({ replicationTokenOnly: false }); // a wrong admin password is still tried, so it is refused as one
    setNodeRole('primary');
    initStateEngine();
    const node = await startP2P(0, 0);
    const TOKEN = 'address-retention-replication-token';
    setReplicationToken(TOKEN);

    const deps = {
        checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
        rateLimit: () => true, clampLimit: (_v: unknown, d = 20) => d, clampOffset: () => 0,
        activeConnections: new Map(), calculateAnalytics: () => ({}), enforceReadAuth: false,
    } as any;
    const app = new Koa();
    app.use(async (ctx, next) => {
        if (ctx.method === 'POST') {
            const raw = await new Promise<string>((resolve) => { let s = ''; ctx.req.on('data', (c) => { s += c; }); ctx.req.on('end', () => resolve(s)); });
            try { (ctx as any).requestBody = raw ? JSON.parse(raw) : {}; } catch { (ctx as any).requestBody = {}; }
        } else {
            (ctx as any).requestBody = {};
        }
        await next();
    });
    app.use(createBackupRoutes(deps).routes());
    app.use(createTakeoverEnvelopeRoutes(deps).routes());
    const server = http.createServer(app.callback());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    /** A request as the tunnel hands it over: from this machine, naming the real client. */
    const from = (ip: string, headers: Record<string, string> = {}) => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': ip, ...headers });
    const get = async (p: string, headers: Record<string, string>) => {
        resetBrakes();
        const res = await fetch(base + p, { headers });
        await res.arrayBuffer();
        return res.status;
    };
    const ownerList = async () => {
        const res = await fetch(`${base}/api/local/admin/replication-access`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Replication-Token': TOKEN }, body: '{}',
        });
        return res.json() as Promise<any>;
    };

    // node Settings' Replication Access panel (static/settings.js), run against the real route.
    const settingsSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'static', 'settings.js'), 'utf-8');
    const start = settingsSrc.indexOf('async function loadReplicationAccess()');
    let depth = 0, end = settingsSrc.indexOf('{', start);
    for (let i = end; i < settingsSrc.length; i++) {
        if (settingsSrc[i] === '{') depth++;
        else if (settingsSrc[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const els: Record<string, any> = {};
    for (const id of ['rep-token-state', 'rep-token-only', 'rep-token-only-notice', 'rep-last-pull', 'rep-total-pulls', 'rep-rejected', 'rep-recent']) {
        els[id] = { textContent: '', innerHTML: '', style: {}, checked: false };
    }
    const settingsCtx = vm.createContext({
        API: `${base}/api/local`, authToken: ADMIN_PW, relativeTime: () => 'now', JSON,
        fetch: (u: string, init: any) => { resetBrakes(); return fetch(u, init); },
        document: { getElementById: (id: string) => els[id] || null, createElement: () => ({ style: {} }) },
    });
    vm.runInContext(settingsSrc.slice(start, end) + '\nthis.loadReplicationAccess = loadReplicationAccess;', settingsCtx);
    const settingsPanel = async () => {
        await settingsCtx.loadReplicationAccess();
        return `${els['rep-last-pull'].textContent}\n${els['rep-recent'].innerHTML}`;
    };

    try {
        // ── 1. The copying routes ──
        say('\n— 1. pulls and refusals from made-up addresses —');
        assert(await get('/api/local/admin/sync-snapshot', from('203.0.113.10')) === 401, '1. a pull with no credentials is refused');
        assert(await get('/api/local/admin/sync-delta', from('203.0.113.11', { 'X-Replication-Token': 'not-the-token' })) === 401, '1. a pull with a wrong token is refused');
        assert(await get('/api/local/admin/sync-snapshot', from('203.0.113.12', { 'X-Admin-Password': 'not-the-password' })) === 401, '1. a pull with a wrong admin password is refused');
        assert(await get('/api/local/admin/sync-delta', from('2001:db8:1:2::abcd')) === 401, '1. a pull from an IPv6 address with no credentials is refused');
        assert(await get('/api/local/admin/sync-snapshot', from('203.0.113.20', { 'X-Replication-Token': TOKEN })) === 200, '1. a token pull is allowed');
        assert(await get('/api/local/admin/sync-delta', from('203.0.113.30', { 'X-Replication-Token': TOKEN, 'X-Standby-Report': refusedReport })) === 200,
            "1. a standby's pull, reporting three refused copies, is allowed");
        const envelope = await get('/api/local/admin/takeover-envelope', from('203.0.113.40', { 'X-Replication-Token': TOKEN }));
        assert(envelope === 404 || envelope === 200, `1. a take-over envelope fetch with the token is answered (${envelope})`);
        noteEnvelopeFetch('203.0.113.31', 'env-address-retention-1', '2026-09-29T00:00:00.000Z', 'sent');

        const fresh = await ownerList();
        assert(fresh.lastPullIp === '203.0.113.40' && fresh.lastRejectedIp === '2001:db8:1:2::abcd',
            `1. within 7 days the owner sees the last pull's and the last refusal's address (${fresh.lastPullIp}, ${fresh.lastRejectedIp})`);
        const recentIps = (fresh.recent ?? []).map((e: any) => e.ip);
        assert(['203.0.113.10', '203.0.113.11', '203.0.113.12', '2001:db8:1:2::abcd', '203.0.113.20', '203.0.113.30', '203.0.113.40'].every((ip) => recentIps.includes(ip)),
            `1. …and each recent pull's (${recentIps.join(', ')})`);
        const panel = await settingsPanel();
        assert(panel.includes('203.0.113.40') && panel.includes('2001:db8:1:2::abcd'), "1. node Settings' Replication Access panel shows them");
        const banner = getStandbyHealthBanner();
        assert(banner.incident !== null && banner.standbys.some((s) => s.label === 'The standby at 203.0.113.30'),
            `1. the standby banner names the standby by its address (${banner.standbys.map((s) => s.label).join(', ')})`);
        const holder = getEnvelopeHolders().find((h) => h.envelopeId === 'env-address-retention-1');
        assert(!!holder && holder.message.startsWith('The standby at 203.0.113.31'), `1. the take-over keys' holders name it by its address ("${holder?.message}")`);

        // ── 2. The password brake, an untrusted proxy, the gateway ──
        say('\n— 2. wrong admin passwords, an untrusted proxy, a gateway 429 —');
        resetBrakes();
        resetUntrustedForwardersForTests();
        const ctxFrom = (ip: string) => ({ state: {}, ip, headers: {}, set: () => { }, get: () => '' });
        const results: string[] = [];
        for (let i = 0; i < 7; i++) results.push(await checkAdminPassword(ctxFrom('203.0.113.50'), 'wrong-password'));
        assert(results.slice(0, 6).every((r) => r === 'wrong') && results[6] === 'braked',
            `2. six wrong admin passwords from one address, then the brake makes it wait (${results.join(', ')})`);
        const v6 = await acquirePasswordAttempt('2001:db8:5:6::/64');
        if (v6.admitted) settlePasswordAttempt('2001:db8:5:6::/64', false);
        for (let i = 0; i < 6; i++) notePasswordFailure('2001:db8:5:6::/64');
        const v6After = await acquirePasswordAttempt('2001:db8:5:6::/64');
        assert(!v6After.admitted, '2. …and so it does for an IPv6 /64');
        const brakeLines = logText().split('\n').filter((l) => l.includes('[password-brake]') && l.includes('wrong admin passwords from'));
        assert(brakeLines.length >= 2, `2. the brake logged each source once (${brakeLines.length})`);
        const tagOf50 = logTag?.logAddressTag('203.0.113.50');
        assert(!!tagOf50 && brakeLines.some((l) => l.includes(`from ${tagOf50} `)), `2. the brake's line names the address by its daily hash (${tagOf50})`);

        resolveClientIp('198.51.100.9', { 'x-forwarded-for': '203.0.113.99' });
        for (let i = 0; i < 6; i++) notePasswordFailure('198.51.100.9');
        const proxyLines = printed.join('').split('\n').filter((l) => l.includes('[client-ip]') && l.includes('forwarding headers'));
        assert(proxyLines.length >= 1, '2. an untrusted forwarding proxy is warned about');
        const tagOfProxy = logTag?.logAddressTag('198.51.100.9');
        assert(!!tagOfProxy && proxyLines.some((l) => l.includes(tagOfProxy)) && logText().includes(`A proxy (${tagOfProxy})`),
            '2. by its daily hash, the same in the warning and in the brake\'s line about it');

        resetGatewayRateLimit();
        const gw = (ip: string) => ({ state: {}, ip, headers: {}, status: 200, body: null, set: () => { } }) as any;
        gatewayAdmit(gw('203.0.113.60'), 1, false);
        const tripped = gw('203.0.113.60');
        assert(gatewayAdmit(tripped, 1, false) === false && tripped.status === 429, '2. the gateway answers 429 past its limit');
        const gwLine = logText().split('\n').find((l) => l.includes('[gateway] rate limit reached'));
        assert(!!gwLine && !!logTag && gwLine.includes(logTag.logAddressTag('203.0.113.60')), `2. its log line names the address by its daily hash ("${gwLine}")`);

        const incidentLine = logText().split('\n').find((l) => l.includes('[StandbyHealth]') && l.includes('needs this community'));
        assert(!!incidentLine, "2. the standby's incident was logged");

        const inLogs = addressesIn(logText());
        assert(inLogs.length === 0, `2. no made-up address in system_logs (${inLogs.join(', ') || 'none'})`);
        const inPrint = addressesIn(printed.join(''));
        assert(inPrint.length === 0, `2. none in anything the node printed (${inPrint.join(', ') || 'none'})`);

        // ── 3. The net under every log line ──
        say('\n— 3. a log line with addresses in its text —');
        const printedBefore = printed.length;
        logger.warn('SYS', 'Could not reach 203.0.113.77:443 or [2001:db8::77]:443 at 2026-09-29T10:22:33Z (v1.2.3.4)');
        const netLine = (db.prepare("SELECT message FROM system_logs WHERE message LIKE 'Could not reach%' ORDER BY id DESC").get() as { message: string } | undefined)?.message ?? '';
        assert(addressesIn(netLine).length === 0 && netLine.includes('[REDACTED_ADDRESS]:443') && netLine.includes('10:22:33') && netLine.includes('v1.2.3.4'),
            `3. both addresses redacted in system_logs, the time and the version left alone ("${netLine}")`);
        assert(addressesIn(printed.slice(printedBefore).join('')).length === 0, '3. …and in what was printed');

        // ── 4. Six days, then seven ──
        say('\n— 4. the clock moved on —');
        const beforeSweep = await ownerList();
        retention?.forgetOldAddresses(Date.now() + 6 * DAY);
        assert(addressesIn(addressRowsText()).length >= 7, '4. six days on, the addresses are all still kept');
        retention?.forgetOldAddresses(Date.now() + 7 * DAY + 60_000);
        const leftInConfig = addressesIn(addressRowsText());
        assert(retention !== null && leftInConfig.length === 0, `4. seven days on, no address in node_config (${leftInConfig.join(', ') || 'none'})`);
        const after = await ownerList();
        assert(after.totalPulls === beforeSweep.totalPulls && after.totalRejected === beforeSweep.totalRejected
            && after.lastPullAt === beforeSweep.lastPullAt && after.lastRejectedAt === beforeSweep.lastRejectedAt
            && after.lastPullIp === null && after.lastRejectedIp === null,
            '4. the owner still has the counts and times, and the last pull and refusal with no address');
        assert(after.recent.length === beforeSweep.recent.length
            && after.recent.every((e: any, i: number) => e.ip === null && e.at === beforeSweep.recent[i].at && e.auth === beforeSweep.recent[i].auth),
            '4. every recent entry keeps its time and outcome, and no address');
        const panelAfter = await settingsPanel();
        assert(addressesIn(panelAfter).length === 0 && els['rep-last-pull'].textContent.includes('address no longer kept') && panelAfter.includes('address no longer kept'),
            `4. node Settings says "address no longer kept" ("${els['rep-last-pull'].textContent}")`);
        const bannerAfter = getStandbyHealthBanner();
        assert(bannerAfter.standbys.length === 1 && addressesIn(JSON.stringify(bannerAfter)).length === 0,
            `4. the standby is still watched, named without an address (${bannerAfter.standbys.map((s) => s.label).join(', ')})`);
        const holderAfter = getEnvelopeHolders().find((h) => h.envelopeId === 'env-address-retention-1');
        assert(!!holderAfter && holderAfter.ip === null && holderAfter.message.startsWith('A standby whose address is no longer kept'),
            `4. the take-over keys' holder is still listed, without its address ("${holderAfter?.message}")`);

        // ── 5. Day zero ──
        say('\n— 5. rows and log lines from an older version —');
        const now = Date.now();
        db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run('replication_access', JSON.stringify({
            totalPulls: 3, lastPullAt: now - 30 * DAY, lastPullIp: '203.0.113.90', lastPullAuth: 'admin-pw',
            totalRejected: 1, lastRejectedAt: now - 60 * 60_000, lastRejectedIp: '203.0.113.91',
            recent: [
                { at: now - 60 * 60_000, ip: '203.0.113.91', auth: 'rejected', reason: 'no credentials' },
                { at: now - 30 * DAY, ip: '203.0.113.90', auth: 'admin-pw' },
            ],
        }));
        db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run('standby_health', JSON.stringify({
            standbys: [{
                id: STANDBY_ID, address: '203.0.113.92', firstSeenAt: now - 40 * DAY, lastPullAt: now - 10 * DAY, lastOutcome: 'ok', lastWhy: null,
                failedInARow: 0, lastCopyAt: now - 10 * DAY, lastWholeAt: null, exact: null, lastExactAt: null, differs: [], hashed: false, healing: false,
            }],
            incident: null, lastIncident: null,
        }));
        db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run('takeover_envelope_holders', JSON.stringify([
            { ip: '203.0.113.94', envelopeId: 'env-new', sealedAt: '2026-09-29T00:00:00.000Z', lastFetchAt: now - 60_000, how: 'confirmed' },
            { ip: '203.0.113.93', envelopeId: 'env-old', sealedAt: '2026-09-01T00:00:00.000Z', lastFetchAt: now - 8 * DAY, how: 'sent' },
        ]));
        db.prepare("INSERT INTO system_logs (level, category, message, metadata) VALUES ('SECURITY', 'AUTH', ?, ?)")
            .run('[password-brake] 6 wrong admin passwords from 203.0.113.95; that address now backs off', JSON.stringify({ ip: '2001:db8:9::95' }));
        retention?.startForgettingOldAddresses(50);
        const zero = addressesIn(addressRowsText());
        assert(retention !== null && zero.length === 2 && zero.includes('203.0.113.91') && zero.includes('203.0.113.94'),
            `5. the first boot clears every address older than 7 days and keeps the fresh ones (${zero.join(', ')})`);
        assert(addressesIn(logText()).length === 0, '5. …and every address in log lines from before this version');
        const old = JSON.parse(configRow('replication_access'));
        assert(old.lastPullAt === now - 30 * DAY && old.lastPullAuth === 'admin-pw' && old.lastPullIp === null && old.recent[1].ip === null && old.recent[1].auth === 'admin-pw',
            '5. an old entry keeps its time and outcome');
        // An hour-old refusal comes of age: the hourly timer (here every 50 ms) clears it without anything written to its row.
        const aged = JSON.parse(configRow('replication_access'));
        aged.lastRejectedAt = now - 7 * DAY - 60_000;
        aged.recent[0].at = now - 7 * DAY - 60_000;
        db.prepare('UPDATE node_config SET value = ? WHERE key = ?').run(JSON.stringify(aged), 'replication_access');
        await sleep(300);
        assert(retention !== null && !configRow('replication_access').includes('203.0.113.91'), '5. the timer clears an address that comes of age later');
        retention?.startForgettingOldAddresses();

        // ── 6. A snapshot ──
        say('\n— 6. a snapshot —');
        await get('/api/local/admin/sync-snapshot', from('203.0.113.70', { 'X-Replication-Token': TOKEN }));
        assert(configRow('replication_access').includes('203.0.113.70'), '6. the live database has a fresh address');
        // A sign-up and a knock from the last day: the limiters' keyed hashes of their addresses. The key, openJoinSalt,
        // is in node_config, so from a copy anyone can try every IPv4 address against them.
        const signupHash = openJoinAddressHash('203.0.113.57');
        const knockHash = knockAddressHash('203.0.113.58');
        const fkWas = db.pragma('foreign_keys', { simple: true });
        db.pragma('foreign_keys = OFF');
        db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, ip_hash) VALUES (?, ?, ?, ?)')
            .run('address-retention-member', 'google', 'address-retention-join-hash', signupHash);
        db.prepare("INSERT INTO join_requests (id, pubkey, callsign, message, status, ip_hash) VALUES (?, ?, ?, ?, 'pending', ?)")
            .run('address-retention-knock', 'address-retention-knocker', 'Knocker', 'hello', knockHash);
        db.pragma(`foreign_keys = ${fkWas ? 'ON' : 'OFF'}`);
        assert(addressHashes(db).includes(signupHash) && addressHashes(db).includes(knockHash), '6. (the live database has a sign-up\'s and a knock\'s address hash)');
        // Take-over keys' holders enough that the row spills onto overflow pages. Cleaning it in the copy frees those
        // pages whole: without secure_delete their bytes, addresses and all, stay in the copy's free list, where SQL
        // never looks and `strings` does. (A row inside one page can leave its old cell behind too, depending on the
        // page's layout: #1289's review found one.)
        const fleet = Array.from({ length: 60 }, (_, i) => ({
            ip: `198.51.100.${100 + i}`, envelopeId: `env-fleet-${i}`, sealedAt: '2026-09-29T00:00:00.000Z', lastFetchAt: Date.now() - 60_000, how: 'confirmed',
        }));
        db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run('takeover_envelope_holders', JSON.stringify(fleet));
        const snapDir = fs.mkdtempSync(path.join(DATA_DIR!, 'snapcheck-'));
        const snapFile = path.join(snapDir, 'copy.db');
        writeDbSnapshot(snapFile);
        const copy = new Database(snapFile, { readonly: true });
        const copyRows = (copy.prepare(`SELECT value FROM node_config WHERE key IN (${ADDRESS_ROWS.map(() => '?').join(', ')})`).all(...ADDRESS_ROWS) as { value: string }[]).map((r) => r.value).join('\n');
        const copyLogs = (copy.prepare(`SELECT group_concat(message || ' ' || COALESCE(metadata, ''), '\n') AS t FROM system_logs`).get() as { t: string | null }).t ?? '';
        const copyHashes = addressHashes(copy);
        const copyJoins = (copy.prepare("SELECT (SELECT COUNT(*) FROM open_joins WHERE member_pubkey = 'address-retention-member') + (SELECT COUNT(*) FROM join_requests WHERE id = 'address-retention-knock') AS n").get() as { n: number }).n;
        copy.close();
        assert(copyRows.includes('"auth":"token"') && addressesIn(copyRows).length === 0, `6. the copy keeps the entries and no address (${addressesIn(copyRows).join(', ') || 'none'})`);
        assert(addressesIn(copyLogs).length === 0, "6. …nor in its log lines");
        assert(copyJoins === 2 && copyHashes.length === 0, `6. …nor a limiter's address hash: the sign-up and the knock are kept, their hashes are not (${copyHashes.length} left)`);
        const copyBytes = bytesOf(snapFile);
        assert(addressesIn(copyBytes).length === 0 && !copyBytes.includes(signupHash) && !copyBytes.includes(knockHash),
            `6. the copy's FILE holds no address and no hash, free space included (${[...addressesIn(copyBytes), ...[signupHash, knockHash].filter((h) => copyBytes.includes(h))].join(', ') || 'none'})`);
        assert(configRow('replication_access').includes('203.0.113.70'), '6. the live database still has its fresh one');
        assert(addressHashes(db).includes(signupHash) && addressHashes(db).includes(knockHash), '6. …and its hashes, which the sign-up and knock limits count for a day');
        assert(fs.readdirSync(snapDir).join(',') === 'copy.db', `6. nothing left beside the copy (${fs.readdirSync(snapDir).join(', ')})`);

        // A snapshot from before this version: a plain copy, with the live addresses in it.
        const oldSnap = path.join(snapDir, 'old-version.db');
        db.exec(`VACUUM INTO '${oldSnap.replace(/'/g, "''")}'`);
        const oldImages = path.join(snapDir, 'old-version.db.images');
        fs.mkdirSync(oldImages);
        const plain = await createPlainBackup({ dbFile: oldSnap, imagesDir: oldImages });
        const tarFile = path.join(snapDir, 'backup.tar.gz');
        try { await pipeline(plain.body, fs.createWriteStream(tarFile)); } finally { plain.cleanup(); }
        const unpacked = path.join(snapDir, 'unpacked');
        fs.mkdirSync(unpacked);
        execFileSync('tar', ['-xzf', tarFile, '-C', unpacked]);
        const fromBackup = new Database(path.join(unpacked, 'state.db'), { readonly: true });
        const backupRows = (fromBackup.prepare(`SELECT value FROM node_config WHERE key IN (${ADDRESS_ROWS.map(() => '?').join(', ')})`).all(...ADDRESS_ROWS) as { value: string }[]).map((r) => r.value).join('\n');
        const backupHashes = addressHashes(fromBackup);
        fromBackup.close();
        const oldCopy = new Database(oldSnap, { readonly: true });
        const oldRows = (oldCopy.prepare("SELECT value FROM node_config WHERE key = 'replication_access'").get() as { value: string }).value;
        oldCopy.close();
        assert(oldRows.includes('203.0.113.70'), '6. (the old snapshot has the address in it)');
        assert(backupRows.includes('"auth":"token"') && addressesIn(backupRows).length === 0 && backupHashes.length === 0,
            `6. downloaded as a backup, its database holds none (${addressesIn(backupRows).join(', ') || 'none'}; ${backupHashes.length} hash(es))`);
        const backupBytes = bytesOf(path.join(unpacked, 'state.db'));
        assert(addressesIn(backupBytes).length === 0 && !backupBytes.includes(signupHash) && !backupBytes.includes(knockHash),
            `6. …and the backup's database FILE holds none either (${addressesIn(backupBytes).join(', ') || 'none'})`);

        // ── 6b. Copies already on disk ──
        say('\n— 6b. copies kept on disk from before this version —');
        const snapshotsDir = path.join(DATA_DIR!, 'snapshots');
        fs.mkdirSync(snapshotsDir, { recursive: true });
        // A snapshot as an older version made it: the live addresses, the hashes, an address two months old (main never
        // expired them) and a log line with one (written before logs were sanitized).
        const planted = path.join(snapshotsDir, 'snapshot-2026-09-26T02-00-00-000Z.db');
        db.exec(`VACUUM INTO '${planted.replace(/'/g, "''")}'`);
        const plant = new Database(planted);
        const access = JSON.parse((plant.prepare("SELECT value FROM node_config WHERE key = 'replication_access'").get() as { value: string }).value);
        access.recent.push({ at: Date.now() - 60 * DAY, ip: '198.51.100.61', auth: 'rejected', reason: 'no credentials' });
        plant.prepare("UPDATE node_config SET value = ? WHERE key = 'replication_access'").run(JSON.stringify(access));
        // Its log as main's is: at the cap (2,500 lines, logger.ts), about 1 line in 10 naming an address the way main
        // wrote the brake's line and the gateway's. That many rows make the log's b-tree grow a level while a copy of
        // this file is built, and the page that turns interior keeps its old rows in its gap unless the copy is made
        // with secure_delete on: SQL shows none there, `strings` does (#1289's review, inline 4126055254).
        plant.prepare('DELETE FROM system_logs').run();
        const logLine = plant.prepare('INSERT INTO system_logs (level, category, message, metadata) VALUES (?, ?, ?, ?)');
        plant.transaction(() => {
            for (let i = 0; i < 2499; i++) {
                const n = i % 250;
                if (i % 30 === 0) logLine.run('SECURITY', 'AUTH', `[password-brake] 6 wrong admin passwords from 198.51.100.${n}; that address now backs off`, null);
                else if (i % 30 === 10) logLine.run('WARN', 'AUTH', `[gateway] rate limit reached for ip:203.0.113.${n}; answering 429 until the window resets`, null);
                else if (i % 30 === 20) logLine.run('WARN', 'AUTH', `[gateway] rate limit reached for ip:2001:db8:15::${i.toString(16)}; answering 429 until the window resets`, null);
                else logLine.run('INFO', 'P2P', `[Sync] pulled ${i % 37} posts and ${i % 11} offers from a peer in ${100 + (i % 900)} ms`, null);
            }
            logLine.run('SECURITY', 'AUTH', '[password-brake] 6 wrong admin passwords from 198.51.100.62; that address now backs off', null);
        })();
        const plantedLines = (plant.prepare('SELECT COUNT(*) AS n FROM system_logs').get() as { n: number }).n;
        plant.close();
        // The same snapshot, to download as a backup (below): outside snapshots/, so the boot run leaves it as it is.
        const toDownload = path.join(snapDir, 'old-version-full.db');
        fs.copyFileSync(planted, toDownload);
        // The same database as a fleet harvester holds a server's: the latest, and one day of its history.
        const heldLatest = path.join(DATA_DIR!, 'backups', 'node-a', 'state.db');
        const heldDay = path.join(DATA_DIR!, 'backups', 'node-a', 'history', 'beanpool-2026-09-20.db');
        fs.mkdirSync(path.dirname(heldDay), { recursive: true });
        fs.copyFileSync(planted, heldLatest);
        fs.copyFileSync(planted, heldDay);
        // A snapshot this version made, and a twin a crash left part-way.
        const clean = path.join(snapshotsDir, 'snapshot-2026-09-28T02-00-00-000Z.db');
        writeDbSnapshot(clean);
        const leftTwin = path.join(snapshotsDir, 'snapshot-2026-09-27T02-00-00-000Z.db.forgetting-addresses.tmp');
        fs.copyFileSync(planted, leftTwin);
        const secs = (ms: number) => ms / 1000;
        const kept = [planted, heldLatest, heldDay];
        kept.forEach((f, i) => { fs.chmodSync(f, 0o640); fs.utimesSync(f, secs(Date.now() - (3 + i) * DAY), secs(Date.now() - (3 + i) * DAY)); });
        fs.utimesSync(clean, secs(Date.now() - DAY), secs(Date.now() - DAY));
        const statsBefore = new Map([...kept, clean].map((f) => [f, fs.statSync(f)]));
        const listBefore = listSnapshots();
        assert(kept.every((f) => addressesIn(bytesOf(f)).includes('198.51.100.61') && bytesOf(f).includes(signupHash)),
            '6b. (each old copy has addresses of any age and a hash in it)');

        const swept = await retention?.startForgettingOldAddresses();
        for (const f of kept) {
            const bytes = bytesOf(f);
            const left = [...addressesIn(bytes), ...[signupHash, knockHash].filter((h) => bytes.includes(h))];
            const conn = new Database(f, { readonly: true });
            const entries = (conn.prepare("SELECT value FROM node_config WHERE key = 'replication_access'").get() as { value: string }).value;
            const lines = (conn.prepare('SELECT COUNT(*) AS n FROM system_logs').get() as { n: number }).n;
            conn.close();
            assert(left.length === 0 && entries.includes('"auth":"token"') && lines === plantedLines,
                `6b. the boot run took every address and hash out of ${path.relative(DATA_DIR!, f)}, file bytes included, and kept its entries and its ${lines}/${plantedLines} log lines (${left.join(', ') || 'none'})`);
            const was = statsBefore.get(f)!, now = fs.statSync(f);
            assert(Math.abs(now.mtimeMs - was.mtimeMs) < 1 && (now.mode & 0o777) === 0o640,
                `6b. …and it keeps its mtime and mode (${new Date(now.mtimeMs).toISOString()} vs ${new Date(was.mtimeMs).toISOString()}, ${(now.mode & 0o777).toString(8)})`);
        }
        const listAfter = listSnapshots();
        assert(JSON.stringify(listAfter.map((x) => x.name)) === JSON.stringify(listBefore.map((x) => x.name))
            && listAfter.every((x, i) => Math.abs(x.createdAt - listBefore[i].createdAt) < 1),
            `6b. the snapshot list, its order and its dates are unchanged (${listAfter.map((x) => x.name).join(', ')})`);
        assert(!fs.existsSync(leftTwin) && fs.readdirSync(snapshotsDir).every((n) => n.endsWith('.db'))
            && fs.readdirSync(path.dirname(heldDay)).join(',') === 'beanpool-2026-09-20.db',
            `6b. the twin a crash left is gone, and nothing is left beside the copies (${fs.readdirSync(snapshotsDir).join(', ')})`);
        assert(fs.statSync(clean).ino === statsBefore.get(clean)!.ino && fs.statSync(clean).mtimeMs === statsBefore.get(clean)!.mtimeMs,
            '6b. a snapshot that holds none is only read, not rewritten');
        assert(swept === 3, `6b. three copies were rewritten (${swept})`);
        const inodes = kept.map((f) => fs.statSync(f).ino);
        const again = await retention?.startForgettingOldAddresses();
        assert(again === 0 && kept.every((f, i) => fs.statSync(f).ino === inodes[i]), `6b. the next boot rewrites none of them (${again})`);

        // The same old snapshot downloaded before the boot run reached it, as a readable backup and as a locked one:
        // each backup's database holds no address and no hash, in its bytes either, and keeps its entries and lines.
        assert(addressesIn(bytesOf(toDownload)).includes('198.51.100.62'), '6b. (the snapshot downloaded holds addresses)');
        const drain = async (body: NodeJS.ReadableStream) => {
            const parts: Buffer[] = [];
            for await (const c of body) parts.push(Buffer.from(c as Uint8Array));
            return Buffer.concat(parts);
        };
        const unpackDb = (tarBytes: Uint8Array, tag: string) => {
            const dir = fs.mkdtempSync(path.join(snapDir, `${tag}-`));
            const tar = path.join(dir, 'backup.tar.gz');
            fs.writeFileSync(tar, tarBytes);
            execFileSync('tar', ['-xzf', tar, '-C', dir]);
            return path.join(dir, 'state.db');
        };
        const downloadImages = path.join(snapDir, 'old-version-full.db.images');
        fs.mkdirSync(downloadImages);
        const readable = await createPlainBackup({ dbFile: toDownload, imagesDir: downloadImages });
        let readableBytes: Buffer;
        try { readableBytes = await drain(readable.body); } finally { readable.cleanup(); }
        await ensureGenesis();
        const recovery = await makeRecoveryCode();
        const locked = await createSealedBackup({ dbFile: toDownload, imagesDir: downloadImages });
        let lockedBytes: Buffer;
        try { lockedBytes = await drain(locked.body); } finally { locked.cleanup(); }
        const opened = await openEnvelope(new Uint8Array(lockedBytes), { type: 'code', code: recovery.code }, { kind: 'backup' });
        for (const [how, file] of [['readable', unpackDb(readableBytes, 'readable')], ['locked', unpackDb(opened.payload, 'locked')]] as const) {
            const bytes = bytesOf(file);
            const left = [...addressesIn(bytes), ...[signupHash, knockHash].filter((h) => bytes.includes(h))];
            const conn = new Database(file, { readonly: true });
            const entries = (conn.prepare("SELECT value FROM node_config WHERE key = 'replication_access'").get() as { value: string }).value;
            const lines = (conn.prepare('SELECT COUNT(*) AS n FROM system_logs').get() as { n: number }).n;
            const sqlLeft = addressesIn(entries + (conn.prepare(`SELECT group_concat(message || ' ' || COALESCE(metadata, ''), '\n') AS t FROM system_logs`).get() as { t: string }).t).length + addressHashes(conn).length;
            conn.close();
            assert(sqlLeft === 0 && left.length === 0 && entries.includes('"auth":"token"') && lines === plantedLines,
                `6b. the old snapshot downloaded as a ${how} backup: its database holds no address or hash, file bytes included, and keeps its entries and ${lines}/${plantedLines} log lines (${left.join(', ') || 'none'}; ${sqlLeft} through SQL)`);
        }

        // ── 7. The daily hash (last: a new day's key replaces today's) ──
        say('\n— 7. the daily hash —');
        const t0 = Math.floor(Date.now() / DAY) * DAY + 60 * 60_000;
        const a = logTag?.logAddressTag('203.0.113.80', t0);
        assert(!!a && /^ip#[A-Za-z0-9_-]{10}$/.test(a) && !a.includes('203'), `7. a tag is short and carries no address (${a})`);
        assert(!!a && a === logTag!.logAddressTag('203.0.113.80', t0 + 20 * 60 * 60_000), '7. the same address, the same tag all day');
        assert(!!a && a !== logTag!.logAddressTag('203.0.113.81', t0), '7. another address, another tag');
        assert(!!a && a !== logTag!.logAddressTag('203.0.113.80', t0 + DAY), '7. the next day, another tag');
    } finally {
        server.close();
        try { await node.stop(); } catch { /* the suite's result is already counted */ }
    }

    say(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('✗ suite crashed:', e);
    process.exit(1);
});
