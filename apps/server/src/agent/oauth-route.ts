/**
 * The HTTP side of the AI assistant's OAuth door (admin MCP design §2, slice S2; state in agent/oauth.ts):
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728: /mcp's resource, this node its authorization server
 *   GET  /.well-known/oauth-authorization-server      RFC 8414: issuer = this node's public URL; S256 only; scope agent
 *   POST /oauth/register                              RFC 7591: public clients; https or localhost redirects; braked
 *   GET  /oauth/authorize                             the consent page: who asks, where its answers go, what it reads,
 *                                                     then the phone's QR sign-in with the two-digit number match
 *   POST /oauth/authorize/:id/wait | /confirm         the page's poll and its digits (bound to the page by a cookie)
 *   POST /oauth/token                                 code → tokens (PKCE S256, exact redirect, resource), refresh rotation
 *   POST /oauth/revoke                                RFC 7009
 *
 * The owners' switch off → every one of these answers 404, as /mcp does. Nothing here signs a browser in to Settings:
 * the phone's approval of an assistant yields a code for the assistant, never a session.
 */
import Router from '@koa/router';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import { buildSettingsSigninQr } from '@beanpool/core';
import type { RouteDeps } from '../routes/types.js';
import { clientIp, clientLimiterKey } from '../client-ip.js';
import { directoryName } from '../state-engine.js';
import { nodeRoleOf } from '../engine/node-roles.js';
import { logger } from '../logger.js';
import { noteSecurityEvent } from '../services/security-signal.js';
import {
    bindingCookieName, confirmPairing, createPairing, isPairingId, redeemPairing, waitForPairing, type RedeemResult,
} from '../settings-signin-pairing.js';
import { cleanMemberText } from './fence.js';
import { forgetAgentGrant } from './limits.js';
import { aiAssistantsAllowed, MCP_PATH, nodeUrlFor } from './mcp-route.js';
import {
    consentRequest, dropConsentRequest, exchangeCode, findClient, holdConsentRequest, issueCode, OAUTH_SCOPE, redirectHost,
    refreshGrant, registerClient, revokeByToken, type OAuthGrantView, type TokenResult,
} from './oauth.js';
import { dropSuggestionsOf } from './suggestions.js';
import { offersSuggestions } from './tools.js';
import { agentConnectedWords, agentDisconnectedWords } from './welcome.js';

export const OAUTH_COOKIE_PATH = '/oauth/authorize';
const POLL_MS = 25_000;
const FORM_MAX_BYTES = 8 * 1024;

/** The issuer, and the resource /mcp is: this node's public URL (or the host it was reached at, a LAN node). */
export const issuerFor = (ctx: any): string => nodeUrlFor(ctx);
export const resourceFor = (ctx: any): string => `${nodeUrlFor(ctx)}${MCP_PATH}`;
export const resourceMetadataUrl = (ctx: any): string => `${nodeUrlFor(ctx)}/.well-known/oauth-protected-resource${MCP_PATH}`;

/** The resource an assistant may name: /mcp's URL, or the node's own (design §2: "resource indicator = the node's URL"). */
function resourceAccepted(ctx: any, value: string): boolean {
    const v = value.replace(/\/+$/, '');
    return v === resourceFor(ctx) || v === issuerFor(ctx);
}

function off(ctx: any): boolean {
    if (aiAssistantsAllowed()) return false;
    ctx.status = 404;
    ctx.body = 'Not Found';
    return true;
}

function oauthError(ctx: any, status: number, error: string, description: string): void {
    ctx.status = status;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { error, error_description: description };
}

/** A token or revoke request's fields: a form (as RFC 6749 asks) read here, or JSON the server's parser read already. */
async function formFields(ctx: any): Promise<Record<string, string> | null> {
    const type = String(ctx.get('content-type') || '').toLowerCase();
    if (type.startsWith('application/x-www-form-urlencoded')) {
        const declared = Number(ctx.get('content-length'));
        if (Number.isFinite(declared) && declared > FORM_MAX_BYTES) return null;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of ctx.req as AsyncIterable<Buffer>) {
            size += chunk.length;
            if (size > FORM_MAX_BYTES) return null;
            chunks.push(chunk);
        }
        const out: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) if (!(k in out)) out[k] = v;
        return out;
    }
    const b = ctx.requestBody;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) if (typeof v === 'string') out[k] = v;
    return out;
}

