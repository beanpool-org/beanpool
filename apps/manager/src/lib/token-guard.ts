/**
 * What an owner automation token can't do, said before the request goes (node sign-in step 7b-1).
 *
 * A token (server automation-tokens.ts) never passes an owner-only gate (requireAdminRole(['owner']), requirePhoneStepUp),
 * except a backups token on its own ten routes, and every token is refused on signing in, sessions and the token routes
 * themselves (isRefusedToEveryToken). The fleet manager sends a profile's token as `Authorization: Bearer` (node-client
 * buildAdminHeaders), so this wraps fetch once for the page and looks only at requests that carry one:
 *   - a route on OWNER_ONLY_FOR_TOKENS is answered here with a 403 that says an owner's phone is needed, and nothing is
 *     sent to the node;
 *   - a 403 from the node with code `token_not_allowed` (a route this list missed, a conditional owner-only change, or a
 *     read token asked to write) is given the same words.
 * Either way OWNER_PHONE_EVENT tells the page, which offers the phone sign-in (scan the code). A request without a token
 * passes through untouched. The answer is a Response, not a thrown error, so the callers' "node offline" paths never
 * mistake it for a network failure.
 */
import { isAutomationToken } from './node-client';

export const OWNER_PHONE_MESSAGE = "This needs an owner's phone: sign in with your phone (scan the code)";
/** The server's code on a token's 403 (admin-auth.ts TOKEN_REFUSED_CODE). */
export const TOKEN_REFUSED_CODE = 'token_not_allowed';
export const OWNER_PHONE_EVENT = 'bp:owner-phone-needed';

/**
 * Routes no token reaches. Each is owner-only on the server for every scope, or refused to every token; a backups
 * token's own routes (BACKUPS_SCOPE_ROUTES on the server) are not here, so they go to the node, which decides by scope.
 */
const OWNER_ONLY_FOR_TOKENS: readonly RegExp[] = [
    // Refused to every token (isRefusedToEveryToken).
    /^\/api\/local\/admin\/auth(\/|$)/,
    /^\/api\/local\/admin\/automation-tokens/,
    /^\/api\/local\/admin\/2fa\//,
    /^\/api\/local\/admin\/ws-ticket$/,
    /^\/api\/local\/admin\/csrf-token$/,
    // Owner-only whatever is asked (requireAdminRole(['owner']) or requirePhoneStepUp on every request).
    /^\/api\/local\/admin\/stranded-escrows\/[^/]+\/write-off$/,
    /^\/api\/local\/admin\/public-address\/(claim|update|offline)$/,
    /^\/api\/local\/admin\/takeover\//,
    /^\/api\/local\/admin\/standby-health(\/forget)?$/,
    /^\/api\/local\/admin\/snapshots\/config$/,
    /^\/api\/local\/admin\/backup-config$/,
    /^\/api\/local\/admin\/offbox-backups\/(?!(status|list|run|download)$)/,
    /^\/api\/local\/change-password$/,
    /^\/api\/local\/reset$/,
];

export function tokenCannotReach(pathname: string): boolean {
    // The fleet manager reaches another node through its own proxy (node-client resolveNodeApiUrl): /proxy/<scheme>/<host>/...
    const p = pathname.toLowerCase().replace(/^\/proxy\/https?\/[^/]+(?=\/)/, '').replace(/\/+$/, '');
    return OWNER_ONLY_FOR_TOKENS.some(re => re.test(p));
}

/** A token's scope, by its public id (bp_<id>), once a node has said it. Memory only; never the secret. */
const scopes = new Map<string, string>();

function tokenId(token: string): string {
    return token.split('_')[1] ?? '';
}

export function knownTokenScope(token: string | undefined): string | undefined {
    return isAutomationToken(token) ? scopes.get(tokenId(token)) : undefined;
}

function noteScope(token: string, scope: unknown): void {
    if (typeof scope === 'string' && /^[a-z]{1,20}$/.test(scope)) scopes.set(tokenId(token), scope);
}

function bearerOf(input: RequestInfo | URL, init?: RequestInit): string | null {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const auth = headers.get('authorization');
    const m = auth ? /^Bearer\s+(\S+)$/i.exec(auth) : null;
    return m && isAutomationToken(m[1]) ? m[1] : null;
}

function announce(scope?: string): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(OWNER_PHONE_EVENT, { detail: { scope } }));
}

function ownerPhoneResponse(extra: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({ ...extra, error: OWNER_PHONE_MESSAGE, code: TOKEN_REFUSED_CODE, ownerPhoneNeeded: true }), {
        status: 403,
        // Said in the status line too: many callers show `HTTP 403: <statusText>` rather than the body's error.
        statusText: OWNER_PHONE_MESSAGE,
        headers: { 'Content-Type': 'application/json' },
    });
}

export function guardTokenFetch(fetchImpl: typeof fetch): typeof fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const token = bearerOf(input, init);
        if (!token) return fetchImpl(input, init);
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const pathname = new URL(raw, typeof window !== 'undefined' ? window.location.href : 'http://localhost').pathname;
        if (tokenCannotReach(pathname)) {
            announce(knownTokenScope(token));
            return ownerPhoneResponse({ scope: knownTokenScope(token) });
        }
        const res = await fetchImpl(input, init);
        const said = res.headers.get('x-automation-token-scope');
        if (said) noteScope(token, said);
        if (res.status !== 403) return res;
        const body = await res.clone().json().catch(() => null) as { code?: unknown; scope?: unknown } | null;
        if (body?.code !== TOKEN_REFUSED_CODE) return res;
        noteScope(token, body.scope);
        announce(typeof body.scope === 'string' ? body.scope : undefined);
        return ownerPhoneResponse({ scope: body.scope, serverError: (body as { error?: unknown }).error });
    };
}

let installed = false;

/** Wrap the page's fetch once (main.tsx). Requests without a token pass through untouched. */
export function installTokenFetchGuard(): void {
    if (installed || typeof window === 'undefined') return;
    installed = true;
    window.fetch = guardTokenFetch(window.fetch.bind(window));
}
