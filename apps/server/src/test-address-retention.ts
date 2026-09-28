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
 *  6. A snapshot (writeDbSnapshot makes every snapshot and backup) holds no address, even a fresh one; the live
 *     database keeps its fresh one; nothing is left beside the file. A snapshot made before this version (a plain
 *     copy, addresses in it), downloaded as a backup: the backup's database holds none.
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
const { noteEnvelopeFetch, getEnvelopeHolders } = await import('./services/takeover-envelope.js');
const { writeDbSnapshot } = await import('./services/snapshot-scheduler.js');
const { createPlainBackup } = await import('./services/sealed-backup.js');
const { logger } = await import('./logger.js');
const { db } = await import('./db/db.js');
// This change's own modules: absent on a build from before it, where the checks that need them fail instead of crashing.
const retention = await import('./services/address-retention.js').catch(() => null) as null | {
    forgetOldAddresses(now?: number): number; startForgettingOldAddresses(everyMs?: number): void;
};
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
        const snapDir = fs.mkdtempSync(path.join(DATA_DIR!, 'snapcheck-'));
        const snapFile = path.join(snapDir, 'copy.db');
        writeDbSnapshot(snapFile);
        const copy = new Database(snapFile, { readonly: true });
        const copyRows = (copy.prepare(`SELECT value FROM node_config WHERE key IN (${ADDRESS_ROWS.map(() => '?').join(', ')})`).all(...ADDRESS_ROWS) as { value: string }[]).map((r) => r.value).join('\n');
        const copyLogs = (copy.prepare(`SELECT group_concat(message || ' ' || COALESCE(metadata, ''), '\n') AS t FROM system_logs`).get() as { t: string | null }).t ?? '';
        copy.close();
        assert(copyRows.includes('"auth":"token"') && addressesIn(copyRows).length === 0, `6. the copy keeps the entries and no address (${addressesIn(copyRows).join(', ') || 'none'})`);
        assert(addressesIn(copyLogs).length === 0, "6. …nor in its log lines");
        assert(configRow('replication_access').includes('203.0.113.70'), '6. the live database still has its fresh one');
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
        fromBackup.close();
        const oldCopy = new Database(oldSnap, { readonly: true });
        const oldRows = (oldCopy.prepare("SELECT value FROM node_config WHERE key = 'replication_access'").get() as { value: string }).value;
        oldCopy.close();
        assert(oldRows.includes('203.0.113.70'), '6. (the old snapshot has the address in it)');
        assert(backupRows.includes('"auth":"token"') && addressesIn(backupRows).length === 0,
            `6. downloaded as a backup, its database holds none (${addressesIn(backupRows).join(', ') || 'none'})`);

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
