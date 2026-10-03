/**
 * The node's Cloudflare tunnel token is an owner's, through the real middleware (real HTTPS, real admin auth).
 *
 * Whoever holds the token can run a second connector for the node's name and be handed a share of its visitors,
 * owners' Manage sign-ins among them. So:
 *   1. An admin signed in with their key reads the address status and never sees the token, nor anything else the
 *      registrar's answer carried beyond the named fields; the answer says only that an owner can see it.
 *   2. An admin cannot claim, rename or release the address (operators/setup/signing-in.md: the community's name and
 *      address are an owner's), and the refusal carries no token.
 *   3. An owner, by key or by the admin password, still gets the token (the manager's PublicAddressPanel shows it),
 *      and still never anything the registrar sent beyond the named fields.
 *   4. The tunnel keeps running on the token from the node's config, whoever reads the status.
 *
 * The registrar is a local stub; Cloudflare's edge probe is refused in-process; cloudflared is the test fake.
 */
const ADMIN_PASSWORD = 'Tunnel-Token-Owner-Only-1!';
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

// Made-up values, unique enough that a substring match can only be these.
const TUNNEL_TOKEN = 'fake-tunnel-token-OWNERONLY-TEST-9c41e2b7d0';
const EXTRA_SECRET = 'registrar-extra-secret-OWNERONLY-5a8f';

/** Settings' probe of Cloudflare's edge (routes/public-address.ts verifyEdgeStatus), refused at once. */
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

interface Identity { pub: string; priv: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

let BASE = '';
async function call(method: 'GET' | 'POST', p: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, headers: res.headers };
}

/** The app's Manage button: challenge, the member's signature, the one-time token exchanged for a session. */
async function keySession(who: Identity): Promise<{ sid: string; role: string }> {
    const chal = await call('POST', '/api/local/admin/auth/challenge', {});
    const solved = await call('POST', '/api/local/admin/auth/verify-challenge', {
        challengeId: chal.body?.challengeId,
        memberPubkey: who.pub,
        signature: crypto.sign(null, Buffer.from(chal.body?.challenge ?? ''), who.priv).toString('base64'),
    });
    const ex = await call('POST', '/api/local/admin/auth/exchange', { token: solved.body?.handshakeToken });
    const sid = (ex.headers.get('set-cookie') || '').match(/admin_session=([0-9a-f]+)/)?.[1];
    if (ex.status !== 200 || !sid) throw new Error(`setup: no key session (${chal.status} ${solved.status} ${ex.status} ${ex.text.slice(0, 200)})`);
    return { sid, role: ex.body?.role };
}

