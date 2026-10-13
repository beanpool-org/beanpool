/**
 * The AI assistant's OAuth 2.1 door (admin MCP design §2, slice S2): how an owner or an admin connects claude.ai or
 * ChatGPT by pasting this node's /mcp address, approving on their PHONE (the QR sign-in with its two-digit number match,
 * settings-signin-pairing.ts) instead of copying a token. This node is its own authorization server; nothing of ours
 * is asked (no registrar, DNS or relay).
 *
 * What lives where:
 * - Registrations (RFC 7591, public clients only) are in memory until used: at most OAUTH_PENDING_MAX waiting, at most
 *   OAUTH_PENDING_PER_ADDRESS of them from one address (an IPv6 /64 is one), each gone after OAUTH_PENDING_TTL_MS unused.
 *   When either is full, the oldest one nobody opened a consent page for makes room, so one address can't keep the door
 *   shut for everyone (#1881 review, finding 5). A grant keeps its client's id, name and redirect address itself.
 * - Consent requests and codes are in memory: a code lives OAUTH_CODE_TTL_MS, is good once, and a second use revokes
 *   the grant the first made (RFC 6749 §4.1.2, OAuth 2.1 §4.1.3).
 * - Grants are this server's own (local config `agentOAuthGrants`, per-server: never in a backup, the stager's copy or
 *   the take-over bundle, so a standby's copy holds none). A grant keeps the SHA-256 of its live refresh token and of the
 *   last few spent ones: a spent one presented again means the token was copied, so the grant is revoked and the owners
 *   are told (sec.agent, high). 30 days without a refresh and it is gone: approve again.
 * - Access tokens live an hour, in memory only: a restart costs the assistant one refresh.
 * Tokens are opaque (bpo_/bpr_ + the grant id + 256 random bits) and stored only as SHA-256, as automation tokens are.
 */
import crypto from 'node:crypto';
import { getLocalConfig, updateLocalConfig, type AgentOAuthGrantRecord } from '../config/local-config.js';
import { nodeRoleOf } from '../engine/node-roles.js';
import { cleanMemberText } from './fence.js';

export const OAUTH_SCOPE = 'agent';
/**
 * Registrations not yet used for a grant: at most this many at once, and this many from one address (its limiter key:
 * an IPv6 /64 is one), each gone after an hour. Full, the oldest unopened one makes room; none unopened → 429.
 * 1,000 is 100 addresses' 10 each (under 1 MB): opening a page is something a client does to its own registration, so
 * at 100 a mere 10 addresses could hold the door shut for an hour (#1881 confirmation, finding 1).
 */
export const OAUTH_PENDING_MAX = 1000;
export const OAUTH_PENDING_PER_ADDRESS = 10;
export const OAUTH_PENDING_TTL_MS = 60 * 60_000;
/** New registrations per client address per minute (as a pairing's creation is braked). */
export const OAUTH_REGISTRATIONS_PER_MINUTE = 10;
/** A consent request waits as long as its phone sign-in does. */
export const OAUTH_REQUEST_TTL_MS = 3 * 60_000;
export const OAUTH_CODE_TTL_MS = 60_000;
export const OAUTH_ACCESS_TTL_MS = 60 * 60_000;
/** A refresh token not used for this long is dead, and its grant with it: approve on the phone again. */
export const OAUTH_REFRESH_IDLE_MS = 30 * 24 * 60 * 60_000;
/** OAuth grants on a node, and per member (as agent tokens: grants-route.ts AGENT_GRANTS_PER_MEMBER). */
export const OAUTH_GRANTS_MAX = 50;
export const OAUTH_GRANTS_PER_MEMBER = 5;
const SPENT_REFRESH_KEPT = 10;
const REDIRECTS_MAX = 5;
const REDIRECT_MAX_CHARS = 512;
export const CLIENT_NAME_MAX = 60;

const sha256Hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const ACCESS_SHAPE = /^bpo_(oa[0-9a-f]{10})_([0-9a-f]{64})$/;
const REFRESH_SHAPE = /^bpr_(oa[0-9a-f]{10})_([0-9a-f]{64})$/;

export const looksLikeOAuthAccessToken = (v: unknown): v is string => typeof v === 'string' && v.startsWith('bpo_');

// ───────────────────────── registrations ─────────────────────────

export interface OAuthClient {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    createdAt: number;
}

/** A waiting registration: the address it came from, and whether a consent page was opened for it. */
type PendingClient = OAuthClient & { from: string; opened: boolean };
const pending = new Map<string, PendingClient>();
const registerBuckets = new Map<string, { count: number; resetAt: number }>();

