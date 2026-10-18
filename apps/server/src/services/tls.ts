/**
 * TLS — the certificates this server serves
 *
 * Every public identifier this server accepts members' signatures for (engine/own-addresses.ts tlsIdentifiers) gets a
 * certificate of its own from an ACME CA: Let's Encrypt unless ACME_DIRECTORY_URL names another. services/acme/schedule.ts
 * orders and renews them once both listeners are up: http-01 on the server's own port 80, dns-01 through Cloudflare only
 * for our fleet's CF_RECORD_NAME (design scratch/global-node/DESIGN-https-anywhere-fable.md §1, §2). They are served by
 * SNI; a connection with no SNI (an IP address, an old client) gets the IP's certificate, else the first name's, else the
 * self-signed pair, and a name with no certificate here gets the self-signed pair. A renewed certificate is served from
 * the next connection on; no restart.
 *
 * LAN nodes (no public identifier):
 *   → Generate self-signed Root CA + server cert for beanpool.local
 *   → Users install CA via Trust Bootstrap page
 * The same pair is what is served when no CA certificate is valid, so an expired one is never served.
 *
 * The boot never waits on the network: initTls() loads what is on disk and makes the self-signed pair when there is none.
 */

import fs from 'node:fs';
import { writeFileAtomic } from '../write-file-atomic.js';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import selfsigned from 'selfsigned';
import { audienceOf } from '@beanpool/core';
import { certCovers, certTimes, readPair, storedHosts, writePair, type CertPair } from './acme/store.js';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const TLS_DIR = path.join(DATA_DIR, 'tls');
const CA_CERT_PATH = path.join(TLS_DIR, 'ca.pem');
const CA_KEY_PATH = path.join(TLS_DIR, 'ca-key.pem');
const SERVER_CERT_PATH = path.join(TLS_DIR, 'server.pem');
const SERVER_KEY_PATH = path.join(TLS_DIR, 'server-key.pem');
/** Where the fleet's Let's Encrypt pair lived before each identifier had a folder (copied into it; kept for one release). */
const LE_CERT_PATH = path.join(TLS_DIR, 'le-cert.pem');
const LE_KEY_PATH = path.join(TLS_DIR, 'le-key.pem');

let caCertPem: string = '';
let serverCertPem: string = '';
let serverKeyPem: string = '';

/** A CA certificate being served, by the host a client names in SNI (an IPv6 one in brackets). */
interface Served {
    host: string;
    ip: boolean;
    cert: string;
    key: string;
    notBefore: number;
    notAfter: number;
    context: tls.SecureContext;
}
const served = new Map<string, Served>();
/** The identifiers in configured order (schedule.ts), for which name a connection with no SNI gets. */
let preferredOrder: string[] = [];
/** The HTTPS listeners, told when the certificate for a connection with no SNI changes. */
const listeners = new Set<tls.Server>();
/** The pair a connection with no SNI gets now, and until when (a CA certificate's notAfter; the self-signed pair: no end). */
let defaultServed: DefaultPair | null = null;
/** The fleet's certificate has been looked at by a tick since this start (tlsFellBackToSelfSigned). */
let fleetChecked = false;
/** The time every certificate here is checked against. */
let clock = () => Date.now();
/** Tests only: check certificates against this clock (null puts it back). */
export function _setTlsClockForTests(now: (() => number) | null): void { clock = now ?? (() => Date.now()); }

// --- Exports ---

export function tlsDataDir(): string { return DATA_DIR; }
export function getCaCertPem(): string { return caCertPem; }
/** The self-signed pair: what is served when no CA certificate is. */
export function getServerCertPem(): string { return serverCertPem; }
export function getServerKeyPem(): string { return serverKeyPem; }
/** Whether this server serves a certificate a CA issued, for any of its identifiers. */
export function isUsingLetsEncrypt(): boolean { return served.size > 0; }

