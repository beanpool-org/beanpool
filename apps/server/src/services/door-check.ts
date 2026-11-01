/**
 * The person check at the 12-words door on a busy day (scratch/global-node/DESIGN-global-two-doors-fable.md §5, changed by
 * Marty on 2026-11-01: REQUIRED there, not a discount, because a discount stops no bot). Cloudflare Turnstile, run on a
 * static page of its own on another origin (apps/door-check), never on a node's origin, whose policy forbids third-party
 * script because that origin holds the seed. The web app reaches it by a full-page hop and gets the token back in the URL
 * fragment; the phone opens the same page in an embedded browser, at the tap that needs it.
 *
 * ## Who it applies to
 *
 * Only a node with the profile switch `doorCheck` on (global by default, an owners' setting) AND all three keys in .env
 * (TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, TURNSTILE_PAGE_URL). Otherwise nothing here runs and no join ever hears of
 * it: no node depends on Cloudflare unless its operator chose to. Only the 12-words door, and only from the level the
 * door's numbers name (`checkFromLevel`, engine/door-signal.ts). The sign-in door never needs it.
 *
 * ## What a token buys
 *
 * `POST /api/join/work { door: 'words', turnstile }`: siteverify, then `success`, this check page's `hostname`, action
 * `join`, `cdata` naming the key that signed the request, made in the last 300 s, and seen here only once (a local set,
 * as well as Cloudflare's own rule, so a replay costs no call). A token that passes becomes a pass for that key, in memory,
 * for the challenge's ten minutes, so a challenge the node refuses is replaced without another check. A restart forgets
 * passes, and the member takes the check again.
 *
 * The join reads the pass itself, at the level of that moment, before the work is checked: asking only at the work route
 * would let a script stock up on challenges while the door is quiet and spend them when it is busy.
 *
 * ## An outage shuts nobody out, and no client can fake one
 *
 * When Cloudflare can't be asked the requirement drops, the log says so, and the door runs on work alone, as it did before
 * this existed. Only `siteverifyUp` decides that, and it decides from one thing: whether siteverify answers the server's
 * OWN probe, a fixed token no client ever sees, sent with this server's secret. Anything a client sends can only ever be
 * refused: no token is a refusal, and a junk token is answered "invalid", which is an answer, so Cloudflare is up and the
 * join is refused. A client's token whose call gets no answer proves nothing either: it only asks for the probe sooner,
 * at most every PROBE_FORCED_EVERY_MS and one at a time, and the probe decides. So a client can choose when the question
 * is asked, never its answer. What it would take to open the door is breaking this server's own path to Cloudflare, and
 * then the door still asks for the work, and the ceilings hold.
 *
 * A wrong secret reads as the same outage, on purpose, and says so in the log: every token would fail, which would turn
 * every real person away from the words door on a busy day. No client can cause it.
 */
import crypto from 'node:crypto';
import { DOOR_WORK_MAX_LEVEL, DOOR_WORK_TTL_MS } from '@beanpool/core';
import { getProfileSwitches } from '../config/node-profile.js';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const DOOR_CHECK_ACTION = 'join';
/** How much of the joining key the page's `cdata` carries: 128 bits, more than anyone can match by trying keys. */
export const DOOR_CHECK_CDATA_CHARS = 32;
const SITEVERIFY_TIMEOUT_MS = 2_000;
/** A token is good for this long from when it was made (Cloudflare's rule; checked here as well). */
export const TOKEN_LIFE_MS = 300_000;
/** Cloudflare's own limit on a token. Longer is junk, and is never sent. */
const MAX_TOKEN_CHARS = 2_048;
/** How long a pass lasts: the challenge it was issued with. */
export const PASS_LIFE_MS = DOOR_WORK_TTL_MS;
/** How long the probe's answer stands, either way: an outage ends here within a minute of Cloudflare coming back. */
export const PROBE_STANDS_MS = 60_000;
/** The least time between probes, however many clients' tokens went unanswered. */
export const PROBE_FORCED_EVERY_MS = 10_000;
/** The probe's token: not a token, and fixed, so that no client's input is ever part of the outage's evidence. */
const PROBE_TOKEN = 'beanpool-door-check-probe';
/** At most this many kept: past it the oldest go, which costs a member one more check and no more. */
const MAX_REMEMBERED = 50_000;

