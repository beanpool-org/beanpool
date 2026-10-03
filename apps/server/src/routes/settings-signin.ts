/**
 * Sign in to /settings by scanning a QR code with the BeanPool app — the HTTP side of settings-signin-pairing.ts.
 *
 *   POST /api/local/admin/auth/pairing              browser: new pairing; sets the binding cookie
 *   POST /api/local/admin/auth/pairing/:id/wait     browser: long-poll (≤25 s) with the binding cookie;
 *                                                   on approval, the admin_session cookie + a CSRF token,
 *                                                   or { status: 'confirm' } when the phone shows two digits
 *   POST /api/local/admin/auth/pairing/:id/confirm  browser: { code } — the phone's two digits, with the binding cookie
 *   GET  /api/local/admin/auth/pairing/:id          phone: the short code, "Firefox on Windows", how long ago it asked and
 *                                                   the time left; signed by a member who holds a role here, also the
 *                                                   computer's address and "same network"
 *   POST /api/local/admin/auth/pairing/:id/approve  phone: { memberPubkey, signature, confirm? }
 *   POST /api/local/admin/auth/pairing/:id/decline  phone: { memberPubkey, signature }
 *
 * The phone's calls go through the auth limiter (15 a minute per client). The browser's creation has its own
 * per-client limit inside the pairing module (PAIRING_CREATES_PER_MINUTE).
 */

import Router from '@koa/router';
import type { RouteDeps } from './types.js';
import { clientIp, clientLimiterKey } from '../client-ip.js';
import { setAdminSessionCookie } from '../admin-key-auth.js';
import { verifyMemberSignature } from '../engine/member-signature.js';
import { nodeRoleOf } from '../engine/node-roles.js';
import { SIGNED_FOR_HEADER } from '@beanpool/core';
import {
    createPairing,
    describePairing,
    approvePairing,
    confirmPairing,
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
        const res = createPairing({ clientKey: clientLimiterKey(ctx as any), userAgent: ctx.get('user-agent'), requesterAddress: clientIp(ctx as any) });
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
        answer(ctx, id, res);
    });

    router.post('/api/local/admin/auth/pairing/:id/confirm', async (ctx) => {
        const id = ctx.params.id;
        ctx.set('Cache-Control', 'no-store');
        if (!isPairingId(id)) { ctx.status = 404; ctx.body = { status: 'unknown' }; return; }
        const res = confirmPairing(id, ctx.cookies.get(bindingCookieName(id)) || undefined, bodyOf(ctx).code);
        if (res.kind === 'wrong') {
            ctx.status = 400;
            ctx.body = { status: 'wrong', triesLeft: res.triesLeft, error: 'Those are not the digits on the phone.' };
            return;
        }
        answer(ctx, id, res);
    });

    /** The page's answer for a poll or a confirm: a session, or where the pairing stands. */
    function answer(ctx: any, id: string, res: ReturnType<typeof redeemPairing>): void {
        switch (res.kind) {
            case 'waiting':
                ctx.body = { status: 'waiting', expiresAt: res.expiresAt, ...(res.notice ? { notice: res.notice } : {}) };
                return;
            case 'confirm':
                ctx.body = { status: 'confirm', confirmExpiresAt: res.confirmExpiresAt, confirmInSeconds: Math.max(0, Math.round((res.confirmExpiresAt - Date.now()) / 1000)) };
                return;
            case 'signed-in':
                setAdminSessionCookie(ctx, res.sessionId);
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
    }

    router.get('/api/local/admin/auth/pairing/:id', async (ctx) => {
        if (!deps.rateLimit(ctx as any)) return;
        const res = describePairing(ctx.params.id, Date.now(), clientIp(ctx as any));
        ctx.set('Cache-Control', 'no-store');
        if (!res.ok) { ctx.status = res.status; ctx.body = { error: res.error }; return; }
        const { ok: _ok, fromAddress, sameNetwork, ...shown } = res;
        // The pairing id is in the QR, so anyone who saw the screen can look it up: the computer's address, and whether
        // they share its network, go only to a member who could approve it (4171995201).
        const signer = signedBy(ctx);
        ctx.body = signer && nodeRoleOf(signer) ? { ...shown, fromAddress, sameNetwork } : shown;
    });

    /**
     * The member who signed this request as the app signs a GET, or null. /api/local/ is outside the signature
     * middleware (https-server.ts isSignatureBypassed), so the signature, its freshness, its community and its nonce
     * are checked here; a request that fails any of them is answered as unsigned.
     */
    function signedBy(ctx: any): string | null {
        const pubKeyHex = ctx.get('X-Public-Key');
        const signature = ctx.get('X-Signature');
        if (!pubKeyHex || !signature) return null;
        const verdict = verifyMemberSignature({
            pubKeyHex,
            signature,
            timestamp: ctx.get('X-Timestamp'),
            nonce: ctx.get('X-Nonce'),
            method: ctx.method,
            path: ctx.path,
            body: '',
            signedFor: ctx.get(SIGNED_FOR_HEADER) || null,
        }, { consumeNonce: true });
        return verdict.ok ? verdict.signer : null;
    }

    router.post('/api/local/admin/auth/pairing/:id/approve', async (ctx) => {
        if (!deps.rateLimit(ctx as any)) return;
        const { memberPubkey, signature, signedFor, confirm } = bodyOf(ctx);
        if (typeof memberPubkey !== 'string' || typeof signature !== 'string' || !memberPubkey || !signature) {
            ctx.status = 400;
            ctx.body = { error: 'memberPubkey and signature are required' };
            return;
        }
        const res = approvePairing({
            pairingId: ctx.params.id,
            memberPubkey,
            signature,
            signedFor,
            confirm: confirm === true,
        });
        if (!res.ok) {
            ctx.status = res.status;
            ctx.body = { error: res.error, reason: res.reason, ...(res.code ? { code: res.code } : {}) };
            return;
        }
        ctx.body = res.confirmCode
            ? { success: true, role: res.role, confirmCode: res.confirmCode, confirmExpiresAt: res.confirmExpiresAt }
            : { success: true, role: res.role };
    });

    router.post('/api/local/admin/auth/pairing/:id/decline', async (ctx) => {
        if (!deps.rateLimit(ctx as any)) return;
        const { memberPubkey, signature, signedFor } = bodyOf(ctx);
        const res = declinePairing({ pairingId: ctx.params.id, memberPubkey: String(memberPubkey || ''), signature: String(signature || ''), signedFor });
        if (!res.ok) { ctx.status = res.status; ctx.body = res.code ? { error: res.error, code: res.code } : { error: res.error }; return; }
        ctx.body = { success: true };
    });

    return router;
}
