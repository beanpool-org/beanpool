/**
 * Lights-out H1: the owner's switch on the server (services/lights-out.ts, routes/lights-out.ts; design
 * scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §5 H1), through the real plain listener (http-server.ts), the real
 * gate (plain-http-gate.ts) and the real HTTPS app behind it, with its signature middleware. No BeanPool node, DNS or
 * tunnel is contacted. A test hook gives an accepted socket another remote address (a phone on the hall Wi-Fi, the
 * Internet, Docker's bridge gateway), as test-plain-http-gate.ts does.
 *
 *   0. no certificate of its own: /hall answers the hall Wi-Fi (closed while off), never the Internet or a tunnel;
 *   1. with one, the switch OFF: the hall Wi-Fi gets a 301 except Settings, the sign-in, the switch, /hall and the door's
 *      four reads; /api/ledger/transfer stays 301; a proxy header, a public Host, a public source or a dot segment: 301;
 *      the socket the same;
 *   2. the switch: unsigned 401; a member, an admin, a stale owner signature, an automation token, an assistant's token, a
 *      computer's session, an admin's session, the password with 2FA off, the password without a current code, a standby:
 *      refused, nothing changed. The owner signed for the community's NAME over plain http at the number: on (request
 *      binding unchanged); signed for the NUMBER on this named node: 421. The phone's Manage session and the password with
 *      a current code: on/off through Settings' route. "On" twice is "on";
 *   3. ON: the hall Wi-Fi is served (a page, a write, the socket); the Internet, a tunnel-shaped request and a proxy's are
 *      still redirected; loopback always; /hall shows the lines and the door link; health + info carry `lightsOut`;
 *   4. §2.7: address changes refused while on (409), allowed again once off;
 *   5. the epoch: a server never restored is not raised; a restored copy is raised once (max(own, file) + 1, since now) and
 *      never again for that restore; one that took over after its restore is not; recordAsOf is the backup's made-at;
 *      the stand-down offer on OFF with no hall writes, none after a member wrote;
 *   6. the switch is in no copy: a sealed backup's node_config.json and its take-over bundle, a snapshot, the redacted
 *      config; the manifest says per-server; the stager leaves it out;
 *   7. `beanpool lights-out`: the node takes the request within 2 s and answers; the log keeps a SECURITY line.
 *
 * Run: BEANPOOL_SUITE_ENV_PASSWORD=1 BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-lights-out.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const dataDir = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || process.env.TMPDIR || os.tmpdir(), 'lights-out-'));
process.env.BEANPOOL_DATA_DIR = dataDir;
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'NODE_ROLE', 'PUBLIC_IP']) delete process.env[k];
const OWN = 'beans.example.org';
process.env.BEANPOOL_ADDRESSES = OWN;
const PASSWORD = 'Lights-Out-Suite-Pw-5521!';
process.env.ADMIN_PASSWORD ??= PASSWORD;

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
    if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const { initAdminPassword, getLocalConfig, updateLocalConfig, redactLocalConfig } = await import('./config/local-config.js');
const tlsMod = await import('./services/tls.js');
const se = await import('./state-engine.js');
const { db } = await import('./db/db.js');
const { startHttpServer, _setPlainConnectionHookForTests } = await import('./http-server.js');
const { startHttpsServer } = await import('./https-server.js');
const core = await import('@beanpool/core');
const { ed25519 } = await import('@noble/curves/ed25519.js');
const harness = await import('./admin-auth-test-harness.js');
const lo = await import('./services/lights-out.js');
const { setNodeRole } = await import('./config/node-role.js');
const { logger } = await import('./logger.js');
const { runLightsOut } = await import('./lights-out-command.js');
const { LOCAL_CONFIG_FIELDS } = await import('./engine/replication-manifest.js');

initAdminPassword();
await tlsMod.initTls();
se.initStateEngine();
// The community's genesis and the node's key: the identity statement is signed with the key, and a backup is locked only
// once both exist.
await (await import('./genesis.js')).ensureGenesis();
{
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
}
const httpPort = await startHttpServer(0);
await startHttpsServer(0);

let fakeRemote: string | null = null;
_setPlainConnectionHookForTests((socket) => {
    if (fakeRemote !== null) Object.defineProperty(socket, 'remoteAddress', { value: fakeRemote, configurable: true });
});

interface Answer { status: number; headers: Record<string, string>; body: string; json: any }
function raw(from: string | null, request: string, untilHead = false): Promise<Answer> {
    fakeRemote = from;
    return new Promise((resolve, reject) => {
        const sock = net.connect(httpPort, '127.0.0.1');
        let data = '';
        sock.setTimeout(15_000, () => { sock.destroy(); reject(new Error('timed out')); });
        sock.on('data', (d) => { data += d.toString('latin1'); if (untilHead && data.includes('\r\n\r\n')) sock.destroy(); });
        sock.on('error', reject);
        sock.on('close', () => {
            const [head, ...rest] = data.split('\r\n\r\n');
            const lines = head.split('\r\n');
            const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
            const headers: Record<string, string> = {};
            for (const l of lines.slice(1)) {
                const i = l.indexOf(':');
                if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
            }
            let body = rest.join('\r\n\r\n');
            if ((headers['transfer-encoding'] ?? '').includes('chunked')) {
                let out = '', s = body;
                for (;;) { const m = /^([0-9a-f]+)\r\n/i.exec(s); if (!m) break; const n = parseInt(m[1], 16); if (!n) break; out += s.slice(m[0].length, m[0].length + n); s = s.slice(m[0].length + n + 2); }
                body = out;
            }
            let json: any = null;
            try { json = JSON.parse(Buffer.from(body, 'latin1').toString('utf8')); } catch { /* not json */ }
            resolve({ status, headers, body: Buffer.from(body, 'latin1').toString('utf8'), json });
        });
        sock.write(request);
    });
}
function send(from: string | null, method: string, p: string, host: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
    const h = { Host: host, Connection: 'close', ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}) };
    return raw(from, `${method} ${p} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body ?? ''}`);
}
const upgrade = (from: string | null, host: string, extra = '') => raw(from, `GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\n`
    + `Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\n${extra}\r\n`, true);

