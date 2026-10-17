/**
 * The node's own certificates over ACME http-01 (services/acme/, design scratch/global-node/DESIGN-https-anywhere-fable.md
 * §7 S1), against an in-process fake ACME CA: directory, newNonce, newAccount, newOrder, authz, challenge, finalize,
 * certificate, signing with a test CA, and "validating" by fetching the node's own plain listener (port 0). No real CA,
 * DNS or BeanPool node is contacted.
 *
 *   1. a name identifier yields a certificate served for that name via SNI;
 *   2. an IP identifier's order carries `type: 'ip'` and `profile: 'shortlived'`, its CSR an IP SAN, and its certificate
 *      is served to a client that sends no SNI;
 *   3. renewal happens only when less than a third of the life is left (clock injected); the old certificate serves
 *      until the new one is on disk;
 *   4. a failed order keeps the old certificate and schedules a retry (1 h, 4 h, then daily; never past a third of what
 *      is left);
 *   5. a self-check failure (port 80 not reachable, or answered by someone else) sends nothing to the CA;
 *   6. an unknown token is 404 with an empty body, and the route wins over the CF_RECORD_NAME redirect and the tunnel's
 *      delegation;
 *   7. keys are 0600 when written and after the boot sweep; a restart serves them from disk and asks the CA nothing;
 *   8. `.beanpool.org` names and private hosts are never ordered;
 *   9. a standby orders nothing;
 *  10. a certificate from another ACME directory than the one configured (staging, then production) is ordered again at
 *      once; a state that records no directory is left alone.
 * Plus: docker-compose.yml passes ACME_DIRECTORY_URL through.
 *
 * Run: BEANPOOL_SUITE_ENV_PASSWORD=1 BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-acme-http01.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || process.env.TMPDIR || os.tmpdir(), 'acme-http01-'));
process.env.BEANPOOL_DATA_DIR = dataDir;
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'BEANPOOL_ADDRESSES', 'NODE_ROLE', 'PUBLIC_IP']) delete process.env[k];
process.env.ADMIN_PASSWORD ??= 'Acme-Http01-Suite-Pw-7731!';

const require = createRequire(import.meta.url);
const forge = require(require.resolve('node-forge', { paths: [path.dirname(require.resolve('selfsigned'))] }));

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
    if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** Let's Encrypt's lifetimes as of build day: 90 days on the classic profile, ~160 hours on `shortlived` (IP addresses). */
const NAME_LIFETIME_MS = 90 * DAY;
const IP_LIFETIME_MS = 160 * HOUR;

// ── The fake ACME CA ───────────────────────────────────────────────────────────────────────────────────────────

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');
function rsaPem(): string {
    return crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey;
}

const caKeyPem = rsaPem();
const caKey = forge.pki.privateKeyFromPem(caKeyPem);
const caCert = forge.pki.createCertificate();
caCert.publicKey = forge.pki.setRsaPublicKey(caKey.n, caKey.e);
caCert.serialNumber = '7f01';
caCert.validity.notBefore = new Date(Date.now() - DAY);
caCert.validity.notAfter = new Date(Date.now() + 365 * DAY);
caCert.setSubject([{ name: 'commonName', value: 'Fake ACME Test CA' }]);
caCert.setIssuer([{ name: 'commonName', value: 'Fake ACME Test CA' }]);
caCert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }]);
caCert.sign(caKey, forge.md.sha256.create());
const caPem: string = forge.pki.certificateToPem(caCert);

interface Order { id: number; identifiers: { type: string; value: string }[]; body: any; status: string; token: string; challengeStatus: string; certPem?: string; csrSans?: { type: string; value: string }[] }
const fake = {
    port: 0,
    nodeHttpPort: 0,
    requests: [] as { method: string; path: string }[],
    orders: [] as Order[],
    nonces: new Set<string>(),
    jwk: null as any,
    /** The finalize refuses (a 4xx, which acme-client does not retry). */
    failFinalize: false,
    /** Holds the certificate download until released. */
    hold: null as null | { reached: () => void; release: Promise<void> },
};
const base = () => `http://127.0.0.1:${fake.port}`;

function thumbprint(jwk: any): string {
    const sorted = Object.keys(jwk).sort().reduce((o: any, k) => { o[k] = jwk[k]; return o; }, {});
    return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('base64url');
}