export const DOOR_CHECK_ENV = { siteKey: 'TURNSTILE_SITE_KEY', secret: 'TURNSTILE_SECRET_KEY', page: 'TURNSTILE_PAGE_URL' } as const;

/** What a client needs to reach the check, and all it ever hears about it. */
export interface DoorCheckPage {
    siteKey: string;
    page: string;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    console.warn(message);
}

interface DoorCheckKeys extends DoorCheckPage {
    secret: string;
    host: string;
}

/** The three keys, or null when this node doesn't have them all. Read per request, as the profile's switches are. */
function doorCheckKeys(env: NodeJS.ProcessEnv = process.env): DoorCheckKeys | null {
    const [siteKey, secret, page] = [env[DOOR_CHECK_ENV.siteKey], env[DOOR_CHECK_ENV.secret], env[DOOR_CHECK_ENV.page]].map((v) => v?.trim() ?? '');
    if (!siteKey && !secret && !page) return null;
    if (!siteKey || !secret || !page) {
        warnOnce('⚠️  The door\'s person check needs all three of TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY and TURNSTILE_PAGE_URL, so it is off.');
        return null;
    }
    let url: URL;
    try { url = new URL(page); } catch { url = new URL('about:blank'); }
    if (url.protocol !== 'https:') {
        warnOnce('⚠️  TURNSTILE_PAGE_URL is not an https address, so the door\'s person check is off.');
        return null;
    }
    return { siteKey, secret, page, host: url.hostname };
}

/** The check a 12-words join at `level` must pass here, or null when it needs none. */
export function doorCheckAsked(level: number | null, fromLevel: number): DoorCheckPage | null {
    if (level === null || level < Math.max(1, fromLevel) || fromLevel > DOOR_WORK_MAX_LEVEL) return null;
    if (!getProfileSwitches().doorCheck) return null;
    const keys = doorCheckKeys();
    return keys ? { siteKey: keys.siteKey, page: keys.page } : null;
}

// ── Asking Cloudflare ─────────────────────────────────────────────────────────────────────────

interface SiteverifyAnswer {
    success?: unknown;
    hostname?: unknown;
    action?: unknown;
    cdata?: unknown;
    challenge_ts?: unknown;
    'error-codes'?: unknown;
}

/** The answer, or null for none: unreachable, too slow, or not its JSON. Never throws. */
async function siteverify(secret: string, token: string, idempotencyKey?: string): Promise<SiteverifyAnswer | null> {
    const form = new URLSearchParams({ secret, response: token });
    if (idempotencyKey) form.set('idempotency_key', idempotencyKey);
    try {
        const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS), redirect: 'error' });
        const body = await res.json() as SiteverifyAnswer | null;
        return body && typeof body === 'object' ? body : null;
    } catch {
        return null;
    }
}

const hasCode = (a: SiteverifyAnswer, ...codes: string[]): boolean =>
    Array.isArray(a['error-codes']) && a['error-codes'].some((c) => codes.includes(c as string));

/** Cloudflare's own trouble, or this server's secret: nothing to do with the token that was asked about. */
const notAboutTheToken = (a: SiteverifyAnswer): boolean => hasCode(a, 'internal-error', 'missing-input-secret', 'invalid-input-secret');

// ── Whether Cloudflare can be asked ───────────────────────────────────────────────────────────

let health: { up: boolean; at: number } | null = null;
let probing: Promise<boolean> | null = null;

async function probe(secret: string): Promise<boolean> {
    // Twice, so one lost packet or one stalled moment on this server doesn't open the door.
    for (let attempt = 0; attempt < 2; attempt++) {
        const answer = await siteverify(secret, PROBE_TOKEN);
        if (answer && !notAboutTheToken(answer)) return true;
        if (answer && hasCode(answer, 'missing-input-secret', 'invalid-input-secret')) {
            warnOnce('⚠️  Cloudflare refused TURNSTILE_SECRET_KEY, so the door\'s person check can\'t run. Check the key in .env.');
        }
    }
    return false;
}