const LAN = '192.168.8.20';          // a phone on the hall Wi-Fi
const HALL = '192.168.8.1:8080';     // the laptop's number, as the phone types it
const PUBLIC = '203.0.113.9';
const BRIDGE = '172.17.0.1';         // Docker's bridge gateway: a host-level tunnel or proxy
const ADDRESS = `http://${HALL}`;

// Members with keys this suite can sign with.
type Id = { pk: string; seed: Uint8Array; callsign: string };
function member(callsign: string, role?: 'owner' | 'admin'): Id {
    const seed = new Uint8Array(crypto.randomBytes(32));
    const pk = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pk, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    if (role) se.grantNodeRole(pk, role, 'SYSTEM');
    return { pk, seed, callsign };
}
const owner = member('hallOwner', 'owner');
const admin = member('hallAdmin', 'admin');
const plain = member('hallMember');

async function signed(who: Id, method: string, p: string, signFor: string, body: unknown, timestamp?: number): Promise<Record<string, string>> {
    return core.buildBoundRequestHeaders({ method, url: `${signFor}${p}`, body: JSON.stringify(body), publicKeyHex: who.pk, sign: core.ed25519Signer(who.seed), timestamp });
}
async function phoneSwitch(who: Id, body: unknown, opts: { signFor?: string; timestamp?: number; from?: string } = {}): Promise<Answer> {
    const headers = await signed(who, 'POST', '/api/node/owner/lights-out', opts.signFor ?? `https://${OWN}`, body, opts.timestamp);
    return send(opts.from ?? LAN, 'POST', '/api/node/owner/lights-out', HALL, headers, JSON.stringify(body));
}
const settingsSwitch = (headers: Record<string, string>, body: unknown, from = LAN) => send(from, 'POST', '/api/local/admin/lights-out', HALL, headers, JSON.stringify(body));
const isOn = () => getLocalConfig().lightsOut?.on === true;

