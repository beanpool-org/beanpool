/**
 * Sign in to /settings by scanning a QR code with the BeanPool app — the HTTP side of settings-signin-pairing.ts.
 *
 *   POST /api/local/admin/auth/pairing              browser: new pairing; sets the binding cookie
 *   POST /api/local/admin/auth/pairing/:id/wait     browser: long-poll (≤25 s) with the binding cookie;
 *                                                   on approval, the admin_session cookie + a CSRF token
 *   GET  /api/local/admin/auth/pairing/:id          phone: the short code and "Firefox on Windows" to confirm
 *   POST /api/local/admin/auth/pairing/:id/approve  phone: { memberPubkey, signature, totpCode? }
 *   POST /api/local/admin/auth/pairing/:id/decline  phone: { memberPubkey, signature }
 *
 * The phone's calls go through the auth limiter (15 a minute per client). The browser's creation has its own
 * brake inside the pairing module.
 */

import Router from '@koa/router';
import type { RouteDeps } from './types.js';
import { clientLimiterKey } from '../client-ip.js';
import {
    createPairing,
    describePairing,
    approvePairing,
    declinePairing,
    redeemPairing,
    waitForPairing,
    bindingCookieName,
    isPairingId,
    PAIRING_TTL_MS,
} from '../settings-signin-pairing.js';

export const PAIRING_POLL_MS = 25_000;
const COOKIE_PATH = '/api/local/admin/auth/pairing';

export function createSettingsSigninRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const bodyOf = (ctx: any) => (ctx as any).requestBody || (ctx.request as any)?.body || {};

    router.post('/api/local/admin/auth/pairing', async (ctx) => {
        const res = createPairing({ clientKey: clientLimiterKey(ctx as any), userAgent: ctx.get('user-agent') });
        if (!res.ok) {
            ctx.status = res.status;
            ctx.body = { error: res.error };
            return;
        }
        ctx.cookies.set(bindingCookieName(res.pairingId), res.secret, {
            httpOnly: true,
            sameSite: 'strict',
            maxAge: PAIRING_TTL_MS + 90_000,
            path: COOKIE_PATH,
        });
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { pairingId: res.pairingId, shortCode: res.shortCode, expiresAt: res.expiresAt, ttlMs: PAIRING_TTL_MS };
    });

    router.post('/api/local/admin/auth/pairing/:id/wait', async (ctx) => {
        const id = ctx.params.id;
        ctx.set('Cache-Control', 'no-store');
        if (!isPairingId(id)) { ctx.status = 404; ctx.body = { status: 'unknown' }; return; }
        const secret = ctx.cookies.get(bindingCookieName(id)) || undefined;

        let res = redeemPairing(id, secret);
        if (res.kind === 'waiting' && bodyOf(ctx).wait !== false) {
            const waited = await waitForPairing(id, PAIRING_POLL_MS);
            if (!waited) { ctx.status = 429; ctx.body = { error: 'Already waiting on this code in another tab.' }; return; }
            res = redeemPairing(id, secret);
        }

        switch (res.kind) {
            case 'waiting':
                ctx.body = { status: 'waiting', expiresAt: res.expiresAt, ...(res.notice ? { notice: res.notice } : {}) };
                return;
            case 'signed-in':
                ctx.cookies.set('admin_session', res.sessionId, {
                    httpOnly: true,
                    sameSite: 'lax',
                    maxAge: 12 * 3600 * 1000,
                    path: '/',
                });
                ctx.cookies.set(bindingCookieName(id), '', { maxAge: 0, path: COOKIE_PATH });
                if (res.csrfToken) ctx.set('X-CSRF-Token', res.csrfToken);
                ctx.body = {
                    status: 'signed-in',
                    csrfToken: res.csrfToken,
                    memberPubkey: res.memberPubkey,
                    role: res.role,
                    hardExpiresAt: res.hardExpiresAt,
                    idleExpiresAt: res.idleExpiresAt,
                };
                return;
            case 'wrong-browser':
                ctx.status = 403;
                ctx.body = { status: 'wrong-browser', error: 'This sign-in belongs to the browser that showed the code.' };
                return;
            case 'unknown':
                ctx.status = 404;
                ctx.body = { status: 'unknown' };
                return;
            case 'failed':
                ctx.status = 401;
                ctx.body = { status: 'failed', error: res.error };
                return;
            default:
                ctx.status = 410;
                ctx.body = { status: res.kind };
        }
    });

    router.get('/api/local/admin/auth/pairing/:id', async (ctx) => {
        if (!deps.rateLimit(ctx as any)) return;
        const res = describePairing(ctx.params.id);
        ctx.set('Cache-Control', 'no-store');
        if (!res.ok) { ctx.status = res.status; ctx.body = { error: res.error }; return; }
        ctx.body = { shortCode: res.shortCode, browser: res.browser, expiresAt: res.expiresAt };
    });

    router.post('/api/local/admin/auth/pairing/:id/approve', async (ctx) => {
        if (!deps.rateLimit(ctx as any)) return;
        const { memberPubkey, signature, totpCode } = bodyOf(ctx);
        if (typeof memberPubkey !== 'string' || typeof signature !== 'string' || !memberPubkey || !signature) {
            ctx.status = 400;
            ctx.body = { error: 'memberPubkey and signature are required' };
            return;
        }
        const res = approvePairing({
            pairingId: ctx.params.id,
            memberPubkey,
            signature,
            totpCode: typeof totpCode === 'string' ? totpCode : undefined,
        });
        if (!res.ok) {
            ctx.status = res.status;
            ctx.body = { error: res.error, reason: res.reason, ...(res.totpRequired ? { totpRequired: true } : {}) };
            return;
        }
        ctx.body = { success: true, role: res.role };
    });

    router.post('/api/local/admin/auth/pairing/:id/decline', async (ctx) => {
        if (!deps.rateLimit(ctx as any)) return;
        const { memberPubkey, signature } = bodyOf(ctx);
        const res = declinePairing({ pairingId: ctx.params.id, memberPubkey: String(memberPubkey || ''), signature: String(signature || '') });
        if (!res.ok) { ctx.status = res.status; ctx.body = { error: res.error }; return; }
        ctx.body = { success: true };
    });

    return router;
}
