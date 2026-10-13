/**
 * Admin MCP, slice S2 (scratch/global-node/DESIGN-admin-mcp-fable.md §2, §11 S2, appendix point 4): an owner or an admin
 * connects an AI assistant through OAuth, approving on their PHONE. End to end with the official TypeScript MCP SDK's
 * OAuth client over REAL HTTPS through the real Koa middleware; nothing here contacts anything but the server it starts.
 *
 *   1. Metadata: the protected resource names /mcp and this node as its authorization server; the server's metadata has
 *      issuer = the node's URL, S256 only, scope agent, public clients only. /mcp's 401 names the resource metadata.
 *   2. The SDK client end to end, as an ADMIN: register → the consent page (the assistant's name never alone: the host its
 *      answers go to beside it) → the phone looks (it is told the name AND the host) → an app that cannot show it is
 *      refused (426) → the phone signs → number match on the page → code → token → tools/list. No Settings session is made.
 *      The owners are told (sec.agent). Settings lists the grant (with the host) for that admin; another admin sees none.
 *   3. Refused: no PKCE, `plain` PKCE, a redirect it did not register (no redirect at all, a page), a wrong resource (at
 *      authorize and at token), a wrong verifier, a moderator's approval; a reused code → refused AND the grant it made is
 *      revoked (its access token 401), the owners told (high).
 *   4. Refresh rotates: the new access token works, the old one is dead; the spent refresh token presented again → refused,
 *      the grant revoked, the owners told (high).
 *   5. Revoke (RFC 7009) → 401; Disconnect in Settings → 401; the member demoted → 401 and no refresh.
 *   6. An OAuth access token reaches /mcp and nothing else.
 *   7. Registration bounds: the 101st pending → 429; an unused registration is gone after an hour; only https or localhost.
 *   8. A standby's copy holds no grants (per-server field, left out of every backup file).
 *   9. The owners' switch off → 404 on every OAuth endpoint and /mcp.
 *  10. #1881 review: nothing sent on to an address nobody approved, nor after a No (finding 3); a client a grant holds
 *      keeps the standard redirect. Registrations write nothing into the assistants' ring and their refusals are budgeted;
 *      the connect and reuse lines are AUTH SECURITY lines (finding 4). At most 10 waiting per address, an IPv6 /64 one;
 *      full, the oldest unopened makes room (5). X-Forwarded-Host only from our own proxy (6). Switch off → 404 for
 *      every verb (7). Two refreshes at once: the strict rule holds (8).
 *  11. Lifetimes and pins (finding 9): a code 60 s, access 1 h, 30 days idle, 5 a member, the role re-read at the token,
 *      refresh with another client's id, framing headers, a forged revoke, no fragment or credentials in a redirect, an
 *      OAuth assistant's suggestion approved by its member only, and no token, code or verifier in the log.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-admin-mcp-oauth" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_OFFBOX_')) delete process.env[k];

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { audienceOf, signSettingsSignin } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, submitReport } from './state-engine.js';
import { updateLocalConfig, getLocalConfig, redactLocalConfig } from './config/local-config.js';
import { grantNodeRole, revokeNodeRole } from './engine/node-roles.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetPairingsForTests } from './settings-signin-pairing.js';
import { LOCAL_CONFIG_FIELDS } from './engine/replication-manifest.js';
import { db } from './db/db.js';
import { getAlertsStatus } from './services/alerts.js';
import { setSecurityAlertHandler } from './services/security-signal.js';
import {
    isPendingRegistration, markRegistrationOpened, OAUTH_ACCESS_TTL_MS, OAUTH_CODE_TTL_MS, OAUTH_GRANTS_PER_MEMBER, OAUTH_PENDING_MAX,
    OAUTH_PENDING_PER_ADDRESS, OAUTH_PENDING_TTL_MS, OAUTH_REFRESH_IDLE_MS, pendingRegistrations, registerClient, resetOAuthForTests,
} from './agent/oauth.js';
import { AGENT_REFUSAL_LOG_BUDGET, endAgentRefusalLogMinute } from './agent/mcp-route.js';
import { limiterKeyForIp, setTrustConfigForTests } from './client-ip.js';

// Time moves on for the lifetimes (section 11) only; 0 everywhere else.
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;

let BASE = '';
let HOST = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Reply { status: number; body: any; text: string; headers: Headers }
async function call(method: string, p: string, opts: { body?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    let body: string | undefined;
    if (opts.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(opts.form).toString(); }
    else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    const res = await fetch(p.startsWith('http') ? p : `${BASE}${p}`, { method, headers, body, redirect: 'manual' });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 200)}`;
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (method: string, id = 1, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });

interface Key { pub: string; priv: crypto.KeyObject }
function keypair(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}
const signer = (k: Key) => (bytes: Uint8Array) => new Uint8Array(crypto.sign(null, Buffer.from(bytes), k.priv));
async function keySignIn(k: Key): Promise<string | null> {
    const chal = await call('POST', '/api/local/admin/auth/challenge', { body: {} });
    const solved = await call('POST', '/api/local/admin/auth/verify-challenge', {
        body: { challengeId: chal.body?.challengeId, memberPubkey: k.pub, signature: crypto.sign(null, Buffer.from(chal.body?.challenge ?? ''), k.priv).toString('hex') },
    });
    const res = await fetch(`${BASE}/api/local/admin/auth/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: solved.body?.handshakeToken }),
    });
    const cookie = res.headers.getSetCookie().find(c => c.startsWith('admin_session=')) ?? '';
    return cookie.match(/^admin_session=([0-9a-f]{64})/)?.[1] ?? null;
}

const REDIRECT = 'https://assistant.example/oauth/callback';

/** The assistant's side, as claude.ai keeps it: client registration, tokens and the PKCE verifier, in memory. */
class Assistant implements OAuthClientProvider {
    authUrl: URL | null = null;
    private client: any;
    private saved: any;
    private verifier = '';
    constructor(private name: string, private redirect = REDIRECT) {}
    get redirectUrl() { return this.redirect; }
    get clientMetadata() {
        return { client_name: this.name, redirect_uris: [this.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    }
    clientInformation() { return this.client; }
    saveClientInformation(c: any) { this.client = c; }
    tokens() { return this.saved; }
    saveTokens(t: any) { this.saved = t; }
    redirectToAuthorization(u: URL) { this.authUrl = u; }
    saveCodeVerifier(v: string) { this.verifier = v; }
    codeVerifier() { return this.verifier; }
}

/** The consent page as a browser gets it: its pairing id and short code, and the cookie that binds it. */
async function openConsent(url: string): Promise<{ status: number; html: string; id: string; shortCode: string; cookie: string; location: string | null }> {
    const res = await fetch(url, { redirect: 'manual' });
    const html = await res.text();
    const id = /var id="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';
    const shortCode = /class="code">([A-Z0-9]{6})</.exec(html)?.[1] ?? '';
    const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('bp_signin_')) ?? '';
    return { status: res.status, html, id, shortCode, cookie, location: res.headers.get('location') };
}

/** The phone: look at the pairing, then approve it signed for this host (agentShown and confirm unless told otherwise). */
async function phoneApproves(k: Key, id: string, shortCode: string, extra: Record<string, unknown> = { confirm: true, agentShown: true }): Promise<Reply> {
    return call('POST', `/api/local/admin/auth/pairing/${id}/approve`, {
        body: { memberPubkey: k.pub, signature: await signSettingsSignin(BASE, 'approve', id, shortCode, signer(k)), signedFor: HOST, ...extra },
    });
}

/** The whole consent: page → phone → digits → the redirect back with a code. */
async function consent(url: string, k: Key): Promise<{ redirect: URL | null; page: Awaited<ReturnType<typeof openConsent>>; approve: Reply }> {
    const page = await openConsent(url);
    const approve = await phoneApproves(k, page.id, page.shortCode);
    const cookie = { Cookie: page.cookie };
    await call('POST', `/oauth/authorize/${page.id}/wait`, { body: { wait: false }, headers: cookie });
    const done = await call('POST', `/oauth/authorize/${page.id}/confirm`, { body: { code: approve.body?.confirmCode }, headers: cookie });
    return { redirect: done.body?.redirect ? new URL(done.body.redirect) : null, page, approve };
}

/** The SDK's own client, through 401 → discovery → registration → authorize; the rest is `consent` then finishAuth. */
async function sdkConnect(a: Assistant, k: Key): Promise<{ client: Client | null; redirect: URL | null; page: any; approve: Reply }> {
    const t1 = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: a });
    const c1 = new Client({ name: 'beanpool-oauth-test', version: '1.0.0' });
    let unauthorised = false;
    try { await c1.connect(t1); } catch (e) { unauthorised = /unauthori[sz]ed/i.test(String((e as Error)?.name) + String((e as Error)?.message)); }
    if (!unauthorised || !a.authUrl) return { client: null, redirect: null, page: null, approve: { status: 0, body: null, text: 'no redirect', headers: new Headers() } };
    const { redirect, page, approve } = await consent(a.authUrl.toString(), k);
    const code = redirect?.searchParams.get('code');
    if (!code) return { client: null, redirect, page, approve };
    await t1.finishAuth(code);
    const c2 = new Client({ name: 'beanpool-oauth-test', version: '1.0.0' });
    await c2.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: a }));
    return { client: c2, redirect, page, approve };
}

