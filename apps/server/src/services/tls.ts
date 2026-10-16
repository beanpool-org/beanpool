/**
 * TLS — Dual-Mode Certificate Management
 *
 * Public nodes (CF_RECORD_NAME set):
 *   → Auto-obtain Let's Encrypt certs via DNS-01 + Cloudflare API
 *   → Auto-renew when within 30 days of expiry
 *   → PWA "just works" in any browser, no warnings
 *
 * LAN nodes (no CF_RECORD_NAME):
 *   → Generate self-signed Root CA + server cert for beanpool.local
 *   → Users install CA via Trust Bootstrap page
 *
 * Offline fallback:
 *   → If LE cert expires and can't renew, fall back to self-signed
 *   → Trust Bootstrap page re-activates automatically
 */

import fs from 'node:fs';
import { writeFileAtomic } from '../write-file-atomic.js';
import path from 'node:path';
import crypto from 'node:crypto';
import tls from 'node:tls';
import * as acme from 'acme-client';
import selfsigned from 'selfsigned';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const TLS_DIR = path.join(DATA_DIR, 'tls');
const CA_CERT_PATH = path.join(TLS_DIR, 'ca.pem');
const CA_KEY_PATH = path.join(TLS_DIR, 'ca-key.pem');
const SERVER_CERT_PATH = path.join(TLS_DIR, 'server.pem');
const SERVER_KEY_PATH = path.join(TLS_DIR, 'server-key.pem');
const LE_CERT_PATH = path.join(TLS_DIR, 'le-cert.pem');
const LE_KEY_PATH = path.join(TLS_DIR, 'le-key.pem');
const LE_ACCOUNT_PATH = path.join(TLS_DIR, 'acme-account.json');

// Cloudflare config — if CF_RECORD_NAME exists, we're a public node
const CF_API_TOKEN = process.env.CF_API_TOKEN ?? '';
const CF_ZONE_ID = process.env.CF_ZONE_ID ?? '';
const CF_RECORD_NAME = process.env.CF_RECORD_NAME ?? '';

let caCertPem: string = '';
let serverCertPem: string = '';
let serverKeyPem: string = '';
let usingLetsEncrypt = false;

// --- Exports ---

export function getCaCertPem(): string { return caCertPem; }
export function getServerCertPem(): string { return serverCertPem; }
export function getServerKeyPem(): string { return serverKeyPem; }
export function isUsingLetsEncrypt(): boolean { return usingLetsEncrypt; }
/** A public node (it asks Let's Encrypt) that is serving its self-signed certificate: what services/alerts.ts tells the owners. */
export function tlsFellBackToSelfSigned(): boolean { return !!(CF_RECORD_NAME && CF_API_TOKEN && CF_ZONE_ID) && !usingLetsEncrypt && !!serverCertPem; }

/**
 * Initialize TLS certificates. Tries Let's Encrypt for public nodes,
 * falls back to self-signed for LAN or on failure.
 */
export async function initTls(): Promise<void> {
    fs.mkdirSync(TLS_DIR, { recursive: true });

    const isPublicNode = CF_RECORD_NAME && CF_API_TOKEN && CF_ZONE_ID;

    if (isPublicNode) {
        const success = await tryLetsEncrypt();
        if (success) {
            usingLetsEncrypt = true;
            console.log(`🔒 TLS: Let's Encrypt (${CF_RECORD_NAME})`);
            return;
        }
        console.log('⚠️  Let\'s Encrypt failed — falling back to self-signed');
    }

    generateSelfSigned();
    usingLetsEncrypt = false;
    console.log('🔒 TLS: Self-signed (beanpool.local)');
}

/**
 * Schedule automatic renewal check every 2 hours.
 * Short interval ensures LE certs are picked up quickly after rate limits clear.
 */