/** A host as SNI or a Host header names it, as `served` keys it: lower case, no final dot. */
function hostKey(name: string): string { return name.toLowerCase().replace(/\.+$/, ''); }

/**
 * Whether a request that named `host` (its Host header's hostname) came by an identifier this server serves a valid CA
 * certificate for, so a browser there needs no self-signed CA. /trust on both listeners asks this per request: on a node
 * that is public and used on its LAN, beanpool.local and a LAN address still get the CA.
 */
export function servesCaCertificateFor(host: string, now = clock()): boolean {
    const s = served.get(hostKey(host));
    return !!s && s.notAfter > now;
}

/** CF_RECORD_NAME as signatures carry it, when our fleet's dns-01 path is set up (all three CF variables); else null. */
export function fleetIdentifier(): string | null {
    const name = (process.env.CF_RECORD_NAME ?? '').trim();
    if (!name || !process.env.CF_API_TOKEN || !process.env.CF_ZONE_ID) return null;
    return audienceOf(name);
}

/** A public node (it asks Let's Encrypt through Cloudflare) that is serving its self-signed certificate after a renewal
 *  check: what services/alerts.ts tells the owners. */
export function tlsFellBackToSelfSigned(): boolean {
    const fleet = fleetIdentifier();
    return !!fleet && fleetChecked && !served.has(fleet) && !!serverCertPem;
}

/** schedule.ts: a tick has looked at the fleet's certificate. */
export function noteFleetChecked(): void { fleetChecked = true; }

/** The CA certificate served for `host`, or null. */
export function servedCertificate(host: string): { cert: string; notBefore: number; notAfter: number } | null {
    const s = served.get(host);
    return s ? { cert: s.cert, notBefore: s.notBefore, notAfter: s.notAfter } : null;
}

export function servedHosts(): string[] {
    return [...served.keys()];
}

/**
 * Serve `pair` for `host` from the next connection on, or stop serving one (null). A pair that does not load, has
 * expired by `now` or does not name `host` is refused and the old one stays: the problem in words, else null.
 */
export function serveCertificate(host: string, pair: CertPair | null, now = clock()): string | null {
    if (!pair) {
        if (served.delete(host)) refreshDefault();
        return null;
    }
    const times = certTimes(pair.cert);
    if (!times) return 'the certificate does not parse';
    if (times.notAfter <= now) return 'the certificate has expired';
    if (!certCovers(pair.cert, host)) return `the certificate does not name ${host}`;
    let context: tls.SecureContext;
    try {
        context = tls.createSecureContext({ cert: pair.cert, key: pair.key });
    } catch (err) {
        return (err as Error).message || String(err);
    }
    const ip = host.startsWith('[') || /^[\d.]+$/.test(host);
    served.set(host, { host, ip, cert: pair.cert, key: pair.key, ...times, context });
    refreshDefault();
    return null;
}

/** schedule.ts: the identifiers in configured order. */
export function setPreferredOrder(hosts: string[]): void {
    preferredOrder = [...hosts];
    refreshDefault();
}

interface DefaultPair extends CertPair { until: number }

