/**
 * The door for requests from another community's server (messages across communities X1: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.2; DESIGN-cross-community-chat-fable.md §2.4, slice S2.1). The bytes and the key
 * document are @beanpool/core node-request-signing.ts; this server's own key and signer, engine/node-key.ts.
 *
 * A request to one of NODE_SIGNED_PATHS must carry X-BeanPool-Node, and is taken only when, in this order (the cheapest
 * first, so nothing that fails early costs a fetch or a signature check):
 *   1. the header is one (400 bad_node_signature);
 *   2. its time is within NODE_REQUEST_SKEW_MS of this server's clock, either way (401 stale);
 *   3. its destination is one of this server's own homes (engine/node-key.ts isOwnNodeHome: one of its names, on the port
 *      it answers there): one signed for another server, or for this host on another port, is 421 wrong_destination, so a
 *      request one server received can't be replayed at another. A server that knows none of its names takes no server
 *      request at all (421 too): it can't tell one meant for it from one that wasn't;
 *   4. its nonce was not spent (403 replay);
 *   5. its key is its origin's: the key document of the origin, fetched over TLS from the origin's home on its own port
 *      (@beanpool/core nodeKeyUrl: `https://<host>[:<port>]/api/node/key`), names it, as the current key while the
 *      document is valid or as a previous key while that key's own time lasts.
 *      Past either, 401 node_key_expired; a key the document doesn't name, or an origin whose document can't be had, 401
 *      node_key_unknown;
 *   6. the signature is that key's over the request as it arrived, the body's exact bytes included (403 bad_signature);
 *   7. THEN the nonce is spent, from the origin's own share of a store of its own (503 busy when it has no room): a
 *      forged request burns nothing.
 * A request that passes gets `ctx.state.nodeOrigin` (the origin and its key), and the member signature middleware never
 * sees it (https-server.ts isSignatureBypassed): no member key acts on these paths.
 *
 * **Fetching another server's key.** Only for a request that passed 1 to 4, through the SSRF-safe fetcher
 * (engine/pulse-resolver.ts ssrfSafeFetch: public addresses only, after every lookup; no redirect), at most
 * NODE_KEY_FETCHES_AT_ONCE at once (503 busy past them), each within NODE_KEY_FETCH_TIMEOUT_MS and NODE_KEY_DOCUMENT_MAX_BYTES.
 * A document is kept until it expires and for NODE_KEY_VALIDITY_MS at most (the most a document may promise), for at most
 * NODE_KEYS_KEPT origins, the least recently used going first (used: fetched, or found to name a request's key, current or
 * previous), so a peer in use is never dropped for origins seen once. A key the kept document doesn't name, or names as expired,
 * asks the origin again, at most once every NODE_KEY_ASK_AGAIN_MS (an origin that changed its key). An origin whose
 * document could not be had is not asked again for NODE_KEY_ASK_AGAIN_MS either. So a flood of requests naming other
 * origins costs at most one small fetch an origin a minute, and no origin is ever asked from inside a member's request.
 *
 * **Nonces.** The member signature store (engine/member-signature.ts NonceStore, design 3) is reused as a class, with a
 * store of its own for servers so servers and members never compete for room: every nonce is spent in its strangers'
 * region by its origin (NODE_NONCES_PER_ORIGIN each, NODE_NONCES_MAX together, about 23 MB at the most). A nonce is held
 * for the skew window from its request's time, so a replay is refused for as long as the request could be fresh.
 */
import type Koa from 'koa';
import {
    NODE_KEY_VALIDITY_MS, NODE_REQUEST_HEADER, NODE_REQUEST_SKEW_MS, nodeKeyStanding, nodeKeyUrl, nodeRequestSignatureVerifies,
    parseNodeRequestHeader, readNodeKeyDocument, type NodeKeyDocument,
} from '@beanpool/core';
import { NonceStore } from './member-signature.js';
import { isOwnNodeHome } from './node-key.js';
import { knowsItsNames } from './own-addresses.js';
import { ssrfSafeFetch } from './pulse-resolver.js';
import { logger } from '../logger.js';