function issue(order: Order, csrPem: string): string {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    if (!csr.verify()) throw new Error('CSR signature');
    const ext = csr.getAttribute({ name: 'extensionRequest' });
    const sans = (ext?.extensions?.find((e: any) => e.name === 'subjectAltName')?.altNames ?? [])
        .map((a: any) => (a.type === 7 ? { type: 'ip', value: a.ip } : { type: 'dns', value: a.value }));
    order.csrSans = sans;
    const want = order.identifiers.map((i) => `${i.type}:${i.value}`).sort().join(',');
    if (sans.map((s: any) => `${s.type}:${s.value}`).sort().join(',') !== want) throw new Error(`CSR names ${JSON.stringify(sans)}, order ${want}`);
    const ip = order.identifiers[0].type === 'ip';
    const leaf = forge.pki.createCertificate();
    leaf.publicKey = csr.publicKey;
    leaf.serialNumber = '7' + crypto.randomBytes(8).toString('hex');
    const start = Date.now() - 60_000;
    leaf.validity.notBefore = new Date(start);
    leaf.validity.notAfter = new Date(start + (ip ? IP_LIFETIME_MS : NAME_LIFETIME_MS));
    leaf.setSubject(ip ? [] : [{ name: 'commonName', value: order.identifiers[0].value }]);
    leaf.setIssuer(caCert.subject.attributes);
    leaf.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: order.identifiers.map((i) => (i.type === 'ip' ? { type: 7, ip: i.value } : { type: 2, value: i.value })) },
    ]);
    leaf.sign(caKey, forge.md.sha256.create());
    return forge.pki.certificateToPem(leaf) + caPem;
}

const orderJson = (o: Order) => ({
    status: o.status, expires: new Date(Date.now() + DAY).toISOString(), identifiers: o.identifiers,
    authorizations: [`${base()}/authz/${o.id}`], finalize: `${base()}/finalize/${o.id}`,
    ...(o.certPem ? { certificate: `${base()}/cert/${o.id}` } : {}),
});
const challengeJson = (o: Order) => ({ type: 'http-01', url: `${base()}/chall/${o.id}`, token: o.token, status: o.challengeStatus });

