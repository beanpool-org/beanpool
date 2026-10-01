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
import { plainOriginOf, shouldBlockCleartextNodeUrl, UnsafeNodeAddressError } from './node-url';
import { loadSavedRequestSigning } from './nodes';
import { APP_VERSION_HEADER } from './force-update';

let installed = false;
/** `X-BeanPool-App`'s value on this phone (utils/force-update.ts appVersionHeaderValue), or null: sent with nothing. */
let appVersionHeader: string | null = null;

/**
 * Whether a request to `url` goes to this phone's community at `anchorUrl`: the same origin, scheme, host and port
 * (node-url.ts `plainOriginOf`). A string prefix said yes to `https://a.org.evil.example` and `https://a.organic.example`
 * for the community `https://a.org`, and those got the member's key and a signature (multi-community review F4). An
 * address that isn't plain but starts with the community's still counts, so that the signer refuses it as before: on iOS
 * it reaches another host than the one it names, so it fails rather than going out unsigned.
 */
export function isAnchorRequest(url: string, anchorUrl: string): boolean {
    const anchor = plainOriginOf(anchorUrl);
    if (!anchor) return false;
    const origin = plainOriginOf(url);
    return origin ? origin === anchor : url.startsWith(anchorUrl);
}

/** Read a header value from either a plain object or a Headers instance. */
function hasHeader(headers: any, name: string): boolean {
    if (!headers) return false;
    if (typeof headers.get === 'function') return !!headers.get(name);
    const lower = name.toLowerCase();
    return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

/**
 * The app's version on a request to its own community (`X-BeanPool-App: 1.2.57 android`), for the community's counts of
 * who runs what: an operator reads them before raising the floor (apps/server/src/app-version-counts.ts). Added to a
 * plain headers object only, never over one the caller set: a Headers instance or a Request carries its own, and adding
 * to those here would replace them.
 */
function withAppVersionHeader(input: any, init: any, value: string): any {
    if (typeof input !== 'string') return init;
    const headers = init?.headers;
    if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers) || typeof headers.get === 'function')) return init;
    if (hasHeader(headers, APP_VERSION_HEADER)) return init;
    return { ...(init || {}), headers: { ...(headers || {}), [APP_VERSION_HEADER]: value } };
}

/**
 * Wrap global.fetch once so GET requests to the anchor node carry a replay-proof
 * member signature, and every request to it the app's version when `appVersionHeader` is given (a phone build: see
 * utils/force-update.ts appVersionHeaderValue). Call once at app startup.
 */
export function installNodeRequestSigning(options: { appVersionHeader?: string | null } = {}): void {
    if (installed) return;
    installed = true;
    appVersionHeader = options.appVersionHeader ?? null;

    // Which format each saved community's server reads, as recorded on an earlier run (request binding). Signed
    // requests made before it has loaded wait for it.
    void loadSavedRequestSigning();

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

            if (url && (method === 'GET' || appVersionHeader)) {
                const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                const toAnchor = !!anchorUrl && isAnchorRequest(url, anchorUrl);
                if (toAnchor && appVersionHeader) init = withAppVersionHeader(input, init, appVersionHeader);
                // Only sign requests to our own node, and never double-sign.
                if (method === 'GET' && toAnchor && !hasHeader(init?.headers, 'X-Signature')) {
                    const identity = await loadIdentity();
                    if (identity?.privateKey && identity?.publicKey) {
                        // Signed over the URL fetched: its host (request binding) and its path, which is the
                        // server's ctx.path (no query string).
                        const signed = await buildSignedHeaders(
                            'GET', url, '', identity.privateKey, identity.publicKey,
                        );
                        init = { ...(init || {}), headers: { ...(init?.headers || {}), ...signed } };
                    }
                }
            }
        } catch (e) {
            // Re-throw the NAT-4 block; swallow signing errors (best-effort). But not a refused address (request
            // binding, node-url.ts): on iOS it reaches another host than it names, so it fails, never goes unsigned.
            if (e instanceof Error && e.message.includes('NAT-4')) throw e;
            if (e instanceof UnsafeNodeAddressError) throw e;
        }
        return originalFetch(input, init);
    };
}
