/**
 * Test Suite: the owners' alerts for owner-delete (design case 18 §7, slice S5), over the real HTTPS server through every
 * middleware a node runs, with the alert channel a loopback fake (ntfy) and the address service a loopback stub: nothing
 * leaves this machine.
 *
 *  1. sec.restore: a restore from the server's shell and an owner's roll-back each raise it once at the next boot, high,
 *     saying how ("from the server's shell" / "by an owner") and when the backup was made; the restore and roll-back paths
 *     leave that "who" in their notice; a refused upload of another community's backup is counted ("2 backups … today").
 *  2. sec.name widened: an owner takes the address offline, or claims a new name over the live one: told once, high; the
 *     members are told the address changed.
 *  3. sec.keys: replacing the recovery code is told once, high; making the first one is not.
 *  4. sec.backups: a replication token made, then cleared; the server a standby copies from changed; fewer snapshots kept:
 *     one line each. A fourth change by the same owner in the hour folds into one "1 more change" line when the hour ends.
 *  5. The alert channel changed, then removed: the last message goes to the OLD channel each time.
 *  6. sec.members: two members removed by an admin are counted ("2 members were removed today"); a branch pruned by an
 *     owner too.
 *  7. sec.settings: an admin renaming the community, its callsign or its contacts is told, low; the owner's own is not.
 *  8. No alert, in the book or on the channel, says a member's callsign or key, the address, the new callsign or a contact.
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
    const { mintHandshakeToken, consumeHandshakeToken, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
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
    assert(/otherCommunity: true[\s\S]{0,40}/.test(backupSource) && /noteSecurityEvent\(\{ key: 'sec\.restore'[^\n]*otherCommunityRefused/.test(backupSource),
        '1d. the 409 otherCommunity refusal notes sec.restore with the day\'s count');
    noteSecurityEvent({ key: 'sec.restore', detail: '', perDay: { one: 'A backup from another community was refused today.', many: '{n} backups from another community were refused today.' }, actor: 'restore:other-community', actorRole: 'uploader' } as any);
    noteSecurityEvent({ key: 'sec.restore', detail: '', perDay: { one: 'A backup from another community was refused today.', many: '{n} backups from another community were refused today.' }, actor: 'restore:other-community', actorRole: 'uploader' } as any);
    await sleep(50);
    r = lines('sec.restore');
    assert(r.some((e) => e.detail === 'A backup from another community was refused today.') && r.some((e) => e.detail === '2 backups from another community were refused today.'),
        `1d. two refusals: "2 backups from another community were refused today." (${JSON.stringify(r.map((e) => e.detail))})`);
    fresh();

    // ── 2. sec.name widened ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. sec.name —');
    updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any);
    const claimed = await call('/api/local/admin/public-address/claim', ownerPhone(), { name: 'newvale', mode: 'direct' });
    let n = lines('sec.name');
    assert(claimed.status === 200 && n.length === 1 && /address was changed, by an owner/.test(n[0].detail) && (n[0].high === true || n[0].priority >= 4),
        `2a. a new name claimed over the live one: sec.name told once, high, "changed, by an owner" (${claimed.status} ${JSON.stringify(claimed.json?.error ?? '')} ${JSON.stringify(n.map((e) => e.detail))})`);
    fresh();
    updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any);
    const offline = await call('/api/local/admin/public-address/offline', ownerPhone(), {});
    n = lines('sec.name');
    assert(offline.status === 200 && n.length === 1 && /taken offline, by an owner/.test(n[0].detail),
        `2b. the address taken offline: sec.name told once, "taken offline, by an owner" (${offline.status} ${JSON.stringify(offline.json?.error ?? '')} ${JSON.stringify(n.map((e) => e.detail))})`);
    const addressSource = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'routes', 'public-address.ts'), 'utf8');
    assert(/adminBroadcastAnnouncement\([^;]*membersAddressChanged[^;]*'critical'\)/.test(addressSource)
        && /This community's address changed\. Open the app to follow it\./.test(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'services', 'security-signal.ts'), 'utf8')),
        '2c. the members get the critical announcement "This community\'s address changed. Open the app to follow it."');
    assert(/key: 'sec\.name', detail: OWNER_ALERT_WORDS\.tunnelKey, priority: 3/.test(addressSource), '2d. a new tunnel key notes sec.name, normal');
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
    fresh();

    // ── 6. sec.members counts ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 6. sec.members —');
    const p1 = await call(`/api/local/admin/users/${plainA}/prune`, asAdmin);
    const p2 = await call(`/api/local/admin/users/${plainB}/prune`, asAdmin);
    let m = lines('sec.members');
    assert(p1.status === 200 && p2.status === 200 && m.some((e) => e.detail === 'A member was removed today, by an admin.')
        && m.some((e) => e.detail === '2 members were removed today, by an admin.'),
        `6a. two members removed by an admin: counted, "2 members were removed today, by an admin." (${p1.status} ${p2.status} ${JSON.stringify(m.map((e) => e.detail))})`);
    fresh();
    const br = await call(`/api/local/admin/branches/${branchRoot}/prune`, asOwner);
    m = lines('sec.members');
    assert(br.status === 200 && m.length === 1 && /branch of invites was pruned today, by an owner/.test(m[0].detail),
        `6b. a branch pruned by an owner: counted (${br.status} ${JSON.stringify(br.json?.error ?? '')} ${JSON.stringify(m.map((e) => e.detail))})`);
    const adminSource = fs.readFileSync(path.join(routesDir, 'admin.ts'), 'utf8');
    assert(/executeOffboard\([\s\S]{0,200}\);\s*noteSecurityEvent\(\{ key: 'sec\.members'/.test(adminSource), '6c. an offboard by an admin is counted too');
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
