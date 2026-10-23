/**
 * test-preview-password-config.ts — on a private preview (config/private-preview.ts), an owner signed in with the node
 * password reads the whole node config from GET /api/node/config, as an owner's key session does, so the manager's Node
 * Identity screen loads every switch and a Save from it writes none back changed (#2387's deciding review: the password
 * got the stranger's `{ serviceRadius }` alone, and a Save switched "Share Location & Radius" back ON, the member count
 * and health on, the contact email off and the directory schedule from Never to every 12 hours).
 *
 * Boots the real server (real middleware) with PRIVATE_PREVIEW=1 and the node's 2FA on, and asserts, over HTTP:
 *   1. The owner's password, both ways the manager sends it (Settings' cookie session from the password sign-in, and the
 *      X-Admin-Password header with a code), gets the whole config: byte for byte an owner's key session's answer, the
 *      place exact, every switch as stored.
 *   2. A Save from the Node Identity screen after that read (the body the manager builds from what it read, its
 *      defaults where the read gave nothing) leaves every setting as stored: "Share Location & Radius" stays off.
 *   3. Everyone else keeps #2387's answer on a preview: a stranger, unsigned or signed, the service area alone (null with
 *      the switch off); a member the whole config with the place to two decimals; a wrong password, a session the node
 *      doesn't know, a password session a 2FA change ended, one held to the 2FA card (the node's 2FA off) and the
 *      password header with 2FA off get the stranger's answer, byte for byte, never a refusal.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-preview-password-config.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_PROFILE;
process.env.PRIVATE_PREVIEW = '1';
process.env.REGISTRAR_URL = 'http://127.0.0.1:1';
// A Save that sends the schedule restarts the directory publisher: it never reaches the real registry from here.
process.env.DIRECTORY_REGISTRY_URL = 'http://127.0.0.1:1';
process.env.DIRECTORY_UNLISTED = '1';

import crypto from 'node:crypto';

const PW = 'PreviewPasswordConfig1!';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

interface Reply { status: number; text: string; body: any; headers: Headers }

/** A request as `id` signs it (null: unsigned), with any extra headers (an admin credential). */
async function call(method: string, urlPath: string, opts: { id?: Id | null; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) };
    if (opts.id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = opts.id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n`), opts.id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, redirect: 'manual' });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body, headers: res.headers };
}
const readConfig = (opts: { id?: Id | null; headers?: Record<string, string> } = {}) => call('GET', '/api/node/config', opts);

// Made-up, and unlike any other number a read carries.
const AREA = { lat: -28.55555, lng: 153.49999, radiusKm: 25 };
const ROUNDED_AREA = { lat: -28.56, lng: 153.5, radiusKm: 25 };
// Every directory setting away from the manager's defaults (NodeIdentityPanel: location, members and health on, the
// contacts off, every 12 hours), so a Save that wrote a default back shows.
const STORED = {
    serviceRadius: AREA, publishLocation: false, publishMembers: false, publishHealth: false,
    publishContactEmail: true, publishContactPhone: false, directoryPushIntervalHours: 0,
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => JSON.stringify(v);

/**
 * The body the manager's Node Identity Save posts after reading `cfg` (NodeIdentityPanel handleSave, before it learned to
 * leave out what it didn't read): each setting the read gave, the form's default where it gave none.
 */
function managerSaveBody(cfg: any): Record<string, unknown> {
    return {
        publishLocation: cfg.publishLocation !== undefined ? Boolean(cfg.publishLocation) : true,
        publishMembers: cfg.publishMembers !== undefined ? Boolean(cfg.publishMembers) : true,
        publishContactEmail: cfg.publishContactEmail === true,
        publishContactPhone: cfg.publishContactPhone === true,
        publishHealth: cfg.publishHealth !== undefined ? Boolean(cfg.publishHealth) : true,
        directoryPushIntervalHours: cfg.directoryPushIntervalHours !== undefined ? Number(cfg.directoryPushIntervalHours) : 12,
        serviceRadius: cfg.serviceRadius && typeof cfg.serviceRadius === 'object' ? cfg.serviceRadius : null,
        ...(typeof cfg.acceptKnocks === 'boolean' ? { acceptKnocks: cfg.acceptKnocks } : {}),
    };
}

async function main() {
    console.log('An owner signed in with the password reads the whole node config on a private preview...\n');
    const { initTls } = await import('./services/tls.js');
    const { updateLocalConfig, hashPassword, updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { ownerSessionHeaders, turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { isPrivatePreview } = await import('./config/private-preview.js');

    await initTls();
    se.initStateEngine();
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt });
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    // This suite reads one route many times over; the gateway's per-address minute is not what it measures.
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    if (!isPrivatePreview()) throw new Error('setup: the private preview is not on');

    const OWNER_KEY = ownerSessionHeaders();
    const adminKey = newId();
    se.seedGenesisMember(adminKey.pk, 'PreviewAdmin');
    se.grantNodeRole(adminKey.pk, 'admin', 'SYSTEM');
    const adminSession = consumeHandshakeToken(mintHandshakeToken(adminKey.pk, 'admin').handshakeToken);
    if (!adminSession.ok || !adminSession.sessionId) throw new Error(`setup: no admin session (${adminSession.error})`);
    const ADMIN_KEY = { 'X-Admin-Session': adminSession.sessionId };
    const member = newId();
    se.seedGenesisMember(member.pk, 'PreviewMember');
    const stranger = newId();
    if (!se.isNodeMember(member.pk) || se.isNodeMember(stranger.pk)) throw new Error('setup: the member is no member, or the stranger is one');

    // The owner's authenticator: the password signs in only with a code (design step 6, D3).
    const tfa = turnOn2faForTests(PW);
    se.updateNodeConfig(STORED);
    const stored = () => { const c = se.getNodeConfig() as any; return Object.fromEntries(Object.keys(STORED).map(k => [k, c[k]])); };
    if (!same(stored(), STORED)) throw new Error(`setup: the node holds ${show(stored())}`);

    const signIn = await call('POST', '/api/local/admin/auth/password', { body: { password: PW, totpCode: tfa.code() } });
    const cookie = (signIn.headers.getSetCookie().find(c => c.startsWith('admin_session=')) ?? '').split(';')[0];
    if (signIn.status !== 200 || signIn.body?.role !== 'owner' || !cookie || typeof signIn.body?.csrfToken !== 'string') {
        throw new Error(`setup: the password sign-in failed (${signIn.status} ${signIn.text})`);
    }
    const PASSWORD_SESSION = { Cookie: cookie };

    console.log('── 1. The owner\'s password gets the whole config, as the owner\'s key does ──');
    const byKey = await readConfig({ headers: OWNER_KEY });
    assert(byKey.status === 200 && same(byKey.body?.serviceRadius, AREA) && byKey.body?.publishLocation === false && typeof byKey.body?.door === 'string',
        `the owner's key session: the whole config, the place exact (${byKey.status} ${byKey.text})`);
    const byAdminKey = await readConfig({ headers: ADMIN_KEY });
    assert(byAdminKey.status === 200 && byAdminKey.text === byKey.text, `an admin's key session: the same answer (${byAdminKey.status} ${byAdminKey.text})`);
    for (const [who, headers] of [
        ['the password sign-in\'s session (Settings, a cookie)', PASSWORD_SESSION],
        ['the password header with a code (the fleet manager)', tfa.headers()],
    ] as const) {
        const r = await readConfig({ headers });
        assert(r.status === 200 && r.text === byKey.text,
            `${who}: the owner's key session's answer, byte for byte (${r.status} ${r.text})`);
        const shown = Object.fromEntries(Object.keys(STORED).map(k => [k, r.body?.[k]]));
        assert(same(shown, STORED), `${who}: every directory setting as stored, the place exact (${show(shown)})`);
    }

    console.log('\n── 2. A Save from the Node Identity screen after that read writes nothing back changed ──');
    const read = await readConfig({ headers: PASSWORD_SESSION });
    const body = managerSaveBody(read.body);
    const save = await call('POST', '/api/local/admin/node/config', { headers: { ...PASSWORD_SESSION, 'X-CSRF-Token': signIn.body.csrfToken }, body });
    assert(save.status === 200, `the Save is taken (${save.status} ${save.text.slice(0, 160)})`);
    assert(se.getNodeConfig().publishLocation === false, `"Share Location & Radius" is still off (${show(se.getNodeConfig().publishLocation)}; the Save sent ${show(body)})`);
    assert(same(stored(), STORED), `and every other setting is as stored (${show(stored())})`);
    const strangerAfter = await readConfig({ id: stranger });
    assert(strangerAfter.status === 200 && same(strangerAfter.body, { serviceRadius: null }),
        `a stranger still gets no place after the Save (${strangerAfter.status} ${strangerAfter.text})`);

    console.log('\n── 3. Everyone else keeps #2387\'s answer on a preview ──');
    // As stored again, whatever the Save above did: each section's verdict is its own.
    se.updateNodeConfig(STORED);
    const unsigned = await readConfig();
    assert(unsigned.status === 200 && same(unsigned.body, { serviceRadius: null }),
        `unsigned: the service area alone, null with the switch off (${unsigned.status} ${unsigned.text})`);
    const signedStranger = await readConfig({ id: stranger });
    assert(signedStranger.status === 200 && signedStranger.text === unsigned.text,
        `signed by a stranger: the unsigned answer, byte for byte (${signedStranger.status} ${signedStranger.text})`);
    const asMember = await readConfig({ id: member });
    assert(asMember.status === 200 && same(asMember.body?.serviceRadius, ROUNDED_AREA) && same({ ...asMember.body, serviceRadius: AREA }, byKey.body),
        `a member: the whole config, the place to two decimals (${asMember.status} ${asMember.text})`);
    const wrong = await readConfig({ headers: { 'X-Admin-Password': 'not the password', 'X-Admin-TOTP': tfa.code() } });
    assert(wrong.status === 200 && wrong.text === unsigned.text,
        `a wrong password: the stranger's answer, never a refusal (${wrong.status} ${wrong.text})`);
    const stale = await readConfig({ headers: { Cookie: `admin_session=${'a'.repeat(64)}` } });
    assert(stale.status === 200 && stale.text === unsigned.text,
        `a session the node doesn't know: the stranger's answer (${stale.status} ${stale.text})`);
    // The node's 2FA off again. That ends the session the password opened under it, and a password sign-in now opens one
    // held to the 2FA card (#1537): checkAdminAuth names it the owner, then refuses it every route but the card's.
    updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] });
    const ended = await readConfig({ headers: PASSWORD_SESSION });
    assert(ended.status === 200 && ended.text === unsigned.text,
        `the password session the 2FA change ended: the stranger's answer (${ended.status} ${ended.text})`);
    const heldSignIn = await call('POST', '/api/local/admin/auth/password', { body: { password: PW } });
    const heldCookie = (heldSignIn.headers.getSetCookie().find(c => c.startsWith('admin_session=')) ?? '').split(';')[0];
    if (heldSignIn.status !== 200 || heldSignIn.body?.totpSetupRequired !== true || !heldCookie) {
        throw new Error(`setup: no password session held to the 2FA card (${heldSignIn.status} ${heldSignIn.text})`);
    }
    const gated = await readConfig({ headers: { Cookie: heldCookie } });
    assert(gated.status === 200 && gated.text === unsigned.text,
        `a password session held to the 2FA card (the node's 2FA off): the stranger's answer (${gated.status} ${gated.text})`);
    const headerNo2fa = await readConfig({ headers: { 'X-Admin-Password': PW } });
    assert(headerNo2fa.status === 200 && headerNo2fa.text === unsigned.text,
        `the password header with the node's 2FA off: the stranger's answer (${headerNo2fa.status} ${headerNo2fa.text})`);
    assert(same(stored(), STORED), `nothing above changed a setting (${show(stored())})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ On a private preview, the owner\'s password reads the whole config, and a Save from it keeps every switch.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
