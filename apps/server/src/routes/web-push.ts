/**
 * Web push with this node's own key (scratch/fable-design/DESIGN-web-notifications-fable.md §2.2, slice W1): "Tell me when
 * they answer" on the waiting page. The key and the send: services/web-push.ts; the rows: engine/web-push-subscriptions.ts.
 *
 *   GET    /api/web-push/key   public               → { vapidKey }   the node's public key (base64url), made at first need
 *   POST   /api/web-push       signed               { subscription: { endpoint, keys: { p256dh, auth } }, lang? }
 *                                                   → 201 { success, pushKey, vapidKey, subId }
 *   DELETE /api/web-push       signed               { subId } → { success }   the signer's own row, if there is one
 *
 * ## Who may subscribe
 *
 * A member (W2: "Turn on" on the web app; passesReadGate, the same members who may read their notices): a row of kind
 * `member` per browser, told every kind their phone is (engine/web-push-subscriptions.ts putMemberSubscription), whatever
 * the node's switches; past the key's day of new browsers, 429 `key_rate_limited`.
 *
 * A key with a request to join here that members can still answer (engine/knocks.ts askerStanding; W1): one `asker` row.
 * Anyone else: 403 `no_open_request`; and with requests to join switched off here, 404 `feature_off`, as the profile gate
 * answers them. A key whose request was declined, within the decline's block, is answered exactly as an open one, 201 with
 * the same fields, and nothing is kept: a no is never a message, and nothing will be sent to it. The signer is always the
 * actor (the real signature middleware); no key is read from the body.
 *
 * `pushKey` is the node key the browser pins for the notices (as the phone's registration answers it), so the app can tell a
 * notice its community signed from a forgery; `vapidKey` the key it subscribed with, so it can see the node's key changed.
 *
 * A subscription names its endpoint at a browser push service only (services/web-push.ts isPushServiceEndpoint), with a
 * P-256 `p256dh` and a 16-byte `auth`: 400 otherwise. The node's own https address as this request reached it is kept,
 * sealed, as the push's contact (`sub`).
 *
 * ## The main server only
 *
 * A standby refuses a subscription (503 `standby`) and makes no key: it sends no push. Its key read answers the key it has,
 * or 503.
 */
import Router from '@koa/router';
import { normaliseLang } from '@beanpool/core';
import { getNodeRole, passesReadGate } from '../state-engine.js';
import { askerStanding } from '../engine/knocks.js';
import { pushKeyHex } from '../engine/push-notices.js';
import {
    parseBrowserSubscription, putAskerSubscription, putMemberSubscription, removeWebPushSubscription, webPushSubId,
} from '../engine/web-push-subscriptions.js';
import { FEATURE_OFF, featureOffMessage, getProfileSwitches } from '../config/node-profile.js';
import { ensureVapidKey, readVapidKey, type VapidKey } from '../services/web-push.js';
import { RecoverySealKeyMissing } from '../services/recovery-seal-key.js';
import type { RouteDeps } from './types.js';

function answer(ctx: any, status: number, error: string, code: string): void {
    ctx.status = status;
    ctx.body = { error, code };
}

/** This node's own address as the browser reached it, for the push's `sub`; a Host that is no host name gives none. */
function contactOf(ctx: any): string | null {
    const host = String(ctx.host ?? '').toLowerCase();
    return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(host) ? `https://${host}` : null;
}

function nodeKey(ctx: any, make: boolean): VapidKey | null {
    try {
        return make ? ensureVapidKey() : readVapidKey();
    } catch (e: any) {
        console.warn(`[WebPush] The node's web push key: ${e?.message || e}`);
        answer(ctx, 503, "This community can't send notifications to browsers right now.", 'no_key');
        return null;
    }
}

export function createWebPushRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/web-push/key', (ctx) => {
        const standby = getNodeRole() !== 'primary';
        const key = nodeKey(ctx, !standby);
        if (!key) {
            if (ctx.status !== 503) answer(ctx, 503, "This community's standby sends no notifications.", 'standby');
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { vapidKey: key.publicKeyText };
    });

    router.post('/api/web-push', (ctx) => {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) return answer(ctx, 401, 'A signed request is required.', 'unsigned');
        if (getNodeRole() !== 'primary') return answer(ctx, 503, "This community's standby takes no subscriptions.", 'standby');
        const body = (ctx as any).requestBody ?? {};
        const sub = parseBrowserSubscription(body.subscription);
        if (!sub) return answer(ctx, 400, "'subscription' must be a browser's push subscription: its endpoint at a push service, and its keys.", 'bad_subscription');
        const member = passesReadGate(actor);
        let standing: ReturnType<typeof askerStanding> | 'member' = 'member';
        if (!member) {
            // An applicant's browser goes with the requests to join, as the profile gate would answer it.
            const switches = getProfileSwitches();
            const off = (['invites', 'knocks'] as const).find((k) => !switches[k]);
            if (off) {
                ctx.status = 404;
                ctx.body = { error: featureOffMessage(off), code: FEATURE_OFF, feature: off };
                return;
            }
            standing = askerStanding(actor);
        }
        if (standing === 'none') {
            return answer(ctx, 403, 'Only a member, or someone waiting for an answer to their request to join, can be told here.', 'no_open_request');
        }
        const contact = contactOf(ctx);
        if (!contact) return answer(ctx, 400, 'This request did not name this community by a host name.', 'bad_host');
        const key = nodeKey(ctx, true);
        if (!key) return;
        let subId: string;
        try {
            const lang = typeof body.lang === 'string' ? normaliseLang(body.lang) : null;
            if (standing === 'member') {
                const kept = putMemberSubscription(actor, sub, contact, lang);
                if (kept === 'key_rate_limited') return answer(ctx, 429, 'Too many new browsers for this account today. Try again tomorrow.', 'key_rate_limited');
                subId = kept;
            } else {
                subId = standing === 'open' ? putAskerSubscription(actor, sub, contact, lang) : webPushSubId(sub.endpoint);
            }
        } catch (e) {
            if (e instanceof RecoverySealKeyMissing) return answer(ctx, 503, "This community can't keep browser subscriptions right now.", 'no_seal_key');
            throw e;
        }
        ctx.status = 201;
        ctx.body = { success: true, pushKey: pushKeyHex(), vapidKey: key.publicKeyText, subId };
    });

    router.delete('/api/web-push', (ctx) => {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) return answer(ctx, 401, 'A signed request is required.', 'unsigned');
        if (getNodeRole() !== 'primary') return answer(ctx, 503, "This community's standby takes no subscriptions.", 'standby');
        const subId = (ctx as any).requestBody?.subId;
        if (typeof subId !== 'string' || !/^[0-9a-f]{64}$/.test(subId)) return answer(ctx, 400, "'subId' must be the id the subscription was given.", 'bad_sub_id');
        removeWebPushSubscription(actor, subId);
        // The same answer whether there was a row or not: a declined key's was never kept, and must not learn so here.
        ctx.body = { success: true };
    });

    return router;
}