/**
 * Owners are told of a new connection, or of a grant a reused code or refresh token revoked (high: a copied token). The role
 * named is its member's now (null: read here).
 */
function tellOwners(kind: 'connected' | 'reuse' | 'revoked', grant: OAuthGrantView, given: 'owner' | 'admin' | null): void {
    const live = nodeRoleOf(grant.member);
    const role = given ?? (live === 'owner' || live === 'admin' ? live : null);
    const name = `${cleanMemberText(grant.clientName, 60) || 'unnamed'}, sending to ${redirectHost(grant.redirectUri)}`;
    if (kind === 'connected') {
        noteSecurityEvent({
            key: 'sec.agent', actor: grant.member, actorRole: role ?? 'admin',
            detail: agentConnectedWords(name, role ?? 'admin', role === 'owner', offersSuggestions()),
        });
        return;
    }
    if (kind === 'reuse') {
        noteSecurityEvent({
            key: 'sec.agent', high: true, actor: grant.member, actorRole: role ?? 'admin',
            detail: `An AI assistant (${name}) was disconnected: a sign-in code or refresh token it had already used was presented again, so someone else may hold a copy. Its member can connect it again from their phone.`,
        });
        return;
    }
    noteSecurityEvent({ key: 'sec.agent', actor: grant.member, actorRole: role ?? 'admin', detail: agentDisconnectedWords(name, role ?? 'admin') });
}

function forgetGrant(id: string): void {
    forgetAgentGrant(id);
    dropSuggestionsOf(id);
}