async function main() {
    console.log('Only an owner reads the tunnel token (real HTTPS, real admin auth)...\n');
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { initStateEngine, getNodeConfig, grantNodeRole } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { startP2P } = await import('./p2p.js');
    const { db } = await import('./db/db.js');
    const { useFakeCloudflared } = await import('./tunnel-test-fake.js');
    const { tunnelConnectorForTests, resetTunnelConnectorForTests } = await import('./services/tunnel-connector.js');
    const { turnOn2faForTests } = await import('./admin-auth-test-harness.js');

    refuseEdge();
    await initTls();
    initAdminPassword();
    initStateEngine();
    updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: false } as any);
    const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    await useFakeCloudflared(path.join(DATA_DIR, 'fake-cloudflared'));
    // The registrar signs with the node's key, so the identity is loaded (ephemeral ports, no peers).
    const p2pNode = await startP2P(0, 0);

    // The address service, as a stub on loopback: every answer carries the token and one field nobody should pass on.
    let regStatus = 'none';
    let regName = '';
    const answer = () => ({
        status: regStatus, name: regName || null, hostname: regName ? `${regName}.beanpool.org` : null,
        tunnelToken: regStatus === 'live' ? TUNNEL_TOKEN : null, apiSecret: EXTRA_SECRET,
    });
    const registrar = http.createServer((req, res) => {
        let bodyText = '';
        req.on('data', (c) => { bodyText += c; });
        req.on('end', () => {
            const url = new URL(req.url || '/', 'http://x');
            res.setHeader('Content-Type', 'application/json');
            if (url.pathname === '/api/registrar/claim' && req.method === 'POST') {
                regName = JSON.parse(bodyText || '{}').name; regStatus = 'live';
                res.end(JSON.stringify(answer())); return;
            }
            if (url.pathname === '/api/registrar/status' && req.method === 'GET') { res.end(JSON.stringify(answer())); return; }
            if (url.pathname === '/api/registrar/update' && req.method === 'POST') { res.end(JSON.stringify(answer())); return; }
            if (url.pathname === '/api/registrar/offline' && req.method === 'POST') {
                regStatus = 'none'; regName = '';
                res.end(JSON.stringify({ status: 'none', apiSecret: EXTRA_SECRET })); return;
            }
            res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
        });
    });
    await new Promise<void>((r) => registrar.listen(0, '127.0.0.1', () => r()));
    process.env.REGISTRAR_URL = `http://127.0.0.1:${(registrar.address() as any).port}`;

    const PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    const seed = (who: Identity, callsign: string, role: 'owner' | 'admin') => {
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(who.pub, callsign);
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(who.pub);
        grantNodeRole(who.pub, role, 'SYSTEM');
    };
    const owner = keypair(); seed(owner, 'tokOwner', 'owner');
    const admin = keypair(); seed(admin, 'tokAdmin', 'admin');

    const CLAIM = '/api/local/admin/public-address/claim';
    const STATUS = '/api/local/admin/public-address/status';
    const UPDATE = '/api/local/admin/public-address/update';
    const OFFLINE = '/api/local/admin/public-address/offline';
    const password = { 'X-Admin-Password': ADMIN_PASSWORD };
    // Step 7c: with 2FA off the password alone opens no admin route; the owner's password goes with a code. Each such call
    // turns 2FA on (admin-auth-test-harness turnOn2faForTests) and off again, so the key-session calls run as before.
    const withPassword = async (method: 'GET' | 'POST', p: string, body?: unknown) => {
        const tfa = turnOn2faForTests(ADMIN_PASSWORD);
        try { return await call(method, p, body, tfa.headers()); } finally { updateLocalConfig({ totpEnabled: false, totpSecret: null }); }
    };
    const leaks = (text: string) => text.includes(TUNNEL_TOKEN) || /tunnelToken"\s*:/.test(text);

    try {
        const ownerS = await keySession(owner);
        const adminS = await keySession(admin);
        assert(ownerS.role === 'owner' && adminS.role === 'admin', `setup: an owner and an admin, each signed in by key (${ownerS.role}, ${adminS.role})`);
        const asOwner = { 'x-admin-session': ownerS.sid };
        const asAdmin = { 'x-admin-session': adminS.sid };

        console.log('\n── 1. an admin cannot claim the address, and the refusal carries no token ──');
        const adminClaim = await call('POST', CLAIM, { name: 'tokvale', mode: 'tunnel' }, asAdmin);
        assert(adminClaim.status === 403, `an admin's claim is refused (${adminClaim.status} ${adminClaim.text.slice(0, 120)})`);
        assert(!leaks(adminClaim.text) && !adminClaim.text.includes(EXTRA_SECRET), 'the refusal carries no token and nothing of the registrar\'s answer');
        assert(regStatus === 'none', 'and the registrar was never asked');

        console.log('\n── 2. an owner (by key) claims it, and is shown the token, and only the named fields ──');
        const ownerClaim = await call('POST', CLAIM, { name: 'tokvale', mode: 'tunnel', contact: 'op@example.invalid' }, asOwner);
        assert(ownerClaim.status === 200 && ownerClaim.body?.hostname === 'tokvale.beanpool.org' && ownerClaim.body?.status === 'live',
            `the owner's claim succeeds (${ownerClaim.status} ${ownerClaim.text.slice(0, 160)})`);
        assert(ownerClaim.body?.tunnelToken === TUNNEL_TOKEN, 'the owner\'s claim answer carries the token');
        assert(!ownerClaim.text.includes(EXTRA_SECRET), 'the claim answer carries nothing the registrar sent beyond the named fields');
        assert((getNodeConfig() as any).publicAddress?.tunnelToken === TUNNEL_TOKEN, 'the node config holds the token');
        assert(tunnelConnectorForTests().wantedToken === TUNNEL_TOKEN, 'the tunnel inside this server runs on it');

        console.log('\n── 3. reading the status: an admin is never shown the token ──');
        const adminStatus = await call('GET', STATUS, undefined, asAdmin);
        assert(adminStatus.status === 200 && adminStatus.body?.status === 'live' && adminStatus.body?.hostname === 'tokvale.beanpool.org',
            `an admin reads the status: live at its name (${adminStatus.status} ${adminStatus.text.slice(0, 160)})`);
        assert(!leaks(adminStatus.text), `the token is nowhere in the admin's answer`);
        assert(!adminStatus.text.includes(EXTRA_SECRET), 'nor anything the registrar sent beyond the named fields');
        assert(adminStatus.body?.tunnelTokenOwnerOnly === true, 'the answer says there is a token only an owner can see');
        assert(typeof adminStatus.body?.tunnel?.state === 'string', 'the tunnel\'s state is still shown to the admin');

        const ownerStatus = await call('GET', STATUS, undefined, asOwner);
        assert(ownerStatus.status === 200 && ownerStatus.body?.tunnelToken === TUNNEL_TOKEN, `an owner by key reads the token (${ownerStatus.status})`);
        assert(!ownerStatus.text.includes(EXTRA_SECRET) && !('tunnelTokenOwnerOnly' in (ownerStatus.body || {})), 'and only the named fields');
        const pwAlone = await call('GET', STATUS, undefined, password);
        assert(pwAlone.status === 403 && pwAlone.body?.code === 'password_needs_2fa' && !leaks(pwAlone.text),
            `step 7c: the admin password alone (2FA off) is refused as needing 2FA, with no token (${pwAlone.status} ${pwAlone.body?.code})`);
        const pwStatus = await withPassword('GET', STATUS);
        assert(pwStatus.status === 200 && pwStatus.body?.tunnelToken === TUNNEL_TOKEN, `the admin password (an owner) reads the token (${pwStatus.status})`);
        assert(tunnelConnectorForTests().wantedToken === TUNNEL_TOKEN && (getNodeConfig() as any).publicAddress?.tunnelToken === TUNNEL_TOKEN,
            'after every read the tunnel still runs on the token in the node config');

        console.log('\n── 4. with the registrar unreachable, the saved address answers: still no token for an admin ──');
        const regUrl = process.env.REGISTRAR_URL;
        process.env.REGISTRAR_URL = 'http://127.0.0.1:1';
        const adminCached = await call('GET', STATUS, undefined, asAdmin);
        assert(adminCached.status === 200 && adminCached.body?.cached === true && adminCached.body?.hostname === 'tokvale.beanpool.org',
            `an admin reads the saved address (${adminCached.status} ${adminCached.text.slice(0, 160)})`);
        assert(!leaks(adminCached.text) && adminCached.body?.tunnelTokenOwnerOnly === true, 'without the token, told only an owner can see it');
        const ownerCached = await call('GET', STATUS, undefined, asOwner);
        assert(ownerCached.body?.cached === true && ownerCached.body?.tunnelToken === TUNNEL_TOKEN, 'an owner reads the saved token');
        process.env.REGISTRAR_URL = regUrl;

        console.log('\n── 4b. the node-config save and the tunnel restart give an admin no token either ──');
        // Settings' save answers with the stored node config, which holds publicAddress.tunnelToken (deciding review of #1535).
        const adminCfg = await call('POST', '/api/local/admin/node/config', {}, asAdmin);
        assert(adminCfg.status === 200 && !leaks(adminCfg.text), `an admin's empty node-config save carries no token (${adminCfg.status})`);
        const adminCfgSet = await call('POST', '/api/local/admin/node/config', { publishHealth: true }, asAdmin);
        assert(adminCfgSet.status === 200 && !leaks(adminCfgSet.text) && adminCfgSet.body?.publishHealth === true,
            `an admin's node-config change is saved and carries no token (${adminCfgSet.status})`);
        const ownerCfg = await call('POST', '/api/local/admin/node/config', {}, asOwner);
        assert(ownerCfg.status === 200 && !leaks(ownerCfg.text), `the save's answer holds no token for an owner either: the address has its own route (${ownerCfg.status})`);
        const adminRestart = await call('POST', '/api/local/admin/public-address/restart-tunnel', {}, asAdmin);
        assert(adminRestart.status === 200 && !leaks(adminRestart.text), `an admin can still restart the tunnel, with no token in the answer (${adminRestart.status})`);
        assert(tunnelConnectorForTests().wantedToken === TUNNEL_TOKEN, 'and the restarted tunnel runs on the stored token');

        console.log('\n── 5. an admin cannot rename or release the address ──');
        const adminUpdate = await call('POST', UPDATE, { communityName: 'Taken Over' }, asAdmin);
        assert(adminUpdate.status === 403 && !leaks(adminUpdate.text), `an admin's rename is refused (${adminUpdate.status})`);
        const adminOffline = await call('POST', OFFLINE, {}, asAdmin);
        assert(adminOffline.status === 403 && regStatus === 'live' && (getNodeConfig() as any).publicAddress?.tunnelToken === TUNNEL_TOKEN,
            `an admin's release is refused and the address stays (${adminOffline.status})`);
        const pwUpdate = await withPassword('POST', UPDATE, { communityName: 'Tok Vale' });
        assert(pwUpdate.status === 200 && !pwUpdate.text.includes(EXTRA_SECRET), `the admin password renames it, named fields only (${pwUpdate.status})`);
        const pwOffline = await withPassword('POST', OFFLINE, {});
        assert(pwOffline.status === 200 && pwOffline.body?.status === 'none' && !pwOffline.text.includes(EXTRA_SECRET),
            `the admin password releases it, named fields only (${pwOffline.status} ${pwOffline.text.slice(0, 120)})`);
    } finally {
        registrar.close();
        await resetTunnelConnectorForTests();
        if (p2pNode) await p2pNode.stop();
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
    console.error('Test execution failed:', e);
    process.exit(1);
});