/**
 * Whether siteverify answers this server's own probe (the file's head: the one thing that can drop the requirement). A
 * standing answer holds for PROBE_STANDS_MS; `soon` (a client's token went unanswered) asks after PROBE_FORCED_EVERY_MS.
 * One probe at a time. Says so in the log when it changes.
 */
export async function siteverifyUp(soon = false, now = Date.now()): Promise<boolean> {
    if (health && now >= health.at && now - health.at < (soon ? PROBE_FORCED_EVERY_MS : PROBE_STANDS_MS)) return health.up;
    const keys = doorCheckKeys();
    if (!keys) return true;
    probing ??= probe(keys.secret).then((up) => {
        if (health ? health.up !== up : !up) {
            if (up) console.log('🚪 Cloudflare answers again, so the door\'s person check is back on.');
            else console.warn('⚠️  Cloudflare can\'t be asked to check tokens, so the 12-words door isn\'t asking for its person check. The work and the ceilings still hold. Asked again in a minute.');
        }
        health = { up, at: Date.now() };
        return up;
    }).finally(() => { probing = null; });
    return probing;
}

// ── A token, and what it buys ─────────────────────────────────────────────────────────────────

const spentTokens = new Map<string, number>();
const passes = new Map<string, number>();

function remember(map: Map<string, number>, key: string, until: number, now: number): void {
    if (map.size >= MAX_REMEMBERED) {
        for (const [k, t] of map) if (t <= now) map.delete(k);
        while (map.size >= MAX_REMEMBERED) map.delete(map.keys().next().value as string);
    }
    map.set(key, until);
}

/** This key passed a check in the last ten minutes. */
export function doorCheckPassed(key: string, now = Date.now()): boolean {
    const until = passes.get(key);
    if (until === undefined) return false;
    if (until > now) return true;
    passes.delete(key);
    return false;
}

/** A join went through: the pass is done with. */
export function forgetDoorCheckPass(key: string): void {
    passes.delete(key);
}

export type DoorCheckVerdict =
    /** It passed, and `key` has a pass. */
    | 'passed'
    /** Cloudflare answered, or the token never needed asking about: it does not count. */
    | 'failed'
    /** No answer about this token, which says nothing about it, nor about Cloudflare (`siteverifyUp` says that). */
    | 'unknown';

/** Check the token a work request carries, for the key that signed it. Never throws. */
export async function verifyDoorCheck(token: unknown, key: string, now = Date.now()): Promise<DoorCheckVerdict> {
    const keys = doorCheckKeys();
    if (!keys) return 'unknown';
    if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token) || token.length > MAX_TOKEN_CHARS) return 'failed';
    const id = crypto.createHash('sha256').update(token).digest('base64url');
    const spentUntil = spentTokens.get(id);
    if (spentUntil !== undefined && spentUntil > now) return 'failed';
    // Marked before the call, so two requests at once can't both spend it.
    remember(spentTokens, id, now + TOKEN_LIFE_MS, now);
    const retryKey = crypto.randomUUID();
    let answer = await siteverify(keys.secret, token, retryKey);
    if (answer && hasCode(answer, 'internal-error')) answer = await siteverify(keys.secret, token, retryKey);
    if (!answer || notAboutTheToken(answer)) {
        // Not judged, so not spent: the member may send it again.
        spentTokens.delete(id);
        return 'unknown';
    }
    const made = typeof answer.challenge_ts === 'string' ? Date.parse(answer.challenge_ts) : NaN;
    const good = answer.success === true && answer.hostname === keys.host && answer.action === DOOR_CHECK_ACTION
        && answer.cdata === key.slice(0, DOOR_CHECK_CDATA_CHARS) && now - made <= TOKEN_LIFE_MS;
    if (!good) return 'failed';
    remember(passes, key, now + PASS_LIFE_MS, now);
    return 'passed';
}

export function _resetDoorCheckForTests(): void {
    spentTokens.clear();
    passes.clear();
    health = null;
    probing = null;
    warned.clear();
}