function tokenAnswer(ctx: any, res: TokenResult, from: string): void {
    if (!res.ok) {
        if (res.revoked) {
            forgetGrant(res.revoked.id);
            logger.security('AGENT', 'Assistant disconnected: a used code or refresh token was presented again', { grant: res.revoked.id, from });
            tellOwners('reuse', res.revoked, null);
        }
        oauthError(ctx, res.status, res.error, res.description);
        return;
    }
    if (res.created) {
        logger.security('AGENT', 'Assistant connected through OAuth', { grant: res.grant.id, member: res.grant.member.slice(0, 16), sendsTo: redirectHost(res.grant.redirectUri) });
        tellOwners('connected', res.grant, null);
    }
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Pragma', 'no-cache');
    ctx.body = res.pair;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The consent page's words (design §2): the name never alone, the redirect host beside it and where everything goes. */
export function consentWords(clientName: string, sendsTo: string, community: string): { heading: string; lines: string[] } {
    const who = clientName ? `An AI assistant calling itself “${clientName}”, at ${sendsTo},` : `An AI assistant at ${sendsTo}`;
    return {
        heading: `${who} asks to connect to ${community} for you`,
        lines: [
            `Everything it reads goes to ${sendsTo}. If you did not just add ${community} as a connector in your assistant, close this page.`,
            'It will read: the server\'s health, backups and totals; the reports waiting for moderators; the join requests; what needs an admin now.',
            'It can take a backup (owners only) and SUGGEST actions, which change nothing until you approve them on your phone.',
            'It can never read messages, balances, keys, addresses, photos or logs, or change settings, roles, keys or money.',
            `To connect it, scan this code with the BeanPool app on your phone (Manage → Manage this community from a computer), check that the phone names ${sendsTo}, and type the two digits it shows.`,
        ],
    };
}

function errorPage(ctx: any, status: number, message: string): void {
    ctx.status = status;
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    ctx.type = 'text/html; charset=utf-8';
    ctx.body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect an AI assistant</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">This assistant cannot connect</h1><p>${escapeHtml(message)}</p></body></html>`;
}

/** A redirect back to the assistant with an OAuth error (only once its redirect address is known to be its own). */
function redirectWithError(ctx: any, redirectUri: string, error: string, description: string, state: string | null): void {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (state !== null) u.searchParams.set('state', state);
    u.searchParams.set('iss', issuerFor(ctx));
    ctx.set('Cache-Control', 'no-store');
    ctx.redirect(u.toString());
}

function codeRedirect(ctx: any, redirectUri: string, code: string, state: string | null): string {
    const u = new URL(redirectUri);
    u.searchParams.set('code', code);
    if (state !== null) u.searchParams.set('state', state);
    u.searchParams.set('iss', issuerFor(ctx));
    return u.toString();
}

export function createOAuthRoutes(deps: RouteDeps): Router {
    const router = new Router();

    const protectedResource = async (ctx: any) => {
        if (off(ctx)) return;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = {
            resource: resourceFor(ctx),
            authorization_servers: [issuerFor(ctx)],
            scopes_supported: [OAUTH_SCOPE],
            bearer_methods_supported: ['header'],
            resource_name: `${cleanMemberText(directoryName(), 120) || 'BeanPool community'} (BeanPool)`,
        };
    };
    router.get('/.well-known/oauth-protected-resource', protectedResource);
    router.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

    router.get('/.well-known/oauth-authorization-server', async (ctx) => {
        if (off(ctx)) return;
        const iss = issuerFor(ctx);
        ctx.set('Cache-Control', 'no-store');
        ctx.body = {
            issuer: iss,
            authorization_endpoint: `${iss}/oauth/authorize`,
            token_endpoint: `${iss}/oauth/token`,
            registration_endpoint: `${iss}/oauth/register`,
            revocation_endpoint: `${iss}/oauth/revoke`,
            scopes_supported: [OAUTH_SCOPE],
            response_types_supported: ['code'],
            response_modes_supported: ['query'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            revocation_endpoint_auth_methods_supported: ['none'],
            authorization_response_iss_parameter_supported: true,
        };
    });

    router.post('/oauth/register', async (ctx) => {
        if (off(ctx)) return;
        const res = registerClient((ctx as any).requestBody, clientLimiterKey(ctx as any));
        if (!res.ok) {
            if (res.status === 429) {
                ctx.set('Retry-After', '60');
                logger.warn('AGENT', 'Assistant registration refused: too many', { from: clientLimiterKey(ctx as any).slice(0, 24) });
            }
            oauthError(ctx, res.status, res.error, res.description);
            return;
        }
        logger.info('AGENT', 'Assistant registered (waiting for a phone to approve)', { sendsTo: redirectHost(res.client.redirectUris[0]) });
        ctx.status = 201;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = {
            client_id: res.client.clientId,
            client_id_issued_at: Math.floor(res.client.createdAt / 1000),
            client_name: res.client.clientName || undefined,
            redirect_uris: res.client.redirectUris,
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            scope: OAUTH_SCOPE,
        };
    });

    router.get('/oauth/authorize', async (ctx) => {
        if (off(ctx)) return;
        const q = ctx.query as Record<string, unknown>;
        const one = (k: string): string | null => (typeof q[k] === 'string' ? q[k] as string : null);
        // Until the client and its redirect address are known to belong together, nothing is sent anywhere: a page.
        const client = findClient(one('client_id'));
        if (!client) { errorPage(ctx, 400, 'This assistant is not registered here (or waited more than an hour). Add the connector in your assistant again.'); return; }
        const redirectUri = one('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
        if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
            errorPage(ctx, 400, 'This assistant asked to send the answer to an address it did not register. Nothing was sent.');
            return;
        }
        const state = one('state');
        if (one('response_type') !== 'code') { redirectWithError(ctx, redirectUri, 'unsupported_response_type', 'Only response_type=code', state); return; }
        const challenge = one('code_challenge');
        if (!challenge || one('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
            redirectWithError(ctx, redirectUri, 'invalid_request', 'PKCE with code_challenge_method=S256 is required', state);
            return;
        }
        const scope = one('scope');
        if (scope !== null && scope.split(' ').some((s) => s && s !== OAUTH_SCOPE)) {
            redirectWithError(ctx, redirectUri, 'invalid_scope', `The only scope is ${OAUTH_SCOPE}`, state);
            return;
        }
        const resource = one('resource');
        if (resource !== null && !resourceAccepted(ctx, resource)) {
            redirectWithError(ctx, redirectUri, 'invalid_target', 'resource is not this server', state);
            return;
        }
        const sendsTo = redirectHost(redirectUri);
        const created = createPairing({
            clientKey: clientLimiterKey(ctx as any), userAgent: ctx.get('user-agent'), requesterAddress: clientIp(ctx as any),
            agent: { name: client.clientName, sendsTo },
        });
        if (!created.ok) { errorPage(ctx, created.status, created.error); return; }
        holdConsentRequest({
            pairingId: created.pairingId, clientId: client.clientId, clientName: client.clientName, redirectUri, state,
            codeChallenge: challenge, resource: resource ?? resourceFor(ctx), createdAt: Date.now(),
        });
        ctx.cookies.set(bindingCookieName(created.pairingId), created.secret, {
            httpOnly: true, sameSite: 'strict', maxAge: 4 * 60_000, path: OAUTH_COOKIE_PATH,
        });
        const community = cleanMemberText(directoryName(), 120) || 'this BeanPool community';
        const words = consentWords(client.clientName, sendsTo, community);
        const qr = buildSettingsSigninQr({ nodeUrl: issuerFor(ctx), pairingId: created.pairingId, shortCode: created.shortCode });
        const svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 240 });
        const nonce = crypto.randomBytes(16).toString('base64');
        ctx.set('Cache-Control', 'no-store');
        ctx.set('Referrer-Policy', 'no-referrer');
        ctx.set('Content-Security-Policy', `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`);
        ctx.set('X-Frame-Options', 'DENY');
        ctx.type = 'text/html; charset=utf-8';
        ctx.body = consentPage({ words, svg, shortCode: created.shortCode, pairingId: created.pairingId, nonce });
    });

    /** The page's poll or its digits: the phone's approval becomes a code, sent back to the assistant by the page. */
    function answer(ctx: any, id: string, res: RedeemResult | { kind: 'wrong'; triesLeft: number }): void {
        ctx.set('Cache-Control', 'no-store');
        const r = consentRequest(id);
        switch (res.kind) {
            case 'waiting': ctx.body = { status: 'waiting', ...(res.notice ? { notice: res.notice } : {}) }; return;
            case 'confirm': ctx.body = { status: 'confirm' }; return;
            case 'wrong': ctx.status = 400; ctx.body = { status: 'wrong', triesLeft: res.triesLeft, error: 'Those are not the digits on the phone.' }; return;
            case 'agent-approved': {
                if (!r || !aiAssistantsAllowed()) { ctx.status = 410; ctx.body = { status: 'expired' }; return; }
                const code = issueCode(r, res.memberPubkey);
                ctx.cookies.set(bindingCookieName(id), '', { maxAge: 0, path: OAUTH_COOKIE_PATH });
                ctx.body = { status: 'approved', redirect: codeRedirect(ctx, r.redirectUri, code, r.state) };
                return;
            }
            case 'wrong-browser': ctx.status = 403; ctx.body = { status: 'wrong-browser', error: 'This approval belongs to the page that showed the code.' }; return;
            case 'unknown': ctx.status = 404; ctx.body = { status: 'unknown' }; return;
            default: {
                // Declined, refused or expired: the assistant is told no, once.
                if (r && (res.kind === 'declined' || res.kind === 'refused')) {
                    dropConsentRequest(id);
                    const u = new URL(r.redirectUri);
                    u.searchParams.set('error', 'access_denied');
                    if (r.state !== null) u.searchParams.set('state', r.state);
                    u.searchParams.set('iss', issuerFor(ctx));
                    ctx.status = 410;
                    ctx.body = { status: res.kind, redirect: u.toString() };
                    return;
                }
                ctx.status = 410;
                ctx.body = { status: res.kind };
            }
        }
    }

    router.post('/oauth/authorize/:id/wait', async (ctx) => {
        if (off(ctx)) return;
        const id = ctx.params.id;
        if (!isPairingId(id) || !consentRequest(id)) { ctx.status = 404; ctx.body = { status: 'unknown' }; return; }
        const secret = ctx.cookies.get(bindingCookieName(id)) || undefined;
        let res = redeemPairing(id, secret);
        if (res.kind === 'waiting' && (ctx as any).requestBody?.wait !== false) {
            const waited = await waitForPairing(id, POLL_MS);
            if (!waited) { ctx.status = 429; ctx.body = { error: 'Already waiting on this code in another tab.' }; return; }
            res = redeemPairing(id, secret);
        }
        answer(ctx, id, res);
    });

    router.post('/oauth/authorize/:id/confirm', async (ctx) => {
        if (off(ctx)) return;
        const id = ctx.params.id;
        if (!isPairingId(id) || !consentRequest(id)) { ctx.status = 404; ctx.body = { status: 'unknown' }; return; }
        const res = confirmPairing(id, ctx.cookies.get(bindingCookieName(id)) || undefined, (ctx as any).requestBody?.code);
        answer(ctx, id, res);
    });

    router.post('/oauth/token', async (ctx) => {
        if (off(ctx)) return;
        if (!deps.rateLimit(ctx as any)) return;
        const f = await formFields(ctx);
        if (!f) { oauthError(ctx, 413, 'invalid_request', 'Request body too large'); return; }
        const from = clientLimiterKey(ctx as any).slice(0, 24);
        if (f.resource !== undefined && !resourceAccepted(ctx, f.resource)) { oauthError(ctx, 400, 'invalid_target', 'resource is not this server'); return; }
        if (f.grant_type === 'authorization_code') {
            tokenAnswer(ctx, exchangeCode({ code: f.code, clientId: f.client_id, redirectUri: f.redirect_uri, verifier: f.code_verifier, resource: f.resource }), from);
            return;
        }
        if (f.grant_type === 'refresh_token') {
            tokenAnswer(ctx, refreshGrant({ refreshToken: f.refresh_token, clientId: f.client_id, resource: f.resource }), from);
            return;
        }
        oauthError(ctx, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token');
    });

    router.post('/oauth/revoke', async (ctx) => {
        if (off(ctx)) return;
        if (!deps.rateLimit(ctx as any)) return;
        const f = await formFields(ctx);
        if (!f) { oauthError(ctx, 413, 'invalid_request', 'Request body too large'); return; }
        const revoked = revokeByToken(f.token, f.client_id);
        if (revoked) {
            forgetGrant(revoked.id);
            logger.info('AGENT', 'Assistant disconnected itself (OAuth revoke)', { grant: revoked.id });
            tellOwners('revoked', revoked, null);
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.status = 200;
        ctx.body = {};
    });

    return router;
}

function consentPage(p: { words: { heading: string; lines: string[] }; svg: string; shortCode: string; pairingId: string; nonce: string }): string {
    const lines = p.words.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect an AI assistant</title>
<style nonce="${p.nonce}">
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1917;--muted:#57534e;--line:#d6d3d1}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#d6d3d1;--line:#57534e}}
body{background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;max-width:34rem;margin:1.5rem auto;padding:0 1rem;line-height:1.45}
h1{font-size:1.2rem}p{margin:.6rem 0}.qr{background:#fff;display:inline-block;padding:.5rem;border-radius:.5rem}
.code{font-family:ui-monospace,monospace;font-size:1.1rem;letter-spacing:.1em}#digits{font-size:1.4rem;width:4ch;text-align:center}
.muted{color:var(--muted)}button{font-size:1rem;padding:.4rem .9rem}
</style></head><body>
<h1 id="who">${escapeHtml(p.words.heading)}</h1>${lines}
<div class="qr">${p.svg}</div>
<p class="muted">The phone should show the code <span class="code">${escapeHtml(p.shortCode)}</span>.</p>
<form id="confirm" hidden><label for="digits">Type the two digits your phone shows: </label><input id="digits" inputmode="numeric" maxlength="2" autocomplete="off"> <button type="submit">Connect</button></form>
<p id="status" role="status" class="muted">Waiting for your phone…</p>
<script nonce="${p.nonce}">
(function(){
var id=${JSON.stringify(p.pairingId)},base='/oauth/authorize/'+id,st=document.getElementById('status'),form=document.getElementById('confirm');
function go(r){if(r&&r.redirect){location.replace(r.redirect);return true}return false}
function show(r){
 if(!r){st.textContent='Lost touch with the server: reload to try again.';return}
 if(r.status==='confirm'){form.hidden=false;st.textContent='Approved on the phone: type its two digits here.';document.getElementById('digits').focus();return}
 if(r.status==='approved'){st.textContent='Connected. Taking you back to your assistant…';go(r);return}
 if(r.status==='wrong'){st.textContent=r.error+' Tries left: '+r.triesLeft;return}
 if(r.status==='waiting'){st.textContent=r.notice==='not-admin'?'That phone is not an owner or admin here. Waiting…':'Waiting for your phone…';poll();return}
 form.hidden=true;st.textContent=r.status==='declined'?'Declined on the phone: nothing was connected.':'This request ended: nothing was connected. Start again from your assistant.';go(r);
}
function post(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{}),credentials:'same-origin'}).then(function(x){return x.json()}).catch(function(){return null})}
function poll(){post(base+'/wait').then(show)}
form.addEventListener('submit',function(e){e.preventDefault();post(base+'/confirm',{code:document.getElementById('digits').value}).then(show)});
poll();
})();
</script></body></html>`;
}
