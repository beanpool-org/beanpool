/**
 * The oldest BeanPool server the web app talks to when it reaches a community other than the one that served it: 1.4.0,
 * the clean-slate cutover (DESIGN-clean-slate-cutover-fable.md §1, slice W).
 *
 * The web app is the node's own copy, fetched fresh on every load, so the node that served the page is always the page's
 * version: nothing here works around an older node on the page's own address. What can be older is another community the
 * page reaches: a peer in the Market's browse, a community a member asks to join or has a copy on, the node Settings'
 * Sovereign Node Connection points the page at. Each of those is asked for its version first, and a community whose
 * `GET /api/community/health` names one below MIN_NODE_VERSION gets one plain line and nothing else: no request but the
 * health read itself reaches it. That one rule replaces the older-node branches the web app kept (audit D14).
 *
 * Baked in, never read from anywhere. Every doubt is "not too old": no answer, an answer that is not a health answer, no
 * version, a version that is not a version, or the last-resort 0.0.0 a server reports when it can't resolve its own. In
 * this page's memory only: a reload asks again, and a server is never held to what it said yesterday. The phone's own
 * copy of this rule is apps/native/utils/node-version-gate.ts.
 */
import { t } from '@beanpool/core';
import { isVersionOlder, normaliseVersion } from './app-version';

/** The oldest server version this build talks to. */
export const MIN_NODE_VERSION = '1.4.0';

/** The health route: the one request a community below the minimum is still sent. */
export const HEALTH_PATH = '/api/community/health';

/** The health read's own limit: a call to a community not heard from yet waits at most this long for it. */
export const HEALTH_READ_TIMEOUT_MS = 8_000;
/** A health read that failed is not asked again for a minute, so an offline browser waits for it once a minute at most. */
const FAILED_READ_PAUSE_MS = 60_000;

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

/** The line a member reads, in their language. */
export function nodeTooOldText(version: string): string {
    return t("This community's server runs BeanPool {version}. This app needs {minimum} or newer. Its operator must update.", { version, minimum: MIN_NODE_VERSION });
}

/** A call this page did not make, because the community's server is below MIN_NODE_VERSION. `message` is the line. */
export class NodeTooOldError extends Error {
    readonly nodeVersion: string;
    constructor(nodeVersion: string) {
        super(nodeTooOldText(nodeVersion));
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
/** origin → a read of its health in flight. */
const reading = new Map<string, Promise<void>>();
/** origin → when its last health read failed. */
const failedAt = new Map<string, number>();

async function readHealth(origin: string): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Given up at the limit whether or not the fetch honours its signal.
    const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('health read timed out')); }, HEALTH_READ_TIMEOUT_MS);
    });
    try {
        const body = await Promise.race([timedOut, (async () => {
            const res = await fetch(`${origin}${HEALTH_PATH}`, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
            return res.ok ? await res.json().catch(() => null) : null;
        })()]);
        if (isHealthAnswer(body)) {
            heard.set(origin, nodeVersionBelowMinimum(body));
            failedAt.delete(origin);
        } else {
            failedAt.set(origin, Date.now());
        }
    } catch {
        failedAt.set(origin, Date.now());
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Throws a NodeTooOldError, having sent nothing but the health read, when the server at `community` (any address on it)
 * is below MIN_NODE_VERSION. The page's own address is never asked: it is this page's version. A server that can't be read
 * is a doubt: the call goes. Waits for the read at most HEALTH_READ_TIMEOUT_MS, once per community at a time.
 */
export async function refuseIfNodeTooOld(community: string): Promise<void> {
    const origin = originOf(community);
    if (!origin) return;
    if (typeof window !== 'undefined' && origin === window.location.origin) return;
    if (!heard.has(origin)) {
        let read = reading.get(origin);
        if (!read) {
            const failed = failedAt.get(origin);
            if (failed !== undefined && Date.now() - failed < FAILED_READ_PAUSE_MS) return;
            const started = readHealth(origin);
            read = started;
            reading.set(origin, started);
            void started.finally(() => { if (reading.get(origin) === started) reading.delete(origin); });
        }
        await read;
    }
    const version = heard.get(origin);
    if (typeof version === 'string') throw new NodeTooOldError(version);
}

/** Tests only: forget everything heard. */
export function resetNodeVersionGateForTests(): void {
    heard.clear();
    reading.clear();
    failedAt.clear();
}

/** Tests only: say a community's server is `version`, so a test that records every fetch sees only its own. */
export function hearNodeVersionForTests(community: string, version: string = MIN_NODE_VERSION): void {
    const origin = originOf(community);
    if (origin) heard.set(origin, nodeVersionBelowMinimum({ version }));
}