// ── 0. No certificate of its own ────────────────────────────────────────────────────────────────────────────────
console.log('\n0. A node with no certificate of its own: /hall to the hall Wi-Fi only');
{
    check('no certificate of its own at the start', !tlsMod.holdsOwnCertificate(() => [OWN]));
    const hall = await send(LAN, 'GET', '/hall', HALL);
    check('the hall Wi-Fi gets /hall: "The hall is closed" while off', hall.status === 200 && hall.body.includes('data-hall="closed"') && hall.body.includes(OWN), `${hall.status} ${hall.body.slice(0, 120)}`);
    const pub = await send(PUBLIC, 'GET', '/hall', HALL);
    check('the Internet gets a plain 404 for /hall', pub.status === 404 && !pub.body.includes('data-hall'), String(pub.status));
    const tunnel = await send('127.0.0.1', 'GET', '/hall', OWN, { 'CF-Connecting-IP': PUBLIC, 'Cf-Ray': 'abc-SYD' });
    check('the tunnel (loopback, CF headers, public Host) never gets the hall page', !tunnel.body.includes('data-hall'), String(tunnel.status));
    const proxied = await send(BRIDGE, 'GET', '/hall', HALL, { 'X-Forwarded-For': PUBLIC });
    check('a proxy\'s request (private source, X-Forwarded-For) gets a 404', proxied.status === 404 && !proxied.body.includes('data-hall'), String(proxied.status));
    const publicHost = await send(LAN, 'GET', '/hall', OWN);
    check('a private source naming the public name gets a 404', publicHost.status === 404, String(publicHost.status));
}

// ── A certificate of its own ─────────────────────────────────────────────────────────────────────────────────────
const made = selfsigned.generate([{ name: 'commonName', value: OWN }], {
    days: 30, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: OWN }] }],
});
check('the test certificate is served', tlsMod.serveCertificate(OWN, { cert: made.cert, key: made.private }) === null);
const { acmeTargets } = await import('./services/acme/schedule.js');
check('the node now holds a certificate of its own', tlsMod.holdsOwnCertificate(() => acmeTargets().map((t) => t.host)));

// ── 1. OFF ───────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. The switch off: the hall Wi-Fi reaches Settings, the sign-in and the switch, nothing else');
{
    const r301 = (a: Answer) => a.status === 301 && (a.headers.location ?? '').startsWith('https://');
    check('a page of the app → 301', r301(await send(LAN, 'GET', '/api/version', HALL)));
    check('/api/ledger/transfer → 301 (the money route stays shut)', r301(await send(LAN, 'POST', '/api/ledger/transfer', HALL, {}, '{}')));
    for (const p of ['/settings', '/settings/', '/api/local/admin/auth/session', '/api/local/admin/lights-out', '/api/community/health', '/api/node/identity-epoch']) {
        const a = await send(LAN, 'GET', p, HALL);
        check(`${p} is reached (not redirected)`, a.status !== 301 && a.status !== 0, String(a.status));
    }
    const hall = await send(LAN, 'GET', '/hall', HALL);
    check('/hall is reached and says the hall is closed', hall.status === 200 && hall.body.includes('data-hall="closed"'), String(hall.status));
    check('a proxy header → 301 (not straight from the Wi-Fi)', r301(await send(BRIDGE, 'GET', '/settings', HALL, { 'X-Forwarded-For': PUBLIC })));
    check('the public name from a private source → 301 (not the hall)', r301(await send(LAN, 'GET', '/settings/', 'other.example.net')));
    check('a public source → 301', r301(await send(PUBLIC, 'GET', '/settings', HALL)));
    check('a dot segment past the list → 301', r301(await send(LAN, 'GET', '/settings/../api/version', HALL)));
    check('an encoded slash past the list → 301', r301(await send(LAN, 'GET', '/settings%2f..%2fapi/version', HALL)));
    const ws = await upgrade(LAN, HALL);
    check('the live-updates socket from the hall Wi-Fi → 301 while off', ws.status === 301, String(ws.status));
    const loop = await send('127.0.0.1', 'GET', '/api/version', '127.0.0.1:8080');
    check('loopback is always served', loop.status === 200, String(loop.status));
}

