/**
 * Lights-out H1: the owner's switch on the server (services/lights-out.ts, routes/lights-out.ts; design
 * scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §5 H1), through the real plain listener (http-server.ts), the real
 * gate (plain-http-gate.ts) and the real HTTPS app behind it, with its signature middleware. No BeanPool node, DNS or
 * tunnel is contacted. A test hook gives an accepted socket another remote address (a phone on the hall Wi-Fi, the
 * Internet, Docker's bridge gateway), as test-plain-http-gate.ts does.
 *
 *   0. no certificate of its own: /hall answers the hall Wi-Fi (closed while off), never the Internet or a tunnel;
 *   1. with one, the switch OFF: the hall Wi-Fi gets a 301 except Settings, the sign-in, the switch, /hall and the door's
 *      four reads; a Settings reload (the session, then its CSRF token) is answered; health says `{ on: false, home }`;
 *      /api/ledger/transfer stays 301; a proxy header, a public Host, a public source or a dot segment: 301; the socket
 *      the same;
 *   2. the switch: unsigned 401; a member, an admin, a stale owner signature, the owner's old-format (unbound) signature
 *      (426), an automation token, an assistant's token, a computer's session, an admin's session, the password with 2FA
 *      off, the password without a current code, a standby: refused, nothing changed. The owner signed for the
 *      community's NAME over plain http at the number: on (request binding unchanged); signed for the NUMBER on this named
 *      node: 421. The phone's Manage session and the password with a current code: on/off through Settings' route. "On"
 *      twice is "on";
 *   3. ON: the hall Wi-Fi is served (a page, a write, the socket); the Internet, a tunnel-shaped request and a proxy's are
 *      still redirected; loopback always; /hall shows the lines and the door link, and "Get the Android app" (H3) only with
 *      an APK held and HIDE_APK_LINK unset, in the reader's language, leading to the APK page; health + info carry
 *      `lightsOut`;
 *  3b. one direct-LAN rule (direct-lan.ts): /hall, the plain port's hall exemption and /android (H3) let in and refuse the
 *      same requests, the rows where H1's own copy and H3's differed among them (the Docker gateway, a `.lan` name, four
 *      proxy headers only H3 named); the rule is defined once in the server's code;
 *   4. §2.7: address changes refused while on (409), allowed again once off;
 *   5. the epoch: a server never restored is not raised; a restored copy is raised once (max(own, file) + 1, since now) and
 *      never again for that restore; one that took over after its restore is not; recordAsOf is the backup's made-at;
 *      the stand-down offer on OFF with no hall writes or only Settings' reads (what its Network and Backups tabs send as
 *      they open, from apps/manager/src/lib/hall-reads.json), none after a member wrote or an owner changed something in
 *      Settings; every write route the node serves counts but the ones NOT_HALL_WRITES names;
 *   6. the switch is in no copy: a sealed backup's node_config.json and its take-over bundle, a snapshot, the redacted
 *      config; the manifest says per-server; the stager leaves it out;
 *   7. `beanpool lights-out`: the node looks every 2 s or less (the one constant the boot uses), takes the request and answers
 *      with nothing else waiting (timed on a 250 ms look, so a loaded runner cannot fail it); the log keeps a SECURITY line; a request
 *      file 60 s old, with no time, or dated ahead is dropped and the switch is unchanged;
 *   8. the no-mothership pattern: a second node (the real index.ts, its own process and data folder) restores section 6's
 *      sealed file with `beanpool restore` and starts on it: its health and info read lightsOut off, its local-config.json
 *      holds none, and the boot keeps it as a restored copy.
 *
 * Run: BEANPOOL_SUITE_ENV_PASSWORD=1 BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-lights-out.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const dataDir = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || process.env.TMPDIR || os.tmpdir(), 'lights-out-'));
process.env.BEANPOOL_DATA_DIR = dataDir;
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'NODE_ROLE', 'PUBLIC_IP']) delete process.env[k];
const OWN = 'beans.example.org';
process.env.BEANPOOL_ADDRESSES = OWN;
const PASSWORD = 'Lights-Out-Suite-Pw-5521!';
process.env.ADMIN_PASSWORD ??= PASSWORD;
// The APK on the node (H3, services/apk-mirror.ts): the image's folder, empty until section 3 puts one there.
const apkImageDir = `${dataDir}-image-apk`;
process.env.APK_IMAGE_DIR = apkImageDir;
delete process.env.HIDE_APK_LINK;

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
const lan = await import('./direct-lan.js');
const gate = await import('./plain-http-gate.js');
const androidRoute = await import('./routes/android.js');
const { APK_SIGNING_CERT_SHA256 } = await import('./services/apk-release.js');
const { wordsIn } = await import('./member-words.js');
const { escapeHtml } = await import('./routes/community-card.js');

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
// This machine's default gateway, as the container sees it (direct-lan.ts reads /proc/net/route on Linux): the bridge, the
// same on every machine this suite runs on. Every earlier request from BRIDGE carries a proxy header as well.
lan._setDefaultGatewaysForTests([BRIDGE]);

/** An APK in the image's folder, as the build leaves it: what servedApk() reads is the manifest and the file's size. */
function holdApk(): void {
    fs.mkdirSync(apkImageDir, { recursive: true });
    const bytes = Buffer.from('a stand-in for the APK: servedApk() reads apk.json and checks the size');
    const fileName = 'BeanPool-1.2.97-319.apk';
    fs.writeFileSync(path.join(apkImageDir, fileName), bytes);
    fs.writeFileSync(path.join(apkImageDir, 'apk.json'), JSON.stringify({
        version: '1.2.97', versionCode: 319, fileName, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        certSha256: APK_SIGNING_CERT_SHA256, tag: 'android-v1.2.97',
    }));
}
/** A body as the member's browser reads it (the suite's raw reader keeps bytes as latin1). */
const utf8 = (a: Answer) => Buffer.from(a.body, 'latin1').toString('utf8');

