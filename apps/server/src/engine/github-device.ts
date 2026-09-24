import crypto from 'node:crypto';
import {
    getConfiguredAudiences,
    NONCE_TTL_MS,
    SsoProviderUnavailableError,
    SsoVerificationError,
    type SsoIdentity,
} from '../sso.js';

/**
 * GitHub sign-in, run BY THE NODE (design §2.4, sign-in hardening S2).
 *
 * WHY THE NODE RUNS IT
 * --------------------
 * GitHub OAuth Apps are not OIDC. There is no signed token to check: `GET api.github.com/user` answers
 * for ANY token, minted for any app or typed in as a personal access token, and the endpoint that says
 * which app a token belongs to needs the client secret, which a node run by strangers must never hold
 * (D5). So a token handed to the node proves nothing, and a node that accepted one let anybody who had
 * ever seen a member's GitHub token (any app they had authorised, any node they had enrolled at) rebuild
 * that member's key.
 *
 * The one proof a secret-less node can trust is a token it obtained ITSELF. The device flow takes only
 * `client_id`, `device_code` and `grant_type`, so the node asks GitHub for the code, the member types it
 * at github.com, and the node collects the token. The node chose the audience (our client id), the token
 * never exists anywhere a third party could copy it, and the client hands in a session id rather than a
 * credential.
 *
 * WHAT IS KEPT
 * ------------
 * The access token is used for two reads (`/user`, then `/user/emails` if the profile has no public
 * address) and DROPPED: never stored on the session, never logged, never returned. What the session
 * keeps is `{ sub, email? }`: the numeric user id (the same `sub` the phone-run flow used, so every
 * GitHub keeper enrolled before this still opens) and an address for display.
 *
 * In memory, like the nonce map in sso.ts and for the same reasons: a session outliving a restart buys
 * nothing, since the member would have to still be mid-sign-in, and persisting it would put a
 * short-lived proof of identity in the backup set.
 *
 * THE SESSION IS BOUND TO A SUBJECT
 * ---------------------------------
 * The member's key, a recovering device's ephemeral key, or `open-join:<key>` at the global door: the
 * same subjects sso.ts binds nonces to. Only that subject can poll or consume it, and a wrong subject
 * never consumes it (the denial-of-service reasoning in sso.ts's consumeNonce). A consumed session is
 * gone, and an unconsumed result expires after NONCE_TTL_MS.
 */

/**
 * Carried by every sign-in nonce answer as `githubFlow`, so an app can tell a node that runs the GitHub
 * sign-in itself from one that does not, and never sends a GitHub token to either.
 */
export const GITHUB_FLOW = 'node';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const USER_EMAILS_URL = 'https://api.github.com/user/emails';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const SCOPES = 'read:user user:email';

/** Per request to GitHub. The member is waiting on the other end of every one of these. */
const GITHUB_TIMEOUT_MS = 10_000;

/** GitHub's own defaults, used when an answer leaves them out. */
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_SECONDS = 900;

/** What GitHub adds to the interval on `slow_down` (RFC 8628 §3.5). */
const SLOW_DOWN_MS = 5_000;

/** Throttled sweep, and a ceiling past which no new session starts: every session is a GitHub request. */
const SWEEP_THRESHOLD = 1000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_LIVE_SESSIONS = 10_000;

const RATE_LIMITED = 'GitHub is limiting requests from this node right now. Please try again in a minute.';

interface GithubSession {
    subject: string;
    clientId: string;
    /** Cleared once the flow finishes: it is what GitHub exchanges for a token. */
    deviceCode: string;
    intervalMs: number;
    /** When GitHub's device code expires. */
    expiresAt: number;
    /** The last time this node asked GitHub. Starts at the start, so the first real poll waits an interval. */
    lastPollAt: number;
    /** A poll to GitHub is in flight; another poll meanwhile answers pending without a second request. */
    polling: boolean;
    /** The only thing kept from a finished sign-in. */
    result?: { sub: string; email?: string };
    resultAt?: number;
    resultExpiresAt?: number;
}