export function startRenewalScheduler(): void {
    if (!CF_RECORD_NAME || !CF_API_TOKEN || !CF_ZONE_ID) return;

    const TWO_HOURS = 2 * 60 * 60 * 1000;

    setInterval(async () => {
        try {
            console.log('🔄 Checking certificate renewal...');
            const success = await tryLetsEncrypt();
            if (success && !usingLetsEncrypt) {
                console.log('🔒 Upgraded from self-signed to Let\'s Encrypt');
                usingLetsEncrypt = true;
            } else if (!success && usingLetsEncrypt) {
                // LE cert expired and can't renew — fall back
                if (isCertExpired(LE_CERT_PATH)) {
                    console.log('⚠️  LE cert expired, can\'t renew — falling back to self-signed');
                    generateSelfSigned();
                    usingLetsEncrypt = false;
                }
            }
        } catch (err) {
            console.error('❌ Error during TLS certificate renewal check:', (err as Error).message);
        }
    }, TWO_HOURS);

    console.log('🔄 Certificate renewal scheduler started (2h interval)');
}

// --- Let's Encrypt ---

async function tryLetsEncrypt(): Promise<boolean> {
    try {
        // If valid LE cert exists and not expiring soon, just load it
        if (fs.existsSync(LE_CERT_PATH) && fs.existsSync(LE_KEY_PATH)) {
            if (!isCertExpiringSoon(LE_CERT_PATH, 30)) {
                serverCertPem = fs.readFileSync(LE_CERT_PATH, 'utf-8');
                serverKeyPem = fs.readFileSync(LE_KEY_PATH, 'utf-8');
                return true;
            }
            console.log('🔄 LE cert expiring soon, renewing...');
        }

        // Request new cert from Let's Encrypt
        return await requestLetsEncryptCert();
    } catch (err) {
        console.error('❌ Let\'s Encrypt error:', (err as Error).message);
        return false;
    }
}