function prunePending(now: number): void {
    for (const [id, c] of pending) if (now - c.createdAt >= OAUTH_PENDING_TTL_MS) pending.delete(id);
    for (const [k, b] of registerBuckets) if (now >= b.resetAt) registerBuckets.delete(k);
}

/**
 * A redirect address a client may register: https anywhere, or http to this computer only (a desktop assistant's
 * loopback listener, RFC 8252 §7.3). Never a fragment, never credentials in it.
 */
export function redirectAllowed(raw: unknown): raw is string {
    if (typeof raw !== 'string' || !raw || raw.length > REDIRECT_MAX_CHARS) return false;
    let u: URL;
    try { u = new URL(raw); } catch { return false; }
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
}

/** The host a redirect address sends the code to: what the phone and the page show beside the client's own name. */
export function redirectHost(uri: string): string {
    try { return new URL(uri).host.toLowerCase(); } catch { return 'an unknown address'; }
}

export type RegisterResult =
    | { ok: true; client: OAuthClient }
    | { ok: false; status: 400 | 429; error: string; description: string };

export function registerClient(meta: unknown, clientKey: string, now = Date.now()): RegisterResult {
    prunePending(now);
    const bucket = registerBuckets.get(clientKey);
    if (bucket && now < bucket.resetAt && bucket.count >= OAUTH_REGISTRATIONS_PER_MINUTE) {
        return { ok: false, status: 429, error: 'slow_down', description: 'Too many registrations from this address: try again in a minute' };
    }
    const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
    const uris = m.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > REDIRECTS_MAX || !uris.every(redirectAllowed)) {
        return { ok: false, status: 400, error: 'invalid_redirect_uri', description: `Give 1 to ${REDIRECTS_MAX} redirect addresses, each https (or http to localhost)` };
    }
    const grantTypes = m.grant_types;
    if (grantTypes !== undefined && (!Array.isArray(grantTypes) || grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token'))) {
        return { ok: false, status: 400, error: 'invalid_client_metadata', description: 'Only authorization_code and refresh_token' };
    }
    // Room: this address's own oldest unopened registration goes first, then anyone's (the Map keeps insertion order).
    const fromHere = [...pending.values()].filter((p) => p.from === clientKey);
    if (fromHere.length >= OAUTH_PENDING_PER_ADDRESS) {
        const oldest = fromHere.find((p) => !p.opened);
        if (!oldest) return { ok: false, status: 429, error: 'temporarily_unavailable', description: 'Too many assistants from this address are waiting to be approved: approve one on a phone, or try again in an hour' };
        pending.delete(oldest.clientId);
    }
    if (pending.size >= OAUTH_PENDING_MAX) {
        const oldest = [...pending.values()].find((p) => !p.opened);
        if (!oldest) return { ok: false, status: 429, error: 'temporarily_unavailable', description: 'Too many assistants waiting to be approved on this server: try again later' };
        pending.delete(oldest.clientId);
    }
    if (bucket && now < bucket.resetAt) bucket.count++;
    else registerBuckets.set(clientKey, { count: 1, resetAt: now + 60_000 });
    let clientId = `bpc_${crypto.randomBytes(16).toString('hex')}`;
    while (pending.has(clientId)) clientId = `bpc_${crypto.randomBytes(16).toString('hex')}`;
    const client: OAuthClient = {
        clientId,
        clientName: cleanMemberText(typeof m.client_name === 'string' ? m.client_name : '', CLIENT_NAME_MAX),
        redirectUris: [...new Set(uris as string[])],
        createdAt: now,
    };
    pending.set(clientId, { ...client, from: clientKey, opened: false });
    return { ok: true, client };
}

/** A client: a registration still waiting, or one a live grant holds. */
export function findClient(clientId: unknown, now = Date.now()): OAuthClient | null {
    if (typeof clientId !== 'string' || !clientId) return null;
    prunePending(now);
    const p = pending.get(clientId);
    if (p) return { clientId: p.clientId, clientName: p.clientName, redirectUris: p.redirectUris, createdAt: p.createdAt };
    const g = grantRecords().find((x) => x.clientId === clientId);
    return g ? { clientId: g.clientId, clientName: g.clientName, redirectUris: [g.redirectUri], createdAt: g.createdAt } : null;
}

export const pendingRegistrations = (now = Date.now()): number => { prunePending(now); return pending.size; };
/** A registration no grant holds yet: nobody has approved it on a phone, so its redirect address is only its own word. */
export const isPendingRegistration = (clientId: string): boolean => pending.has(clientId);
/** A consent page was opened for it: it is no longer the first to make room. */
export function markRegistrationOpened(clientId: string): void {
    const p = pending.get(clientId);
    if (p) p.opened = true;
}

