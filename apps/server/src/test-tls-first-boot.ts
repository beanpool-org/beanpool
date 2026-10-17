/**
 * A node's self-signed TLS certificates never fail a boot (services/tls.ts generateSelfSigned).
 *
 * selfsigned 2.x makes a certificate OpenSSL 3 cannot parse 1 time in 65,536 (33 serials in 2,000,000 measured in
 * #2031's review): a random serial starting 00 00 with a third byte below 0x80 is written as a non-minimal INTEGER,
 * and https.createServer throws "asn1 illegal padding" (CI, 15 Oct, test-group-keys-over-time). This suite makes that
 * certificate on purpose:
 *   1. a fresh boot whose first certificate is the bad one makes another and serves a good pair; the same when only
 *      its CA is bad;
 *   2. a good set on disk is used as it is: nothing made, nothing written;
 *   3. a bad CA on disk (written by an older version), or none, is made again alone: the server pair a browser or
 *      NODE_EXTRA_CA_CERTS already trusts is kept, byte for byte (#2031 N1);
 *   4. a bad server certificate on disk is replaced, with a new CA beside it (selfsigned cannot sign with the old one);
 *   5. a certificate and key from two different runs on disk are replaced;
 *   6. a generator that only ever makes bad ones fails with a plain message after its tries, writing nothing;
 *   7. the boot never waits on an ACME order (design scratch/global-node/DESIGN-https-anywhere-fable.md S1): with the
 *      fleet's Cloudflare variables set (which made initTls order from Let's Encrypt, awaited, before the listeners) and
 *      a CA that never answers, initTls returns at once and asks it nothing; it serves the ACME certificates on disk
 *      that are still valid, copies the fleet's old le-cert.pem pair into data/tls/acme/ (the old files stay for one
 *      release; a pair an older image renewed there is copied again), and serves self-signed when there are none.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tls-first-boot-'));
process.env.BEANPOOL_DATA_DIR = dataDir;
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID']) delete process.env[k];
const tlsDir = path.join(dataDir, 'tls');

const tlsMod = await import('./services/tls.js');
const require = createRequire(import.meta.url);
const selfsigned = require('selfsigned');
const forge = require(require.resolve('node-forge', { paths: [path.dirname(require.resolve('selfsigned'))] }));
type Generate = NonNullable<Parameters<typeof tlsMod._setSelfSignedGenerateForTests>[0]>;
type Attrs = Parameters<Generate>[0];
type Opts = Parameters<Generate>[1];

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
    if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function pairParses(cert: string, key: string): string | null {
    try { tls.createSecureContext({ cert, key }); return null; } catch (e) { return (e as Error).message; }
}
function certParses(cert: string): string | null {
    try { new crypto.X509Certificate(cert); return null; } catch (e) { return (e as Error).message; }
}

/** selfsigned.generate, but the serial it draws (its one 9-byte random draw) starts 00 00 17: the case CI hit (a third
 * byte of 0x80 or more would make the one zero node-forge leaves a legal sign byte). */
function generateBad(attrs: Attrs, opts: Opts) {
    const draw = forge.random.getBytesSync;
    forge.random.getBytesSync = (n: number) => (n === 9 ? '\x00\x00\x17' + draw.call(forge.random, 6) : draw.call(forge.random, n));
    try { return selfsigned.generate(attrs, opts); } finally { forge.random.getBytesSync = draw; }
}
/** selfsigned.generate, counting its calls (one per certificate). */
let calls = 0;
function counted(make: (attrs: Attrs, opts: Opts, n: number) => ReturnType<typeof generateBad>) {
    calls = 0;
    tlsMod._setSelfSignedGenerateForTests((attrs: Attrs, opts: Opts) => make(attrs, opts, ++calls));
}
function clearTls() { fs.rmSync(tlsDir, { recursive: true, force: true }); }
function onDisk() {
    const r = (f: string) => fs.readFileSync(path.join(tlsDir, f), 'utf-8');
    return { ca: r('ca.pem'), caKey: r('ca-key.pem'), cert: r('server.pem'), key: r('server-key.pem') };
}
/** A file as it stands: its bytes, inode and mtime (a rewrite, even of the same bytes, changes the inode). */
function stat(f: string) {
    const p = path.join(tlsDir, f);
    const s = fs.statSync(p);
    return `${fs.readFileSync(p, 'base64')}|${s.ino}|${s.mtimeMs}`;
}
const changed = (before: Record<string, string>) => Object.keys(before).filter((f) => stat(f) !== before[f]);
const snapshot = (files: string[]) => Object.fromEntries(files.map((f) => [f, stat(f)]));
const FOUR = ['ca.pem', 'ca-key.pem', 'server.pem', 'server-key.pem'];
const CA_ATTRS = [{ name: 'commonName', value: 'BeanPool Local CA' }];