/** The paths only another community's server may call, each with its node signature (routes/node-key.ts). */
export const NODE_SIGNED_PATHS: ReadonlySet<string> = new Set<string>(['/api/node/check']);

/**
 * Whether `path` is one of NODE_SIGNED_PATHS, matched ignoring case and one trailing slash, as the router dispatches it:
 * what this protects is matched loosely, so no spelling reaches the route without a node signature.
 */
export function isNodeSignedPath(path: string): boolean {
    const lower = path.toLowerCase();
    const routed = lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
    return NODE_SIGNED_PATHS.has(routed);
}

// ─── Nonces ─────────────────────────────────────────────────────────────────────────────────

/** One origin's share of the store: far past what one server sends in the window. */
export const NODE_NONCES_PER_ORIGIN = 3_000;
/** Every origin's together: about 23 MB at 232 bytes a nonce (member-signature.ts measured it). */
export const NODE_NONCES_MAX = 100_000;

/** Servers' nonces, a store of their own: every one in its strangers' region, by its origin. */
export const nodeRequestNonces = new NonceStore(NODE_REQUEST_SKEW_MS, { strangersMax: NODE_NONCES_MAX, addressMax: NODE_NONCES_PER_ORIGIN });

/** The https-server minute timer's sweep, beside the members' store's. */
export function pruneNodeRequestNonces(now = Date.now()): void {
    nodeRequestNonces.prune(now);
}

// ─── Other servers' keys ────────────────────────────────────────────────────────────────────

export const NODE_KEYS_KEPT = 512;
export const NODE_KEY_ASK_AGAIN_MS = 60_000;
export const NODE_KEY_FETCHES_AT_ONCE = 8;
export const NODE_KEY_FETCH_TIMEOUT_MS = 5_000;
export const NODE_KEY_DOCUMENT_MAX_BYTES = 16 * 1024;
/** Origins remembered as unreachable, or as asked a moment ago: the oldest go first past this. */
const ORIGINS_REMEMBERED = 4_096;

interface KeptDocument {
    doc: NodeKeyDocument;
    /** Until when it is used without asking again: its own validity, and never more than NODE_KEY_VALIDITY_MS after it came. */
    trustUntil: number;
}

const kept = new Map<string, KeptDocument>();
/** When each origin was last asked for its document (it came, or it didn't). */
const askedAt = new Map<string, number>();
const fetching = new Map<string, Promise<NodeKeyDocument | null>>();

/** A document that could not be had is written to the log at most this often, with how many since (never one a request). */
const FAILED_LOG_EVERY_MS = 60_000;
let failedLoggedAt = -Infinity;
let failedSince = 0;

/** Fetches the key document at `url`, the origin's nodeKeyUrl. */
type DocumentFetch = (url: string) => Promise<unknown>;

/** The real fetch: `https://<host>[:<port>]/api/node/key`, public addresses only, no redirect, small, quick. */
async function fetchOverTls(url: string): Promise<unknown> {
    const res = await ssrfSafeFetch(url, {
        timeoutMs: NODE_KEY_FETCH_TIMEOUT_MS, maxBytes: NODE_KEY_DOCUMENT_MAX_BYTES, maxRedirects: 0,
        allowedContentTypes: ['application/json'], headers: { Accept: 'application/json' },
    });
    if (res.status !== 200) throw new Error(`answered ${res.status}`);
    return res.json();
}

let fetchDocument: DocumentFetch = fetchOverTls;

/**
 * Tests: fetch origins' documents with `fetch` instead of over TLS from the origin (a suite's servers are on this machine,
 * which the real fetch refuses), and forget every document kept so far; null puts the real fetch back. `fetch` is handed
 * the URL the real fetch would ask (nodeKeyUrl of the origin, its port included). Double-locked as the
 * SSRF fetcher's own hook is: it refuses to run unless the process sets BEANPOOL_SSRF_TEST_HOOK=1, which nothing in
 * production does.
 */