// ── 2. The switch ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. Who may flip it');
{
    const unsigned = await send(LAN, 'POST', '/api/node/owner/lights-out', HALL, {}, JSON.stringify({ on: true }));
    check('unsigned → 401', unsigned.status === 401 && !isOn(), `${unsigned.status} ${unsigned.body.slice(0, 100)}`);
    const byMember = await phoneSwitch(plain, { on: true });
    check('a member → 403', byMember.status === 403 && !isOn(), `${byMember.status} ${byMember.body.slice(0, 100)}`);
    const byAdmin = await phoneSwitch(admin, { on: true });
    check('an admin → 403', byAdmin.status === 403 && !isOn(), String(byAdmin.status));
    const stale = await phoneSwitch(owner, { on: true }, { timestamp: Date.now() - 120_000 });
    check('the owner\'s signature from 2 minutes ago → 403 step_up_required (fresh proof is 90 s)', stale.status === 403 && stale.json?.code === 'step_up_required' && !isOn(), `${stale.status} ${stale.body.slice(0, 100)}`);
    const forNumber = await phoneSwitch(owner, { on: true }, { signFor: ADDRESS });
    check('signed for the number on this named node → 421 (binding unchanged)', forNumber.status === 421 && !isOn(), `${forNumber.status} ${forNumber.body.slice(0, 100)}`);
    const badBody = await phoneSwitch(owner, { on: 'yes' });
    check('`on` that is not a boolean → 400', badBody.status === 400 && !isOn(), String(badBody.status));

    const token = await settingsSwitch(harness.ownerTokenHeaders('admin', owner.pk), { on: true });
    check('an owner\'s automation token → 403', token.status === 403 && !isOn(), `${token.status} ${token.body.slice(0, 100)}`);
    const agent = await settingsSwitch(harness.ownerTokenHeaders('agent', owner.pk), { on: true });
    check('an AI assistant\'s token → refused', (agent.status === 401 || agent.status === 403) && !isOn(), String(agent.status));
    const computer = await settingsSwitch(harness.ownerSessionHeaders(owner.pk), { on: true });
    check('a computer\'s session → 403 phone_required', computer.status === 403 && computer.json?.code === 'phone_required' && !isOn(), `${computer.status} ${computer.body.slice(0, 100)}`);
    const adminPhone = await settingsSwitch(harness.ownerPhoneSessionHeaders(admin.pk), { on: true });
    check('an admin\'s phone session → 403', adminPhone.status === 403 && !isOn(), String(adminPhone.status));
    const pwNo2fa = await settingsSwitch({ 'X-Admin-Password': PASSWORD }, { on: true });
    check('the password with the node\'s 2FA off → refused (fails closed)', (pwNo2fa.status === 401 || pwNo2fa.status === 403) && !isOn(), `${pwNo2fa.status} ${pwNo2fa.body.slice(0, 100)}`);

    setNodeRole('backup');
    const standby = await phoneSwitch(owner, { on: true });
    check('on a standby → 403', standby.status === 403 && !isOn(), `${standby.status} ${standby.body.slice(0, 100)}`);
    check('on a standby the switch never reads as on', !lo.lightsOutOn());
    setNodeRole('primary');

    const on = await phoneSwitch(owner, { on: true, address: ADDRESS });
    check('the owner, signed for the community\'s NAME, over plain http at the number → on', on.status === 200 && on.json?.lightsOut?.on === true && isOn(), `${on.status} ${on.body.slice(0, 160)}`);
    check('the hall address is kept', getLocalConfig().lightsOut?.address === ADDRESS, String(getLocalConfig().lightsOut?.address));
    const since = getLocalConfig().lightsOut?.since;
    const again = await phoneSwitch(owner, { on: true });
    check('"on" twice is "on": same since, not changed', again.status === 200 && again.json?.changed === false && getLocalConfig().lightsOut?.since === since);
    const badAddr = await phoneSwitch(owner, { on: true, address: 'https://evil.example.com' });
    check('a hall address that is not a local number → 400', badAddr.status === 400, String(badAddr.status));

    // Off and on through Settings: the phone's Manage session, and the password with a current code.
    const off = await settingsSwitch(harness.ownerPhoneSessionHeaders(owner.pk), { on: false });
    check('Settings, the phone\'s Manage session → off', off.status === 200 && !isOn(), `${off.status} ${off.body.slice(0, 120)}`);
    const twofa = harness.turnOn2faForTests(PASSWORD);
    // The fresh proof on the password path: a current code, once. The same code a second time is refused.
    const once = twofa.code();
    const pwOn = await settingsSwitch({ 'X-Admin-Password': PASSWORD, 'X-Admin-TOTP': once }, { on: true, address: ADDRESS, code: once });
    check('the password with a current authenticator code → on', pwOn.status === 200 && isOn(), `${pwOn.status} ${pwOn.body.slice(0, 120)}`);
    await phoneSwitch(owner, { on: false });
    const reused = await settingsSwitch({ 'X-Admin-Password': PASSWORD, 'X-Admin-TOTP': once }, { on: true, address: ADDRESS, code: once });
    check('the same code again → refused, nothing changed', (reused.status === 401 || reused.status === 403) && !isOn(), `${reused.status} ${reused.body.slice(0, 120)}`);
    const pwOn2 = await settingsSwitch(twofa.headers(), { on: true, address: ADDRESS, code: twofa.code() });
    check('… and a new current code → on', pwOn2.status === 200 && isOn(), `${pwOn2.status} ${pwOn2.body.slice(0, 120)}`);
    updateLocalConfig({ totpEnabled: false, totpSecret: null });
}

