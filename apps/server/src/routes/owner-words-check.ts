/**
 * "Check your 12 words" — owners only (sealed-keys.md §7, slice 7).
 *
 *   POST /api/node/owner/words-check              owner, signed   record "I checked my words" (the fact and the date)
 *   GET  /api/node/owner/words-check              owner, signed   my last check, so the app knows whether to ask
 *   POST /api/local/admin/takeover/words-checks   admin            every owner's "12 words checked: <date> / not yet"
 *
 * The words are checked on the device and never sent. The statement is the signed request itself: the actor is the
 * signing key and nothing else (no body field names anyone), the date is the signed X-Timestamp the signature
 * middleware has already held to its freshness window, and the only body accepted is
 * `{ "attestation": "owner-12-words-checked" }`, so nothing derived from the words can be stored here by accident.
 * The server cannot verify a words check and never claims it did; the Settings list shows it as the owner's own
 * signed record.
 *
 * Nothing reads these rows to allow or refuse anything. An owner who never checks can still do everything.
 */

import Router from '@koa/router';
import { OWNER_WORDS_CHECK_PATH } from '@beanpool/core';
import { isNodeOwner } from '../engine/node-roles.js';
import {
    OWNER_WORDS_ATTESTATION, getOwnerWordsCheckedAt, listOwnerWordsStatus, recordOwnerWordsCheck,
} from '../engine/owner-words-checks.js';
import type { RouteDeps } from './types.js';

const NOT_OWNER = "Only this community's owners are asked to check their 12 words.";

/** The verified signer, or null after answering 401. */
function signerOf(ctx: any): string | null {
    const signer: string | undefined = ctx.state?.authSig?.signer;
    if (!signer) {
        ctx.status = 401;
        ctx.body = { error: 'Sign this request with your member key.' };
        return null;
    }
    return signer;
}

export function createOwnerWordsCheckRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    router.post(OWNER_WORDS_CHECK_PATH, async (ctx) => {
        const signer = signerOf(ctx);
        if (!signer) return;
        if (!isNodeOwner(signer)) {
            ctx.status = 403;
            ctx.body = { error: NOT_OWNER };
            return;
        }
        const body = ((ctx as any).requestBody ?? {}) as Record<string, unknown>;
        if (Object.keys(body).length !== 1 || body.attestation !== OWNER_WORDS_ATTESTATION) {
            ctx.status = 400;
            ctx.body = { error: `Send only { "attestation": "${OWNER_WORDS_ATTESTATION}" }.` };
            return;
        }
        const authSig = (ctx.state as any).authSig as { signature: string; payload: string };
        // The signed timestamp (METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY): the signature covers it, and the middleware
        // has already refused it if it was stale.
        const checkedAt = Number(String(authSig.payload).split('\n')[2]);
        if (!Number.isFinite(checkedAt) || checkedAt <= 0) {
            ctx.status = 400;
            ctx.body = { error: 'The signed request has no usable timestamp.' };
            return;
        }
        recordOwnerWordsCheck({ memberPubkey: signer, checkedAt, signature: authSig.signature, signedPayload: authSig.payload });
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { success: true, wordsCheckedAt: checkedAt };
    });

    router.get(OWNER_WORDS_CHECK_PATH, async (ctx) => {
        const signer = signerOf(ctx);
        if (!signer) return;
        if (!isNodeOwner(signer)) {
            // Not an error to the app: it simply has nothing to ask this member.
            ctx.status = 403;
            ctx.body = { error: NOT_OWNER, owner: false };
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { owner: true, wordsCheckedAt: getOwnerWordsCheckedAt(signer) };
    });

    // Settings → Who can unlock this community: each owner's "12 words checked: <date> / not yet". Owners and
    // admins; a moderator's session never reaches an admin route that is not on its list (admin-auth.ts).
    router.post('/api/local/admin/takeover/words-checks', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { owners: listOwnerWordsStatus() };
    });

    return router;
}