export function __useNodeKeyFetchForTests(fetch: DocumentFetch | null): void {
    if (process.env.BEANPOOL_SSRF_TEST_HOOK !== '1') throw new Error('The node key fetch hook is disabled (BEANPOOL_SSRF_TEST_HOOK is not 1)');
    fetchDocument = fetch ?? fetchOverTls;
    forgetNodeKeys();
}

/** Forget every origin's document and every ask, and write the next failure to the log (tests; nothing else needs to). */
export function forgetNodeKeys(): void {
    kept.clear();
    askedAt.clear();
    failedLoggedAt = -Infinity;
    failedSince = 0;
}

/** How many origins' documents are kept (suites). */
export function nodeKeysKept(): number {
    return kept.size;
}

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value!);
}


function noteFailedDocument(origin: string, why: string): void {
    failedSince++;
    const now = Date.now();
    if (now - failedLoggedAt < FAILED_LOG_EVERY_MS) return;
    logger.warn('AUTH', `Server requests: no key document that checks out could be had from ${origin} (${why.slice(0, 120)}), so its `
        + `requests are refused for now. ${failedSince} such since the last line.`);
    failedLoggedAt = now;
    failedSince = 0;
}

/** Ask `origin` for its document now: one ask an origin at a time, at most NODE_KEY_FETCHES_AT_ONCE origins at once. */
function askFor(origin: string, now: number): Promise<NodeKeyDocument | null> | 'busy' {
    if (fetching.size >= NODE_KEY_FETCHES_AT_ONCE) return 'busy';
    remember(askedAt, origin, now, ORIGINS_REMEMBERED);
    const ask = (async () => {
        try {
            const doc = readNodeKeyDocument(await fetchDocument(nodeKeyUrl(origin)));
            if (!doc) {
                noteFailedDocument(origin, 'not a signed key document');
                return null;
            }
            remember(kept, origin, { doc, trustUntil: Math.min(doc.validUntil, Date.now() + NODE_KEY_VALIDITY_MS) }, NODE_KEYS_KEPT);
            return doc;
        } catch (e) {
            noteFailedDocument(origin, e instanceof Error ? e.message : String(e));
            return null;
        } finally {
            fetching.delete(origin);
        }
    })();
    fetching.set(origin, ask);
    return ask;
}

export type OriginKeyStanding = 'current' | 'previous' | 'expired' | 'unknown' | 'busy';

/**
 * How `keyHex` stands as `origin`'s key at `now`: from the document kept, else (or when it no longer says yes) from the
 * origin's answer, waited for when an ask is already on its way, asked at most once every NODE_KEY_ASK_AGAIN_MS.
 */
export async function originKeyStanding(origin: string, keyHex: string, now = Date.now()): Promise<OriginKeyStanding> {
    const have = kept.get(origin);
    const trusted = have && now < have.trustUntil ? have.doc : null;
    if (have && trusted) {
        const standing = nodeKeyStanding(trusted, keyHex, now);
        if (standing === 'current' || standing === 'previous') {
            // In use: to the back of the line, so the document dropped past NODE_KEYS_KEPT is the least recently used one.
            remember(kept, origin, have, NODE_KEYS_KEPT);
            return standing;
        }
    }
    let asked: Promise<NodeKeyDocument | null> | 'busy' | undefined = fetching.get(origin);
    if (!asked) {
        const last = askedAt.get(origin);
        if (last !== undefined && now - last >= 0 && now - last < NODE_KEY_ASK_AGAIN_MS) {
            return trusted ? nodeKeyStanding(trusted, keyHex, now) : 'unknown';
        }
        asked = askFor(origin, now);
    }
    if (asked === 'busy') return 'busy';
    const doc = await asked;
    if (doc) return nodeKeyStanding(doc, keyHex, now);
    return trusted ? nodeKeyStanding(trusted, keyHex, now) : 'unknown';
}

// ─── Verifying ──────────────────────────────────────────────────────────────────────────────

export interface NodeOrigin {
    /** The sending server's home, as it signed it: its host, and its port when not 443. */
    origin: string;
    /** The key it signed with: its current key, or a previous one still within its time. */
    key: string;
}

