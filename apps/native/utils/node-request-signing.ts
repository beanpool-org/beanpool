/**
 * Forward-compatible read signing (SRV-2 / SRV-4).
 *
 * The node will (once `ENFORCE_READ_AUTH` is flipped on server-side) require a
 * signed, replay-proof request on gated GET endpoints — the same scheme already
 * used for writes (sign METHOD+PATH+TIMESTAMP+NONCE+BODY). Writes already sign
 * via `buildSignedHeaders`; reads do not, and they are scattered across ~11 files.
 *
 * Rather than touch every call site, we install ONE guarded wrapper around
 * `global.fetch` that signs GET requests aimed at the configured anchor node.
 * It is intentionally:
 *   - additive — a node that does not enforce read-auth simply ignores the extra
 *     headers, so behaviour is identical today and after the server flips the flag;
 *   - scoped — only GETs to the anchor URL, and only when an identity exists;
 *   - inert on failure — any error falls through to the original unsigned fetch.
 *
 * This makes the published app forward-compatible so read-auth can be enabled
 * server-side later without another app-store release.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildSignedHeaders } from './crypto';
import { loadIdentity } from './identity';
import { shouldBlockCleartextNodeUrl } from './node-url';

let installed = false;

/** Read a header value from either a plain object or a Headers instance. */
function hasHeader(headers: any, name: string): boolean {
    if (!headers) return false;
    if (typeof headers.get === 'function') return !!headers.get(name);
    const lower = name.toLowerCase();
    return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

/**
 * Wrap global.fetch once so GET requests to the anchor node carry a replay-proof
 * member signature. Call once at app startup.
 */
export function installNodeRequestSigning(): void {
    if (installed) return;
    installed = true;

    const originalFetch = global.fetch;

    global.fetch = async function signingFetch(input: any, init?: any): Promise<Response> {
        const url: string | undefined = typeof input === 'string' ? input : input?.url;

        // NAT-4: refuse cleartext (http/ws) traffic to a PUBLIC node — it would be
        // MITM-exposed. LAN/private hosts stay cleartext (sync still works). This is
        // NOT swallowed by the best-effort signing try/catch below: a blocked
        // request must fail, not silently proceed in plaintext.
        if (url && shouldBlockCleartextNodeUrl(url)) {
            throw new Error('Refusing cleartext (http/ws) request to a public host (NAT-4). Use https.');
        }

        try {
            const method: string = String(
                init?.method ?? (typeof input !== 'string' ? input?.method : undefined) ?? 'GET',
            ).toUpperCase();

            if (url && method === 'GET') {
                const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                // Only sign requests to our own node, and never double-sign.
                if (anchorUrl && url.startsWith(anchorUrl) && !hasHeader(init?.headers, 'X-Signature')) {
                    const identity = await loadIdentity();
                    if (identity?.privateKey && identity?.publicKey) {
                        // Server verifies the signature over ctx.path (no query string).
                        const path = url.slice(anchorUrl.length).split('?')[0] || '/';
                        const signed = await buildSignedHeaders(
                            'GET', path, '', identity.privateKey, identity.publicKey,
                        );
                        init = { ...(init || {}), headers: { ...(init?.headers || {}), ...signed } };
                    }
                }
            }
        } catch (e) {
            // Re-throw the NAT-4 block; swallow signing errors (best-effort).
            if (e instanceof Error && e.message.includes('NAT-4')) throw e;
        }
        return originalFetch(input, init);
    };
}
