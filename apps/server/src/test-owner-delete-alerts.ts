/**
 * Test Suite: the owners' alerts for owner-delete (design case 18 §7, slice S5), over the real HTTPS server through every
 * middleware a node runs, with the alert channel a loopback fake (ntfy) and the address service a loopback stub: nothing
 * leaves this machine.
 *
 *  1. sec.restore: a restore from the server's shell and an owner's roll-back each raise it once at the next boot, high,
 *     saying how ("from the server's shell" / "by an owner") and when the backup was made (an unlocked one, with no date:
 *     said without one); the restore and roll-back paths leave that "who" in their notice; a refused upload of another
 *     community's backup is counted, one line for the last 24 hours ("2 backups … in the last day"), its hour's fold line
 *     says refusals.
 *  2. sec.address (#2033 B1): an owner takes the address offline, or claims a new name over the live one: told once, high,
 *     on its own row, never "not its own"; the members are told, in words for how it went, only when it was live; a real
 *     hijack inside the same day still pushes the owners.
 *  3. sec.keys: replacing the recovery code is told once, high; making the first one is not.
 *  4. sec.backups: a replication token made, then cleared; the server a standby copies from changed; fewer snapshots kept:
 *     one line each. A fourth change by the same owner in the hour folds into one "1 more change" line when the hour ends.
 *  4. (also) every lessening the proof is asked for: snapshots off, covering less time, off-box kept fewer days, a
 *     standby's own token cleared.
 *  5. The alert channel changed, then removed: the last message goes to the OLD channel each time; a new token for the
 *     same channel says nothing.
 *  6. sec.members: an admin's removals are one counted line ("2 members were removed in the last day"), an offboard too;
 *     a repeat, a non-member or an owner's or the password's removal is not counted; a branch pruned by an owner is; one
 *     admin removing 30 moderators is one line, and 60 with the channel down leave the admin's earlier rename in place.
 *  7. sec.settings: an admin renaming the community, its callsign or its contacts is told, low; the owner's own is not.
 *  8. No alert, in the book or on the channel, says a member's callsign or key, the address, the new callsign or a contact.
 *  9. The community's name in a title: a hostile callsign standing in for it is cleaned (#2033 N6).
 *
 * Run: SERVER_SUITES_ONLY=test-owner-delete-alerts node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.ALERTS_WEBHOOK_URL;

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { localFetch } from './keepalive-test-fetch.js';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        // Counted, and the run goes on, so a run on a server without these alerts reports every one missing.
        console.error(`✗ ${msg}`);
    }
}

/** Settings' probe of Cloudflare's edge, refused at once: nothing leaves. */
const CF_EDGE_IP = '104.21.93.179';
function refuseEdge(): void {
    const real = http.request;
    (http as any).request = function (this: unknown, ...args: any[]) {
        const o = args[0];
        const opts = o && typeof o === 'object' && !(o instanceof URL) ? o : null;
        if (opts && (opts.hostname === CF_EDGE_IP || opts.host === CF_EDGE_IP)) {
            const req: any = new EventEmitter();
            req.setTimeout = () => req;
            req.destroy = () => req;
            req.write = () => true;
            req.end = () => { setImmediate(() => req.emit('error', new Error('refused in tests'))); return req; };
            return req;
        }
        return (real as any).apply(this, args);
    };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (cond()) return true;
        await sleep(25);
    }
    return cond();
}

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');
    refuseEdge();
    // Expo's push door answered here: the owners' pushes are counted, and nothing leaves this machine.
    const pushes: Array<{ k: string; title: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
        if (url.hostname === 'exp.host') {
            const batch = JSON.parse(String(init?.body ?? '[]')) as any[];
            for (const m of batch) pushes.push({ k: String(m?.data?.k ?? ''), title: String(m?.title ?? '') });
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200 });
        }
        throw new Error(`nothing leaves this machine (${url.hostname})`);
    }) as typeof fetch;

    // The address service: a stub on loopback that releases and grants whatever it is asked, signs nothing back.
    const registrar = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body: any = {};
            try { body = JSON.parse(raw); } catch { /* none */ }
            res.setHeader('Content-Type', 'application/json');
            if (req.url?.includes('/offline')) return res.end(JSON.stringify({ status: 'released', name: body.name ?? null }));
            if (req.url?.includes('/claim')) return res.end(JSON.stringify({ status: 'live', name: body.name, hostname: null }));
            res.statusCode = 404;
            res.end('{"error":"not found"}');
        });
    });
    await new Promise<void>((r) => registrar.listen(0, '127.0.0.1', () => r()));
    process.env.REGISTRAR_URL = `http://127.0.0.1:${(registrar.address() as any).port}`;

    // The owners' channel: an ntfy on loopback, one topic per path.
    const received: Array<{ topic: string; title: string; body: string }> = [];
    const channel = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            received.push({ topic: req.url ?? '', title: String(req.headers.title ?? ''), body: raw });
            res.end('{}');
        });
    });
    await new Promise<void>((r) => channel.listen(0, '127.0.0.1', () => r()));
    const channelBase = `http://127.0.0.1:${(channel.address() as any).port}`;

    const { initStateEngine, seedGenesisMember, grantNodeRole, updateNodeConfig } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig, getLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { mintHandshakeToken, consumeHandshakeToken, createPasswordSession, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { noteNameStandingForTests } = await import('./services/registrar-name-watch.js');
    const { recordRegistrarAnswer } = await import('./engine/registrar-names.js');
    const { noteSecurityEvent } = await import('./services/security-signal.js');
    const alerts = await import('./services/alerts.js');
    const { leaveRestoreNotice, startRestoreNoticeWatch } = await import('./services/restore-points.js');
    const { initTls } = await import('./services/tls.js');
    const { startP2P, getP2PNode } = await import('./p2p.js');
    const https = await import('./https-server.js');

    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const PW = 'Owner-Alerts-Pw-5521!';
    const { hash, salt } = hashPassword(PW);
    const COMMUNITY = 'Riverbend Commons';
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, communityName: COMMUNITY, callsign: 'RIVBND' } as any);

    const pubkey = () => crypto.randomBytes(32).toString('hex');
    const owner = pubkey();
    const admin = pubkey();
    const plainA = pubkey();
    const plainB = pubkey();
    const branchRoot = pubkey();
    const branchKid = pubkey();
    const CALLSIGNS = ['Zyxolive', 'Qadmintx', 'Plainmemq', 'Plainmemr', 'Branchrootw', 'Branchkidv'];
    seedGenesisMember(owner, CALLSIGNS[0]);
    const join = (pk: string, callsign: string, by: string) => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(pk, callsign, new Date().toISOString(), by, 'TEST');
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    };
    join(admin, CALLSIGNS[1], owner);
    join(plainA, CALLSIGNS[2], owner);
    join(plainB, CALLSIGNS[3], owner);
    join(branchRoot, CALLSIGNS[4], owner);
    join(branchKid, CALLSIGNS[5], branchRoot);
    grantNodeRole(admin, 'admin', owner);
    putPushTokenRow(owner, 'ExponentPushToken[owner-alerts]', 'android');
    const ownerPushes = () => pushes.filter((p) => p.k === 'owner.alert').length;
    const session = (pk: string, role: 'owner' | 'admin', phone = false) => {
        const ex = consumeHandshakeToken(mintHandshakeToken(pk, role).handshakeToken, Date.now(), phone ? { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS } : {});
        if (!ex.ok || ex.role !== role) throw new Error(`setup: no ${role} session: ${ex.error}`);
        return ex.sessionId!;
    };
    const asOwner = { 'x-admin-session': session(owner, 'owner') };
    const asAdmin = { 'x-admin-session': session(admin, 'admin') };
    /** The owner's phone, Manage pressed just now: the fresh proof. */
    const ownerPhone = () => ({ 'x-admin-session': session(owner, 'owner', true) });

    // The node key the address service's requests are signed with (registrar-client.ts): libp2p on ephemeral ports.
    await startP2P(0, 0);
    await initTls();
    const port = await https.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    async function call(route: string, headers: Record<string, string>, body: unknown = {}) {
        resetAdminAuthTarpit();
        https.resetAdminRateLimit();
        const res = await localFetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        let json: any = null;
        try { json = await res.json(); } catch { /* none */ }
        return { status: res.status, json };
    }

    // Every line the book kept, and every message the channel got, for step 8.
    const everything: string[] = [];
    const book = () => alerts.getAlertsStatus() as any;
    const lines = (key: string) => (book().history as Array<{ key: string; detail: string; priority: number; high?: boolean }>).filter((e) => e.key === key);
    const fresh = () => {
        everything.push(JSON.stringify(book()));
        alerts.resetAlertsForTests();
    };
    const setChannel = (topic: string) => alerts.updateAlertChannel({ url: `${channelBase}/${topic}`, format: 'ntfy' });
    assert((setChannel('owners') as any).ok === true, 'setup: the owners\' channel is a loopback ntfy');
    fresh();

    // ── 1. sec.restore ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 1. sec.restore —');
    const announced: string[] = [];
    const bootDeps = { announce: (title: string, body: string) => { announced.push(`${title}\n${body}`); }, log: () => undefined };
    leaveRestoreNotice({ kind: 'restore', at: new Date().toISOString(), madeAt: '2026-10-01T03:00:00.000Z', point: 'point-a', by: 'shell' } as any);
    startRestoreNoticeWatch(bootDeps);
    await sleep(50);
    let r = lines('sec.restore');
    assert(r.length === 1 && /2026-10-01/.test(r[0].detail) && /from the server's shell/.test(r[0].detail) && /restore point was kept/i.test(r[0].detail),
        `1a. a restore from the server's shell: sec.restore told once at the next boot, with the backup's date and "from the server's shell" (${JSON.stringify(r.map((e) => e.detail))})`);
    assert(r.length === 1 && (r[0].high === true || r[0].priority >= 4), `1a. sec.restore is high (${JSON.stringify(r[0] ?? null)})`);
    assert(announced.length === 1, `1a. the members' critical announcement is made once too (${announced.length})`);
    assert(await until(() => received.some((m) => m.topic === '/owners' && /restored/i.test(m.title + m.body))), '1a. it reached the owners\' channel');
    fresh();
    leaveRestoreNotice({ kind: 'roll-back', at: new Date().toISOString(), madeAt: '2026-10-05T03:00:00.000Z', point: 'point-b', by: 'owner' } as any);
    startRestoreNoticeWatch(bootDeps);
    startRestoreNoticeWatch(bootDeps);
    await sleep(50);
    r = lines('sec.restore');
    assert(r.length === 1 && /rolled back/.test(r[0].detail) && /2026-10-05/.test(r[0].detail) && /by an owner/.test(r[0].detail),
        `1b. an owner's roll-back: sec.restore told once, "by an owner" (${JSON.stringify(r.map((e) => e.detail))})`);
    // The restore and roll-back paths leave who did it in the notice: the shell's runs pass no restart (restartAfterMs null).
    const backupSource = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'routes', 'backup.ts'), 'utf8');
    const byShell = backupSource.match(/leaveRestoreNotice\(\{[^}]*by: restartAfterMs === null \? 'shell' : 'owner'/g) ?? [];
    assert(byShell.length === 2, `1c. restoreFromTar and rollBackTo both leave "by" in the notice: the shell's (no restart) or an owner's (${byShell.length})`);
    fresh();
    // The refused upload of another community's backup (S2b's 409 otherCommunity) is counted, never whose file.
    assert(/otherCommunity: true[\s\S]{0,40}/.test(backupSource)
        && /noteSecurityEvent\(\{\s*key: 'sec\.restore', detail: '', perDay: OWNER_ALERT_WORDS\.otherCommunityRefused, foldAs: OWNER_ALERT_WORDS\.otherCommunityRefusedMore/.test(backupSource),
        '1d. the 409 otherCommunity refusal notes sec.restore with the count of the last day, and its own fold words');
    const { OWNER_ALERT_WORDS } = await import('./services/security-signal.js');
    noteSecurityEvent({ key: 'sec.restore', detail: '', perDay: OWNER_ALERT_WORDS.otherCommunityRefused, actor: 'restore:other-community', actorRole: 'uploader' });
    noteSecurityEvent({ key: 'sec.restore', detail: '', perDay: OWNER_ALERT_WORDS.otherCommunityRefused, actor: 'restore:other-community', actorRole: 'uploader' });
    await sleep(50);
    r = lines('sec.restore');
    assert(r.length === 1 && r[0].detail === '2 backups from another community were refused in the last day.',
        `1d. two refusals: one line, "2 backups from another community were refused in the last day." (${JSON.stringify(r.map((e) => e.detail))})`);
    fresh();
    // The route's own note (words and fold words), 5 times: 3 told as one line, 2 folded; the hour's line says refusals.
    const refusal = () => noteSecurityEvent({ key: 'sec.restore', detail: '', perDay: OWNER_ALERT_WORDS.otherCommunityRefused, foldAs: OWNER_ALERT_WORDS.otherCommunityRefusedMore, actor: 'restore:other-community', actorRole: 'uploader' });
    for (let i = 0; i < 5; i++) refusal();
    await sleep(100);
    alerts.setAlertsClockForTests(61 * 60_000);
    await alerts.checkServerAlerts();
    const more1 = lines('sec.more');
    assert(lines('sec.restore').length === 1 && more1.length === 1 && /^2 more backups from another community were refused/.test(more1[0].detail) && !/see who|change/.test(more1[0].detail),
        `1e. past the bound the hour's line says refusals, not changes, and no "see who" (${JSON.stringify([...lines('sec.restore'), ...more1].map((e) => e.detail))})`);
    // A rolling day (#2033 N8): 23 h on the count goes on; 25 h after the first ones it starts again.
    alerts.setAlertsClockForTests(23 * 60 * 60_000);
    refusal();
    await sleep(50);
    const at23 = lines('sec.restore').map((e) => e.detail);
    alerts.setAlertsClockForTests(25 * 60 * 60_000 + 60_000);
    refusal();
    await sleep(50);
    const at25 = lines('sec.restore').map((e) => e.detail);
    alerts.setAlertsClockForTests(0);
    assert(at23.some((d) => d === '6 backups from another community were refused in the last day.') && at25.length === 1 && at25[0] === '2 backups from another community were refused in the last day.',
        `1f. "in the last day" is the last 24 hours, not the UTC day (${JSON.stringify({ at23, at25 })})`);
    fresh();
    alerts.resetAlertsForTests();
    leaveRestoreNotice({ kind: 'restore', at: new Date().toISOString(), madeAt: null, point: 'point-c', by: 'shell' } as any);
    startRestoreNoticeWatch(bootDeps);
    await sleep(50);
    r = lines('sec.restore');
    assert(r.length === 1 && r[0].detail === "A backup was restored from the server's shell. A restore point was kept.",
        `1g. an unlocked shell restore, its date unknown: "A backup was restored from the server's shell." (${JSON.stringify(r.map((e) => e.detail))})`);
    fresh();

    // ── 2. sec.name widened ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. sec.address —');
    const notices = () => (db.prepare(`SELECT title, body FROM push_notices WHERE kind = 'community.notice' ORDER BY rowid`).all() as Array<{ title: string; body: string }>);
    let n0 = notices().length;
    updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any);
    const claimed = await call('/api/local/admin/public-address/claim', ownerPhone(), { name: 'newvale', mode: 'direct' });
    let n = lines('sec.address');
    const told2a = notices().slice(n0);
    assert(claimed.status === 200 && n.length === 1 && /address was changed, by an owner/.test(n[0].detail) && (n[0].high === true || n[0].priority >= 4),
        `2a. a new name claimed over the live one: sec.address told once, high, "changed, by an owner" (${claimed.status} ${JSON.stringify(claimed.json?.error ?? '')} ${JSON.stringify(n.map((e) => e.detail))})`);
    assert(lines('sec.name').length === 0, `2a. not on sec.name, the hijack's row (${lines('sec.name').length})`);
    assert(told2a.length === 1 && told2a[0].body === "This community's address changed. Open the app to follow it.",
        `2c. the members get the critical announcement "This community's address changed. Open the app to follow it." (${JSON.stringify(told2a)})`);
    fresh();
    n0 = notices().length;
    updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any);
    const offline = await call('/api/local/admin/public-address/offline', ownerPhone(), {});
    n = lines('sec.address');
    const told2b = notices().slice(n0);
    assert(offline.status === 200 && n.length === 1 && /taken offline, by an owner/.test(n[0].detail) && lines('sec.name').length === 0,
        `2b. the address taken offline: sec.address told once, "taken offline, by an owner" (${offline.status} ${JSON.stringify(offline.json?.error ?? '')} ${JSON.stringify(n.map((e) => e.detail))})`);
    assert(told2b.length === 1 && told2b[0].body === "This community's address was taken offline by an owner. Ask your owners for the new one.",
        `2b. the members are told it was taken offline, and to ask their owners (${JSON.stringify(told2b)})`);
    fresh();
    n0 = notices().length;
    updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'pending' } } as any);
    const offlineUnused = await call('/api/local/admin/public-address/offline', ownerPhone(), {});
    assert(offlineUnused.status === 200 && notices().length === n0 && lines('sec.address').length === 1,
        `2c. an address that was never live taken offline: the owners told, the members not (${offlineUnused.status}, ${notices().length - n0} announcements)`);
    const words2 = received.filter((m) => /taken offline|address was changed/.test(m.body)).map((m) => m.title);
    assert(words2.length >= 2 && words2.every((t) => /its address changed/.test(t) && !/not its own/.test(t)),
        `2d. an owner's act is titled "its address changed", never "not its own" (${JSON.stringify(words2)})`);
    fresh();
    // A real hijack inside the same day as an owner's address act still pushes the owners (#2033 B1, the review's P1).
    recordRegistrarAnswer({ status: 'live', name: 'hijackvale', hostname: 'hijackvale.beanpool.org' } as any, 'claim');
    updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any);
    await call('/api/local/admin/public-address/offline', ownerPhone(), {});
    await sleep(100);
    // The owners' push for it, by the words it holds (pushOwners: the row's title), not any push in the window.
    const hijackNotices = () => (db.prepare(`SELECT COUNT(*) AS n FROM push_notices WHERE kind = 'owner.alert' AND title LIKE '%its address is not its own%'`).get() as { n: number }).n;
    const pBefore = hijackNotices();
    alerts.setAlertsClockForTests(2 * 60 * 60_000);
    noteNameStandingForTests('lost-another-key', 'hijackvale.beanpool.org');
    await sleep(300);
    await alerts.checkServerAlerts();
    await sleep(300);
    const hijackPushed = hijackNotices() - pBefore;
    const hijackActive = (book().active as any[]).some((a) => a.key === 'sec.name');
    noteNameStandingForTests('held', 'hijackvale.beanpool.org');
    alerts.setAlertsClockForTests(3 * 60 * 60_000);
    await alerts.checkServerAlerts();
    alerts.setAlertsClockForTests(0);
    assert(hijackActive && hijackPushed >= 1, `2e. a hijack 2 h after the owner took the address offline: active, and the owners pushed (${hijackActive}, ${hijackPushed} pushes)`);
    fresh();

    // ── 3. sec.keys on a recovery-code replace ─────────────────────────────────────────────────────────────────────
    console.log('\n— 3. sec.keys —');
    const first = await call('/api/local/admin/takeover/recovery-code', asOwner, {});
    assert(first.status === 200 && lines('sec.keys').length === 0, `3a. the first recovery code: made, no alert (${first.status}, ${lines('sec.keys').length})`);
    const replaced = await call('/api/local/admin/takeover/recovery-code', ownerPhone(), { replace: true });
    const k = lines('sec.keys');
    assert(replaced.status === 200 && k.length === 1 && /recovery code was replaced, by an owner/.test(k[0].detail) && /still open with the old one/.test(k[0].detail)
        && (k[0].high === true || k[0].priority >= 4),
        `3b. the recovery code replaced: sec.keys told once, high (${replaced.status} ${JSON.stringify(replaced.json?.error ?? '')} ${JSON.stringify(k.map((e) => e.detail))})`);
    fresh();

    // ── 4. sec.backups, one line each, folded hourly ───────────────────────────────────────────────────────────────
    console.log('\n— 4. sec.backups —');
    const gen = await call('/api/local/admin/replication-token/generate', asOwner);
    const clr = await call('/api/local/admin/replication-token/clear', asOwner);
    const save = await call('/api/local/admin/replication-config/save', ownerPhone(), { primaryUrl: 'https://main.example.test' });
    const keepBefore = (await call('/api/local/admin/snapshots/config', asOwner)).json?.config?.keep;
    const lower = await call('/api/local/admin/snapshots/config', ownerPhone(), { keep: 3 });
    let b = lines('sec.backups');
    const said = (re: RegExp) => b.filter((e) => re.test(e.detail)).length;
    assert(gen.status === 200 && said(/replication token was made/) === 1, `4a. a replication token made: one line (${gen.status}, ${JSON.stringify(b.map((e) => e.detail))})`);
    assert(clr.status === 200 && said(/replication token was cleared/) === 1, `4b. the replication token cleared: one line (${clr.status})`);
    assert(save.status === 200 && said(/copies from was changed/) === 1, `4c. the server a standby copies from changed: one line (${save.status} ${JSON.stringify(save.json?.error ?? '')})`);
    // Past the owner's 3 pushes in the hour: the fourth is counted, not told yet.
    assert(lower.status === 200 && keepBefore > 3 && b.length === 3 && said(/Fewer snapshots/) === 0,
        `4d. a fourth change in the hour (fewer snapshots kept, ${keepBefore} → 3) is folded, not told at once (${lower.status}, ${b.length} lines)`);
    alerts.setAlertsClockForTests(61 * 60_000);
    await alerts.checkServerAlerts();
    alerts.setAlertsClockForTests(0);
    const more = lines('sec.more');
    assert(more.length === 1 && /^1 more change by the same owner/.test(more[0].detail), `4e. when the hour ends it is told as one line: "1 more change by the same owner" (${JSON.stringify(more.map((e) => e.detail))})`);
    fresh();
    const lower2 = await call('/api/local/admin/snapshots/config', asOwner, { keep: 7 });
    const lower3 = await call('/api/local/admin/snapshots/config', ownerPhone(), { keep: 4 });
    b = lines('sec.backups');
    assert(lower2.status === 200 && lower3.status === 200 && b.length === 1 && /Fewer snapshots are kept now: 4, down from 7/.test(b[0].detail),
        `4f. fewer snapshots kept, alone in its hour: one line with the counts; keeping more says nothing (${lower2.status} ${lower3.status} ${JSON.stringify(b.map((e) => e.detail))})`);
    const routesDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'routes');
    const offboxSource = fs.readFileSync(path.join(routesDir, 'offbox-backups.ts'), 'utf8');
    assert(/key: 'sec\.backups', detail: OWNER_ALERT_WORDS\.offBoxRemoved/.test(offboxSource) && /key: 'sec\.backups', detail: OWNER_ALERT_WORDS\.offBoxChanged/.test(offboxSource),
        '4g. an off-box destination removed or changed notes sec.backups');
    assert(/key: 'sec\.backups', detail: OWNER_ALERT_WORDS\.standbyForgotten/.test(backupSource), '4h. a standby forgotten notes sec.backups');
    fresh();
    // Every lessening the fresh proof is asked for is told (#2033 N5).
    await call('/api/local/admin/snapshots/config', asOwner, { enabled: true, intervalHours: 6, keep: 7 });
    fresh();
    const off = await call('/api/local/admin/snapshots/config', ownerPhone(), { enabled: false });
    b = lines('sec.backups');
    assert(off.status === 200 && b.length === 1 && b[0].detail === 'Snapshots were turned off.', `4i. snapshots turned off: told (${off.status} ${JSON.stringify(b.map((e) => e.detail))})`);
    fresh();
    await call('/api/local/admin/snapshots/config', asOwner, { enabled: true, intervalHours: 6, keep: 7 });
    fresh();
    const often = await call('/api/local/admin/snapshots/config', ownerPhone(), { intervalHours: 1 });
    b = lines('sec.backups');
    assert(often.status === 200 && b.length === 1 && b[0].detail === 'Snapshots cover less time now.', `4j. as many kept, more often: they cover less time, told (${often.status} ${JSON.stringify(often.json?.error ?? '')} ${JSON.stringify(b.map((e) => e.detail))})`);
    fresh();
    const longer = await call('/api/local/admin/snapshots/config', ownerPhone(), { intervalHours: 400 });
    b = lines('sec.backups');
    assert(longer.status === 200 && b.length === 1 && b[0].detail === 'Snapshots cover less time now.', `4k. an interval past their age: less time, told (${longer.status} ${JSON.stringify(longer.json?.error ?? '')} ${JSON.stringify(b.map((e) => e.detail))})`);
    fresh();
    const keepLong = await call('/api/local/admin/offbox-backups/settings', asOwner, { retentionDays: 30 });
    fresh();
    const keepShort = await call('/api/local/admin/offbox-backups/settings', ownerPhone(), { retentionDays: 7 });
    b = lines('sec.backups');
    assert(keepLong.status === 200 && keepShort.status === 200 && b.length === 1 && b[0].detail === 'Off-box backups are kept for fewer days now.',
        `4l. off-box backups kept for fewer days: told (${keepLong.status} ${keepShort.status} ${JSON.stringify(keepShort.json?.error ?? '')} ${JSON.stringify(b.map((e) => e.detail))})`);
    fresh();
    await call('/api/local/admin/replication-config/save', ownerPhone(), { primaryUrl: 'https://main.example.test', primaryToken: 'standby-token-4m' });
    fresh();
    const dropTok = await call('/api/local/admin/replication-config/save', ownerPhone(), { primaryUrl: 'https://main.example.test', primaryToken: '' });
    b = lines('sec.backups');
    assert(dropTok.status === 200 && b.length === 1 && /no longer holds a replication token/.test(b[0].detail),
        `4m. a standby clearing its own replication token: told (${dropTok.status} ${JSON.stringify(b.map((e) => e.detail))})`);
    fresh();

    // ── 5. The alert channel changed or removed: the last message to the OLD channel ───────────────────────────────
    console.log('\n— 5. the old channel —');
    const toNew = await call('/api/local/admin/alerts/settings', asOwner, { url: `${channelBase}/newtopic`, format: 'ntfy' });
    assert(toNew.status === 200 && await until(() => received.some((m) => m.topic === '/owners' && /alert channel was changed/.test(m.body))),
        `5a. changed: the old channel gets "the alert channel was changed … the last alert sent here" (${toNew.status})`);
    assert(!received.some((m) => m.topic === '/newtopic' && /alert channel was changed/.test(m.body)), '5a. the new channel does not get that line');
    const removed = await call('/api/local/admin/alerts/settings', asOwner, { remove: true });
    assert(removed.status === 200 && await until(() => received.some((m) => m.topic === '/newtopic' && /alert channel was removed/.test(m.body))),
        `5b. removed: the channel that was set gets the last message (${removed.status})`);
    assert((setChannel('owners') as any).ok === true, '5c. the owners\' channel set again for the rest');
    const r5 = received.length;
    const tok = await call('/api/local/admin/alerts/settings', asOwner, { url: `${channelBase}/owners`, format: 'ntfy', token: 'tk_owner_alerts_5d' });
    await sleep(300);
    assert(tok.status === 200 && !received.slice(r5).some((m) => /last alert sent here/.test(m.body)),
        `5d. a new token for the same channel: no "last alert sent here" (${tok.status}, ${received.slice(r5).length} messages)`);
    assert((setChannel('owners') as any).ok === true, '5d. the owners\' channel set again, no token');
    fresh();

    // ── 6. sec.members counts ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 6. sec.members —');
    const p1 = await call(`/api/local/admin/users/${plainA}/prune`, asAdmin);
    const p2 = await call(`/api/local/admin/users/${plainB}/prune`, asAdmin);
    let m = lines('sec.members');
    assert(p1.status === 200 && p2.status === 200 && m.length === 1 && m[0].detail === '2 members were removed in the last day, by an admin.',
        `6a. two members removed by an admin: one counted line, "2 members were removed in the last day, by an admin." (${p1.status} ${p2.status} ${JSON.stringify(m.map((e) => e.detail))})`);
    // A repeat and a key that is no member remove no one (#2033 N1).
    const again = await call(`/api/local/admin/users/${plainA}/prune`, asAdmin);
    const ghost = await call(`/api/local/admin/users/${pubkey()}/prune`, asAdmin);
    m = lines('sec.members');
    assert(m.length === 1 && m[0].detail === '2 members were removed in the last day, by an admin.',
        `6c. a member pruned again and a key that is no member: not counted (${again.status} ${ghost.status} ${JSON.stringify(m.map((e) => e.detail))})`);
    fresh();
    // An offboard by an admin, over HTTP, then the same offboard again: one more, not two (N1, N7).
    const plainC = pubkey();
    join(plainC, 'Plainmems', owner);
    const off1 = await call(`/api/local/admin/members/${plainC}/offboard`, asAdmin, { resolution: 'prune_zero_balance' });
    const off2 = await call(`/api/local/admin/members/${plainC}/offboard`, asAdmin, { resolution: 'prune_zero_balance' });
    m = lines('sec.members');
    assert(off1.status === 200 && m.length === 1 && m[0].detail === 'A member was removed in the last day, by an admin.',
        `6d. an admin's offboard counted, its retry not (${off1.status} ${off2.status} ${JSON.stringify(off1.json?.error ?? '')} ${JSON.stringify(m.map((e) => e.detail))})`);
    fresh();
    // An owner's removals are not "by an admin" (#2033 B3): an owner's key session and the admin password say nothing.
    const plainD = pubkey();
    const plainE = pubkey();
    join(plainD, 'Plainmemt', owner);
    join(plainE, 'Plainmemu', owner);
    const ownPrune = await call(`/api/local/admin/users/${plainD}/prune`, asOwner);
    // The password opens Settings only with 2FA on: on for this one.
    turnOn2faForTests(PW);
    const pwOff = await call(`/api/local/admin/members/${plainE}/offboard`, { 'x-admin-session': createPasswordSession().sessionId }, { resolution: 'prune_zero_balance' });
    updateLocalConfig({ totpEnabled: false, totpSecret: null } as any);
    const pwPruned = (db.prepare('SELECT status FROM members WHERE public_key = ?').get(plainE) as any)?.status;
    assert(ownPrune.status === 200 && lines('sec.members').length === 0, `6e. an owner's prune: no "by an admin" line (${ownPrune.status} ${JSON.stringify(lines('sec.members').map((e) => e.detail))})`);
    assert(pwOff.status === 200 && pwPruned === 'pruned' && lines('sec.members').length === 0,
        `6f. the admin password's offboard: no "by an admin" line (${pwOff.status} ${JSON.stringify(pwOff.json?.error ?? '')} ${pwPruned} ${JSON.stringify(lines('sec.members').map((e) => e.detail))})`);
    fresh();
    const br = await call(`/api/local/admin/branches/${branchRoot}/prune`, asOwner);
    m = lines('sec.members');
    assert(br.status === 200 && m.length === 1 && /branch of invites was pruned in the last day, by an owner/.test(m[0].detail),
        `6b. a branch pruned by an owner: counted (${br.status} ${JSON.stringify(br.json?.error ?? '')} ${JSON.stringify(m.map((e) => e.detail))})`);
    fresh();
    // One admin removing 30 moderators: one sec.members line, however many (#2033 B2, the review's P9).
    const mods = Array.from({ length: 30 }, () => pubkey());
    mods.forEach((pk, i) => { join(pk, `Modqz${i}`, owner); grantNodeRole(pk, 'moderator', owner); });
    alerts.resetAlertsForTests();
    for (const pk of mods) await call(`/api/local/admin/users/${pk}/prune`, asAdmin);
    await sleep(500);
    m = lines('sec.members');
    assert(m.length === 1, `6g. 30 moderators removed by one admin: one sec.members line (${m.length}: ${JSON.stringify(m.map((e) => e.detail))})`);
    fresh();
    // The channel down, all held: an admin renames the community, then removes 60 role holders. The rename stays in the
    // history and in the channel's queue, and nothing is dropped (#2033 B2, the review's P10).
    alerts.updateAlertChannel({ url: 'http://127.0.0.1:9/down', format: 'ntfy' });
    alerts.resetAlertsForTests();
    await call('/api/local/update-identity', asAdmin, { communityName: 'Riverbend Renamed' });
    await sleep(200);
    const holders = Array.from({ length: 60 }, () => pubkey());
    holders.forEach((pk, i) => { join(pk, `Rhqa${i}`, owner); grantNodeRole(pk, 'moderator', owner); });
    for (const pk of holders) await call(`/api/local/admin/users/${pk}/prune`, asAdmin);
    await sleep(500);
    const held = book();
    assert(lines('sec.settings').length === 1 && held.dropped === 0 && lines('sec.members').length === 1,
        `6h. the channel down, an admin's rename then 60 role holders removed: the rename still there, nothing dropped, one count line (${lines('sec.settings').length} ${held.dropped} ${lines('sec.members').length} waiting ${held.waiting})`);
    await call('/api/local/update-identity', asOwner, { communityName: COMMUNITY });
    assert((setChannel('owners') as any).ok === true, '6h. the owners\' channel set again');
    fresh();

    // ── 7. sec.settings ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 7. sec.settings —');
    const NEW_CALLSIGN = 'NEWCALLX';
    const EMAIL = 'zq-contact@example.test';
    const ownRename = await call('/api/local/update-identity', asOwner, { communityName: 'Riverbend Owners' });
    assert(ownRename.status === 200 && lines('sec.settings').length === 0, `7a. the owner's own rename: no alert (${ownRename.status})`);
    const rn = await call('/api/local/update-identity', asAdmin, { communityName: COMMUNITY });
    const cs = await call('/api/local/update-identity', asAdmin, { callsign: NEW_CALLSIGN });
    const ct = await call('/api/local/update-identity', asAdmin, { contactEmail: EMAIL });
    const st = lines('sec.settings');
    assert(rn.status === 200 && cs.status === 200 && ct.status === 200 && st.length === 3
        && st.some((e) => /name was changed, by an admin/.test(e.detail)) && st.some((e) => /callsign was changed, by an admin/.test(e.detail))
        && st.some((e) => /contact details were changed, by an admin/.test(e.detail)) && st.every((e) => e.priority <= 2),
        `7b. an admin's rename, callsign and contacts: one low line each (${rn.status} ${cs.status} ${ct.status} ${JSON.stringify(st.map((e) => [e.detail, e.priority]))})`);
    await sleep(300);
    fresh();

    // ── 8. No name, key, address or contact in any alert ───────────────────────────────────────────────────────────
    console.log('\n— 8. no names —');
    await sleep(300);
    // The message's own footer, "Open Settings: <this server's Settings link>" (alerts.ts settingsLink, since S4), is the
    // owner's way back to their server, not an alert's words: left out of this check; every other line is in it.
    const words = (body: string) => body.split('\n').filter((l) => !l.startsWith('Open Settings: ')).join('\n');
    const all = everything.join('\n') + '\n' + received.map((x) => `${x.title}\n${words(x.body)}`).join('\n');
    const forbidden = [...CALLSIGNS, NEW_CALLSIGN, EMAIL, 'oldvale', 'newvale', 'main.example.test',
        ...[owner, admin, plainA, plainB, branchRoot, branchKid].flatMap((pk) => [pk, pk.slice(0, 12)])];
    const found = forbidden.filter((w) => all.includes(w));
    for (const w of found) console.error(`   ${w} in: …${all.slice(Math.max(0, all.indexOf(w) - 160), all.indexOf(w) + 60)}…`);
    assert(everything.length > 5 && received.length > 2 && found.length === 0,
        `8. no alert in the book or on the channel says a member's callsign or key, the address, the copy-from server or a contact (${found.length ? found.join(', ') : 'none'}; ${received.length} messages)`);

    // ── 9. A hostile callsign standing in for the community's name (#2033 N6) ─────────────────────────────────────
    console.log('\n— 9. the name in a title —');
    alerts.resetAlertsForTests();
    const r9 = received.length;
    await call('/api/local/update-identity', asOwner, { communityName: '' });
    const hostile = await call('/api/local/update-identity', asAdmin, { callsign: '\u001b[2J\u0007\u202eEVIL https://x.y' });
    await until(() => received.length > r9, 3000);
    const msgs9 = received.slice(r9);
    // eslint-disable-next-line no-control-regex -- the control characters are what is looked for
    assert(hostile.status === 200 && msgs9.length >= 1 && msgs9.every((x) => !/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e]/.test(x.title + x.body)),
        `9. no control or bidi character reaches a title or body (${hostile.status} ${JSON.stringify(msgs9.map((x) => x.title))})`);
    await call('/api/local/update-identity', asOwner, { communityName: COMMUNITY, callsign: 'RIVBND' });

    registrar.close();
    channel.close();
    try { await getP2PNode()?.stop(); } catch { /* stopping only */ }
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(testsPassed === testsRun ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(1);
});