/** A manual authorize URL for a registered client (for the refusals the SDK would never send). */
function authorizeUrl(clientId: string, over: Record<string, string | null> = {}): string {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const p: Record<string, string | null> = {
        response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st-1',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        resource: `${BASE}/mcp`, scope: 'agent', ...over,
    };
    const u = new URL(`${BASE}/oauth/authorize`);
    for (const [k, v] of Object.entries(p)) if (v !== null) u.searchParams.set(k, v);
    return u.toString();
}

/** Register, consent and exchange by hand: the access and refresh tokens, and what was sent. */
async function manualConnect(k: Key, name = 'Manual Assistant'): Promise<{ clientId: string; access: string; refresh: string; code: string; verifier: string; token: Reply }> {
    const reg = await call('POST', '/oauth/register', { body: { client_name: name, redirect_uris: [REDIRECT] } });
    const clientId = reg.body?.client_id ?? '';
    const verifier = crypto.randomBytes(32).toString('base64url');
    const url = authorizeUrl(clientId, { code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
    const { redirect } = await consent(url, k);
    assert(redirect?.searchParams.get('state') === 'st-1', `the assistant's state comes back with its code (${redirect?.searchParams.get('state')})`);
    const code = redirect?.searchParams.get('code') ?? '';
    const token = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp` } });
    return { clientId, access: token.body?.access_token ?? '', refresh: token.body?.refresh_token ?? '', code, verifier, token };
}

async function mcpStatus(access: string): Promise<number> {
    return (await call('POST', '/mcp', { body: rpc('tools/list'), headers: { ...MCP_HEADERS, ...bearer(access) } })).status;
}

async function main(): Promise<void> {
    console.log('\n=== Admin MCP, slice S2: an assistant connects through OAuth, approved on the phone ===\n');
    const tmp = path.resolve(os.tmpdir());
    const webRoot = fs.mkdtempSync(path.join(tmp, 'bp-mcp-oauth-'));
    fs.mkdirSync(path.join(webRoot, 'public', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    fs.writeFileSync(path.join(webRoot, 'public', 'settings', 'index.html'), '<!doctype html><title>Settings</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const owner = keypair(), admin = keypair(), admin2 = keypair(), moderator = keypair(), member = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    const addMember = (k: Key, callsign: string) => {
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'inv-test')`).run(k.pub, callsign, owner.pub);
        db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(k.pub);
    };
    addMember(admin, 'Adam');
    addMember(admin2, 'Ada');
    addMember(moderator, 'Mo');
    addMember(member, 'Mel');
    grantNodeRole(admin.pub, 'admin', 'SYSTEM');
    grantNodeRole(admin2.pub, 'admin', 'SYSTEM');
    grantNodeRole(moderator.pub, 'moderator', 'SYSTEM');
    updateLocalConfig({ gateway: { ...(getLocalConfig().gateway ?? {}), rateLimiting: { enabled: true, maxRequestsPerMinute: 100000 } } as any });

    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    HOST = audienceOf(BASE) ?? 'localhost';
    // The auth limiter (15 a minute per address) is not what is tested here, and every request comes from one address.
    const resetLimits = () => { resetAdminRateLimit(); pruneAuthAttempts(Date.now() + 120_000); resetPairingsForTests(); };
    const notes: Array<{ key: string; detail: string; high?: boolean }> = [];
    setSecurityAlertHandler((n) => { notes.push({ key: n.key, detail: n.detail ?? '', high: n.high }); });

    try {
        // ── 1. Metadata ──
        const prm = await call('GET', '/.well-known/oauth-protected-resource/mcp');
        const prmRoot = await call('GET', '/.well-known/oauth-protected-resource');
        assert(prm.status === 200 && prm.body?.resource === `${BASE}/mcp` && JSON.stringify(prm.body?.authorization_servers) === JSON.stringify([BASE])
            && prmRoot.body?.resource === `${BASE}/mcp`, `protected resource: /mcp, this node its authorization server (${show(prm)})`);
        const as = await call('GET', '/.well-known/oauth-authorization-server');
        assert(as.status === 200 && as.body?.issuer === BASE && JSON.stringify(as.body?.code_challenge_methods_supported) === '["S256"]'
            && JSON.stringify(as.body?.scopes_supported) === '["agent"]' && JSON.stringify(as.body?.token_endpoint_auth_methods_supported) === '["none"]'
            && as.body?.registration_endpoint === `${BASE}/oauth/register` && as.body?.revocation_endpoint === `${BASE}/oauth/revoke`,
        `authorization server: issuer = the node's URL, S256 only, scope agent, public clients (${show(as)})`);
        const bare = await call('POST', '/mcp', { body: rpc('tools/list'), headers: MCP_HEADERS });
        assert(bare.status === 401 && (bare.headers.get('www-authenticate') ?? '').includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`),
            `/mcp's 401 names its resource metadata (${bare.headers.get('www-authenticate')})`);
        assert(!/an owner or an admin makes one/.test(bare.text) && /owner makes one/.test(bare.text) && /approving on your phone/.test(bare.text),
            `/mcp's 401 no longer says an admin makes a token; it names the phone's approval (#1865 finding 1) (${bare.body?.error?.message})`);

        // ── 2. The SDK client end to end, as an admin ──
        const claude = new Assistant('Claude');
        const e2e = await sdkConnect(claude, admin);
        const page = e2e.page;
        assert(!!page && page.status === 200 && page.id.length === 64 && page.html.includes('assistant.example')
            && /calling itself “Claude”, at assistant\.example/.test(page.html) && /Everything it reads goes to assistant\.example/.test(page.html),
        'the consent page names the assistant only beside the host its answers go to, and says everything it reads goes there');
        assert(!!page && /script-src 'nonce-/.test(String((await fetch(claude.authUrl!.toString(), { redirect: 'manual' })).headers.get('content-security-policy'))),
            'the consent page carries its own nonce CSP');
        assert(e2e.approve.status === 200 && /^\d{2}$/.test(String(e2e.approve.body?.confirmCode)) && e2e.approve.body?.role === 'admin',
            `the admin's phone approves and is shown two digits (${show(e2e.approve)})`);
        assert(!!e2e.redirect && e2e.redirect.origin + e2e.redirect.pathname === REDIRECT && !!e2e.redirect.searchParams.get('code')
            && e2e.redirect.searchParams.get('iss') === BASE, `the page sends the browser back with a code, the state and iss (${e2e.redirect?.toString().slice(0, 120)})`);
        let toolNames: string[] = [];
        try { toolNames = ((await e2e.client?.listTools())?.tools ?? []).map(t => t.name); } catch (e) { console.error(e); }
        assert(toolNames.includes('node_overview') && toolNames.includes('suggest_action') && !toolNames.includes('take_backup'),
            `register → authorize → phone signs → number match → code → token → tools/list: an admin's tools (${toolNames.join(',')})`);
        const welcome = e2e.client?.getInstructions() ?? '';
        assert(/acting for Adam, who is an admin there/.test(welcome), `the welcome names the admin it acts for (${welcome.slice(0, 120)})`);
        const tokens = claude.tokens();
        assert(typeof tokens?.access_token === 'string' && tokens.access_token.startsWith('bpo_') && tokens.expires_in === 3600 && tokens.refresh_token?.startsWith('bpr_'),
            'an opaque access token for an hour and a refresh token');
        assert(notes.some(n => n.key === 'sec.agent' && /connected by an admin/.test(n.detail) && /Claude, sending to assistant\.example/.test(n.detail) && !n.high),
            `the owners are told an admin connected it, with the host (${JSON.stringify(notes.slice(-1))})`);

        // No Settings session came of it: the pairing's wait answers no session and sets no admin cookie.
        const after = await fetch(`${BASE}/oauth/authorize/${page.id}/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: page.cookie }, body: '{"wait":false}' });
        assert(!after.headers.getSetCookie().some(c => c.startsWith('admin_session=')) && after.status !== 200,
            `the phone's approval of an assistant signs no browser in to Settings (${after.status})`);
        const viaSettingsRoute = await call('POST', `/api/local/admin/auth/pairing/${page.id}/wait`, { body: { wait: false }, headers: { Cookie: page.cookie } });
        assert(viaSettingsRoute.body?.status !== 'signed-in', `the Settings sign-in route cannot redeem an assistant's pairing (${show(viaSettingsRoute)})`);

        // Settings lists it for that admin, with the host; another admin sees none of it; the owner sees it.
        const adminSession = await keySignIn(admin);
        const admin2Session = await keySignIn(admin2);
        const ownerSession = await keySignIn(owner);
        const mine = await call('GET', '/api/local/admin/agent/grants', { headers: { 'X-Admin-Session': adminSession ?? '' } });
        const g = (mine.body?.grants ?? []).find((x: any) => x.via === 'oauth');
        assert(!!g && g.name === 'Claude' && g.sendsTo === 'assistant.example' && g.mine === true && g.role === 'admin' && mine.body?.canConnectOAuth === true,
            `Settings lists the admin's OAuth assistant with the host it sends to (${JSON.stringify(g)})`);
        const theirs = await call('GET', '/api/local/admin/agent/grants', { headers: { 'X-Admin-Session': admin2Session ?? '' } });
        const ownerView = await call('GET', '/api/local/admin/agent/grants', { headers: { 'X-Admin-Session': ownerSession ?? '' } });
        assert((theirs.body?.grants ?? []).length === 0 && (ownerView.body?.grants ?? []).some((x: any) => x.id === g?.id),
            'another admin sees none of it; an owner sees it');
        assert(!JSON.stringify(mine.body).includes(tokens?.refresh_token ?? 'x') && !/refreshHash|spentRefresh/.test(JSON.stringify(ownerView.body)),
            'no list carries a token or a hash');

        // ── 6. The access token reaches /mcp and nothing else ──
        const elsewhere = await call('GET', '/api/local/admin/agent/grants', { headers: bearer(tokens!.access_token) });
        const data = await call('POST', '/api/local/admin/data', { body: {}, headers: bearer(tokens!.access_token) });
        assert(elsewhere.status === 401 && data.status === 401, `an OAuth access token opens no other admin route (${elsewhere.status}, ${data.status})`);

        // An app that cannot show the assistant is refused; a moderator and a plain member cannot connect one.
        resetLimits();
        const reg = await call('POST', '/oauth/register', { body: { client_name: 'Old App Check', redirect_uris: [REDIRECT] } });
        assert(reg.status === 201 && /^bpc_[0-9a-f]{32}$/.test(reg.body?.client_id) && reg.body?.token_endpoint_auth_method === 'none',
            `registration: a public client (${show(reg)})`);
        const oldApp = await openConsent(authorizeUrl(reg.body.client_id));
        const describe = await call('GET', `/api/local/admin/auth/pairing/${oldApp.id}`);
        assert(describe.status === 200 && describe.body?.agent?.name === 'Old App Check' && describe.body?.agent?.sendsTo === 'assistant.example',
            `the phone is told the assistant's name AND where its answers go (${JSON.stringify(describe.body?.agent)})`);
        const noShown = await phoneApproves(admin, oldApp.id, oldApp.shortCode, { confirm: true });
        const noConfirm = await phoneApproves(admin, oldApp.id, oldApp.shortCode, { agentShown: true });
        assert(noShown.status === 426 && noShown.body?.code === 'agent_app_too_old' && noConfirm.status === 426,
            `an app that cannot show the assistant, or the digits, cannot approve one (${show(noShown)})`);
        const mod = await phoneApproves(moderator, oldApp.id, oldApp.shortCode);
        const plain = await phoneApproves(member, oldApp.id, oldApp.shortCode);
        assert(mod.status === 403 && mod.body?.reason === 'not-owner-or-admin' && plain.status === 403,
            `a moderator and a plain member cannot connect an assistant (${show(mod)}; ${show(plain)})`);

        // ── 3. Refusals at authorize ──
        const cid = reg.body.client_id;
        const noPkce = await call('GET', authorizeUrl(cid, { code_challenge: null, code_challenge_method: null }));
        // A client nobody has approved on a phone yet: its address is only its own word, so an error is our page, never a
        // redirect there (RFC 9700 §4.11.2; #1881 review, finding 3).
        assert(noPkce.status === 400 && !noPkce.headers.get('location') && /PKCE/.test(noPkce.text) && !/var id=/.test(noPkce.text),
            `no PKCE → refused, a page: nothing sent to an address nobody approved (${noPkce.status} ${noPkce.headers.get('location')?.slice(0, 100)})`);
        const plainPkce = await call('GET', authorizeUrl(cid, { code_challenge_method: 'plain' }));
        assert(plainPkce.status === 400 && !plainPkce.headers.get('location'), 'plain PKCE → refused (S256 only), a page: nothing sent to an address nobody approved');
        const wrongRedirect = await call('GET', authorizeUrl(cid, { redirect_uri: 'https://evil.example/cb' }));
        assert(wrongRedirect.status === 400 && !wrongRedirect.headers.get('location') && !/var id=/.test(wrongRedirect.text),
            `a redirect it did not register → a page, nothing sent anywhere, no QR (${wrongRedirect.status})`);
        const wrongResource = await call('GET', authorizeUrl(cid, { resource: 'https://evil.example/mcp' }));
        assert(wrongResource.status === 400 && !wrongResource.headers.get('location'), `a wrong resource at authorize → refused, a page (${wrongResource.status})`);
        const unknownClient = await call('GET', authorizeUrl('bpc_' + '0'.repeat(32)));
        assert(unknownClient.status === 400 && !unknownClient.headers.get('location'), 'an unknown client → a page, no redirect');

        // ── 3b. Refusals at token, and a reused code revokes ──
        resetLimits();
        const m1 = await manualConnect(owner, 'Reuse Check');
        assert(m1.token.status === 200 && m1.access.startsWith('bpo_') && (await mcpStatus(m1.access)) === 200,
            `a hand-made consent by the owner gives a working token (${show(m1.token)})`);
        assert(notes.some(n => n.key === 'sec.agent' && /Reuse Check/.test(n.detail) && /connected by an owner: it can .*take a backup/.test(n.detail)),
            `an owner's connection is told as an owner's, with backups (${JSON.stringify(notes.filter(n => /Reuse Check/.test(n.detail)).map(n => n.detail))})`);
        const alerts = getAlertsStatus() as any;
        assert(alerts?.assistants?.connected >= 2, `the Alerts card counts OAuth assistants as connected (${JSON.stringify(alerts?.assistants)})`);
        const reuse = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: m1.code, client_id: m1.clientId, redirect_uri: REDIRECT, code_verifier: m1.verifier } });
        assert(reuse.status === 400 && reuse.body?.error === 'invalid_grant', `a reused code → invalid_grant (${show(reuse)})`);
        assert((await mcpStatus(m1.access)) === 401, "…and the grant it made is revoked: its access token answers 401");
        const refreshAfterReuse = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: m1.refresh, client_id: m1.clientId } });
        assert(refreshAfterReuse.status === 400, '…and its refresh token is dead');
        assert(notes.some(n => n.key === 'sec.agent' && n.high === true && /Reuse Check/.test(n.detail) && /presented again/.test(n.detail)),
            'the owners are told, high');

        resetLimits();
        const regB = await call('POST', '/oauth/register', { body: { client_name: 'Token Checks', redirect_uris: [REDIRECT] } });
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const getCode = async () => (await consent(authorizeUrl(regB.body.client_id, { code_challenge: challenge }), owner)).redirect?.searchParams.get('code') ?? '';
        const exchange = (over: Record<string, string>) => call('POST', '/oauth/token', {
            form: { grant_type: 'authorization_code', client_id: regB.body.client_id, redirect_uri: REDIRECT, code_verifier: verifier, ...over },
        });
        const c1 = await getCode();
        const badVerifier = await exchange({ code: c1, code_verifier: crypto.randomBytes(32).toString('base64url') });
        assert(badVerifier.status === 400 && badVerifier.body?.error === 'invalid_grant', `a wrong verifier → invalid_grant (${show(badVerifier)})`);
        const noVerifier = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', client_id: regB.body.client_id, redirect_uri: REDIRECT, code: await getCode() } });
        assert(noVerifier.status === 400 && noVerifier.body?.error === 'invalid_grant', 'no verifier → invalid_grant');
        resetLimits();
        const badRedirect = await exchange({ code: await getCode(), redirect_uri: 'https://assistant.example/other' });
        assert(badRedirect.status === 400 && badRedirect.body?.error === 'invalid_grant', 'a different redirect at token → invalid_grant');
        const badResource = await exchange({ code: await getCode(), resource: 'https://evil.example/mcp' });
        assert(badResource.status === 400 && badResource.body?.error === 'invalid_target', 'a wrong resource at token → invalid_target');
        const badClient = await exchange({ code: await getCode(), client_id: 'bpc_' + '1'.repeat(32) });
        assert(badClient.status === 400 && badClient.body?.error === 'invalid_grant', 'another client at token → invalid_grant');

        // ── 4. Refresh rotates; a spent refresh token revokes ──
        resetLimits();
        const m2 = await manualConnect(admin, 'Refresh Check');
        const r1 = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: m2.refresh, client_id: m2.clientId } });
        assert(r1.status === 200 && r1.body?.refresh_token !== m2.refresh && r1.body?.access_token !== m2.access, `refresh rotates both tokens (${show(r1)})`);
        assert((await mcpStatus(r1.body.access_token)) === 200 && (await mcpStatus(m2.access)) === 401, 'the new access token works; the old one is dead');
        const spent = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: m2.refresh, client_id: m2.clientId } });
        assert(spent.status === 400 && spent.body?.error === 'invalid_grant', `the spent refresh token again → invalid_grant (${show(spent)})`);
        assert((await mcpStatus(r1.body.access_token)) === 401, '…and the grant is revoked: the newest access token answers 401 too');
        const r2 = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: m2.clientId } });
        assert(r2.status === 400, '…and the newest refresh token is dead');
        assert(notes.some(n => n.key === 'sec.agent' && n.high === true && /Refresh Check/.test(n.detail)), 'the owners are told, high');

        // Approving the same assistant again replaces its earlier connection (no second grant for one client and member).
        resetLimits();
        const oldAccess = tokens!.access_token;
        claude.saveTokens(undefined);
        const again = await sdkConnect(claude, admin);
        const relisted = ((await call('GET', '/api/local/admin/agent/grants', { headers: { 'X-Admin-Session': adminSession ?? '' } })).body?.grants ?? []).filter((x: any) => x.name === 'Claude');
        assert(!!again.client && relisted.length === 1 && relisted[0].id !== g?.id && (await mcpStatus(oldAccess)) === 401,
            `the same assistant approved again replaces its earlier connection: one row, the old pass dead (${relisted.length})`);

        // ── 5. Revoke, Disconnect, demotion ──
        resetLimits();
        const m3 = await manualConnect(admin, 'Revoke Check');
        const rv = await call('POST', '/oauth/revoke', { form: { token: m3.refresh, client_id: m3.clientId } });
        assert(rv.status === 200 && (await mcpStatus(m3.access)) === 401, `revoke (RFC 7009) → 401 (${show(rv)})`);
        resetLimits();
        const m4 = await manualConnect(admin, 'Disconnect Check');
        const list4 = await call('GET', '/api/local/admin/agent/grants', { headers: { 'X-Admin-Session': adminSession ?? '' } });
        const g4 = (list4.body?.grants ?? []).find((x: any) => x.name === 'Disconnect Check');
        const other = await call('POST', `/api/local/admin/agent/grants/${g4?.id}/revoke`, { body: {}, headers: { 'X-Admin-Session': admin2Session ?? '' } });
        const dc = await call('POST', `/api/local/admin/agent/grants/${g4?.id}/revoke`, { body: {}, headers: { 'X-Admin-Session': adminSession ?? '' } });
        assert(other.status === 404 && dc.status === 200 && (await mcpStatus(m4.access)) === 401,
            `another admin cannot disconnect it; its admin can, in Settings → 401 (${other.status}, ${dc.status})`);
        resetLimits();
        const m5 = await manualConnect(admin2, 'Demote Check');
        assert((await mcpStatus(m5.access)) === 200, "admin2's assistant works");
        revokeNodeRole(admin2.pub, 'admin', owner.pub);
        const demotedRefresh = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: m5.refresh, client_id: m5.clientId } });
        assert((await mcpStatus(m5.access)) === 401 && demotedRefresh.status === 400, 'the member no longer an admin → 401, and no refresh');

        // ── 7. Registration bounds ──
        resetOAuthForTests();
        const insecure = await call('POST', '/oauth/register', { body: { client_name: 'x', redirect_uris: ['http://evil.example/cb'] } });
        const loopback = await call('POST', '/oauth/register', { body: { client_name: 'Desktop', redirect_uris: ['http://127.0.0.1:33418/callback'] } });
        assert(insecure.status === 400 && loopback.status === 201, `only https or localhost redirects (${insecure.status}, ${loopback.status})`);
        resetOAuthForTests();
        // 100 addresses with 10 waiting each all fit: at 100 node-wide, 10 addresses opening their own pages shut the door
        // for an hour (#1881 confirmation, finding 1).
        const held: string[] = [];
        for (let a = 0; a < 100; a++) {
            for (let i = 0; i < OAUTH_PENDING_PER_ADDRESS; i++) {
                const r = registerClient({ client_name: `p${a}-${i}`, redirect_uris: [REDIRECT] }, `test-${a}`);
                if (r.ok) held.push(r.client.clientId);
            }
        }
        const stillWaiting = held.filter(id => isPendingRegistration(id)).length;
        assert(held.length === 1000 && stillWaiting === 1000 && pendingRegistrations() === 1000,
            `100 addresses × 10 waiting all fit: none made room for another (${held.length} made, ${stillWaiting} still waiting)`);
        const opened = await openConsent(authorizeUrl(held[0])); // its consent page shown: no longer the first to make room
        const room = await call('POST', '/oauth/register', { body: { client_name: 'Makes Room', redirect_uris: [REDIRECT] } });
        assert(opened.status === 200 && room.status === 201 && pendingRegistrations() === OAUTH_PENDING_MAX && isPendingRegistration(held[0]) && !isPendingRegistration(held[1]),
            `the cap still bounds it: one more from a 101st address, and the oldest one nobody opened a page for makes room, one whose page was opened stays (${opened.status}; ${show(room)}; ${pendingRegistrations()} waiting)`);
        for (const id of [...held, room.body?.client_id]) markRegistrationOpened(id);
        const over = await call('POST', '/oauth/register', { body: { client_name: 'One Too Many', redirect_uris: [REDIRECT] } });
        assert(over.status === 429 && pendingRegistrations() === OAUTH_PENDING_MAX, `${OAUTH_PENDING_MAX} waiting, every one opened: the next → 429 (${show(over)})`);
        resetOAuthForTests();
        const old = registerClient({ client_name: 'Stale', redirect_uris: [REDIRECT] }, 'test-old', Date.now() - OAUTH_PENDING_TTL_MS - 1);
        const stale = old.ok ? await call('GET', authorizeUrl(old.client.clientId)) : null;
        assert(!!stale && stale.status === 400 && /not registered/.test(stale.text), 'an unused registration is gone after an hour');
        resetOAuthForTests();
        let braked = 0;
        for (let i = 0; i < 11; i++) if ((await call('POST', '/oauth/register', { body: { redirect_uris: [REDIRECT] } })).status === 429) braked++;
        assert(braked === 1, `registration is braked per address: the 11th in a minute → 429 (${braked})`);

        // ── 8. A standby's copy holds no grants ──
        resetOAuthForTests();
        resetLimits();
        const m6 = await manualConnect(owner, 'Standby Check');
        assert((getLocalConfig().agentOAuthGrants ?? []).length >= 1 && m6.access.length > 0, 'a grant is held on this server');
        assert(LOCAL_CONFIG_FIELDS.agentOAuthGrants?.kind === 'per-server' && !('agentOAuthGrants' in redactLocalConfig(getLocalConfig())),
            "grants are this server's own: per-server in the manifest and left out of every backup file, so a standby's copy holds none");

        // ── 9. The switch off → 404 everywhere ──
        updateLocalConfig({ aiAssistantsAllowed: false });
        const offs = await Promise.all([
            call('GET', '/.well-known/oauth-protected-resource'), call('GET', '/.well-known/oauth-protected-resource/mcp'),
            call('GET', '/.well-known/oauth-authorization-server'),
            call('POST', '/oauth/register', { body: { redirect_uris: [REDIRECT] } }), call('GET', authorizeUrl(m6.clientId)),
            call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: m6.refresh, client_id: m6.clientId } }),
            call('POST', '/oauth/revoke', { form: { token: m6.refresh } }),
            call('POST', `/oauth/authorize/${'a'.repeat(64)}/wait`, { body: {} }),
            call('POST', '/mcp', { body: rpc('tools/list'), headers: { ...MCP_HEADERS, ...bearer(m6.access) } }),
        ]);
        assert(offs.every(r => r.status === 404), `the owners' switch off → 404 on every OAuth endpoint and /mcp (${offs.map(r => r.status).join(',')})`);
        updateLocalConfig({ aiAssistantsAllowed: true });
        assert((await mcpStatus(m6.access)) === 200, 'switched back on, the grant answers again');

        // ── 10. #1881 review findings 3 to 8 ──
        // Finding 3: a client nobody approved on a phone gets our page for any error, and a No sends the browser nowhere.
        resetOAuthForTests();
        resetLimits();
        const EVIL = 'https://evil.example/landing';
        const evilReg = await call('POST', '/oauth/register', { body: { client_name: 'Claude', redirect_uris: [EVIL] } });
        const evilId = evilReg.body?.client_id ?? '';
        const evilErrors = await Promise.all([
            call('GET', `/oauth/authorize?client_id=${evilId}&response_type=token`),
            call('GET', `/oauth/authorize?client_id=${evilId}&response_type=code`),
            call('GET', `/oauth/authorize?client_id=${evilId}&response_type=code&code_challenge_method=S256&code_challenge=${'A'.repeat(43)}&scope=admin`),
        ]);
        assert(evilReg.status === 201 && evilErrors.every(r => r.status === 400 && !r.headers.get('location') && !/var id=/.test(r.text)),
            `an unapproved client's bad request → our page, never a redirect to the address it registered (${evilErrors.map(r => `${r.status} ${r.headers.get('location') ?? ''}`).join(', ')})`);
        const declined = await openConsent(authorizeUrl(evilId, { redirect_uri: EVIL }));
        const no = await call('POST', `/api/local/admin/auth/pairing/${declined.id}/decline`, {
            body: { memberPubkey: admin.pub, signature: await signSettingsSignin(BASE, 'decline', declined.id, declined.shortCode, signer(admin)), signedFor: HOST },
        });
        const afterNo = await call('POST', `/oauth/authorize/${declined.id}/wait`, { body: { wait: false }, headers: { Cookie: declined.cookie } });
        assert(afterNo.status === 410 && afterNo.body?.status === 'declined' && !('redirect' in (afterNo.body ?? {})) && !afterNo.text.includes('evil.example'),
            `a No on the phone: the page is told "declined" and sent nowhere (decline ${no.status}; ${show(afterNo)})`);
        assert(declined.html.split('\n').filter(l => l.includes("r.status==='declined'")).every(l => !l.includes('go(r)')),
            "the consent page's script never navigates after a No");
        const claudeId = claude.clientInformation()?.client_id ?? '';
        const trustedErr = await call('GET', authorizeUrl(claudeId, { response_type: 'token' }));
        const tl = (() => { try { return new URL(trustedErr.headers.get('location') ?? ''); } catch { return null; } })();
        assert(trustedErr.status === 302 && tl?.origin === 'https://assistant.example' && tl?.searchParams.get('error') === 'unsupported_response_type' && tl?.searchParams.get('iss') === BASE,
            `a client a grant holds (approved on a phone) keeps the standard error redirect (${trustedErr.status} ${tl?.toString().slice(0, 100)})`);

        // Finding 4: registrations write nothing into the ring kept for calls let in; their refusals are budgeted.
        const admittedLines = () => (db.prepare("SELECT COUNT(*) AS n FROM system_logs WHERE category = 'AGENT' AND message NOT LIKE 'Assistant refused%'").get() as any).n as number;
        const refusedRegistrations = () => db.prepare("SELECT message, metadata FROM system_logs WHERE category = 'AGENT' AND message LIKE 'Assistant refused a registration%' ORDER BY id").all() as any[];
        resetOAuthForTests();
        endAgentRefusalLogMinute();
        const ringBefore = admittedLines(), refusedBefore = refusedRegistrations().length;
        const flood: Record<number, number> = {};
        for (let a = 1; a <= 3; a++) {
            for (let i = 0; i < 20; i++) {
                const x = await call('POST', '/oauth/register', { body: { redirect_uris: ['https://flood.example/cb'] }, headers: { 'X-Forwarded-For': `203.0.113.${a}` } });
                flood[x.status] = (flood[x.status] ?? 0) + 1;
            }
        }
        const refusedLines = refusedRegistrations().slice(refusedBefore);
        assert(flood[201] === 30 && flood[429] === 30 && admittedLines() === ringBefore,
            `60 registrations from 3 addresses (30 made, 30 refused) write nothing into the ring kept for calls let in (${JSON.stringify(flood)}; ${admittedLines() - ringBefore} lines)`);
        assert(refusedLines.length === AGENT_REFUSAL_LOG_BUDGET && refusedLines.every(l => !String(l.metadata).includes('203.0.113.') && String(l.metadata).includes('ip#')),
            `…their refusals go through the refusal budget (${refusedLines.length} written one by one), each naming the address's daily tag, never the address`);
        endAgentRefusalLogMinute();
        const summary = db.prepare("SELECT message FROM system_logs WHERE category = 'AGENT' AND message LIKE 'Assistant refused % more requests%' ORDER BY id DESC LIMIT 1").get() as any;
        assert(/refused 10 more requests/.test(summary?.message ?? ''), `…and the rest are counted in one line at the minute's end (${summary?.message})`);
        const secLines = db.prepare("SELECT category, level, message FROM system_logs WHERE message IN ('Assistant connected through OAuth', 'Assistant disconnected: a used code or refresh token was presented again')").all() as any[];
        assert(secLines.filter(l => /connected through/.test(l.message)).length >= 3 && secLines.filter(l => /presented again/.test(l.message)).length >= 2
            && secLines.every(l => l.category === 'AUTH' && l.level === 'SECURITY'),
        `the connect and reuse lines are AUTH SECURITY lines, outside the assistants' rings (${[...new Set(secLines.map(l => `${l.category}/${l.level}`))].join(',')})`);

        // Finding 5: at most 10 waiting from one address (an IPv6 /64 is one); its own oldest unopened one makes room.
        resetOAuthForTests();
        const otherWaiting = await call('POST', '/oauth/register', { body: { client_name: 'Elsewhere', redirect_uris: [REDIRECT] }, headers: { 'X-Forwarded-For': '198.51.100.8' } });
        const otherWaitingId = otherWaiting.body?.client_id ?? '';
        const v6Key = limiterKeyForIp('2001:db8:5:6::1');
        const v6Ids: string[] = [];
        for (let i = 0; i < OAUTH_PENDING_PER_ADDRESS; i++) {
            const r = registerClient({ client_name: `v6-${i}`, redirect_uris: [REDIRECT] }, v6Key, Date.now() - 2 * 60_000);
            if (r.ok) v6Ids.push(r.client.clientId);
        }
        const sameSlash64 = { 'X-Forwarded-For': '2001:db8:5:6:aaaa:bbbb:cccc:42' };
        const eleventh = await call('POST', '/oauth/register', { body: { client_name: 'v6 again', redirect_uris: [REDIRECT] }, headers: sameSlash64 });
        const v6Waiting = [...v6Ids, eleventh.body?.client_id].filter(id => isPendingRegistration(id)).length;
        assert(otherWaiting.status === 201 && v6Ids.length === OAUTH_PENDING_PER_ADDRESS && eleventh.status === 201 && pendingRegistrations() === OAUTH_PENDING_PER_ADDRESS + 1
            && !isPendingRegistration(v6Ids[0]) && isPendingRegistration(v6Ids[1]),
        `an address (another address in the same IPv6 /64) with 10 waiting: its 11th drops its own oldest unopened one (${show(eleventh)}; ${pendingRegistrations()} waiting)`);
        assert(isPendingRegistration(otherWaitingId) && v6Waiting === OAUTH_PENDING_PER_ADDRESS,
            `…never another address's, even one older and unopened: 198.51.100.8's still waits, and the /64 still holds 10 (${v6Waiting})`);
        for (const id of [...v6Ids, eleventh.body?.client_id]) markRegistrationOpened(id);
        const twelfth = await call('POST', '/oauth/register', { body: { client_name: 'v6 once more', redirect_uris: [REDIRECT] }, headers: sameSlash64 });
        const otherAddress = await call('POST', '/oauth/register', { body: { client_name: 'Claude', redirect_uris: [REDIRECT] }, headers: { 'X-Forwarded-For': '198.51.100.7' } });
        assert(twelfth.status === 429 && twelfth.body?.error === 'temporarily_unavailable' && otherAddress.status === 201,
            `…its 10 all opened: its next → 429, and another address still registers (${show(twelfth)}; ${otherAddress.status})`);

        // Finding 6: no public address: X-Forwarded-Host is believed only from our own proxy.
        setTrustConfigForTests({ loopback: false, localSubnets: false });
        const asForged = await call('GET', '/.well-known/oauth-authorization-server', { headers: { 'X-Forwarded-Host': 'evil.example' } });
        const prmForged = await call('GET', '/.well-known/oauth-protected-resource/mcp', { headers: { 'X-Forwarded-Host': 'evil.example' } });
        setTrustConfigForTests(undefined);
        assert(asForged.body?.issuer === BASE && prmForged.body?.resource === `${BASE}/mcp` && JSON.stringify(prmForged.body?.authorization_servers) === JSON.stringify([BASE]),
            `X-Forwarded-Host from a peer that isn't our proxy moves nothing: the issuer is the host reached (${asForged.body?.issuer}, ${prmForged.body?.resource})`);
        const asProxied = await call('GET', '/.well-known/oauth-authorization-server', { headers: { 'X-Forwarded-Host': 'town.example' } });
        assert(asProxied.body?.issuer === 'https://town.example', `…from our own proxy it names the host the member reached (${asProxied.body?.issuer})`);

        // Finding 7: the switch off → 404 for every verb on every OAuth path, OPTIONS included.
        updateLocalConfig({ aiAssistantsAllowed: false });
        const doorPaths = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server',
            '/oauth/register', '/oauth/authorize', `/oauth/authorize/${'a'.repeat(64)}/wait`, `/oauth/authorize/${'a'.repeat(64)}/confirm`, '/oauth/token', '/oauth/revoke'];
        const notFound: string[] = [];
        for (const p of doorPaths) {
            for (const v of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
                const res = await fetch(`${BASE}${p}`, { method: v, redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: 'https://claude.ai' }, body: v === 'GET' || v === 'HEAD' ? undefined : '{}' });
                await res.arrayBuffer();
                if (res.status !== 404) notFound.push(`${v} ${p} ${res.status}`);
            }
        }
        updateLocalConfig({ aiAssistantsAllowed: true });
        assert(notFound.length === 0, `the switch off: all 7 verbs on all 9 OAuth paths → 404 (${notFound.slice(0, 6).join('; ')})`);
        const preflight = await fetch(`${BASE}/oauth/token`, { method: 'OPTIONS', headers: { Origin: 'https://claude.ai' } });
        await preflight.arrayBuffer();
        assert(preflight.status !== 404, `switched on, the door answers its preflight again (${preflight.status})`);

        // Finding 8 (kept): two refreshes at once with one refresh token: one is answered, the other revokes the grant.
        resetLimits();
        const race = await manualConnect(admin, 'Race Check');
        const highBefore = notes.filter(n => n.high).length;
        resetLimits();
        const both = await Promise.all([1, 2].map(() => call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: race.refresh, client_id: race.clientId } })));
        assert(both.map(r => r.status).sort().join(',') === '200,400' && !(getLocalConfig().agentOAuthGrants ?? []).some(g => g.clientName === 'Race Check')
            && notes.filter(n => n.high).length === highBefore + 1,
        `two refreshes at once: the strict rule holds, the grant revoked and the owners told, high (${both.map(r => r.status).join(',')})`);

        // ── 11. Lifetimes and the pins finding 9 asked for ──
        resetOAuthForTests();
        resetLimits();
        const life = await call('POST', '/oauth/register', { body: { client_name: 'Life', redirect_uris: [REDIRECT] } });
        const lifeVerifier = crypto.randomBytes(32).toString('base64url');
        const lifeCode = (await consent(authorizeUrl(life.body.client_id, { code_challenge: crypto.createHash('sha256').update(lifeVerifier).digest('base64url') }), owner)).redirect?.searchParams.get('code') ?? '';
        skew = OAUTH_CODE_TTL_MS + 1000;
        const lateCode = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: lifeCode, client_id: life.body.client_id, redirect_uri: REDIRECT, code_verifier: lifeVerifier } });
        skew = 0;
        assert(lateCode.status === 400 && /expired/.test(lateCode.body?.error_description ?? ''), `a code past 60 s → refused (${show(lateCode)})`);
        resetLimits();
        const lg = await manualConnect(owner, 'Life Grant');
        skew = OAUTH_ACCESS_TTL_MS + 1000;
        const accessLate = await mcpStatus(lg.access);
        resetLimits();
        const refreshLate = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: lg.refresh, client_id: lg.clientId } });
        const refreshedWorks = await mcpStatus(refreshLate.body?.access_token ?? '');
        assert(accessLate === 401 && refreshLate.status === 200 && refreshedWorks === 200, `an access token dies at an hour; a refresh then works (${accessLate}, ${refreshLate.status}, ${refreshedWorks})`);
        skew += OAUTH_REFRESH_IDLE_MS + 1000;
        resetLimits();
        const idle = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: refreshLate.body?.refresh_token ?? '', client_id: lg.clientId } });
        skew = 0;
        pruneAuthAttempts(Date.now() + 90 * 86_400_000); // the auth limiter's attempts made 30 days ahead
        assert(idle.status === 400 && /30 days/.test(idle.body?.error_description ?? '') && !(getLocalConfig().agentOAuthGrants ?? []).some(g => g.clientName === 'Life Grant'),
            `30 days without a refresh: refused, and the grant is gone (${show(idle)})`);

        // Five OAuth assistants a member; the role is read again at the token step.
        resetOAuthForTests();
        const capper = keypair();
        addMember(capper, 'Cap');
        grantNodeRole(capper.pub, 'admin', 'SYSTEM');
        const capStatuses: number[] = [];
        let capLast: Reply | null = null;
        for (let i = 0; i <= OAUTH_GRANTS_PER_MEMBER; i++) {
            resetLimits();
            capLast = (await manualConnect(capper, `Cap ${i}`)).token;
            capStatuses.push(capLast.status);
        }
        assert(capStatuses.slice(0, OAUTH_GRANTS_PER_MEMBER).every(s => s === 200) && capStatuses[OAUTH_GRANTS_PER_MEMBER] === 400
            && new RegExp(`You have ${OAUTH_GRANTS_PER_MEMBER} assistants`).test(capLast?.body?.error_description ?? ''),
        `${OAUTH_GRANTS_PER_MEMBER} OAuth assistants a member; the next is refused in words (${capStatuses.join(',')})`);
        resetOAuthForTests();
        resetLimits();
        const roleReg = await call('POST', '/oauth/register', { body: { client_name: 'Role Check', redirect_uris: [REDIRECT] } });
        const roleVerifier = crypto.randomBytes(32).toString('base64url');
        const roleCode = (await consent(authorizeUrl(roleReg.body.client_id, { code_challenge: crypto.createHash('sha256').update(roleVerifier).digest('base64url') }), admin)).redirect?.searchParams.get('code') ?? '';
        revokeNodeRole(admin.pub, 'admin', owner.pub);
        const demotedExchange = await call('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: roleCode, client_id: roleReg.body.client_id, redirect_uri: REDIRECT, code_verifier: roleVerifier } });
        grantNodeRole(admin.pub, 'admin', 'SYSTEM');
        assert(roleCode.length > 0 && demotedExchange.status === 400 && /no longer an owner or admin/.test(demotedExchange.body?.error_description ?? ''),
            `approved as an admin, demoted before the exchange: the token step reads the role again (${show(demotedExchange)})`);

        // Refresh with another client's id; a forged revoke; framing; a fragment or credentials in a redirect.
        resetLimits();
        const fg = await manualConnect(owner, 'Forge Check');
        const fgId = (getLocalConfig().agentOAuthGrants ?? []).find(g => g.clientName === 'Forge Check')?.id ?? '';
        resetLimits();
        const forgedRefresh = await call('POST', '/oauth/revoke', { form: { token: `bpr_${fgId}_${crypto.randomBytes(32).toString('hex')}` } });
        const forgedAccess = await call('POST', '/oauth/revoke', { form: { token: `bpo_${fgId}_${crypto.randomBytes(32).toString('hex')}` } });
        assert(!!fgId && forgedRefresh.status === 200 && forgedAccess.status === 200 && (getLocalConfig().agentOAuthGrants ?? []).some(g => g.id === fgId) && (await mcpStatus(fg.access)) === 200,
            'a refresh or access token forged for a real grant id at /oauth/revoke: 200 (RFC 7009), and the grant stays');
        const otherClient = await call('POST', '/oauth/register', { body: { client_name: 'Other Client', redirect_uris: [REDIRECT] } });
        resetLimits();
        const wrongClient = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: fg.refresh, client_id: otherClient.body?.client_id ?? '' } });
        const rightClient = await call('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: fg.refresh, client_id: fg.clientId } });
        assert(wrongClient.status === 400 && /another client/.test(wrongClient.body?.error_description ?? '') && rightClient.status === 200,
            `a refresh token sent with another client's id → refused, nothing revoked: its own client's refresh still works (${show(wrongClient)}; ${rightClient.status})`);
        resetLimits();
        const framed = await fetch(authorizeUrl(otherClient.body?.client_id ?? ''), { redirect: 'manual' });
        await framed.text();
        assert(framed.status === 200 && /frame-ancestors 'none'/.test(framed.headers.get('content-security-policy') ?? '') && framed.headers.get('x-frame-options') === 'DENY',
            'the consent page cannot be framed (CSP frame-ancestors none, X-Frame-Options DENY)');
        const fragment = await call('POST', '/oauth/register', { body: { redirect_uris: ['https://assistant.example/cb#x'] } });
        const credentials = await call('POST', '/oauth/register', { body: { redirect_uris: ['https://user:pw@assistant.example/cb'] } });
        assert(fragment.status === 400 && credentials.status === 400, `a redirect address with a fragment or credentials in it is refused (${fragment.status}, ${credentials.status})`);

        // An OAuth assistant's suggestion: filed, on its member's card, approved by that member only.
        const poster = keypair(), reporter = keypair();
        addMember(poster, 'Pat');
        addMember(reporter, 'Rita');
        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status)
                    VALUES ('post-oauth-1', 'offer', 'general', 'Bike repair', 'Bring it on Saturday.', 10, ?, 'active')`).run(poster.pub);
        const report = submitReport(reporter.pub, poster.pub, 'Looks like spam', 'post-oauth-1');
        resetLimits();
        const sg = await manualConnect(admin, 'Suggesting Claude');
        const filed = await call('POST', '/mcp', {
            body: rpc('tools/call', 1, { name: 'suggest_action', arguments: { kind: 'dismiss_report', report_id: report?.id, reason: 'It is a real offer.' } }),
            headers: { ...MCP_HEADERS, ...bearer(sg.access) },
        });
        resetLimits();
        const sAdmin = await keySignIn(admin), sOwner = await keySignIn(owner);
        const card = ((await call('GET', '/api/local/admin/agent/suggestions', { headers: { 'X-Admin-Session': sAdmin ?? '' } })).body?.suggestions ?? [])[0];
        assert(filed.status === 200 && !filed.body?.result?.isError && card?.agent?.name === 'Suggesting Claude' && card?.agent?.member === 'Adam' && card?.approve?.path === `/api/local/admin/reports/${report?.id}/dismiss`,
            `an OAuth assistant's suggestion is filed and waits on its member's card with Approve (${show(filed)})`);
        const byOwner = await call('POST', `/api/local/admin/reports/${report?.id}/dismiss`, { body: { suggestion: card?.id }, headers: { 'X-Admin-Session': sOwner ?? '' } });
        resetLimits();
        const byMember = await call('POST', `/api/local/admin/reports/${report?.id}/dismiss`, { body: { suggestion: card?.id }, headers: { 'X-Admin-Session': sAdmin ?? '' } });
        const reportNow = (db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(report?.id) as any)?.status;
        assert(byOwner.status === 403 && byMember.status === 200 && reportNow === 'reviewed',
            `only its member approves it (owner ${byOwner.status}, member ${byMember.status}, report ${reportNow})`);

        // No access token, refresh token, code or verifier in any log line or the local config.
        const secrets = [tokens?.access_token, tokens?.refresh_token, m1.code, m1.verifier, m1.access, m1.refresh, m2.access, m2.refresh, r1.body?.refresh_token,
            lifeCode, lifeVerifier, lg.access, lg.refresh, refreshLate.body?.access_token, fg.access, fg.refresh, sg.access, sg.refresh]
            .filter((s): s is string => typeof s === 'string' && s.length >= 16);
        const logText = (db.prepare('SELECT message, metadata FROM system_logs').all() as any[]).map(r => `${r.message} ${r.metadata ?? ''}`).join('\n');
        const cfgText = JSON.stringify(getLocalConfig());
        const leaked = secrets.filter(s => logText.includes(s) || cfgText.includes(s));
        assert(secrets.length >= 16 && leaked.length === 0, `no access token, refresh token, code or verifier in any log line or the local config (${secrets.length} checked, ${leaked.length} found)`);
    } finally {
        console.log(`\n${passed}/${run} passed`);
        setTimeout(() => process.exit(process.exitCode ?? 0), 50);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
