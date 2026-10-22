/**
 * test-share-location-off.ts — the manager's "Share Location & Radius" switch (node config `publishLocation`) OFF hides the
 * community's place from everyone who is not a member here (Marty, 23 Oct 2026, board card share-location-off: "Yes, OFF
 * means hidden"). The place is the manager's one map pin, saved as the service area's centre (`serviceRadius`) and as the
 * node's own place (local config `location`); an operator may have set it at home.
 *
 * Boots the real server (real middleware, read auth at its default) and asserts, over HTTP:
 *   1. OFF: an unsigned read and one signed by a key that is no member here get no place from GET /api/node/config
 *      (serviceRadius null, the other settings as before), /api/local/status or /api/local/dashboard (location null, the
 *      rest of the identity as before), nor from /api/directory/info or the directory push (which already sent none);
 *      the directory still names the community. The unsigned and the stranger's answers are the same bytes, so the
 *      answer says nothing about a key but what its own signer already knows.
 *   2. OFF: a member's signed GET /api/node/config gets today's pin to two decimals (~1 km); a suspended or disabled
 *      member's gets the stranger's answer (readsAsMember: while it lasts they read what a non-member reads); an owner's
 *      and an admin's key session get it exact (the manager's Node Identity screen saves it back); a session the node
 *      doesn't know gets the stranger's answer. /api/local/* is never signature-checked (https-server isSignatureBypassed), so status and
 *      the dashboard can't tell a member from a stranger: they give it to no one without an admin credential.
 *   3. OFF: no public read (every PUBLIC_READ_EXACT path, and the three /api/local/* reads that answer without a
 *      credential) holds a number within ~10 km of the place, unsigned or signed by a stranger.
 *   4. OFF on a private preview: a stranger's answer is the service area alone, and it is null; an owner's and an
 *      admin's key session still get the whole config (the Node Identity screen loads every switch from it, and saves
 *      them all back).
 *   5. ON: as before: anyone gets the pin to two decimals from each read, an owner or admin exact where they did.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-share-location-off.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.PRIVATE_PREVIEW;
process.env.REGISTRAR_URL = 'http://127.0.0.1:1';
process.env.ADMIN_PASSWORD = 'ShareLocationOff123!';

import crypto from 'node:crypto';

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

/** A GET as `id` signs it (null: unsigned), with any extra headers (an admin session). */
async function get(urlPath: string, id: Id | null = null, extra: Record<string, string> = {}): Promise<{ status: number; text: string; body: any }> {
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`GET\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { headers, redirect: 'manual' });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body };
}

// Made-up, and unlike any other number a read carries.
const PLACE = { lat: -28.55555, lng: 153.49999 };
const RADIUS_KM = 25;
const AREA = { ...PLACE, radiusKm: RADIUS_KM };
const ROUNDED = { lat: -28.56, lng: 153.5 };
const ROUNDED_AREA = { ...ROUNDED, radiusKm: RADIUS_KM };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => JSON.stringify(v);

/** Whether `text` holds a number within ~10 km (0.1°) of the place's latitude and another of its longitude. */
function holdsThePlace(text: string): boolean {
    const nums = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
    return nums.some(n => Math.abs(n - PLACE.lat) < 0.1) && nums.some(n => Math.abs(n - PLACE.lng) < 0.1);
}

async function main() {
    console.log('"Share Location & Radius" OFF hides the community\'s place from everyone but its members...\n');
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword, updateLocalConfig, updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer, PUBLIC_READ_EXACT } = await import('./https-server.js');
    const { startP2P } = await import('./p2p.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { ownerSessionHeaders } = await import('./admin-auth-test-harness.js');

    await initTls();
    initAdminPassword();
    se.initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    // The dashboard names the node's key (ephemeral ports, no peers).
    await startP2P(0, 0);
    // This suite reads every public route several times over; the gateway's per-address minute is not what it measures.
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    const OWNER = ownerSessionHeaders();
    const adminKey = newId();
    se.seedGenesisMember(adminKey.pk, 'PlaceAdmin');
    se.grantNodeRole(adminKey.pk, 'admin', 'SYSTEM');
    const adminSession = consumeHandshakeToken(mintHandshakeToken(adminKey.pk, 'admin').handshakeToken);
    if (!adminSession.ok || !adminSession.sessionId) throw new Error(`setup: no admin session (${adminSession.error})`);
    const ADMIN = { 'X-Admin-Session': adminSession.sessionId };
    const STALE = { 'X-Admin-Session': 'a'.repeat(64) };
    const member = newId();
    se.seedGenesisMember(member.pk, 'PlaceMember');
    const stranger = newId();
    if (!se.isNodeMember(member.pk) || se.isNodeMember(stranger.pk)) throw new Error('setup: the member is no member, or the stranger is one');
    // Members suspended and disabled, as a re-key, an admin, a report or a community vote leaves the row: still members
    // (isNodeMember), who read what a non-member reads while it lasts (readsAsMember).
    const { db } = await import('./db/db.js');
    const suspended = newId();
    se.seedGenesisMember(suspended.pk, 'PlaceSuspended');
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(suspended.pk);
    const disabled = newId();
    se.seedGenesisMember(disabled.pk, 'PlaceDisabled');
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(disabled.pk);
    for (const id of [suspended, disabled]) {
        if (!se.isNodeMember(id.pk) || se.readsAsMember(id.pk)) throw new Error('setup: a suspended or disabled member is no member, or reads as one');
    }

    // What the operator set in the manager: one pin, saved as both (NodeIdentityPanel handleSave).
    updateLocalConfig({ communityName: 'Placeholder Vale', callsign: 'placevale', location: PLACE });
    se.updateNodeConfig({ serviceRadius: AREA, publishLocation: false });

    console.log('── 1. OFF: a stranger gets no place ──');
    const cfgUnsigned = await get('/api/node/config');
    const cfgStranger = await get('/api/node/config', stranger);
    for (const [who, r] of [['unsigned', cfgUnsigned], ['signed by a stranger', cfgStranger]] as const) {
        assert(r.status === 200 && r.body?.serviceRadius === null,
            `${who} GET /api/node/config: serviceRadius null (${r.status} ${show(r.body?.serviceRadius)})`);
        assert(r.body?.publishLocation === false && r.body?.directoryPushIntervalHours === 12 && typeof r.body?.acceptKnocks === 'boolean' && typeof r.body?.door === 'string',
            `${who}: the other settings are still there, the switch read as off (${r.text.slice(0, 200)})`);
    }
    assert(cfgUnsigned.text === cfgStranger.text, `the stranger's answer is the unsigned answer, byte for byte`);
    for (const [who, id] of [['unsigned', null], ['signed by a stranger', stranger]] as const) {
        const status = await get('/api/local/status', id);
        assert(status.status === 200 && status.body?.location === null && status.body?.callsign === 'placevale',
            `${who} GET /api/local/status: location null, the callsign still said (${status.status} ${status.text})`);
        const dash = await get('/api/local/dashboard', id);
        const ident = dash.body?.identity ?? {};
        assert(dash.status === 200 && ident.location === null && ident.callsign === 'placevale' && typeof ident.peerId === 'string' && ident.peerId !== 'unknown',
            `${who} GET /api/local/dashboard: identity.location null, the rest of the identity as before (${dash.status} ${dash.text})`);
    }
    const dir = await get('/api/directory/info');
    assert(dir.status === 200 && dir.body?.serviceRadius === null && dir.body?.communityName === 'Placeholder Vale',
        `/api/directory/info: no service area, and it still names the community (${dir.status} ${show({ serviceRadius: dir.body?.serviceRadius, communityName: dir.body?.communityName })})`);
    const pushed = se.getDirectoryInfo();
    assert(pushed.serviceRadius === null && pushed.communityName === 'Placeholder Vale' && !holdsThePlace(JSON.stringify(pushed)),
        `a push to the directory sends no place, and the community's name (${show({ serviceRadius: pushed.serviceRadius, communityName: pushed.communityName })})`);

    console.log('\n── 2. OFF: a member keeps the ~1 km pin; an owner or admin the exact one ──');
    const cfgMember = await get('/api/node/config', member);
    assert(cfgMember.status === 200 && same(cfgMember.body?.serviceRadius, ROUNDED_AREA),
        `a member's signed GET /api/node/config: the centre to two decimals (${cfgMember.status} ${show(cfgMember.body?.serviceRadius)})`);
    assert(same({ ...cfgMember.body, serviceRadius: null }, cfgUnsigned.body),
        `and every other field as a stranger has it`);
    for (const [who, id] of [['a suspended member', suspended], ['a disabled member', disabled]] as const) {
        const cfg = await get('/api/node/config', id);
        assert(cfg.status === 200 && cfg.body?.serviceRadius === null && cfg.text === cfgUnsigned.text,
            `${who}'s signed GET /api/node/config: no place, the stranger's answer byte for byte (${cfg.status} ${show(cfg.body?.serviceRadius)})`);
    }
    const wholeConfig: Record<string, string> = {};
    for (const [who, headers] of [['an owner', OWNER], ['an admin', ADMIN]] as const) {
        const cfg = await get('/api/node/config', null, headers);
        wholeConfig[who] = cfg.text;
        assert(cfg.status === 200 && same(cfg.body?.serviceRadius, AREA),
            `${who}'s key session, GET /api/node/config: the exact centre (${cfg.status} ${show(cfg.body?.serviceRadius)})`);
        const dash = await get('/api/local/dashboard', null, headers);
        assert(dash.status === 200 && same(dash.body?.identity?.location, PLACE),
            `${who}'s key session, GET /api/local/dashboard: the exact place (${dash.status} ${show(dash.body?.identity?.location)})`);
    }
    const cfgStale = await get('/api/node/config', null, STALE);
    assert(cfgStale.status === 200 && cfgStale.text === cfgUnsigned.text,
        `a session the node doesn't know (a cookie that ran out) gets the stranger's answer, never a 401 (${cfgStale.status} ${show(cfgStale.body?.serviceRadius)})`);
    const statusMember = await get('/api/local/status', member);
    assert(statusMember.status === 200 && statusMember.body?.location === null,
        `/api/local/status isn't signature-checked, so a member's signed read is a stranger's there: no place (${statusMember.status} ${show(statusMember.body?.location)})`);

    console.log('\n── 3. OFF: no public read holds the place ──');
    const reads = [...PUBLIC_READ_EXACT, '/api/local/status', '/api/local/dashboard', '/api/local/community-info'];
    const holding: string[] = [];
    for (const p of reads) {
        for (const [who, id] of [['unsigned', null], ['stranger', stranger]] as const) {
            const r = await get(p, id);
            if (holdsThePlace(r.text)) holding.push(`${who} ${p} (${r.status} ${r.text.slice(0, 120)})`);
        }
    }
    assert(holding.length === 0, `none of ${reads.length} public reads, unsigned or a stranger's, holds a number within ~10 km of the place${holding.length ? `: ${holding.join('; ')}` : ''}`);

    console.log('\n── 4. OFF on a private preview: the stranger\'s one field is null ──');
    process.env.PRIVATE_PREVIEW = '1';
    try {
        const preview = await get('/api/node/config', stranger);
        assert(preview.status === 200 && same(preview.body, { serviceRadius: null }),
            `a stranger's GET /api/node/config on a private preview: { serviceRadius: null } (${preview.status} ${preview.text})`);
        const previewMember = await get('/api/node/config', member);
        assert(previewMember.status === 200 && same(previewMember.body?.serviceRadius, ROUNDED_AREA),
            `a member's: the centre to two decimals, as before (${previewMember.status} ${show(previewMember.body?.serviceRadius)})`);
        const previewDisabled = await get('/api/node/config', disabled);
        assert(previewDisabled.status === 200 && previewDisabled.body?.serviceRadius === null,
            `a disabled member's: no place (${previewDisabled.status} ${show(previewDisabled.body?.serviceRadius)})`);
        for (const [who, headers] of [['an owner', OWNER], ['an admin', ADMIN]] as const) {
            const cfg = await get('/api/node/config', null, headers);
            assert(cfg.status === 200 && cfg.text === wholeConfig[who] && cfg.body?.publishLocation === false && typeof cfg.body?.acceptKnocks === 'boolean',
                `${who}'s key session: the whole config, as off a preview, so a save from the Node Identity screen keeps the switch off (${cfg.status} ${cfg.text.slice(0, 200)})`);
        }
    } finally {
        delete process.env.PRIVATE_PREVIEW;
    }

    console.log('\n── 5. ON: as before ──');
    se.updateNodeConfig({ publishLocation: true });
    for (const [who, id] of [['unsigned', null], ['signed by a stranger', stranger], ['signed by a member', member], ['signed by a disabled member', disabled]] as const) {
        const cfg = await get('/api/node/config', id);
        assert(cfg.status === 200 && same(cfg.body?.serviceRadius, ROUNDED_AREA) && cfg.body?.publishLocation === true,
            `${who} GET /api/node/config: the centre to two decimals (${cfg.status} ${show(cfg.body?.serviceRadius)})`);
        const status = await get('/api/local/status', id);
        assert(status.status === 200 && same(status.body?.location, ROUNDED),
            `${who} GET /api/local/status: the place to two decimals (${status.status} ${show(status.body?.location)})`);
        const dash = await get('/api/local/dashboard', id);
        assert(dash.status === 200 && same(dash.body?.identity?.location, ROUNDED),
            `${who} GET /api/local/dashboard: the place to two decimals (${dash.status} ${show(dash.body?.identity?.location)})`);
    }
    for (const [who, headers] of [['an owner', OWNER], ['an admin', ADMIN]] as const) {
        const cfg = await get('/api/node/config', null, headers);
        assert(cfg.status === 200 && same(cfg.body?.serviceRadius, AREA), `${who}'s key session: the exact centre (${show(cfg.body?.serviceRadius)})`);
        const dash = await get('/api/local/dashboard', null, headers);
        assert(dash.status === 200 && same(dash.body?.identity?.location, PLACE), `${who}'s key session, the dashboard: the exact place (${show(dash.body?.identity?.location)})`);
    }
    const dirOn = await get('/api/directory/info');
    assert(dirOn.status === 200 && same(dirOn.body?.serviceRadius, ROUNDED_AREA),
        `/api/directory/info: the centre to two decimals (${show(dirOn.body?.serviceRadius)})`);
    assert(same(se.getDirectoryInfo().serviceRadius, ROUNDED_AREA), `and a push sends the same (${show(se.getDirectoryInfo().serviceRadius)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ With "Share Location & Radius" off, only members, owners and admins get the community\'s place.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
