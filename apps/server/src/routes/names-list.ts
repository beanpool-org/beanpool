/**
 * The names list (community modes slice 2): what an owner's or admin's phone reads and writes. The rules, the key and
 * what is logged: engine/names-list.ts. Every route is signed with the admin's own key, through the real signature
 * middleware; none takes a key from the body or the query to act as.
 *
 *   GET    /api/names/state                         → the key history, every share header (the box of one to this admin),
 *                                                     the admins and the key ids each holds, the write freeze, settings
 *   GET    /api/names/entries[?for=export]          → every entry, sealed, every confirmation, and the deleted ids (logged: read | export)
 *   POST   /api/names/entries                       { id, ciphertext, keyId } → 201 { id }
 *   PUT    /api/names/entries/:id                   { ciphertext, keyId }     → { id }
 *   DELETE /api/names/entries/:id                   → { id } (409 entry_confirmed while a member is confirmed against it)
 *   POST   /api/names/generations                   { statement, signature, replay? } → 201 { id, n } | 200 { id, n, code: exists }
 *   POST   /api/names/shares                        { header, signature, box } → { to }
 *   POST   /api/names/confirmations                 { memberPubkey, entryId } → 201 { id, status }
 *   POST   /api/names/confirmations/:id/second      → { id, status }
 *   POST   /api/names/confirmations/:id/revoke      → { id, status }
 *   GET    /api/names/log?limit&offset              → { log, total, limit, offset }
 *   POST   /api/names/settings                      { twoAdminsToConfirm?, namesShownToMembers? } (an owner)
 *   GET    /api/names/health                        → the Community health panel: the totals, the two lines, whether the rule has started
 *   GET    /api/names/health/exceptions             → known mode only: confirmed members past a line, and members who stepped
 *                                                     back owing past their ordinary line, by key and entry id (never a name),
 *                                                     and the open debts of members who left (logged)
 *   GET    /api/names/health/log?limit              → who opened the exceptions, and when
 *   POST   /api/names/health/settings               { debtLinePct?, quietDays? } (an owner; each change in the known floor's log)
 *   POST   /api/names/step-back                     → { id, status, owing }: the signer steps back from being confirmed, signed
 *                                                     with their own key; no parameter names a member (any member)
 *   GET    /api/community/known-rule                → a known community's rule in its numbers, before joining (anyone)
 *   GET    /api/names/copy                          → { header, signature, box } of the signer's own locked copy (logged:
 *                                                     copy_restored) | 404 no_copy
 *   PUT    /api/names/copy                          { header, signature, box } → { seq } | { seq, code: exists }; 400 bad_copy |
 *                                                     other_community, 403 not_yours, 409 stale_copy { seq }, 413 copy_too_big,
 *                                                     429 too_many_copies (30 an hour per admin)
 *
 * Vouchers (engine/vouchers.ts; DESIGN-invites-and-names-list-amend2-fable.md §2 to §5, Marty's §9 to §11). Every writer is
 * an owner's or a credit-committee admin's (403 `committee_only` for any other admin), with Beans on (403
 * `profile_no_beans`), and never their own budget (403 `own_budget`):
 *   GET    /api/names/vouchers                      → { vouchers: [row], settings } (the vouchers block: owners and committee)
 *   POST   /api/names/vouchers                      { entryId, amount? } → 201 card: a confirmed entry's member made a voucher
 *   GET    /api/names/vouchers/:member              → card { …row, history, people, canChange } (any owner or admin; logged)
 *   DELETE /api/names/vouchers/:member              → card: Stop vouching (a list budget; 409 role_voucher for a role's)
 *   POST   /api/names/vouchers/:member/budget       { level } → card + changed: set the budget to a level (100 to 2,000)
 *   POST   /api/names/vouchers/settings             { voucherBudget } → settings (an owner); `memberGift` is a Core setting,
 *                                                     refused here whole (400 moved_to_community_shape): Core settings change it
 *   POST   /api/names/committee                     { memberPubkey, on } → { memberPubkey, committee } (an owner)
 * Making a voucher, each set-to change and Stop vouching are each a notice to the voucher (Marty's §10.2): kept in the
 * writer's transaction, then told live and pushed (community.notice) once it has committed. A set-to raises a budget only
 * for an active voucher whose credit line isn't frozen (409 `paused`, `frozen`); it lowers one whatever their state.
 *
 * Refusals, before anything is read or written: unsigned 401; a key that isn't an active member's here 403
 * `not_member`; a member, a moderator or a visitor 403 `admins_only`; the global node 404 `feature_off` (it keeps no
 * names list: nobody there is confirmed by name, design §5); a standby 409 `standby`, reads included, since a read
 * writes the access log, which is the main server's. Every admin's request first marks holders of the current key who
 * are no admin now (reconcileHolders).
 */
