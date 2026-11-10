/**
 * The oldest BeanPool server this app talks to: 1.4.0, the clean-slate cutover (DESIGN-clean-slate-cutover-fable.md §1).
 *
 * Baked in, never read from anywhere: a community whose `GET /api/community/health` names a `version` below it gets one
 * card, the full-screen block (components/ForceUpdateBlock.tsx: "This community's server runs BeanPool x. This app needs
 * 1.4.0 or newer. Its operator must update."), and no other request. That one rule replaces every branch the app kept
 * for an older server (audit CN1 to CN14): nothing here works around an old server, it is only told apart.
 *
 * How "no other request" holds (utils/node-request-signing.ts, services/ws-client.ts): a request to one of this phone's
 * communities whose version this run hasn't heard yet first waits for a read of its health (unsigned, one per community at
 * a time, at most HEALTH_WAIT_MS), and one to a community heard below the minimum is refused here, before anything leaves
 * the phone (NodeTooOldError). The health read itself always goes: it is how the phone learns, and how it hears that the
 * server was updated. Every health answer the phone reads anywhere is noted (noteHealthAnswer), so a server updated while
 * the block is up is let through again at once.
 *
 * Every doubt is "not too old": no answer, an answer that is not a health answer, no version, a version that is not a
 * version, or the last-resort 0.0.0 a server reports when it can't resolve its own (apps/server/src/version.ts). In memory
 * for this run: a cold start asks again, and a server is never held to what it said yesterday.
 */
import { signedPathOf } from '@beanpool/core';
import { isVersionOlder, normaliseVersion } from './app-version';
import { plainOriginOf } from './node-url';

/** The oldest server version this build talks to. */
export const MIN_NODE_VERSION = '1.4.0';

/** How long a request to a community not heard from yet waits for its health: the read goes on after, for the next one. */
export const HEALTH_WAIT_MS = 1_500;
/** The health read's own limit. */
const HEALTH_READ_TIMEOUT_MS = 8_000;
/** A health read that failed is not asked again for a minute, so an offline phone isn't held up. */
const FAILED_READ_PAUSE_MS = 60_000;

/** The health route: the one request a community below the minimum is still sent. */
export const HEALTH_PATH = '/api/community/health';

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

/** Whether a health answer is one at all (an object that names a version), so an error page or a proxy's HTML records nothing. */
function isHealthAnswer(body: unknown): boolean {
    return !!body && typeof body === 'object' && !Array.isArray(body) && normaliseVersion((body as { version?: unknown }).version) !== null;
}

/** The card's sentence, in English: utils that throw it say it as given; the block says it in the member's language. */
export function nodeTooOldText(version: string): string {
    return `This community's server runs BeanPool ${version}. This app needs ${MIN_NODE_VERSION} or newer. Its operator must update.`;
}

/** A request this phone did not send, because its community's server is below MIN_NODE_VERSION. */
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

/** origin → its version when below the minimum, or null when it answered new enough. Absent: not heard this run. */
const heard = new Map<string, string | null>();
/** origin → a read of its health in flight. */
const reading = new Map<string, Promise<void>>();
/** origin → when its last health read failed. */
const failedAt = new Map<string, number>();
const listeners = new Set<() => void>();

/** Tell `listener` whenever what is known of a community's version changes. Returns the unsubscribe. */
export function onNodeVersionHeard(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * Note a health answer from the server at `url` (any address on it: the origin is what is kept). An answer that is not a
 * health answer changes nothing.
 */
export function noteHealthAnswer(url: string, body: unknown): void {
    const origin = plainOriginOf(url);
    if (!origin || !isHealthAnswer(body)) return;
    const next = nodeVersionBelowMinimum(body);
    failedAt.delete(origin);
    if (heard.has(origin) && heard.get(origin) === next) return;
    heard.set(origin, next);
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* one listener's throw never stops the others */ }
    }
}

/**
 * What this run knows of the server at `url`: its version when below the minimum, null when it answered new enough,
 * undefined when it hasn't been heard. No network.
 */
export function tooOldVersionOf(url: string): string | null | undefined {
    const origin = plainOriginOf(url);
    if (!origin) return undefined;
    return heard.has(origin) ? heard.get(origin) ?? null : undefined;
}

/** Whether `url` is the health read, the one request a server below the minimum is still sent. */
export function isHealthRead(url: string): boolean {
    return signedPathOf(url).replace(/\/+$/, '') === HEALTH_PATH;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

async function readHealth(origin: string, fetchImpl: FetchLike): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Given up at the timeout whether or not the fetch honours its signal.
    const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('health read timed out')); }, HEALTH_READ_TIMEOUT_MS);
    });
    try {
        const body = await Promise.race([timedOut, (async () => {
            const res = await fetchImpl(`${origin}${HEALTH_PATH}`, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
            return res.ok ? await res.json().catch(() => null) : null;
        })()]);
        if (isHealthAnswer(body)) noteHealthAnswer(origin, body);
        else failedAt.set(origin, Date.now());
    } catch {
        failedAt.set(origin, Date.now());
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Make sure this run has heard the version of the server at `url` before a request goes to it: nothing to do when it
 * has; else wait for a read of its health already in flight, or start one (through `fetchImpl`, unsigned), for at most
 * HEALTH_WAIT_MS. A server that couldn't be read is left unheard (a doubt: the request goes) and not asked again for a
 * minute. Never throws.
 */
export async function learnNodeVersion(url: string, fetchImpl: FetchLike): Promise<void> {
    const origin = plainOriginOf(url);
    if (!origin || heard.has(origin)) return;
    let read = reading.get(origin);
    if (!read) {
        const failed = failedAt.get(origin);
        if (failed !== undefined && Date.now() - failed < FAILED_READ_PAUSE_MS) return;
        const started = readHealth(origin, fetchImpl);
        read = started;
        reading.set(origin, started);
        void started.finally(() => { if (reading.get(origin) === started) reading.delete(origin); });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([read, new Promise<void>((resolve) => { timer = setTimeout(resolve, HEALTH_WAIT_MS); })]);
    clearTimeout(timer);
}

/** Throws NodeTooOldError, having sent nothing, when the server at `url` was heard below the minimum. */
export function refuseIfNodeTooOld(url: string): void {
    const version = tooOldVersionOf(url);
    if (typeof version === 'string') throw new NodeTooOldError(version);
}

/** Tests only: forget everything heard. */
export function resetNodeVersionGateForTests(): void {
    heard.clear();
    reading.clear();
    failedAt.clear();
    listeners.clear();
}
