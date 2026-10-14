/**
 * Which request format each community's server checks (request binding, @beanpool/core request-signing.ts).
 *
 * A server from #1219 on says `requestSigning: 2` in `GET /api/community/info`, and the app signs everything it sends
 * there in format 2: bound to the host it connects to, so the signature is no good at any other community. A server
 * older than that can't read format 2, so a node whose info answered WITHOUT the field gets the old format. A node
 * this phone has not heard from yet must not be sent a format it refuses (found live 2026-10-04: a restore onto a
 * v1.2.26 node signed everything in format 2, even the info read that would have said so, and the socket, push and
 * every member read were refused). So: the info read is never signed while the format isn't known
 * (node-request-signing.ts); a request signed while a read of that node's info is in flight waits for its answer; a
 * socket, which can't be signed again, reads the info first (`learnRequestSigning`); and an HTTP request an old
 * server refuses is signed again once in the old format (`fellBackToOldFormat`), but only to one of this phone's own
 * communities (node-request-signing.ts): any other host could refuse just to get an old-format signature, which names
 * no host. A node not heard from otherwise gets format 2, and a saved community that pretends to be old gains only
 * old-format signatures, which every node refuses after the switch.
 *
 * One way only: once a host has said 2, nothing it says later moves it back. Until the switch every community still
 * accepts the old format, which names no community, so a request signed in it for a hostile node that stopped saying
 * 2 could be replayed at every other community where the key is a member for five minutes: a ledger transfer paid
 * twice (multi-community review F2). A server that really went back to a release older than #1219 is refused the
 * member's requests until it is updated, which is the right way round.
 *
 * Kept per host (the name signed for, `audienceOf`), in memory for this run and on each SavedNode for the next
 * (utils/nodes.ts recordRequestSigning / loadSavedRequestSigning). No React Native import here: utils/crypto.ts reads
 * it on every signed request.
 *
 * Only a plain address (node-url.ts `isPlainNodeAddress`) is read or recorded. From any other, iOS reaches a
 * different host than the one `audienceOf` names, and that other node's answer must not change the format used
 * for the named host.
 */

import { audienceOf, REQUEST_SIGNING_VERSION } from '@beanpool/core';
import { isPlainNodeAddress, plainOriginOf } from './node-url';

/** The host a request to `url` is kept under: null for an address that isn't plain. */
function hostOf(url: string): string | null {
    return isPlainNodeAddress(url) ? audienceOf(url) : null;
}

/** 2: bound to the host. 1: the old, unbound format, for a server that predates format 2. */
export type RequestSigningFormat = 1 | 2;

/** host → what its info answer said (1 when it said nothing). */
const known = new Map<string, number>();
let hydrating: Promise<void> | null = null;
/** host → a read of its info in flight (ours or node-profile.ts's), settled whatever it answers. */
const reading = new Map<string, Promise<void>>();
/** host → when a read of its info last failed: not asked again for a minute, so an offline phone isn't held up. */
const failedAt = new Map<string, number>();
const INFO_READ_TIMEOUT_MS = 8_000;
/**
 * How long a signed request waits for that read: the read goes on after, and its answer is kept for the next request.
 * Short, because a caller's own deadline starts after signing (Sign Out gives each community 4 s, account-leaves-phone.ts).
 */
const INFO_WAIT_MS = 1_500;
const FAILED_READ_PAUSE_MS = 60_000;
/** Where what is learned here is kept for the next run (utils/nodes.ts sets it): memory only until then. */
let keep: ((url: string, version: number) => Promise<void>) | null = null;

/**
 * What an info answer says about request signing: its `requestSigning` when that is a whole number, otherwise 1 (a
 * server older than format 2 answers without it). Null when the answer isn't an info answer at all, so nothing is
 * recorded from an error page or a proxy's HTML.
 */
export function requestSigningOf(infoBody: unknown): number | null {
    if (!infoBody || typeof infoBody !== 'object' || Array.isArray(infoBody)) return null;
    const v = (infoBody as { requestSigning?: unknown }).requestSigning;
    return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 1;
}