// Members with keys this suite can sign with.
type Id = { pk: string; seed: Uint8Array; callsign: string };
function member(callsign: string, role?: 'owner' | 'admin'): Id {
    const seed = new Uint8Array(crypto.randomBytes(32));
    const pk = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pk, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
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
    // A reload of Settings in the hall (apps/manager key-session.ts startKeySession): the live session is asked for, then a
    // CSRF token for it. Without the second, the owner is back at the sign-in with a good cookie (review of #2822).
    const cookie = { Cookie: `admin_session=${harness.ownerSessionHeaders(owner.pk)['X-Admin-Session']}` };
    const session = await send(LAN, 'GET', '/api/local/admin/auth/session', HALL, cookie);
    check('a Settings reload in the hall: the session is read, signed in', session.status === 200 && session.json?.authenticated === true, `${session.status} ${session.body.slice(0, 120)}`);
    const csrf = await send(LAN, 'POST', '/api/local/admin/csrf-token', HALL, { ...cookie, 'Content-Length': '0' });
    check('… and POST /api/local/admin/csrf-token answers its token (not a 301 to the name)', csrf.status === 200 && typeof csrf.json?.csrfToken === 'string' && csrf.json.csrfToken.length > 0,
        `${csrf.status} ${csrf.headers.location ?? ''} ${csrf.body.slice(0, 80)}`);
    const hall = await send(LAN, 'GET', '/hall', HALL);
    check('/hall is reached and says the hall is closed', hall.status === 200 && hall.body.includes('data-hall="closed"'), String(hall.status));
    const offHealth = (await send(LAN, 'GET', '/api/community/health', HALL)).json?.lightsOut;
    check('health while off: exactly { on: false, home } (the phone reads `on` and `home`)', JSON.stringify(offHealth) === JSON.stringify({ on: false, home: `https://${OWN}` }), JSON.stringify(offHealth));
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
    // The old format (1) names no community: one an owner sent to another community could be replayed here (design §2.3).
    // Refused as break-glass refuses it (AUTH-01), the middleware having accepted it until UNBOUND_SIGNATURES_UNTIL.
    {
        const body = JSON.stringify({ on: true });
        const ts = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const text = core.unboundRequestText({ method: 'POST', path: '/api/node/owner/lights-out', timestamp: ts, nonce, body });
        const sig = Buffer.from(ed25519.sign(new TextEncoder().encode(text), owner.seed)).toString('base64');
        const old = await send(LAN, 'POST', '/api/node/owner/lights-out', HALL, { 'X-Public-Key': owner.pk, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig }, body);
        check('the owner\'s old-format (unbound, format 1) request → 426 app_too_old, nothing changed', old.status === 426 && old.json?.code === 'app_too_old' && !isOn(),
            `${old.status} ${old.body.slice(0, 120)}`);
    }
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
    check('no APK on the node: no "Get the Android app" link on the poster', !hall.body.includes('data-hall="android"') && !hall.body.includes('href="/android"'));
    check('/hall is never cached', /no-store/.test(hall.headers['cache-control'] ?? ''));
    const hallPub = await send(PUBLIC, 'GET', '/hall', HALL);
    check('/hall from the Internet → never the page', !hallPub.body.includes('data-hall'), String(hallPub.status));
    const hallTunnel = await send('127.0.0.1', 'GET', '/hall', OWN, { 'CF-Connecting-IP': PUBLIC });
    check('/hall through the tunnel → never the page', !hallTunnel.body.includes('data-hall'), String(hallTunnel.status));

    // The APK on the node (H3): the poster links to /android where the trust page would (routes/android.ts showsApkLink),
    // in the reader's language.
    holdApk();
    check('an APK is held now', androidRoute.showsApkLink({ req: { socket: { remoteAddress: LAN }, headers: { host: HALL } } }));
    const frHall = await send(LAN, 'GET', '/hall', HALL, { 'Accept-Language': 'fr' });
    const getAppFr = wordsIn('fr').t(core.ANDROID_ON_NODE_WORDS.getApp);
    check('with an APK: the poster links to /android, in French for a French reader', frHall.status === 200 && frHall.body.includes('data-hall="android"')
        && frHall.body.includes('href="/android"') && getAppFr !== 'Get the Android app' && utf8(frHall).includes(`>${escapeHtml(getAppFr)}</a>`)
        && frHall.body.includes('lang="fr"'), `${frHall.status} ${getAppFr}`);
    const enHall = await send(LAN, 'GET', '/hall', HALL);
    check('… and in English with no language asked', enHall.body.includes('data-hall="android"') && enHall.body.includes('>Get the Android app</a>'));
    check('… below the door link, never in its place', enHall.body.indexOf('data-hall="door"') >= 0 && enHall.body.indexOf('data-hall="door"') < enHall.body.indexOf('data-hall="android"'));
    process.env.HIDE_APK_LINK = 'true';
    const hidden = await send(LAN, 'GET', '/hall', HALL);
    delete process.env.HIDE_APK_LINK;
    check('HIDE_APK_LINK=true: no link on the poster (the page itself stays)', hidden.status === 200 && hidden.body.includes('data-hall="lines"') && !hidden.body.includes('data-hall="android"'));
    const followed = await send(LAN, 'GET', '/android', HALL);
    check('the link leads to the APK page from the hall Wi-Fi (through the gate, the switch on)', followed.status === 200
        && followed.body.includes('data-testid="android-on-node"') && followed.body.includes('data-apk="download"'), String(followed.status));

    const health = await send(LAN, 'GET', '/api/community/health', HALL);
    const hl = health.json?.lightsOut;
    check('health: lightsOut is exactly { on, since, address, recordAsOf, home }', health.status === 200 && hl?.on === true && typeof hl.since === 'string'
        && hl.address === ADDRESS && hl.recordAsOf === null && hl.home === `https://${OWN}` && Object.keys(hl).sort().join() === 'address,home,on,recordAsOf,since', JSON.stringify(hl));
    const info = await send(LAN, 'GET', '/api/community/info', HALL);
    check('info: the same lightsOut', info.status === 200 && JSON.stringify(info.json?.lightsOut) === JSON.stringify(hl), JSON.stringify(info.json?.lightsOut));
}

