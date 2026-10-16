/**
 * Pairing Routes — Ephemeral QR Device Pairing Endpoints (#89).
 *
 *   POST /api/pair/init      browser: opens a session; sets its binding cookie (httpOnly, SameSite=Strict, /api/pair)
 *   POST /api/pair/transfer  phone: the sealed account; answers the four digits the phone shows
 *   GET  /api/pair/poll      browser, with the binding cookie: 'confirming' until the digits are typed, then the payload.
 *                            Without it (the phone's probe): 403 wrong-browser, with how many digits this relay asks for
 *   POST /api/pair/confirm   browser, with the binding cookie: { sessionId, code }; three wrong burn the session
 *   POST /api/pair/cancel
 */

import Router from '@koa/router';
import type { RouteDeps } from './types.js';
import {
    initPairingSession,
    transferPairingPayload,
    pollPairingSession,
    cancelPairingSession,
    confirmPairingTransfer,
    PAIRING_RELAY_LIMITS,
} from '../pairing-relay.js';

const COOKIE_PATH = '/api/pair';
/** One cookie per session, so two tabs don't clash. */
export const pairBindingCookieName = (sessionId: string) => `bp_pair_${sessionId.slice(0, 16)}`;

export function createPairingRoutes(deps: RouteDeps): Router {
    const router = new Router();

    /**
     * POST /api/pair/init
     * Initiated by unauthenticated desktop PWA.
     */
    router.post('/api/pair/init', async (ctx) => {
        if (!deps.rateLimit(ctx, 'pairing')) return;

        const { sessionId, desktopPubHex } = (ctx.request as any).body || {};

        if (!sessionId || !desktopPubHex) {
            ctx.status = 400;
            ctx.body = { error: 'Missing sessionId or desktopPubHex' };
            return;
        }

        const res = initPairingSession(sessionId, desktopPubHex);
        if (!res.ok) {
            ctx.status = 400;
            ctx.body = { error: res.error };
            return;
        }

        ctx.cookies.set(pairBindingCookieName(sessionId), res.secret!, {
            httpOnly: true,
            sameSite: 'strict',
            maxAge: PAIRING_RELAY_LIMITS.ttlMs + 30_000,
            path: COOKIE_PATH,
        });
        ctx.set('Cache-Control', 'no-store');
        ctx.body = {
            success: true,
            expiresAt: res.expiresAt,
        };
    });

    /**
     * GET /api/pair/poll
     * Polled by waiting desktop PWA (runs in-memory without auth bucket consumption).
     */
    router.get('/api/pair/poll', async (ctx) => {
        const sessionId = ctx.query.session as string;
        if (!sessionId || typeof sessionId !== 'string' || !/^[0-9a-fA-F]{16,64}$/.test(sessionId)) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid or missing session query parameter' };
            return;
        }

        const res = pollPairingSession(sessionId, ctx.cookies.get(pairBindingCookieName(sessionId)) || undefined);
        ctx.set('Cache-Control', 'no-store');
        // The phone probes here before it reads the 12 words: `confirmDigits` tells it this relay asks for four. A
        // relay that asks for two never said it, so a phone that shows four refuses it with nothing sent.
        if (res.status === 'wrong-browser') {
            ctx.status = 403;
            ctx.body = { ...res, confirmDigits: PAIRING_RELAY_LIMITS.confirmDigits };
            return;
        }
        ctx.body = res;
    });

    /**
     * POST /api/pair/transfer
     * Submitted by authenticated mobile app with encrypted payload.
     */
    router.post('/api/pair/transfer', async (ctx) => {
        if (!deps.rateLimit(ctx, 'pairing')) return;

        const { sessionId, mobilePubHex, nonceHex, ciphertextHex, confirm } = (ctx.request as any).body || {};

        if (!sessionId || !mobilePubHex || !nonceHex || !ciphertextHex) {
            ctx.status = 400;
            ctx.body = { error: 'Missing required transfer fields (sessionId, mobilePubHex, nonceHex, ciphertextHex)' };
            return;
        }

        // Only an app that shows the four digits says so (`confirm: 'four-digits'`). Every app before #1983 sends no
        // `confirm` and shows none; an app from #1983 until four digits (SEC-INV-02) sends `confirm: 'digits'`, accepts
        // only two and drops four with an error, but never cancels: the relay would go on holding its account. Either
        // way the browser would wait for digits nobody can read. Refused before the relay is touched, so nothing is held
        // and the session stays open for a newer app. An old app shows a 4xx's `error` in its sheet as it is, so the
        // words are written for it.
        if (confirm !== 'four-digits') {
            ctx.status = 409;
            ctx.body = { error: 'This BeanPool app is too old to show the four digits, so nothing was sent. Update the BeanPool app, then scan again.' };
            return;
        }

        const res = transferPairingPayload(sessionId, mobilePubHex, nonceHex, ciphertextHex);
        if (!res.ok) {
            ctx.status = 400;
            ctx.body = { error: res.error };
            return;
        }

        ctx.body = { success: true, confirmCode: res.confirmCode };
    });

    /**
     * POST /api/pair/confirm
     * The browser types the four digits the phone shows, with its binding cookie.
     */
    router.post('/api/pair/confirm', async (ctx) => {
        const { sessionId, code } = (ctx.request as any).body || {};
        if (!sessionId || typeof sessionId !== 'string' || !/^[0-9a-fA-F]{16,64}$/.test(sessionId)) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid or missing sessionId' };
            return;
        }
        const res = confirmPairingTransfer(sessionId, ctx.cookies.get(pairBindingCookieName(sessionId)) || undefined, code);
        ctx.set('Cache-Control', 'no-store');
        ctx.status = res.result === 'released' ? 200
            : res.result === 'wrong' ? 400
            : res.result === 'wrong-browser' ? 403
            : 410;
        ctx.body = res;
    });

    /**
     * POST /api/pair/cancel
     * Cancels an active pairing session.
     */
    router.post('/api/pair/cancel', async (ctx) => {
        const { sessionId } = (ctx.request as any).body || {};
        if (!sessionId || typeof sessionId !== 'string') {
            // Reliability fix: return 400 Bad Request when sessionId parameter is missing
            ctx.status = 400;
            ctx.body = { error: 'Missing sessionId parameter' };
            return;
        }

        cancelPairingSession(sessionId);
        ctx.status = 200;
        ctx.body = { success: true };
    });

    return router;
}
