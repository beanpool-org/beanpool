/**
 * What a member's request may be told when something it asked for throws (FABLE-sec-errors MEDIUM-3, 2026-10-01).
 *
 * A route's catch-all used to answer `{ error: e.message }`. That is right for the refusals the engine means for the
 * member ("Group not found", "Only a convenor can do that") and wrong for everything else that can be thrown on the
 * way: the database's own text (`UNIQUE constraint failed: groups.slug`, `no such column …`), a bug's TypeError with
 * its property names, a network error with an address in it (`connect ECONNREFUSED 10.0.0.5:443`). Those are server
 * faults. The member is told so in fixed words, and the text goes to the server's log.
 *
 * Two layers:
 *  - memberErrorText(e, fallback) at a member route's catch: the thrown thing's own words only when it is a plain
 *    refusal, judged by what it is (a SqliteError, TypeError, RangeError, a system error) and by what it says
 *    (looksLikeServerFault).
 *  - scrubServerFaults, a middleware over every answer outside the operator's own routes: an `error` or `message`
 *    that reads as a server fault becomes SERVER_FAULT_TEXT, answered 500, wherever it came from (an engine function
 *    that returned `{ error: e.message }`, a route that never used memberErrorText).
 * The operator's routes (/api/local/…, /api/admin/…) keep the detail: the operator owns the box, and the registrar's
 * or the tunnel's own words are what they need to act on (NOTE-2).
 */
import type Koa from 'koa';
import { sanitizeMessage } from '../sanitize-message.js';

/** The words a member gets for a server fault. */
export const SERVER_FAULT_TEXT = 'Something went wrong on the server. Please try again.';

/** Kinds of error that are never a refusal written for a member. */
const FAULT_NAMES = new Set([
    'SqliteError', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError',
    'AggregateError', 'AbortError', 'TimeoutError', 'SystemError',
]);

/**
 * Text no refusal written for a member contains: the database's and the driver's words, a JavaScript engine's,
 * a network or file system error code, an IPv4 address. Checked against every literal message the server, the engine
 * and core throw or answer with: none matches.
 */
const SERVER_FAULT_WORDS = new RegExp([
    String.raw`\bSQLITE_[A-Z]+`, 'constraint failed', String.raw`no such (?:table|column|function|index|savepoint)`,
    'datatype mismatch', 'can only bind', 'parameter values', String.raw`database (?:is locked|disk image)`, String.raw`disk I/O error`,
    String.raw`Cannot (?:read|set) propert`, 'Cannot destructure', String.raw`is not (?:a function|iterable|a constructor|defined)`,
    String.raw`Unexpected (?:token|end of JSON)`, 'JSON at position', 'Invalid time value', 'Invalid array length',
    'Maximum call stack',
    String.raw`\bE(?:CONNREFUSED|CONNRESET|NOTFOUND|TIMEDOUT|AI_AGAIN|HOSTUNREACH|NETUNREACH|ADDRINUSE|ACCES|NOENT|PERM|ISDIR|PIPE)\b`,
    'getaddrinfo', 'socket hang up', 'fetch failed',
    String.raw`(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])`,
].join('|'), 'i');

/** Does this text read as a server fault rather than a refusal meant for a member? */
export function looksLikeServerFault(text: string): boolean {
    return SERVER_FAULT_WORDS.test(text);
}

/** Is this thrown value a server fault (the database, a bug, the network) rather than a refusal meant for a member? */
export function isServerFault(e: unknown): boolean {
    if (!(e instanceof Error)) return true;
    const err = e as Error & { code?: unknown; errno?: unknown; syscall?: unknown };
    if (FAULT_NAMES.has(err.name)) return true;
    if (typeof err.errno === 'number' || typeof err.syscall === 'string') return true;
    if (typeof err.code === 'string' && /^(?:SQLITE_|ERR_)/.test(err.code)) return true;
    return typeof err.message !== 'string' || err.message === '' || looksLikeServerFault(err.message);
}

/**
 * The words a member route may answer with for `e`: its own when it is a refusal meant for the member, else `fallback`
 * (and the real text in the server's log, sanitised).
 */
export function memberErrorText(e: unknown, fallback: string): string {
    if (!isServerFault(e)) return (e as Error).message;
    if (!(e instanceof Error) || e.message) logServerFault(e);
    return fallback;
}

function logServerFault(e: unknown): void {
    let text: string;
    try {
        text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    } catch {
        text = 'an unprintable value';
    }
    console.error(`[MemberRoute] A server fault, answered in general words: ${sanitizeMessage(text)}`);
}

/** The operator's own routes, which keep an error's detail. */
function isOperatorPath(path: string): boolean {
    return path.startsWith('/api/local/') || path.startsWith('/api/admin/');
}

/**
 * The net under every member route: an answer's `error` or `message` that reads as a server fault is replaced by
 * SERVER_FAULT_TEXT and answered 500 (a fault, not the member's mistake, so an app retries rather than gives up).
 */
export function scrubServerFaults(): Koa.Middleware {
    return async (ctx, next) => {
        await next();
        if (ctx.status < 400 || isOperatorPath(ctx.path)) return;
        const body = ctx.body as Record<string, unknown> | null | undefined;
        if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body) || typeof (body as any).pipe === 'function') return;
        let scrubbed: Record<string, unknown> | null = null;
        for (const field of ['error', 'message'] as const) {
            const text = body[field];
            if (typeof text === 'string' && looksLikeServerFault(text)) {
                console.error(`[MemberRoute] ${ctx.method} ${ctx.path} answered a server fault, now in general words: ${sanitizeMessage(text)}`);
                // A copy: the body may be an object a route shares between answers.
                scrubbed = { ...(scrubbed ?? body), [field]: SERVER_FAULT_TEXT };
            }
        }
        if (scrubbed) {
            ctx.status = 500;
            ctx.body = scrubbed;
        }
    };
}