// ── 3. ON ────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3. The switch on: the hall Wi-Fi is served; the Internet and the tunnel are not');
{
    check('the switch is on', lo.lightsOutOn());
    const page = await send(LAN, 'GET', '/api/version', HALL);
    check('a page of the app from the hall Wi-Fi → served', page.status === 200, String(page.status));
    const transfer = await send(LAN, 'POST', '/api/ledger/transfer', HALL, {}, '{}');
    check('/api/ledger/transfer reaches the app (unsigned: refused by the app, not redirected)', transfer.status !== 301 && transfer.status >= 400, String(transfer.status));
    const pub = await send(PUBLIC, 'GET', '/api/version', HALL);
    check('a public source → 301, switch or no switch', pub.status === 301, String(pub.status));
    const tunnel = await send(BRIDGE, 'GET', '/api/version', 'other.example.net', { 'CF-Connecting-IP': PUBLIC });
    check('a tunnel-shaped request (bridge source, CF header, another host) → 301', tunnel.status === 301, String(tunnel.status));
    const proxy = await send(BRIDGE, 'GET', '/api/version', HALL, { 'X-Forwarded-For': PUBLIC });
    check('a proxy\'s request naming the number → 301 (not straight from the Wi-Fi)', proxy.status === 301, String(proxy.status));
    const loop = await send('127.0.0.1', 'GET', '/api/version', '127.0.0.1:8080');
    check('loopback → served', loop.status === 200, String(loop.status));
    const ws = await upgrade(LAN, HALL);
    check('the live-updates socket from the hall Wi-Fi → upgraded', ws.status === 101, String(ws.status));
    const wsPub = await upgrade(PUBLIC, HALL);
    check('the socket from the Internet → 301', wsPub.status === 301, String(wsPub.status));
    const wsProxy = await upgrade(BRIDGE, HALL, `X-Forwarded-For: ${PUBLIC}\r\n`);
    check('the socket through a proxy → 301', wsProxy.status === 301, String(wsProxy.status));

    const hall = await send(LAN, 'GET', '/hall', HALL);
    check('/hall: the poster, the four lines, the address', hall.status === 200 && hall.body.includes('data-hall="lines"') && hall.body.includes(HALL)
        && hall.body.includes('airplane mode') && hall.body.includes('can be read by others'), `${hall.status}`);
    const door = /href="(beanpool:\/\/hall\?[^"]+)"/.exec(hall.body)?.[1]?.replace(/&amp;/g, '&');
    const q = door ? new URL(door).searchParams : null;
    check('the hall door link names the number and the community\'s name', !!q && q.get('at') === HALL && q.get('for') === OWN, String(door));
    check('the slot for the Android app link is there (H3 fills it)', hall.body.includes('hall-android-slot'));
    check('/hall is never cached', /no-store/.test(hall.headers['cache-control'] ?? ''));
    const hallPub = await send(PUBLIC, 'GET', '/hall', HALL);
    check('/hall from the Internet → never the page', !hallPub.body.includes('data-hall'), String(hallPub.status));
    const hallTunnel = await send('127.0.0.1', 'GET', '/hall', OWN, { 'CF-Connecting-IP': PUBLIC });
    check('/hall through the tunnel → never the page', !hallTunnel.body.includes('data-hall'), String(hallTunnel.status));

    const health = await send(LAN, 'GET', '/api/community/health', HALL);
    const hl = health.json?.lightsOut;
    check('health: lightsOut { on, since, address, recordAsOf, home, epoch }', health.status === 200 && hl?.on === true && typeof hl.since === 'string'
        && hl.address === ADDRESS && hl.recordAsOf === null && hl.home === `https://${OWN}` && hl.epoch === 0, JSON.stringify(hl));
    const info = await send(LAN, 'GET', '/api/community/info', HALL);
    check('info: the same lightsOut', info.status === 200 && JSON.stringify(info.json?.lightsOut) === JSON.stringify(hl), JSON.stringify(info.json?.lightsOut));
}