/** What a connection with no SNI gets: an IPv4 address's certificate, an IPv6 one's, the first name's, the self-signed pair. */
function defaultPair(now = clock()): DefaultPair {
    const rank = (s: Served) => (!s.ip ? 2 : s.host.startsWith('[') ? 1 : 0);
    const place = (s: Served) => { const i = preferredOrder.indexOf(s.host); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
    const best = [...served.values()].filter((s) => s.notAfter > now)
        .sort((a, b) => rank(a) - rank(b) || place(a) - place(b) || a.host.localeCompare(b.host))[0];
    return best ? { cert: best.cert, key: best.key, until: best.notAfter } : { cert: serverCertPem, key: serverKeyPem, until: Infinity };
}

function refreshDefault(): void {
    const next = defaultPair();
    if (defaultServed && defaultServed.cert === next.cert && defaultServed.key === next.key) return;
    defaultServed = next;
    for (const server of listeners) {
        try {
            server.setSecureContext({ cert: next.cert, key: next.key });
        } catch (err) {
            console.error('❌ TLS: could not change the certificate for connections with no name:', (err as Error).message);
        }
    }
}

let selfSigned: { cert: string; context: tls.SecureContext } | null = null;
/** The self-signed pair as a context, for a name this server holds no CA certificate for. */
function selfSignedContext(): tls.SecureContext | undefined {
    if (!serverCertPem) return undefined;
    if (selfSigned?.cert !== serverCertPem) {
        try {
            selfSigned = { cert: serverCertPem, context: tls.createSecureContext({ cert: serverCertPem, key: serverKeyPem }) };
        } catch {
            return undefined;
        }
    }
    return selfSigned.context;
}

/** The certificate options for https.createServer: the pair for a connection with no SNI, and the SNI choice. */
export function httpsCertOptions(): Pick<tls.TlsOptions, 'cert' | 'key' | 'SNICallback'> {
    const pair = defaultPair();
    defaultServed = pair;
    return {
        cert: pair.cert,
        key: pair.key,
        SNICallback: (servername, cb) => {
            const name = hostKey(servername);
            const s = served.get(name);
            if (s && s.notAfter > clock()) return cb(null, s.context);
            // An IP address sent as SNI (RFC 6066 forbids it; some clients do) is a connection with no name. Any other
            // name gets the self-signed pair (beanpool.local), as on a LAN node.
            cb(null, net.isIP(name) ? undefined : selfSignedContext());
        },
    };
}

/** An HTTPS listener made with httpsCertOptions(), to be told when the pair for a connection with no SNI changes. */
export function attachTlsListener(server: tls.Server): void {
    listeners.add(server);
    // A default certificate that has expired since it was chosen is swapped before the next connection gets it: this runs
    // ahead of Node's own 'connection' listener, which wraps the socket in TLS with the listener's context. Nothing else
    // has to come first (a standby's ticks never reach setPreferredOrder), so an expired certificate is never served.
    server.prependListener('connection', () => {
        if (defaultServed && defaultServed.until <= clock()) refreshDefault();
    });
    server.once('close', () => listeners.delete(server));
}

/**
 * Initialize TLS certificates from disk only: the self-signed pair (made when there is none), and every ACME pair under
 * data/tls/acme/ that loads, names its identifier and has not expired. Never orders anything: the first orders run after
 * both listeners are up (services/acme/schedule.ts).
 */
export async function initTls(): Promise<void> {
    fs.mkdirSync(TLS_DIR, { recursive: true });
    generateSelfSigned();

    served.clear();
    fleetChecked = false;
    adoptLegacyFleetCertificate();
    const now = clock();
    for (const host of storedHosts(DATA_DIR)) {
        const pair = readPair(DATA_DIR, host);
        if (!pair) continue;
        const problem = serveCertificate(host, pair, now);
        if (problem) console.log(`⚠️  TLS: the certificate on disk for ${host} is not served (${problem}); it is ordered again`);
    }
    defaultServed = null;
    refreshDefault();

    if (served.size) console.log(`🔒 TLS: certificates for ${[...served.keys()].join(', ')}; self-signed (beanpool.local) for any other name`);
    else console.log('🔒 TLS: Self-signed (beanpool.local)');
}

/**
 * The fleet's pair from before each identifier had a folder (tls/le-*.pem), copied into data/tls/acme/<CF_RECORD_NAME>/
 * when that has none, or an older one (an older image ran here after a rollback and renewed le-cert.pem).
 *
 * The old files are kept for one release: v1.2.29 and older read only them, and without them order from Let's Encrypt
 * inside initTls, before the listeners are up, using one of the 5 certificates a week for the name. The release after
 * the first one that ships this copy (v1.2.31, if it is v1.2.30) may delete them, and this function with them; the boot
 * sweep keeps le-key.pem 0600 until then (boot-file-safety.ts).
 */
function adoptLegacyFleetCertificate(): void {
    const fleet = fleetIdentifier();
    if (!fleet) return;
    try {
        const cert = readOrError(LE_CERT_PATH);
        const key = readOrError(LE_KEY_PATH);
        if (cert instanceof Error || key instanceof Error) return;
        if (serverPairProblem(cert, key) || !certCovers(cert, fleet)) return;
        const held = readPair(DATA_DIR, fleet);
        if (held && (certTimes(held.cert)?.notAfter ?? 0) >= (certTimes(cert)?.notAfter ?? 0)) return;
        writePair(DATA_DIR, fleet, { cert, key });
        console.log(`🔐 TLS: the Let's Encrypt certificate for ${fleet} copied to data/tls/acme/ (tls/le-*.pem kept for a rollback)`);
    } catch (err) {
        console.error(`❌ TLS: could not copy the Let's Encrypt certificate for ${fleet}:`, (err as Error).message);
    }
}

// --- Self-Signed Certs (LAN / Fallback) ---

/*
 * selfsigned 2.x (node-forge) makes a certificate OpenSSL 3 cannot parse 1 time in 65,536: its random 9-byte serial
 * can start 00 00 with a third byte below 0x80, and node-forge then writes a non-minimal INTEGER ("asn1 illegal
 * padding"), which failed a fresh boot on CI on 15 Oct. A set of two certificates is bad 1 time in 32,768.
 */

/** Why OpenSSL refuses this CA certificate (the one /trust hands out); null when it parses. */
export function caCertProblem(caCert: string): string | null {
    try {
        new crypto.X509Certificate(caCert);
        return null;
    } catch (err) {
        return (err as Error).message || String(err);
    }
}

/** Why OpenSSL refuses this server certificate and key as the pair https.createServer loads (the same
 *  tls.createSecureContext call); null when they are good. */
export function serverPairProblem(serverCert: string, serverKey: string): string | null {
    try {
        tls.createSecureContext({ cert: serverCert, key: serverKey });
        return null;
    } catch (err) {
        return (err as Error).message || String(err);
    }
}

let generate: typeof selfsigned.generate = selfsigned.generate;
/** Tests only: make the certificates with this instead of selfsigned.generate (null puts it back). */
export function _setSelfSignedGenerateForTests(fn: typeof selfsigned.generate | null): void { generate = fn ?? selfsigned.generate; }

/** Fresh tries before a boot gives up: a bad certificate is 1 in 65,536, so a second try all but always does. */
const SELF_SIGNED_TRIES = 5;

/** A file's text, or why it cannot be read. */
function readOrError(file: string): string | Error {
    try {
        return fs.readFileSync(file, 'utf-8');
    } catch (err) {
        return err as Error;
    }
}

function generateSelfSigned(): void {
    // Certificates already on disk are used when OpenSSL takes them. A half it refuses (a bad serial written by an
    // older version, a certificate and key from two different runs, a missing file) is made again rather than
    // failing every boot after this one. The CA and the server pair are checked apart (#2031 N1): the server pair is
    // what a browser exception or NODE_EXTRA_CA_CERTS trusts on a LAN node, so a bad CA alone is remade alone.
    const ca = readOrError(CA_CERT_PATH);
    const cert = readOrError(SERVER_CERT_PATH);
    const key = readOrError(SERVER_KEY_PATH);
    const missing = (r: string | Error) => r instanceof Error && (r as NodeJS.ErrnoException).code === 'ENOENT';
    if (!(missing(ca) && missing(cert) && missing(key))) {
        const caProblem = ca instanceof Error ? ca.message : caCertProblem(ca);
        const pairProblem = cert instanceof Error ? cert.message : key instanceof Error ? key.message : serverPairProblem(cert, key);
        if (!pairProblem && !caProblem) {
            caCertPem = ca as string;
            serverCertPem = cert as string;
            serverKeyPem = key as string;
            console.log('🔐 Self-signed certificates loaded from disk');
            return;
        }
        if (!pairProblem) {
            console.log(`⚠️  The self-signed CA on disk cannot be used (${caProblem}) — making a new CA, keeping the server certificate`);
            const made = madeUntilGood(makeCa, (m) => caCertProblem(m.caCert));
            caCertPem = made.caCert;
            serverCertPem = cert as string;
            serverKeyPem = key as string;
            writeFileAtomic(CA_CERT_PATH, caCertPem);
            writeFileAtomic(CA_KEY_PATH, made.caKey, { mode: 0o600 });
            console.log('🔐 CA certificate generated and saved to data/tls/');
            return;
        }
        // A new server pair would be signed by the CA kept here if selfsigned 2.4.1 could sign with one; it cannot
        // (every certificate it makes is its own issuer), so the four are made again together, as on a first boot.
        console.log(`⚠️  The self-signed server certificate on disk cannot be used (${pairProblem}) — making new certificates`);
    }

    console.log('🔐 Generating local CA + server certificates...');
    const made = madeUntilGood(
        () => ({ ...makeCa(), ...makeServerPair() }),
        (m) => caCertProblem(m.caCert) ?? serverPairProblem(m.serverCert, m.serverKey),
    );
    caCertPem = made.caCert;
    serverCertPem = made.serverCert;
    serverKeyPem = made.serverKey;
    // Persist
    writeFileAtomic(CA_CERT_PATH, caCertPem);
    writeFileAtomic(CA_KEY_PATH, made.caKey, { mode: 0o600 });
    writeFileAtomic(SERVER_CERT_PATH, serverCertPem);
    writeFileAtomic(SERVER_KEY_PATH, serverKeyPem, { mode: 0o600 });
    console.log('🔐 Certificates generated and saved to data/tls/');
}

/** make() until OpenSSL takes what it made (problem() is null), at most SELF_SIGNED_TRIES times. */
function madeUntilGood<T>(make: () => T, problem: (made: T) => string | null): T {
    let lastProblem = '';
    for (let attempt = 1; attempt <= SELF_SIGNED_TRIES; attempt++) {
        const made = make();
        const why = problem(made);
        if (!why) return made;
        lastProblem = why;
        console.log(`⚠️  A new self-signed certificate did not parse (${why}) — making another (try ${attempt} of ${SELF_SIGNED_TRIES})`);
    }
    throw new Error(`TLS: ${SELF_SIGNED_TRIES} self-signed certificates in a row did not parse: ${lastProblem}`);
}

function makeCa(): { caCert: string; caKey: string } {
    // Generate the Root CA
    const caAttrs = [{ name: 'commonName', value: 'BeanPool Local CA' }];
    const caResult = generate(caAttrs, {
        keySize: 2048,
        days: 3650,
        algorithm: 'sha256',
        extensions: [
            { name: 'basicConstraints', cA: true, critical: true },
            {
                name: 'keyUsage',
                keyCertSign: true,
                cRLSign: true,
                critical: true,
            },
        ],
    });
    return { caCert: caResult.cert, caKey: caResult.private };
}

function makeServerPair(): { serverCert: string; serverKey: string } {
    // Generate the server certificate
    const serverAttrs = [{ name: 'commonName', value: 'beanpool.local' }];
    const serverResult = generate(serverAttrs, {
        keySize: 2048,
        days: 825,
        algorithm: 'sha256',
        extensions: [
            {
                name: 'subjectAltName',
                altNames: [
                    { type: 2, value: 'beanpool.local' },
                    { type: 2, value: '*.beanpool.local' },
                    { type: 7, ip: '127.0.0.1' },
                ],
            },
        ],
    });
    return { serverCert: serverResult.cert, serverKey: serverResult.private };
}

