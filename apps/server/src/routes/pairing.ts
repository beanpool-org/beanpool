/**
 * Pairing Routes — Ephemeral QR Device Pairing Endpoints (#89).
 */

import Router from '@koa/router';
import type { RouteDeps } from './types.js';
import {
    initPairingSession,
    transferPairingPayload,
    pollPairingSession,
    cancelPairingSession,
} from '../pairing-relay.js';

export function createPairingRoutes(deps: RouteDeps): Router {
    const router = new Router();

    /**
     * POST /api/pair/init
     * Initiated by unauthenticated desktop PWA.
     */
    router.post('/api/pair/init', async (ctx) => {
        if (!deps.rateLimit(ctx)) return;

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
        if (!sessionId) {
            ctx.status = 400;
            ctx.body = { error: 'Missing session query parameter' };
            return;
        }

        const res = pollPairingSession(sessionId);
        ctx.body = res;
    });

    /**
     * POST /api/pair/transfer
     * Submitted by authenticated mobile app with encrypted payload.
     */
    router.post('/api/pair/transfer', async (ctx) => {
        if (!deps.rateLimit(ctx)) return;

        const { sessionId, mobilePubHex, nonceHex, ciphertextHex } = (ctx.request as any).body || {};

        if (!sessionId || !mobilePubHex || !nonceHex || !ciphertextHex) {
            ctx.status = 400;
            ctx.body = { error: 'Missing required transfer fields (sessionId, mobilePubHex, nonceHex, ciphertextHex)' };
            return;
        }

        const res = transferPairingPayload(sessionId, mobilePubHex, nonceHex, ciphertextHex);
        if (!res.ok) {
            ctx.status = 400;
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