// ── 3b. One direct-LAN rule ─────────────────────────────────────────────────────────────────────────────────────
// The hall (GET /hall and the plain port's exemption, H1) and the APK (/android, H3) let in exactly the same requests:
// direct-lan.ts is the one rule. Each row goes end to end through the real listener (the poster, a page of the app through
// the exemption, the web app's /android/link), and to routes/android.ts's own decision and the gate's own (hallMayReach)
// directly, since on the plain port the gate answers a refused request before the APK route sees it.
console.log('\n3b. One direct-LAN rule: /hall, the hall exemption and /android answer the same requests');
{
    check('the switch is still on (the exemption covers every path)', lo.lightsOutOn());
    type Row = [name: string, from: string, host: string, headers: Record<string, string>, room: boolean];
    const rows: Row[] = [
        ['a phone on the hall Wi-Fi, at the number', LAN, HALL, {}, true],
        ['the same phone as an IPv4-mapped IPv6 source', `::ffff:${LAN}`, HALL, {}, true],
        ['an IPv6 unique-local phone naming a .local name', 'fd00::12', 'beanpool.local:8080', {}, true],
        // Where H1's own copy and H3's differed: H1 let these in, H3 did not. Both refuse them now (the stricter).
        ['Docker\'s default gateway, no header, naming the number (its port proxy hands the internet on from there)', BRIDGE, HALL, {}, false],
        ['the same gateway, IPv4-mapped', `::ffff:${BRIDGE}`, HALL, {}, false],
        ['a router\'s .lan name', LAN, 'laptop.lan:8080', {}, false],
        ['X-Client-IP', LAN, HALL, { 'X-Client-IP': PUBLIC }, false],
        ['X-Forwarded-Server', LAN, HALL, { 'X-Forwarded-Server': 'proxy.example.net' }, false],
        ['X-Original-Forwarded-For', LAN, HALL, { 'X-Original-Forwarded-For': PUBLIC }, false],
        ['CF-Connecting-IPv6', LAN, HALL, { 'CF-Connecting-IPv6': '2001:db8::7' }, false],
        // Refused by both before, and still.
        ['an empty X-Forwarded-For', LAN, HALL, { 'X-Forwarded-For': '' }, false],
        ['a tunnel from a compose sidecar: Cloudflare\'s headers, the public name', '172.18.0.7', OWN, { 'CF-Connecting-IP': PUBLIC, 'Cf-Ray': '8f00-SYD' }, false],
        ['a private source naming the public name', LAN, OWN, {}, false],
        ['a private source naming a public IP', LAN, '203.0.113.50', {}, false],
        ['a public source naming the number', PUBLIC, HALL, {}, false],
    ];
    for (const [name, from, host, headers, room] of rows) {
        const hallA = await send(from, 'GET', '/hall', host, headers);
        const gateA = await send(from, 'GET', '/api/version', host, headers);
        const apkA = await send(from, 'GET', '/android/link', host, headers);
        const nodeHeaders: Record<string, string> = Object.fromEntries([['host', host], ...Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])]);
        const got = {
            hall: hallA.status === 200 && hallA.body.includes('data-hall='),
            exemption: gateA.status === 200,
            apk: apkA.status === 200 && apkA.json?.href === '/android',
            apkRoute: androidRoute.showsApkLink({ req: { socket: { remoteAddress: from }, headers: nodeHeaders } }),
            gate: gate.hallMayReach({ remoteAddress: from, host, headers: nodeHeaders, path: '/api/version' }),
        };
        check(`${name}: ${room ? 'the room' : 'not the room'} for /hall, the exemption and /android alike`,
            Object.values(got).every((v) => v === room), `${JSON.stringify(got)} (${hallA.status}/${gateA.status}/${apkA.status})`);
    }
    // No second copy can come back unseen: the rule is defined once in the server's code (two were, after #2824).
    const SRC = path.dirname(fileURLToPath(import.meta.url));
    const defining: string[] = [];
    const walk = (dir: string) => {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            const f = path.join(dir, d.name);
            if (d.isDirectory()) { if (d.name !== 'node_modules') walk(f); continue; }
            if (!/\.ts$/.test(d.name) || /^test-|\.test\.ts$/.test(d.name)) continue;
            if (/\bfunction\s+(isDirectLanRequest|isDirectLanContext)\b|\b(isDirectLanRequest|isDirectLanContext)\s*=/.test(fs.readFileSync(f, 'utf8'))) defining.push(path.relative(SRC, f));
        }
    };
    walk(SRC);
    check('the direct-LAN rule is defined in one file: direct-lan.ts', defining.length === 1 && defining[0] === 'direct-lan.ts', defining.join(', '));
    // The switch takes only a hall address the rule lets phones in at: the number or a .local name, never a .lan one.
    check('the switch takes the number and a .local name as the hall address', lo.hallAddressOf('192.168.8.1:8080') === 'http://192.168.8.1:8080'
        && lo.hallAddressOf('http://laptop.local:8080') === 'http://laptop.local:8080');
    check('… but not a router\'s .lan name (the rule refuses that Host)', lo.hallAddressOf('http://laptop.lan:8080') === null);
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

    // A restore leaves its notice (routes/backup.ts restoreFromTar), delivered at the next boot (services/restore-points.ts):
    // made 1 Nov, its keys at epoch 3. The boot's delivery keeps it (index.ts: remember = noteRestoredCopy).
    const rp = await import('./services/restore-points.js');
    rp.leaveRestoreNotice({ kind: 'restore', at: new Date().toISOString(), madeAt: '2026-11-01T10:00:00.000Z', point: 'p', by: 'shell', epoch: 3 });
    const delivered = rp.deliverRestoreNotices({ announce: () => {}, log: () => {}, remember: lo.noteRestoredCopy });
    check('the restore notice is delivered and kept for lights-out', delivered === 1 && getLocalConfig().restoredCopy?.epoch === 3 && getLocalConfig().restoredCopy?.madeAt === '2026-11-01T10:00:00.000Z', JSON.stringify(getLocalConfig().restoredCopy));
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
    check('health says the record as of', health.json?.lightsOut?.recordAsOf === '2026-11-01T10:00:00.000Z', JSON.stringify(health.json?.lightsOut));
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

    // Settings in the hall (review of #2822): opening it (its reads sent as POST, a CSRF token) changes nothing, so the
    // offer stands; an owner's change in it (an announcement here; a dispute resolved, a re-key, the treasury alike) is a
    // hall write as much as a member's, so standing down would lose it and OFF offers none.
    const settings = harness.ownerSessionHeaders(owner.pk);
    const fresh = await onPhone();
    check('a new hall starts with no writes', fresh.status === 200 && fresh.json?.lightsOut?.hallWrites === false, JSON.stringify(fresh.json?.lightsOut));
    const reads: Array<[string, string]> = [['/api/local/admin/csrf-token', ''], ['/api/local/admin/data', '{}'], ['/api/local/admin/alerts-summary', '{"alerts":"summary"}'],
        ['/api/local/admin/backup-status', '{}'], ['/api/local/admin/logs', '{}']];
    const readStatus: string[] = [];
    for (const [p, b] of reads) readStatus.push(`${p} ${(await send(LAN, 'POST', p, HALL, settings, b)).status}`);
    check('opening Settings in the hall: its POST reads answer 200', readStatus.every((s) => s.endsWith(' 200')), readStatus.join(', '));
    off = await offPhone();
    check('off after only Settings\' reads → still the stand-down offer', off.json?.lightsOut?.hallWrites === false && off.json?.lightsOut?.standDown?.offered === true, JSON.stringify(off.json?.lightsOut));
    // What the tabs really send as they open (review of fix round 1, #2822): the Network tab (where the switch is) and
    // the Backups tab, recorded from Settings' own components by apps/manager's hall-reads.test.tsx into hall-reads.json.
    // Each tab opened alone in a fresh hall, then OFF: still the offer. The schedule is read from snapshots/list
    // (snapshots/config also saves, so it counts).
    const hallReads = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'manager', 'src', 'lib', 'hall-reads.json'), 'utf8')) as { tabs: Record<string, string[]> };
    const tabs = Object.entries(hallReads.tabs);
    check(`hall-reads.json names the tabs (${tabs.map(([t]) => t).join(', ')}), the Network tab's schedule read among them`,
        tabs.length >= 3 && (hallReads.tabs.network ?? []).includes('POST /api/local/admin/snapshots/list')
        && !tabs.some(([, sent]) => sent.some((r) => r.includes('/snapshots/config'))), JSON.stringify(hallReads.tabs.network));
    for (const [tab, sent] of tabs) {
        await onPhone();
        const answered: string[] = [];
        for (const r of sent) {
            const [method, p] = [r.slice(0, r.indexOf(' ')), r.slice(r.indexOf(' ') + 1)];
            answered.push(`${p} ${(await send(LAN, method, p, HALL, settings, '{}')).status}`);
        }
        check(`opening the ${tab} tab in the hall: the ${sent.length} POSTs it sends answer 200`, sent.length > 0 && answered.every((s) => s.endsWith(' 200')), answered.join(', '));
        off = await offPhone();
        check(`… off after opening it → still the stand-down offer`, off.json?.lightsOut?.hallWrites === false && off.json?.lightsOut?.standDown?.offered === true, JSON.stringify(off.json?.lightsOut));
    }
    await onPhone();
    const schedRead = await send(LAN, 'POST', '/api/local/admin/snapshots/config', HALL, settings, '{}');
    off = await offPhone();
    check('snapshots/config (it reads and saves on one route) still counts, read or not: no offer after it', schedRead.status === 200
        && off.json?.lightsOut?.hallWrites === true && off.json?.lightsOut?.standDown === null, `${schedRead.status} ${JSON.stringify(off.json?.lightsOut)}`);
    await onPhone();
    const annBody = JSON.stringify({ title: 'Hall', body: 'We are in the hall tonight.' });
    const announced = await send(LAN, 'POST', '/api/local/admin/announcements', HALL, settings, annBody);
    check('an owner\'s change in Settings over the hall Wi-Fi (an announcement) → 200', announced.status === 200, `${announced.status} ${announced.body.slice(0, 100)}`);
    off = await offPhone();
    check('off after an owner\'s change in Settings → hallWrites, no stand-down', off.json?.lightsOut?.hallWrites === true && off.json?.lightsOut?.standDown === null, JSON.stringify(off.json?.lightsOut));

    // How the list is kept complete: every write route the node serves counts unless NOT_HALL_WRITES names it, and each
    // name there is a route the node serves.
    const app = (await import('./https-server.js')).getKoaApp() as any;
    const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const writes = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
        .flatMap((l: any) => (l.methods as string[]).filter((m) => MUTATING.has(m)).map((m) => `${m} ${l.path}`)))].sort();
    const notCounted = writes.filter((r) => !lo.countsAsHallWrite(r.slice(0, r.indexOf(' ')), r.slice(r.indexOf(' ') + 1)));
    const named = [...lo.NOT_HALL_WRITES].sort();
    const settingsWrites = writes.filter((r) => / \/api\/(local|manager)\//.test(r) && !named.includes(r));
    check(`the node serves ${writes.length} write routes; every one counts as a hall write but the ${named.length} NOT_HALL_WRITES names`,
        writes.length > 200 && notCounted.join() === named.join(), `not counted: ${notCounted.filter((r) => !named.includes(r)).join(', ')}; named but not served: ${named.filter((r) => !writes.includes(r)).join(', ')}`);
    check(`… ${settingsWrites.length} of them Settings' own (/api/local/, /api/manager/), the ones the review named among them`,
        settingsWrites.length > 100 && ['POST /api/local/admin/disputes/:id/resolve', 'POST /api/local/admin/members/:pubkey/rekey/complete',
            'POST /api/local/admin/treasury', 'POST /api/local/admin/members/:pubkey/offboard', 'POST /api/local/admin/community-health'].every((r) => settingsWrites.includes(r)),
        settingsWrites.slice(0, 5).join(', '));
    check('a write no route answered counts (never assumed harmless); a read never does', lo.countsAsHallWrite('POST', undefined) && lo.countsAsHallWrite('delete', '')
        && !lo.countsAsHallWrite('GET', '/api/local/admin/disputes/:id/resolve'));

    // A server that took over AFTER its restore: its take-over raised it; the switch doesn't again.
    updateLocalConfig({ lightsOut: null, restoredCopy: { at: '2026-11-02T00:00:00.000Z', madeAt: '2026-11-01T23:00:00.000Z', epoch: 5 },
        identityEpoch: 6, identityEpochSince: '2026-11-03T00:00:00.000Z', lastPromotionAudit: { at: '2026-11-03T00:10:00.000Z', ok: true, sumBalances: 0, drift: 0, strandedEscrows: 0, copy: { match: true, here: { accounts: 0, holdings: 0 }, lastCopy: { accounts: 0, holdings: 0, generatedAt: '2026-11-02T23:59:00.000Z' } } } });
    const tookOver = await onPhone();
    check('took over after the restore + on → not raised (6)', tookOver.json?.epochRaised === false && getLocalConfig().identityEpoch === 6, String(getLocalConfig().identityEpoch));
    check('… recordAsOf = the last good copy before the take-over', tookOver.json?.lightsOut?.recordAsOf === '2026-11-02T23:59:00.000Z', String(tookOver.json?.lightsOut?.recordAsOf));
}

