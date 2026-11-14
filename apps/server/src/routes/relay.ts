/**
 * The mailbox between communities (messages across communities X2: scratch/fable-design/DESIGN-cross-chat-voice-fable.md
 * §3.2, §3.3, §11 row X2). What each does is engine/relay-mail.ts (receiving) and engine/relay-outbox.ts (sending).
 *
 *   POST /api/relay/mail            another community's server's signed request only (engine/node-signature.ts)
 *                                   { items: RelayItem[] } → 202 { items: [{ itemId, received: true } | { itemId, refused }] }
 *   POST /api/mail/send             a member here       { items: RelayItem[] } → { items: [{ itemId, state }] }
 *   GET  /api/mail?since=<ms>&sinceId=<itemId>
 *                                   a member here       → { items: HeldItem[], more, outbox: [{ itemId, kind, recipient,
 *                                                          recipientHome, state, at }], outboxMore }: the ticks after the
 *                                                          last one the device has (its `at` and `itemId`), 200 a page
 *   GET  /api/mail/blob/:itemId     a member here       → { itemId, payload } (a blob held for them)
 *   POST /api/mail/confirm          a member here       { ids: string[] } → { confirmed }
 *   POST /api/mail/report           a member here       { item: { envelope, payload }, reason, words } → { success, report }:
 *                                                          a line from another community reported, its sender blocked for
 *                                                          them, and their home told (engine/relay-complaint.ts)
 *   POST /api/relay/complaint       another community's server's signed request only
 *                                   { complaint } → 202 { received: true } (filed or dropped alike)
 *
 * The member routes are for a member who reads as one (engine/members.ts readsAsMember): a visitor's row, a key that is no
 * member here, a suspended member is refused (403 not_a_member). Every answer is `no-store`: a member's mail is theirs.
 */
import Router from '@koa/router';
import { isNodeMember, readsAsMember } from '../state-engine.js';
import { NOT_A_MEMBER_CODE, NOT_A_MEMBER_ERROR } from '../engine/members.js';
import { MutedError, assertNotMuted } from '../engine/auto-moderation.js';
import { StorageNearlyFullError } from '../engine/photo-upload-budget.js';
import type { NodeOrigin } from '../engine/node-signature.js';
import { MAIL_FETCH_PAGE, confirmMail, heldBlobFor, heldMailFor, receiveRelayItems } from '../engine/relay-mail.js';
import { OutboxError, outboxStatesFor, sendRelayItems } from '../engine/relay-outbox.js';
import { checkOutsideLineReport, receiveComplaint, submitOutsideLineReport, tellHomeOf } from '../engine/relay-complaint.js';
import { GroupLineReportError } from '../engine/group-chat-report.js';
import { fileMessageReport } from './message-report.js';

/** The verified signer, when they are a member here who reads as one; else the route has answered 403. */
function memberHere(ctx: any): string | null {
    const actor = ctx.state.actor as string | undefined;
    if (actor && isNodeMember(actor) && readsAsMember(actor)) return actor;
    ctx.status = 403;
    ctx.body = { error: NOT_A_MEMBER_ERROR, code: NOT_A_MEMBER_CODE };
    return null;
}

export function createRelayRoutes(): Router {
    const router = new Router();

    router.post('/api/relay/mail', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        // Set only by the node signature door (https-server.ts requireNodeSignature): a request without one never gets here.
        const from = ctx.state.nodeOrigin as NodeOrigin | undefined;
        if (!from) {
            ctx.status = 401;
            ctx.body = { error: 'This path takes only requests signed by a community\'s server.', code: 'node_signature_missing' };
            return;
        }
        const answer = receiveRelayItems(from.origin, ((ctx.request as any).body as { items?: unknown } | undefined)?.items);
        ctx.status = answer.status;
        if ('retryAfterSec' in answer && answer.retryAfterSec) ctx.set('Retry-After', String(answer.retryAfterSec));
        ctx.body = answer.body;
    });

    router.post('/api/mail/send', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        try {
            assertNotMuted(member);
            ctx.body = { items: await sendRelayItems(member, ((ctx.request as any).body as { items?: unknown } | undefined)?.items) };
        } catch (e) {
            if (e instanceof OutboxError || e instanceof MutedError) {
                ctx.status = e.status;
                ctx.body = { error: e.message, code: e.code };
                return;
            }
            if (e instanceof StorageNearlyFullError) {
                ctx.status = 503;
                ctx.body = { error: e.message, code: 'storage_full' };
                return;
            }
            throw e;
        }
    });

    router.get('/api/mail', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        const since = Number(ctx.query.since ?? 0);
        const sinceId = typeof ctx.query.sinceId === 'string' ? ctx.query.sinceId.slice(0, 64) : '';
        const held = heldMailFor(member);
        const ticks = outboxStatesFor(member, Number.isSafeInteger(since) && since > 0 ? since : 0, sinceId);
        ctx.body = { ...held, page: MAIL_FETCH_PAGE, outbox: ticks.ticks, outboxMore: ticks.more };
    });

    router.get('/api/mail/blob/:itemId', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        const payload = heldBlobFor(member, ctx.params.itemId);
        if (payload === null) {
            ctx.status = 404;
            ctx.body = { error: 'Nothing waits for you by that id.', code: 'not_found' };
            return;
        }
        ctx.body = { itemId: ctx.params.itemId, payload };
    });

    router.post('/api/mail/confirm', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        const ids = ((ctx.request as any).body as { ids?: unknown } | undefined)?.ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAIL_FETCH_PAGE || !ids.every((id) => typeof id === 'string')) {
            ctx.status = 400;
            ctx.body = { error: `ids is a list of 1 to ${MAIL_FETCH_PAGE} item ids.`, code: 'bad_ids' };
            return;
        }
        ctx.body = { confirmed: confirmMail(member, ids as string[]) };
    });

    router.post('/api/mail/report', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        let checked;
        try {
            checked = checkOutsideLineReport(member, (ctx.request as any).body);
        } catch (e) {
            if (!(e instanceof GroupLineReportError)) throw e;
            ctx.status = e.status;
            ctx.body = { error: e.message, code: e.code };
            return;
        }
        let filed: string | null = null;
        fileMessageReport(ctx, member, checked.envelope.itemId, checked.reason, () => {
            const report = submitOutsideLineReport(member, checked);
            filed = report?.id ?? null;
            return report;
        });
        // Told after the answer is decided, before it goes: a member's send waits for its forward the same way.
        if (filed) await tellHomeOf(filed);
    });

    router.post('/api/relay/complaint', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const from = ctx.state.nodeOrigin as NodeOrigin | undefined;
        if (!from) {
            ctx.status = 401;
            ctx.body = { error: 'This path takes only requests signed by a community\'s server.', code: 'node_signature_missing' };
            return;
        }
        const answer = receiveComplaint(from.origin, from.key, (ctx.request as any).body);
        ctx.status = answer.status;
        if ('retryAfterSec' in answer && answer.retryAfterSec) ctx.set('Retry-After', String(answer.retryAfterSec));
        ctx.body = answer.body;
    });

    return router;
}
