/**
 * The mailbox between communities (messages across communities X2: scratch/fable-design/DESIGN-cross-chat-voice-fable.md
 * §3.2, §3.3, §11 row X2). What each does is engine/relay-mail.ts (receiving) and engine/relay-outbox.ts (sending).
 *
 *   POST /api/relay/mail            another community's server's signed request only (engine/node-signature.ts)
 *                                   { items: RelayItem[] } → 202 { items: [{ itemId, received: true } | { itemId, refused }] }
 *   POST /api/mail/send             a member here       { items: RelayItem[] } → { items: [{ itemId, state }] }; group
 *                                                          items (group-invite, -leave, -line, -epoch to group:<id>) go to
 *                                                          its host (engine/group-guest-home.ts), and may carry `refused`
 *   GET  /api/mail?device=<id>&since=<ms>&sinceId=<itemId>
 *                                   a member here       → { items: HeldItem[], more, outbox: [{ itemId, kind, recipient,
 *                                                          recipientHome, state, at }], outboxMore }: what waits that THIS
 *                                                          device has not confirmed (X2b), and the ticks after the last
 *                                                          one the device has (its `at` and `itemId`), 200 a page. `device`
 *                                                          is required (400 bad_device without it), and lists the device
 *   GET  /api/mail/blob/:itemId     a member here       → { itemId, payload } (a blob held for them)
 *   POST /api/mail/confirm          a member here       { ids: string[], device } → { confirmed }: this device has them;
 *                                                          an item goes once every device listed has it
 *   POST /api/mail/device/forget    a member here       { device } → { forgotten }: at Sign Out, this device is listed no more
 *   POST /api/mail/report           a member here       { item: { envelope, payload }, reason, words } → { success, report }:
 *                                                          a line from another community reported, its sender blocked for
 *                                                          them, and their home told (engine/relay-complaint.ts)
 *   POST /api/relay/group           a group's host's signed request only (engine/group-guest-home.ts, G1b)
 *                                   { v: 1, kind, group, host, guests, data } → 202 { received: true }, held for each named
 *                                                          guest it may reach or dropped alike; 400 not a notice, or a host
 *                                                          that is not its signer; 503 mailbox_full
 *   GET  /api/mail/group?device=<id>&since=<ms>&sinceId=<itemId>
 *                                   a member here       → { items, more, groups, sent, sentMore }: the group notices THIS
 *                                                          device has not confirmed, where they stand with each group at
 *                                                          another community (with its latest roster), and what became of
 *                                                          their own group items after the device's last tick
 *   POST /api/mail/group/confirm    a member here       { ids: string[], device } → { confirmed }
 *   POST /api/relay/complaint       another community's server's signed request only
 *                                   { complaint } → 202 { received: true } (filed, or on file already); every drop
 *                                                          422 not_taken alike; 503 while the name its line went to
 *                                                          can't be confirmed as the signer's yet
 *
 * `device` is the random id the member's app keeps for this device (@beanpool/core OUTSIDE_DEVICE_ID; engine/relay-mail.ts
 * explains what each device holds). The member routes are for a member who reads as one (engine/members.ts readsAsMember): a visitor's row, a key that is no
 * member here, a suspended member is refused (403 not_a_member). Every answer is `no-store`: a member's mail is theirs.
 */
import Router from '@koa/router';
import { isNodeMember, readsAsMember } from '../state-engine.js';
import { NOT_A_MEMBER_CODE, NOT_A_MEMBER_ERROR } from '../engine/members.js';
import { MutedError, assertNotMuted } from '../engine/auto-moderation.js';
import { StorageNearlyFullError } from '../engine/photo-upload-budget.js';
import type { NodeOrigin } from '../engine/node-signature.js';
import {
    MAIL_FETCH_PAGE, confirmMail, forgetMailDevice, heldBlobFor, heldMailFor, isMailDevice, noteMailDevice, receiveRelayItems,
} from '../engine/relay-mail.js';
import { OutboxError, outboxStatesFor, sendRelayItems } from '../engine/relay-outbox.js';
import { COMPLAINT_REPORTER_PREFIX, checkOutsideLineReport, readComplaintBody, receiveComplaint, submitOutsideLineReport, tellHomeOf } from '../engine/relay-complaint.js';
import { noteNewReport } from '../services/alerts.js';
import { logger } from '../logger.js';
import { GroupLineReportError } from '../engine/group-chat-report.js';
import { fileMessageReport } from './message-report.js';
import { confirmGroupMail, groupItemStepsAway, heldGroupMailFor, isGroupItem, isGroupItemId, receiveGroupNotice, sendGroupItems } from '../engine/group-guest-home.js';

/** The verified signer, when they are a member here who reads as one; else the route has answered 403. */
function memberHere(ctx: any): string | null {
    const actor = ctx.state.actor as string | undefined;
    if (actor && isNodeMember(actor) && readsAsMember(actor)) return actor;
    ctx.status = 403;
    ctx.body = { error: NOT_A_MEMBER_ERROR, code: NOT_A_MEMBER_CODE };
    return null;
}

/** The direct kinds that carry no words to anyone: a delete of their own line, and a receipt (the local mark-read takes it too). */
const QUIET_DIRECT_KINDS: ReadonlySet<string> = new Set(['dm-delete', 'receipt']);

