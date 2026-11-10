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
 *
 * The same wrapper keeps the app away from a server older than it talks to (utils/node-version-gate.ts): a request to one
 * of this phone's communities waits for that community's health the first time this run, and one to a server heard below
 * MIN_NODE_VERSION is refused before it leaves the phone. And it hears the community refuse this app (426 app_too_old,
 * the node's floor): that is the full-screen "Update required" (utils/force-update.ts noteAppRefused).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LANGUAGE_HEADER } from '@beanpool/core';
import { buildSignedHeaders } from './crypto';
import { loadIdentity } from './identity';
import { plainOriginOf, shouldBlockCleartextNodeUrl, UnsafeNodeAddressError } from './node-url';
import { getSavedNodes } from './nodes';
import { APP_TOO_OLD_CODE, APP_VERSION_HEADER, noteAppRefused } from './force-update';
import { languageForNode } from './language-choice';
import { isHealthRead, learnNodeVersion, noteHealthAnswer, refuseIfNodeTooOld, tooOldVersionOf } from './node-version-gate';

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

/** Whether `url` goes to the community open on this phone (the anchor) or a saved one: the same origin. */
async function isSavedCommunity(url: string): Promise<boolean> {
    const origin = plainOriginOf(url);
    if (!origin) return false;
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (anchorUrl && plainOriginOf(anchorUrl) === origin) return true;
    return (await getSavedNodes()).some(n => plainOriginOf(n.url) === origin);
}

/** Read a header value from either a plain object or a Headers instance. */
function hasHeader(headers: any, name: string): boolean {
    if (!headers) return false;
    if (typeof headers.get === 'function') return !!headers.get(name);
    const lower = name.toLowerCase();
    return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

/**
 * A header on a request to the phone's own community: the app's version (`X-BeanPool-App: 1.2.57 android`), for the
 * community's counts of who runs what (an operator reads them before raising the floor:
 * apps/server/src/app-version-counts.ts), and the language this phone writes in (`X-Language: pt`, Marty's M6: not
 * signed, not stored), so a refusal comes back in it whichever helper made the request. Added to a plain headers object
 * only, never over one the caller set: a Headers instance or a Request carries its own, and adding to those here would
 * replace them.
 */
function withHeader(input: any, init: any, name: string, value: string): any {
    if (typeof input !== 'string') return init;
    const headers = init?.headers;
    if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers) || typeof headers.get === 'function')) return init;
    if (hasHeader(headers, name)) return init;
    return { ...(init || {}), headers: { ...(headers || {}), [name]: value } };
}

/**
 * Wrap global.fetch once so GET requests to the anchor node carry a replay-proof
 * member signature, every request to it the phone's language, and the app's version when `appVersionHeader` is given
 * (a phone build: see utils/force-update.ts appVersionHeaderValue). Call once at app startup.
 */
export function installNodeRequestSigning(options: { appVersionHeader?: string | null } = {}): void {
    if (installed) return;
    installed = true;
    appVersionHeader = options.appVersionHeader ?? null;

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

        // A server older than this app talks to (node-version-gate.ts) is sent its health read and nothing else: one of
        // this phone's communities not heard from yet this run is asked first, and a server heard below the minimum (one
        // of ours, or one a join read the health of) is refused here, before anything is sent. Not swallowed below.
        const healthRead = !!url && isHealthRead(url);
        if (url && !healthRead) {
            try {
                if (tooOldVersionOf(url) === undefined && await isSavedCommunity(url)) await learnNodeVersion(url, originalFetch);
            } catch {
                // The saved communities unreadable: a doubt, and a doubt sends the request.
            }
            refuseIfNodeTooOld(url);
        }

        let toAnchor = false;
        try {
            const method: string = String(
                init?.method ?? (typeof input !== 'string' ? input?.method : undefined) ?? 'GET',
            ).toUpperCase();

            if (url) {
                const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                toAnchor = !!anchorUrl && isAnchorRequest(url, anchorUrl);
                if (toAnchor && appVersionHeader) init = withHeader(input, init, APP_VERSION_HEADER, appVersionHeader);
                if (toAnchor) init = withHeader(input, init, LANGUAGE_HEADER, languageForNode());
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
        const res = await originalFetch(input, init);
        if (!url) return res;
        // What a server's health says of its version, wherever the app read it: a server updated while the app ran is let
        // through again at once, and one a join reads is refused if it is too old. Read from a copy, never the caller's.
        if (healthRead && res.ok) void readCopy(res).then((body) => noteHealthAnswer(url, body));
        // The community refusing this app (its floor, 426 app_too_old): the full-screen "Update required". Only its own
        // community's answer counts: any other host could say it just to cover the app. The server sends the code in
        // `code` and a sentence in `error` (force-update.ts APP_TOO_OLD_CODE); with no `minAppVersion` (a refusal of one
        // feature, such as the sign-in pairing's) noteAppRefused puts nothing up.
        if (toAnchor && res.status === 426) {
            const body = await readCopy(res);
            if (body && typeof body === 'object' && (body as { code?: unknown }).code === APP_TOO_OLD_CODE) {
                noteAppRefused((body as { minAppVersion?: unknown }).minAppVersion);
            }
        }
        return res;
    };
}

/** The JSON of a copy of `res`, or null: the caller's own body is never read here. */
async function readCopy(res: Response): Promise<unknown> {
    try {
        if (typeof (res as any).clone !== 'function') return null;
        return await res.clone().json();
    } catch {
        return null;
    }
}