/** The higher of two answers: what a host once said it reads, it is never taken below. */
export function ratchetedRequestSigning(held: unknown, said: number): number {
    return typeof held === 'number' && Number.isSafeInteger(held) && held > said ? held : said;
}

/**
 * Remember what the node at `url` said, for this run, never below what it said before (one way only). Returns the host
 * it was kept under, or null for none.
 */
export function rememberRequestSigning(url: string, version: number): string | null {
    const host = hostOf(url);
    if (!host) return null;
    known.set(host, ratchetedRequestSigning(known.get(host), version));
    return host;
}

/** What this phone knows the node at `url` said, or undefined when it hasn't asked yet. No network. */
export function knownRequestSigning(url: string): number | undefined {
    const host = hostOf(url);
    return host ? known.get(host) : undefined;
}

/** What this phone knows the node at `url` said, once the stored answers have loaded. No network. */
export async function settledRequestSigning(url: string): Promise<number | undefined> {
    if (hydrating) await hydrating;
    return knownRequestSigning(url);
}

/** Where to keep what a node said for the next run (utils/nodes.ts). */
export function setRequestSigningKeeper(fn: (url: string, version: number) => Promise<void>): void {
    keep = fn;
}

/**
 * Note a read of `url`'s info that is already on its way (node-profile.ts fetchNodeProfile), so a request signed
 * meanwhile waits for its answer instead of asking again. Returns `read` unchanged.
 */
export function trackInfoRead<T>(url: string, read: Promise<T>): Promise<T> {
    const host = hostOf(url);
    if (!host) return read;
    const settled = read.then(() => undefined, () => undefined);
    reading.set(host, settled);
    void settled.finally(() => { if (reading.get(host) === settled) reading.delete(host); });
    return read;
}

/** `url`'s info address: https for a socket's wss (and http for ws). Null for an address that isn't plain. */
function infoUrlOf(url: string): string | null {
    const origin = plainOriginOf(url);
    return origin ? `${origin.replace(/^ws(s?):/, 'http$1:')}/api/community/info` : null;
}