import { DebtError, listDebts, settleByPayment } from '../engine/names-debts.js';
import { HealthError, healthSummary, knownRule, openExceptions, readHealthAccessLog, setHealthSettings, stepBackFromConfirmed } from '../engine/community-health.js';
import { isNodeOwner } from '../engine/node-roles.js';
import Router from '@koa/router';
import { getMember, isVisitorKey, generateInvite, broadcast, dispatchPushNotification } from '../state-engine.js';
import { assertMayMakeInvite } from '../engine/writer-bounds.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import { getNodeProfile } from '../config/node-profile.js';
import { getNodeRole, STANDBY_CODE } from '../config/node-role.js';
import {
    NamesListError, assertNamesAdmin, reconcileHolders, namesState, readEntries, addEntry, editEntry, deleteEntry,
    addGeneration, addShare, confirmMember, confirmToWorkOff, secondConfirmation, revokeConfirmation, readNamesLog, setNamesSettings,
    readNamesCopyOf, saveNamesCopy, readBoundInvites,
} from '../engine/names-list.js';
import type { RouteDeps } from './types.js';
import { word } from '@beanpool/core';
import {
    VoucherError, VOUCHER_WORDS, isOnCreditCommittee, vouchersBlock, makeVoucher, readVoucherCard, stopVoucher, setBudgetLevel,
    setVoucherSettings, setCreditCommittee, tellVoucherNotice, type TellVoucher,
} from '../engine/vouchers.js';

const STANDBY_NAMES = word('This server is a standby copy of the community, not its main server. The names list opens on the main server, which logs who reads it; this copy keeps it, sealed, for a take-over.');
const GLOBAL_NAMES = word('The global community keeps no names list: nobody there is confirmed by name. Each local community keeps its own.');

const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;

function answer(ctx: any, status: number, error: string, code: string): void {
    ctx.status = status;
    ctx.body = { error, code };
}

function wholeQuery(raw: unknown, fallback: number, max: number): number | null {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) return null;
    const n = Number(raw);
    return n > max ? null : n;
}

/**
 * The signing admin, in the member table's spelling, once every refusal above has been written; null when one was.
 * Marks the holders of the current key who are no admin now before the handler runs.
 */
function admin(ctx: any): string | null {
    ctx.set('Cache-Control', 'no-store');
    if (getNodeProfile() === 'global') { answer(ctx, 404, GLOBAL_NAMES, 'feature_off'); return null; }
    const actor = ctx.state?.actor as string | undefined;
    if (!actor) { answer(ctx, 401, 'Sign this request with your member key.', 'unsigned'); return null; }
    const key = actor.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) { answer(ctx, 400, 'The key that signed this request must be 64 hexadecimal characters.', 'bad_key'); return null; }
    const member = getMember(key);
    if (!member || member.status !== 'active' || isVisitorKey(key)) { answer(ctx, 403, word('Not an active member of this community.'), 'not_member'); return null; }
    if (getNodeRole() !== 'primary') { answer(ctx, 409, STANDBY_NAMES, STANDBY_CODE); return null; }
    reconcileHolders();
    try {
        assertNamesAdmin(key);
    } catch (e) {
        respond(ctx, e);
        return null;
    }
    return key;
}

function respond(ctx: any, e: unknown): void {
    if (e instanceof DebtError || e instanceof HealthError || e instanceof VoucherError) return answer(ctx, e.status, e.message, e.code);
    // Beans off (a voucher's every writer), a standby: their own status and code.
    if (respondProfileRefusal(ctx, e)) return;
    if (e instanceof NamesListError) {
        answer(ctx, e.status, e.message, e.code);
        if (e.extra) ctx.body = { ...e.extra, ...ctx.body };
        return;
    }
    if ((e as { code?: unknown })?.code === STANDBY_CODE) return answer(ctx, 409, STANDBY_NAMES, STANDBY_CODE);
    throw e;
}

