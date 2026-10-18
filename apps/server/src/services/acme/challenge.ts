/**
 * The http-01 challenge answer on the plain listener, and the self-check that fetches it from outside first (design
 * scratch/global-node/DESIGN-https-anywhere-fable.md §1 and §6).
 *
 * `GET /.well-known/acme-challenge/<token>` answers the key authorisation of a token this server put here in the last 10
 * minutes, as text/plain, never cached. Anything else under that path is 404 with an empty body: no query, no other method,
 * no redirect, never handed to the HTTPS app, never logged. http-server.ts mounts it before everything else, so neither
 * the tunnel's delegation nor the CF_RECORD_NAME redirect ever sees a challenge request.
 *
 * The self-check fetches the same URL the CA will, http://<identifier>:80/…, before anything is sent to the CA: an
 * identifier it cannot reach is submitted at most once a day (schedule.ts), which keeps a node far under the CA's
 * failed-validation limits and makes a typo cheap, while a home router without NAT loopback (the check fails from inside,
 * the CA reaches the server from outside) still gets its certificate. It answers in words what is missing.
 */

import type Koa from 'koa';

export const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
/** How long a token this server created is answered. */
export const CHALLENGE_TTL_MS = 10 * 60_000;
/** The self-check's wait for an answer from port 80. */
export const SELF_CHECK_TIMEOUT_MS = 10_000;
/** RFC 8555 §8.3: a token is base64url. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

const answers = new Map<string, { keyAuthorization: string; expiresAt: number }>();

/** Answer `token` with `keyAuthorization` for the next 10 minutes. */
export function putChallenge(token: string, keyAuthorization: string, now = Date.now()): void {
    if (!TOKEN_RE.test(token)) throw new Error('ACME: a challenge token that is not base64url');
    for (const [t, a] of answers) if (a.expiresAt <= now) answers.delete(t);
    answers.set(token, { keyAuthorization, expiresAt: now + CHALLENGE_TTL_MS });
}

export function removeChallenge(token: string): void {
    answers.delete(token);
}

/** The key authorisation for `token`, or null for a token this server did not create in the last 10 minutes. */
export function challengeAnswer(token: string, now = Date.now()): string | null {
    const a = answers.get(token);
    if (!a) return null;
    if (a.expiresAt <= now) {
        answers.delete(token);
        return null;
    }
    return a.keyAuthorization;
}

/** The challenge route, for the plain listener, first in its chain. Every other path goes on unchanged. */
export function acmeChallengeMiddleware(): Koa.Middleware {
    return async (ctx, next) => {
        if (!ctx.path.startsWith(CHALLENGE_PREFIX)) return next();
        const token = ctx.path.slice(CHALLENGE_PREFIX.length);
        const answer = (ctx.method === 'GET' || ctx.method === 'HEAD') && !ctx.querystring && TOKEN_RE.test(token)
            ? challengeAnswer(token) : null;
        ctx.set('Cache-Control', 'no-store');
        if (answer === null) {
            ctx.status = 404;
            ctx.body = '';
            return;
        }
        ctx.status = 200;
        ctx.type = 'text/plain';
        ctx.body = answer;
    };
}

/** What a self-check is told about one identifier: its host as signatures carry it, and whether it is an IP literal. */
export interface ChallengeTarget {
    host: string;
    type: 'dns' | 'ip';
}

/** http://<host>:80, the origin the CA fetches a challenge from. Tests point it at their own listener. */
let challengeOrigin = (target: ChallengeTarget): string => `http://${target.host}`;

/** Tests only: fetch self-checks from this origin instead of the identifier's port 80 (null puts it back). */
export function _setChallengeOriginForTests(fn: ((target: ChallengeTarget) => string) | null): void {
    challengeOrigin = fn ?? ((target) => `http://${target.host}`);
}

/**
 * Fetch `token` from the target's port 80 as the CA will, and compare the answer with `keyAuthorization`. Null when it
 * matches; otherwise what is missing, in words the owner can act on.
 */
export async function selfCheckChallenge(target: ChallengeTarget, token: string, keyAuthorization: string): Promise<string | null> {
    const url = `${challengeOrigin(target)}${CHALLENGE_PREFIX}${token}`;
    let res: Response;
    try {
        res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(SELF_CHECK_TIMEOUT_MS) });
    } catch (err) {
        return unreachableWords(target, err);
    }
    let body = '';
    try { body = (await res.text()).slice(0, 4096).trim(); } catch { /* an empty answer */ }
    if (res.status === 200 && body === keyAuthorization) return null;
    return target.type === 'ip'
        ? `${target.host} answers on port 80, but not as this server (HTTP ${res.status}): the address may belong to another machine, or a proxy in front answers instead`
        : `${target.host} answers on port 80, but not as this server (HTTP ${res.status}): point its A record at this server's public IP`;
}

function unreachableWords(target: ChallengeTarget, err: unknown): string {
    const e = err as { name?: string; code?: string; cause?: { code?: string } };
    const code = e?.cause?.code ?? e?.code ?? (e?.name === 'TimeoutError' ? 'ETIMEDOUT' : '');
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') {
        return `${target.host} does not point at any server yet: make an A record for it with this server's public IP`;
    }
    if (target.type === 'ip') {
        return `port 80 at ${target.host} is not reachable from the Internet${code ? ` (${code})` : ''}: open port 80 in the firewall, or check that this is the server's public IP`;
    }
    return `${target.host} does not reach this server on port 80${code ? ` (${code})` : ''}: check that its A record points at this server and that port 80 is open`;
}