// ── 4. §2.7 ──────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4. Address changes are refused while the hall is open');
{
    for (const p of ['/api/local/admin/public-address/claim', '/api/local/admin/public-address/offline', '/api/local/admin/app-addresses/confirm', '/api/local/admin/app-addresses/remove']) {
        const a = await send(LAN, 'POST', p, HALL, harness.ownerPhoneSessionHeaders(owner.pk), JSON.stringify({ address: '192.168.8.1' }));
        check(`${p} → 409 lights_out`, a.status === 409 && a.json?.code === 'lights_out', `${a.status} ${a.body.slice(0, 100)}`);
    }
    const check2 = await send(LAN, 'POST', '/api/local/admin/app-addresses/check', HALL, harness.ownerPhoneSessionHeaders(owner.pk), JSON.stringify({ address: OWN }));
    check('a read that is a POST (app-addresses/check) is not refused', check2.status !== 409, String(check2.status));
}

// ── 5. The epoch, recordAsOf, the stand-down offer ─────────────────────────────────────────────────────────────────
console.log('\n5. The epoch raise on a restored copy, the record as of, stand down');
{
    const offPhone = async () => phoneSwitch(owner, { on: false });
    const onPhone = async () => phoneSwitch(owner, { on: true, address: ADDRESS });
    check('a server never restored: the epoch was not raised', (getLocalConfig().identityEpoch ?? 0) === 0);
    let off = await offPhone();
    check('off after a hall on a server that is no copy: no stand-down offer', off.status === 200 && off.json?.lightsOut?.standDown === null, JSON.stringify(off.json?.lightsOut?.standDown));
    check('the hall page says closed again', (await send(LAN, 'GET', '/hall', HALL)).body.includes('data-hall="closed"'));

    // A restore leaves its note (routes/backup.ts restoreFromTar → noteRestoredCopy): made 1 Nov, its keys at epoch 3.
    lo.noteRestoredCopy('2026-11-01T10:00:00.000Z', 3);
    updateLocalConfig({ identityEpoch: 1 });
    const before = Date.now();
    const on = await onPhone();
    const c = getLocalConfig();
    check('restored copy + on → epoch max(1, 3) + 1 = 4', on.json?.epochRaised === true && c.identityEpoch === 4, `${c.identityEpoch}`);
    check('… with since = now', !!c.identityEpochSince && Date.parse(c.identityEpochSince) >= before - 1000, String(c.identityEpochSince));
    check('recordAsOf = the backup\'s made-at', on.json?.lightsOut?.recordAsOf === '2026-11-01T10:00:00.000Z', String(on.json?.lightsOut?.recordAsOf));
    const sigEpoch = await send(LAN, 'GET', '/api/node/identity-epoch', HALL);
    check('the signed statement says 4', sigEpoch.json?.statement?.epoch === 4, JSON.stringify(sigEpoch.json?.statement));
    const health = await send(LAN, 'GET', '/api/community/health', HALL);
    check('health says epoch 4 and the record as of', health.json?.lightsOut?.epoch === 4 && health.json?.lightsOut?.recordAsOf === '2026-11-01T10:00:00.000Z');
    off = await offPhone();
    check('off with no hall writes on a restored copy → the stand-down offer', off.json?.lightsOut?.standDown?.offered === true && off.json.lightsOut.hallWrites === false, JSON.stringify(off.json?.lightsOut));
    await onPhone();
    check('on again → never raised twice for one restore', getLocalConfig().identityEpoch === 4, String(getLocalConfig().identityEpoch));

    // A member writes in the hall (a signed write answered 2xx): OFF offers no stand-down.
    const areaBody = { lat: null, lng: null };
    const area = await send(LAN, 'POST', '/api/community/me/area', HALL, await signed(plain, 'POST', '/api/community/me/area', `https://${OWN}`, areaBody), JSON.stringify(areaBody));
    check('a member\'s signed write over plain http at the number → 200', area.status === 200, `${area.status} ${area.body.slice(0, 100)}`);
    off = await offPhone();
    check('off after a member wrote in the hall → hallWrites, no stand-down', off.json?.lightsOut?.hallWrites === true && off.json?.lightsOut?.standDown === null, JSON.stringify(off.json?.lightsOut));

    // A server that took over AFTER its restore: its take-over raised it; the switch doesn't again.
    updateLocalConfig({ lightsOut: null, restoredCopy: { at: '2026-11-02T00:00:00.000Z', madeAt: '2026-11-01T23:00:00.000Z', epoch: 5 },
        identityEpoch: 6, identityEpochSince: '2026-11-03T00:00:00.000Z', lastPromotionAudit: { at: '2026-11-03T00:10:00.000Z', ok: true, sumBalances: 0, drift: 0, strandedEscrows: 0, copy: { match: true, here: { accounts: 0, holdings: 0 }, lastCopy: { accounts: 0, holdings: 0, generatedAt: '2026-11-02T23:59:00.000Z' } } } });
    const tookOver = await onPhone();
    check('took over after the restore + on → not raised (6)', tookOver.json?.epochRaised === false && getLocalConfig().identityEpoch === 6, String(getLocalConfig().identityEpoch));
    check('… recordAsOf = the last good copy before the take-over', tookOver.json?.lightsOut?.recordAsOf === '2026-11-02T23:59:00.000Z', String(tookOver.json?.lightsOut?.recordAsOf));
}