try {
    console.log('\n0. The injected certificate is the one CI hit');
    const bad = generateBad([{ name: 'commonName', value: 'beanpool.local' }], { keySize: 2048, algorithm: 'sha256' });
    const why = pairParses(bad.cert, bad.private);
    check('OpenSSL refuses it with "illegal padding"', !!why && /illegal padding/.test(why), why ?? 'it parsed');
    const badCa = generateBad(CA_ATTRS, { keySize: 2048, algorithm: 'sha256' });
    const caWhy = certParses(badCa.cert);
    check('…and a CA made the same way with "illegal padding"', !!caWhy && /illegal padding/.test(caWhy), caWhy ?? 'it parsed');

    console.log('\n1. A fresh boot whose first certificate is bad makes another');
    clearTls();
    counted((attrs, opts, n) => (n <= 2 ? generateBad(attrs, opts) : selfsigned.generate(attrs, opts)));
    await tlsMod.initTls();
    check('the served pair parses', pairParses(tlsMod.getServerCertPem(), tlsMod.getServerKeyPem()) === null);
    check('it made a second set (4 certificates)', calls === 4, `calls=${calls}`);
    const d1 = onDisk();
    check('the pair on disk is the served one and parses', d1.cert === tlsMod.getServerCertPem() && pairParses(d1.cert, d1.key) === null);

    clearTls();
    counted((attrs, opts, n) => (n === 1 ? generateBad(attrs, opts) : selfsigned.generate(attrs, opts)));
    await tlsMod.initTls();
    check('a first set whose CA alone is bad is made again too (4 certificates)', calls === 4, `calls=${calls}`);
    const d1b = onDisk();
    check('…and the CA served and on disk parses', certParses(tlsMod.getCaCertPem()) === null && d1b.ca === tlsMod.getCaCertPem(),
        certParses(tlsMod.getCaCertPem()) ?? 'the served CA is not the one on disk');

    console.log('\n2. A good set on disk is used as it is');
    const kept = snapshot(FOUR);
    counted((attrs, opts) => selfsigned.generate(attrs, opts));
    await tlsMod.initTls();
    check('no certificate is made', calls === 0, `calls=${calls}`);
    check('the four files keep their bytes, inode and mtime', changed(kept).length === 0, `changed: ${changed(kept).join(', ')}`);
    check('the served CA and pair are the ones on disk', tlsMod.getCaCertPem() === d1b.ca && tlsMod.getServerCertPem() === d1b.cert
        && tlsMod.getServerKeyPem() === d1b.key);

    console.log('\n3. A bad CA on disk, or none, is made again alone; the server pair stays');
    fs.writeFileSync(path.join(tlsDir, 'ca.pem'), badCa.cert);
    fs.writeFileSync(path.join(tlsDir, 'ca-key.pem'), badCa.private);
    const server = snapshot(['server.pem', 'server-key.pem']);
    counted((attrs, opts) => selfsigned.generate(attrs, opts));
    await tlsMod.initTls();
    const d3 = onDisk();
    check('the bad CA is not served or kept', tlsMod.getCaCertPem() !== badCa.cert && d3.ca !== badCa.cert && d3.caKey !== badCa.private);
    check('the new CA on disk parses and is the one served', certParses(d3.ca) === null && d3.ca === tlsMod.getCaCertPem());
    check('only the CA was made (1 certificate)', calls === 1, `calls=${calls}`);
    check('server.pem and server-key.pem keep their bytes, inode and mtime', changed(server).length === 0, `changed: ${changed(server).join(', ')}`);
    check('the served pair is the kept one', tlsMod.getServerCertPem() === d1b.cert && tlsMod.getServerKeyPem() === d1b.key);

    fs.rmSync(path.join(tlsDir, 'ca.pem'));
    counted((attrs, opts) => selfsigned.generate(attrs, opts));
    await tlsMod.initTls();
    check('a missing ca.pem is made again alone (1 certificate), the server pair kept',
        calls === 1 && certParses(onDisk().ca) === null && changed(server).length === 0 && tlsMod.getServerCertPem() === d1b.cert,
        `calls=${calls}, changed: ${changed(server).join(', ')}`);

    console.log('\n4. A bad server certificate on disk is replaced, with a new CA');
    const caBefore = onDisk().ca;
    fs.writeFileSync(path.join(tlsDir, 'server.pem'), bad.cert);
    fs.writeFileSync(path.join(tlsDir, 'server-key.pem'), bad.private);
    counted((attrs, opts) => selfsigned.generate(attrs, opts));
    await tlsMod.initTls();
    check('the served pair parses', pairParses(tlsMod.getServerCertPem(), tlsMod.getServerKeyPem()) === null);
    check('the bad certificate is not served', tlsMod.getServerCertPem() !== bad.cert);
    const d4 = onDisk();
    check('the next boot finds a good pair on disk', pairParses(d4.cert, d4.key) === null && d4.cert !== bad.cert);
    check('the four are made together (2 certificates, a new CA)', calls === 2 && d4.ca !== caBefore && certParses(d4.ca) === null, `calls=${calls}`);

    console.log('\n5. A certificate and key from two different runs are replaced');
    const other = selfsigned.generate([{ name: 'commonName', value: 'beanpool.local' }], { keySize: 2048, algorithm: 'sha256' });
    fs.writeFileSync(path.join(tlsDir, 'server-key.pem'), other.private);
    check('precondition: the mixed pair does not parse', pairParses(d4.cert, other.private) !== null);
    await tlsMod.initTls();
    check('the served pair parses', pairParses(tlsMod.getServerCertPem(), tlsMod.getServerKeyPem()) === null);
    const d5 = onDisk();
    check('the pair on disk parses', pairParses(d5.cert, d5.key) === null);

    console.log('\n6. A generator that only makes bad certificates fails plainly, writing nothing');
    clearTls();
    tlsMod._setSelfSignedGenerateForTests(generateBad);
    let err = '';
    try { await tlsMod.initTls(); } catch (e) { err = (e as Error).message; }
    check('initTls throws after its tries', /5 self-signed certificates in a row did not parse: .*illegal padding/.test(err), err || 'no error');
    check('no certificate was written', !fs.existsSync(path.join(tlsDir, 'server.pem')));
    tlsMod._setSelfSignedGenerateForTests(null);

    console.log('\n7. The boot never waits on an ACME order');
    // A CA that takes every connection and never answers: an order at boot would hang here.
    const asked: string[] = [];
    const silent = http.createServer((req) => { asked.push(`${req.method} ${req.url}`); });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    process.env.ACME_DIRECTORY_URL = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/directory`;
    Object.assign(process.env, { CF_RECORD_NAME: 'fleet.example.org', CF_API_TOKEN: 'never-used', CF_ZONE_ID: 'never-used' });
    try {
        clearTls();
        let t0 = Date.now();
        await tlsMod.initTls();
        check('the fleet set up, no certificate: initTls returns at once and asks the CA nothing', Date.now() - t0 < 5000 && asked.length === 0,
            `${Date.now() - t0} ms, ${asked.length} request(s)`);
        check('…and serves the self-signed pair, not yet told as a fall-back (no renewal check has run)', !tlsMod.isUsingLetsEncrypt()
            && pairParses(tlsMod.getServerCertPem(), tlsMod.getServerKeyPem()) === null && !tlsMod.tlsFellBackToSelfSigned());

        // What earlier runs left: the fleet's pair where it used to live, and ACME folders, one of them expired.
        const caKey = forge.pki.privateKeyFromPem(crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey);
        const leaf = (host: string, from: number, to: number) => {
            const keyPem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
                publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
            const k = forge.pki.privateKeyFromPem(keyPem);
            const c = forge.pki.createCertificate();
            c.publicKey = forge.pki.setRsaPublicKey(k.n, k.e);
            c.serialNumber = '7' + crypto.randomBytes(8).toString('hex');
            c.validity.notBefore = new Date(Date.now() + from);
            c.validity.notAfter = new Date(Date.now() + to);
            c.setSubject([{ name: 'commonName', value: host }]);
            c.setIssuer([{ name: 'commonName', value: 'Earlier Run CA' }]);
            c.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: host }] }]);
            c.sign(caKey, forge.md.sha256.create());
            return { cert: forge.pki.certificateToPem(c), key: keyPem };
        };
        const DAY = 86_400_000;
        const fleet = leaf('fleet.example.org', -DAY, 60 * DAY);
        fs.writeFileSync(path.join(tlsDir, 'le-cert.pem'), fleet.cert);
        fs.writeFileSync(path.join(tlsDir, 'le-key.pem'), fleet.key, { mode: 0o600 });
        const put = (host: string, pair: { cert: string; key: string }) => {
            const dir = path.join(tlsDir, 'acme', host);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'cert.pem'), pair.cert);
            fs.writeFileSync(path.join(dir, 'key.pem'), pair.key, { mode: 0o600 });
        };
        put('beans.example.org', leaf('beans.example.org', -DAY, 30 * DAY));
        put('old.example.org', leaf('old.example.org', -90 * DAY, -DAY));
        put('wrong.example.org', leaf('someone-else.example.org', -DAY, 30 * DAY));

        t0 = Date.now();
        await tlsMod.initTls();
        check('with certificates on disk: at once, still not one request to the CA', Date.now() - t0 < 5000 && asked.length === 0,
            `${Date.now() - t0} ms, ${asked.length} request(s)`);
        const servedNow = tlsMod.servedHosts().sort();
        check('the valid ones are served (the fleet\'s and beans.example.org), not the expired one or one for another name',
            JSON.stringify(servedNow) === JSON.stringify(['beans.example.org', 'fleet.example.org']), JSON.stringify(servedNow));
        const fleetDir = path.join(tlsDir, 'acme', 'fleet.example.org');
        const legacyIs = (pair: { cert: string; key: string }) => ['le-cert.pem', 'le-key.pem'].every((f) => fs.existsSync(path.join(tlsDir, f)))
            && fs.readFileSync(path.join(tlsDir, 'le-cert.pem'), 'utf-8') === pair.cert && fs.readFileSync(path.join(tlsDir, 'le-key.pem'), 'utf-8') === pair.key;
        check('the fleet\'s old le-cert.pem pair is copied into data/tls/acme/fleet.example.org/ (key 0600)',
            fs.readFileSync(path.join(fleetDir, 'cert.pem'), 'utf-8') === fleet.cert && fs.readFileSync(path.join(fleetDir, 'key.pem'), 'utf-8') === fleet.key
            && (fs.statSync(path.join(fleetDir, 'key.pem')).mode & 0o777) === 0o600);
        check('…and the old files stay, byte for byte (an older image, which reads only them, can still be rolled back to)', legacyIs(fleet));
        check('a CA certificate is in use, and the self-signed pair is still there behind it', tlsMod.isUsingLetsEncrypt()
            && pairParses(tlsMod.getServerCertPem(), tlsMod.getServerKeyPem()) === null && !tlsMod.tlsFellBackToSelfSigned());

        // Rolled back: the older image renewed le-cert.pem. Rolled forward: the newer pair is the one copied and served.
        const renewedByOld = leaf('fleet.example.org', -60_000, 89 * DAY);
        fs.writeFileSync(path.join(tlsDir, 'le-cert.pem'), renewedByOld.cert);
        fs.writeFileSync(path.join(tlsDir, 'le-key.pem'), renewedByOld.key, { mode: 0o600 });
        await tlsMod.initTls();
        check('le-cert.pem renewed by an older image (later notAfter): copied over the store\'s and served on the next boot',
            fs.readFileSync(path.join(fleetDir, 'cert.pem'), 'utf-8') === renewedByOld.cert
            && tlsMod.servedCertificate('fleet.example.org')?.cert === renewedByOld.cert && legacyIs(renewedByOld));
        // Renewed by this image (the store's is the newer): the older le-cert.pem is never copied back over it.
        const renewedByNew = leaf('fleet.example.org', 0, 90 * DAY);
        fs.writeFileSync(path.join(fleetDir, 'cert.pem'), renewedByNew.cert);
        fs.writeFileSync(path.join(fleetDir, 'key.pem'), renewedByNew.key, { mode: 0o600 });
        await tlsMod.initTls();
        check('the store\'s certificate the newer one: left as it is and served, le-cert.pem untouched',
            fs.readFileSync(path.join(fleetDir, 'cert.pem'), 'utf-8') === renewedByNew.cert
            && tlsMod.servedCertificate('fleet.example.org')?.cert === renewedByNew.cert && legacyIs(renewedByOld));
    } finally {
        for (const k of ['ACME_DIRECTORY_URL', 'CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID']) delete process.env[k];
        silent.closeAllConnections();
        silent.close();
    }
} finally {
    tlsMod._setSelfSignedGenerateForTests(null);
    fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