// ── 6. In no copy ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n6. The switch travels in no copy');
/** Section 6's sealed file, made while the switch was on, and what section 8 restores on a second node. */
const copyMadeOn = { file: '', code: '', epoch: 0, madeAt: '' };
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
    Object.assign(copyMadeOn, { file: sealedFile, code: code.code, epoch: Number(bundle?.identityEpoch) || 0, madeAt: String(header.createdAt) });
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
    // The node's real cadence is one constant (services/lights-out.ts LIGHTS_OUT_WATCH_MS = 2 s) and the boot (index.ts) calls
    // the watch without overriding it; that is checked exactly, below. The timed run below uses a short look instead, because
    // this process starts the watch and writes the request in the same turn of the loop: the request always waits one whole
    // look, the worst case, so at 2 s the run is ~2.04 s on an idle Mac (the same with a heavy suite beside it), only 0.56 s
    // under the old 2.6 s bound; a shared CI runner went over it twice (2,778 ms on main 18c5a8bf, 9 Nov; 8 Nov before).
    // With a short look the bound below leaves a loaded runner seconds, and still goes red for a fixed wait added to the path.
    const WATCH_MS = 250;
    // Expected: one look (<= 250 ms) + the command's 200 ms poll + ~30 ms of the node's work = ~0.41 s measured on an idle Mac.
    // The bound is 2 s: 1.6 s over for a late timer or a slow disk (CI's red was 0.74 s over an idle Mac), while a 2 s wait
    // added anywhere in the path (the command's poll at 2 s, say: 2,013 ms) goes red.
    const TAKEN_WITHIN_MS = 2000;
    lo.startLightsOutRequestWatch(dataDir, WATCH_MS);
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    const bootSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
    check('the node looks for a lights-out request every 2 s or less, and the boot does not override it',
        lo.LIGHTS_OUT_WATCH_MS > 0 && lo.LIGHTS_OUT_WATCH_MS <= 2000 && /\bstartLightsOutRequestWatch\(\);/.test(bootSrc),
        `${lo.LIGHTS_OUT_WATCH_MS} ms`);
    const t0 = Date.now();
    const offCode = await runLightsOut(['off'], io);
    const took = Date.now() - t0;
    check(`\`beanpool lights-out off\` → 0, off, and nothing else waits: within ${TAKEN_WITHIN_MS} ms (a ${WATCH_MS} ms look, the command's 200 ms poll)`,
        offCode === 0 && took <= TAKEN_WITHIN_MS && !isOn(), `${offCode} in ${took} ms: ${out.join(' | ')}`);
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

    // An abandoned `beanpool lights-out on` (review of #2822): the command was stopped before the node took its file, and
    // the node starts later. Older than the command's own pickup and answer windows, or with no time on it: dropped, and
    // the switch is as it was ("Never automatic", §2.1).
    out.length = 0;
    check('(off first)', await runLightsOut(['off'], io) === 0 && !isOn(), out.join(' | '));
    const reqFile = path.join(dataDir, lo.LIGHTS_OUT_REQUEST_FILE);
    const leave = (at: number | undefined) => fs.writeFileSync(reqFile, JSON.stringify({ v: 1, id: crypto.randomBytes(12).toString('hex'), action: 'on', address: ADDRESS,
        ...(at === undefined ? {} : { at }) }), { mode: 0o600 });
    const taken = async () => { const end = Date.now() + 5000; while (fs.existsSync(reqFile) && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return !fs.existsSync(reqFile); };
    const offBefore = JSON.stringify(getLocalConfig().lightsOut);
    leave(Date.now() - 60_000);
    check('a request file 60 s old → removed, the switch unchanged (off)', await taken() && !isOn() && JSON.stringify(getLocalConfig().lightsOut) === offBefore, JSON.stringify(getLocalConfig().lightsOut));
    leave(undefined);
    check('a request file with no time on it → removed, the switch unchanged', await taken() && !isOn() && JSON.stringify(getLocalConfig().lightsOut) === offBefore);
    leave(Date.now() + 60_000);
    check('one dated a minute ahead → removed, the switch unchanged', await taken() && !isOn() && JSON.stringify(getLocalConfig().lightsOut) === offBefore);
    leave(Date.now());
    const end = Date.now() + 5000;
    while (!isOn() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    check('… and one made just now is taken: on (the watch is live, so the three above prove something)', await taken() && isOn() && getLocalConfig().lightsOut?.address === ADDRESS);
    lo.stopLightsOutRequestWatch();
    (logger as any).security = realSecurity;
}

// ── 8. A second node restores the file ──────────────────────────────────────────────────────────────────────────
// The no-mothership pattern (test-no-mothership.ts, test-beanpool-restore.ts step 9): the REAL entry point (index.ts), its
// own process and data folder, nothing of ours reachable. It starts once (its own genesis), stops, takes section 6's sealed
// file with `beanpool restore` as an owner does on a laptop with no internet, and starts again on the restored data. What
// reaches its local-config.json from a file is the take-over bundle's field list (takeover-envelope.ts); with 'lightsOut'
// added to that list this section goes red (the second node reads ON, with the first node's hall address).
console.log('\n8. A second node restores the file made while the switch was on: the switch is off there');
{
    const SRC = path.dirname(fileURLToPath(import.meta.url));
    const second = fs.mkdtempSync(path.join(path.dirname(dataDir), 'lights-out-second-'));
    const secondConfig = () => JSON.parse(fs.readFileSync(path.join(second, 'local-config.json'), 'utf8'));
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BEANPOOL_ADDRESSES|NODE_ROLE|ADMIN_PASSWORD|CF_|PUBLIC_ADDRESS_|PUBLIC_IP)/.test(k))),
        BEANPOOL_DATA_DIR: second, PORT_HTTP: '0', PORT_HTTPS: '0', PORT_P2P: '0', PORT_P2P_WS: '0',
        DISABLE_UPDATE_CHECK: 'true', DIRECTORY_REGISTRY_URL: 'http://127.0.0.1:9/',
    } as NodeJS.ProcessEnv;
    const started: import('node:child_process').ChildProcess[] = [];
    const startSecond = async () => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.join(SRC, 'index.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        started.push(child);
        let out = '';
        child.stdout!.on('data', (d) => { out += d; });
        child.stderr!.on('data', (d) => { out += d; });
        const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
        const t0 = Date.now();
        while (!out.includes('BeanPool Node is live') && child.exitCode === null && child.signalCode === null && Date.now() - t0 < 150_000) {
            await new Promise((r) => setTimeout(r, 100));
        }
        const port = Number(/listening on https:\/\/0\.0\.0\.0:(\d+)/.exec(out)?.[1] ?? 0);
        return { child, exited, port, live: out.includes('BeanPool Node is live') && !!port, tail: () => out.trim().split('\n').slice(-3).join(' | ').slice(0, 300) };
    };
    const stopSecond = async (n: { child: import('node:child_process').ChildProcess; exited: Promise<void> }) => {
        n.child.kill('SIGTERM');
        await Promise.race([n.exited, new Promise((r) => setTimeout(r, 30_000))]);
        if (n.child.exitCode === null && n.child.signalCode === null) { n.child.kill('SIGKILL'); await n.exited; }
    };
    /** A GET on the second node's own HTTPS port (its self-signed certificate), as the phone's health ping reads it. */
    const getJson = (port: number, p: string) => new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = https.get({ host: '127.0.0.1', port, path: p, rejectUnauthorized: false, timeout: 15_000 }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => { let json: any = null; try { json = JSON.parse(body); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, json }); });
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
    });
    try {
        check('section 6 left a sealed file made while the switch was on', !!copyMadeOn.file && fs.existsSync(copyMadeOn.file) && !!copyMadeOn.code);
        const first = await startSecond();
        check('the second node starts on its own, a community of its own', first.live, first.tail());
        await stopSecond(first);

        const codeFile = path.join(second, '..', `lights-out-code-${process.pid}`);
        fs.writeFileSync(codeFile, copyMadeOn.code, { mode: 0o600 });
        const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(SRC, 'recover-cli.ts'), 'restore', '--code-file', codeFile, copyMadeOn.file], {
            env, encoding: 'utf8', timeout: 120_000, input: 'yes\n',
        });
        fs.rmSync(codeFile, { force: true });
        const said = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-2).join(' | ').slice(0, 300);
        check('`beanpool restore` on the second node, the node stopped: restored (exit 0)', r.status === 0, `exit ${r.status}: ${said}`);
        const afterRestore = secondConfig();
        check('its local-config.json after the restore: no lightsOut', !('lightsOut' in afterRestore) || afterRestore.lightsOut == null, JSON.stringify(afterRestore.lightsOut));

        const again = await startSecond();
        check('it starts again on the restored data', again.live, again.tail());
        const health = again.live ? await getJson(again.port, '/api/community/health') : { status: 0, json: null };
        const hl = health.json?.lightsOut;
        // Off is `{ on: false, home }` and nothing else (services/lights-out.ts publicLightsOut): no since, no hall address, no
        // record date, so the first node's hall can't show through.
        check('its health reads lightsOut off: exactly { on: false, home }', health.status === 200 && hl?.on === false
            && Object.keys(hl).sort().join() === 'home,on' && !JSON.stringify(health.json).includes(ADDRESS), `${health.status} ${JSON.stringify(hl)}`);
        const info = again.live ? await getJson(again.port, '/api/community/info') : { status: 0, json: null };
        check('its info reads the same', info.status === 200 && JSON.stringify(info.json?.lightsOut) === JSON.stringify(hl) && !JSON.stringify(info.json).includes(ADDRESS),
            JSON.stringify(info.json?.lightsOut));
        const booted = secondConfig();
        check('its local-config.json after the boot: still no lightsOut, and the hall address of the first node nowhere',
            (!('lightsOut' in booted) || booted.lightsOut == null) && !JSON.stringify(booted).includes(ADDRESS), JSON.stringify(booted.lightsOut));
        check('the boot kept it as a restored copy: the file\'s made-at and take-over count (what a later switch raises past)',
            booted.restoredCopy?.madeAt === copyMadeOn.madeAt && booted.restoredCopy?.epoch === copyMadeOn.epoch,
            `${JSON.stringify(booted.restoredCopy)} vs ${copyMadeOn.madeAt}/${copyMadeOn.epoch}`);
        await stopSecond(again);
    } finally {
        for (const ch of started) if (ch.exitCode === null && ch.signalCode === null) ch.kill('SIGKILL');
        fs.rmSync(second, { recursive: true, force: true });
    }
}

_setPlainConnectionHookForTests(null);
fs.rmSync(apkImageDir, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
