/**
 * A node's self-signed TLS certificates never fail a boot (services/tls.ts generateSelfSigned).
 *
 * selfsigned 2.x makes a server certificate OpenSSL 3 cannot parse about once in 10,000 (2 of 20,000 measured on
 * 16 Oct): a random serial starting 00 00 is written as a non-minimal INTEGER, and https.createServer throws
 * "asn1 illegal padding" (CI, 15 Oct, test-group-keys-over-time). This suite makes that certificate on purpose:
 *   1. a fresh boot whose first certificate is the bad one makes another and serves a good pair;
 *   2. a bad certificate already on disk (written by an older version) is replaced, not loaded;
 *   3. a certificate and key from two different runs on disk are replaced;
 *   4. a generator that only ever makes bad ones fails with a plain message after its tries, writing nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createRequire } from 'node:module';

const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tls-first-boot-'));
process.env.BEANPOOL_DATA_DIR = dataDir;
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID']) delete process.env[k];
const tlsDir = path.join(dataDir, 'tls');

const tlsMod = await import('./services/tls.js');
const require = createRequire(import.meta.url);
const selfsigned = require('selfsigned');
const forge = require(require.resolve('node-forge', { paths: [path.dirname(require.resolve('selfsigned'))] }));

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
    if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function pairParses(cert: string, key: string): string | null {
    try { tls.createSecureContext({ cert, key }); return null; } catch (e) { return (e as Error).message; }
}

/** selfsigned.generate, but the serial it draws (its one 9-byte random draw) starts 00 00 17: the case CI hit (a third
 * byte of 0x80 or more would make the one zero node-forge leaves a legal sign byte). */
function generateBad(attrs: any, opts: any) {
    const draw = forge.random.getBytesSync;
    forge.random.getBytesSync = (n: number) => (n === 9 ? '\x00\x00\x17' + draw.call(forge.random, 6) : draw.call(forge.random, n));
    try { return selfsigned.generate(attrs, opts); } finally { forge.random.getBytesSync = draw; }
}
function clearTls() { fs.rmSync(tlsDir, { recursive: true, force: true }); }
function onDisk() {
    const r = (f: string) => fs.readFileSync(path.join(tlsDir, f), 'utf-8');
    return { ca: r('ca.pem'), cert: r('server.pem'), key: r('server-key.pem') };
}

try {
    console.log('\n0. The injected certificate is the one CI hit');
    const bad = generateBad([{ name: 'commonName', value: 'beanpool.local' }], { keySize: 2048, algorithm: 'sha256' });
    const why = pairParses(bad.cert, bad.private);
    check('OpenSSL refuses it with "illegal padding"', !!why && /illegal padding/.test(why), why ?? 'it parsed');

    console.log('\n1. A fresh boot whose first certificate is bad makes another');
    clearTls();
    let calls = 0;
    tlsMod._setSelfSignedGenerateForTests((attrs: any, opts: any) => (++calls <= 2 ? generateBad(attrs, opts) : selfsigned.generate(attrs, opts)));
    await tlsMod.initTls();
    check('the served pair parses', pairParses(tlsMod.getServerCertPem(), tlsMod.getServerKeyPem()) === null);
    check('it made a second set (4 certificates)', calls === 4, `calls=${calls}`);
    const d1 = onDisk();
    check('the pair on disk is the served one and parses', d1.cert === tlsMod.getServerCertPem() && pairParses(d1.cert, d1.key) === null);
    tlsMod._setSelfSignedGenerateForTests(null);

    console.log('\n2. A bad certificate already on disk is replaced');
    fs.writeFileSync(path.join(tlsDir, 'server.pem'), bad.cert);
    fs.writeFileSync(path.join(tlsDir, 'server-key.pem'), bad.private);
    await tlsMod.initTls();
    check('the served pair parses', pairParses(tlsMod.getServerCertPem(), tlsMod.getServerKeyPem()) === null);
    check('the bad certificate is not served', tlsMod.getServerCertPem() !== bad.cert);
    const d2 = onDisk();
    check('the next boot finds a good pair on disk', pairParses(d2.cert, d2.key) === null && d2.cert !== bad.cert);

    console.log('\n3. A certificate and key from two different runs are replaced');
    const other = selfsigned.generate([{ name: 'commonName', value: 'beanpool.local' }], { keySize: 2048, algorithm: 'sha256' });
    fs.writeFileSync(path.join(tlsDir, 'server-key.pem'), other.private);
    check('precondition: the mixed pair does not parse', pairParses(d2.cert, other.private) !== null);
    await tlsMod.initTls();
    check('the served pair parses', pairParses(tlsMod.getServerCertPem(), tlsMod.getServerKeyPem()) === null);
    const d3 = onDisk();
    check('the pair on disk parses', pairParses(d3.cert, d3.key) === null);

    console.log('\n4. A generator that only makes bad certificates fails plainly, writing nothing');
    clearTls();
    tlsMod._setSelfSignedGenerateForTests(generateBad);
    let err = '';
    try { await tlsMod.initTls(); } catch (e) { err = (e as Error).message; }
    check('initTls throws after its tries', /5 self-signed certificates in a row did not parse: .*illegal padding/.test(err), err || 'no error');
    check('no certificate was written', !fs.existsSync(path.join(tlsDir, 'server.pem')));
    tlsMod._setSelfSignedGenerateForTests(null);
} finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
