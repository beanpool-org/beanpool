/**
 * What Settings → Public Address shows about this server's certificates (GET /api/local/admin/tls/status, owner-only;
 * design scratch/global-node/DESIGN-https-anywhere-fable.md §4, S4): for each identifier the scheduler looks at
 * (schedule.ts acmeTargets), the certificate served for it (issued, expires), when it is renewed or tried next, and what
 * went wrong last, in the scheduler's words (state.json). Built field by field from what is served and the store's state:
 * never a key, a certificate's PEM or the ACME account.
 */

import { getNodeRole } from '../../config/node-role.js';
import { configuredAddresses, ownerConfirmedAddresses, primaryAddress, type AddressSource } from '../../engine/own-addresses.js';
import { givenAgainOnlyRetries } from '../public-address-agent.js';
import { servedCertificate, tlsDataDir } from '../tls.js';
import { acmeDirectoryUrl, acmeTargets, caName, RENEW_WHEN_LEFT } from './schedule.js';
import { readState } from './store.js';

export interface IdentifierStatus {
    /** The host as signatures carry it. */
    identifier: string;
    kind: 'ip' | 'name';
    /** http-01 on this server's own port 80; dns-01 through Cloudflare for the fleet's CF_RECORD_NAME. */
    challenge: 'http-01' | 'dns-01';
    /** Where it is configured (engine/own-addresses.ts), or `fleet`: CF_RECORD_NAME, certified through Cloudflare. */
    source: AddressSource | 'fleet';
    /** In the owner-confirmed list (Settings, `beanpool claim --ip/--address`): an owner can remove it in Settings. */
    ownerAdded: boolean;
    /**
     * Given again, it is only asked for again, past the back-off, and the community's address stays where it is
     * (public-address-agent.ts givenAgainOnlyRetries): Settings offers "Try again now" only then. False for one that would
     * become the community's address, and for one no owner added.
     */
    retryOnly: boolean;
    /** Where /api/community/info sends newcomers (primaryAddress). */
    communityAddress: boolean;
    /** The certificate served for it now, or null for none. */
    certificate: { issuedAt: string; expiresAt: string } | null;
    /**
     * When the server next asks for one: the served certificate's renewal (a third of its life left), or the next try
     * after a failure. Null: at the next hourly check, or at once when the address was just given.
     */
    nextRenewalAt: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    /** Attempts that failed in a row. */
    failures: number;
    /** What went wrong last, in the scheduler's words, or null. */
    lastError: string | null;
}

export interface TlsStatus {
    /** The ACME CA as the owner reads it: "Let's Encrypt", else "the CA". */
    ca: string;
    /** ACME_DIRECTORY_URL is a CA's test (staging) directory: no phone or browser trusts what it issues. */
    testCa: boolean;
    /** Whether this server asks for certificates: a standby never does (D8). */
    orders: boolean;
    identifiers: IdentifierStatus[];
}

const iso = (ms: number): string | null => (ms > 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

function isTestDirectory(url: string): boolean {
    try { return /staging/.test(new URL(url).hostname); } catch { return false; }
}

export function tlsStatus(now = Date.now()): TlsStatus {
    const directoryUrl = acmeDirectoryUrl();
    const dataDir = tlsDataDir();
    const sources = new Map(configuredAddresses().map((a) => [a.address, a.source]));
    const owned = new Set(ownerConfirmedAddresses());
    const primary = primaryAddress();
    const identifiers = acmeTargets().map((target): IdentifierStatus => {
        const state = readState(dataDir, target.host);
        const served = servedCertificate(target.host);
        const held = served && served.notAfter > now ? served : null;
        // As the scheduler reads them (schedule.ts considerTarget): a certificate from another directory is due now, and a
        // wait set at another directory does not hold here.
        const sameDirectory = state.directoryUrl === null || state.directoryUrl === directoryUrl;
        const sameAttempts = state.attemptDirectoryUrl === null || state.attemptDirectoryUrl === directoryUrl;
        const renewAt = held && sameDirectory ? held.notAfter - (held.notAfter - held.notBefore) * RENEW_WHEN_LEFT : 0;
        const nextTry = sameAttempts && state.nextAttemptAt > now ? state.nextAttemptAt : 0;
        return {
            identifier: target.host,
            kind: target.type === 'ip' ? 'ip' : 'name',
            challenge: target.challenge,
            source: sources.get(target.host) ?? 'fleet',
            ownerAdded: owned.has(target.host),
            retryOnly: owned.has(target.host) && givenAgainOnlyRetries(target.host),
            communityAddress: primary === target.host,
            certificate: held ? { issuedAt: new Date(held.notBefore).toISOString(), expiresAt: new Date(held.notAfter).toISOString() } : null,
            nextRenewalAt: iso(renewAt > now ? renewAt : nextTry),
            lastAttemptAt: iso(state.lastAttemptAt),
            lastSuccessAt: iso(state.lastSuccessAt),
            failures: sameAttempts ? state.failures : 0,
            lastError: sameAttempts ? state.lastError : null,
        };
    });
    return { ca: caName(directoryUrl), testCa: isTestDirectory(directoryUrl), orders: getNodeRole() === 'primary', identifiers };
}
