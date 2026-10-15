/**
 * Test Suite: no route wipes the node or deletes a recovery point, no admin can damage it, and the rare owner actions that
 * can lose the community's data or address, or lock an owner out, ask for a fresh proof every time (design case 18,
 * scratch/global-node/DESIGN-owner-delete-fable.md §2, §5, §9 S1, and its amendment 1).
 *
 * Over the real HTTPS server, through every middleware a node runs:
 *  1. The removed routes (factory reset, snapshot delete, the legacy settings page and its script) answer 404 to the
 *     owner's password (with a code), a password session, an owner's key session from a computer and from the phone, an
 *     admin's key session, an admin-scope automation token and no credential; local-config.json and the snapshot are as
 *     they were.
 *  2. Every OWNER ONLY row: an admin's key session is refused 403 in words, an admin-scope token 403 token_not_allowed,
 *     the live state as it was; an owner gets past the gate.
 *  3. Every OWNER + FRESH PROOF row: a password session with no code 401 totpRequired, with a current code passes and the
 *     code is spent (sent again: 401); a phone hand-off whose unlock is 91 s old 403 step_up_required, a fresh one passes;
 *     a computer's key session 403 phone_required; an admin 403; an admin token 403 token_not_allowed.
 *  4. With the node's 2FA off: a password session is held at the 2FA setup card; a key session's proof refuses, never
 *     passes; the helper itself refuses a password caller (fail closed).
 *  5. The snapshot keep floor (keep 1 or 2 refused, the config as it was; 3 taken), the off-box retention floor (7 days),
 *     the gateway allow-list that would shut the caller out, mirror links owner-only, the first recovery code plain.
 *
 * Run:
 *   SERVER_SUITES_ONLY=test-owner-delete-gates node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.BACKUP_OFFBOX_RETENTION_DAYS;

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
        // Counted, and the run goes on, so a run against a server without these gates reports every hole, not the first.
        console.error(`✗ ${msg}`);
    }
}

/** Settings' probe of Cloudflare's edge (routes/public-address.ts verifyEdgeStatus), refused at once: nothing leaves. */
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

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');
    refuseEdge();

    // The address service, a stub on loopback that knows nothing: no request leaves this machine.
    const registrar = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"not found"}'); });
    });
    await new Promise<void>((r) => registrar.listen(0, '127.0.0.1', () => r()));
    process.env.REGISTRAR_URL = `http://127.0.0.1:${(registrar.address() as any).port}`;

    const { initStateEngine, seedGenesisMember, grantNodeRole, updateNodeConfig, getNodeConfig } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig, getLocalConfig, getGatewayConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit, requireFreshProof } = await import('./admin-auth.js');
    const { mintHandshakeToken, consumeHandshakeToken, createPasswordSession, backdateAdminSessionForTests, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
    const { turnOn2faForTests, ownerTokenHeaders } = await import('./admin-auth-test-harness.js');
    const snapshots: any = await import('./services/snapshot-scheduler.js');
    const { createSnapshot, listSnapshots, getAutoSnapshotConfig } = snapshots;
    const offbox: any = await import('./services/offbox-backups.js');
    const { readOffboxSettings } = offbox;
    // The floors (design case 18, A4, and amendment 1), as the server names them; 3 and 7 where it names none.
    const MIN_SNAPSHOTS_KEPT: number = snapshots.MIN_SNAPSHOTS_KEPT ?? 3;
    const MIN_OFFBOX_RETENTION_DAYS: number = offbox.MIN_OFFBOX_RETENTION_DAYS ?? 7;
    const { getConnectors } = await import('./connector-manager.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');

    initStateEngine();
    await ensureGenesis();
    // A node key, so a recovery code can be made (A11).
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const PW = 'Owner-Delete-Gates-Pw-5512!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, breakGlassMode: false } as any);

    const pubkey = () => crypto.randomBytes(32).toString('hex');
    const owner = pubkey();
    const admin = pubkey();
    seedGenesisMember(owner, 'Olive');
    let added = 0;
    const addMember = (name: string): string => {
        const pk = pubkey();
        const callsign = `${name}${++added}`;
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(pk, callsign, new Date().toISOString(), owner, 'TEST');
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
        return pk;
    };
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
        .run(admin, 'Adam', new Date().toISOString(), owner, 'TEST');
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(admin);
    grantNodeRole(admin, 'admin', owner);

    /** A key session: a computer's ("Sign in with your phone"), or the phone's Manage hand-off (its 15-minute idle limit). */
    const keySession = (pk: string, role: 'owner' | 'admin', phone = false): string => {
        const ex = consumeHandshakeToken(mintHandshakeToken(pk, role).handshakeToken, Date.now(), phone ? { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS } : {});
        if (!ex.ok || ex.role !== role) throw new Error(`setup: no ${role} session: ${ex.error}`);
        return ex.sessionId!;
    };
    const asComputer = { 'x-admin-session': keySession(owner, 'owner') };
    const asAdmin = { 'x-admin-session': keySession(admin, 'admin') };
    const asPhone = (): Record<string, string> => ({ 'x-admin-session': keySession(owner, 'owner', true) });
    const asStalePhone = (): Record<string, string> => {
        const sid = keySession(owner, 'owner', true);
        backdateAdminSessionForTests(sid, 91_000);
        return { 'x-admin-session': sid };
    };
    const asToken = ownerTokenHeaders('admin', owner);

    await initTls();
    const port = await https.startHttpsServer(0);
    const base = `https://localhost:${port}`;

    async function call(method: string, route: string, headers: Record<string, string> = {}, body?: unknown) {
        resetAdminAuthTarpit();
        https.resetAdminRateLimit();
        const init: RequestInit = { method, headers: { ...headers } };
        if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
            (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body ?? {});
        }
        const res = await localFetch(base + route, init);
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, text, json };
    }
    const short = (r: { status: number; text: string }) => `${r.status} ${r.text.slice(0, 140)}`;
    /** Refused in words: a 403 whose error is a sentence. */
    const inWords = (r: { status: number; json: any }) => r.status === 403 && typeof r.json?.error === 'string' && r.json.error.length > 20;

    // 2FA on for sections 1-3: the password path is a real owner's, with an authenticator.
    let tfa = turnOn2faForTests(PW);
    const pwSession = (): Record<string, string> => ({ 'x-admin-session': createPasswordSession().sessionId });
    const localConfigBytes = () => fs.readFileSync(path.join(dataDir!, 'local-config.json'));

    try {
        // ── 1. the removed routes ──────────────────────────────────────────────────────────────────────────────────
        console.log('\n── 1. no route wipes the node, deletes a snapshot, or serves the legacy settings page ──');
        const snap = await createSnapshot();
        assert(!!snap?.name && listSnapshots().some((s: any) => s.name === snap.name), `setup: a snapshot exists (${snap?.name})`);
        const removed: Array<[string, string, unknown]> = [
            ['POST', '/api/local/reset', {}],
            ['POST', '/api/local/admin/snapshots/delete', { name: snap.name }],
            ['GET', '/settings-legacy', undefined],
            ['GET', '/settings.js', undefined],
        ];
        const credentials: Array<[string, () => Record<string, string>]> = [
            ['the owner password with a code', () => tfa.headers()],
            ['a password session', pwSession],
            ['an owner key session (computer)', () => asComputer],
            ['an owner key session (phone, just unlocked)', asPhone],
            ['an admin key session', () => asAdmin],
            ['an admin automation token', () => asToken],
            ['no credential', () => ({})],
        ];
        const configBefore = localConfigBytes();
        for (const [method, route, body] of removed) {
            for (const [who, headers] of credentials) {
                const r = await call(method, route, headers(), body);
                assert(r.status === 404, `${method} ${route}, ${who}: 404 (${short(r)})`);
            }
        }
        // The password with a code spends codes and makes 2FA sessions, which local-config.json does not hold; a reset would
        // have dropped the password hash, the 2FA and the callsign from it.
        const configAfter = JSON.parse(localConfigBytes().toString('utf8'));
        const configWas = JSON.parse(configBefore.toString('utf8'));
        assert(configAfter.adminHash === configWas.adminHash && configAfter.totpSecret === configWas.totpSecret
            && configAfter.totpEnabled === true && configAfter.salt === configWas.salt,
            'local-config.json still holds the password, its salt and the 2FA (nothing reset)');
        assert(listSnapshots().some((s: any) => s.name === snap.name) && fs.existsSync(path.join(dataDir!, 'snapshots', snap.name)),
            'the snapshot is still there');

        // ── 2. OWNER ONLY ─────────────────────────────────────────────────────────────────────────────────────────
        console.log('\n── 2. owner-only: an admin is refused in words, an admin token by its scope, an owner passes ──');
        const mirrorAddr = 'mirror.example.invalid:4001';
        const branchRoot = addMember('Bramble');
        const ownerOnly: Array<{ what: string; method: string; route: string; body: unknown; unchanged?: () => string; ok: (r: any) => boolean }> = [
            { what: 'snapshot settings (A4)', method: 'POST', route: '/api/local/admin/snapshots/config', body: { keep: 5 },
                unchanged: () => JSON.stringify(getAutoSnapshotConfig()), ok: (r) => r.status === 200 && r.json?.config?.keep === 5 },
            { what: 'off-box settings (A6)', method: 'POST', route: '/api/local/admin/offbox-backups/settings', body: { intervalHours: 12 },
                unchanged: () => JSON.stringify(readOffboxSettings().intervalHours), ok: (r) => r.status === 200 },
            { what: 'replication token generate (A7)', method: 'POST', route: '/api/local/admin/replication-token/generate', body: {},
                unchanged: () => String(getLocalConfig().replicationTokenHash ?? ''), ok: (r) => r.status === 200 && typeof r.json?.token === 'string' },
            { what: 'replication token clear (A7)', method: 'POST', route: '/api/local/admin/replication-token/clear', body: {},
                unchanged: () => String(getLocalConfig().replicationTokenHash ?? ''), ok: (r) => r.status === 200 },
            { what: 'the server a standby copies from (A8)', method: 'POST', route: '/api/local/admin/replication-config/save', body: { primaryUrl: '' },
                unchanged: () => String(getLocalConfig().backupPrimaryUrl ?? ''), ok: (r) => r.status === 200 },
            { what: 'forget a standby (A8)', method: 'POST', route: '/api/local/admin/standby-health/forget', body: { id: 'nobody' },
                ok: (r) => r.status === 404 },
            { what: 'force a standby resync (A9)', method: 'POST', route: '/api/local/admin/replication-resync', body: {},
                ok: (r) => r.status !== 401 && r.status !== 403 },
            { what: 'add a mirror link (A10)', method: 'POST', route: '/api/local/connectors', body: { address: mirrorAddr, trustLevel: 'mirror' },
                unchanged: () => JSON.stringify(getConnectors()), ok: (r) => r.status === 200 && getConnectors().some((c: any) => c.address === mirrorAddr && c.trustLevel === 'mirror') },
            { what: 'demote a mirror link to a peer (A10)', method: 'POST', route: '/api/local/connectors', body: { address: mirrorAddr, trustLevel: 'peer' },
                unchanged: () => JSON.stringify(getConnectors()), ok: (r) => r.status === 200 },
            { what: 'a new tunnel key (B4)', method: 'POST', route: '/api/local/admin/public-address/rotate', body: {},
                ok: (r) => r.status === 409 },
            { what: 'restart the tunnel (B5)', method: 'POST', route: '/api/local/admin/public-address/restart-tunnel', body: {},
                ok: (r) => r.status !== 401 && r.status !== 403 },
            { what: 'remove an app address (B6)', method: 'POST', route: '/api/local/admin/app-addresses/remove', body: { address: 'app.example.invalid' },
                ok: (r) => r.status !== 401 && r.status !== 403 },
            { what: 'the alerts channel (C11)', method: 'POST', route: '/api/local/admin/alerts/settings', body: { remove: true },
                ok: (r) => r.status === 200 },
            { what: 'bulk post deletion (D1)', method: 'POST', route: '/api/local/admin/posts/bulk-delete', body: { postIds: ['no-such-post'] },
                ok: (r) => r.status !== 401 && r.status !== 403 },
            { what: 'a new ledger baseline (D2)', method: 'POST', route: '/api/local/admin/ledger-rebaseline', body: { reason: 'owner-delete gates suite baseline' },
                unchanged: () => JSON.stringify(db.prepare(`SELECT value FROM node_config WHERE key LIKE '%baseline%'`).all()), ok: (r) => r.status !== 401 && r.status !== 403 },
            { what: 'prune a whole invite branch (D3)', method: 'POST', route: `/api/local/admin/branches/${branchRoot}/prune`, body: {},
                unchanged: () => JSON.stringify(db.prepare(`SELECT status FROM members WHERE public_key = ?`).get(branchRoot)),
                ok: (r) => r.status !== 401 && r.status !== 403 },
        ];
        // An admin keeps peer links (only mirror is an owner's).
        const peerAddr = 'peer.example.invalid:4001';
        const adminPeer = await call('POST', '/api/local/connectors', asAdmin, { address: peerAddr, trustLevel: 'peer' });
        assert(adminPeer.status === 200 && getConnectors().some((c: any) => c.address === peerAddr && c.trustLevel === 'peer'),
            `an admin still adds a peer link (${short(adminPeer)})`);
        for (const row of ownerOnly) {
            const before = row.unchanged?.();
            const a = await call(row.method, row.route, asAdmin, row.body);
            assert(inWords(a), `${row.what}: an admin is refused in words (${short(a)})`);
            const t = await call(row.method, row.route, asToken, row.body);
            assert(t.status === 403 && t.json?.code === 'token_not_allowed', `${row.what}: an admin token is refused by its scope (${short(t)})`);
            if (row.unchanged) assert(row.unchanged() === before, `${row.what}: nothing changed on either refusal`);
            const o = await call(row.method, row.route, asComputer, row.body);
            assert(row.ok(o), `${row.what}: an owner passes the gate (${short(o)})`);
            if (row.what.startsWith('add a mirror')) {
                const adminRemove = await call('POST', '/api/local/connectors/remove', asAdmin, { address: mirrorAddr });
                assert(inWords(adminRemove) && getConnectors().some((c: any) => c.address === mirrorAddr), `an admin cannot remove the mirror link (${short(adminRemove)})`);
                const adminDisconnect = await call('POST', '/api/local/connectors/disconnect', asAdmin, { address: mirrorAddr });
                assert(inWords(adminDisconnect), `nor disconnect it (${short(adminDisconnect)})`);
            }
        }
        // Burst removal of established accounts is an owner's; the brand-new accounts of a burst stay an admin's. Bursts are
        // cleaned up where the open door is (the global profile), so for these calls this node runs that profile.
        process.env.NODE_PROFILE = 'global';
        try {
            const burstRoute = `/api/local/admin/members/${admin}/burst/remove`;
            const burst = await call('POST', burstRoute, asAdmin, { members: [], count: 0, includeEstablished: true });
            assert(inWords(burst) && /owner/i.test(burst.json?.error || ''), `burst removal with established accounts, by an admin → 403, an owner's (${short(burst)})`);
            const burstNew = await call('POST', burstRoute, asAdmin, { members: [], count: 0 });
            assert(burstNew.status !== 403 && burstNew.status !== 401, `burst removal of brand-new accounts stays an admin's: past the gate (${short(burstNew)})`);
            const burstOwner = await call('POST', burstRoute, asComputer, { members: [], count: 0, includeEstablished: true });
            assert(burstOwner.status !== 403 && burstOwner.status !== 401, `an owner removes established accounts too: past the gate (${short(burstOwner)})`);
        } finally {
            delete process.env.NODE_PROFILE;
        }

        // ── 3. OWNER + FRESH PROOF ────────────────────────────────────────────────────────────────────────────────
        console.log('\n── 3. owner + fresh proof: a current code, or Manage pressed within 90 seconds ──');
        const madeFirst = await call('POST', '/api/local/admin/takeover/recovery-code', asComputer, {});
        assert(madeFirst.status === 200 && typeof madeFirst.json?.code === 'string',
            `the FIRST recovery code stays plain: a computer's owner session makes it (${madeFirst.status})`);
        updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any);
        const firstClaim = { name: 'oldvale', mode: 'direct' };
        const sameClaim = await call('POST', '/api/local/admin/public-address/claim', asComputer, firstClaim);
        assert(sameClaim.status !== 401 && sameClaim.status !== 403, `claiming the name already held asks no proof (${short(sameClaim)})`);
        updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any);

        type Row = { what: string; method: string; route: string; body: (pw: boolean) => Record<string, unknown>; ok: (r: any) => boolean;
            keyOnly?: boolean; before?: () => void };
        const passes = (r: any) => r.status !== 401 && r.status !== 403;
        let retention = 30;
        const fresh: Row[] = [
            { what: 'replace the recovery code (A11)', method: 'POST', route: '/api/local/admin/takeover/recovery-code', body: () => ({ replace: true }),
                ok: (r) => r.status === 200 && typeof r.json?.code === 'string' },
            { what: 'take the community offline (B1)', method: 'POST', route: '/api/local/admin/public-address/offline', body: () => ({}), ok: passes,
                before: () => updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any) },
            { what: 'release a name (B2)', method: 'POST', route: '/api/local/admin/public-address/release-name', body: () => ({ name: 'sparevale' }), ok: passes },
            { what: 'claim over a different live name (B3)', method: 'POST', route: '/api/local/admin/public-address/claim', body: () => ({ name: 'newvale', mode: 'direct' }), ok: passes,
                before: () => updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any) },
            { what: 'break-glass mode (C5)', method: 'POST', route: '/api/local/admin/auth/break-glass-mode', body: () => ({ enabled: false }),
                ok: (r) => r.status === 200 && r.json?.breakGlassMode === false },
            { what: 'enrol an admin key (C6)', method: 'POST', route: '/api/local/admin/auth/enrol', body: () => ({ memberPubkey: addMember('Enrolee'), role: 'admin' }),
                ok: (r) => r.status === 200 && r.json?.role === 'admin' },
            { what: 'make a break-glass code (C7)', method: 'POST', route: '/api/local/admin/auth/break-glass/issue', body: (pw) => (pw ? { memberPubkey: owner } : {}),
                ok: (r) => r.status === 200 && typeof r.json?.breakGlassCode === 'string' },
            { what: 'grant admin (C8)', method: 'POST', route: '/api/local/admin/node-roles', body: () => ({ pubkey: addMember('Granted'), role: 'admin' }),
                ok: (r) => r.status === 200 },
            { what: 'make an automation token (C10)', method: 'POST', route: '/api/local/admin/automation-tokens', body: () => ({ name: 'suite', scope: 'read' }),
                ok: (r) => r.status === 201 && typeof r.json?.token === 'string', keyOnly: true },
            { what: 'the gateway settings (amendment 1)', method: 'POST', route: '/api/local/admin/gateway', body: () => ({ adminIpAllowlist: [] }),
                ok: (r) => r.status === 200 },
            { what: 'shorten off-box retention (amendment 1)', method: 'POST', route: '/api/local/admin/offbox-backups/settings',
                body: () => ({ retentionDays: retention - 1 }), ok: (r) => r.status === 200 && readOffboxSettings().retentionDays === --retention },
        ];
        // The 4-hour 2FA session a password sign-in hands out is no fresh proof.
        const signIn = await call('POST', '/api/local/verify-password', {}, { password: PW, totpCode: tfa.code() });
        const tfaSession: string = signIn.json?.tfaSessionToken;
        assert(signIn.status === 200 && typeof tfaSession === 'string', `setup: the password and a code sign in, with a 2FA session (${signIn.status})`);
        for (const row of fresh) {
            console.log(`  · ${row.what}`);
            const send = (headers: Record<string, string>, extra: Record<string, unknown> = {}, pw = false) => {
                row.before?.();
                return call(row.method, row.route, headers, { ...row.body(pw), ...extra });
            };
            if (!row.keyOnly) {
                const noCode = await send(pwSession(), {}, true);
                assert(noCode.status === 401 && noCode.json?.totpRequired === true, `${row.what}: a password session without a code → 401 totpRequired (${short(noCode)})`);
                const viaTfaSession = await send({ 'X-Admin-Password': PW, 'X-Admin-2FA-Session': tfaSession }, {}, true);
                assert(viaTfaSession.status === 401 && viaTfaSession.json?.totpRequired === true,
                    `${row.what}: the password with an earlier 2FA session and no code → 401 totpRequired (${short(viaTfaSession)})`);
                const code = tfa.code();
                const withCode = await send(pwSession(), { code }, true);
                assert(row.ok(withCode), `${row.what}: with a current code it goes through (${short(withCode)})`);
                const spent = await send(pwSession(), { code }, true);
                assert(spent.status === 401, `${row.what}: the same code again is spent → 401 (${short(spent)})`);
            } else {
                const pw = await send(pwSession(), { code: tfa.code() }, true);
                assert(pw.status === 403, `${row.what}: the password never does it, whatever the code (${short(pw)})`);
            }
            const stale = await send(asStalePhone());
            assert(stale.status === 403 && stale.json?.code === 'step_up_required', `${row.what}: Manage pressed 91 s ago → 403 step_up_required (${short(stale)})`);
            const phone = await send(asPhone());
            assert(row.ok(phone), `${row.what}: Manage pressed just now goes through (${short(phone)})`);
            const computer = await send(asComputer, { code: tfa.code() });
            assert(computer.status === 403 && computer.json?.code === 'phone_required', `${row.what}: a computer's session is sent to the phone → 403 phone_required (${short(computer)})`);
            const byAdmin = await send(asAdmin, { code: tfa.code() });
            // A role change by an admin goes to the engine as it always has, which refuses it (it grants only on a node with
            // no acting owner): 400 "Only an owner may grant …". Every other row: 403.
            assert(byAdmin.status === 403 || (byAdmin.status === 400 && /only an owner/i.test(byAdmin.json?.error || '')),
                `${row.what}: an admin is refused (${short(byAdmin)})`);
            const byToken = await send(asToken, { code: tfa.code() });
            assert(byToken.status === 403 && (byToken.json?.code === 'token_not_allowed' || row.keyOnly === true),
                `${row.what}: an admin token → 403 token_not_allowed (${short(byToken)})`);
        }
        // Taking a role: the DELETE carries its code as X-Fresh-Proof.
        const revokee = addMember('Revokee');
        grantNodeRole(revokee, 'admin', owner);
        const revokeNoCode = await call('DELETE', `/api/local/admin/node-roles/${revokee}/admin`, pwSession());
        assert(revokeNoCode.status === 401, `taking admin (C8), a password session without a code → 401 (${short(revokeNoCode)})`);
        const revokeComputer = await call('DELETE', `/api/local/admin/node-roles/${revokee}/admin`, asComputer);
        assert(revokeComputer.status === 403 && revokeComputer.json?.code === 'phone_required', `taking admin from a computer → 403 phone_required (${short(revokeComputer)})`);
        const revokeCode = await call('DELETE', `/api/local/admin/node-roles/${revokee}/admin`, { ...pwSession(), 'x-fresh-proof': tfa.code() });
        assert(revokeCode.status === 200, `taking admin with a current code in X-Fresh-Proof → 200 (${short(revokeCode)})`);
        // Retiring the password is a key session's alone: the phone, unlocked within 90 seconds. Last, as it ends the password.
        const retireStale = await call('POST', '/api/local/admin/auth/retire-password', asStalePhone(), { acceptOneOwner: true });
        assert(retireStale.status === 403 && retireStale.json?.code === 'step_up_required', `retire the password (C4), Manage 91 s ago → 403 step_up_required (${short(retireStale)})`);
        const retireComputer = await call('POST', '/api/local/admin/auth/retire-password', asComputer, { acceptOneOwner: true });
        assert(retireComputer.status === 403 && retireComputer.json?.code === 'phone_required', `retire the password from a computer → 403 phone_required (${short(retireComputer)})`);

        // ── 5. floors and guards ──────────────────────────────────────────────────────────────────────────────────
        console.log('\n── 5. the snapshot keep floor, the off-box retention floor, the gateway allow-list ──');
        const cfgBefore = JSON.stringify(getAutoSnapshotConfig());
        for (const keep of [1, MIN_SNAPSHOTS_KEPT - 1]) {
            const r = await call('POST', '/api/local/admin/snapshots/config', asComputer, { keep });
            assert(r.status === 400, `snapshots/config keep ${keep} → 400 (${short(r)})`);
            assert(JSON.stringify(getAutoSnapshotConfig()) === cfgBefore, `and the config as it was (keep ${keep})`);
        }
        const keep3 = await call('POST', '/api/local/admin/snapshots/config', asComputer, { keep: MIN_SNAPSHOTS_KEPT });
        assert(keep3.status === 200 && getAutoSnapshotConfig().keep === MIN_SNAPSHOTS_KEPT, `snapshots/config keep ${MIN_SNAPSHOTS_KEPT} is taken (${short(keep3)})`);
        const underFloor = await call('POST', '/api/local/admin/offbox-backups/settings', asPhone(), { retentionDays: MIN_OFFBOX_RETENTION_DAYS - 1 });
        assert(underFloor.status === 400 && readOffboxSettings().retentionDays === retention, `off-box retention under ${MIN_OFFBOX_RETENTION_DAYS} days → 400, unchanged (${short(underFloor)})`);
        const longer = await call('POST', '/api/local/admin/offbox-backups/settings', asComputer, { retentionDays: 30 });
        assert(longer.status === 200 && readOffboxSettings().retentionDays === 30, `keeping off-box backups longer asks no proof (${short(longer)})`);
        const shutOut = await call('POST', '/api/local/admin/gateway', asPhone(), { adminIpAllowlist: ['203.0.113.9'] });
        assert(shutOut.status === 400 && shutOut.json?.code === 'allowlist_excludes_you' && getGatewayConfig().adminIpAllowlist.length === 0,
            `a gateway allow-list without the caller's own address → 400, unchanged (${short(shutOut)})`);
        const garbage = await call('POST', '/api/local/admin/gateway', asPhone(), { adminIpAllowlist: '127.0.0.1' });
        assert(garbage.status === 400 && Array.isArray(getGatewayConfig().adminIpAllowlist), `an allow-list that is not a list → 400 (${short(garbage)})`);
        const withMe = await call('POST', '/api/local/admin/gateway', asPhone(), { adminIpAllowlist: ['127.0.0.1'] });
        assert(withMe.status === 200 && getGatewayConfig().adminIpAllowlist.includes('127.0.0.1'), `one that holds the caller's address is taken (${short(withMe)})`);
        const reach = await call('GET', '/api/local/admin/gateway', asComputer);
        assert(reach.status === 200, `and the owner still reaches Settings (${short(reach)})`);
        await call('POST', '/api/local/admin/gateway', asPhone(), { adminIpAllowlist: [] });

        // ── 4. 2FA off: fail closed ───────────────────────────────────────────────────────────────────────────────
        console.log('\n── 4. with the node\'s 2FA off, no proof passes for want of one ──');
        updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [] } as any);
        const held = await call('POST', '/api/local/admin/auth/break-glass-mode', pwSession(), { enabled: false, code: '123456' });
        assert(held.status === 403 && held.json?.code === 'totp_setup_required', `a password session is held at the 2FA setup card (${short(held)})`);
        const computerOff = await call('POST', '/api/local/admin/auth/break-glass-mode', asComputer, { enabled: false, code: '123456' });
        assert(computerOff.status === 403 && computerOff.json?.code === 'phone_required', `a computer's key session sending a code is still refused (${short(computerOff)})`);
        const staleOff = await call('POST', '/api/local/admin/auth/break-glass-mode', asStalePhone(), { enabled: false });
        assert(staleOff.status === 403 && staleOff.json?.code === 'step_up_required', `a stale phone session is still refused (${short(staleOff)})`);
        const ctx: any = { state: { adminRole: 'owner', isPasswordSession: true }, status: 200, body: null };
        const helper = typeof requireFreshProof === 'function' ? await requireFreshProof(ctx, '123456', 'test the helper') : true;
        assert(helper === false && ctx.status === 403 && ctx.body?.code === 'fresh_proof_needs_2fa',
            `requireFreshProof refuses a password caller when 2FA is off, where requireCurrentSecondFactor would pass (${ctx.status} ${ctx.body?.code})`);
        const tokenCtx: any = { state: { adminRole: 'owner', automationTokenId: 't', tokenOwnerRoute: true }, status: 200, body: null };
        assert(typeof requireFreshProof === 'function' && (await requireFreshProof(tokenCtx, '123456', 'x')) === false && tokenCtx.body?.code === 'token_not_allowed',
            'and any automation token, the backups scope included');

        // Last: retiring the password with Manage pressed just now goes through (it needs the owner's break-glass code).
        tfa = turnOn2faForTests(PW);
        const issued = await call('POST', '/api/local/admin/auth/break-glass/issue', asPhone(), {});
        assert(issued.status === 200, `setup: the owner makes their break-glass code (${short(issued)})`);
        const retire = await call('POST', '/api/local/admin/auth/retire-password', asPhone(), { acceptOneOwner: true });
        assert(retire.status === 200 && retire.json?.passwordRetired === true, `retire the password (C4), Manage pressed just now → 200 (${short(retire)})`);
        assert(!!getNodeConfig(), 'the node still answers');
    } finally {
        registrar.close();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ owner-delete gates PASSED.');
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