/** Runs `fn` for the signing admin, answering a refusal in its own status and code. */
async function asAdmin(ctx: any, fn: (actor: string, body: Record<string, unknown>) => unknown, status = 200): Promise<void> {
    const actor = admin(ctx);
    if (!actor) return;
    const body = ((ctx as any).requestBody && typeof (ctx as any).requestBody === 'object' ? (ctx as any).requestBody : {}) as Record<string, unknown>;
    try {
        // Set first: a handler may answer with another success status of its own.
        ctx.status = status;
        const out = fn(actor, body);
        ctx.body = out;
    } catch (e) {
        respond(ctx, e);
    }
}

/** Runs `fn` for the signing member (any member, for their own step-back). */
async function asMember(ctx: any, fn: (actor: string, body: Record<string, unknown>) => unknown): Promise<void> {
    ctx.set('Cache-Control', 'no-store');
    if (getNodeProfile() === 'global') return answer(ctx, 404, GLOBAL_NAMES, 'feature_off');
    const actor = (ctx.state?.actor as string | undefined)?.toLowerCase();
    if (!actor) return answer(ctx, 401, 'Sign this request with your member key.', 'unsigned');
    const body = ((ctx as any).requestBody && typeof (ctx as any).requestBody === 'object' ? (ctx as any).requestBody : {}) as Record<string, unknown>;
    try {
        ctx.body = fn(actor, body);
    } catch (e) {
        respond(ctx, e);
    }
}

