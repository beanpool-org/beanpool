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
import { REQUEST_SIGNING_VERSION, signedPathOf } from '@beanpool/core';
import { buildSignedHeaders } from './crypto';
import { loadIdentity } from './identity';
import { plainOriginOf, shouldBlockCleartextNodeUrl, UnsafeNodeAddressError } from './node-url';
import { getSavedNodes, loadSavedRequestSigning } from './nodes';
import { APP_VERSION_HEADER } from './force-update';
import { fellBackToOldFormat, OLD_SERVER_SIGNATURE_REFUSAL, settledRequestSigning } from './request-signing-version';

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

/** A header's value from a plain headers object, any case; undefined from anything else. */
function plainHeader(headers: any, name: string): string | undefined {
    if (!headers || typeof headers !== 'object' || typeof headers.get === 'function') return undefined;
    const lower = name.toLowerCase();
    const key = Object.keys(headers).find(k => k.toLowerCase() === lower);
    return key === undefined ? undefined : String(headers[key]);
}

const SIGNING_HEADERS = new Set(['x-public-key', 'x-signature', 'x-timestamp', 'x-nonce', 'x-signed-for', 'content-type']);

/** Whether `url` goes to the community open on this phone (the anchor) or a saved one: the same origin. */
async function isSavedCommunity(url: string): Promise<boolean> {
    const origin = plainOriginOf(url);
    if (!origin) return false;
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (anchorUrl && plainOriginOf(anchorUrl) === origin) return true;
    return (await getSavedNodes()).some(n => plainOriginOf(n.url) === origin);
}

/**
 * A request signed in format 2 (it names a host: X-Signed-For) that a node refused as an old server refuses a signature
 * it can't read, before this phone had heard which format that node reads (its info couldn't be read): signed again,
 * once, in the old format, which is then kept for that node until its info says otherwise (request-signing-version.ts
 * `fellBackToOldFormat`). Never for a node that has said it reads 2. Only to one of this phone's communities
 * (`isSavedCommunity`): any other host could answer a write that way just to get it signed in the old format, which
 * names no host, and replay it at the member's community until the switch. Only for a plain headers object, a string
 * body (or none) and the phone's own key: anything else is returned as answered. Null: not signed again.
 */
async function signedAgainForOldNode(
    url: string, method: string, init: any, res: Response, send: (init: any) => Promise<Response>,
): Promise<Response | null> {
    if (res.status !== 403 && res.status !== 401) return null;
    const headers = init?.headers;
    const signedFor = plainHeader(headers, 'X-Signed-For');
    const pubkey = plainHeader(headers, 'X-Public-Key');
    if (!signedFor || !pubkey) return null;
    if (init?.body !== undefined && init?.body !== null && typeof init.body !== 'string') return null;
    if (typeof (res as any).clone !== 'function') return null;
    const refusal = await res.clone().json().catch(() => null);
    if (refusal?.error !== OLD_SERVER_SIGNATURE_REFUSAL) return null;
    const identity = await loadIdentity();
    if (!identity?.privateKey || identity.publicKey !== pubkey) return null;
    if (!(await isSavedCommunity(url))) return null;
    if (!(await fellBackToOldFormat(url))) return null;
    const kept = Object.fromEntries(Object.entries(headers).filter(([k]) => !SIGNING_HEADERS.has(k.toLowerCase())));
    const signed = await buildSignedHeaders(method, url, init?.body ?? '', identity.privateKey, identity.publicKey);
    return send({ ...init, headers: { ...kept, ...signed } });
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
                // Only sign requests to our own node, and never double-sign. Nor the read of a node's info while this
                // phone doesn't know it reads format 2: that read is how it learns, an older node refuses a format-2
                // signature even on its public info, a request signed meanwhile waits for this answer
                // (request-signing-version.ts learnRequestSigning) so signing it would wait on itself, and a node
                // updated since it was old must be able to say so even once it refuses the old format.
                const learningRead = signedPathOf(url) === '/api/community/info'
                    && ((await settledRequestSigning(url)) ?? 0) < REQUEST_SIGNING_VERSION;
                if (method === 'GET' && toAnchor && !learningRead && !hasHeader(init?.headers, 'X-Signature')) {
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
        const res = await originalFetch(input, init);
        if (typeof input !== 'string' || !url) return res;
        try {
            const method = String(init?.method ?? 'GET').toUpperCase();
            return (await signedAgainForOldNode(url, method, init, res, (again) => originalFetch(input, again))) ?? res;
        } catch (e) {
            if (e instanceof UnsafeNodeAddressError) throw e;
            return res;
        }
    };
}