// ───────────────────────── consent requests and codes ─────────────────────────

export interface ConsentRequest {
    /** The phone sign-in pairing that carries this request (its id). */
    pairingId: string;
    clientId: string;
    clientName: string;
    redirectUri: string;
    state: string | null;
    codeChallenge: string;
    resource: string;
    createdAt: number;
}

const requests = new Map<string, ConsentRequest>();

export function holdConsentRequest(r: ConsentRequest): void {
    const now = r.createdAt;
    for (const [id, x] of requests) if (now - x.createdAt >= OAUTH_REQUEST_TTL_MS) requests.delete(id);
    requests.set(r.pairingId, r);
}

export function consentRequest(pairingId: string, now = Date.now()): ConsentRequest | null {
    const r = requests.get(pairingId);
    if (!r) return null;
    if (now - r.createdAt >= OAUTH_REQUEST_TTL_MS) { requests.delete(pairingId); return null; }
    return r;
}

interface CodeRecord {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    member: string;
    clientName: string;
    expiresAt: number;
    /** Set once exchanged: the grant it made, revoked if the code comes again. */
    spentFor: string | null;
    spentAt: number;
}

const codes = new Map<string, CodeRecord>();
/** A spent code is remembered this long, so its reuse is caught (and revokes the grant). */
const SPENT_CODE_KEPT_MS = 10 * 60_000;

function pruneCodes(now: number): void {
    for (const [h, c] of codes) {
        if (c.spentFor ? now - c.spentAt >= SPENT_CODE_KEPT_MS : now >= c.expiresAt + SPENT_CODE_KEPT_MS) codes.delete(h);
    }
}

/** The member approved on the phone: a code for the consent request, which ends here. */
export function issueCode(r: ConsentRequest, member: string, now = Date.now()): string {
    pruneCodes(now);
    requests.delete(r.pairingId);
    const code = crypto.randomBytes(32).toString('hex');
    codes.set(sha256Hex(code), {
        clientId: r.clientId, redirectUri: r.redirectUri, codeChallenge: r.codeChallenge, resource: r.resource,
        member, clientName: r.clientName, expiresAt: now + OAUTH_CODE_TTL_MS, spentFor: null, spentAt: 0,
    });
    return code;
}

/** The consent request ends without a code (declined, refused or expired on the phone). */
export function dropConsentRequest(pairingId: string): void {
    requests.delete(pairingId);
}

// ───────────────────────── grants and tokens ─────────────────────────

function grantRecords(): AgentOAuthGrantRecord[] {
    const list = getLocalConfig().agentOAuthGrants;
    return Array.isArray(list) ? list : [];
}

function saveGrants(list: AgentOAuthGrantRecord[]): void {
    updateLocalConfig({ agentOAuthGrants: list });
}

/** A grant as Settings and /mcp see it: never a hash. */
export type OAuthGrantView = Omit<AgentOAuthGrantRecord, 'refreshHash' | 'spentRefresh'>;
const viewOf = ({ refreshHash: _r, spentRefresh: _s, ...rest }: AgentOAuthGrantRecord): OAuthGrantView => rest;

const idleExpired = (g: AgentOAuthGrantRecord, now: number) => now - g.refreshIssuedAt >= OAUTH_REFRESH_IDLE_MS;

/** The grants not yet idle 30 days (an idle one is dropped as it is read). */
export function listOAuthGrants(now = Date.now()): OAuthGrantView[] {
    const all = grantRecords();
    const live = all.filter((g) => !idleExpired(g, now));
    if (live.length !== all.length) saveGrants(live);
    return live.map(viewOf);
}

const accessTokens = new Map<string, { grantId: string; expiresAt: number }>();

function pruneAccess(now: number): void {
    for (const [h, a] of accessTokens) if (now >= a.expiresAt) accessTokens.delete(h);
}

export interface TokenPair { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }

function mintPair(grantId: string, now: number): { pair: TokenPair; refreshHash: string } {
    pruneAccess(now);
    const access = `bpo_${grantId}_${crypto.randomBytes(32).toString('hex')}`;
    const refresh = `bpr_${grantId}_${crypto.randomBytes(32).toString('hex')}`;
    accessTokens.set(sha256Hex(access), { grantId, expiresAt: now + OAUTH_ACCESS_TTL_MS });
    return {
        pair: { access_token: access, token_type: 'Bearer', expires_in: Math.floor(OAUTH_ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: OAUTH_SCOPE },
        refreshHash: sha256Hex(refresh),
    };
}

/** Forget a grant's access tokens (on revoke). */
function dropAccessOf(grantId: string): void {
    for (const [h, a] of accessTokens) if (a.grantId === grantId) accessTokens.delete(h);
}

export function revokeOAuthGrant(grantId: unknown): OAuthGrantView | null {
    const list = grantRecords();
    const g = list.find((x) => x.id === grantId);
    if (!g) return null;
    saveGrants(list.filter((x) => x.id !== grantId));
    dropAccessOf(g.id);
    return viewOf(g);
}

/** Why a token request failed, as RFC 6749 §5.2 names it; `revoked` when the attempt itself revoked a grant (reuse). */
export type TokenFailure = { ok: false; status: 400 | 401; error: string; description: string; revoked?: OAuthGrantView };
/** `replaced`: the same client's earlier grants for the same member, revoked by this new one (one connection per assistant). */
export type TokenResult = { ok: true; pair: TokenPair; grant: OAuthGrantView; created: boolean; replaced?: string[] } | TokenFailure;

const fail = (error: string, description: string, status: 400 | 401 = 400): TokenFailure => ({ ok: false, status, error, description });

/** S256: BASE64URL(SHA-256(verifier)) is the challenge. Verifier per RFC 7636 §4.1: 43 to 128 unreserved characters. */
export function pkceMatches(verifier: unknown, challenge: string): boolean {
    if (typeof verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
    const want = Buffer.from(challenge);
    const got = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'));
    return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const roleNow = (member: string): 'owner' | 'admin' | null => {
    const r = nodeRoleOf(member);
    return r === 'owner' || r === 'admin' ? r : null;
};

/** grant_type=authorization_code. `resource`, when sent, must be the one the code was approved for. */
export function exchangeCode(p: { code: unknown; clientId: unknown; redirectUri: unknown; verifier: unknown; resource: unknown }, now = Date.now()): TokenResult {
    pruneCodes(now);
    if (typeof p.code !== 'string' || !p.code) return fail('invalid_request', 'code is required');
    const rec = codes.get(sha256Hex(p.code));
    if (!rec) return fail('invalid_grant', 'Unknown or expired code');
    if (rec.spentFor) {
        // A code used twice was seen by someone else: the grant it made is revoked (OAuth 2.1 §4.1.3).
        const revoked = revokeOAuthGrant(rec.spentFor) ?? undefined;
        rec.spentFor = null;
        rec.expiresAt = 0;
        return { ...fail('invalid_grant', 'This code was already used: the connection it made is revoked'), revoked };
    }
    if (now >= rec.expiresAt) return fail('invalid_grant', 'The code expired: approve on the phone again');
    if (p.clientId !== rec.clientId) return fail('invalid_grant', 'The code was issued to another client');
    if (p.redirectUri !== rec.redirectUri) return fail('invalid_grant', 'redirect_uri is not the one the code was issued for');
    if (p.resource !== undefined && p.resource !== rec.resource) return fail('invalid_target', 'resource is not the one the code was approved for');
    if (!pkceMatches(p.verifier, rec.codeChallenge)) return fail('invalid_grant', 'code_verifier does not match the code challenge');
    const role = roleNow(rec.member);
    if (!role) return fail('invalid_grant', 'The member who approved is no longer an owner or admin here');
    // Approving the same assistant again (its old pass lost or kept) replaces its earlier connection for this member.
    const all = grantRecords().filter((g) => !idleExpired(g, now));
    const replaced = all.filter((g) => g.clientId === rec.clientId && g.member === rec.member).map((g) => g.id);
    for (const id of replaced) dropAccessOf(id);
    const list = all.filter((g) => !replaced.includes(g.id));
    if (list.length >= OAUTH_GRANTS_MAX) return fail('invalid_grant', `This server has ${OAUTH_GRANTS_MAX} assistants connected: disconnect one in Settings first`);
    if (list.filter((g) => g.member === rec.member).length >= OAUTH_GRANTS_PER_MEMBER) {
        return fail('invalid_grant', `You have ${OAUTH_GRANTS_PER_MEMBER} assistants connected: disconnect one in Settings first`);
    }
    let id = `oa${crypto.randomBytes(5).toString('hex')}`;
    while (list.some((g) => g.id === id)) id = `oa${crypto.randomBytes(5).toString('hex')}`;
    const { pair, refreshHash } = mintPair(id, now);
    const record: AgentOAuthGrantRecord = {
        id, clientId: rec.clientId, clientName: rec.clientName, redirectUri: rec.redirectUri, resource: rec.resource,
        member: rec.member, createdAt: now, lastUsedAt: null, refreshIssuedAt: now, refreshHash, spentRefresh: [],
    };
    saveGrants([...list, record]);
    pending.delete(rec.clientId);
    rec.spentFor = id;
    rec.spentAt = now;
    return { ok: true, pair, grant: viewOf(record), created: true, ...(replaced.length ? { replaced } : {}) };
}

/** grant_type=refresh_token: rotates. A spent refresh token presented again revokes the grant (`revoked`). */
export function refreshGrant(p: { refreshToken: unknown; clientId: unknown; resource: unknown }, now = Date.now()): TokenResult {
    const m = typeof p.refreshToken === 'string' ? REFRESH_SHAPE.exec(p.refreshToken) : null;
    if (!m) return fail('invalid_grant', 'Unknown refresh token');
    const list = grantRecords();
    const i = list.findIndex((g) => g.id === m[1]);
    if (i < 0) return fail('invalid_grant', 'Unknown refresh token');
    const g = list[i];
    const presented = sha256Hex(p.refreshToken as string);
    const same = (h: string) => h.length === presented.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(presented));
    if (!same(g.refreshHash)) {
        if (g.spentRefresh.some(same)) {
            const revoked = revokeOAuthGrant(g.id) ?? undefined;
            return { ...fail('invalid_grant', 'This refresh token was already used: the connection is revoked'), revoked };
        }
        return fail('invalid_grant', 'Unknown refresh token');
    }
    if (p.clientId !== g.clientId) return fail('invalid_grant', 'The refresh token was issued to another client');
    if (idleExpired(g, now)) {
        revokeOAuthGrant(g.id);
        return fail('invalid_grant', 'Unused for 30 days: approve on the phone again');
    }
    if (p.resource !== undefined && p.resource !== g.resource) return fail('invalid_target', 'resource is not the one this connection was approved for');
    if (!roleNow(g.member)) return fail('invalid_grant', 'The member who approved is no longer an owner or admin here');
    dropAccessOf(g.id);
    const { pair, refreshHash } = mintPair(g.id, now);
    list[i] = { ...g, refreshHash, refreshIssuedAt: now, spentRefresh: [g.refreshHash, ...g.spentRefresh].slice(0, SPENT_REFRESH_KEPT) };
    saveGrants(list);
    return { ok: true, pair, grant: viewOf(list[i]), created: false };
}

/** RFC 7009: the grant an access or refresh token belongs to, revoked; null when the token names none (still a 200). */
export function revokeByToken(token: unknown, clientId: unknown): OAuthGrantView | null {
    if (typeof token !== 'string') return null;
    const m = REFRESH_SHAPE.exec(token) ?? ACCESS_SHAPE.exec(token);
    if (!m) return null;
    const g = grantRecords().find((x) => x.id === m[1]);
    if (!g || (clientId !== undefined && clientId !== g.clientId)) return null;
    const h = sha256Hex(token);
    const isRefresh = token.startsWith('bpr_');
    const matches = isRefresh ? h === g.refreshHash : accessTokens.get(h)?.grantId === g.id;
    return matches ? revokeOAuthGrant(g.id) : null;
}

/** The grant behind a live access token, or null. */
export function verifyAccessToken(presented: string, now = Date.now()): OAuthGrantView | null {
    const m = ACCESS_SHAPE.exec(presented);
    const a = accessTokens.get(sha256Hex(presented));
    if (!m || !a || a.grantId !== m[1] || now >= a.expiresAt) return null;
    const g = grantRecords().find((x) => x.id === a.grantId);
    if (!g || idleExpired(g, now)) return null;
    return viewOf(g);
}

const LAST_USED_WRITE_MS = 60_000;
const lastUsedWritten = new Map<string, number>();

export function noteOAuthGrantUse(grantId: string, now = Date.now()): void {
    if (now - (lastUsedWritten.get(grantId) ?? 0) < LAST_USED_WRITE_MS) return;
    lastUsedWritten.set(grantId, now);
    const list = grantRecords();
    const i = list.findIndex((g) => g.id === grantId);
    if (i < 0) return;
    list[i] = { ...list[i], lastUsedAt: now };
    saveGrants(list);
}

/** For tests: forget everything held in memory (registrations, requests, codes, access tokens). */
export function resetOAuthForTests(): void {
    pending.clear();
    registerBuckets.clear();
    requests.clear();
    codes.clear();
    accessTokens.clear();
    lastUsedWritten.clear();
}

/** For tests: age every access token past its hour, as a restart or the hour would. */
export function expireAccessTokensForTests(): void {
    accessTokens.clear();
}