async function readInfo(url: string, host: string, infoUrl: string): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Given up at the timeout whether or not the fetch honours its signal.
    const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('info read timed out')); }, INFO_READ_TIMEOUT_MS);
    });
    try {
        // Unsigned: the read-signing wrapper (node-request-signing.ts) never signs this read for a host whose format
        // isn't known, so it can't wait on itself, and an older node has no signature to refuse.
        const body = await Promise.race([timedOut, (async () => {
            const res = await fetch(infoUrl, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
            return res.ok ? await res.json().catch(() => null) : null;
        })()]);
        const version = requestSigningOf(body);
        if (version === null) {
            failedAt.set(host, Date.now());
            return;
        }
        rememberRequestSigning(url, version);
        await keep?.(url, version).catch(() => undefined);
    } catch {
        failedAt.set(host, Date.now());
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Make sure this phone knows which format `url`'s node reads before signing for it: nothing to do when it has heard
 * from the node; else wait for a read of its info already in flight, or read it now (unsigned, one per host at a
 * time), for at most INFO_WAIT_MS: a slow node's answer still lands for the next request, and one that refuses this
 * request meanwhile is signed again in the old format (`fellBackToOldFormat`). A node that couldn't be read is left
 * unknown (format 2) and not asked again for a minute. Never throws.
 */
export async function learnRequestSigning(url: string): Promise<void> {
    if (hydrating) await hydrating;
    const host = hostOf(url);
    if (!host || known.has(host)) return;
    let read = reading.get(host);
    if (!read) {
        const failed = failedAt.get(host);
        if (failed !== undefined && Date.now() - failed < FAILED_READ_PAUSE_MS) return;
        const infoUrl = infoUrlOf(url);
        if (!infoUrl) return;
        read = trackInfoRead(url, readInfo(url, host, infoUrl));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([read, new Promise<void>((resolve) => { timer = setTimeout(resolve, INFO_WAIT_MS); })]);
    clearTimeout(timer);
}

/** Wait, at most INFO_WAIT_MS, for a read of `url`'s info already in flight; start none. */
async function awaitInfoInFlight(url: string): Promise<void> {
    if (hydrating) await hydrating;
    const host = hostOf(url);
    const read = host && !known.has(host) ? reading.get(host) : undefined;
    if (!read) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([read, new Promise<void>((resolve) => { timer = setTimeout(resolve, INFO_WAIT_MS); })]);
    clearTimeout(timer);
}

/**
 * The format for a request to `url`: the old one only for a node that answered without `requestSigning`, or that
 * refused a format-2 signature before it had said anything (`fellBackToOldFormat`). Waits for a read of the node's
 * info in flight; `readInfoFirst` (a socket: nothing signs it again) reads it when none is (`learnRequestSigning`).
 */
export async function requestSigningFormatFor(url: string, options: { readInfoFirst?: boolean } = {}): Promise<RequestSigningFormat> {
    await (options.readInfoFirst ? learnRequestSigning(url) : awaitInfoInFlight(url));
    const said = knownRequestSigning(url);
    return said !== undefined && said < REQUEST_SIGNING_VERSION ? 1 : 2;
}

/**
 * A node refused a format-2 signature with an old server's refusal (403 `Invalid cryptographic signature`): record
 * the old format for it, here and on its saved entry, until its info says otherwise, and say whether to sign again in
 * it (once). Never for a node that has said it reads 2 (no downgrade: request-signing-version.ts, one way only). A
 * current server's own route handlers answer with the same words after its check has accepted the signature
 * (settings-signin-pairing.ts, engine/member-signature.ts), so a node not heard from yet has its info read first
 * (`learnRequestSigning`: unsigned, at most INFO_WAIT_MS, a read in flight reused): one that says 2 keeps 2 and its
 * refusal stands, so a handler isn't run twice. Signed again when the info says 1 or couldn't be read in time, and
 * for one whose info said 1 while the request was on its way (it outlasted INFO_WAIT_MS).
 */
export async function fellBackToOldFormat(url: string): Promise<boolean> {
    if (hydrating) await hydrating;
    const host = hostOf(url);
    if (!host) return false;
    if (!known.has(host)) await learnRequestSigning(url);
    const said = known.get(host);
    if (said !== undefined && said >= REQUEST_SIGNING_VERSION) return false;
    rememberRequestSigning(url, 1);
    await keep?.(url, 1).catch(() => undefined);
    return true;
}

/** What an old server answers a signature it can't verify (it reads format 1 only): 403 and this error. */
export const OLD_SERVER_SIGNATURE_REFUSAL = 'Invalid cryptographic signature';

/**
 * Load what saved nodes recorded on an earlier run (app start). The higher of the stored answer and one heard in this
 * run wins (one way only), so an old-format answer that arrives before this finishes can't undo a stored 2. Requests
 * signed while this runs wait for it, so the first request after a cold start uses the stored answer.
 */
export function hydrateRequestSigning(load: () => Promise<Array<{ url: string; requestSigning?: unknown }>>): Promise<void> {
    const run = (async () => {
        try {
            for (const node of await load()) {
                const host = typeof node.url === 'string' ? hostOf(node.url) : null;
                const v = node.requestSigning;
                if (host && typeof v === 'number' && Number.isSafeInteger(v) && v > 0) known.set(host, ratchetedRequestSigning(known.get(host), v));
            }
        } catch {
            // Nothing stored, or unreadable: each node is asked again when the app next reads its info.
        }
    })();
    hydrating = run;
    void run.finally(() => { if (hydrating === run) hydrating = null; });
    return run;
}

/** Tests only: forget everything. */
export function resetRequestSigningForTests(): void {
    known.clear();
    reading.clear();
    failedAt.clear();
    hydrating = null;
}
