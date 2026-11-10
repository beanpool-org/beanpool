/**
 * The oldest BeanPool server the web app talks to when it reaches a community other than the one that served it: 1.4.0,
 * the clean-slate cutover (DESIGN-clean-slate-cutover-fable.md §1, slice W).
 *
 * The web app is the node's own copy, fetched fresh on every load, so the node that served the page is always the page's
 * version: nothing here works around an older node on the page's own address. What can be older is another community the
 * page reaches: a peer in the Market's browse, a community a member asks to join or has a copy on, the node Settings'
 * Sovereign Node Connection points the page at. Each of those is asked for its version first, at
 * `GET /api/community/health`, and is called only once it has said it runs MIN_NODE_VERSION or newer.
 *
 * The read is cross-origin, and every server from 1.4.0 answers it readably to any origin (apps/server https-server.ts
 * HEALTH_CORS_PATH, a plain GET with no credential and no header of its own, so a browser sends no preflight). A server
 * older than that never does: a browser refuses its answer. So a read that fails (refused by the browser, no network, no
 * answer in time, not a health answer, no version) means "not known to be 1.4.0", and the call is refused as well, with one
 * line that says both things it can be. A failure is never kept: the next call asks again. A version heard is kept for
 * this page's memory only: a reload asks again, and a server is never held to what it said yesterday. The last-resort
 * 0.0.0 a server reports when it can't resolve its own version is not refused: it answered readably, which a server older
 * than 1.4.0 does only for an origin its operator lists. That one rule replaces the older-node branches the web app kept
 * (audit D14). The phone's own copy of the rule is apps/native/utils/node-version-gate.ts.
 */
import { t } from '@beanpool/core';
import { isVersionOlder, normaliseVersion } from './app-version';

/** The oldest server version this build talks to. */
export const MIN_NODE_VERSION = '1.4.0';

/** The health route: the one request a community not known to be MIN_NODE_VERSION or newer is still sent. */
export const HEALTH_PATH = '/api/community/health';

/** The health read's own limit: a call to a community not heard from yet waits at most this long for it. */
export const HEALTH_READ_TIMEOUT_MS = 8_000;

/**
 * The server version a health answer names, when it is below MIN_NODE_VERSION; null otherwise (not a health answer, no
 * version or not a version, the unresolved 0.0.0, or new enough).
 */
export function nodeVersionBelowMinimum(health: unknown): string | null {
    if (!health || typeof health !== 'object' || Array.isArray(health)) return null;
    const version = normaliseVersion((health as { version?: unknown }).version);
    if (!version || /^0(\.0){0,2}$/.test(version)) return null;
    return isVersionOlder(version, MIN_NODE_VERSION) ? version : null;
}

/** Whether a health answer is one at all (an object that names a version), so an error page records nothing. */
function isHealthAnswer(body: unknown): boolean {
    return !!body && typeof body === 'object' && !Array.isArray(body) && normaliseVersion((body as { version?: unknown }).version) !== null;
}

/** The line a member reads, in their language, for a server that named its version. */
export function nodeTooOldText(version: string): string {
    return t("This community's server runs BeanPool {version}. This app needs {minimum} or newer. Its operator must update.", { version, minimum: MIN_NODE_VERSION });
}

/** The line for a server whose version couldn't be read: it is out of reach just now, or older than this app talks to. */
export function nodeNotReadText(): string {
    return t("This community's server can't be reached right now, or it runs a BeanPool older than {minimum}. Try again later.", { minimum: MIN_NODE_VERSION });
}

/**
 * A call this page did not make, because the community's server is not known to run MIN_NODE_VERSION or newer. `message`
 * is the line. `nodeVersion` is the version it named when below the minimum, or null when its version couldn't be read.
 */
export class NodeTooOldError extends Error {
    readonly nodeVersion: string | null;
    constructor(nodeVersion: string | null) {
        super(nodeVersion === null ? nodeNotReadText() : nodeTooOldText(nodeVersion));
        this.name = 'NodeTooOldError';
        this.nodeVersion = nodeVersion;
    }
}

export function isNodeTooOldError(e: unknown): e is NodeTooOldError {
    return e instanceof NodeTooOldError || (!!e && typeof e === 'object' && (e as { name?: unknown }).name === 'NodeTooOldError');
}

/** An address's origin, or null for one that isn't an http(s) address. */
function originOf(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
    } catch {
        return null;
    }
}

/** origin → its version when below the minimum, or null when it answered new enough. Absent: not heard this page. */
const heard = new Map<string, string | null>();
/** origin → a read of its health in flight: true when it was heard, false when it failed. */
const reading = new Map<string, Promise<boolean>>();

/** Reads `origin`'s health once; true when it named a version (now in `heard`), false when it couldn't be read. */
async function readHealth(origin: string): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Given up at the limit whether or not the fetch honours its signal.
    const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('health read timed out')); }, HEALTH_READ_TIMEOUT_MS);
    });
    try {
        // A plain GET: no header of its own and no credential, so a browser sends it without a preflight.
        const body = await Promise.race([timedOut, (async () => {
            const res = await fetch(`${origin}${HEALTH_PATH}`, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal });
            return res.ok ? await res.json().catch(() => null) : null;
        })()]);
        if (!isHealthAnswer(body)) return false;
        heard.set(origin, nodeVersionBelowMinimum(body));
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** What an aborted signal throws: its own reason, or the AbortError a fetch would. */
function abortReason(signal: AbortSignal): unknown {
    if (signal.reason !== undefined) return signal.reason;
    try {
        return new DOMException('The operation was aborted.', 'AbortError');
    } catch {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        return e;
    }
}

/** `read`, unless `signal` gives up first: then its reason, and the read goes on for whoever else waits on it. */
function untilAborted<T>(read: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return read;
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        read.then(
            (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
            (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
        );
    });
}

/**
 * Throws a NodeTooOldError, having sent nothing but the health read, unless the server at `community` (any address on it)
 * has said it runs MIN_NODE_VERSION or newer: one that names an older version, and one whose health can't be read. The
 * page's own address is never asked: it is this page's version. Waits for the read at most HEALTH_READ_TIMEOUT_MS, one
 * read per community at a time; `signal` gives up the wait (and throws its reason) without stopping the read.
 */
export async function refuseIfNodeTooOld(community: string, signal?: AbortSignal): Promise<void> {
    const origin = originOf(community);
    if (!origin) return;
    if (typeof window !== 'undefined' && origin === window.location.origin) return;
    if (signal?.aborted) throw abortReason(signal);
    if (!heard.has(origin)) {
        let read = reading.get(origin);
        if (!read) {
            const started = readHealth(origin);
            read = started;
            reading.set(origin, started);
            void started.finally(() => { if (reading.get(origin) === started) reading.delete(origin); });
        }
        if (!(await untilAborted(read, signal))) throw new NodeTooOldError(null);
    }
    const version = heard.get(origin);
    if (typeof version === 'string') throw new NodeTooOldError(version);
}

/** Tests only: forget everything heard. */
export function resetNodeVersionGateForTests(): void {
    heard.clear();
    reading.clear();
}

/** Tests only: say a community's server is `version`, so a test that records every fetch sees only its own. */
export function hearNodeVersionForTests(community: string, version: string = MIN_NODE_VERSION): void {
    const origin = originOf(community);
    if (origin) heard.set(origin, nodeVersionBelowMinimum({ version }));
}
