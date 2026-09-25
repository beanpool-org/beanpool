/**
 * GET /api/node/config is a public read (PUBLIC_READ_EXACT): it returns the fields its readers use and nothing else.
 *
 * The stored node config also holds the public-address agent's state. On a node using the registrar's tunnel mode
 * that includes the Cloudflare tunnel token and the registrar contact, and the route used to return the stored
 * config whole, so anyone could read the token and run a connector on that node's tunnel.
 *
 * Boots the real server (real middleware, read auth at its default), seeds publicAddress the way the agent persists
 * it (services/public-address-agent.ts: a claim answer, then a status poll whose answer has no token, which
 * withKeptTunnelToken fills from the saved one), and asserts:
 *   1. an unsigned GET /api/node/config, and one signed by a non-member, contain neither the token nor the contact
 *   2. it still carries every field each of its readers uses, with the saved values
 *   3. the admin route the manager reads the public address from still returns it (token and contact included),
 *      and refuses a caller without the admin password
 *
 * Contacts no registrar: REGISTRAR_URL points at a closed local port, so the admin status route answers from the
 * saved address, as it does whenever the registrar is unreachable.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-node-config-public.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.ENFORCE_READ_AUTH;
process.env.REGISTRAR_URL = 'http://127.0.0.1:1';
const ADMIN_PASSWORD = 'NodeConfigAdmin123!';
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

import crypto from 'node:crypto';

const PORT = 8768;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// Made-up values, unique enough that a substring match can only be these.
const TUNNEL_TOKEN = 'fake-tunnel-token-NODECONFIG-TEST-7f3a9c2e51';
const CONTACT = 'operator-nodeconfig-test@example.invalid';

async function getRaw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
    const res = await fetch(`${BASE}${path}`, { headers });
    return { status: res.status, text: await res.text() };
}

function signedHeaders(path: string): Record<string, string> {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    return {
        'X-Public-Key': pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(`GET\n${path}\n${ts}\n${nonce}\n`), privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

async function main() {
    console.log('GET /api/node/config returns only what its public readers use...\n');
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { initStateEngine, getNodeConfig, updateNodeConfig } = await import('./state-engine.js');
    const { withKeptTunnelToken } = await import('./services/public-address-agent.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { startP2P } = await import('./p2p.js');

    await initTls();
    initAdminPassword();
    initStateEngine();
    await startHttpsServer(PORT);
    // The admin status route names the node's key in its answer, so the identity is loaded (ephemeral ports, no peers).
    await startP2P(0, 0);

    // What the operator set in Settings.
    const serviceRadius = { lat: -28.55, lng: 153.5, radiusKm: 25 };
    const lastDirectoryPush = '2026-09-20T10:00:00.000Z';
    updateNodeConfig({
        serviceRadius, publishLocation: true, publishMembers: false, publishContacts: true, publishHealth: false,
        directoryPushIntervalHours: 6, lastDirectoryPush,
    });

    // The agent's persist(): updateNodeConfig({ publicAddress: withKeptTunnelToken(pa, saved) }).
    const persist = (pa: any) => updateNodeConfig({ publicAddress: withKeptTunnelToken(pa, (getNodeConfig() as any).publicAddress) } as any);
    // 1. its claim: { name, mode, communityName, contact, ...the registrar's answer }
    persist({
        name: 'testvale', mode: 'tunnel', communityName: 'Test Vale', contact: CONTACT,
        status: 'live', hostname: 'testvale.beanpool.org', tunnelToken: TUNNEL_TOKEN,
    });
    // 2. a later status poll whose answer has no token (the registrar's Cloudflare call failed): the saved one is kept
    persist({
        status: 'live', name: 'testvale', hostname: 'testvale.beanpool.org', mode: 'tunnel',
        community_name: 'Test Vale', contact: CONTACT, reason: null, since: null,
    });
    const saved = (getNodeConfig() as any).publicAddress;
    if (saved?.tunnelToken !== TUNNEL_TOKEN || saved?.contact !== CONTACT) {
        throw new Error('setup: the seeded public address does not hold the token and contact');
    }

    console.log('── 1. neither the tunnel token nor the contact is in the public read ──');
    const unsigned = await getRaw('/api/node/config');
    const signed = await getRaw('/api/node/config', signedHeaders('/api/node/config'));
    for (const [who, r] of [['unsigned', unsigned], ['signed by a non-member', signed]] as const) {
        assert(r.status === 200, `${who} GET /api/node/config is 200 (got ${r.status})`);
        assert(!r.text.includes(TUNNEL_TOKEN), `${who}: the tunnel token is not in the body`);
        assert(!r.text.includes(CONTACT), `${who}: the registrar contact is not in the body`);
        assert(!/tunnelToken|publicAddress/.test(r.text), `${who}: no tunnelToken or publicAddress key in the body`);
    }

    console.log('\n── 2. every field its readers use is still there ──');
    const body = JSON.parse(unsigned.text);
    // The web app (MapPage, MarketplacePage) and the phone's map (map.tsx, unsigned fetch): serviceRadius lat/lng/radiusKm.
    // The manager's Node Identity screen and static/settings.js: serviceRadius plus the directory fields below.
    assert(body.serviceRadius?.lat === serviceRadius.lat, 'serviceRadius.lat (web map, phone map, manager, settings.js)');
    assert(body.serviceRadius?.lng === serviceRadius.lng, 'serviceRadius.lng (web map, phone map, manager, settings.js)');
    assert(body.serviceRadius?.radiusKm === serviceRadius.radiusKm, 'serviceRadius.radiusKm (web map, web marketplace, phone map, manager, settings.js)');
    assert(body.publishLocation === true, 'publishLocation (manager, settings.js)');
    assert(body.publishMembers === false, 'publishMembers (manager, settings.js)');
    assert(body.publishContacts === true, 'publishContacts (manager, settings.js)');
    assert(body.publishHealth === false, 'publishHealth (manager, settings.js)');
    assert(body.directoryPushIntervalHours === 6, 'directoryPushIntervalHours (manager, settings.js)');
    assert(body.lastDirectoryPush === lastDirectoryPush, 'lastDirectoryPush (manager, settings.js)');

    console.log('\n── 3. the manager still reads the public address from its admin route ──');
    const STATUS = '/api/local/admin/public-address/status';
    const refused = await getRaw(STATUS);
    assert(refused.status === 401, `without the admin password ${STATUS} is refused (got ${refused.status})`);
    assert(!refused.text.includes(TUNNEL_TOKEN) && !refused.text.includes(CONTACT), 'the refusal carries neither the token nor the contact');
    const admin = await getRaw(STATUS, { 'X-Admin-Password': ADMIN_PASSWORD });
    assert(admin.status === 200, `with the admin password ${STATUS} is 200 (got ${admin.status})`);
    const pa = JSON.parse(admin.text);
    // PublicAddressPanel reads name, hostname, mode, status, contact and tunnelToken from it.
    assert(pa.name === 'testvale', 'admin status: name');
    assert(pa.hostname === 'testvale.beanpool.org', 'admin status: hostname');
    assert(pa.mode === 'tunnel', 'admin status: mode');
    assert(pa.status === 'live', 'admin status: status');
    assert(pa.contact === CONTACT, 'admin status: contact');
    assert(pa.tunnelToken === TUNNEL_TOKEN, 'admin status: tunnelToken (the operator screen shows it)');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The public node config names its fields; the public address stays behind admin auth.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
