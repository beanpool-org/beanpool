/**
 * Test Suite: no route wipes the node or deletes a recovery point, no admin can damage it, and the rare owner actions that
 * can lose the community's data or address, or lock an owner out, ask for a fresh proof every time (design case 18,
 * scratch/global-node/DESIGN-owner-delete-fable.md §2, §5, §9 S1, and its amendment 1).
 *
 * Over the real HTTPS server, through every middleware a node runs:
 *  1. The removed routes (factory reset, snapshot delete, the legacy settings page and its script) answer 404 to the
 *     owner's password (with a code), a password session, an owner's key session from a computer and from the phone, an
 *     admin's key session, an admin-scope automation token and no credential; local-config.json and the snapshot are as
 *     they were. The Dockerfile puts no legacy page in the image.
 *  2. Every OWNER ONLY row: an admin's key session is refused 403 in words, an admin-scope token 403 token_not_allowed,
 *     the live state as it was; an owner gets past the gate.
 *  3. Every OWNER + FRESH PROOF row: a password session with no code 401 totpRequired, with a current code passes and the
 *     code is spent (sent again: 401); a phone hand-off whose unlock is 91 s old 403 step_up_required, a fresh one passes;
 *     a computer's key session 403 phone_required; an admin 403; an admin token 403 token_not_allowed. Removing or
 *     re-pointing an off-box destination is held on each refusal. In break-glass mode the password and an earlier 2FA
 *     session enrol no owner key; a current code does. Re-keying an owner or admin (making the code and binding it) asks
 *     the same, and each refusal leaves their key, status and role as they were; cancelling, and a member's or a
 *     moderator's re-key, ask nothing more.
 *  4. With the node's 2FA off: a password session is held at the 2FA setup card; a key session's proof refuses, never
 *     passes; the helper itself refuses a password caller (fail closed).
 *  5. The snapshot keep floor (keep 1 or 2 refused, the config as it was; 3 taken); a snapshot taken by hand (an admin,
 *     an admin or backups token, the owner's button) never pushes out a scheduled one, and the manual ones keep their own
 *     newest 3; the off-box retention floor (7 days, and a stored lower row read as 7); the standby's copy schedule
 *     (owner-only, bounded, a stored value read through the bounds); the gateway allow-list that would shut the caller
 *     out, or is no list; mirror links owner-only, the first recovery code plain.
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
import { fileURLToPath } from 'node:url';
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
    const { nodeRoleOf, revokeNodeRole } = await import('./engine/node-roles.js');
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
        const snap = await createSnapshot('scheduled');
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
        // Nor does the image carry the legacy page (#1984 review N1): a node serves public/, and the Dockerfile copies nothing
        // from apps/server/static (settings.html, settings.js) into it, so /settings.html and /settings.js are 404 there too.
        const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
        const copiesLegacy = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8').split('\n')
            .filter((l) => /^\s*COPY\b/i.test(l) && /apps\/server\/static|settings\.(html|js)\b/.test(l));
        assert(copiesLegacy.length === 0, `the Dockerfile puts no legacy settings page in the image (${copiesLegacy.join(' | ') || 'no such COPY'})`);

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
            { what: "the standby's copy schedule (#1984 review N2)", method: 'POST', route: '/api/local/admin/backup-config', body: { pullSeconds: 30 },
                unchanged: () => String(getLocalConfig().backupPullSeconds ?? ''), ok: (r) => r.status === 200 && getLocalConfig().backupPullSeconds === 30 },
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
        const adminReadsCadence = await call('POST', '/api/local/admin/backup-config', asAdmin, {});
        assert(adminReadsCadence.status === 200 && typeof adminReadsCadence.json?.status?.pullSeconds === 'number',
            `an admin still reads the standby's copy schedule (${short(adminReadsCadence)})`);
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
            keyOnly?: boolean; before?: () => void; held?: () => boolean };
        // An off-box destination set in Settings, put back as it was before each request of its rows (#1984 review N5).
        const gatesDest = { name: 'Gates store', endpoint: 'https://gates.example.invalid', bucket: 'gates-bucket', region: 'auto', prefix: 'g1',
            accessKeyId: 'AKIDGATES', secretAccessKey: 'SECRETGATES' };
        const storedDest = (): any => readOffboxSettings().destinations.find((d: any) => d.source !== 'env' && d.bucket === gatesDest.bucket);
        const putDestBack = (): void => {
            const d = storedDest();
            const r = !d ? offbox.updateOffboxSettings({ destination: gatesDest })
                : d.endpoint !== gatesDest.endpoint ? offbox.updateOffboxSettings({ destination: { ...gatesDest, id: d.id } }) : { ok: true };
            if (!r.ok || storedDest()?.endpoint !== gatesDest.endpoint) throw new Error(`setup: no off-box destination: ${r.error}`);
        };
        const destHeld = (): boolean => storedDest()?.endpoint === gatesDest.endpoint;
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
            { what: 'remove an off-box destination (amendment 1)', method: 'POST', route: '/api/local/admin/offbox-backups/settings',
                before: putDestBack, body: () => ({ removeId: storedDest()?.id }), ok: (r) => r.status === 200 && !storedDest(), held: destHeld },
            { what: 're-point an off-box destination by its id (amendment 1)', method: 'POST', route: '/api/local/admin/offbox-backups/settings',
                before: putDestBack, body: () => ({ destination: { ...gatesDest, id: storedDest()?.id, endpoint: 'https://elsewhere.example.invalid' } }),
                ok: (r) => r.status === 200 && storedDest()?.endpoint === 'https://elsewhere.example.invalid', held: destHeld },
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
            /** A row whose state can be read back: as it was after a refusal. */
            const held = (r: { status: number }, who: string) => {
                if (row.held) assert(row.held(), `${row.what}, ${who}: nothing changed (${r.status})`);
            };
            if (!row.keyOnly) {
                const noCode = await send(pwSession(), {}, true);
                assert(noCode.status === 401 && noCode.json?.totpRequired === true, `${row.what}: a password session without a code → 401 totpRequired (${short(noCode)})`);
                held(noCode, 'a password session without a code');
                const viaTfaSession = await send({ 'X-Admin-Password': PW, 'X-Admin-2FA-Session': tfaSession }, {}, true);
                assert(viaTfaSession.status === 401 && viaTfaSession.json?.totpRequired === true,
                    `${row.what}: the password with an earlier 2FA session and no code → 401 totpRequired (${short(viaTfaSession)})`);
                held(viaTfaSession, 'the password with an earlier 2FA session');
                const code = tfa.code();
                const withCode = await send(pwSession(), { code }, true);
                assert(row.ok(withCode), `${row.what}: with a current code it goes through (${short(withCode)})`);
                const spent = await send(pwSession(), { code }, true);
                assert(spent.status === 401, `${row.what}: the same code again is spent → 401 (${short(spent)})`);
                held(spent, 'a spent code');
            } else {
                const pw = await send(pwSession(), { code: tfa.code() }, true);
                assert(pw.status === 403, `${row.what}: the password never does it, whatever the code (${short(pw)})`);
            }
            const stale = await send(asStalePhone());
            assert(stale.status === 403 && stale.json?.code === 'step_up_required', `${row.what}: Manage pressed 91 s ago → 403 step_up_required (${short(stale)})`);
            held(stale, 'Manage pressed 91 s ago');
            const phone = await send(asPhone());
            assert(row.ok(phone), `${row.what}: Manage pressed just now goes through (${short(phone)})`);
            const computer = await send(asComputer, { code: tfa.code() });
            assert(computer.status === 403 && computer.json?.code === 'phone_required', `${row.what}: a computer's session is sent to the phone → 403 phone_required (${short(computer)})`);
            held(computer, "a computer's session");
            const byAdmin = await send(asAdmin, { code: tfa.code() });
            // A role change by an admin goes to the engine as it always has, which refuses it (it grants only on a node with
            // no acting owner): 400 "Only an owner may grant …". Every other row: 403.
            assert(byAdmin.status === 403 || (byAdmin.status === 400 && /only an owner/i.test(byAdmin.json?.error || '')),
                `${row.what}: an admin is refused (${short(byAdmin)})`);
            held(byAdmin, 'an admin');
            const byToken = await send(asToken, { code: tfa.code() });
            assert(byToken.status === 403 && (byToken.json?.code === 'token_not_allowed' || row.keyOnly === true),
                `${row.what}: an admin token → 403 token_not_allowed (${short(byToken)})`);
            held(byToken, 'an admin token');
        }
        if (storedDest()) offbox.updateOffboxSettings({ removeId: storedDest().id });
        // Break-glass mode changes none of that for an owner key (C6, #1984 review B2): the password with an earlier 2FA
        // session is the stolen session the row is for, on either enrolment route. The owner recovering sends a current code.
        updateLocalConfig({ breakGlassMode: true } as any);
        const lockdownOwners: string[] = [];
        try {
            for (const route of ['/api/local/admin/auth/enrol', '/api/local/admin/auth/break-glass/enrol']) {
                const target = addMember('Lockdown');
                const r = await call('POST', route, { 'X-Admin-Password': PW, 'X-Admin-2FA-Session': tfaSession }, { memberPubkey: target, role: 'owner' });
                assert(r.status === 401 && r.json?.totpRequired === true && nodeRoleOf(target) === null,
                    `break-glass mode, ${route}: the password with an earlier 2FA session and no code → 401, no role (${short(r)}; role ${nodeRoleOf(target)})`);
                const recovering = addMember('Recovering');
                const withCode = await call('POST', route, { 'X-Admin-Password': PW, 'X-Admin-TOTP': tfa.code() }, { memberPubkey: recovering, role: 'owner' });
                if (nodeRoleOf(recovering) === 'owner') lockdownOwners.push(recovering);
                assert(withCode.status === 200 && nodeRoleOf(recovering) === 'owner',
                    `break-glass mode, ${route}: the password with a current code (the owner recovering) → 200, an owner key (${short(withCode)})`);
            }
        } finally {
            updateLocalConfig({ breakGlassMode: false } as any);
            for (const pk of lockdownOwners) revokeNodeRole(pk, 'owner', owner);
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

        // Re-keying an owner or admin moves their role to the new key (#1984 confirmation R1): making the code (which holds
        // their key and suspends them) and binding it ask the same fresh proof. issue-code takes the code in its body;
        // complete's `code` is the re-key code, so there the fresh code is X-Fresh-Proof. On every refusal the target's key
        // is not held, their status and role are as they were, and no new key holds a role.
        console.log('\n── 3b. re-keying an owner or admin asks the fresh proof; a member or moderator as before ──');
        const rekeyRoute = (pk: string, step: string) => `/api/local/admin/members/${pk}/rekey/${step}`;
        const keyHeld = (pk: string) => !!db.prepare("SELECT 1 FROM invalidated_keys WHERE public_key = ? AND reason = 'rekey_pending'").get(pk);
        const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as any)?.status ?? null;
        // The node_roles row itself: nodeRoleOf counts only an active member's, and a re-key code suspends the member.
        const roleRow = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as any)?.role ?? null;
        const pendingCode = (pk: string) => (db.prepare("SELECT code FROM rekey_requests WHERE old_pubkey = ? AND status = 'pending'").get(pk) as any)?.code ?? null;
        const wrongMatches = (pk: string) => (db.prepare("SELECT wrong_matches FROM rekey_requests WHERE old_pubkey = ? AND status = 'pending'").get(pk) as any)?.wrong_matches ?? 0;
        const coOwners: string[] = [];
        const coOwner = (name: string): string => { const pk = addMember(name); grantNodeRole(pk, 'owner', owner); coOwners.push(pk); return pk; };
        const earlier2fa = (): Record<string, string> => ({ 'X-Admin-Password': PW, 'X-Admin-2FA-Session': tfaSession });
        const askedForCode = (r: any) => r.status === 401 && r.json?.totpRequired === true;
        type Refusal = [string, () => Record<string, string>, (r: any) => boolean];
        const refusals = (proofHeader: string | null): Refusal[] => [
            ['a password session without a code', pwSession, askedForCode],
            ['the password with an earlier 2FA session and no code', earlier2fa, askedForCode],
            ["a co-owner's computer session, with a code", () => ({ ...asComputer, ...(proofHeader ? { [proofHeader]: tfa.code() } : {}) }),
                (r) => r.status === 403 && r.json?.code === 'phone_required'],
            ['Manage pressed 91 s ago', asStalePhone, (r) => r.status === 403 && r.json?.code === 'step_up_required'],
            ['an admin', () => asAdmin, inWords],
            ['an admin token', () => asToken, (r) => r.status === 403],
        ];
        const cy = coOwner('Cy');
        for (const [who, headers, refused] of refusals(null)) {
            // The computer's row sends its code in the body, as the owner's own would.
            const r = await call('POST', rekeyRoute(cy, 'issue-code'), headers(), who.includes('computer') ? { code: tfa.code() } : {});
            assert(refused(r), `re-key an owner (issue-code), ${who}: refused (${short(r)})`);
            assert(!keyHeld(cy) && statusOf(cy) === 'active' && roleRow(cy) === 'owner' && nodeRoleOf(cy) === 'owner' && pendingCode(cy) === null,
                `re-key an owner (issue-code), ${who}: their key not held, still active, still an owner, no code (${statusOf(cy)}, ${roleRow(cy)})`);
        }
        const ada = addMember('Ada');
        grantNodeRole(ada, 'admin', owner);
        const adaRefused = await call('POST', rekeyRoute(ada, 'issue-code'), earlier2fa(), {});
        assert(askedForCode(adaRefused) && !keyHeld(ada) && statusOf(ada) === 'active' && roleRow(ada) === 'admin',
            `re-key an admin (issue-code), the password with an earlier 2FA session and no code → 401, nothing changed (${short(adaRefused)})`);
        const cyIssued = await call('POST', rekeyRoute(cy, 'issue-code'), pwSession(), { code: tfa.code() });
        const rkCode: string = cyIssued.json?.code;
        assert(cyIssued.status === 200 && typeof rkCode === 'string' && keyHeld(cy) && pendingCode(cy) === rkCode,
            `re-key an owner (issue-code), the password with a current code → 200, the code made (${short(cyIssued)})`);
        const newCy = pubkey();
        for (const [who, headers, refused] of refusals('x-fresh-proof')) {
            const r = await call('POST', rekeyRoute(cy, 'complete'), headers(), { code: rkCode, newPubkey: newCy });
            assert(refused(r), `re-key an owner (complete), ${who}: refused (${short(r)})`);
            assert(roleRow(cy) === 'owner' && roleRow(newCy) === null && statusOf(newCy) === null && pendingCode(cy) === rkCode,
                `re-key an owner (complete), ${who}: the role stays on their key, the new key is nobody, the code still waits (${roleRow(cy)}, ${roleRow(newCy)})`);
        }
        // By the number on their phone too, and a refused bind counts no wrong number against the code.
        const byMatch = await call('POST', rekeyRoute(cy, 'complete'), earlier2fa(), { code: rkCode, match: '42' });
        assert(askedForCode(byMatch) && wrongMatches(cy) === 0 && pendingCode(cy) === rkCode,
            `re-key an owner (complete by the number), the password with an earlier 2FA session → 401, no try counted (${short(byMatch)})`);
        const bound = await call('POST', rekeyRoute(cy, 'complete'), { ...pwSession(), 'x-fresh-proof': tfa.code() }, { code: rkCode, newPubkey: newCy });
        assert(bound.status === 200 && roleRow(newCy) === 'owner' && nodeRoleOf(newCy) === 'owner' && roleRow(cy) === null,
            `re-key an owner (complete), a current code in X-Fresh-Proof → 200, the owner role on the new key (${short(bound)})`);
        coOwners.push(newCy);
        // The real owner on their phone, Manage pressed just now: both steps go through.
        const dee = coOwner('Dee');
        const deeIssued = await call('POST', rekeyRoute(dee, 'issue-code'), asPhone(), {});
        const newDee = pubkey();
        const deeBound = await call('POST', rekeyRoute(dee, 'complete'), asPhone(), { code: deeIssued.json?.code, newPubkey: newDee });
        assert(deeIssued.status === 200 && deeBound.status === 200 && nodeRoleOf(newDee) === 'owner' && roleRow(dee) === null,
            `re-key an owner from the phone, Manage pressed just now → 200, 200, the role moves (${short(deeIssued)}; ${short(deeBound)})`);
        coOwners.push(newDee);
        // Cancelling gives back: the step-up, as before, and the co-owner is as they were.
        const eve = coOwner('Eve');
        const eveIssued = await call('POST', rekeyRoute(eve, 'issue-code'), asPhone(), {});
        const eveCancel = await call('POST', rekeyRoute(eve, 'cancel'), asComputer, {});
        assert(eveIssued.status === 200 && eveCancel.status === 200 && !keyHeld(eve) && statusOf(eve) === 'active' && nodeRoleOf(eve) === 'owner',
            `cancelling an owner's re-key code from a computer still goes through, and gives back (${short(eveCancel)})`);
        // A member's or a moderator's re-key asks nothing more: an admin's computer, and the password with its 2FA session.
        const mo = addMember('Mo');
        const mod = addMember('Moddy');
        grantNodeRole(mod, 'moderator', owner);
        for (const [what, target, headers, roleAfter] of [
            ['a member, by an admin', mo, () => asAdmin, null],
            ['a moderator, by an admin', mod, () => asAdmin, 'moderator'],
            ['a member, by the password with an earlier 2FA session', addMember('Mae'), earlier2fa, null],
        ] as Array<[string, string, () => Record<string, string>, string | null]>) {
            const i = await call('POST', rekeyRoute(target, 'issue-code'), headers(), {});
            const nk = pubkey();
            const c = await call('POST', rekeyRoute(target, 'complete'), headers(), { code: i.json?.code, newPubkey: nk });
            assert(i.status === 200 && c.status === 200 && statusOf(nk) === 'active' && roleRow(nk) === roleAfter,
                `re-key ${what}: no proof asked, 200 and 200 (${short(i)}; ${short(c)}; role ${roleRow(nk)})`);
        }
        for (const pk of [...coOwners, ada]) if (roleRow(pk)) revokeNodeRole(pk, roleRow(pk), owner);
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
        // A snapshot taken by hand never pushes out a scheduled one (#1984 review B1): `keep` counts the scheduler's own.
        const keepNow: number = getAutoSnapshotConfig().keep;
        const MANUAL_KEPT: number = snapshots.MANUAL_SNAPSHOTS_KEPT ?? 3;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        // The scheduler's own, named to the second.
        for (let i = 0; i < keepNow; i++) { await sleep(1100); createSnapshot('scheduled'); }
        const scheduled: string[] = listSnapshots().filter((s: any) => !s.manual).map((s: any) => s.name);
        assert(scheduled.length === keepNow, `setup: ${keepNow} scheduled snapshots (${scheduled.length})`);
        const onDisk = (name: string) => listSnapshots().some((s: any) => s.name === name) && fs.existsSync(path.join(dataDir!, 'snapshots', name));
        // The same file, not only the same name: a snapshot taken in the same second as a scheduled one, under its name,
        // would write over it.
        const identity = (name: string) => {
            try { const st = fs.statSync(path.join(dataDir!, 'snapshots', name)); return `${st.ino}:${st.mtimeMs}:${st.size}`; } catch { return 'gone'; }
        };
        const scheduledWas = new Map(scheduled.map((n) => [n, identity(n)]));
        const takers: Array<[string, Record<string, string>, number]> = [
            ['an admin key session', asAdmin, keepNow + 2],
            ['an admin-scope automation token', asToken, keepNow + 2],
            ['a backups-scope automation token', ownerTokenHeaders('backups', owner), keepNow + 2],
            ['the owner pressing Take snapshot', asComputer, 5],
        ];
        for (const [who, headers, times] of takers) {
            const answers: number[] = [];
            const made: string[] = [];
            // A second apart, as the scheduler names its own to the second: each one a new name on any server.
            for (let i = 0; i < times; i++) {
                await sleep(1100);
                const r = await call('POST', '/api/local/admin/snapshots/create', headers, {});
                answers.push(r.status);
                if (typeof r.json?.snapshot?.name === 'string') made.push(r.json.snapshot.name);
            }
            assert(answers.every((a) => a === 200), `${who} takes ${times} snapshots (${answers.join(', ')})`);
            const left = scheduled.filter((n) => onDisk(n) && identity(n) === scheduledWas.get(n));
            assert(left.length === scheduled.length, `${who}, ${times} times: every scheduled snapshot is still there, as it was (${left.length} of ${scheduled.length})`);
            const manual = listSnapshots().filter((s: any) => s.manual === true).map((s: any) => s.name);
            assert(manual.length === MANUAL_KEPT && made.length === times && made.slice(-MANUAL_KEPT).every((n) => manual.includes(n)),
                `and the ones taken by hand keep their own newest ${MANUAL_KEPT} (${manual.length} on disk, ${new Set(made).size} distinct made)`);
        }
        const manualNow: string[] = listSnapshots().filter((s: any) => s.manual === true).map((s: any) => s.name);
        const expired = snapshots.expireSnapshots();
        assert(expired === 0 && scheduled.every(onDisk) && manualNow.every(onDisk), `the hourly expiry keeps them all (${expired} removed)`);
        await sleep(1100);
        const nextScheduled = createSnapshot('scheduled');
        assert(onDisk(nextScheduled.name) && !onDisk(scheduled[scheduled.length - 1]) && scheduled.slice(0, -1).every(onDisk) && manualNow.every(onDisk),
            "the scheduler's own next snapshot pushes out its oldest scheduled one, and no manual one");
        const oldManual: string | undefined = manualNow[manualNow.length - 1];
        const fifteenDaysAgo = (Date.now() - 15 * 86_400_000) / 1000;
        if (oldManual) fs.utimesSync(path.join(dataDir!, 'snapshots', oldManual), fifteenDaysAgo, fifteenDaysAgo);
        snapshots.expireSnapshots();
        assert(!!oldManual && !onDisk(oldManual) && listSnapshots().filter((s: any) => !s.manual).length === keepNow,
            `a manual snapshot still goes at ${snapshots.SNAPSHOT_MAX_AGE_DAYS ?? 14} days; the scheduled ones stay`);
        const underFloor = await call('POST', '/api/local/admin/offbox-backups/settings', asPhone(), { retentionDays: MIN_OFFBOX_RETENTION_DAYS - 1 });
        assert(underFloor.status === 400 && readOffboxSettings().retentionDays === retention, `off-box retention under ${MIN_OFFBOX_RETENTION_DAYS} days → 400, unchanged (${short(underFloor)})`);
        const longer = await call('POST', '/api/local/admin/offbox-backups/settings', asComputer, { retentionDays: 30 });
        assert(longer.status === 200 && readOffboxSettings().retentionDays === 30, `keeping off-box backups longer asks no proof (${short(longer)})`);
        // A stored retention under the floor (saved before it, or brought back by a restore) is read as the floor, like
        // .env's and like a low snapshot keep (#1984 review N6).
        const offboxFile = path.join(dataDir!, offbox.OFFBOX_SETTINGS_FILE ?? 'offbox-backups.json');
        const storedOffbox = JSON.parse(fs.readFileSync(offboxFile, 'utf8'));
        fs.writeFileSync(offboxFile, JSON.stringify({ ...storedOffbox, retentionDays: 3 }), { mode: 0o600 });
        const lowRead = readOffboxSettings();
        assert(lowRead.retentionDays === MIN_OFFBOX_RETENTION_DAYS && lowRead.retentionFrom === 'settings',
            `a stored off-box retention of 3 days is read as ${MIN_OFFBOX_RETENTION_DAYS}, from Settings (${lowRead.retentionDays}, ${lowRead.retentionFrom})`);
        fs.writeFileSync(offboxFile, JSON.stringify(storedOffbox), { mode: 0o600 });
        // The standby's copy schedule, within bounds (#1984 review N2): 5 s to an hour between pulls, a whole copy every 0
        // (off) to 1,440 minutes; null goes back to the default.
        const cadence = () => `${getLocalConfig().backupPullSeconds ?? ''}/${getLocalConfig().backupReconcileMinutes ?? ''}`;
        const cadenceBefore = cadence();
        for (const body of [{ pullSeconds: 3_000_000 }, { pullSeconds: 4 }, { pullSeconds: 3601 }, { pullSeconds: 30.5 }, { pullSeconds: '60' },
            { reconcileMinutes: 1441 }, { reconcileMinutes: -1 }, { reconcileMinutes: 10_000_000 }]) {
            const r = await call('POST', '/api/local/admin/backup-config', asComputer, body);
            assert(r.status === 400 && /whole number/.test(r.json?.error || '') && cadence() === cadenceBefore,
                `the standby's copy schedule ${JSON.stringify(body)} → 400 in words, unchanged (${short(r)})`);
        }
        for (const body of [{ pullSeconds: 3600, reconcileMinutes: 1440 }, { pullSeconds: 5, reconcileMinutes: 0 }]) {
            const r = await call('POST', '/api/local/admin/backup-config', asComputer, body);
            assert(r.status === 200 && cadence() === `${body.pullSeconds}/${body.reconcileMinutes}`, `${JSON.stringify(body)} is taken (${short(r)})`);
        }
        updateLocalConfig({ backupPullSeconds: 3_000_000, backupReconcileMinutes: 10_000_000 } as any);
        const clamped = await call('POST', '/api/local/admin/backup-config', asAdmin, {});
        assert(clamped.json?.status?.pullSeconds === 3600 && clamped.json?.status?.reconcileMinutes === 1440,
            `a stored 3,000,000 s and 10,000,000 min are read as an hour and a day (${clamped.json?.status?.pullSeconds} s, ${clamped.json?.status?.reconcileMinutes} min)`);
        const cleared = await call('POST', '/api/local/admin/backup-config', asComputer, { pullSeconds: null, reconcileMinutes: null });
        assert(cleared.status === 200 && cadence() === '/', `null goes back to the default (${short(cleared)})`);
        const shutOut = await call('POST', '/api/local/admin/gateway', asPhone(), { adminIpAllowlist: ['203.0.113.9'] });
        assert(shutOut.status === 400 && shutOut.json?.code === 'allowlist_excludes_you' && getGatewayConfig().adminIpAllowlist.length === 0,
            `a gateway allow-list without the caller's own address → 400, unchanged (${short(shutOut)})`);
        const garbage = await call('POST', '/api/local/admin/gateway', asPhone(), { adminIpAllowlist: '127.0.0.1' });
        assert(garbage.status === 400 && garbage.json?.code === 'allowlist_not_a_list' && Array.isArray(getGatewayConfig().adminIpAllowlist),
            `an allow-list that is not a list → 400 allowlist_not_a_list, a shape error, not an exclusion (${short(garbage)})`);
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