export interface GithubSessionStart {
    sessionId: string;
    userCode: string;
    verificationUri: string;
    expiresInSeconds: number;
    intervalSeconds: number;
}

export type GithubPoll =
    | { status: 'pending'; intervalSeconds: number }
    | { status: 'ok'; sub: string; email?: string }
    | { status: 'denied' }
    | { status: 'expired' };

const sessions = new Map<string, GithubSession>();
/** One live session per subject: starting again replaces the old one. */
const sessionBySubject = new Map<string, string>();
let lastSweep = 0;

let clock: () => number = () => Date.now();

/** Tests move time instead of waiting out GitHub's interval. Omit `fn` to put the real clock back. */
export function _setGithubDeviceClockForTests(fn?: () => number): void {
    clock = fn ?? (() => Date.now());
}

export function _clearGithubSessionsForTests(): void {
    sessions.clear();
    sessionBySubject.clear();
    lastSweep = 0;
}

/** The session object itself, so a test can prove the access token is not reachable from it. */
export function _githubSessionForTests(sessionId: string): unknown {
    return sessions.get(sessionId);
}

function forget(sessionId: string): void {
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (session && sessionBySubject.get(session.subject) === sessionId) sessionBySubject.delete(session.subject);
}

function isDead(session: GithubSession, now: number): boolean {
    if (session.result) return (session.resultExpiresAt ?? 0) <= now;
    return session.expiresAt <= now;
}

function sweep(now: number, force: boolean): void {
    if (!force && (sessions.size <= SWEEP_THRESHOLD || now - lastSweep <= SWEEP_INTERVAL_MS)) return;
    lastSweep = now;
    for (const [id, session] of sessions) if (isDead(session, now)) forget(id);
}

/**
 * One request to GitHub, JSON both ways. Anything that is not an answer (unreachable, timed out, a 5xx,
 * a rate limit, a body that is not JSON) is SsoProviderUnavailableError: GitHub failed, not the member.
 *
 * `bearer` is sent in the Authorization header and nowhere else. No message built here includes it.
 */
async function askGithub(url: string, init: { body?: Record<string, string>; bearer?: string }): Promise<{ status: number; body: any }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'BeanPool-Node' };
        if (init.body) headers['Content-Type'] = 'application/json';
        if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
        let res: Response;
        try {
            res = await fetch(url, {
                method: init.body ? 'POST' : 'GET',
                headers,
                body: init.body ? JSON.stringify(init.body) : undefined,
                signal: controller.signal,
            });
        } catch {
            throw new SsoProviderUnavailableError('GitHub could not be reached. Please try again in a minute.');
        }
        if (res.status >= 500) {
            throw new SsoProviderUnavailableError(`GitHub is not answering right now (HTTP ${res.status}). Please try again in a minute.`);
        }
        if (res.status === 429) throw new SsoProviderUnavailableError(RATE_LIMITED);
        let body: any;
        try {
            body = await res.json();
        } catch {
            throw new SsoProviderUnavailableError('GitHub sent an answer this node could not read. Please try again in a minute.');
        }
        // GitHub answers a rate limit with a 403 as often as a 429: `x-ratelimit-remaining: 0` for the
        // primary limit, `retry-after` or a message naming it for a secondary one. Its body has a `message`
        // and no OAuth `error`, so taken as an answer it would end a sign-in the member is still finishing.
        if (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')
            || /rate limit/i.test(String(body?.message ?? '')))) {
            throw new SsoProviderUnavailableError(RATE_LIMITED);
        }
        return { status: res.status, body };
    } finally {
        clearTimeout(timeout);
    }
}

function positiveSeconds(value: unknown, fallback: number, max: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.ceil(n), max);
}

/**
 * Ask GitHub for a device code, bound to `subject`. The member types `userCode` at `verificationUri`.
 */
