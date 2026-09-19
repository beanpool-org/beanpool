/**
 * Unlocking with an owner's phone (sealed-keys.md §5.2, §6.2, §7; slice 6). services/owner-unlock.ts does the work;
 * this file is who may ask.
 *
 * On a standby, from its Settings (its own admin sign-in, owner level):
 *   POST /api/local/admin/takeover/phone/start     { serverUrl? }   a session and its QR, on the newest held keys
 *   POST /api/local/admin/takeover/phone/wait      { sessionId }    waiting / unlocked + the preview / expired / failed
 * On a server restoring a sealed backup, the upload is POST /api/local/admin/restore with `X-Unlock-With: phone`
 * (routes/backup.ts); then:
 *   POST /api/local/admin/restore/phone/wait       { sessionId }    waiting / restored / failed / expired; admin, or
 *                                                                   the follow token the upload answered (X-Unlock-Follow):
 *                                                                   the restore brings back the community's password
 * Either:
 *   POST /api/local/admin/unlock/cancel            { sessionId }    forget the session (and a restore's kept file)
 *
 * The owner's phone (no admin sign-in: the owner's signature inside the body is what counts, checked in core):
 *   GET  /api/local/admin/unlock/:sessionId        the header and what will happen
 *   POST /api/local/admin/unlock/:sessionId        the signed request with the re-wrapped data key
 * Rate-limited like the settings sign-in pairing. Cross-origin readable (no credentials) so the web app can use them.
 *
 * The silent open check (§7), on the main server:
 *   POST /api/node/owner/lock-open-check           owner, signed   { envelopeId, opened }: "this device could (not)
 *                                                                   open the current lock"
 */

import Router from '@koa/router';
import { OWNER_LOCK_OPEN_CHECK_PATH } from '@beanpool/core';
import { requireAdminRole } from '../admin-auth.js';
import { isNodeOwner } from '../engine/node-roles.js';
import { recordOwnerLockOpen } from '../engine/owner-lock-opens.js';
import {
    startTakeoverUnlock, followUnlock, describeUnlock, redeemUnlock, forgetUnlockSession, unlockServerUrl,
    restoreFollowTokenMatches,
} from '../services/owner-unlock.js';
import { TakeoverError } from '../services/takeover.js';
import type { RouteDeps } from './types.js';

const TAKEOVER_OWNER_ONLY = 'Only an owner of this standby can take over as the main server.';

export function createOwnerUnlockRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;
    const bodyOf = (ctx: any) => (ctx as any).requestBody || (ctx.request as any)?.body || {};

    router.post('/api/local/admin/takeover/phone/start', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        if (!requireAdminRole(ctx, ['owner'], TAKEOVER_OWNER_ONLY)) return;
        ctx.set('Cache-Control', 'no-store');
        try {
            const serverUrl = unlockServerUrl(bodyOf(ctx).serverUrl, ctx.origin);
            ctx.body = { success: true, ...startTakeoverUnlock(serverUrl) };
        } catch (e) {
            if (e instanceof TakeoverError) {
                ctx.status = e.status;
                ctx.body = { error: e.message, ...e.extra };
                return;
            }
            ctx.status = (e as any)?.reason ? 409 : 500;
            ctx.body = { error: (e as Error)?.message || 'Could not start the unlock.' };
        }
    });

    router.post('/api/local/admin/takeover/phone/wait', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        if (!requireAdminRole(ctx, ['owner'], TAKEOVER_OWNER_ONLY)) return;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = followUnlock(bodyOf(ctx).sessionId, 'takeover');
    });

    router.post('/api/local/admin/restore/phone/wait', async (ctx) => {
        const sessionId = bodyOf(ctx).sessionId;
        if (!restoreFollowTokenMatches(sessionId, ctx.request.header['x-unlock-follow'])) {
            if (!(await checkAdminAuth(ctx as any))) return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = followUnlock(sessionId, 'restore');
    });

    router.post('/api/local/admin/unlock/cancel', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        forgetUnlockSession(bodyOf(ctx).sessionId);
        ctx.body = { success: true };
    });

    // The phone's two calls. The session id is the only thing that names a session, and it is in the QR.
    router.get('/api/local/admin/unlock/:sessionId', async (ctx) => {
        if (!deps.rateLimit(ctx as any)) return;
        ctx.set('Cache-Control', 'no-store');
        const got = await describeUnlock(ctx.params.sessionId);
        ctx.status = got.status;
        ctx.body = got.body;
    });

    router.post('/api/local/admin/unlock/:sessionId', async (ctx) => {
        if (!deps.rateLimit(ctx as any)) return;
        ctx.set('Cache-Control', 'no-store');
        const got = await redeemUnlock(ctx.params.sessionId, bodyOf(ctx));
        ctx.status = got.status;
        ctx.body = got.body;
    });

    // The silent open check (§7): an owner's app saw a new lock, opened its own stanza, threw the key away, and says
    // so. Signed by the member key (the middleware checked it); the actor is the signer and nothing else. The server
    // cannot verify it and Settings never claims it did: it shows what the owner's device reported, and when.
    router.post(OWNER_LOCK_OPEN_CHECK_PATH, async (ctx) => {
        const signer: string | undefined = (ctx.state as any)?.authSig?.signer;
        if (!signer) {
            ctx.status = 401;
            ctx.body = { error: 'Sign this request with your member key.' };
            return;
        }
        if (!isNodeOwner(signer)) {
            ctx.status = 403;
            ctx.body = { error: "Only this community's owners report on its lock." };
            return;
        }
        const body = bodyOf(ctx) as Record<string, unknown>;
        const keys = Object.keys(body).sort().join(',');
        if (keys !== 'envelopeId,opened' || typeof body.envelopeId !== 'string' || !/^[0-9a-f]{32}$/.test(body.envelopeId)
            || typeof body.opened !== 'boolean') {
            ctx.status = 400;
            ctx.body = { error: 'Send only { "envelopeId": <32 hex>, "opened": true | false }.' };
            return;
        }
        const authSig = (ctx.state as any).authSig as { signature: string; payload: string };
        const checkedAt = Number(String(authSig.payload).split('\n')[2]);
        if (!Number.isFinite(checkedAt) || checkedAt <= 0) {
            ctx.status = 400;
            ctx.body = { error: 'The signed request has no usable timestamp.' };
            return;
        }
        recordOwnerLockOpen({
            memberPubkey: signer, envelopeId: body.envelopeId, opened: body.opened, checkedAt,
            signature: authSig.signature, signedPayload: authSig.payload,
        });
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { success: true, checkedAt };
    });

    return router;
}