async function fakeHandle(req: http.IncomingMessage, body: string): Promise<{ status: number; headers?: Record<string, string>; body?: unknown }> {
    const url = new URL(req.url ?? '/', base());
    const p = url.pathname;
    if (p === '/directory') {
        return { status: 200, body: { newNonce: `${base()}/nonce`, newAccount: `${base()}/account`, newOrder: `${base()}/new-order`,
            revokeCert: `${base()}/revoke`, keyChange: `${base()}/key-change`,
            meta: { termsOfService: `${base()}/terms`, profiles: { classic: 'the old one', shortlived: '160 hours, IP addresses' } } } };
    }
    if (p === '/nonce') return { status: req.method === 'HEAD' ? 200 : 204 };
    if (req.method !== 'POST') return { status: 405 };

    // A JWS: its nonce must be one this CA gave out, its signature the account key's.
    const jws = JSON.parse(body);
    const header = JSON.parse(fromB64u(jws.protected).toString());
    if (!fake.nonces.delete(header.nonce)) return { status: 400, body: { type: 'urn:ietf:params:acme:error:badNonce', detail: 'unknown nonce' } };
    if (header.url !== `${base()}${p}`) return { status: 400, body: { type: 'urn:ietf:params:acme:error:malformed', detail: 'url' } };
    const jwk = header.jwk ?? fake.jwk;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${jws.protected}.${jws.payload}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), fromB64u(jws.signature));
    if (!ok) return { status: 400, body: { type: 'urn:ietf:params:acme:error:malformed', detail: 'signature' } };
    const payload = jws.payload ? JSON.parse(fromB64u(jws.payload).toString()) : null;

    if (p === '/account') {
        fake.jwk = header.jwk;
        return { status: 201, headers: { Location: `${base()}/acct/1` }, body: { status: 'valid' } };
    }
    if (p === '/acct/1') return { status: 200, body: { status: 'valid' } };
    if (p === '/new-order') {
        const o: Order = { id: fake.orders.length + 1, identifiers: payload.identifiers, body: payload, status: 'pending',
            token: crypto.randomBytes(32).toString('base64url'), challengeStatus: 'pending' };
        fake.orders.push(o);
        return { status: 201, headers: { Location: `${base()}/order/${o.id}` }, body: orderJson(o) };
    }
    const m = /^\/(authz|chall|order|finalize|cert)\/(\d+)$/.exec(p);
    const o = m && fake.orders[Number(m[2]) - 1];
    if (!m || !o) return { status: 404, body: { type: 'urn:ietf:params:acme:error:malformed', detail: 'no such resource' } };
    switch (m[1]) {
        case 'authz':
            return { status: 200, body: { identifier: o.identifiers[0], status: o.challengeStatus === 'valid' ? 'valid' : 'pending',
                expires: new Date(Date.now() + DAY).toISOString(), challenges: [challengeJson(o), { type: 'dns-01', url: `${base()}/chall-dns/${o.id}`, token: o.token, status: 'pending' }] } };
        case 'chall':
            if (payload && o.challengeStatus === 'pending') {
                // "Validation": fetch the node's own plain listener, as the CA's vantage points fetch port 80.
                let got = '';
                try { got = (await (await fetch(`http://127.0.0.1:${fake.nodeHttpPort}/.well-known/acme-challenge/${o.token}`)).text()).trim(); } catch { /* unreachable */ }
                o.challengeStatus = got === `${o.token}.${thumbprint(fake.jwk)}` ? 'valid' : 'invalid';
                if (o.challengeStatus === 'valid') o.status = 'ready';
                else o.status = 'invalid';
            }
            return { status: 200, body: { ...challengeJson(o), ...(o.challengeStatus === 'invalid' ? { error: { type: 'urn:ietf:params:acme:error:unauthorized', detail: 'wrong answer' } } : {}) } };
        case 'order':
            return { status: 200, body: orderJson(o) };
        case 'finalize': {
            if (fake.failFinalize) return { status: 403, body: { type: 'urn:ietf:params:acme:error:unauthorized', detail: 'the fake CA refuses this finalize' } };
            if (o.status !== 'ready') return { status: 403, body: { type: 'urn:ietf:params:acme:error:orderNotReady', detail: o.status } };
            const der = fromB64u(payload.csr);
            const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
            try { o.certPem = issue(o, pem); } catch (e) { return { status: 400, body: { type: 'urn:ietf:params:acme:error:badCSR', detail: (e as Error).message } }; }
            o.status = 'valid';
            return { status: 200, body: orderJson(o) };
        }
        case 'cert':
            if (fake.hold) { fake.hold.reached(); await fake.hold.release; }
            return { status: 200, headers: { 'Content-Type': 'application/pem-certificate-chain' }, body: o.certPem };
    }
    return { status: 404 };
}

const fakeServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
        fake.requests.push({ method: req.method ?? '', path: new URL(req.url ?? '/', base()).pathname });
        let out: Awaited<ReturnType<typeof fakeHandle>>;
        try { out = await fakeHandle(req, body); } catch (e) { out = { status: 500, body: { type: 'urn:ietf:params:acme:error:serverInternal', detail: (e as Error).message } }; }
        const nonce = b64u(crypto.randomBytes(16));
        fake.nonces.add(nonce);
        const isText = typeof out.body === 'string';
        res.writeHead(out.status, { 'Replay-Nonce': nonce, 'Cache-Control': 'no-store',
            ...(out.body !== undefined && !isText ? { 'Content-Type': out.status >= 400 ? 'application/problem+json' : 'application/json' } : {}), ...(out.headers ?? {}) });
        res.end(out.body === undefined ? undefined : isText ? out.body as string : JSON.stringify(out.body));
    });
});
await new Promise<void>((r) => fakeServer.listen(0, '127.0.0.1', () => r()));
fake.port = (fakeServer.address() as AddressInfo).port;
process.env.ACME_DIRECTORY_URL = `${base()}/directory`;

// ── The node, in this process ──────────────────────────────────────────────────────────────────────────────────

const { initAdminPassword } = await import('./config/local-config.js');
const tlsMod = await import('./services/tls.js');
const se = await import('./state-engine.js');
const { startHttpServer } = await import('./http-server.js');
const { startHttpsServer } = await import('./https-server.js');
const { forgetOwnAddresses, tlsIdentifiers, isCertifiableHost } = await import('./engine/own-addresses.js');
const schedule = await import('./services/acme/schedule.js');
const challenge = await import('./services/acme/challenge.js');
const store = await import('./services/acme/store.js');
const { setNodeRole } = await import('./config/node-role.js');
const { secureDataDirAtBoot } = await import('./boot-file-safety.js');