export async function startGithubSession(subject: string): Promise<GithubSessionStart> {
    if (!subject) throw new SsoVerificationError('A GitHub sign-in must be bound to a member.');
    const clientId = getConfiguredAudiences('github')[0];
    if (!clientId) {
        throw new SsoVerificationError('This node has no GitHub client ID configured, so it cannot run a GitHub sign-in.');
    }

    const now = clock();
    sweep(now, sessions.size >= MAX_LIVE_SESSIONS);
    if (sessions.size >= MAX_LIVE_SESSIONS) {
        throw new SsoProviderUnavailableError('Too many GitHub sign-ins are in progress on this node. Please try again in a few minutes.');
    }

    const { body } = await askGithub(DEVICE_CODE_URL, { body: { client_id: clientId, scope: SCOPES } });
    if (body?.error) {
        // `device_flow_disabled` is a setting on the OAuth app, nothing the member did.
        throw new SsoVerificationError(body.error === 'device_flow_disabled'
            ? 'GitHub sign-in is not enabled for this app yet.'
            : `GitHub did not start the sign-in (${String(body.error_description || body.error).slice(0, 200)}).`);
    }
    const deviceCode = body?.device_code;
    const userCode = body?.user_code;
    const verificationUri = body?.verification_uri;
    // The URI goes to the phone, which opens it: only ever GitHub's own page.
    if (typeof deviceCode !== 'string' || !deviceCode || deviceCode.length > 512
        || typeof userCode !== 'string' || !userCode || userCode.length > 64
        || typeof verificationUri !== 'string' || !verificationUri.startsWith('https://github.com/') || verificationUri.length > 256) {
        throw new SsoProviderUnavailableError('GitHub did not issue a usable sign-in code. Please try again in a minute.');
    }
    const intervalSeconds = positiveSeconds(body.interval, DEFAULT_INTERVAL_SECONDS, 60);
    const expiresInSeconds = positiveSeconds(body.expires_in, DEFAULT_EXPIRES_SECONDS, 1800);

    const previous = sessionBySubject.get(subject);
    if (previous) forget(previous);
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const startedAt = clock();
    sessions.set(sessionId, {
        subject,
        clientId,
        deviceCode,
        intervalMs: intervalSeconds * 1000,
        expiresAt: startedAt + expiresInSeconds * 1000,
        lastPollAt: startedAt,
        polling: false,
    });
    sessionBySubject.set(subject, sessionId);
    return { sessionId, userCode, verificationUri, expiresInSeconds, intervalSeconds };
}

/** Deliberately one answer for "no such session" and "not yours": the id is not an oracle. */
function sessionFor(sessionId: string, subject: string): GithubSession {
    const session = typeof sessionId === 'string' && sessionId ? sessions.get(sessionId) : undefined;
    if (!session || !subject || session.subject !== subject) {
        throw new SsoVerificationError('There is no GitHub sign-in in progress for this device. Start again.');
    }
    return session;
}

/** Read who signed in with a token this node just obtained. The token goes no further than this. */
async function readGithubUser(accessToken: string): Promise<{ sub: string; email?: string }> {
    const user = await askGithub(USER_URL, { bearer: accessToken });
    if (user.status !== 200) {
        throw new SsoVerificationError(`GitHub would not say who signed in (HTTP ${user.status}). Start again.`);
    }
    const id = user.body?.id;
    const sub = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id)
        : typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id) ? id
        : '';
    if (!sub) throw new SsoVerificationError('GitHub did not return a user id, so this account cannot be used yet.');

    let email = typeof user.body?.email === 'string' && user.body.email ? user.body.email : undefined;
    if (!email) {
        // Display only, so a failure here costs the member a label, never the sign-in.
        try {
            const emails = await askGithub(USER_EMAILS_URL, { bearer: accessToken });
            if (emails.status === 200 && Array.isArray(emails.body)) {
                const primary = emails.body.find((e: any) => e?.primary && e?.verified) ?? emails.body.find((e: any) => e?.primary);
                if (typeof primary?.email === 'string' && primary.email) email = primary.email;
            }
        } catch {
            // As above.
        }
    }
    return { sub, email: email && email.length <= 320 ? email : undefined };
}