// ── 6. In no copy ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n6. The switch travels in no copy');
{
    check('it is on as the copies are made', isOn() && !!getLocalConfig().restoredCopy);
    const red = redactLocalConfig(getLocalConfig()) as any;
    check('the redacted config (a backup file\'s node_config.json) has neither lightsOut nor restoredCopy', !('lightsOut' in red) && !('restoredCopy' in red));
    check('the manifest says per-server', LOCAL_CONFIG_FIELDS.lightsOut?.kind === 'per-server' && LOCAL_CONFIG_FIELDS.restoredCopy?.kind === 'per-server');
    const stagerSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'services', 'stager.ts'), 'utf8');
    const leftOut = /const CREDENTIALS_LEFT_OUT = \[([\s\S]*?)\];/.exec(stagerSrc)?.[1] ?? '';
    check('the stager\'s copy leaves both out', leftOut.includes("'lightsOut'") && leftOut.includes("'restoredCopy'"));

    const { makeRecoveryCode, BUNDLED_LOCAL_CONFIG_FIELDS } = await import('./services/takeover-envelope.js');
    check('the take-over bundle\'s field list has neither', !(BUNDLED_LOCAL_CONFIG_FIELDS as readonly string[]).includes('lightsOut') && !(BUNDLED_LOCAL_CONFIG_FIELDS as readonly string[]).includes('restoredCopy'));
    const code = await makeRecoveryCode();
    const { createSealedBackup, openSealedFileTo, readBundleFrom } = await import('./services/sealed-backup.js');
    const work = fs.mkdtempSync(path.join(dataDir, 'copies-'));
    const sealed = await createSealedBackup();
    const sealedFile = path.join(work, 'b.bpsealed');
    await new Promise<void>((resolve, reject) => sealed.body.pipe(fs.createWriteStream(sealedFile)).on('finish', resolve).on('error', reject));
    sealed.cleanup();
    const opened = path.join(work, 'b.tar.gz');
    const header = await openSealedFileTo(sealedFile, { type: 'code', code: code.code }, opened);
    const unpacked = path.join(work, 'unpacked');
    fs.mkdirSync(unpacked);
    spawnSync('tar', ['-xzf', opened, '-C', unpacked]);
    const nodeConfig = JSON.parse(fs.readFileSync(path.join(unpacked, 'node_config.json'), 'utf8'));
    check('a sealed backup\'s node_config.json: no lightsOut, no restoredCopy', !('lightsOut' in nodeConfig) && !('restoredCopy' in nodeConfig) && 'identityEpoch' in nodeConfig);
    const bundle = readBundleFrom(unpacked, header) as any;
    check('its take-over bundle: no lightsOut anywhere', !!bundle && !JSON.stringify(bundle).includes('lightsOut') && !JSON.stringify(bundle).includes('restoredCopy'));
    const { createSnapshot, resolveSnapshotPath } = await import('./services/snapshot-scheduler.js');
    const snap = createSnapshot('scheduled');
    const snapBytes = fs.readFileSync(resolveSnapshotPath(snap.name)!).toString('latin1');
    check('a snapshot (what a snapshot download seals): no lightsOut', !snapBytes.includes('lightsOut') && !snapBytes.includes(ADDRESS));
}