export function createNamesListRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/names/state', (ctx) => asAdmin(ctx, (actor) => namesState(actor)));

    router.get('/api/names/entries', (ctx) => asAdmin(ctx, (actor) => {
        const purpose = ctx.query.for;
        if (purpose !== undefined && purpose !== 'export') throw new NamesListError(400, 'bad_request', "'for' is export, or left out.");
        return readEntries(actor, purpose === 'export' ? 'export' : 'read');
    }));

    router.post('/api/names/entries', (ctx) => asAdmin(ctx, (actor, body) => addEntry(actor, body), 201));
    router.put('/api/names/entries/:id', (ctx) => asAdmin(ctx, (actor, body) => editEntry(actor, ctx.params.id, body)));
    router.delete('/api/names/entries/:id', (ctx) => asAdmin(ctx, (actor) => deleteEntry(actor, ctx.params.id)));

    // A statement this server has already (a retry, or a replay after a rollback) is 200 `exists`, not a refusal.
    router.post('/api/names/generations', (ctx) => asAdmin(ctx, (actor, body) => {
        const out = addGeneration(actor, body);
        if (!out.exists) return { id: out.id, n: out.n };
        ctx.status = 200;
        return { id: out.id, n: out.n, code: 'exists' };
    }, 201));
    router.post('/api/names/shares', (ctx) => asAdmin(ctx, (actor, body) => addShare(actor, body)));

    // Debts and a second chance (engine/names-debts.ts): every entry's debt history, and paying one back.
    router.get('/api/names/debts', (ctx) => asAdmin(ctx, () => ({ debts: listDebts() })));
    router.post('/api/names/debts/:id/work-off', (ctx) => asAdmin(ctx, (actor, body) => confirmToWorkOff(actor, ctx.params.id, body), 201));
    router.post('/api/names/debts/:id/settle', (ctx) => asAdmin(ctx, (actor, body) => settleByPayment(actor, ctx.params.id, body)));

    // An invite bound to an entry (community modes slice 3): redeeming it confirms the joiner against the entry, by the
    // admin who made it. The same limits as any invite (W-main) and the door's rule; the entry's rule is confirmMember's.
    router.post('/api/names/entries/:id/invite', async (ctx) => {
        const actor = admin(ctx);
        if (!actor) return;
        try {
            const invite = generateInvite(actor, undefined, () => assertMayMakeInvite(actor), String(ctx.params.id));
            if (!invite) return answer(ctx, 403, word('Only registered members can generate invites'), 'not_member');
            ctx.status = 201;
            ctx.body = { success: true, invite };
        } catch (e) {
            if (respondProfileRefusal(ctx, e)) return;
            respond(ctx, e);
        }
    });
    router.get('/api/names/invites', (ctx) => asAdmin(ctx, () => ({ invites: readBoundInvites() })));

    router.post('/api/names/confirmations', (ctx) => asAdmin(ctx, (actor, body) => confirmMember(actor, body), 201));
    router.post('/api/names/confirmations/:id/second', (ctx) => asAdmin(ctx, (actor) => secondConfirmation(actor, ctx.params.id)));
    router.post('/api/names/confirmations/:id/revoke', (ctx) => asAdmin(ctx, (actor) => revokeConfirmation(actor, ctx.params.id)));

    router.get('/api/names/log', (ctx) => asAdmin(ctx, () => {
        const limit = wholeQuery(ctx.query.limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT);
        const offset = wholeQuery(ctx.query.offset, 0, 1_000_000);
        if (limit === null || limit < 1) throw new NamesListError(400, 'bad_request', `limit must be a whole number from 1 to ${MAX_LOG_LIMIT}.`);
        if (offset === null) throw new NamesListError(400, 'bad_request', 'offset must be a whole number.');
        return { ...readNamesLog(limit, offset), limit, offset };
    }));

    router.post('/api/names/settings', (ctx) => asAdmin(ctx, (actor, body) => setNamesSettings(actor, body)));

    // The Community health panel (engine/community-health.ts): totals for every owner and admin; the exceptions only in a
    // known community, each opening logged first; no export of balances.
    router.get('/api/names/health', (ctx) => asAdmin(ctx, () => healthSummary()));
    router.get('/api/names/health/exceptions', (ctx) => asAdmin(ctx, (actor) => openExceptions(actor)));
    router.get('/api/names/health/log', (ctx) => asAdmin(ctx, () => {
        const limit = wholeQuery(ctx.query.limit, 100, 500);
        if (limit === null || limit < 1) throw new NamesListError(400, 'bad_request', 'limit must be a whole number from 1 to 500.');
        return { log: readHealthAccessLog(limit, 'balance'), tradeLog: readHealthAccessLog(limit, 'trades') };
    }));
    router.post('/api/names/health/settings', (ctx) => asAdmin(ctx, (actor, body) => {
        if (!isNodeOwner(actor)) throw new NamesListError(403, 'owner_only', word('Only an owner of this community can change what the admins see.'));
        return setHealthSettings(actor, body);
    }));

    // A known community's rule, in its own numbers: public, for the join screen; the words are core's, in the reader's language.
    router.get('/api/community/known-rule', (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        ctx.body = knownRule();
    });
    // A member stepping back from being confirmed: the signer's own, and nobody else's. Nothing here names a member, and a
    // body that does is refused rather than read as the signer's own: an admin who means someone else steps nobody back.
    router.post('/api/names/step-back', (ctx) => asMember(ctx, (actor, body) => {
        if (Object.keys(body).length > 0) throw new NamesListError(403, 'not_yours', word('Each member steps back for themselves.'));
        return stepBackFromConfirmed(actor);
    }));

    // Vouchers (engine/vouchers.ts). The block is the committee's: an admin who isn't on it reads a voucher's card only.
    router.get('/api/names/vouchers', (ctx) => asAdmin(ctx, (actor) => {
        if (!isOnCreditCommittee(actor)) throw new VoucherError(403, 'committee_only', VOUCHER_WORDS.committeeOnly);
        return vouchersBlock();
    }));
    // Making a voucher, setting a budget and stopping one each tell the voucher (§10.2), once the change has committed.
    const tell: TellVoucher = (notice) => tellVoucherNotice(notice, { broadcast, dispatchPushNotification });
    router.post('/api/names/vouchers', (ctx) => asAdmin(ctx, (actor, body) => makeVoucher(actor, body, tell), 201));
    router.post('/api/names/vouchers/settings', (ctx) => asAdmin(ctx, (actor, body) => setVoucherSettings(actor, body)));
    router.get('/api/names/vouchers/:member', (ctx) => asAdmin(ctx, (actor) => readVoucherCard(actor, ctx.params.member)));
    router.delete('/api/names/vouchers/:member', (ctx) => asAdmin(ctx, (actor) => stopVoucher(actor, ctx.params.member, tell)));
    router.post('/api/names/vouchers/:member/budget', (ctx) => asAdmin(ctx, (actor, body) => setBudgetLevel(actor, ctx.params.member, body, tell)));
    router.post('/api/names/committee', (ctx) => asAdmin(ctx, (actor, body) => setCreditCommittee(actor, body)));

    // The signer's own locked copy, and nobody else's: no parameter names an owner.
    router.get('/api/names/copy', (ctx) => asAdmin(ctx, (actor) => readNamesCopyOf(actor)));
    router.put('/api/names/copy', (ctx) => asAdmin(ctx, (actor, body) => {
        const out = saveNamesCopy(actor, body);
        return out.exists ? { seq: out.seq, code: 'exists' } : { seq: out.seq };
    }));

    return router;
}