export type NodeSignatureVerdict =
    | ({ ok: true } & NodeOrigin)
    | { ok: false; status: 400 | 401 | 403 | 421 | 503; code: string; error: string; retryAfterSec?: number };

export const NODE_BUSY_RETRY_AFTER_SEC = 60;

const refuse = (status: 400 | 401 | 403 | 421 | 503, code: string, error: string, retryAfterSec?: number): NodeSignatureVerdict =>
    ({ ok: false, status, code, error, ...(retryAfterSec ? { retryAfterSec } : {}) });

/** Verify a request from another community's server, in the order above. */
export async function verifyNodeRequest(
    request: { header: string | undefined; method: string; path: string; body: string },
    opts: { now?: number; nonces?: NonceStore } = {},
): Promise<NodeSignatureVerdict> {
    const now = opts.now ?? Date.now();
    if (!request.header) return refuse(401, 'node_signature_missing', `This path takes only requests signed by a community's server (${NODE_REQUEST_HEADER}).`);
    const h = parseNodeRequestHeader(request.header);
    if (!h) return refuse(400, 'bad_node_signature', `The ${NODE_REQUEST_HEADER} header is not one this server reads.`);
    if (Math.abs(now - h.at) > NODE_REQUEST_SKEW_MS) return refuse(401, 'stale', 'The request time is too far from this server\'s clock.');
    if (!knowsItsNames()) {
        return refuse(421, 'wrong_destination', 'This server knows none of its own names yet, so it takes no request from another server.');
    }
    let here: boolean;
    try {
        here = isOwnNodeHome(h.destination);
    } catch {
        here = false;
    }
    if (!here) return refuse(421, 'wrong_destination', 'This request was signed for another server.');
    const nonces = opts.nonces ?? nodeRequestNonces;
    if (nonces.isSpent(h.nonce, now)) return refuse(403, 'replay', 'Replay detected: nonce already used.');

    const key = await originKeyStanding(h.origin, h.key, now);
    if (key === 'busy') return refuse(503, 'busy', 'This server is checking other servers\' keys. Please try again in a minute.', NODE_BUSY_RETRY_AFTER_SEC);
    if (key === 'expired') return refuse(401, 'node_key_expired', 'The sending server\'s key has expired.');
    if (key === 'unknown') return refuse(401, 'node_key_unknown', 'The sending server\'s key could not be confirmed.');

    if (!nodeRequestSignatureVerifies(h, { method: request.method, path: request.path, body: request.body })) {
        return refuse(403, 'bad_signature', 'Invalid server signature.');
    }

    const spender = { region: 'stranger' as const, owner: `o:${h.origin}` };
    if (!nonces.isSpent(h.nonce, now) && nonces.room(spender, now)) {
        return refuse(503, 'busy', 'This server is very busy right now. Please try again in a minute.', NODE_BUSY_RETRY_AFTER_SEC);
    }
    if (!nonces.consume(h.nonce, now, h.at, spender)) return refuse(403, 'replay', 'Replay detected: nonce already used.');
    return { ok: true, origin: h.origin, key: h.key };
}

/**
 * Koa middleware, mounted after the body parser (the exact body the request signed: `ctx.rawBody`) and before the member
 * signature middleware. On NODE_SIGNED_PATHS only; every other request passes untouched.
 */
export async function requireNodeSignature(ctx: Koa.Context, next: Koa.Next): Promise<void> {
    if (!isNodeSignedPath(ctx.path)) return next();
    const verdict = await verifyNodeRequest({
        header: ctx.get(NODE_REQUEST_HEADER) || undefined, method: ctx.method, path: ctx.path,
        body: (ctx as unknown as { rawBody?: string }).rawBody ?? '',
    });
    if (!verdict.ok) {
        ctx.status = verdict.status;
        if (verdict.retryAfterSec) ctx.set('Retry-After', String(verdict.retryAfterSec));
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { error: verdict.error, code: verdict.code };
        return;
    }
    ctx.state.nodeOrigin = { origin: verdict.origin, key: verdict.key } satisfies NodeOrigin;
    await next();
}
