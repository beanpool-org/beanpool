// Who is signed in to the control room (/admin and /api/local/admin/registrar/*): Cloudflare Access (Marty, 2026-10-17:
// "people shouldn't be seeing this page at all unless they have 2FA" — "2FA, not a key"). Access sits in front of those
// paths, makes the admin sign in with an email code and an authenticator, and hands every request it lets through a
// signed header, Cf-Access-Jwt-Assertion: an RS256 JWT under the team's keys (https://<team domain>/cdn-cgi/access/certs).
// The Worker believes nothing else — not Access's plain email header, not a cookie, not that the request came through
// Access at all (workers.dev, or a route Access doesn't cover, reach the Worker without it): the token's signature, its
// audience (this Access app's AUD tag), its issuer (the team), its times, and its email in ADMIN_EMAILS.
//
// Config, wrangler.toml [vars] (none of it secret): ACCESS_TEAM_DOMAIN, ACCESS_AUD, ADMIN_EMAILS (a comma list). Any one
// of them set means Access is how the admin signs in, and ADMIN_SECRET no longer opens anything; set but incomplete,
// nothing does (fail closed, never back to the secret). None set: the ADMIN_SECRET header, as before (a self-hoster
// running this registrar without Access — README "Admin sign-in").

export const ACCESS_VARS = ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS'];
export const ACCESS_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_SKEW_S = 60;            // clock difference allowed on exp, nbf and iat
const CERTS_TTL_MS = 60 * 60 * 1000;        // the team's keys are fetched again after an hour (Cloudflare rotates them)
const KID_REFRESH_MS = 30 * 1000;           // a key id the cache doesn't know fetches them again, at most this often
const CERTS_TIMEOUT_MS = 5000;
const TOKEN_MAX = 16 * 1024;
const MODULUS_MIN_BYTES = 256;              // RSA 2048 at least (Cloudflare's are 2048): a short key is no key

const isSet = (env, k) => typeof env[k] === 'string' && env[k].trim() !== '';
export const accessMode = (env) => ACCESS_VARS.some((k) => isSet(env, k));

// The team's host, as ACCESS_TEAM_DOMAIN gives it with or without https:// and a trailing slash.
const teamHost = (v) => v.trim().replace(/^https:\/\//i, '').replace(/\/+$/, '').toLowerCase();
export const adminEmails = (env) => (isSet(env, 'ADMIN_EMAILS') ? env.ADMIN_EMAILS : '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

// All three set and usable, or null.
export function accessConfig(env) {
    if (!ACCESS_VARS.every((k) => isSet(env, k))) return null;
    const team = teamHost(env.ACCESS_TEAM_DOMAIN);
    const emails = adminEmails(env);
    if (!/^[a-z0-9.-]+$/.test(team) || !emails.length) return null;
    return { team, aud: env.ACCESS_AUD.trim(), emails };
}

const B64URL = /^[A-Za-z0-9_-]*$/;
function b64urlBytes(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

// --- The team's signing keys ---
// Per isolate, per team: kid → CryptoKey, when they were fetched, and when an unknown kid last made us fetch them. A
// fetch that fails, or answers no RS256 key, keeps what the cache had for the rest of its hour and lets nothing new
// in; past the hour, with no fresh fetch, nothing at all (fail closed).
const certsCache = new Map();

async function fetchKeys(team) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(CERTS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`certs answered ${res.status}`);
    const body = await res.json();
    const keys = new Map();
    for (const k of Array.isArray(body?.keys) ? body.keys : []) {
        if (k?.kty !== 'RSA' || typeof k.kid !== 'string' || typeof k.n !== 'string' || typeof k.e !== 'string') continue;
        if (k.alg !== undefined && k.alg !== 'RS256') continue;
        try {
            if (!B64URL.test(k.n) || !B64URL.test(k.e) || b64urlBytes(k.n).length < MODULUS_MIN_BYTES) continue;
            keys.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true },
                { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
        } catch { /* one bad key never spoils the others */ }
    }
    if (!keys.size) throw new Error('certs hold no RS256 key');
    return keys;
}

// One fetch at a time per team: requests arriving meanwhile wait for it.
async function reload(team, c) {
    if (!c.pending) c.pending = fetchKeys(team).then((keys) => { c.keys = keys; c.at = Date.now(); }).finally(() => { c.pending = null; });
    await c.pending;
}

async function keyFor(team, kid) {
    let c = certsCache.get(team);
    if (!c) certsCache.set(team, (c = { keys: new Map(), at: 0, kidAt: 0, pending: null }));
    const fresh = () => Date.now() - c.at < CERTS_TTL_MS;
    if (fresh() && c.keys.has(kid)) return c.keys.get(kid);
    if (fresh()) {
        // A kid we don't know: Cloudflare may have rotated. Fetched again once, then not for KID_REFRESH_MS — a stream
        // of made-up kids must not become a stream of fetches.
        if (Date.now() - c.kidAt < KID_REFRESH_MS) return null;
        c.kidAt = Date.now();
    }
    try { await reload(team, c); } catch (e) { console.error('[ACCESS_CERTS]', team, e.message || e); return null; }
    return fresh() ? c.keys.get(kid) ?? null : null;
}

// --- The token ---
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
const isTime = (v) => typeof v === 'number' && Number.isFinite(v);

// The token's email when every check passes, or { error } saying which failed (for the Worker's log, never the answer).
export async function verifyAccessToken(token, cfg, now = Math.floor(Date.now() / 1000)) {
    if (typeof token !== 'string' || !token || token.length > TOKEN_MAX) return { error: 'no token' };
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((s) => B64URL.test(s))) return { error: 'malformed token' };
    const [h, p, s] = parts;
    let header, claims;
    try { header = b64urlJson(h); claims = b64urlJson(p); } catch { return { error: 'malformed token' }; }
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return { error: 'not an RS256 token with a kid' };
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { error: 'malformed token' };
    const key = await keyFor(cfg.team, header.kid);
    if (!key) return { error: 'unknown signing key' };
    let ok = false;
    try { ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`)); } catch { ok = false; }
    if (!ok) return { error: 'bad signature' };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.aud)) return { error: 'wrong audience' };
    if (claims.iss !== `https://${cfg.team}`) return { error: 'wrong issuer' };
    if (!isTime(claims.exp) || now >= claims.exp + ACCESS_SKEW_S) return { error: 'expired' };
    if (claims.nbf !== undefined && (!isTime(claims.nbf) || now + ACCESS_SKEW_S < claims.nbf)) return { error: 'not yet valid' };
    if (claims.iat !== undefined && (!isTime(claims.iat) || now + ACCESS_SKEW_S < claims.iat)) return { error: 'issued in the future' };
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email || !cfg.emails.includes(email)) return { error: 'email not in ADMIN_EMAILS' };
    return { email };
}

// The request's admin by Access: { email }, or { error }.
export async function accessIdentity(request, env) {
    const cfg = accessConfig(env);
    if (!cfg) return { error: `incomplete config: ${ACCESS_VARS.join(', ')} must all be set` };
    return verifyAccessToken(request.headers.get(ACCESS_HEADER), cfg);
}