// ── 7. The shell ─────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n7. beanpool lights-out');
{
    const lines: string[] = [];
    const realSecurity = logger.security.bind(logger);
    (logger as any).security = (area: any, message: string) => { lines.push(`${area} ${message}`); return realSecurity(area, message); };
    lo.startLightsOutRequestWatch(dataDir, 2000);
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    const t0 = Date.now();
    const offCode = await runLightsOut(['off'], io);
    const took = Date.now() - t0;
    check('`beanpool lights-out off` → 0, taken within ~2 s', offCode === 0 && took <= 2600 && !isOn(), `${offCode} in ${took} ms: ${out.join(' | ')}`);
    check('the log keeps a SECURITY line naming the shell', lines.some((l) => /\[LightsOut\] Lights-out OFF by the server's shell/.test(l)), lines.join(' | '));
    out.length = 0;
    const onCode = await runLightsOut(['on', '--address', ADDRESS], io);
    check('`beanpool lights-out on --address …` → on, the address kept', onCode === 0 && isOn() && getLocalConfig().lightsOut?.address === ADDRESS, out.join(' | '));
    out.length = 0;
    const st = await runLightsOut(['status'], io);
    check('`status` says ON and the address', st === 0 && out.some((l) => l.startsWith('Lights-out is ON')) && out.some((l) => l.includes(ADDRESS)), out.join(' | '));
    out.length = 0;
    const bad = await runLightsOut(['on', '--address', 'https://evil.example.com'], io);
    check('a bad address → 1, nothing changed', bad === 1 && getLocalConfig().lightsOut?.address === ADDRESS, out.join(' | '));
    const usage = await runLightsOut(['sideways'], io);
    check('an unknown action → usage (2)', usage === 2);
    lo.stopLightsOutRequestWatch();
    (logger as any).security = realSecurity;
}

_setPlainConnectionHookForTests(null);
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
