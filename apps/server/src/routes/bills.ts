/**
 * Bills (engine/bills.ts; DESIGN-getting-paid-fable.md §4, slice B1): a request to pay, never a payment.
 *
 *   POST /api/bills                    send one: { id, to, amount_c, whatFor, postId?, standingId?, enterprise? }
 *   GET  /api/bills                    the signer's: { toPay, sent }; ?enterprise=<key> an enterprise's sent, for its keeper
 *   POST /api/bills/:id/pay            the payer pays it: { requestId? }, safe to retry with the same id
 *   POST /api/bills/:id/decline        the payer declines it, quietly
 *   POST /api/bills/:id/withdraw       the sender takes back one not paid
 *
 * Every request is signed, and its signer is the actor (never a key in a body). Beans off answers 403 profile_no_beans,
 * bills off 404 feature_off (the engine); a standby refuses the writes before this (routes/standby-ledger-gate.ts), and a
 * payment counts against the payer's money limits (routes/money-limits-gate.ts). A refusal carries its code and the words a
 * member reads; a limit's carries `resetsAt` and Retry-After.
 */
import Router from '@koa/router';
import type { Context } from 'koa';
import { word } from '@beanpool/core';
import { sendBill, payBill, declineBill, withdrawBill, listBills } from '../state-engine.js';
import { BillRefusal } from '../engine/bills.js';
import { REQUEST_ID_REUSED_CODE } from '../engine/money-requests.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import { membersOnlyHere } from './viewer.js';
import { isServerFault, memberErrorText, SERVER_FAULT_TEXT } from './member-error-text.js';
import type { RouteDeps } from './types.js';

/** Answer a refusal from the bills engine or underneath it, in its own status and code. */
function respondBillRefusal(ctx: Context, e: any): void {
    if (e instanceof BillRefusal) {
        ctx.status = e.status;
        ctx.body = { error: e.message, code: e.code, ...(e.resetsAt ? { resetsAt: e.resetsAt } : {}) };
        if (e.resetsAt) ctx.set('Retry-After', String(Math.max(1, Math.ceil((Date.parse(e.resetsAt) - Date.now()) / 1000))));
        return;
    }
    // Beans off (403), bills off (404), a standby (409), a mute (403).
    if (respondProfileRefusal(ctx, e)) return;
    if (e?.code === REQUEST_ID_REUSED_CODE) {
        ctx.status = 409;
        ctx.body = { error: e.message, code: e.code };
        return;
    }
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
        ctx.status = e.status;
        ctx.body = { error: e.message, ...(e.code ? { code: e.code } : {}) };
        return;
    }
    // The payer's own standing, as every door that spends their Beans refuses it (escrow.ts assertBuyerMayTrade: paused,
    // removed, on holiday): theirs to read, 403. Anything else is the server's fault, and says so.
    if (isServerFault(e)) {
        console.error('[Bills] A bill request failed:', e);
        ctx.status = 500;
        ctx.body = { error: SERVER_FAULT_TEXT };
        return;
    }
    ctx.status = 403;
    ctx.body = { error: memberErrorText(e, word('This bill could not be changed.')) };
}

/** The signed actor, or a 401 answered (false). */
function actorOf(ctx: Context): string | null {
    const actor = ctx.state?.actor as string | undefined;
    if (actor) return actor;
    ctx.status = 401;
    ctx.body = { error: word('A signed request is required') };
    return null;
}

export function createBillRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.post('/api/bills', async (ctx) => {
        const actor = actorOf(ctx);
        if (!actor || !membersOnlyHere(ctx)) return;
        try {
            ctx.body = { success: true, bill: sendBill(actor, (ctx as any).requestBody || {}) };
        } catch (e) {
            respondBillRefusal(ctx, e);
        }
    });

    router.get('/api/bills', async (ctx) => {
        const actor = actorOf(ctx);
        if (!actor || !membersOnlyHere(ctx)) return;
        ctx.set('Cache-Control', 'private, no-store');
        try {
            ctx.body = listBills(actor, ctx.query.enterprise);
        } catch (e) {
            respondBillRefusal(ctx, e);
        }
    });

    router.post('/api/bills/:id/pay', async (ctx) => {
        const actor = actorOf(ctx);
        if (!actor || !membersOnlyHere(ctx)) return;
        try {
            const { requestId } = (ctx as any).requestBody || {};
            ctx.body = { success: true, ...payBill(actor, String(ctx.params.id), requestId) };
        } catch (e) {
            respondBillRefusal(ctx, e);
        }
    });

    router.post('/api/bills/:id/decline', async (ctx) => {
        const actor = actorOf(ctx);
        if (!actor || !membersOnlyHere(ctx)) return;
        try {
            ctx.body = { success: true, bill: declineBill(actor, String(ctx.params.id)) };
        } catch (e) {
            respondBillRefusal(ctx, e);
        }
    });

    router.post('/api/bills/:id/withdraw', async (ctx) => {
        const actor = actorOf(ctx);
        if (!actor || !membersOnlyHere(ctx)) return;
        try {
            ctx.body = { success: true, bill: withdrawBill(actor, String(ctx.params.id)) };
        } catch (e) {
            respondBillRefusal(ctx, e);
        }
    });

    return router;
}
