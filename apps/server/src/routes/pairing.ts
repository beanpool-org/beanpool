/**
 * Pairing Routes — Ephemeral QR Device Pairing Endpoints (#89).
 *
 *   POST /api/pair/init      browser: opens a session; sets its binding cookie (httpOnly, SameSite=Strict, /api/pair)
 *   POST /api/pair/transfer  phone: the sealed account; answers the four digits the phone shows
 *   GET  /api/pair/poll      browser, with the binding cookie: 'confirming' until the digits are typed, then the payload.
 *                            Without it (the phone's probe): 403 wrong-browser, with how many digits this relay asks for
 *   POST /api/pair/confirm   browser, with the binding cookie: { sessionId, code }; three wrong burn the session
 *   POST /api/pair/cancel
 *
 * The other way, browser to phone (front doors S9; pairing-relay.ts explains the order and why the phone shows the digits):
 *   POST /api/pair/init      browser, with `to: 'phone'`: opens a to-phone session, the same binding cookie
 *   POST /api/pair/offer     phone: { sessionId, phonePubHex }; one phone per session; answers the four digits to show
 *                            and the phone's own binding secret
 *   GET  /api/pair/poll      browser: 'confirming' once a phone scanned; after its digits, 'released' with the phone's
 *                            key; then 'sent', 'collected'. Never a payload
 *   POST /api/pair/confirm   browser types the digits the phone shows, as above
 *   POST /api/pair/send      browser, with the binding cookie, only once released: the account sealed to the phone's key
 *   POST /api/pair/collect   phone, with its secret: { sessionId, phoneSecret }; the sealed account once sent
 *   POST /api/pair/saved     phone, with its secret: { sessionId, phoneSecret, saved }; whether it saved the account.
 *                            The browser's poll then says 'saved' or 'not-saved'; only 'saved' offers Remove there
 */

import Router from '@koa/router';
import type { RouteDeps } from './types.js';
import {
    initPairingSession,
    transferPairingPayload,
    pollPairingSession,
    cancelPairingSession,
    confirmPairingTransfer,
    offerToPhoneSession,
    sendToPhonePayload,
    collectToPhonePayload,
    reportToPhoneSaved,
    PAIRING_RELAY_LIMITS,
} from '../pairing-relay.js';

const SESSION_ID = /^[0-9a-fA-F]{16,64}$/;

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

        const { sessionId, desktopPubHex, to } = (ctx.request as any).body || {};

        if (!sessionId || !desktopPubHex) {
            ctx.status = 400;
            ctx.body = { error: 'Missing sessionId or desktopPubHex' };
            return;
        }
        // Only the exact word opens the other way; anything else here is a mistake, never a quiet phone-to-browser session.
        if (to !== undefined && to !== 'phone') {
            ctx.status = 400;
            ctx.body = { error: 'Unknown pairing direction' };
            return;
        }

        const res = initPairingSession(sessionId, desktopPubHex, to === 'phone' ? 'to-phone' : 'from-phone');
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
     * POST /api/pair/offer (S9)
     * The phone that scanned a browser's to-phone code: its own X25519 key. Unsigned (the phone has no account yet).
     */
    router.post('/api/pair/offer', async (ctx) => {
        if (!deps.rateLimit(ctx, 'pairing')) return;
        const { sessionId, phonePubHex } = (ctx.request as any).body || {};
        if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
            ctx.status = 400;
            ctx.body = { error: 'bad-session' };
            return;
        }
        const res = offerToPhoneSession(sessionId, phonePubHex);
        ctx.set('Cache-Control', 'no-store');
        if (!res.ok) {
            ctx.status = res.error === 'expired' ? 410 : res.error === 'taken' ? 409 : 400;
            ctx.body = { error: res.error };
            return;
        }
        ctx.body = { success: true, confirmCode: res.confirmCode, phoneSecret: res.phoneSecret, expiresAt: res.expiresAt };
    });

    /**
     * POST /api/pair/send (S9)
     * The browser that opened the to-phone session, with its binding cookie, once its digits matched: the sealed account.
     */
    router.post('/api/pair/send', async (ctx) => {
        if (!deps.rateLimit(ctx, 'pairing')) return;
        const { sessionId, nonceHex, ciphertextHex } = (ctx.request as any).body || {};
        if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
            ctx.status = 400;
            ctx.body = { error: 'bad-session' };
            return;
        }
        const res = sendToPhonePayload(sessionId, ctx.cookies.get(pairBindingCookieName(sessionId)) || undefined, nonceHex, ciphertextHex);
        ctx.set('Cache-Control', 'no-store');
        if (!res.ok) {
            ctx.status = res.error === 'expired' ? 410
                : res.error === 'wrong-browser' ? 403
                : res.error === 'not-released' ? 409
                : res.error === 'busy' ? 503
                : 400;
            ctx.body = { error: res.error };
            return;
        }
        ctx.body = { success: true };
    });

    /**
     * POST /api/pair/collect (S9)
     * Polled by the phone that offered, with the secret its offer got. A POST, so the secret is never in an address or a log.
     */
    router.post('/api/pair/collect', async (ctx) => {
        const { sessionId, phoneSecret } = (ctx.request as any).body || {};
        if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
            ctx.status = 400;
            ctx.body = { error: 'bad-session' };
            return;
        }
        const res = collectToPhonePayload(sessionId, phoneSecret);
        ctx.set('Cache-Control', 'no-store');
        ctx.status = res.status === 'wrong-phone' ? 403 : res.status === 'expired' ? 410 : 200;
        ctx.body = res;
    });

    /**
     * POST /api/pair/saved (doors-s9-fix1)
     * The phone that collected, with its secret: whether it saved the account. Until it says 'saved', its browser never
     * says the account is on the phone, nor offers to remove it there.
     */
    router.post('/api/pair/saved', async (ctx) => {
        const { sessionId, phoneSecret, saved } = (ctx.request as any).body || {};
        if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
            ctx.status = 400;
            ctx.body = { error: 'bad-session' };
            return;
        }
        const res = reportToPhoneSaved(sessionId, phoneSecret, saved);
        ctx.set('Cache-Control', 'no-store');
        if (!res.ok) {
            ctx.status = res.error === 'expired' ? 410 : res.error === 'wrong-phone' ? 403 : res.error === 'already' ? 409 : 400;
            ctx.body = { error: res.error };
            return;
        }
        ctx.body = { success: true };
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