initAdminPassword();
await tlsMod.initTls();
se.initStateEngine();
const httpPort = await startHttpServer(0);
const httpsPort = await startHttpsServer(0);
fake.nodeHttpPort = httpPort;

// The self-check fetches each identifier's port 80; here, the node's own plain listener, or what a test puts there.
const closed = http.createServer();
await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
const closedPort = (closed.address() as AddressInfo).port;
await new Promise<void>((r) => closed.close(() => r()));
const stranger = http.createServer((_req, res) => { res.writeHead(404); res.end('not here'); });
await new Promise<void>((r) => stranger.listen(0, '127.0.0.1', () => r()));
const strangerPort = (stranger.address() as AddressInfo).port;
const originFor: Record<string, number> = { 'elsewhere.example.org': closedPort, 'stranger.example.org': strangerPort };
challenge._setChallengeOriginForTests((t) => `http://127.0.0.1:${originFor[t.host] ?? httpPort}`);

let now = Date.now();
schedule._setScheduleHooksForTests({ now: () => now });
function configure(addresses: string[]) {
    process.env.BEANPOOL_ADDRESSES = addresses.join(',');
    forgetOwnAddresses();
}

/** The certificate the HTTPS listener serves for `servername` (none: no SNI at all), and whether a client trusting only the
 *  test CA accepts it for `servername` or the IP. */
function served(servername: string | null, ipCheck?: string): Promise<{ serial: string; san: string; authorized: boolean; identityOk: boolean; raw: string }> {
    return new Promise((resolve, reject) => {
        // `authorized` is the chain alone (the test CA); the name or IP is checked apart (identityOk).
        const sock = tls.connect({ host: '127.0.0.1', port: httpsPort, ...(servername ? { servername } : {}), ca: [caPem], rejectUnauthorized: false,
            checkServerIdentity: () => undefined }, () => {
            const peer = sock.getPeerCertificate();
            const identityOk = tls.checkServerIdentity(ipCheck ?? servername ?? '', peer) === undefined;
            resolve({ serial: peer.serialNumber, san: peer.subjectaltname ?? '', authorized: sock.authorized, identityOk, raw: peer.raw.toString('base64') });
            sock.end();
        });
        sock.on('error', reject);
    });
}
const serialOf = (pem: string) => new crypto.X509Certificate(pem).serialNumber;
const keyMode = (host: string) => fs.statSync(path.join(store.acmeRoot(dataDir), store.folderName(host), 'key.pem')).mode & 0o777;
const certOnDisk = (host: string) => fs.readFileSync(path.join(store.acmeRoot(dataDir), store.folderName(host), 'cert.pem'), 'utf-8');
const orderCount = () => fake.requests.filter((r) => r.path === '/new-order').length;

