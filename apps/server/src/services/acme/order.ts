/**
 * One ACME order for one identifier (design scratch/global-node/DESIGN-https-anywhere-fable.md §1, §2, D7): a fresh
 * RSA-2048 key (the chain to ISRG Root X1, which Android 8 trusts), a CSR naming the identifier alone, and one challenge:
 *
 *   - http-01 for every identifier but one: answered on this server's own port 80 (challenge.ts). A self-check fetches it
 *     from outside BEFORE the CA is asked anything, with a token of this server's own, and again with the CA's token
 *     before the challenge is submitted: an identifier that does not reach this server submits nothing.
 *   - dns-01 through the Cloudflare API only for CF_RECORD_NAME with CF_API_TOKEN and CF_ZONE_ID set: our own fleet's
 *     names, as before.
 *
 * An IP identifier is ordered as `type: 'ip'` on Let's Encrypt's `shortlived` profile, the only one that issues for IP
 * addresses (about 160 hours). The order body passes through acme-client untouched; its OrderCreateRequest type lacks
 * the `profile` field, hence the cast.
 *
 * Nothing is written here: the caller puts the pair on disk and serves it (schedule.ts). The account key and the
 * certificate key are never logged.
 */

import crypto from 'node:crypto';
import * as acme from 'acme-client';
import { putChallenge, removeChallenge, selfCheckChallenge, type ChallengeTarget } from './challenge.js';
import { certCovers, type CertPair } from './store.js';
import { serverPairProblem } from '../tls.js';

export const LETS_ENCRYPT_PRODUCTION = acme.directory.letsencrypt.production;
/** The profile Let's Encrypt issues IP-address certificates on (letsencrypt.org/docs/profiles, 2026). */
export const IP_CERT_PROFILE = 'shortlived';

export interface AcmeTarget extends ChallengeTarget {
    /** The identifier as the CA is sent it: a name, or an IP address without brackets. */
    value: string;
    challenge: 'http-01' | 'dns-01';
}

/** A self-check that failed: nothing was sent to the CA. */
export class SelfCheckFailed extends Error {}

export interface OrderOptions {
    directoryUrl: string;
    accountKey: string;
    log?: (line: string) => void;
}

function rsaKey(): string {
    return crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }).privateKey;
}

async function selfCheck(target: AcmeTarget, token: string, keyAuthorization: string): Promise<void> {
    putChallenge(token, keyAuthorization);
    try {
        const problem = await selfCheckChallenge(target, token, keyAuthorization);
        if (problem) throw new SelfCheckFailed(problem);
    } catch (err) {
        removeChallenge(token);
        throw err;
    }
}

/** Order a certificate for `target`; resolves with the pair, or throws with what went wrong. */
export async function orderCertificate(target: AcmeTarget, opts: OrderOptions): Promise<CertPair> {
    const log = opts.log ?? (() => {});
    if (target.challenge === 'http-01') {
        // Before the first request to the CA: does this identifier reach this server's port 80 at all?
        const probe = crypto.randomBytes(24).toString('base64url');
        await selfCheck(target, probe, crypto.randomBytes(24).toString('base64url'));
        removeChallenge(probe);
    }

    const key = rsaKey();
    const [, csr] = await acme.crypto.createCsr(
        target.type === 'ip' ? { altNames: [target.value] } : { commonName: target.value, altNames: [target.value] },
        key,
    );
    const client = new acme.Client({ directoryUrl: opts.directoryUrl, accountKey: opts.accountKey });
    await client.createAccount({ termsOfServiceAgreed: true });
    const order = await client.createOrder({
        identifiers: [{ type: target.type, value: target.value }],
        ...(target.type === 'ip' ? { profile: IP_CERT_PROFILE } : {}),
    } as Parameters<typeof client.createOrder>[0]);
    log(`order created for ${target.host} (${target.challenge}${target.type === 'ip' ? `, ${IP_CERT_PROFILE}` : ''})`);

    for (const authz of await client.getAuthorizations(order)) {
        if (authz.status === 'valid') continue;
        const challenge = authz.challenges.find((c) => c.type === target.challenge);
        if (!challenge) throw new Error(`the CA offered no ${target.challenge} challenge for ${target.host}`);
        const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
        if (target.challenge === 'http-01') {
            await selfCheck(target, challenge.token, keyAuthorization);
            try {
                await client.completeChallenge(challenge);
                await client.waitForValidStatus(challenge);
            } finally {
                removeChallenge(challenge.token);
            }
        } else {
            const recordId = await cfCreateTxtRecord(`_acme-challenge.${target.value}`, keyAuthorization);
            try {
                log('waiting 30 s for the DNS record to spread');
                await new Promise((resolve) => setTimeout(resolve, 30_000));
                await client.completeChallenge(challenge);
                await client.waitForValidStatus(challenge);
            } finally {
                await cfDeleteTxtRecord(recordId);
            }
        }
    }

    const finalized = await client.finalizeOrder(order, csr);
    const cert = await client.getCertificate(finalized);
    if (!cert) throw new Error(`the CA sent no certificate for ${target.host}`);
    if (!certCovers(cert, target.host)) throw new Error(`the certificate the CA sent does not name ${target.host}`);
    const problem = serverPairProblem(cert, key);
    if (problem) throw new Error(`the certificate the CA sent does not load: ${problem}`);
    return { cert, key };
}

// --- Cloudflare DNS API (our fleet's CF_RECORD_NAME only) ---

async function cfCreateTxtRecord(name: string, value: string): Promise<string> {
    const zone = process.env.CF_ZONE_ID ?? '';
    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN ?? ''}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'TXT', name, content: value, ttl: 120 }),
        });
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        const data = await res.json() as { success: boolean; result: { id: string }; errors: unknown[] };
        if (!data?.success || !data?.result?.id) throw new Error(`Cloudflare DNS create failed: ${JSON.stringify(data?.errors || data)}`);
        return data.result.id;
    } catch (e: any) {
        throw new Error(`Failed to create TXT record: ${e.message}`);
    }
}

async function cfDeleteTxtRecord(recordId: string): Promise<void> {
    try {
        await fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID ?? ''}/dns_records/${recordId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN ?? ''}` },
        });
    } catch {
        // Non-critical: a leftover TXT record does no harm.
    }
}
