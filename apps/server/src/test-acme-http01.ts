/**
 * The node's own certificates over ACME http-01 (services/acme/, design scratch/global-node/DESIGN-https-anywhere-fable.md
 * §7 S1), against an in-process fake ACME CA: directory, newNonce, newAccount, newOrder, authz, challenge, finalize,
 * certificate, signing with a test CA, and "validating" by fetching the node's own plain listener (port 0). No real CA,
 * DNS or BeanPool node is contacted.
 *
 *   1. a name identifier yields a certificate served for that name via SNI;
 *   2. an IP identifier's order carries `type: 'ip'` and `profile: 'shortlived'`, its CSR an IP SAN, and its certificate
 *      is served to a client that sends no SNI; a name with no certificate here gets the self-signed pair;
 *   3. renewal happens only when less than a third of the life is left (clock injected); the old certificate serves
 *      until the new one is on disk;
 *   4. a failed order keeps the old certificate and schedules a retry (1 h, 4 h, then daily; never past a third of what
 *      is left);
 *   5. a self-check failure (port 80 not reachable from here, or answered by someone else) asks the CA anyway, at most
 *      once a day, saying so in words: a router without NAT loopback fails the check from inside although the CA reaches
 *      the server (ordered at once, then served); within the day, the CA is asked nothing;
 *   6. an unknown token is 404 with an empty body, and the route wins over the CF_RECORD_NAME redirect and the tunnel's
 *      delegation;
 *   7. keys are 0600 when written and after the boot sweep; a restart serves them from disk and asks the CA nothing;
 *   8. `.beanpool.org` names and private hosts are never ordered;
 *   9. a standby orders nothing;
 *  10. a certificate from another ACME directory than the one configured (staging, then production) is ordered again at
 *      once; a state that records no directory is left alone; a wait after a failure under another directory is not
 *      this one's;
 *  11. /trust hands out the self-signed CA to a request that named a host with no CA certificate here (beanpool.local, a
 *      LAN address), on both listeners, whenever they started; a host with one is redirected (plain) or 404 (HTTPS), also
 *      with CF_RECORD_NAME set but empty, as docker-compose.yml passes it;
 *  12. docker-compose.yml passes ACME_DIRECTORY_URL through;
 *  13. a certificate that expires (TLS clock injected) is not served to the next connection with no SNI, on a standby
 *      too, whose ticks look at nothing: the next valid certificate is, else the self-signed pair;
 *  14. state.json holds the attempt (its count and next try, and the once-a-day mark of an unconfirmed one) before the
 *      CA is asked anything: what a server that stops mid-order leaves makes its next boot wait and ask the CA nothing.
 *
 * Run: BEANPOOL_SUITE_ENV_PASSWORD=1 BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-acme-http01.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
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
    /** The port the CA "validates" an identifier on, when not the node's own (a port 80 the CA cannot reach either). */
    caPortFor: {} as Record<string, number>,
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
                const port = fake.caPortFor[o.identifiers[0].value] ?? fake.nodeHttpPort;
                try { got = (await (await fetch(`http://127.0.0.1:${port}/.well-known/acme-challenge/${o.token}`)).text()).trim(); } catch { /* unreachable */ }
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
    const unserved = await served('other.example.org');
    check('SNI for a name with no certificate here gets the self-signed pair, not another identifier\'s', unserved.serial === self.serial,
        JSON.stringify(unserved));
    const local = await served('beanpool.local');
    check('…so SNI beanpool.local gets the self-signed pair, which names it', local.serial === self.serial && local.identityOk, JSON.stringify(local));
    // Node's client refuses an IP as servername; other clients send one. The callback's answer: none, i.e. the context a
    // connection with no SNI gets (the IP's certificate, above), for an IPv4 or IPv6 address alike.
    const sniAnswer = (name: string) => new Promise<tls.SecureContext | undefined>((r) => tlsMod.httpsCertOptions().SNICallback!(name, (_e, ctx) => r(ctx)));
    check('an IP address sent as SNI is treated as no SNI (no context of its own)',
        (await sniAnswer('198.51.100.9')) === undefined && (await sniAnswer('2001:db8::7')) === undefined && (await sniAnswer('other.example.org')) !== undefined);
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
    const alertsSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'services', 'alerts.ts'), 'utf8');
    check('the owners\' tls.fallback alert promises what the back-off does: tried again within a day',
        Math.max(...schedule.BACKOFF_MS) <= DAY && /self-signed one\. It is tried again within a day\."/.test(alertsSource) && !/retried every 2 hours/.test(alertsSource));

    console.log('\n5. A self-check failure: the CA is asked anyway, at most once a day (a router without NAT loopback fails it from inside)');
    now = Date.now(); // the name renewed above is fresh again
    const anyway = /^could not confirm from inside your network; trying with the CA anyway, once a day\./;
    for (const [host, words] of [['elsewhere.example.org', /does not reach this server on port 80 \(ECONNREFUSED\)/], ['stranger.example.org', /answers on port 80, but not as this server \(HTTP 404\)/]] as const) {
        configure(['beans.example.org', host]);
        fake.caPortFor[host] = originFor[host]; // the CA cannot reach it either
        const askedAt = now;
        before = orderCount();
        const t5 = await schedule.runAcmeTick();
        const st5 = store.readState(dataDir, host);
        check(`${host}: the first failed self-check: the CA is asked anyway (one order), and its validation fails`,
            t5.outcomes[host] === 'failed' && orderCount() === before + 1, JSON.stringify(t5));
        check(`${host}: state.json says so in words: not confirmed from inside, tried anyway, the CA's answer and the check's`,
            anyway.test(st5.lastError ?? '') && /The CA said: wrong answer\./.test(st5.lastError ?? '') && words.test(st5.lastError ?? ''), st5.lastError ?? '');
        check(`${host}: 1 failure, the next try in an hour, the CA asked unconfirmed now`, st5.failures === 1 && st5.nextAttemptAt === now + HOUR
            && st5.unconfirmedAttemptAt === askedAt, JSON.stringify(st5));
        check(`${host}: no key or certificate is written`, !store.readPair(dataDir, host));
        now += HOUR + 60_000;
        let reqs = fake.requests.length;
        const t5b = await schedule.runAcmeTick();
        const st5b = store.readState(dataDir, host);
        check(`${host}: an hour later the self-check fails again: not one request reaches the CA (no directory, account, order or challenge)`,
            t5b.outcomes[host] === 'failed' && fake.requests.length === reqs, JSON.stringify(fake.requests.slice(reqs)));
        check(`${host}: …state.json: the same words without a CA answer, 2 failures, the next try in 4 hours`, anyway.test(st5b.lastError ?? '')
            && words.test(st5b.lastError ?? '') && !/wrong answer/.test(st5b.lastError ?? '') && st5b.failures === 2 && st5b.nextAttemptAt === now + 4 * HOUR
            && st5b.unconfirmedAttemptAt === askedAt, JSON.stringify(st5b));
        // The back-off set aside (nextAttemptAt 0), to see the once-a-day limit alone.
        now = askedAt + DAY - 60_000;
        store.writeState(dataDir, { ...st5b, nextAttemptAt: 0 });
        reqs = fake.requests.length;
        const t5c = await schedule.runAcmeTick();
        check(`${host}: a minute short of a day after the CA was asked: the CA is asked nothing`, t5c.outcomes[host] === 'failed' && fake.requests.length === reqs,
            JSON.stringify(t5c));
        now = askedAt + DAY;
        store.writeState(dataDir, { ...store.readState(dataDir, host), nextAttemptAt: 0 });
        before = orderCount();
        const t5d = await schedule.runAcmeTick();
        check(`${host}: a day after: the CA is asked again (one order)`, t5d.outcomes[host] === 'failed' && orderCount() === before + 1
            && store.readState(dataDir, host).unconfirmedAttemptAt === now, JSON.stringify(store.readState(dataDir, host)));
        delete fake.caPortFor[host];
    }
    // No NAT loopback at home: the check from inside cannot reach the public address, the CA can.
    const home = 'home.example.org';
    originFor[home] = closedPort;
    configure(['beans.example.org', home]);
    before = orderCount();
    const t5h = await schedule.runAcmeTick();
    const s5h = await served(home);
    const st5h = store.readState(dataDir, home);
    check('unreachable from inside but not from the CA: ordered at once, and served by SNI', t5h.outcomes[home] === 'renewed' && orderCount() === before + 1
        && s5h.authorized && s5h.identityOk, JSON.stringify({ t5h, san: s5h.san }));
    check('…state.json: no failure, no error, the CA asked unconfirmed now', st5h.failures === 0 && st5h.lastError === null && st5h.unconfirmedAttemptAt === now,
        JSON.stringify(st5h));
    delete originFor[home];
    check('the words name Let\'s Encrypt when it is the CA (production or staging), else "the CA"',
        schedule.caName('https://acme-v02.api.letsencrypt.org/directory') === "Let's Encrypt"
        && schedule.caName('https://acme-staging-v02.api.letsencrypt.org/directory') === "Let's Encrypt"
        && schedule.caName(schedule.acmeDirectoryUrl()) === 'the CA' && schedule.caName('not a url') === 'the CA');
    check('once a day is within Let\'s Encrypt\'s failed-validation limits (5 an hour; 1,152 in a row, given back 1 a day)',
        schedule.UNCONFIRMED_EVERY_MS >= DAY);

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
        '100.64.1.2', '100.127.255.254', '198.18.0.1', '198.19.255.254', '169.254.1.1', '0.0.0.0', '224.0.0.1', '[fd00::1]', '[fe80::1]', '[::1]', 'intranet', 'host.internal', 'nas.lan', 'x.test'];
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

        // No certificate held: the wait and the count a failure earns belong to its directory. Port 80 shut under the first
        // (staging), then opened and the second (production) configured: tried at once, from the first back-off step.
        const switched = 'switch.example.org';
        configure([switched]);
        originFor[switched] = closedPort;
        fake.caPortFor[switched] = closedPort;
        const firstAskedAt = now;
        const t10d = await schedule.runAcmeTick();
        now += HOUR + 60_000;
        const t10e = await schedule.runAcmeTick();
        const st10e = store.readState(dataDir, switched);
        check('no certificate, port 80 shut: two failures under the first directory, the next try in 4 hours',
            t10d.outcomes[switched] === 'failed' && t10e.outcomes[switched] === 'failed' && st10e.failures === 2
            && st10e.nextAttemptAt === now + 4 * HOUR && st10e.attemptDirectoryUrl === firstDirectory && st10e.unconfirmedAttemptAt === firstAskedAt, JSON.stringify(st10e));
        now += 5 * 60_000;
        const t10f = await schedule.runAcmeTick();
        check('…5 minutes later under the same directory: waiting', t10f.outcomes[switched] === 'waiting', JSON.stringify(t10f));
        process.env.ACME_DIRECTORY_URL = secondDirectory;
        store.writeState(dataDir, { ...st10e, attemptDirectoryUrl: null });
        const t10g = await schedule.runAcmeTick();
        check('a wait that records no directory counts as this directory\'s: still waiting after the switch', t10g.outcomes[switched] === 'waiting',
            JSON.stringify(t10g));
        store.writeState(dataDir, st10e);
        before = orderCount();
        const t10h = await schedule.runAcmeTick();
        const st10h = store.readState(dataDir, switched);
        check('the second directory configured: tried at once, and its first failure waits an hour, not 4 hours or a day',
            t10h.outcomes[switched] === 'failed' && st10h.failures === 1 && st10h.nextAttemptAt === now + HOUR
            && st10h.attemptDirectoryUrl === secondDirectory, JSON.stringify(st10h));
        check('…and the CA is asked although the first directory\'s was asked within the day (the once-a-day limit is per directory)',
            orderCount() === before + 1 && st10h.unconfirmedAttemptAt === now, JSON.stringify(st10h));
        delete originFor[switched];
        delete fake.caPortFor[switched];
        now += HOUR + 60_000;
        before = orderCount();
        const t10i = await schedule.runAcmeTick();
        const st10i = store.readState(dataDir, switched);
        check('port 80 opened, after that hour: one order, from the second directory, recorded with the certificate',
            t10i.outcomes[switched] === 'renewed' && orderCount() === before + 1 && st10i.directoryUrl === secondDirectory && st10i.failures === 0,
            JSON.stringify(st10i));
    } finally {
        process.env.ACME_DIRECTORY_URL = firstDirectory;
    }

    console.log('\n11. /trust hands out the CA unless the request named a host with a CA certificate here');
    configure(['beans.example.org']);
    const t11 = await schedule.runAcmeTick();
    check('precondition: a CA certificate is served for beans.example.org', t11.outcomes['beans.example.org'] === 'fresh'
        && tlsMod.servedHosts().includes('beans.example.org'), JSON.stringify(t11));
    /** GET /trust on a listener, as a request that named `host` (its Host header). */
    const trust = (port: number, host: string, secure = false) => new Promise<{ status: number; type: string; location: string; body: string }>((resolve, reject) => {
        const req = (secure ? https : http).request({ host: '127.0.0.1', port, path: '/trust', headers: { host }, rejectUnauthorized: false }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'] ?? '', location: res.headers.location ?? '', body }));
        });
        req.on('error', reject);
        req.end();
    });
    const handsOutCa = (r: { status: number; type: string; body: string }) => r.status === 200 && /x-pem-file/.test(r.type) && r.body === tlsMod.getCaCertPem();
    const caPemNow = tlsMod.getCaCertPem();
    check('precondition: the self-signed CA is there to hand out', /BEGIN CERTIFICATE/.test(caPemNow));
    for (const host of ['beanpool.local', '192.168.1.5', 'other.example.org']) {
        const r = await trust(httpPort, host);
        check(`plain listener, Host ${host} (no CA certificate here): the CA`, handsOutCa(r), `${r.status} ${r.type} ${r.location}`);
    }
    const toName = await trust(httpPort, 'beans.example.org');
    check('plain listener, Host beans.example.org (its certificate is served): redirected to https://beans.example.org/',
        toName.status === 302 && toName.location === 'https://beans.example.org/', `${toName.status} ${toName.location}`);
    const upper = await trust(httpPort, 'BEANS.Example.org.');
    check('…the same host in capitals and with a final dot: redirected, not the CA', upper.status === 302, `${upper.status} ${upper.type}`);
    // docker-compose.yml passes CF_RECORD_NAME=${CF_RECORD_NAME:-}: set, and empty, on every node outside the fleet.
    for (const [words, value] of [['empty, as docker-compose.yml passes it', ''], ['only spaces', '  ']] as const) {
        process.env.CF_RECORD_NAME = value;
        let r: Awaited<ReturnType<typeof trust>>;
        try { r = await trust(httpPort, 'beans.example.org'); } finally { delete process.env.CF_RECORD_NAME; }
        check(`…with CF_RECORD_NAME set but ${words}: a 302 to https://beans.example.org/, not a 500`,
            r.status === 302 && r.location === 'https://beans.example.org/', `${r.status} ${r.location}`);
    }
    const httpsLocal = await trust(httpsPort, 'beanpool.local', true);
    check('HTTPS listener, Host beanpool.local: the CA', handsOutCa(httpsLocal), `${httpsLocal.status} ${httpsLocal.type}`);
    const httpsName = await trust(httpsPort, 'beans.example.org', true);
    check('HTTPS listener, Host beans.example.org: no CA (answered as if there were no /trust)', httpsName.status === 404 && !httpsName.body.includes('BEGIN CERTIFICATE'),
        `${httpsName.status} ${httpsName.type}`);
    // The usual state after the first week: the HTTPS listener starts with a CA certificate already served.
    const httpsPortLater = await startHttpsServer(0);
    const laterLocal = await trust(httpsPortLater, 'beanpool.local', true);
    check('an HTTPS listener started with a CA certificate already served: Host beanpool.local still gets the CA', handsOutCa(laterLocal),
        `${laterLocal.status} ${laterLocal.type}`);

    console.log('\n12. docker-compose.yml passes ACME_DIRECTORY_URL through');
    const compose = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docker-compose.yml'), 'utf8');
    check('docker-compose.yml passes ACME_DIRECTORY_URL from the node\'s .env, empty by default', /^\s*- ACME_DIRECTORY_URL=\$\{ACME_DIRECTORY_URL:-\}\s*$/m.test(compose));
    check('…and CF_RECORD_NAME empty by default, as section 11 runs /trust with it', /^\s*- CF_RECORD_NAME=\$\{CF_RECORD_NAME:-\}\s*$/m.test(compose));
    check('an empty ACME_DIRECTORY_URL is Let\'s Encrypt production', (() => {
        const was = process.env.ACME_DIRECTORY_URL;
        process.env.ACME_DIRECTORY_URL = '';
        const got = schedule.acmeDirectoryUrl();
        process.env.ACME_DIRECTORY_URL = was;
        return got === 'https://acme-v02.api.letsencrypt.org/directory';
    })());

    console.log('\n13. An expired certificate is never served to a connection with no SNI, not even once, and on a standby too');
    configure(['beans.example.org', '203.0.113.5']);
    const t13 = await schedule.runAcmeTick();
    const ipFirst = await served(null, '203.0.113.5');
    check('precondition: the IP certificate (from its folder) is what a connection with no SNI gets', t13.outcomes['203.0.113.5'] === 'fresh'
        && ipFirst.san === 'IP Address:203.0.113.5', JSON.stringify({ t13, san: ipFirst.san }));
    const ipUntil = tlsMod.servedCertificate('203.0.113.5')!.notAfter;
    const nameUntil = tlsMod.servedCertificate('beans.example.org')!.notAfter;
    setNodeRole('backup');
    try {
        tlsMod._setTlsClockForTests(() => ipUntil + 1000);
        const t13b = await schedule.runAcmeTick();
        check('precondition: a standby\'s tick stops before it looks at any certificate', t13b.skipped === 'standby', JSON.stringify(t13b));
        const afterIp = await served(null, 'beans.example.org');
        check('the IP certificate has expired: the very next connection with no SNI gets the name\'s, the next valid one',
            afterIp.san === 'DNS:beans.example.org', afterIp.san);
        check('…and the listener and /trust agree: 203.0.113.5 has no CA certificate here now', !tlsMod.servesCaCertificateFor('203.0.113.5')
            && tlsMod.servesCaCertificateFor('beans.example.org'));
        tlsMod._setTlsClockForTests(() => nameUntil + 1000);
        const afterAll = await served(null);
        check('every CA certificate has expired: the next connection with no SNI gets the self-signed pair', afterAll.serial === self.serial, afterAll.san);
        check('…and so does SNI beans.example.org', (await served('beans.example.org')).serial === self.serial);
    } finally {
        tlsMod._setTlsClockForTests(null);
        setNodeRole('primary');
    }
    const t13c = await schedule.runAcmeTick();
    check('the clock back, the main server\'s next tick: the IP certificate is served with no SNI again', t13c.outcomes['203.0.113.5'] === 'fresh'
        && (await served(null, '203.0.113.5')).san === 'IP Address:203.0.113.5', JSON.stringify(t13c));

    console.log('\n14. The attempt is on disk before the CA is asked: a server that stops mid-order waits at its next boot');
    // What state.json holds at the moment the order would reach the CA is what a crash then leaves: put back after the
    // attempt, then a tick reads it as the next boot's first tick would.
    const stateFile = (host: string) => path.join(store.acmeRoot(dataDir), store.folderName(host), 'state.json');
    const rawState = (host: string) => { try { return fs.readFileSync(stateFile(host), 'utf8'); } catch { return null; } };
    const leaveOnDisk = (host: string, raw: string | null) => { if (raw === null) fs.rmSync(stateFile(host), { force: true }); else fs.writeFileSync(stateFile(host), raw); };
    for (const [host, unconfirmed] of [['crash.example.org', false], ['crash-shut.example.org', true]] as const) {
        configure([host]);
        if (unconfirmed) { originFor[host] = closedPort; fake.caPortFor[host] = closedPort; }
        now = Date.now();
        const stoppedAt = now;
        let atTheCa: string | null = null;
        schedule._setScheduleHooksForTests({ order: async (_target, opts) => {
            // Confirmed: the order reaches the CA as it starts. Unconfirmed: once the scheduler says to go on anyway.
            if (unconfirmed && !opts.orderUnconfirmed?.('port 80 is shut')) throw new Error('not asked anyway');
            atTheCa = rawState(host);
            throw new Error('the server stopped here');
        } });
        try { await schedule.runAcmeTick(); } finally { schedule._setScheduleHooksForTests({ order: null }); }
        const was = atTheCa ? JSON.parse(atTheCa) : null;
        check(`${host}: when the order reached the CA, state.json already said: one failure, the next try in an hour`,
            was?.failures === 1 && was?.nextAttemptAt === stoppedAt + HOUR && was?.lastAttemptAt === stoppedAt, String(atTheCa));
        if (unconfirmed) {
            check(`${host}: …and that the CA was asked unconfirmed now, before the challenge went out`, was?.unconfirmedAttemptAt === stoppedAt, String(atTheCa));
            check(`${host}: …with what the self-check found, in words, before the CA answers`,
                /^could not confirm from inside your network; trying with the CA anyway, once a day\. The check from here: port 80 is shut$/.test(was?.lastError ?? ''),
                String(was?.lastError));
        }
        leaveOnDisk(host, atTheCa);
        let reqs = fake.requests.length;
        const boot = await schedule.runAcmeTick();
        check(`${host}: the next boot's first tick (the same minute) waits and asks the CA nothing`, boot.outcomes[host] === 'waiting' && fake.requests.length === reqs,
            JSON.stringify({ boot, asked: fake.requests.slice(reqs) }));
        now = stoppedAt + HOUR + 60_000;
        reqs = fake.requests.length;
        const later = await schedule.runAcmeTick();
        if (unconfirmed) {
            check(`${host}: an hour on, port 80 still shut: the self-check fails and the CA is asked nothing within the day`,
                later.outcomes[host] === 'failed' && fake.requests.length === reqs, JSON.stringify({ later, asked: fake.requests.slice(reqs) }));
            delete originFor[host];
            delete fake.caPortFor[host];
        } else {
            check(`${host}: an hour on: ordered, served, and the failure cleared`, later.outcomes[host] === 'renewed'
                && store.readState(dataDir, host).failures === 0 && tlsMod.servedHosts().includes(host), JSON.stringify(later));
        }
    }
} catch (e) {
    failed++;
    console.log(`  ❌ the suite threw: ${(e as Error).stack}`);
} finally {
    schedule._setScheduleHooksForTests({ now: null });
    tlsMod._setTlsClockForTests(null);
    challenge._setChallengeOriginForTests(null);
    fakeServer.close();
    stranger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
