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
 *     moderator's re-key, ask nothing more. Removing or suspending an owner (pruning, offboarding, a branch with one in
 *     it, an emergency suspension, one through a report, cutting short one's removal) asks the same, and each refusal
 *     leaves them an active owner; an owner whose key waits on a re-key code is one too (nothing held aside, no vote
 *     opened); the only owner is suspended by neither route, even with the code; an admin or a member as target asks
 *     what it asked before. Shortening the span the scheduled snapshots cover (interval × keep, at most their 14-day
 *     age: a lower keep that prunes some now, a shorter interval, turning them off, an interval past that age) asks the
 *     same; a change that keeps the span or lengthens it (keeping more, turning them on, a longer interval within the
 *     age, more often with as many more kept) does not. A mirror link (adding one, changing one, disconnecting or removing
 *     one) and the server a standby copies from ask the same (S2b, D2), connectors.json and the copy source held on
 *     every refusal. 3a: a standby whose owner's session cannot make its own key a mirror link restores no file that key
 *     signed (409 signerNotPinned), nothing moved.
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
    const { getConnectors, addConnector, removeConnector } = await import('./connector-manager.js');
    const { nodeRoleOf, revokeNodeRole } = await import('./engine/node-roles.js');
    const { removalInGraceFromBefore } = await import('./decisions-from-before-test-fixture.js');
    const { cancelRekeyCode } = await import('./engine/member-wizards.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');

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
        // The peer-link routes count against the auth limiter (15 a minute per address) too.
        pruneAuthAttempts(Date.now() + 120_000);
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
            // Keeping more: keeping fewer asks the fresh proof too (3d).
            { what: 'snapshot settings (A4)', method: 'POST', route: '/api/local/admin/snapshots/config', body: { keep: 8 },
                unchanged: () => JSON.stringify(getAutoSnapshotConfig()), ok: (r) => r.status === 200 && r.json?.config?.keep === 8 },
            { what: 'off-box settings (A6)', method: 'POST', route: '/api/local/admin/offbox-backups/settings', body: { intervalHours: 12 },
                unchanged: () => JSON.stringify(readOffboxSettings().intervalHours), ok: (r) => r.status === 200 },
            { what: 'replication token generate (A7)', method: 'POST', route: '/api/local/admin/replication-token/generate', body: {},
                unchanged: () => String(getLocalConfig().replicationTokenHash ?? ''), ok: (r) => r.status === 200 && typeof r.json?.token === 'string' },
            { what: 'replication token clear (A7)', method: 'POST', route: '/api/local/admin/replication-token/clear', body: {},
                unchanged: () => String(getLocalConfig().replicationTokenHash ?? ''), ok: (r) => r.status === 200 },
            { what: 'forget a standby (A8)', method: 'POST', route: '/api/local/admin/standby-health/forget', body: { id: 'nobody' },
                ok: (r) => r.status === 404 },
            { what: 'force a standby resync (A9)', method: 'POST', route: '/api/local/admin/replication-resync', body: {},
                ok: (r) => r.status !== 401 && r.status !== 403 },
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
        const firstClaim = { name: 'oldvale', mode: 'tunnel' };
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
        const mirrorThere = () => getConnectors().some((c: any) => c.address === mirrorAddr && c.trustLevel === 'mirror');
        let connectorsSet = '';
        const connectorsAsSet = () => JSON.stringify(getConnectors()) === connectorsSet;
        const noMirror = () => { removeConnector(mirrorAddr); connectorsSet = JSON.stringify(getConnectors()); };
        const oneMirror = () => { removeConnector(mirrorAddr); addConnector(mirrorAddr, 'mirror', 'Main'); connectorsSet = JSON.stringify(getConnectors()); };
        const fresh: Row[] = [
            { what: 'replace the recovery code (A11)', method: 'POST', route: '/api/local/admin/takeover/recovery-code', body: () => ({ replace: true }),
                ok: (r) => r.status === 200 && typeof r.json?.code === 'string' },
            { what: 'take the community offline (B1)', method: 'POST', route: '/api/local/admin/public-address/offline', body: () => ({}), ok: passes,
                before: () => updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any) },
            { what: 'release a name (B2)', method: 'POST', route: '/api/local/admin/public-address/release-name', body: () => ({ name: 'sparevale' }), ok: passes },
            { what: 'claim over a different live name (B3)', method: 'POST', route: '/api/local/admin/public-address/claim', body: () => ({ name: 'newvale', mode: 'tunnel' }), ok: passes,
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
            // A mirror link's key is one a standby's restore trusts, and the copy source feeds its database (S2b, D2): each
            // change asks the fresh proof, connectors.json and the copy source as they were on every refusal.
            { what: 'add a mirror link (A10, S2b)', method: 'POST', route: '/api/local/connectors', body: () => ({ address: mirrorAddr, trustLevel: 'mirror' }),
                before: noMirror, ok: (r) => r.status === 200 && mirrorThere(), held: () => !mirrorThere() && connectorsAsSet() },
            { what: 'change a mirror link to a peer (A10, S2b)', method: 'POST', route: '/api/local/connectors', body: () => ({ address: mirrorAddr, trustLevel: 'peer' }),
                before: oneMirror, ok: (r) => r.status === 200 && getConnectors().some((c: any) => c.address === mirrorAddr && c.trustLevel === 'peer'),
                held: () => mirrorThere() && connectorsAsSet() },
            { what: 'disconnect a mirror link (A10, S2b)', method: 'POST', route: '/api/local/connectors/disconnect', body: () => ({ address: mirrorAddr }),
                before: oneMirror, ok: (r) => r.status === 200 && r.json?.success === true, held: () => mirrorThere() && connectorsAsSet() },
            { what: 'remove a mirror link (A10, S2b)', method: 'POST', route: '/api/local/connectors/remove', body: () => ({ address: mirrorAddr }),
                before: oneMirror, ok: (r) => r.status === 200 && !getConnectors().some((c: any) => c.address === mirrorAddr), held: () => mirrorThere() && connectorsAsSet() },
            { what: 'the server a standby copies from (A8, S2b)', method: 'POST', route: '/api/local/admin/replication-config/save',
                body: () => ({ primaryUrl: 'https://elsewhere.example.invalid' }), before: () => updateLocalConfig({ backupPrimaryUrl: 'https://main.example.invalid' } as any),
                ok: (r) => r.status === 200 && getLocalConfig().backupPrimaryUrl === 'https://elsewhere.example.invalid',
                held: () => getLocalConfig().backupPrimaryUrl === 'https://main.example.invalid' },
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
        removeConnector(mirrorAddr);

        // ── 3-NB1. A request the route refuses on its own terms spends no code (#2002 confirmation review, NB1) ──
        console.log('\n── 3-NB1. a mistyped request spends no code: the proof is checked last ──');
        {
            resetAdminAuthTarpit();
            https.resetAdminRateLimit();
            const linksBefore = JSON.stringify(getConnectors());
            const code = tfa.code();
            const badUrl = await call('POST', '/api/local/connectors', pwSession(), { address: mirrorAddr, trustLevel: 'mirror', publicUrl: 'not a url', code });
            assert(badUrl.status === 400 && /publicUrl/.test(badUrl.json?.error || '') && JSON.stringify(getConnectors()) === linksBefore,
                `3-NB1. a mirror link with a mistyped public URL → 400, connectors.json unchanged (${short(badUrl)})`);
            const good = await call('POST', '/api/local/connectors', pwSession(), { address: mirrorAddr, trustLevel: 'mirror', code });
            assert(good.status === 200 && mirrorThere(), `3-NB1. …and the same code still adds it: it was not spent (${short(good)})`);
            removeConnector(mirrorAddr);

            updateLocalConfig({ backupPrimaryUrl: 'https://main.example.invalid' } as any);
            const code2 = tfa.code();
            const withPassword = await call('POST', '/api/local/admin/replication-config/save', pwSession(), { primaryUrl: 'https://elsewhere.example.invalid', primaryPassword: 'pasted by mistake', code: code2 });
            assert(withPassword.status === 400 && getLocalConfig().backupPrimaryUrl === 'https://main.example.invalid',
                `3-NB1. the copy source with the main server's password pasted → 400, unchanged (${short(withPassword)})`);
            const noUrl = await call('POST', '/api/local/admin/replication-config/save', pwSession(), { code: code2 });
            assert(noUrl.status === 400 && getLocalConfig().backupPrimaryUrl === 'https://main.example.invalid',
                `3-NB1. the copy source with no primaryUrl → 400, unchanged (${short(noUrl)})`);
            const saved = await call('POST', '/api/local/admin/replication-config/save', pwSession(), { primaryUrl: 'https://elsewhere.example.invalid', code: code2 });
            assert(saved.status === 200 && getLocalConfig().backupPrimaryUrl === 'https://elsewhere.example.invalid',
                `3-NB1. …and the same code still saves it: it was not spent (${short(saved)})`);
        }

        // ── 3-NB2. The same on every other route that asks a code: its own checks first (the proof-order sweep) ──
        // Each: the mistyped request with a current code → 4xx, nothing changed; then the SAME code (no tfa.code() between,
        // which forgets spent codes) goes through, so the refusal did not spend it.
        console.log('\n── 3-NB2. the proof-order sweep: a mistyped request spends no code on any route that asks one ──');
        {
            resetAdminAuthTarpit();
            https.resetAdminRateLimit();
            const modeNow = async () => (await call('GET', '/api/local/admin/auth/break-glass-status', pwSession())).json?.breakGlassMode;
            const modeBefore = await modeNow();
            let code = tfa.code();
            const notBoolean = await call('POST', '/api/local/admin/auth/break-glass-mode', pwSession(), { enabled: 'off', code });
            assert(notBoolean.status === 400 && (await modeNow()) === modeBefore,
                `3-NB2. break-glass mode with enabled not a boolean → 400, unchanged (${short(notBoolean)})`);
            const modeSet = await call('POST', '/api/local/admin/auth/break-glass-mode', pwSession(), { enabled: false, code });
            assert(modeSet.status === 200 && modeSet.json?.breakGlassMode === false, `3-NB2. …and the same code still sets it: it was not spent (${short(modeSet)})`);

            const gatewayBefore = JSON.stringify(getGatewayConfig());
            code = tfa.code();
            const shutsMeOut = await call('POST', '/api/local/admin/gateway', pwSession(), { adminIpAllowlist: ['203.0.113.9'], code });
            assert(shutsMeOut.status === 400 && JSON.stringify(getGatewayConfig()) === gatewayBefore,
                `3-NB2. a gateway allow-list without the caller's own address → 400, unchanged (${short(shutsMeOut)})`);
            const gatewaySet = await call('POST', '/api/local/admin/gateway', pwSession(), { adminIpAllowlist: [], code });
            assert(gatewaySet.status === 200, `3-NB2. …and the same code still saves the gateway: it was not spent (${short(gatewaySet)})`);

            code = tfa.code();
            const nobody = await call('POST', '/api/local/admin/auth/break-glass/issue', pwSession(), { code });
            assert(nobody.status === 400 && /memberPubkey/.test(nobody.json?.error || '') && !nobody.json?.breakGlassCode,
                `3-NB2. a break-glass code for nobody named → 400, none made (${short(nobody)})`);
            const misspelt = await call('POST', '/api/local/admin/auth/break-glass/issue', pwSession(), { memberPubkey: 'not a key', code });
            assert(misspelt.status === 400 && !misspelt.json?.breakGlassCode, `3-NB2. a break-glass code for a misspelt key → 400, none made (${short(misspelt)})`);
            const issued = await call('POST', '/api/local/admin/auth/break-glass/issue', pwSession(), { memberPubkey: owner, code });
            assert(issued.status === 200 && typeof issued.json?.breakGlassCode === 'string',
                `3-NB2. …and the same code still makes it: it was not spent (${short(issued)})`);

            putDestBack();
            const offboxBefore = JSON.stringify(readOffboxSettings());
            const keptDays: number = readOffboxSettings().retentionDays;
            code = tfa.code();
            const underFloorDays = await call('POST', '/api/local/admin/offbox-backups/settings', pwSession(), { retentionDays: MIN_OFFBOX_RETENTION_DAYS - 1, code });
            assert(underFloorDays.status === 400 && JSON.stringify(readOffboxSettings()) === offboxBefore,
                `3-NB2. off-box retention under the floor → 400, unchanged (${short(underFloorDays)})`);
            const unknownDest = await call('POST', '/api/local/admin/offbox-backups/settings', pwSession(), { removeId: 'd-00000000', code });
            assert(unknownDest.status === 400 && JSON.stringify(readOffboxSettings()) === offboxBefore && destHeld(),
                `3-NB2. removing an off-box destination by an unknown id → 400, unchanged (${short(unknownDest)})`);
            const unusable = await call('POST', '/api/local/admin/offbox-backups/settings', pwSession(),
                { destination: { ...gatesDest, id: storedDest()?.id, endpoint: 'not a url' }, code });
            assert(unusable.status === 400 && JSON.stringify(readOffboxSettings()) === offboxBefore && destHeld(),
                `3-NB2. re-pointing an off-box destination at an unusable endpoint → 400, unchanged (${short(unusable)})`);
            const shortened = await call('POST', '/api/local/admin/offbox-backups/settings', pwSession(), { retentionDays: keptDays - 1, code });
            assert(shortened.status === 200 && readOffboxSettings().retentionDays === keptDays - 1,
                `3-NB2. …and the same code still shortens it: it was not spent (${short(shortened)})`);
            // Back as it was: §5 reads the retention the rows above left.
            offbox.updateOffboxSettings({ retentionDays: keptDays, removeId: storedDest().id });

            updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any);
            const addressBefore = JSON.stringify((getNodeConfig() as any).publicAddress);
            code = tfa.code();
            const badLabel = await call('POST', '/api/local/admin/public-address/release-name', pwSession(), { name: 'not a name!', code });
            assert(badLabel.status === 400 && JSON.stringify((getNodeConfig() as any).publicAddress) === addressBefore,
                `3-NB2. releasing a name that is no address label → 400, unchanged (${short(badLabel)})`);
            const stored = await call('POST', '/api/local/admin/public-address/release-name', pwSession(), { name: 'oldvale', code });
            assert(stored.status === 409 && JSON.stringify((getNodeConfig() as any).publicAddress) === addressBefore,
                `3-NB2. releasing this community's own stored address → 409, unchanged (${short(stored)})`);
            // Past the proof with the same code: the address service is asked, and the stub holds nothing for this key.
            const asked = await call('POST', '/api/local/admin/public-address/release-name', pwSession(), { name: 'sparevale', code });
            assert(asked.status === 409 && /does not say this community holds/.test(asked.json?.error || ''),
                `3-NB2. …and the same code still reaches the address service: it was not spent (${short(asked)})`);

            // Enrol with a misspelt role, on a key that already holds admin (so the proof is asked): #2018 review NB2.
            const heldAdmin = addMember('Misspelt');
            grantNodeRole(heldAdmin, 'admin', owner);
            const roleNow = () => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(heldAdmin) as any)?.role ?? null;
            code = tfa.code();
            const badRole = await call('POST', '/api/local/admin/auth/enrol', pwSession(), { memberPubkey: heldAdmin, role: 'Admin', code });
            assert(badRole.status === 400 && /role must be/i.test(badRole.json?.error || '') && roleNow() === 'admin',
                `3-NB2. enrol with a misspelt role on an admin's key → 400, still an admin (${short(badRole)})`);
            const goodRole = await call('POST', '/api/local/admin/auth/enrol', pwSession(), { memberPubkey: heldAdmin, role: 'moderator', code });
            assert(goodRole.status !== 401 && goodRole.status !== 403, `3-NB2. …and the same code still gets past the proof: it was not spent (${short(goodRole)})`);

            // Claim over a different live name with a name that is no address label: #2018 review NB3.
            updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any);
            const liveBefore = JSON.stringify((getNodeConfig() as any).publicAddress);
            code = tfa.code();
            const badClaim = await call('POST', '/api/local/admin/public-address/claim', pwSession(), { name: 'new_vale', mode: 'tunnel', code });
            assert(badClaim.status === 400 && JSON.stringify((getNodeConfig() as any).publicAddress) === liveBefore,
                `3-NB2. claiming over the live name with a name that is no address label → 400, unchanged (${short(badClaim)})`);
            const goodClaim = await call('POST', '/api/local/admin/public-address/claim', pwSession(), { name: 'newvale', mode: 'tunnel', code });
            assert(goodClaim.status !== 401 && goodClaim.status !== 403, `3-NB2. …and the same code still gets past the proof: it was not spent (${short(goodClaim)})`);
            updateNodeConfig({ publicAddress: { name: 'oldvale', mode: 'direct', hostname: null, status: 'live' } } as any);
        }

        // ── 3a. A standby: a session alone cannot make its own key a pin, so a file that key signed restores nothing ──
        console.log('\n── 3a. a standby: no mirror link from a session alone, so no file signed by an unpinned key ──');
        {
            const { setNodeRole, getNodeRole } = await import('./config/node-role.js');
            const core: any = await import('@beanpool/core');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const roleWas = getNodeRole();
            const realMain = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
            const mallory = await generateKeyPair('Ed25519');
            const malloryPeer = peerIdFromPrivateKey(mallory).toString();
            setNodeRole('backup');
            try {
                // The standby's link to its real main server, set up when it was made.
                addConnector(`/ip4/127.0.0.1/tcp/4001/p2p/${realMain}`, 'mirror', 'Main');
                const linksBefore = JSON.stringify(getConnectors());
                const malloryLink = { address: `/ip4/127.0.0.1/tcp/4002/p2p/${malloryPeer}`, trustLevel: 'mirror' };
                const byComputer = await call('POST', '/api/local/connectors', asComputer, malloryLink);
                assert(byComputer.status === 403 && byComputer.json?.code === 'phone_required' && JSON.stringify(getConnectors()) === linksBefore,
                    `3a. a standby: the owner's computer session adds no mirror link of its own key → 403 phone_required, connectors.json unchanged (${short(byComputer)})`);
                const byEarlier = await call('POST', '/api/local/connectors', { 'X-Admin-Password': PW, 'X-Admin-2FA-Session': tfaSession }, malloryLink);
                assert(byEarlier.status === 401 && byEarlier.json?.totpRequired === true && JSON.stringify(getConnectors()) === linksBefore,
                    `3a. …nor the password with an earlier 2FA session → 401 totpRequired, connectors.json unchanged (${short(byEarlier)})`);
                // A file of this community, signed by that key, locked to a code the uploader made.
                const community = JSON.parse(fs.readFileSync(path.join(dataDir!, 'genesis.json'), 'utf8')).communityId;
                const theirCode = await core.createRecoveryCode(7);
                const forged = Buffer.from(await core.sealEnvelope(new Uint8Array(Buffer.from('a database of their own')), {
                    kind: 'backup', communityId: community, nodePeerId: malloryPeer,
                    recipients: { owners: [], codes: [theirCode.record] }, signingKey: new Uint8Array(mallory.raw.subarray(0, 32)),
                }));
                const rolesBefore = JSON.stringify(db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all());
                const keyBefore = fs.readFileSync(path.join(dataDir!, 'libp2p_key')).toString('hex');
                resetAdminAuthTarpit();
                https.resetAdminRateLimit();
                pruneAuthAttempts(Date.now() + 120_000);
                const res = await localFetch(base + '/api/local/admin/restore', {
                    method: 'POST', body: new Uint8Array(forged),
                    headers: { 'X-Admin-Password': PW, 'X-Admin-2FA-Session': tfaSession, 'X-Recovery-Code': theirCode.code, 'Content-Type': 'application/octet-stream' },
                });
                const restored: any = await res.json().catch(() => null);
                assert(res.status === 409 && restored?.signerNotPinned === true && restored?.signer === malloryPeer,
                    `3a. …so the file that key signed, with the uploader's own code: 409 signerNotPinned (${res.status} ${String(restored?.error).slice(0, 120)})`);
                assert(JSON.stringify(db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all()) === rolesBefore
                    && fs.readFileSync(path.join(dataDir!, 'libp2p_key')).toString('hex') === keyBefore
                    && !fs.existsSync(path.join(dataDir!, 'restore-points'))
                    && fs.readdirSync(dataDir!).filter((f) => f.startsWith('uploaded-backup') || f.startsWith('.restore')).length === 0,
                    '3a. …nothing moved: the roles, the node key, no restore point, nothing left');
            } finally {
                for (const c of getConnectors()) if (c.trustLevel === 'mirror') removeConnector(c.address);
                setNodeRole(roleWas);
            }
        }
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

        // Removing or suspending an owner asks the same fresh proof (#1984 confirmation N-1; Marty, 15 Oct, card
        // owner-stolen-session: "Yes to both"): pruning, offboarding, a branch with one in it, an emergency suspension and
        // one through a report. Each refusal leaves the owner active, with the role. An admin or a member as before.
        console.log('\n── 3c. removing or suspending an owner asks the fresh proof; an admin or a member as before ──');
        const heldAside = (pk: string) => (db.prepare('SELECT role FROM suspended_node_roles WHERE member_pubkey = ?').get(pk) as any)?.role ?? null;
        const intact = (pk: string) => statusOf(pk) === 'active' && roleRow(pk) === 'owner' && heldAside(pk) === null;
        // Olive alone is an owner here: a stolen session still can't suspend the only owner, nor can the proof.
        const soleStolen = await call('POST', `/api/local/admin/users/${owner}/suspend`, earlier2fa(), { reason: 'stolen session' });
        assert(soleStolen.status === 401 && intact(owner), `suspend the only owner, the password with an earlier 2FA session → 401, still an owner (${short(soleStolen)})`);
        const soleProof = await call('POST', `/api/local/admin/users/${owner}/suspend`, pwSession(), { reason: 'with a code', code: tfa.code() });
        assert(soleProof.status === 400 && intact(owner), `suspend the only owner, with a current code → 400, still an owner (${short(soleProof)})`);
        const reportOn = (pk: string): string => {
            const id = `rpt-${crypto.randomBytes(6).toString('hex')}`;
            db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, reason, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
                .run(id, admin, pk, 'gates suite', new Date().toISOString());
            return id;
        };
        // Nor through a report (the deciding review of #1992, NB 2): it would take her role with no vote to give it back.
        const oliveRow = db.prepare('SELECT * FROM node_roles WHERE member_pubkey = ?').get(owner) as Record<string, unknown>;
        const soleReport = await call('POST', `/api/local/admin/reports/${reportOn(owner)}/action`, pwSession(), { suspendUser: true, code: tfa.code() });
        assert(soleReport.status === 400 && intact(owner), `suspend the only owner through a report, with a current code → 400, still an owner (${short(soleReport)})`);
        if (!intact(owner)) {
            // A server without that guard took the only owner's role: it is put back as it was, so the run goes on and
            // reports every row after this one, not the sessions it ended.
            db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(owner);
            const cols = Object.keys(oliveRow);
            db.prepare(`INSERT OR REPLACE INTO node_roles (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => oliveRow[c]));
        }
        // A short reason spends no code (#2018 review NB1): it is checked before the proof, and the same code then suspends.
        {
            const shortReasonOwner = coOwner('ShortReason');
            const code = tfa.code();
            const tooShort = await call('POST', `/api/local/admin/users/${shortReasonOwner}/suspend`, pwSession(), { reason: 'stolen', code });
            assert(tooShort.status === 400 && /at least 10 characters/.test(tooShort.json?.error || '') && intact(shortReasonOwner),
                `3c-NB1. emergency-suspend an owner with a 6-character reason → 400, still an active owner (${short(tooShort)})`);
            const longEnough = await call('POST', `/api/local/admin/users/${shortReasonOwner}/suspend`, pwSession(), { reason: 'a reason members can read', code });
            assert(longEnough.status === 200 && statusOf(shortReasonOwner) !== 'active',
                `3c-NB1. …and the same code still suspends: it was not spent (${short(longEnough)})`);
        }
        /** A branch whose root is a member, with an owner invited by them. */
        const ownerInBranch = (): [string, string] => {
            const root = addMember('Root');
            const pk = coOwner('Branchy');
            db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(root, pk);
            return [root, pk];
        };
        type Removal = { what: string; send: (target: string, headers: Record<string, string>, extra?: Record<string, unknown>) => Promise<any>;
            done: (target: string) => boolean; target?: () => [string, string] };
        const removals: Removal[] = [
            { what: 'emergency-suspend an owner', send: (t, h, x = {}) => call('POST', `/api/local/admin/users/${t}/suspend`, h, { reason: 'gates suite', ...x }),
                done: (t) => statusOf(t) !== 'active' && roleRow(t) === null && heldAside(t) === 'owner' },
            { what: 'suspend an owner through a report', send: (t, h, x = {}) => call('POST', `/api/local/admin/reports/${reportOn(t)}/action`, h, { suspendUser: true, ...x }),
                done: (t) => statusOf(t) !== 'active' && roleRow(t) === null },
            { what: 'prune an owner', send: (t, h, x = {}) => call('POST', `/api/local/admin/users/${t}/prune`, h, x),
                done: (t) => statusOf(t) === 'pruned' && roleRow(t) === null },
            { what: 'offboard an owner', send: (t, h, x = {}) => call('POST', `/api/local/admin/members/${t}/offboard`, h, { resolution: 'prune_zero_balance', ...x }),
                done: (t) => statusOf(t) === 'pruned' && roleRow(t) === null },
            { what: 'prune a branch with an owner in it', target: ownerInBranch,
                send: (root, h, x = {}) => call('POST', `/api/local/admin/branches/${root}/prune`, h, x),
                done: (root) => statusOf(root) === 'pruned' },
        ];
        for (const row of removals) {
            console.log(`  · ${row.what}`);
            const [target, ownerKey] = row.target ? row.target() : (() => { const pk = coOwner('Removee'); return [pk, pk] as [string, string]; })();
            for (const [who, headers, refused] of refusals('x-fresh-proof')) {
                // The computer's row also sends a code in the body, as the owner's own would.
                const r = await row.send(target, headers(), who.includes('computer') ? { code: tfa.code() } : {});
                assert(refused(r), `${row.what}, ${who}: refused (${short(r)})`);
                assert(intact(ownerKey) && (target === ownerKey || statusOf(target) === 'active'),
                    `${row.what}, ${who}: nothing changed, still an active owner (${statusOf(ownerKey)}, ${roleRow(ownerKey)}, held ${heldAside(ownerKey)})`);
            }
            const code = tfa.code();
            const withCode = await row.send(target, pwSession(), { code });
            assert(withCode.status === 200 && row.done(target) && roleRow(ownerKey) === null,
                `${row.what}, a password session with a current code → 200, done (${short(withCode)}; ${statusOf(target)}, role ${roleRow(ownerKey)})`);
            // Again, on another owner: the code is spent; the phone with Manage pressed just now, or the code as X-Fresh-Proof.
            const [target2, ownerKey2] = row.target ? row.target() : (() => { const pk = coOwner('Removee'); return [pk, pk] as [string, string]; })();
            const spent = await row.send(target2, pwSession(), { code });
            assert(spent.status === 401 && intact(ownerKey2), `${row.what}, the same code again → 401, nothing changed (${short(spent)})`);
            const phone = await row.send(target2, asPhone());
            assert(phone.status === 200 && row.done(target2) && roleRow(ownerKey2) === null,
                `${row.what}, Manage pressed just now → 200, done (${short(phone)})`);
            const [target3, ownerKey3] = row.target ? row.target() : (() => { const pk = coOwner('Removee'); return [pk, pk] as [string, string]; })();
            const header = await row.send(target3, { ...pwSession(), 'x-fresh-proof': tfa.code() });
            assert(header.status === 200 && row.done(target3) && roleRow(ownerKey3) === null,
                `${row.what}, a current code in X-Fresh-Proof → 200, done (${short(header)})`);
        }
        // An owner whose key waits on a re-key code is still an owner (the deciding review of #1992, BLOCKING 1): the code
        // made them 'suspended', and an emergency suspension may be made over it. Every credential above is refused, and
        // the role stays on their key: nothing held aside, no vote opened. An owner's fresh proof suspends them.
        console.log('  · emergency-suspend an owner whose key waits on a re-key code');
        const keepVotesOn = (pk: string) => (db.prepare("SELECT COUNT(*) AS c FROM decisions WHERE subject = ? AND effect = 'keep_suspension'").get(pk) as any).c;
        const waitsOnCode = (pk: string) => statusOf(pk) === 'suspended' && keyHeld(pk) && roleRow(pk) === 'owner' && heldAside(pk) === null && keepVotesOn(pk) === 0;
        const rekeyingOwner = async (): Promise<string> => {
            const pk = coOwner('Rekeyee');
            const issued = await call('POST', rekeyRoute(pk, 'issue-code'), pwSession(), { code: tfa.code() });
            assert(issued.status === 200 && waitsOnCode(pk), `setup: a co-owner given a re-key code waits on it, still holding the owner row (${short(issued)}; ${statusOf(pk)}, ${roleRow(pk)})`);
            return pk;
        };
        const suspendOwner = (pk: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
            call('POST', `/api/local/admin/users/${pk}/suspend`, headers, { reason: 'gates suite', ...extra });
        const suspendedAside = (pk: string) => statusOf(pk) === 'disabled' && roleRow(pk) === null && heldAside(pk) === 'owner' && keepVotesOn(pk) === 1;
        // One owner per credential, so each is measured on an owner still waiting on the code.
        for (const [who, headers, refused] of refusals('x-fresh-proof')) {
            const rekeyee = await rekeyingOwner();
            const r = await suspendOwner(rekeyee, headers(), who.includes('computer') ? { code: tfa.code() } : {});
            assert(refused(r), `emergency-suspend an owner whose key waits on a re-key code, ${who}: refused (${short(r)})`);
            assert(waitsOnCode(rekeyee), `emergency-suspend an owner whose key waits on a re-key code, ${who}: nothing held aside, no vote, the role on their key (${statusOf(rekeyee)}, ${roleRow(rekeyee)}, held ${heldAside(rekeyee)}, votes ${keepVotesOn(rekeyee)})`);
            // Their code cancelled, so they are an active owner again, whose role the end of this section takes back.
            if (waitsOnCode(rekeyee)) cancelRekeyCode(rekeyee, owner);
        }
        const rekeyee = await rekeyingOwner();
        const rekeyeeProof = await suspendOwner(rekeyee, pwSession(), { code: tfa.code() });
        assert(rekeyeeProof.status === 200 && suspendedAside(rekeyee),
            `emergency-suspend an owner whose key waits on a re-key code, a password session with a current code → 200, the role held aside, a vote open (${short(rekeyeeProof)})`);
        const rekeyee2 = await rekeyingOwner();
        const rekeyeePhone = await suspendOwner(rekeyee2, asPhone());
        assert(rekeyeePhone.status === 200 && suspendedAside(rekeyee2),
            `emergency-suspend an owner whose key waits on a re-key code, Manage pressed just now → 200, the role held aside, a vote open (${short(rekeyeePhone)})`);

        // Cutting short an owner's removal in its grace window (the deciding review of #1992, NB 4), over real HTTP: the
        // owner is suspended with the role held aside until the removal runs. Each refusal leaves it waiting.
        console.log("  · cut short an owner's removal");
        const decisionStatus = (id: string) => (db.prepare('SELECT status FROM decisions WHERE id = ?').get(id) as any)?.status ?? null;
        const ownerInGrace = (): [string, string] => { const pk = coOwner('Graced'); return [removalInGraceFromBefore(owner, pk, 'Remove a co-owner'), pk]; };
        const accelerate = (id: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
            call('POST', `/api/local/admin/decisions/${id}/accelerate`, headers, extra);
        const inGrace = (id: string, pk: string) => decisionStatus(id) === 'execution_pending_grace' && statusOf(pk) === 'disabled' && heldAside(pk) === 'owner';
        const removalRan = (id: string, pk: string) => decisionStatus(id) === 'executed' && statusOf(pk) === 'pruned' && heldAside(pk) === null && roleRow(pk) === null;
        const [graceId, gracedOwner] = ownerInGrace();
        assert(inGrace(graceId, gracedOwner), `setup: an owner's removal waits in its grace window, the role held aside (${decisionStatus(graceId)}, ${statusOf(gracedOwner)})`);
        for (const [who, headers, refused] of refusals('x-fresh-proof')) {
            const r = await accelerate(graceId, headers(), who.includes('computer') ? { code: tfa.code() } : {});
            assert(refused(r), `cut short an owner's removal, ${who}: refused (${short(r)})`);
            assert(inGrace(graceId, gracedOwner), `cut short an owner's removal, ${who}: still in its grace window (${decisionStatus(graceId)}, ${statusOf(gracedOwner)}, held ${heldAside(gracedOwner)})`);
        }
        const graceCode = tfa.code();
        const graceWithCode = await accelerate(graceId, pwSession(), { code: graceCode });
        assert(graceWithCode.status === 200 && removalRan(graceId, gracedOwner),
            `cut short an owner's removal, a password session with a current code → 200, removed (${short(graceWithCode)}; ${decisionStatus(graceId)}, ${statusOf(gracedOwner)})`);
        const [graceId2, gracedOwner2] = ownerInGrace();
        const graceSpent = await accelerate(graceId2, pwSession(), { code: graceCode });
        assert(graceSpent.status === 401 && inGrace(graceId2, gracedOwner2), `cut short an owner's removal, the same code again → 401, still in its grace window (${short(graceSpent)})`);
        const gracePhone = await accelerate(graceId2, asPhone());
        assert(gracePhone.status === 200 && removalRan(graceId2, gracedOwner2), `cut short an owner's removal, Manage pressed just now → 200, removed (${short(gracePhone)})`);
        const [graceId3, gracedOwner3] = ownerInGrace();
        const graceHeader = await accelerate(graceId3, { ...pwSession(), 'x-fresh-proof': tfa.code() });
        assert(graceHeader.status === 200 && removalRan(graceId3, gracedOwner3), `cut short an owner's removal, a current code in X-Fresh-Proof → 200, removed (${short(graceHeader)})`);

        // An admin or a member as target: the step-up, as before. The password with an earlier 2FA session, an owner's
        // computer, an admin's computer: no code asked.
        const asked = (r: any) => r.status === 401 || r.json?.code === 'phone_required' || r.json?.code === 'step_up_required';
        for (const [what, make, send, done] of [
            ['prune an admin, the password with an earlier 2FA session', () => { const pk = addMember('Adminee'); grantNodeRole(pk, 'admin', owner); return pk; },
                (t: string) => call('POST', `/api/local/admin/users/${t}/prune`, earlier2fa(), {}), (t: string) => statusOf(t) === 'pruned'],
            ["suspend an admin, an owner's computer", () => { const pk = addMember('Adminee'); grantNodeRole(pk, 'admin', owner); return pk; },
                (t: string) => call('POST', `/api/local/admin/users/${t}/suspend`, asComputer, { reason: 'gates suite' }), (t: string) => statusOf(t) !== 'active' && heldAside(t) === 'admin'],
            ["offboard an admin, an owner's computer", () => { const pk = addMember('Adminee'); grantNodeRole(pk, 'admin', owner); return pk; },
                (t: string) => call('POST', `/api/local/admin/members/${t}/offboard`, asComputer, { resolution: 'prune_zero_balance' }), (t: string) => statusOf(t) === 'pruned'],
            ["prune a member, an admin's computer", () => addMember('Membee'),
                (t: string) => call('POST', `/api/local/admin/users/${t}/prune`, asAdmin, {}), (t: string) => statusOf(t) === 'pruned'],
            ["suspend a member, an admin's computer", () => addMember('Membee'),
                (t: string) => call('POST', `/api/local/admin/users/${t}/suspend`, asAdmin, { reason: 'gates suite' }), (t: string) => statusOf(t) !== 'active'],
            ["offboard a member, an admin's computer", () => addMember('Membee'),
                (t: string) => call('POST', `/api/local/admin/members/${t}/offboard`, asAdmin, { resolution: 'prune_zero_balance' }), (t: string) => statusOf(t) === 'pruned'],
            ["suspend a member through a report, an admin's computer", () => addMember('Membee'),
                (t: string) => call('POST', `/api/local/admin/reports/${reportOn(t)}/action`, asAdmin, { suspendUser: true }), (t: string) => statusOf(t) !== 'active'],
            ["prune a branch of members, an owner's computer", () => addMember('Rootee'),
                (t: string) => call('POST', `/api/local/admin/branches/${t}/prune`, asComputer, {}), (t: string) => statusOf(t) === 'pruned'],
        ] as Array<[string, () => string, (t: string) => Promise<any>, (t: string) => boolean]>) {
            const t = make();
            const r = await send(t);
            assert(r.status === 200 && !asked(r) && done(t), `${what}: no proof asked, 200, done (${short(r)}; ${statusOf(t)})`);
        }
        for (const pk of coOwners) if (roleRow(pk)) revokeNodeRole(pk, roleRow(pk), owner);

        // A shorter span of snapshots asks the same fresh proof (#1984 confirmation N-2; #1992 confirmation NB 2): a lower
        // keep, a shorter interval, turning scheduled snapshots off, an interval past their 14-day age. More, on: no proof.
        console.log('\n── 3d. a shorter span of snapshots, or none, asks the fresh proof; keeping more does not ──');
        const snapCfg = () => JSON.stringify(getAutoSnapshotConfig());
        const configRoute = '/api/local/admin/snapshots/config';
        const raise = await call('POST', configRoute, asComputer, { keep: 9 });
        assert(raise.status === 200 && getAutoSnapshotConfig().keep === 9, `keeping more snapshots (keep 9) from a computer: no proof asked (${short(raise)})`);
        const MAX_AGE_HOURS = (snapshots.SNAPSHOT_MAX_AGE_DAYS ?? 14) * 24;
        const lessen: Array<[string, Record<string, unknown>, () => boolean, Record<string, unknown>]> = [
            ['keep fewer snapshots (9 → 8, then 7)', { keep: 8 }, () => getAutoSnapshotConfig().keep === 8, { keep: 7 }],
            // With keep fixed, each one taken pushes the oldest out: one an hour turns a week of daily ones over in 7 hours.
            ['take them more often with the same keep (24 h → 6 h, then 1 h)', { intervalHours: 6 }, () => getAutoSnapshotConfig().intervalHours === 6,
                { intervalHours: 1 }],
            ['turn scheduled snapshots off', { enabled: false }, () => getAutoSnapshotConfig().enabled === false, { enabled: false }],
            [`an interval past their age (${MAX_AGE_HOURS + 1} h)`, { intervalHours: MAX_AGE_HOURS + 1 }, () => getAutoSnapshotConfig().intervalHours === MAX_AGE_HOURS + 1,
                { intervalHours: MAX_AGE_HOURS + 2 }],
        ];
        for (const [what, change, done, again] of lessen) {
            console.log(`  · ${what}`);
            const before = snapCfg();
            for (const [who, headers, refused] of [
                ...refusals(null).filter(([w]) => !w.includes('admin')),
                ['an admin', () => asAdmin, inWords],
                ['an admin token', () => asToken, (r: any) => r.status === 403 && r.json?.code === 'token_not_allowed'],
            ] as Refusal[]) {
                const r = await call('POST', configRoute, headers(), { ...change, ...(who.includes('computer') ? { code: tfa.code() } : {}) });
                assert(refused(r), `${what}, ${who}: refused (${short(r)})`);
                assert(snapCfg() === before, `${what}, ${who}: the config as it was`);
            }
            const code = tfa.code();
            const withCode = await call('POST', configRoute, pwSession(), { ...change, code });
            assert(withCode.status === 200 && done(), `${what}, a password session with a current code → 200 (${short(withCode)}; ${snapCfg()})`);
            const spentBefore = snapCfg();
            const spent = await call('POST', configRoute, pwSession(), { ...again, ...(again.enabled === false ? { keep: 6 } : {}), code });
            assert(spent.status === 401 && snapCfg() === spentBefore, `${what}, the same code again → 401, unchanged (${short(spent)})`);
            if (again.enabled === false) {
                const on = await call('POST', configRoute, asComputer, { enabled: true });
                assert(on.status === 200 && getAutoSnapshotConfig().enabled === true, `turning scheduled snapshots back on from a computer: no proof asked (${short(on)})`);
                const offPhone = await call('POST', configRoute, asPhone(), { enabled: false });
                assert(offPhone.status === 200 && getAutoSnapshotConfig().enabled === false, `turning them off, Manage pressed just now → 200 (${short(offPhone)})`);
                const onAgain = await call('POST', configRoute, asComputer, { enabled: true });
                assert(onAgain.status === 200 && getAutoSnapshotConfig().enabled === true, `and on again, no proof (${short(onAgain)})`);
            } else {
                const phone = await call('POST', configRoute, asPhone(), again);
                assert(phone.status === 200 && Object.entries(again).every(([k, v]) => (getAutoSnapshotConfig() as any)[k] === v),
                    `${what}, Manage pressed just now → 200 (${short(phone)}; ${snapCfg()})`);
            }
        }
        const shorter = await call('POST', configRoute, asComputer, { intervalHours: MAX_AGE_HOURS });
        assert(shorter.status === 200 && getAutoSnapshotConfig().intervalHours === MAX_AGE_HOURS,
            `a shorter interval (${MAX_AGE_HOURS} h, within their age) from a computer: no proof asked (${short(shorter)})`);
        // From one every 14 days back to daily, keep 8: the span goes from 14 days to 8, so it is asked too.
        const dailyComputer = await call('POST', configRoute, asComputer, { intervalHours: 24, keep: 8, enabled: true });
        assert(dailyComputer.status === 403 && dailyComputer.json?.code === 'phone_required' && getAutoSnapshotConfig().intervalHours === MAX_AGE_HOURS,
            `back to daily and keep 8 from a computer (a span of ${MAX_AGE_HOURS} h → 192 h): the proof is asked (${short(dailyComputer)}; ${snapCfg()})`);
        const daily = await call('POST', configRoute, asPhone(), { intervalHours: 24, keep: 8, enabled: true });
        assert(daily.status === 200 && getAutoSnapshotConfig().intervalHours === 24 && getAutoSnapshotConfig().keep === 8,
            `and from the phone, Manage pressed just now → 200 (${short(daily)})`);
        const mixed = await call('POST', configRoute, asComputer, { keep: 7, enabled: true });
        assert(mixed.status === 403 && mixed.json?.code === 'phone_required' && getAutoSnapshotConfig().keep === 8,
            `keep fewer with snapshots on in the same change: the proof is still asked (${short(mixed)})`);
        const sameKeep = await call('POST', configRoute, asComputer, { keep: 8, intervalHours: 24 });
        assert(sameKeep.status === 200, `the same keep and interval sent again: no proof asked (${short(sameKeep)})`);

        // One rule (#1992 confirmation NB 2): the span the kept scheduled snapshots cover, interval × keep and at most their
        // 14-day age, may not get shorter without the fresh proof, neither once the new schedule has run nor right away: a
        // lower keep prunes those already taken, at whatever interval they were taken, so it always asks.
        console.log('\n── 3e. the span the snapshots cover: shorter asks the fresh proof; the same or longer does not ──');
        const reset = await call('POST', configRoute, asPhone(), { enabled: true, intervalHours: 24, keep: 7 });
        assert(reset.status === 200, `setup: daily, keep 7, a span of 168 h (${short(reset)})`);
        const cfgIs = (want: Record<string, unknown>) => Object.entries(want).every(([k, v]) => (getAutoSnapshotConfig() as any)[k] === v);
        const spanRows: Array<[string, Record<string, unknown>, 'proof' | 'none', boolean]> = [
            ['24 h → 1 h with keep 7 (168 h → 7 h)', { intervalHours: 1 }, 'proof', true],
            ['1 h → 24 h (7 h → 168 h)', { intervalHours: 24 }, 'none', true],
            ['keep 7 → 14 with 24 h → 12 h (168 h → 168 h)', { keep: 14, intervalHours: 12 }, 'none', true],
            ['keep 14 → 7 with 12 h → 24 h (168 h once it has run, but the 7 kept now were taken 12 h apart: 84 h)',
                { keep: 7, intervalHours: 24 }, 'proof', true],
            ['keep 7 → 3 with 24 h → 72 h (216 h once it has run, 72 h right away)', { keep: 3, intervalHours: 72 }, 'proof', true],
            ['keep 3 → 14 at 72 h (216 h → 336 h, the 14-day age)', { keep: 14 }, 'none', true],
            // The schedule says 336 h either way, but the 14 kept now may have been taken a day apart (24 h → 72 h above asked
            // nothing): keep 7 would prune seven of them at once.
            ['keep 14 → 7 at 72 h (336 h → 336 h once it has run; a lower keep prunes now)', { keep: 7 }, 'proof', true],
            ['72 h → 24 h with keep 7 (336 h → 168 h)', { intervalHours: 24 }, 'proof', true],
            ['raising keep 7 → 10 at 24 h (168 h → 240 h)', { keep: 10 }, 'none', true],
            [`an interval past their age, ${MAX_AGE_HOURS + 1} h (240 h → hours with none)`, { intervalHours: MAX_AGE_HOURS + 1 }, 'proof', false],
            ['turning them off', { enabled: false }, 'proof', false],
            ['turning them off while keeping more', { enabled: false, keep: 14 }, 'proof', false],
        ];
        for (const [what, change, expect, apply] of spanRows) {
            const before = snapCfg();
            const fromComputer = await call('POST', configRoute, asComputer, change);
            if (expect === 'none') {
                assert(fromComputer.status === 200 && cfgIs(change), `${what}, from a computer: no proof asked (${short(fromComputer)}; ${snapCfg()})`);
                continue;
            }
            assert(fromComputer.status === 403 && fromComputer.json?.code === 'phone_required' && snapCfg() === before,
                `${what}, from a computer: the proof is asked, the config as it was (${short(fromComputer)}; ${snapCfg()})`);
            const noCode = await call('POST', configRoute, pwSession(), change);
            assert(noCode.status === 401 && noCode.json?.totpRequired === true && snapCfg() === before,
                `${what}, a password session with no code: asked for one (${short(noCode)})`);
            if (!apply) continue;
            const withCode = await call('POST', configRoute, pwSession(), { ...change, code: tfa.code() });
            assert(withCode.status === 200 && cfgIs(change), `${what}, with a current code → 200 (${short(withCode)}; ${snapCfg()})`);
        }
        const restore = await call('POST', configRoute, asPhone(), { enabled: true, intervalHours: 24, keep: 8 });
        assert(restore.status === 200 && cfgIs({ enabled: true, intervalHours: 24, keep: 8 }), `back to daily, keep 8 (${short(restore)})`);
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
        // Down to the floor is keeping fewer: the fresh proof (3d).
        const keep3 = await call('POST', '/api/local/admin/snapshots/config', asPhone(), { keep: MIN_SNAPSHOTS_KEPT });
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