/**
 * Ask whether the member has finished at GitHub. Answers `pending` WITHOUT asking GitHub while the
 * interval since the last question has not passed, so a phone polling every second never earns
 * `slow_down` and cannot make this node hammer GitHub.
 */
export async function pollGithubSession(sessionId: string, subject: string): Promise<GithubPoll> {
    const session = sessionFor(sessionId, subject);
    const now = clock();

    if (session.result) {
        if ((session.resultExpiresAt ?? 0) <= now) { forget(sessionId); return { status: 'expired' }; }
        return { status: 'ok', sub: session.result.sub, ...(session.result.email ? { email: session.result.email } : {}) };
    }
    if (session.expiresAt <= now) { forget(sessionId); return { status: 'expired' }; }

    const pending = (): GithubPoll => ({ status: 'pending', intervalSeconds: Math.ceil(session.intervalMs / 1000) });
    if (session.polling || now < session.lastPollAt + session.intervalMs) return pending();

    session.polling = true;
    session.lastPollAt = now;
    try {
        let answer: { status: number; body: any };
        try {
            answer = await askGithub(ACCESS_TOKEN_URL, {
                body: { client_id: session.clientId, device_code: session.deviceCode, grant_type: DEVICE_GRANT },
            });
        } catch (e) {
            // A dropped poll is not a failed sign-in: the member may still be typing the code.
            if (e instanceof SsoProviderUnavailableError) return pending();
            throw e;
        }
        const body = answer.body;
        if (typeof body?.access_token === 'string' && body.access_token) {
            // The token lives in this call and in readGithubUser's, and nowhere else.
            let user: { sub: string; email?: string };
            try {
                user = await readGithubUser(body.access_token);
            } catch (e) {
                // GitHub issues one token per device code, so this flow cannot be finished now. However GitHub
                // failed, the member has to start again, and is told so: a "try again in a minute" would send
                // them back to a session that is gone.
                forget(sessionId);
                if (e instanceof SsoProviderUnavailableError) {
                    throw new SsoVerificationError('GitHub could not say who signed in just now. Start the GitHub sign-in again.');
                }
                throw e;
            }
            const doneAt = clock();
            session.deviceCode = '';
            session.result = user.email ? { sub: user.sub, email: user.email } : { sub: user.sub };
            session.resultAt = doneAt;
            session.resultExpiresAt = doneAt + NONCE_TTL_MS;
            return { status: 'ok', ...session.result };
        }
        switch (body?.error) {
            case 'authorization_pending':
                return pending();
            case 'slow_down': {
                const asked = positiveSeconds(body.interval, 0, 120) * 1000;
                session.intervalMs = Math.max(session.intervalMs + SLOW_DOWN_MS, asked);
                return pending();
            }
            case 'access_denied':
                forget(sessionId);
                return { status: 'denied' };
            case 'expired_token':
                forget(sessionId);
                return { status: 'expired' };
            default:
                forget(sessionId);
                throw new SsoVerificationError(`GitHub refused the sign-in (${String(body?.error_description || body?.error || 'no reason given').slice(0, 200)}). Start again.`);
        }
    } finally {
        session.polling = false;
    }
}

/**
 * Spend a finished sign-in: once, by the subject it was started for, before it expires. A wrong subject
 * or an unfinished session is refused WITHOUT consuming it.
 */
export function consumeGithubSession(sessionId: string, subject: string): SsoIdentity {
    const session = sessionFor(sessionId, subject);
    if (!session.result) {
        throw new SsoVerificationError('The GitHub sign-in has not finished yet. Enter the code at GitHub first.');
    }
    const now = clock();
    const result = session.result;
    const expiresAt = session.resultExpiresAt ?? 0;
    forget(sessionId);
    if (expiresAt <= now) {
        throw new SsoVerificationError('The GitHub sign-in has expired. Start again.');
    }
    return {
        provider: 'github',
        sub: result.sub,
        email: result.email,
        audience: session.clientId,
        issuedAt: Math.floor((session.resultAt ?? now) / 1000),
        expiresAt: Math.floor(expiresAt / 1000),
    };
}
