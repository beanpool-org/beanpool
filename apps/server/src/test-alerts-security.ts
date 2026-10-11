/**
 * Test Suite: owners are alerted when someone gains power on their server (services/alerts.ts sec.* rows,
 * services/security-signal.ts; design scratch/global-node/DESIGN-alerts-fable.md §3.2, slice S4).
 *
 * The stand-in ntfy on loopback (as test-alerts.ts runs it) keeps every message; pushes are caught at the Expo door.
 * Nothing leaves this machine. Over the real HTTPS server and its middleware:
 *
 *  1. An owner grants admin through the real route: exactly one push to the owners (not to the admin, the moderator or a
 *     member) and exactly one line on the channel, naming the role and how ("by an owner"), never the member. The
 *     owners' admin queue shows the banner; an admin's doesn't. Taking it away is one more of each. A grant that changes
 *     nothing tells nothing.
 *  2. One per source, called as the server calls them: a grant by the admin password, by break-glass enrolment, a
 *     grant inside a transaction that rolled back (nothing told), the community claimed from the server, wrong claim
 *     proofs past the minute's budget, one address backing off wrong passwords and then many addresses (raised, then
 *     raised again as high; ended after an hour quiet), a break-glass code made, an owner signed out everywhere, new 2FA
 *     backup codes (through the real route), the admin password retired (through the real route), the address naming
 *     another community's key and its own again.
 *  3. Replaced: this server replaced by another with the same keys is urgent, told again a day later, and counted in
 *     the banner until an owner acknowledges it (through the real route); then resolved once, after the hold.
 *  4. Nothing per member in any payload: no callsign and no key (nor its first 12 characters) in any message the
 *     channel received, header or body, any push, any push notice kept for the phone, or any answer of the alerts routes.
 *
 * Run (as test-all does, through scripts/run-server-suites.mjs):
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-alerts-security.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_OFFBOX_') || k.startsWith('ALERTS_WEBHOOK_')) delete process.env[k];

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

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
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

interface NtfyHit { path: string; headers: http.IncomingHttpHeaders; body: string }

/** The stand-in ntfy: every POST kept, a 200 for each. */
async function startFakeNtfy() {
    const hits: NtfyHit[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"id":"x"}');
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return { hits, url: (p: string) => `http://127.0.0.1:${port}${p}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');

    const ntfy = await startFakeNtfy();
    const TOPIC = `bp-sec-${crypto.randomBytes(9).toString('hex')}`;

    const pushes: Array<{ to: string[]; k: string; i: string; title: string; body: string }> = [];
    const blocked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
        if (url.hostname === 'exp.host') {
            const batch = JSON.parse(String(init?.body ?? '[]')) as any[];
            pushes.push({ to: batch.map((m) => m.to), k: batch[0]?.data?.k, i: batch[0]?.data?.i, title: String(batch[0]?.title ?? ''), body: String(batch[0]?.body ?? '') });
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;

    const { initStateEngine, seedGenesisMember, grantNodeRole } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig, getLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { mintHandshakeToken, consumeHandshakeToken, enrolAdminOwnerKey, issueBreakGlassCode, retireBreakGlassCode } = await import('./admin-key-auth.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { getAdminQueue } = await import('./engine/admin-queue.js');
    const { burnClaimFromShell, claimLogAdmit, resetClaimBrake } = await import('./claim-code.js');
    const brake = await import('./password-brake.js');
    const { generateTotpSecret, generateTotpCode } = await import('./totp.js');
    const { readNodeIdentity } = await import('./services/takeover-envelope.js');
    const { noteNameStandingForTests } = await import('./services/registrar-name-watch.js');
    const { setSimulatedDiskUsageForTesting } = await import('./engine/storage-health.js');
    const alerts = await import('./services/alerts.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');

    initStateEngine();
    await ensureGenesis();
    // This machine's own disk may be full enough to alert: the rows here are the security ones.
    setSimulatedDiskUsageForTesting(10);
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const PW = 'Alerts-Sec-Pw-5512!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, communityName: 'Security Test Commons' });

    const pubkey = () => crypto.randomBytes(32).toString('hex');
    const owner = pubkey();
    const admin = pubkey();
    const moderator = pubkey();
    const member = pubkey();
    const helper = pubkey();
    const CALLSIGNS = ['OliveOwnerS', 'AdamAdminS', 'ModeratorMoS', 'ZedMemberS', 'HelperHalS'];
    const KEYS = [owner, admin, moderator, member, helper];
    seedGenesisMember(owner, CALLSIGNS[0]);
    for (const [pk, callsign] of [[admin, CALLSIGNS[1]], [moderator, CALLSIGNS[2]], [member, CALLSIGNS[3]], [helper, CALLSIGNS[4]]]) {
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

    await initTls();
    const port = await https.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const answers: string[] = [];
    const call = async (method: string, route: string, body: unknown, headers: Record<string, string>) => {
        resetAdminAuthTarpit();
        https.resetAdminRateLimit();
        const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
        const text = await res.text();
        if (route.includes('/alerts/')) answers.push(text);
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json, text };
    };

    let offset = 0;
    const advance = (ms: number) => { offset += ms; alerts.setAlertsClockForTests(offset); };
    const tick = () => alerts.checkServerAlerts();
    const ownerPushes = () => pushes.filter((p) => p.k === 'owner.alert');
    const topicHits = () => ntfy.hits.filter((h) => h.path === `/${TOPIC}`);
    const banner = (who: 'owner' | 'admin') => getAdminQueue(who === 'owner' ? { forOwner: true } : {}).items.find((i) => i.kind === 'server_alert')?.count ?? 0;
    const lastHistory = (key: string) => alerts.getAlertsStatus().history.find((e) => e.key === key);
    const historyOf = (key: string) => alerts.getAlertsStatus().history.filter((e) => e.key === key);

    // The setup's grants were told too (sec.role): the suite starts each step from an empty book.
    alerts.resetAlertsForTests();
    const set = await call('POST', '/api/local/admin/alerts/settings', { url: ntfy.url(`/${TOPIC}`) }, asOwner);
    assert(set.status === 200, `setup: the owner sets the channel (${set.status})`);

    // ── 1. Grant admin through the real route ───────────────────────────────────────────────────────────────────────
    const p0 = ownerPushes().length;
    const h0 = topicHits().length;
    const grant = await call('POST', '/api/local/admin/node-roles', { pubkey: helper, role: 'admin' }, asOwner);
    assert(grant.status === 200, `1. the owner grants admin through the real route (${grant.status} ${grant.json?.error ?? ''})`);
    await settle(300);
    const pushed = ownerPushes().slice(p0);
    assert(pushed.length === 1, `1. exactly one push (${pushed.length})`);
    assert(pushed[0]?.to.length === 1 && pushed[0].to[0] === 'ExponentPushToken[olive-owner]', `1. to the owners only (${JSON.stringify(pushed[0]?.to)})`);
    const lines = topicHits().slice(h0);
    assert(lines.length === 1, `1. exactly one line on the owner's channel (${lines.length})`);
    const line = lines[0];
    assert(/a role changed/.test(String(line?.headers.title ?? '')) && line?.headers.priority === '4', `1. its title says a role changed, high (${line?.headers.title} p${line?.headers.priority})`);
    assert(/Someone was made an admin, by an owner\./.test(line?.body ?? ''), `1. it names the role and how: ${JSON.stringify(line?.body.split('\n')[2])}`);
    assert(!line.body.includes(CALLSIGNS[4]) && !line.body.includes(helper.slice(0, 12)), '1. and never the member');
    assert(banner('owner') >= 1, `1. the owner's admin queue shows the banner (${banner('owner')})`);
    assert(banner('admin') === 0, `1. an admin's shows none (${banner('admin')})`);

    const again = await call('POST', '/api/local/admin/node-roles', { pubkey: helper, role: 'admin' }, asOwner);
    await settle(300);
    assert(again.status === 200 && ownerPushes().length === p0 + 1 && topicHits().length === h0 + 1, '1. a grant that changes nothing tells nothing');

    const revoke = await call('DELETE', `/api/local/admin/node-roles/${helper}/admin`, {}, asOwner);
    await settle(300);
    assert(revoke.status === 200, `1. the owner takes it away through the real route (${revoke.status})`);
    assert(ownerPushes().length === p0 + 2 && topicHits().length === h0 + 2, `1. one more push and one more line (${ownerPushes().length - p0}, ${topicHits().length - h0})`);
    assert(/An admin lost that role, by an owner\./.test(topicHits().at(-1)?.body ?? ''), '1. naming the role taken away, and how');

    // ── 2. One per source ───────────────────────────────────────────────────────────────────────────────────────────
    grantNodeRole(helper, 'moderator', 'owner:password');
    await settle();
    assert(/Someone was made a moderator, by the admin password\./.test(lastHistory('sec.role')?.detail ?? ''), `2. a grant by the admin password says so (${lastHistory('sec.role')?.detail})`);

    enrolAdminOwnerKey({ targetPubkey: helper, isBreakGlass: true, role: 'admin' });
    await settle();
    assert(/A moderator was made an admin, with a break-glass code\./.test(lastHistory('sec.role')?.detail ?? ''), `2. break-glass enrolment says so (${lastHistory('sec.role')?.detail})`);

    const roleEvents = historyOf('sec.role').length;
    try {
        db.transaction(() => {
            grantNodeRole(member, 'moderator', owner);
            throw new Error('rolled back');
        })();
    } catch { /* the point */ }
    await settle();
    assert(historyOf('sec.role').length === roleEvents, '2. a grant inside a transaction that rolled back tells nothing');
    db.transaction(() => { grantNodeRole(member, 'moderator', owner); })();
    await settle();
    assert(historyOf('sec.role').length === roleEvents + 1 && /Someone was made a moderator, by an owner\./.test(lastHistory('sec.role')!.detail),
        '2. one that committed is told once the transaction is over');

    burnClaimFromShell('no-such-claim', member);
    await settle();
    assert(/claimed with its one-time claim code, from the server/.test(lastHistory('sec.claim')?.detail ?? '') && lastHistory('sec.claim')?.priority === 4,
        `2. the community claimed: high, and how (${lastHistory('sec.claim')?.detail})`);

    resetClaimBrake();
    const t0 = Date.now();
    for (let i = 0; i < 25; i++) claimLogAdmit(t0);
    claimLogAdmit(t0 + 2 * MIN); // the next minute writes the summary of the last
    await settle();
    assert(/25 wrong claim proofs were refused in one minute/.test(lastHistory('sec.claim-guess')?.detail ?? ''), `2. wrong claim proofs past the budget, counted (${lastHistory('sec.claim-guess')?.detail})`);

    brake.resetPasswordBrake();
    for (let i = 0; i <= brake.SOURCE_FREE_FAILURES; i++) brake.notePasswordFailure('203.0.113.7');
    await settle();
    let pw = alerts.getAlertsStatus().active.find((a) => a.key === 'sec.password-burst');
    assert(!!pw && pw.priority === 3 && /6 wrong admin passwords came from one address/.test(pw.detail), `2. one address backing off: raised, default (${pw?.priority} ${pw?.detail})`);
    assert(!pw!.detail.includes('203.0.113'), '2. never the address');
    const pwEvents = historyOf('sec.password-burst').length;
    brake.notePasswordFailure('203.0.113.7');
    for (let i = 0; i < 3; i++) brake.notePasswordFailure(`198.51.100.${i}`);
    await settle();
    assert(historyOf('sec.password-burst').length === pwEvents, '2. more wrong passwords while it is raised tell nothing new');
    // Many addresses that failed, each asking again: past the node's allowance a minute.
    let nodeRefused = false;
    for (let i = 0; i < 60 && !nodeRefused; i++) {
        const k = `2001:db8:${i.toString(16)}::1`;
        brake.notePasswordFailure(k);
        const a = brake.tryAdmit(k);
        if (a !== 'wait' && !a.admitted && a.reason === 'node') nodeRefused = true;
        else if (a !== 'wait' && a.admitted) brake.settlePasswordAttempt(k, false);
    }
    await settle();
    pw = alerts.getAlertsStatus().active.find((a) => a.key === 'sec.password-burst');
    assert(nodeRefused && pw?.priority === 4 && /from many addresses/.test(pw.detail), `2. many addresses: raised again as high (${nodeRefused} ${pw?.priority})`);
    advance(HOUR + MIN);
    await tick();
    advance(16 * MIN);
    await tick();
    assert(lastHistory('sec.password-burst')?.kind === 'cleared', `2. an hour without another, then the hold: resolved (${lastHistory('sec.password-burst')?.kind})`);
    brake.resetPasswordBrake();

    issueBreakGlassCode(owner, 'a test', 'app');
    await settle();
    assert(/A new break-glass code was made for an owner, from the app/.test(lastHistory('sec.keys')?.detail ?? ''), `2. a break-glass code made (${lastHistory('sec.keys')?.detail})`);
    retireBreakGlassCode(owner);
    await settle();
    assert(/An owner signed out everywhere/.test(lastHistory('sec.keys')?.detail ?? ''), '2. an owner signed out everywhere');

    const secret = generateTotpSecret();
    updateLocalConfig({ totpEnabled: true, totpSecret: secret });
    const codes = await call('POST', '/api/local/admin/2fa/backup-codes', { code: generateTotpCode(secret) }, asOwner);
    await settle();
    assert(codes.status === 200 && /New 2FA backup codes for the admin password were made, by an owner/.test(lastHistory('sec.keys')?.detail ?? ''),
        `2. new 2FA backup codes through the real route (${codes.status} ${codes.json?.error ?? ''})`);
    updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [] });

    noteNameStandingForTests('lost-another-key');
    await settle();
    const nm = alerts.getAlertsStatus().active.find((a) => a.key === 'sec.name');
    assert(!!nm && nm.priority === 4 && /names another community's key/.test(nm.detail), `2. the address names another community's key: raised, high (${nm?.priority})`);
    noteNameStandingForTests('held');
    await settle();
    advance(16 * MIN);
    await tick();
    assert(lastHistory('sec.name')?.kind === 'cleared', `2. its own again: resolved after the hold (${lastHistory('sec.name')?.kind})`);

    // ── 3. Replaced, until acknowledged ─────────────────────────────────────────────────────────────────────────────
    alerts.resetAlertsForTests();
    const peerId = readNodeIdentity()?.peerId;
    assert(!!peerId, 'setup: this server has an identity');
    updateLocalConfig({ identityReplaced: { peerId: peerId!, epoch: 2, ownEpoch: 0, since: '2026-10-01T00:00:00.000Z', detectedAt: new Date().toISOString(), url: 'https://example.invalid' } } as any);
    const hReplaced = topicHits().length;
    await tick();
    const rep = alerts.getAlertsStatus().active.find((a) => a.key === 'sec.replaced');
    assert(!!rep && rep.priority === 5, `3. replaced: urgent (${rep?.priority})`);
    await settle(300);
    assert(topicHits().length === hReplaced + 1 && topicHits().at(-1)?.headers.priority === '5', '3. one urgent line on the channel');
    assert(!/example\.invalid/.test(topicHits().at(-1)?.body ?? ''), "3. never the other server's address");
    assert(banner('owner') === 1, `3. counted in the owners' banner (${banner('owner')})`);
    advance(24 * HOUR + MIN);
    await tick();
    assert(lastHistory('sec.replaced')?.kind === 'still', `3. told again a day later (${lastHistory('sec.replaced')?.kind})`);
    assert(banner('owner') === 1, '3. still in the banner: nobody acknowledged it');
    const ack = await call('POST', '/api/local/admin/alerts/acknowledge', {}, asOwner);
    assert(ack.status === 200 && ack.json?.replacedAcknowledged === true, `3. an owner acknowledges it through the real route (${ack.status})`);
    assert(banner('owner') === 0, `3. the banner lets it go at once (${banner('owner')})`);
    const ackAdmin = await call('POST', '/api/local/admin/alerts/acknowledge', {}, { 'x-admin-session': session(admin, 'admin') });
    assert(ackAdmin.status === 403, `3. an admin can't acknowledge (${ackAdmin.status})`);
    advance(16 * MIN);
    await tick();
    assert(lastHistory('sec.replaced')?.kind === 'cleared', '3. resolved once, after the hold');
    await tick();
    assert(historyOf('sec.replaced').filter((e) => e.kind === 'raised').length === 1, '3. and not raised again for the same replacement');
    updateLocalConfig({ identityReplaced: null } as any);

    // One-shots in the banner: counted for a day, or until acknowledged.
    grantNodeRole(helper, 'moderator', owner);
    await settle();
    assert(banner('owner') === 1, `3. a role change counts in the banner (${banner('owner')})`);
    advance(24 * HOUR + MIN);
    assert(banner('owner') === 0, '3. for a day');
    grantNodeRole(helper, 'admin', owner);
    await settle();
    await call('POST', '/api/local/admin/alerts/acknowledge', {}, asOwner);
    assert(banner('owner') === 0, '3. or until an owner acknowledges it');

    // The admin password retired, through the real route (last: it ends password sign-in).
    issueBreakGlassCode(owner, 'a test', 'app');
    const retire = await call('POST', '/api/local/admin/auth/retire-password', { acceptOneOwner: true }, asOwner);
    await settle();
    assert(retire.status === 200 && /The admin password was retired for good, by an owner/.test(lastHistory('sec.keys')?.detail ?? ''),
        `2. the admin password retired through the real route (${retire.status} ${retire.json?.error ?? ''})`);

    // ── 4. Nothing per member ───────────────────────────────────────────────────────────────────────────────────────
    await settle(300);
    // What the phone shows of an owner's push: its title, body and data. The row's recipient is whom it is for (an owner).
    const notices = db.prepare(`SELECT recipient, title, body, data FROM push_notices WHERE kind = 'owner.alert'`).all() as any[];
    assert(notices.length > 5 && notices.every((n) => n.recipient === owner), `4. ${notices.length} owner.alert notices, every one for the owner`);
    const payloads = [
        ...ntfy.hits.map((h) => JSON.stringify(h.headers) + h.body),
        ...ownerPushes().map((p) => p.title + p.body),
        ...notices.map((n) => `${n.title}\n${n.body}\n${n.data}`),
        ...answers,
        JSON.stringify(alerts.getAlertsStatus()),
    ];
    const leaks = payloads.filter((p) => CALLSIGNS.some((c) => p.includes(c)) || KEYS.some((k) => p.includes(k.slice(0, 12))));
    assert(payloads.length > 20 && leaks.length === 0, `4. ${payloads.length} payloads (${ntfy.hits.length} channel messages), none names a member or key (${leaks.length})`);
    assert(blocked.length === 0, `4. nothing off this machine was asked (${blocked.join(', ')})`);
    assert(getLocalConfig().communityName === 'Security Test Commons', 'setup unchanged');

    await ntfy.close();
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(testsPassed === testsRun ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(1);
});