/**
 * A mute stops a member speaking, never stepping away (engine/auto-moderation.ts, "Auto-mute": they can still read, edit their
 * profile and leave). So a muted member's request made only of items that carry no words to anyone is taken: a group's leave
 * and a no to its invitation (groupItemStepsAway), a delete of their own line, a receipt. Any other item in it (a line, a photo,
 * an edit, a reaction, a yes, an epoch) and the whole request is refused 403 `moderation_muted`. A reaction across communities
 * is sealed: no server can tell one taken back from one added, so it is refused with the lines (test-group-guests-home §3m).
 */
function speaksIn(items: unknown): boolean {
    if (!Array.isArray(items) || items.length === 0) return true;
    return !items.every((it) => {
        const kind = (it as { envelope?: { kind?: unknown } } | null)?.envelope?.kind;
        return (typeof kind === 'string' && QUIET_DIRECT_KINDS.has(kind)) || groupItemStepsAway(it);
    });
}

/** The device a member's request names, when it is one; else the route has answered 400. */
function deviceOf(ctx: any, device: unknown): string | null {
    if (isMailDevice(device)) return device;
    ctx.status = 400;
    ctx.body = { error: "device is this device's mail id: 32 lowercase hex characters, made by the app.", code: 'bad_device' };
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
            const items = ((ctx.request as any).body as { items?: unknown } | undefined)?.items;
            if (speaksIn(items)) assertNotMuted(member);
            ctx.body = { items: Array.isArray(items) && items.some(isGroupItem) ? await sendGroupItems(member, items) : await sendRelayItems(member, items) };
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
        const device = deviceOf(ctx, ctx.query.device);
        if (!device) return;
        const since = Number(ctx.query.since ?? 0);
        const sinceId = typeof ctx.query.sinceId === 'string' ? ctx.query.sinceId.slice(0, 64) : '';
        noteMailDevice(member, device);
        const held = heldMailFor(member, device);
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
        const body = (ctx.request as any).body as { ids?: unknown; device?: unknown } | undefined;
        const ids = body?.ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAIL_FETCH_PAGE || !ids.every((id) => typeof id === 'string')) {
            ctx.status = 400;
            ctx.body = { error: `ids is a list of 1 to ${MAIL_FETCH_PAGE} item ids.`, code: 'bad_ids' };
            return;
        }
        const device = deviceOf(ctx, body?.device);
        if (!device) return;
        ctx.body = { confirmed: confirmMail(member, device, ids as string[]) };
    });

    router.post('/api/mail/device/forget', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        const device = deviceOf(ctx, ((ctx.request as any).body as { device?: unknown } | undefined)?.device);
        if (!device) return;
        ctx.body = { forgotten: forgetMailDevice(member, device) };
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

    router.post('/api/relay/group', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        // Set only by the node signature door, as for /api/relay/mail.
        const from = ctx.state.nodeOrigin as NodeOrigin | undefined;
        if (!from) {
            ctx.status = 401;
            ctx.body = { error: 'This path takes only requests signed by a community\'s server.', code: 'node_signature_missing' };
            return;
        }
        const answer = receiveGroupNotice(from.origin, (ctx.request as any).body);
        ctx.status = answer.status;
        if ('retryAfterSec' in answer && answer.retryAfterSec) ctx.set('Retry-After', String(answer.retryAfterSec));
        ctx.body = answer.body;
    });

    router.get('/api/mail/group', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        const device = deviceOf(ctx, ctx.query.device);
        if (!device) return;
        const since = Number(ctx.query.since ?? 0);
        noteMailDevice(member, device);
        ctx.body = heldGroupMailFor(member, device, Number.isSafeInteger(since) && since > 0 ? since : 0, isGroupItemId(ctx.query.sinceId) ? ctx.query.sinceId : '');
    });

    router.post('/api/mail/group/confirm', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = memberHere(ctx);
        if (!member) return;
        const body = (ctx.request as any).body as { ids?: unknown; device?: unknown } | undefined;
        const ids = body?.ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAIL_FETCH_PAGE || !ids.every((id) => typeof id === 'string')) {
            ctx.status = 400;
            ctx.body = { error: `ids is a list of 1 to ${MAIL_FETCH_PAGE} notice ids.`, code: 'bad_ids' };
            return;
        }
        const device = deviceOf(ctx, body?.device);
        if (!device) return;
        ctx.body = { confirmed: confirmGroupMail(member, device, ids as string[]) };
    });

    router.post('/api/relay/complaint', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const from = ctx.state.nodeOrigin as NodeOrigin | undefined;
        if (!from) {
            ctx.status = 401;
            ctx.body = { error: 'This path takes only requests signed by a community\'s server.', code: 'node_signature_missing' };
            return;
        }
        const answer = await receiveComplaint(from, (ctx.request as any).body);
        ctx.status = answer.status;
        if ('retryAfterSec' in answer && answer.retryAfterSec) ctx.set('Retry-After', String(answer.retryAfterSec));
        ctx.body = answer.body;
        // The owners and admins hear of it as of any report, by kind and count, never who or what (services/alerts.ts).
        if (answer.filed) {
            const reason = readComplaintBody((ctx.request as any).body)?.reason ?? 'other';
            noteNewReport(reason === 'child safety' ? 'Child safety' : reason, `${COMPLAINT_REPORTER_PREFIX}${from.origin}`)
                .catch((e) => logger.warn('SYS', `[Alerts] A complaint from another community could not be told: ${e instanceof Error ? e.message : String(e)}`));
        }
    });

    return router;
}