try {
    console.log('\n1. A name identifier is ordered over http-01 and served for that name by SNI');
    const self = await served('beans.example.org');
    configure(['beans.example.org']);
    check('precondition: the name is a tlsIdentifier', JSON.stringify(tlsIdentifiers()) === '["beans.example.org"]', JSON.stringify(tlsIdentifiers()));
    const t1 = await schedule.runAcmeTick();
    check('the tick orders it and serves it', t1.outcomes['beans.example.org'] === 'renewed', JSON.stringify(t1));
    const o1 = fake.orders[0];
    check('one order, type dns, no profile', fake.orders.length === 1 && o1.identifiers[0].type === 'dns' && o1.identifiers[0].value === 'beans.example.org' && o1.body.profile === undefined,
        JSON.stringify(o1?.body));
    check('the CA validated by fetching the node\'s port 80 (challenge valid)', o1.challengeStatus === 'valid');
    const s1 = await served('beans.example.org');
    check('SNI beans.example.org gets the CA\'s certificate, trusted for that name', s1.authorized && s1.identityOk && s1.san === 'DNS:beans.example.org', JSON.stringify(s1));
    check('it is not the self-signed one served before', s1.serial !== self.serial);
    check('cert.pem on disk is the served one', serialOf(certOnDisk('beans.example.org')).toLowerCase() === s1.serial.toLowerCase());
    const st1 = store.readState(dataDir, 'beans.example.org');
    check('state.json: valid until the certificate\'s notAfter, a 90-day life, no failures',
        st1.validUntil > Date.now() && Math.abs(st1.lifetimeMs - NAME_LIFETIME_MS) < 1000 && st1.failures === 0 && st1.lastError === null, JSON.stringify(st1));
    check('the challenge token is answered no longer once validated', (await fetch(`http://127.0.0.1:${httpPort}/.well-known/acme-challenge/${o1.token}`)).status === 404);

    console.log('\n2. An IP identifier: type ip, profile shortlived, served with no SNI');
    configure(['beans.example.org', '203.0.113.5']);
    const t2 = await schedule.runAcmeTick();
    check('the name is fresh, the IP ordered', t2.outcomes['beans.example.org'] === 'fresh' && t2.outcomes['203.0.113.5'] === 'renewed', JSON.stringify(t2));
    const o2 = fake.orders[1];
    check('the order body carries type ip and profile shortlived', JSON.stringify(o2?.body) === JSON.stringify({ identifiers: [{ type: 'ip', value: '203.0.113.5' }], profile: 'shortlived' }),
        JSON.stringify(o2?.body));
    check('the CSR names the IP as an IP SAN', JSON.stringify(o2?.csrSans) === JSON.stringify([{ type: 'ip', value: '203.0.113.5' }]), JSON.stringify(o2?.csrSans));
    const s2 = await served(null, '203.0.113.5');
    check('a client with no SNI gets the IP\'s certificate, trusted for 203.0.113.5', s2.authorized && s2.identityOk && s2.san === 'IP Address:203.0.113.5', JSON.stringify(s2));
    check('SNI beans.example.org still gets the name\'s', (await served('beans.example.org')).serial === s1.serial);
    const st2 = store.readState(dataDir, '203.0.113.5');
    check('state.json: a ~160-hour life', Math.abs(st2.lifetimeMs - IP_LIFETIME_MS) < 1000, JSON.stringify(st2));

    console.log('\n3. Renewal only when less than a third of the life is left; the old certificate serves until the new is on disk');
    configure(['beans.example.org']); // the IP's 160 hours would end long before the days this section moves the clock
    const issuedAt = new crypto.X509Certificate(certOnDisk('beans.example.org'));
    const nb = Date.parse(issuedAt.validFrom);
    now = nb + 59 * DAY; // 31 days left of 90
    let before = orderCount();
    const t3a = await schedule.runAcmeTick();
    check('31 days left of 90: fresh, nothing ordered', t3a.outcomes['beans.example.org'] === 'fresh' && orderCount() === before, JSON.stringify(t3a));
    check('the IP no longer configured is no longer served (its folder kept)', !tlsMod.servedHosts().includes('203.0.113.5') && !!store.readPair(dataDir, '203.0.113.5'));
    now = nb + 61 * DAY; // 29 days left
    let reached!: () => void;
    const atCert = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    fake.hold = { reached: () => reached(), release: new Promise<void>((r) => { release = r; }) };
    before = orderCount();
    const renewal = schedule.runAcmeTick();
    await atCert;
    const mid = await served('beans.example.org');
    check('29 days left: an order is under way', orderCount() === before + 1);
    check('while it is, SNI still gets the old certificate', mid.serial === s1.serial && mid.authorized);
    check('…and cert.pem on disk is still the old one', serialOf(certOnDisk('beans.example.org')).toLowerCase() === s1.serial.toLowerCase());
    release();
    fake.hold = null;
    const t3b = await renewal;
    const s3 = await served('beans.example.org');
    check('the renewal completes', t3b.outcomes['beans.example.org'] === 'renewed', JSON.stringify(t3b));
    check('the new certificate is on disk and served from the next connection, no restart',
        s3.serial !== s1.serial && s3.authorized && serialOf(certOnDisk('beans.example.org')).toLowerCase() === s3.serial.toLowerCase());

    console.log('\n4. A failed order keeps the old certificate and schedules a retry');
    const nb2 = Date.parse(new crypto.X509Certificate(certOnDisk('beans.example.org')).validFrom);
    now = nb2 + 61 * DAY;
    fake.failFinalize = true;
    const t4a = await schedule.runAcmeTick();
    const st4 = store.readState(dataDir, 'beans.example.org');
    check('the order fails', t4a.outcomes['beans.example.org'] === 'failed', JSON.stringify(t4a));
    check('the old certificate still serves, and stays on disk', (await served('beans.example.org')).serial === s3.serial
        && serialOf(certOnDisk('beans.example.org')).toLowerCase() === s3.serial.toLowerCase());
    check('state.json: 1 failure, the CA\'s words, the next try in an hour', st4.failures === 1 && /refuses this finalize/.test(st4.lastError ?? '')
        && st4.nextAttemptAt === now + HOUR, JSON.stringify(st4));
    now += 30 * 60_000;
    before = orderCount();
    const t4b = await schedule.runAcmeTick();
    check('half an hour later: waiting, nothing ordered', t4b.outcomes['beans.example.org'] === 'waiting' && orderCount() === before, JSON.stringify(t4b));
    now += 31 * 60_000;
    fake.failFinalize = false;
    const t4c = await schedule.runAcmeTick();
    const st4c = store.readState(dataDir, 'beans.example.org');
    check('after the hour: the retry renews and the failures are cleared', t4c.outcomes['beans.example.org'] === 'renewed' && st4c.failures === 0 && st4c.lastError === null,
        JSON.stringify({ t4c, st4c }));
    check('back-off: 1 h, 4 h, then daily', schedule.nextAttemptDelay(1, null, 0) === HOUR && schedule.nextAttemptDelay(2, null, 0) === 4 * HOUR
        && schedule.nextAttemptDelay(3, null, 0) === DAY && schedule.nextAttemptDelay(9, null, 0) === DAY);
    check('…never past a third of what a held certificate has left, nor under an hour', schedule.nextAttemptDelay(3, 30 * HOUR, 0) === 10 * HOUR
        && schedule.nextAttemptDelay(3, 2 * HOUR, 0) === HOUR && schedule.nextAttemptDelay(3, -HOUR, 0) === HOUR && schedule.nextAttemptDelay(2, 30 * DAY, 0) === 4 * HOUR);

    console.log('\n5. A self-check failure sends nothing to the CA');
    now = Date.now(); // the name renewed above is fresh again
    for (const [host, words] of [['elsewhere.example.org', /does not reach this server on port 80 \(ECONNREFUSED\)/], ['stranger.example.org', /answers on port 80, but not as this server \(HTTP 404\)/]] as const) {
        configure(['beans.example.org', host]);
        const reqs = fake.requests.length;
        const t5 = await schedule.runAcmeTick();
        const st5 = store.readState(dataDir, host);
        check(`${host}: the attempt fails`, t5.outcomes[host] === 'failed', JSON.stringify(t5));
        check(`${host}: not one request reached the CA (no directory, account, order or challenge)`, fake.requests.length === reqs,
            JSON.stringify(fake.requests.slice(reqs)));
        check(`${host}: state.json says why in words, and when to try next`, words.test(st5.lastError ?? '') && st5.failures === 1 && st5.nextAttemptAt === now + HOUR,
            JSON.stringify(st5));
        check(`${host}: no key or certificate is written`, !store.readPair(dataDir, host));
    }

    console.log('\n6. The challenge route: 404 for anything but a live token, before the CF_RECORD_NAME redirect and the tunnel');
    process.env.CF_RECORD_NAME = 'fleet.example.org';
    try {
        const plain = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${httpPort}${p}`, { redirect: 'manual', ...init });
        const unknown = crypto.randomBytes(32).toString('base64url');
        const r404 = await plain(`/.well-known/acme-challenge/${unknown}`);
        const body404 = await r404.text();
        check('an unknown token is 404 with an empty body', r404.status === 404 && body404 === '', `${r404.status} ${JSON.stringify(body404)}`);
        const other = await plain('/somewhere');
        check('precondition: any other path is redirected to https://fleet.example.org/', other.status === 301 && other.headers.get('location') === 'https://fleet.example.org/',
            `${other.status} ${other.headers.get('location')}`);
        const tunnel = await plain(`/.well-known/acme-challenge/${unknown}`, { headers: { 'cf-connecting-ip': '198.51.100.7' } });
        check('a tunnel request (cf-connecting-ip) is answered here, not handed to the HTTPS app', tunnel.status === 404 && (await tunnel.text()) === '');
        const token = crypto.randomBytes(32).toString('base64url');
        challenge.putChallenge(token, `${token}.thumb`);
        const live = await plain(`/.well-known/acme-challenge/${token}`);
        check('a live token: 200 text/plain, the key authorisation, never cached', live.status === 200 && /^text\/plain/.test(live.headers.get('content-type') ?? '')
            && live.headers.get('cache-control') === 'no-store' && (await live.text()) === `${token}.thumb`);
        check('…the same token by POST, with a query, or under a longer path: 404',
            (await plain(`/.well-known/acme-challenge/${token}`, { method: 'POST' })).status === 404
            && (await plain(`/.well-known/acme-challenge/${token}?x=1`)).status === 404
            && (await plain(`/.well-known/acme-challenge/${token}/more`)).status === 404);
        const old = crypto.randomBytes(32).toString('base64url');
        challenge.putChallenge(old, `${old}.thumb`, Date.now() - challenge.CHALLENGE_TTL_MS - 1000);
        check('a token older than 10 minutes: 404', (await plain(`/.well-known/acme-challenge/${old}`)).status === 404);
        challenge.removeChallenge(token);
    } finally {
        delete process.env.CF_RECORD_NAME;
        forgetOwnAddresses();
    }

    console.log('\n7. Keys are 0600; the boot sweep makes them so; a restart serves them from disk and asks the CA nothing');
    check('every key.pem written is 0600', keyMode('beans.example.org') === 0o600 && keyMode('203.0.113.5') === 0o600,
        `${keyMode('beans.example.org').toString(8)} ${keyMode('203.0.113.5').toString(8)}`);
    const keyFile = path.join(store.acmeRoot(dataDir), 'beans.example.org', 'key.pem');
    fs.chmodSync(keyFile, 0o644);
    const temp = path.join(store.acmeRoot(dataDir), 'beans.example.org', '.key.pem.tmp-999997-12345678');
    fs.writeFileSync(temp, 'a half-written key');
    secureDataDirAtBoot(dataDir);
    check('a key made 0644 is 0600 after the boot sweep', keyMode('beans.example.org') === 0o600, keyMode('beans.example.org').toString(8));
    check('a crash\'s temp copy in the folder is removed', !fs.existsSync(temp));
    const reqs7 = fake.requests.length;
    const started = Date.now();
    await tlsMod.initTls();
    check('initTls (a restart) serves the certificates on disk', tlsMod.servedHosts().includes('beans.example.org') && (await served('beans.example.org')).authorized);
    check('…without a single request to the CA, at once', fake.requests.length === reqs7 && Date.now() - started < 5000, `${fake.requests.length - reqs7} requests`);

    console.log('\n8. `.beanpool.org` names and private hosts are never ordered');
    const never = ['mytown.beanpool.org', 'beanpool.org', '10.0.0.5', '192.168.1.10', '172.16.4.4', '127.0.0.1', 'localhost', 'box.local',
        '100.64.1.2', '169.254.1.1', '0.0.0.0', '224.0.0.1', '[fd00::1]', '[fe80::1]', '[::1]', 'intranet', 'host.internal', 'nas.lan', 'x.test'];
    configure(never);
    check('none of them is a tlsIdentifier', tlsIdentifiers().length === 0, JSON.stringify(tlsIdentifiers()));
    check('each is refused by isCertifiableHost', never.every((h) => !isCertifiableHost(h)), never.filter((h) => isCertifiableHost(h)).join(', '));
    check('…while a public name, IPv4 and IPv6 are certifiable', ['beans.example.org', '203.0.113.5', '[2001:db8::1]'].every((h) => isCertifiableHost(h)));
    const reqs8 = fake.requests.length;
    const t8 = await schedule.runAcmeTick();
    check('a tick orders nothing and asks the CA nothing', Object.keys(t8.outcomes).length === 0 && fake.requests.length === reqs8, JSON.stringify(t8));
    check('no folder is made for any of them', never.every((h) => { try { return !fs.existsSync(path.join(store.acmeRoot(dataDir), store.folderName(h))); } catch { return true; } }));
    process.env.CF_RECORD_NAME = 'node7.beanpool.org';
    process.env.CF_API_TOKEN = 'unused-here';
    process.env.CF_ZONE_ID = 'unused-here';
    forgetOwnAddresses();
    const fleet = schedule.acmeTargets();
    check('the fleet\'s CF_RECORD_NAME goes on dns-01 through Cloudflare, never http-01 (not ordered here)',
        fleet.length === 1 && fleet[0].host === 'node7.beanpool.org' && fleet[0].challenge === 'dns-01', JSON.stringify(fleet));
    for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID']) delete process.env[k];
    forgetOwnAddresses();

    console.log('\n9. A standby orders nothing');
    configure(['beans.example.org', 'fresh-name.example.org']);
    setNodeRole('backup');
    const reqs9 = fake.requests.length;
    const t9 = await schedule.runAcmeTick();
    check('the tick is skipped on a standby, with an identifier due', t9.skipped === 'standby' && Object.keys(t9.outcomes).length === 0, JSON.stringify(t9));
    check('…and asks the CA nothing', fake.requests.length === reqs9);
    setNodeRole('primary');
    const t9b = await schedule.runAcmeTick();
    check('the same tick as the main server orders the new name', t9b.outcomes['fresh-name.example.org'] === 'renewed', JSON.stringify(t9b));

    console.log('\n10. A certificate from another ACME directory is ordered again at once (staging, then production)');
    configure(['beans.example.org']);
    const firstDirectory = schedule.acmeDirectoryUrl();
    const held10 = await served('beans.example.org');
    check('state.json records the directory the certificate came from', store.readState(dataDir, 'beans.example.org').directoryUrl === firstDirectory,
        JSON.stringify(store.readState(dataDir, 'beans.example.org')));
    // The fake CA answers whatever the query, so a second URL stands for a second directory (production after staging).
    const secondDirectory = `${firstDirectory}?production`;
    process.env.ACME_DIRECTORY_URL = secondDirectory;
    try {
        before = orderCount();
        const t10a = await schedule.runAcmeTick();
        const s10 = await served('beans.example.org');
        const st10 = store.readState(dataDir, 'beans.example.org');
        check('a fresh certificate from the old directory: one new order', t10a.outcomes['beans.example.org'] === 'renewed' && orderCount() === before + 1,
            JSON.stringify(t10a));
        check('…served from the next connection, and state.json records the new directory', s10.serial !== held10.serial && s10.authorized
            && st10.directoryUrl === secondDirectory, JSON.stringify(st10));
        before = orderCount();
        const t10b = await schedule.runAcmeTick();
        check('the next tick: fresh, nothing ordered', t10b.outcomes['beans.example.org'] === 'fresh' && orderCount() === before, JSON.stringify(t10b));
        // The fleet's adopted pair, or a state written before the directory was recorded: no directory, left alone.
        store.writeState(dataDir, { ...st10, directoryUrl: null });
        process.env.ACME_DIRECTORY_URL = firstDirectory;
        before = orderCount();
        const t10c = await schedule.runAcmeTick();
        check('a state with no directory recorded counts as this directory\'s: fresh, nothing ordered',
            t10c.outcomes['beans.example.org'] === 'fresh' && orderCount() === before, JSON.stringify(t10c));
    } finally {
        process.env.ACME_DIRECTORY_URL = firstDirectory;
    }

    console.log('\n11. docker-compose.yml passes ACME_DIRECTORY_URL through');
    const compose = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docker-compose.yml'), 'utf8');
    check('docker-compose.yml passes ACME_DIRECTORY_URL from the node\'s .env, empty by default', /^\s*- ACME_DIRECTORY_URL=\$\{ACME_DIRECTORY_URL:-\}\s*$/m.test(compose));
    check('an empty ACME_DIRECTORY_URL is Let\'s Encrypt production', (() => {
        const was = process.env.ACME_DIRECTORY_URL;
        process.env.ACME_DIRECTORY_URL = '';
        const got = schedule.acmeDirectoryUrl();
        process.env.ACME_DIRECTORY_URL = was;
        return got === 'https://acme-v02.api.letsencrypt.org/directory';
    })());
} catch (e) {
    failed++;
    console.log(`  ❌ the suite threw: ${(e as Error).stack}`);
} finally {
    schedule._setScheduleHooksForTests({ now: null });
    challenge._setChallengeOriginForTests(null);
    fakeServer.close();
    stranger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