async function requestLetsEncryptCert(): Promise<boolean> {
    console.log(`🔐 Requesting Let's Encrypt cert for ${CF_RECORD_NAME}...`);

    // Wrap the entire ACME flow in a 90-second timeout.
    // acme-client internally waits on HTTP retry-after headers which
    // can't be cancelled via Promise.race, so we use a hard timer.
    const ACME_TIMEOUT_MS = 90 * 1000; // 90 seconds

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        console.log('⚠️  ACME cert request timed out after 90s — will fall back to self-signed');
    }, ACME_TIMEOUT_MS);

    const certPromise = (async () => {
        // Create or load ACME account key
        let accountKey: string;
        if (fs.existsSync(LE_ACCOUNT_PATH)) {
            const saved = JSON.parse(fs.readFileSync(LE_ACCOUNT_PATH, 'utf-8'));
            accountKey = saved.key;
            console.log('   Loaded existing ACME account key');
        } else {
            console.log('   Generating new ACME account key...');
            const { privateKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
            accountKey = privateKey;
            writeFileAtomic(LE_ACCOUNT_PATH, JSON.stringify({ key: accountKey }), { mode: 0o600 });
            console.log('   ACME account key generated');
        }

        // Generate server key using Node.js native crypto
        console.log('   Generating server key...');
        const { privateKey: serverKeyPemStr } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        console.log('   Server key generated');

        // Generate CSR using the ACME library but with our pre-generated key
        console.log('   Generating CSR...');
        const [, csr] = await acme.crypto.createCsr({
            commonName: CF_RECORD_NAME,
        }, serverKeyPemStr);
        console.log('   CSR generated');

        // Create ACME client
        console.log('   Creating ACME client (production)...');
        const client = new acme.Client({
            directoryUrl: acme.directory.letsencrypt.production,
            accountKey,
        });

        // Step 1: Create account
        console.log('   Step 1: Creating ACME account...');
        await client.createAccount({
            termsOfServiceAgreed: true,
        });
        console.log('   Step 1: Account created/verified');

        // Step 2: Create order
        console.log('   Step 2: Creating order...');
        const order = await client.createOrder({
            identifiers: [{ type: 'dns', value: CF_RECORD_NAME }],
        });
        console.log('   Step 2: Order created');

        // Step 3: Get authorizations
        console.log('   Step 3: Getting authorizations...');
        const authorizations = await client.getAuthorizations(order);
        console.log(`   Step 3: Got ${authorizations.length} authorization(s)`);

        // Step 4: Complete challenges
        const createdRecords: string[] = [];
        for (const authz of authorizations) {
            const challenge = authz.challenges.find((c: { type: string }) => c.type === 'dns-01');
            if (!challenge) throw new Error('No dns-01 challenge found');

            const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
            const recordName = `_acme-challenge.${CF_RECORD_NAME}`;

            console.log(`   Step 4: Creating DNS TXT record: ${recordName}`);
            const recordId = await cfCreateTxtRecord(recordName, keyAuthorization);
            createdRecords.push(recordId);
            console.log(`   Step 4: DNS record created (ID: ${recordId})`);

            console.log('   Step 4: Waiting 30s for DNS propagation...');
            await sleep(30000);
            console.log('   Step 4: Propagation wait done. Completing challenge...');

            await client.completeChallenge(challenge);
            console.log('   Step 4: Challenge completed, waiting for validation...');

            await client.waitForValidStatus(challenge);
            console.log('   Step 4: Challenge validated!');
        }

        // Step 5: Finalize order
        console.log('   Step 5: Finalizing order...');
        const finalized = await client.finalizeOrder(order, csr);
        console.log('   Step 5: Order finalized');

        // Step 6: Get certificate
        console.log('   Step 6: Getting certificate...');
        const cert = await client.getCertificate(finalized);
        console.log('   Step 6: Certificate obtained!');

        // Cleanup DNS records
        console.log(`   Cleaning up ${createdRecords.length} DNS record(s)...`);
        for (const recordId of createdRecords) {
            await cfDeleteTxtRecord(recordId);
        }

        if (!cert) {
            throw new Error('Failed to obtain certificate');
        }

        // Save cert + key
        serverCertPem = cert;
        serverKeyPem = serverKeyPemStr;
        writeFileAtomic(LE_CERT_PATH, serverCertPem);
        writeFileAtomic(LE_KEY_PATH, serverKeyPem, { mode: 0o600 });

        console.log(`✅ Let's Encrypt cert obtained for ${CF_RECORD_NAME}`);
        return true;
    })();

    let checkInterval: ReturnType<typeof setInterval> | null = null;
    try {
        // Race the cert request against the timeout
        return await Promise.race([
            certPromise,
            new Promise<false>((resolve) => {
                checkInterval = setInterval(() => {
                    if (timedOut) {
                        resolve(false);
                    }
                }, 500);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        if (checkInterval) clearInterval(checkInterval);
    }
}

// --- Cloudflare DNS API ---

async function cfCreateTxtRecord(name: string, value: string): Promise<string> {
    try {
        const res = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${CF_API_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    type: 'TXT',
                    name,
                    content: value,
                    ttl: 120,
                }),
            }
        );

        if (!res.ok) {
            throw new Error(`HTTP error ${res.status}`);
        }

        const data = await res.json() as { success: boolean; result: { id: string }; errors: unknown[] };
        if (!data?.success || !data?.result?.id) {
            throw new Error(`Cloudflare DNS create failed: ${JSON.stringify(data?.errors || data)}`);
        }

        return data.result.id;
    } catch (e: any) {
        throw new Error(`Failed to create TXT record: ${e.message}`);
    }
}

async function cfDeleteTxtRecord(recordId: string): Promise<void> {
    try {
        await fetch(
            `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${recordId}`,
            {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
            }
        );
    } catch {
        // Non-critical — cleanup failure is OK
    }
}

// --- Self-Signed Certs (LAN / Fallback) ---

/**
 * Why OpenSSL refuses this CA certificate, or this server certificate and key as the pair https.createServer loads
 * (the same tls.createSecureContext call); null when they are good. selfsigned 2.x (node-forge) makes a certificate
 * OpenSSL 3 cannot parse about once in 10,000: its random 9-byte serial can start 00 00 and node-forge then writes a
 * non-minimal INTEGER ("asn1 illegal padding"), which failed a fresh boot on CI on 15 Oct.
 */
export function selfSignedProblem(caCert: string, serverCert: string, serverKey: string): string | null {
    try {
        new crypto.X509Certificate(caCert);
        tls.createSecureContext({ cert: serverCert, key: serverKey });
        return null;
    } catch (err) {
        return (err as Error).message || String(err);
    }
}

let generate: typeof selfsigned.generate = selfsigned.generate;
/** Tests only: make the certificates with this instead of selfsigned.generate (null puts it back). */
export function _setSelfSignedGenerateForTests(fn: typeof selfsigned.generate | null): void { generate = fn ?? selfsigned.generate; }

/** Fresh tries before a boot gives up: a bad set is about one in 10,000, so a second try all but always does. */
const SELF_SIGNED_TRIES = 5;

function generateSelfSigned(): void {
    // Certificates already on disk are used when OpenSSL takes them. A set it refuses (a bad serial written by an
    // older version, a certificate and key from two different runs, a missing file) is made again rather than
    // failing every boot after this one.
    if (fs.existsSync(CA_CERT_PATH) && fs.existsSync(SERVER_CERT_PATH)) {
        let problem: string | null;
        try {
            const ca = fs.readFileSync(CA_CERT_PATH, 'utf-8');
            const cert = fs.readFileSync(SERVER_CERT_PATH, 'utf-8');
            const key = fs.readFileSync(SERVER_KEY_PATH, 'utf-8');
            problem = selfSignedProblem(ca, cert, key);
            if (!problem) {
                caCertPem = ca;
                serverCertPem = cert;
                serverKeyPem = key;
                console.log('🔐 Self-signed certificates loaded from disk');
                return;
            }
        } catch (err) {
            problem = (err as Error).message;
        }
        console.log(`⚠️  Self-signed certificates on disk cannot be used (${problem}) — making new ones`);
    }

    console.log('🔐 Generating local CA + server certificates...');

    let lastProblem = '';
    for (let attempt = 1; attempt <= SELF_SIGNED_TRIES; attempt++) {
        const made = makeSelfSignedSet();
        const problem = selfSignedProblem(made.caCert, made.serverCert, made.serverKey);
        if (!problem) {
            caCertPem = made.caCert;
            serverCertPem = made.serverCert;
            serverKeyPem = made.serverKey;
            // Persist
            writeFileAtomic(CA_CERT_PATH, caCertPem);
            writeFileAtomic(CA_KEY_PATH, made.caKey, { mode: 0o600 });
            writeFileAtomic(SERVER_CERT_PATH, serverCertPem);
            writeFileAtomic(SERVER_KEY_PATH, serverKeyPem, { mode: 0o600 });
            console.log('🔐 Certificates generated and saved to data/tls/');
            return;
        }
        lastProblem = problem;
        console.log(`⚠️  A new self-signed certificate did not parse (${problem}) — making another (try ${attempt} of ${SELF_SIGNED_TRIES})`);
    }
    throw new Error(`TLS: ${SELF_SIGNED_TRIES} self-signed certificates in a row did not parse: ${lastProblem}`);
}

function makeSelfSignedSet(): { caCert: string; caKey: string; serverCert: string; serverKey: string } {
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

    return { caCert: caResult.cert, caKey: caResult.private, serverCert: serverResult.cert, serverKey: serverResult.private };
}

// --- Cert Helpers ---

function isCertExpiringSoon(certPath: string, daysThreshold: number): boolean {
    try {
        const pem = fs.readFileSync(certPath, 'utf-8');
        return isCertExpired(certPath) || getDaysUntilExpiry(pem) < daysThreshold;
    } catch {
        return true;
    }
}

function isCertExpired(certPath: string): boolean {
    try {
        const pem = fs.readFileSync(certPath, 'utf-8');
        return getDaysUntilExpiry(pem) <= 0;
    } catch {
        return true;
    }
}

function getDaysUntilExpiry(pem: string): number {
    // Parse the Not After date from the PEM certificate
    const cert = new crypto.X509Certificate(pem);
    const notAfter = new Date(cert.validTo);
    const now = new Date();
    return Math.floor((notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
