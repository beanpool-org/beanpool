/**
 * Test Suite: this server's own alerts to its owners (services/alerts.ts, routes/alerts.ts; design
 * scratch/global-node/DESIGN-alerts-fable.md §3, slice S3).
 *
 * A stand-in ntfy on loopback, in a worker thread (as fake-s3-test-harness.ts runs its store): it keeps every message,
 * and answers a 503 or a 302 on demand. Pushes are caught at the Expo door here. Nothing leaves this machine. Over the
 * real HTTPS server and its middleware:
 *
 *  1. Owner only: an owner's key session reaches status, settings and test; an admin's and a moderator's are refused 403
 *     in words; an owner's automation token reaches none of it; no credential is 401.
 *  2. No channel: a disk at 79 % for three minutes is nothing; at 80 % it is raised at the third minute, not before: one
 *     `owner.alert` push to the owner's phone only, the owner's admin queue shows `server_alert` and an admin's doesn't;
 *     nothing is sent anywhere. Backups that never leave the server (no destination, no recovery code) nudge the owners
 *     and are never sent to the channel.
 *  3. The channel set in Settings: data/alerts.json is mode 600, the status shows the host and never the path or token;
 *     the waiting alert goes at the next minute with ntfy's Title, Priority and Authorization; 95 % raises 90 and 95 in one
 *     urgent message; 77 % clears those two and keeps 80 (three points of hysteresis); 76 % clears it.
 *  4. Retry: the channel answers 503; the alert waits, is not tried again before 5 minutes, and goes after with what it
 *     missed. A disk back within 6 hours is told as STILL, not as new.
 *  5. A 302 is a failed send: the address it points to is never asked.
 *  6. The hourly cap: 20 messages, then low ones are held (not dropped) while a high one still goes; the held ones go
 *     together an hour later.
 *  7. Off-box backups failing (state fixtures): raised as high, with counts only; cleared when the next one arrives.
 *     Three starts in 15 minutes: a crash loop, urgent.
 *  8. "Send a test": one message, "Test from <community>"; its answer says it went.
 *  9. The secret: in no table of state.db (so in no standby copy: every table the replication manifest copies is checked
 *     too), no snapshot, no locked backup (opened with the code), no log line, no answer. No member's name in any message
 *     sent, header or body. docker-compose.yml passes the three settings through; boot-file-safety lists alerts.json.
 *
 * Run (as test-all does, through scripts/run-server-suites.mjs):
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-alerts.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_OFFBOX_') || k.startsWith('ALERTS_WEBHOOK_')) delete process.env[k];

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const MIN = 60_000;
const HOUR = 60 * MIN;

// ── The stand-in ntfy, in its own thread ──────────────────────────────────────────────────────────────────────────────

const NTFY_SOURCE = `
'use strict';
const http = require('node:http');
const { parentPort } = require('node:worker_threads');
const log = [];
const faults = [];
const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        log.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        const f = faults[0];
        if (f) {
            if (--f.count <= 0) faults.shift();
            res.writeHead(f.status, f.location ? { Location: f.location } : {});
            if (f.bigMb) {
                // An answer far bigger than the node's heap would hold, written only as fast as it is read.
                const mb = Buffer.alloc(1024 * 1024, 120);
                let left = f.bigMb;
                const more = () => {
                    while (left > 0) {
                        left--;
                        if (!res.write(mb)) { res.once('drain', more); return; }
                    }
                    res.end();
                };
                res.on('close', () => { left = 0; });
                more();
                return;
            }
            res.end('fault');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"id":"x"}');
    });
});
parentPort.on('message', (msg) => {
    const reply = (value) => parentPort.postMessage({ id: msg.id, value });
    if (msg.op === 'log') reply(log);
    else if (msg.op === 'fault') { faults.push(msg.fault); reply(true); }
    else if (msg.op === 'close') server.close(() => reply(true));
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ ready: server.address().port }));
`;

interface NtfyHit { method: string; path: string; headers: Record<string, string>; body: string }

async function startFakeNtfy() {
    const worker = new Worker(NTFY_SOURCE, { eval: true });
    let next = 0;
    const waiting = new Map<number, (v: any) => void>();
    const port: number = await new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.on('message', (m: any) => {
            if (m.ready) resolve(m.ready);
            else waiting.get(m.id)?.(m.value);
        });
    });
    const call = (op: string, extra: Record<string, unknown> = {}) => new Promise<any>((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        worker.postMessage({ id, op, ...extra });
    });
    return {
        port,
        url: (p: string) => `http://127.0.0.1:${port}${p}`,
        hits: (): Promise<NtfyHit[]> => call('log'),
        fault: (status: number, count = 1, location?: string, bigMb?: number) => call('fault', { fault: { status, count, location, bigMb } }),
        close: async () => { await call('close'); await worker.terminate(); },
    };
}

// ── The suite ──────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));

    // Everything this process prints, to look for the secret in afterwards.
    const printed: string[] = [];
    for (const stream of [process.stdout, process.stderr] as const) {
        const write = stream.write.bind(stream);
        (stream as any).write = (chunk: any, ...rest: any[]) => { printed.push(String(chunk)); return write(chunk, ...rest); };
    }

    const ntfy = await startFakeNtfy();
    const TOPIC = `bp-alerts-${crypto.randomBytes(9).toString('hex')}`;
    const TOKEN = `tk_${crypto.randomBytes(12).toString('hex')}`;

    // No node reaches anything but this machine: a push is answered here and kept; anything else is refused and counted.
    const pushes: Array<{ to: string[]; k: string; i: string }> = [];
    const blocked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
        if (url.hostname === 'exp.host') {
            const batch = JSON.parse(String(init?.body ?? '[]')) as any[];
            pushes.push({ to: batch.map((m) => m.to), k: batch[0]?.data?.k, i: batch[0]?.data?.i });
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;

    const { initStateEngine, seedGenesisMember, grantNodeRole } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { mintHandshakeToken, consumeHandshakeToken, backdateAdminSessionForTests, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
    const { ownerTokenHeaders } = await import('./admin-auth-test-harness.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { getAdminQueue } = await import('./engine/admin-queue.js');
    const { setSimulatedDiskUsageForTesting } = await import('./engine/storage-health.js');
    const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
    const { createSealedBackup, openSealedFileTo } = await import('./services/sealed-backup.js');
    const { createSnapshot, resolveSnapshotPath } = await import('./services/snapshot-scheduler.js');
    const { TABLES } = await import('./engine/replication-manifest.js');
    const { SECRET_FILES } = await import('./boot-file-safety.js');
    const { toldPush } = await import('./push-notice-test-harness.js');
    const alerts = await import('./services/alerts.js');
    const { ALERTS_OWNER_ONLY } = await import('./routes/alerts.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');

    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const PW = 'Alerts-Main-Pw-5512!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, communityName: 'Alert Test Commons' });

    const pubkey = () => crypto.randomBytes(32).toString('hex');
    const owner = pubkey();
    const admin = pubkey();
    const moderator = pubkey();
    const member = pubkey();
    const CALLSIGNS = ['OliveOwnerQ', 'AdamAdminQ', 'ModeratorMoQ', 'ZedMemberQ'];
    seedGenesisMember(owner, CALLSIGNS[0]);
    for (const [pk, callsign] of [[admin, CALLSIGNS[1]], [moderator, CALLSIGNS[2]], [member, CALLSIGNS[3]]]) {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(pk, callsign, new Date().toISOString(), owner, 'TEST');
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    }
    grantNodeRole(admin, 'admin', owner);
    grantNodeRole(moderator, 'moderator', owner);
    for (const [pk, token] of [[owner, 'ExponentPushToken[olive-owner]'], [admin, 'ExponentPushToken[adam-admin]'],
        [moderator, 'ExponentPushToken[mo-moderator]'], [member, 'ExponentPushToken[zed-member]']]) {
        putPushTokenRow(pk, token, 'android');
    }
    const session = (pk: string, role: 'owner' | 'admin' | 'moderator') => {
        const ex = consumeHandshakeToken(mintHandshakeToken(pk, role).handshakeToken);
        if (!ex.ok || ex.role !== role) throw new Error(`setup: no ${role} session: ${ex.error}`);
        return ex.sessionId!;
    };
    const asOwner = { 'x-admin-session': session(owner, 'owner') };
    const asAdmin = { 'x-admin-session': session(admin, 'admin') };
    const asMod = { 'x-admin-session': session(moderator, 'moderator') };
    const asToken = ownerTokenHeaders('admin', owner);

    await initTls();
    const port = await https.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const answers: string[] = [];
    const call = async (route: string, body: unknown, headers: Record<string, string>) => {
        resetAdminAuthTarpit();
        https.resetAdminRateLimit();
        const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
        const text = await res.text();
        answers.push(text);
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json, text };
    };

    let offset = 0;
    const advance = (ms: number) => { offset += ms; alerts.setAlertsClockForTests(offset); };
    const tick = () => alerts.checkServerAlerts();
    const pushedKeys = async () => {
        await new Promise((r) => setTimeout(r, 50));
        return pushes.filter((p) => p.k === 'owner.alert').map((p) => ({ to: p.to, alert: toldPush(db, { data: { i: p.i } }).data?.alert as string }));
    };
    const ntfyHits = async () => (await ntfy.hits()).filter((h) => h.path === `/${TOPIC}`);

    // ── 1. Owner only ─────────────────────────────────────────────────────────────────────────────────────────────────
    for (const route of ['status', 'settings', 'test']) {
        const r = `/api/local/admin/alerts/${route}`;
        const body = route === 'settings' ? { url: ntfy.url(`/${TOPIC}`) } : {};
        const a = await call(r, body, asAdmin);
        assert(a.status === 403 && a.json?.error === ALERTS_OWNER_ONLY, `1. an admin's key session is refused ${route} in words (${a.status} ${a.json?.error})`);
        const m = await call(r, body, asMod);
        assert(m.status === 403, `1. a moderator's key session is refused ${route} (${m.status})`);
        const t = await call(r, body, asToken);
        assert(t.status === 401 || t.status === 403, `1. an owner's automation token reaches no ${route} (${t.status})`);
        const n = await call(r, body, {});
        assert(n.status === 401, `1. no credential is 401 on ${route} (${n.status})`);
    }
    assert(!fs.existsSync(path.join(dataDir!, alerts.ALERTS_SETTINGS_FILE)), '1. nothing a refused request sent was kept');
    const st0 = await call('/api/local/admin/alerts/status', {}, asOwner);
    assert(st0.status === 200 && st0.json?.channel === null, "1. the owner's key session reads the status: no channel yet");
    // The phone's Manage hand-off asks for the unlock again before a change after 5 minutes; the status is a read, so it
    // keeps showing (as the off-box card beside it does), while setting the channel still asks.
    const phoneEx = consumeHandshakeToken(mintHandshakeToken(owner, 'owner').handshakeToken, Date.now(), { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS });
    const stalePhone = phoneEx.sessionId!;
    backdateAdminSessionForTests(stalePhone, 6 * MIN);
    const stStale = await call('/api/local/admin/alerts/status', {}, { 'x-admin-session': stalePhone });
    assert(stStale.status === 200, `1. an owner's phone session minted 6 minutes ago still reads the status (${stStale.status} ${stStale.json?.code ?? ''})`);
    const setStale = await call('/api/local/admin/alerts/settings', { url: ntfy.url(`/${TOPIC}`) }, { 'x-admin-session': stalePhone });
    assert(setStale.status === 403 && setStale.json?.code === 'step_up_required', `1. and setting the channel from it asks for the step-up (${setStale.status} ${setStale.json?.code})`);
    assert(!fs.existsSync(path.join(dataDir!, alerts.ALERTS_SETTINGS_FILE)), '1. which kept nothing');

    // A channel file that is there but can't be used says so (never what it holds), and one that can't be removed is not
    // answered as removed. The status shows the scheme and registrable domain only: a subdomain can be the secret.
    const chFile = path.join(dataDir!, alerts.ALERTS_SETTINGS_FILE);
    for (const [content, why, re] of [
        ['{not json', 'garbage', /not readable/],
        [JSON.stringify({ url: `http://ntfy.example.org/${TOPIC}` }), 'a hand-written http:// address', /https:\/\//],
    ] as const) {
        fs.writeFileSync(chFile, content);
        const r = await call('/api/local/admin/alerts/status', {}, asOwner);
        assert(r.json?.channel === null && re.test(r.json?.channelProblem ?? '') && !r.text.includes(TOPIC), `1. ${why} in alerts.json is a channel problem in words (${r.json?.channelProblem})`);
    }
    fs.rmSync(chFile);
    fs.mkdirSync(chFile);
    const unreadable = await call('/api/local/admin/alerts/status', {}, asOwner);
    assert(/can't be read/.test(unreadable.json?.channelProblem ?? ''), `1. an unreadable alerts.json says so (${unreadable.json?.channelProblem})`);
    const rm = await call('/api/local/admin/alerts/settings', { remove: true }, asOwner);
    assert(rm.status === 400 && /could not be removed/.test(rm.json?.error ?? ''), `1. a channel that can't be removed is not answered as removed (${rm.status} ${rm.json?.error})`);
    fs.rmdirSync(chFile);
    const rmNone = await call('/api/local/admin/alerts/settings', { remove: true }, asOwner);
    assert(rmNone.status === 200 && rmNone.json?.status?.channelProblem === null, '1. removing when none is set is fine');
    for (const [host, shown] of [['abc123secret.hooks.example.com', '….example.com'], ['ntfy.sh', 'ntfy.sh'], ['team-x.example.co.uk', '….example.co.uk'],
        ['example.com.au', 'example.com.au'], ['10.0.0.1', '10.0.0.1']] as const) {
        const d = alerts.describeChannel({ source: 'settings', url: `https://${host}:8443/${TOPIC}?k=1`, format: 'json', token: null });
        assert(d.where === `https://${shown}/…`, `1. ${host} is shown as ${d.where}`);
    }

    // ── 2. No channel: the disk, the owners' push and banner ─────────────────────────────────────────────────────────
    alerts.resetAlertsForTests();
    pushes.length = 0;
    setSimulatedDiskUsageForTesting(79);
    for (let i = 0; i < 3; i++) await tick();
    let active = alerts.getAlertsStatus().active.map((a) => a.key);
    assert(!active.some((k) => k.startsWith('disk.')), '2. 79 % for three minutes raises nothing');
    assert(active.includes('backups.none'), '2. no destination and no recovery code: the owners are nudged');
    setSimulatedDiskUsageForTesting(80);
    await tick();
    await tick();
    assert(!alerts.getAlertsStatus().active.some((a) => a.key === 'disk.80'), '2. 80 % for two minutes is not yet an alert');
    await tick();
    assert(alerts.getAlertsStatus().active.some((a) => a.key === 'disk.80'), '2. 80 % at the third minute is raised');
    let told = await pushedKeys();
    assert(told.filter((p) => p.alert === 'disk.80').length === 1, `2. one owner.alert push for the disk (${JSON.stringify(told)})`);
    assert(told.every((p) => p.to.length === 1 && p.to[0] === 'ExponentPushToken[olive-owner]'), "2. only the owner's phone is pushed");
    const ownerQ = getAdminQueue({ forOwner: true }).items.find((i) => i.kind === 'server_alert');
    assert(!!ownerQ && ownerQ.count === 2 && ownerQ.section === 'home', `2. the owner's admin queue shows server_alert (${ownerQ?.count})`);
    assert(!getAdminQueue({}).items.some((i) => i.kind === 'server_alert'), "2. an admin's queue does not");
    const qHttp = await call('/api/local/admin/queue', {}, asAdmin);
    assert(!qHttp.text.includes('server_alert'), "2. an admin's queue over HTTP has no server_alert");
    assert((await ntfy.hits()).length === 0, '2. with no channel nothing is sent anywhere');

    // ── 3. The channel, set in Settings ──────────────────────────────────────────────────────────────────────────────
    const bad = await call('/api/local/admin/alerts/settings', { url: `http://ntfy.example.org/${TOPIC}` }, asOwner);
    assert(bad.status === 400 && /https:\/\//.test(bad.json?.error) && !bad.text.includes(TOPIC), '3. http:// off this machine is refused, without repeating the address');
    const set = await call('/api/local/admin/alerts/settings', { url: ntfy.url(`/${TOPIC}`), format: 'ntfy', token: TOKEN }, asOwner);
    assert(set.status === 200 && set.json?.status?.channel?.where === 'http://127.0.0.1/…' && set.json.status.channel.tokenSet === true,
        `3. the status shows the host and that a token is set (${JSON.stringify(set.json?.status?.channel)})`);
    assert(!set.text.includes(TOPIC) && !set.text.includes(TOKEN), '3. the answer carries neither the topic nor the token');
    const settingsFile = path.join(dataDir!, alerts.ALERTS_SETTINGS_FILE);
    assert((fs.statSync(settingsFile).mode & 0o777) === 0o600, '3. data/alerts.json is mode 600');
    await tick();
    let hits = await ntfyHits();
    assert(hits.length === 1, `3. the waiting alert went at the next minute (${hits.length})`);
    const first = hits[0];
    assert(first.headers.authorization === `Bearer ${TOKEN}`, '3. with the token as a bearer');
    assert(first.headers.title === 'Alert Test Commons: disk 80% full' && first.headers.priority === '3',
        `3. ntfy's Title and Priority (${first.headers.title}, ${first.headers.priority})`);
    assert(/DISK 80% FULL since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: The disk is 80% full/.test(first.body), '3. the body: the condition, since when, the figure');
    assert(!first.body.includes('backups stay on this server') && !first.body.includes('BACKUPS STAY'), '3. the backups nudge is never sent to the channel');
    setSimulatedDiskUsageForTesting(95);
    for (let i = 0; i < 3; i++) await tick();
    hits = await ntfyHits();
    assert(hits.length === 2 && hits[1].headers.priority === '5' && /\(\+1 more\)/.test(hits[1].headers.title),
        `3. 95 % raises 90 and 95 in one urgent message (${hits.length}, ${hits[1]?.headers.priority}, ${hits[1]?.headers.title})`);
    told = await pushedKeys();
    assert(told.filter((p) => p.alert === 'disk.95').length === 1 && told.filter((p) => p.alert === 'disk.90').length === 1, '3. one push each for 90 and 95');
    setSimulatedDiskUsageForTesting(77);
    await tick();
    active = alerts.getAlertsStatus().active.map((a) => a.key);
    hits = await ntfyHits();
    assert(active.includes('disk.80') && !active.includes('disk.90') && !active.includes('disk.95'), `3. 77 %: 90 and 95 cleared, 80 kept by the hysteresis (${active})`);
    assert(hits.length === 3 && /resolved/.test(hits[2].headers.title) && hits[2].headers.priority === '2', '3. one resolved message, low priority');
    setSimulatedDiskUsageForTesting(76);
    await tick();
    assert(!alerts.getAlertsStatus().active.some((a) => a.key === 'disk.80'), '3. 76 %: 80 cleared too');
    assert((await ntfyHits()).length === 4, '3. and told once');

    // ── 4. Retry, and a disk back within 6 hours ─────────────────────────────────────────────────────────────────────
    await ntfy.fault(503, 1);
    setSimulatedDiskUsageForTesting(85);
    for (let i = 0; i < 3; i++) await tick();
    let st = alerts.getAlertsStatus();
    assert((await ntfyHits()).length === 5 && st.failedInARow === 1 && st.error === 'HTTP 503' && st.waiting === 1, `4. a 503: the alert waits (${st.error}, ${st.waiting})`);
    advance(4 * MIN);
    await tick();
    assert((await ntfyHits()).length === 5, '4. not tried again before 5 minutes');
    advance(1 * MIN + 1000);
    await tick();
    hits = await ntfyHits();
    st = alerts.getAlertsStatus();
    assert(hits.length === 6 && st.waiting === 0 && st.failedInARow === 0, '4. tried again at 5 minutes, and delivered');
    assert(/STILL DISK 80% FULL/.test(hits[5].body), '4. back within 6 hours: told as STILL, not as new');
    told = await pushedKeys();
    assert(told.filter((p) => p.alert === 'disk.80').length === 1, '4. and the owner is not pushed again within the day');

    // ── 5. A redirect is never followed ──────────────────────────────────────────────────────────────────────────────
    await ntfy.fault(302, 1, ntfy.url('/elsewhere'));
    setSimulatedDiskUsageForTesting(70);
    await tick();
    st = alerts.getAlertsStatus();
    assert(st.error !== null && /redirect/.test(st.error) && st.waiting === 1, `5. a 302 is a failed send (${st.error})`);
    assert(!(await ntfy.hits()).some((h) => h.path === '/elsewhere'), '5. the address it points to is never asked');
    advance(5 * MIN + 1000);
    await tick();
    assert(alerts.getAlertsStatus().waiting === 0, '5. delivered to the address the owner gave on the next try');

    // The channel's answer is never read: only its status is looked at, so a huge one costs the node nothing.
    const channel5 = alerts.readAlertChannel()!;
    const msg5 = alerts.composeAlert('Alert Test Commons', [{ key: 'tls.fallback', kind: 'raised', at: 0, since: 0, priority: 4, detail: 'test' }], null);
    for (const status of [200, 302]) {
        await ntfy.fault(status, 1, status === 302 ? ntfy.url('/elsewhere') : undefined, 256);
        global.gc?.();
        const rss0 = process.memoryUsage().rss;
        const t0 = Date.now();
        const r5 = await alerts.sendToChannel(channel5, msg5);
        const grew = Math.round((process.memoryUsage().rss - rss0) / 1024 / 1024);
        assert(r5.ok === (status === 200) && grew < 64 && Date.now() - t0 < 10_000, `5. a 256 MB answer (HTTP ${status}) is not read: RSS +${grew} MB, ${Date.now() - t0} ms`);
    }

    // ── 6. The hourly cap ────────────────────────────────────────────────────────────────────────────────────────────
    advance(2 * HOUR);
    const before6 = (await ntfyHits()).length;
    for (let i = 0; i < 24; i++) await alerts.updateAlerts([{ key: 'snapshots.failed', active: i % 2 === 0, detail: `flap ${i}` }]);
    let sent6 = (await ntfyHits()).length - before6;
    st = alerts.getAlertsStatus();
    assert(sent6 === alerts.ALERT_HOURLY_CAP && st.waiting > 0, `6. 20 messages in an hour, then low ones are held (${sent6} sent, ${st.waiting} held)`);
    await alerts.updateAlerts([{ key: 'tls.fallback', active: true, detail: 'test: high priority' }]);
    sent6 = (await ntfyHits()).length - before6;
    hits = await ntfyHits();
    assert(sent6 === alerts.ALERT_HOURLY_CAP + 1 && hits[hits.length - 1].headers.priority === '4', '6. a high one still goes past the cap, with the held ones');
    await alerts.updateAlerts([{ key: 'tls.fallback', active: false, detail: 'test: back' }]);
    assert(alerts.getAlertsStatus().waiting === 1, '6. a low one after it is held again');
    advance(HOUR + 1000);
    await alerts.flushAlerts();
    assert(alerts.getAlertsStatus().waiting === 0 && (await ntfyHits()).length - before6 === alerts.ALERT_HOURLY_CAP + 2, '6. an hour later the held one goes');

    // ── 7. Off-box state fixtures; a crash loop ──────────────────────────────────────────────────────────────────────
    const code = await makeRecoveryCode();
    process.env.BACKUP_OFFBOX_1_NAME = 'Fixture store';
    process.env.BACKUP_OFFBOX_1_ENDPOINT = 'https://s3.fixture.invalid';
    process.env.BACKUP_OFFBOX_1_BUCKET = 'fixture-bucket';
    process.env.BACKUP_OFFBOX_1_REGION = 'auto';
    process.env.BACKUP_OFFBOX_1_ACCESS_KEY_ID = 'AKIAFIXTURE123';
    process.env.BACKUP_OFFBOX_1_SECRET_ACCESS_KEY = 'fixture-secret-never-used';
    const offbox = await import('./services/offbox-backups.js');
    const dest = offbox.getOffboxStatus().destinations[0];
    const where = `${dest.endpoint}|${dest.bucket}|${dest.prefix}`;
    const stateFile = path.join(dataDir!, offbox.OFFBOX_STATE_FILE);
    const fixture = (failures: number, lastSuccessAt: number) => fs.writeFileSync(stateFile, JSON.stringify({
        destinations: { [dest.id]: { where, lastAttemptAt: Date.now(), lastSuccessAt, lastSuccessKey: null, lastSuccessBytes: 1, lastError: failures ? 'HTTP 503' : null, failures, lastPruneAt: null, lastPruned: 0, lastPruneError: null } },
        lastRunAt: Date.now(), lastRunError: null,
    }));
    fixture(2, Date.now() - HOUR);
    const before7 = (await ntfyHits()).length;
    await tick();
    active = alerts.getAlertsStatus().active.map((a) => a.key);
    assert(active.includes('backups.offbox') && !active.includes('backups.none'), `7. two failed tries: off-box backups raised; the nudge cleared (${active})`);
    hits = await ntfyHits();
    const offMsg = hits.slice(before7).find((h) => /off-box backups failing/i.test(h.body));
    assert(!!offMsg && offMsg.headers.priority === '4' && /1 of 1 off-box destination is failing/.test(offMsg.body), '7. told as high, with counts only');
    assert(!offMsg!.body.includes('Fixture store') && !offMsg!.body.includes('AKIA') && !offMsg!.body.includes('fixture-bucket'), "7. no destination's name, key or bucket");
    fixture(0, Date.now());
    await tick();
    assert(!alerts.getAlertsStatus().active.some((a) => a.key === 'backups.offbox'), '7. the next upload that arrives clears it');
    fs.writeFileSync(path.join(dataDir!, alerts.BOOTS_FILE), JSON.stringify([Date.now() + offset - 10 * MIN, Date.now() + offset - 5 * MIN]));
    alerts.recordBoot();
    await tick();
    const loop = alerts.getAlertsStatus().active.find((a) => a.key === 'boot.crashloop');
    assert(!!loop && loop.priority === 5, '7. three starts in 15 minutes: a crash loop, urgent');
    hits = await ntfyHits();
    assert(/RESTARTING AGAIN AND AGAIN/.test(hits[hits.length - 1].body), '7. sent at the third start');

    // ── 8. Send a test ───────────────────────────────────────────────────────────────────────────────────────────────
    const before8 = (await ntfyHits()).length;
    const test = await call('/api/local/admin/alerts/test', {}, asOwner);
    hits = await ntfyHits();
    assert(test.status === 200 && test.json?.ok === true && test.json.status?.lastOkAt, `8. the test went (${test.text.slice(0, 120)})`);
    assert(hits.length === before8 + 1 && hits[hits.length - 1].headers.title === 'Test from Alert Test Commons', '8. one message, "Test from <community>"');

    // ── 9. Where the secret is not ───────────────────────────────────────────────────────────────────────────────────
    const secrets = [TOPIC, TOKEN];
    const has = (text: string) => secrets.some((s) => text.includes(s));
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((r) => r.name);
    const tableText = (t: string) => (db.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}"`).raw().all() as unknown[][]).map((r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : Buffer.isBuffer(v) ? v.toString('latin1') : v))).join('\n');
    const inDb = tables.filter((t) => has(tableText(t)));
    assert(inDb.length === 0, `9. in no table of state.db (${tables.length} read; found in: ${inDb.join(', ') || 'none'})`);
    const copied = Object.entries(TABLES).filter(([, e]) => e.kind === 'replicated' || e.kind === 'replicated-except').map(([t]) => t).filter((t) => tables.includes(t));
    assert(copied.length > 10 && copied.every((t) => !has(tableText(t))), `9. so in none of the ${copied.length} tables a standby copies`);
    db.pragma('wal_checkpoint(TRUNCATE)');
    assert(!has(fs.readFileSync(path.join(dataDir!, 'state.db')).toString('latin1')), "9. nor in state.db's bytes");
    const snap = createSnapshot();
    assert(!has(fs.readFileSync(resolveSnapshotPath(snap.name)!).toString('latin1')), '9. nor in a snapshot');
    const sealed = await createSealedBackup();
    const sealedFile = path.join(work, 'b.bpsealed');
    await new Promise<void>((resolve, reject) => sealed.body.pipe(fs.createWriteStream(sealedFile)).on('finish', resolve).on('error', reject));
    sealed.cleanup();
    const opened = path.join(work, 'b.tar.gz');
    await openSealedFileTo(sealedFile, { type: 'code', code: code.code }, opened);
    const unpacked = path.join(work, 'unpacked');
    fs.mkdirSync(unpacked);
    spawnSync('tar', ['-xzf', opened, '-C', unpacked]);
    const files = fs.readdirSync(unpacked, { recursive: true }).map((f) => path.join(unpacked, String(f))).filter((f) => fs.statSync(f).isFile());
    const backupText = files.map((f) => fs.readFileSync(f).toString('latin1')).join('\n');
    assert(backupText.includes(CALLSIGNS[3]) && fs.existsSync(path.join(unpacked, 'state.db')), '9. (the locked backup opens with the code and holds the community)');
    assert(!has(backupText), `9. nor in a locked backup (${files.length} files read)`);
    const logRows = (db.prepare('SELECT message FROM system_logs').all() as { message: string }[]).map((r) => r.message).join('\n');
    assert(/\[Alerts\]/.test(logRows) || /\[Alerts\]/.test(printed.join('')), '9. (the alert lines were logged)');
    assert(!has(printed.join('')) && !has(logRows), '9. nor in any log line, console or table');
    assert(!answers.some(has), `9. nor in any answer (${answers.length})`);
    assert(!has(fs.readFileSync(path.join(dataDir!, alerts.ALERTS_STATE_FILE), 'utf8')), "9. nor in the alert book's own file");
    const sent = await ntfy.hits();
    const sentText = sent.map((h) => JSON.stringify(h.headers) + '\n' + h.body).join('\n');
    const named = CALLSIGNS.filter((c) => sentText.toLowerCase().includes(c.toLowerCase()));
    const keys = [owner, admin, moderator, member].filter((k) => sentText.includes(k.slice(0, 16)));
    assert(sent.length > 20 && named.length === 0 && keys.length === 0, `9. no member's name or key in any of the ${sent.length} messages sent (${named.join(', ') || 'none'})`);
    const compose = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../docker-compose.yml'), 'utf8');
    assert(['ALERTS_WEBHOOK_URL', 'ALERTS_WEBHOOK_FORMAT', 'ALERTS_WEBHOOK_TOKEN'].every((k) => compose.includes(`- ${k}=\${${k}:-}`)), '9. docker-compose.yml passes the three settings through');
    assert(SECRET_FILES.includes('alerts.json'), '9. boot-file-safety makes alerts.json 600 at every start');
    assert(blocked.length === 0, `9. nothing reached off this machine (${blocked.join(', ') || 'none'})`);

    // A channel removed: nothing is sent; the owners' push and banner still work.
    const removed = await call('/api/local/admin/alerts/settings', { remove: true }, asOwner);
    assert(removed.status === 200 && removed.json?.status?.channel === null && !fs.existsSync(settingsFile), '9. the channel removed: the file is gone');

    alerts.stopServerAlerts();
    await ntfy.close();
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(1);
});
