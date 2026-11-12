/**
 * The giver's sight (scratch/fable-design/DESIGN-credit-list-fable.md §6, its amendment 1 §5, §6; slice C1; the reads are
 * engine/credit-sight.ts, the log engine/credit-looks.ts). Every route is signed with the member's own key, as POST /api/vouch
 * is: a Settings password session, an admin key session or an automation token gets 401. On a node with Beans off (global
 * among them) every route answers 404.
 *
 *   GET /api/credit/people          ?filter=all|no_credit|has_offers|mine &q= &after=   owners, admins, live vouchers
 *       → { sight, told, people: [...], next }; each person built for the signer's sight; one look per person recorded
 *         (surface `list`) before the answer, all or none.
 *   GET /api/credit/people/:member   the card or sheet for one person; its look recorded (surface `card`) first.
 *   GET /api/credit/looks           ?limit &offset (&actor &day | &member)   owners and admins: who looked at whom. Not logged.
 *   GET /api/credit/me              any member: what givers see about them, the voucher answer; no look recorded.
 *   POST /api/credit/known-floor    `{ memberPubkey, raiseTo_c }` owners and every admin raise a confirmed member's known
 *       floor, never their own, never lower (slice C2, engine/credit-give.ts): Settings' writer underneath, the member told
 *       by the credit notice it makes. → { memberPubkey, was_c, knownFloor_c }. Records no look (it shows no balance). A
 *       voucher, a moderator or a member 403 `owners_admins_only`; a standby 409 `standby`.
 *   GET /api/credit/people?filter=vouchers   owners and committee admins (slice C3): the Vouchers chip, every live
 *       voucher's budget, branch health and the top-up offer (engine/vouchers.ts vouchersChip); 403 `committee_only` for
 *       anyone else who gives credit. No look recorded: it shows budgets and counts, never a balance.
 *   POST /api/vouchers/ask          a live voucher who is not an owner (slice C3): Ask for more, one tap, no body (any key
 *       in it: 400 `no_body`), once a week (409 `asked_this_week`); told to every owner and committee admin
 *       (engine/vouchers.ts askForMore). A standby refuses it (409).
 *
 * Refusals: unsigned 401; a member, a moderator, a visitor or a stranger 403 `not_a_giver` (`looks`: a voucher too,
 * `owners_admins_only`); a standby 409 `standby` for every read that records a look (it records nothing); a look that can't
 * be recorded 500, with no body. The told sentence (core CREDIT_SIGHT_WORDS.told) is in every answer that shows a balance:
 * the rules page says it in the same release (core community-shape-card.ts), so no node answers a look its page doesn't
 * state.
 */
import Router from '@koa/router';
import { CREDIT_SIGHT_WORDS, word, type CreditSight } from '@beanpool/core';
import { db } from '../db/db.js';
import { getMember, isVisitorKey, broadcast, dispatchPushNotification } from '../state-engine.js';
import { getNodeRole, STANDBY_CODE, STANDBY_WRITE_MESSAGE } from '../config/node-role.js';
import { BEANS_OFF_MESSAGE } from '../config/node-profile.js';
import { NOT_A_MEMBER_CODE } from '../engine/members.js';
import { CreditSightError, creditMe, creditPeople, creditPerson, creditSightOn, giverSight, memberKeyOf } from '../engine/credit-sight.js';
import { VoucherError, VOUCHER_WORDS, askForMore, isOnCreditCommittee, tellVoucherNotice, vouchersChip } from '../engine/vouchers.js';
import { readLooks, recordLooks } from '../engine/credit-looks.js';
import { CreditGiveError, CREDIT_GIVE_WORDS, raiseKnownFloor } from '../engine/credit-give.js';
import { KnownFloorError } from '../config/known-floor.js';
import { SERVER_FAULT_TEXT } from './member-error-text.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import { logger } from '../logger.js';
import type { RouteDeps } from './types.js';

/** The told sentence (core), in the English it is keyed by: the apps draw it in the reader's language (creditSightLine). */
const TOLD = String(CREDIT_SIGHT_WORDS.told);
const NOT_A_GIVER = word('Only the owners, admins and vouchers here can see credit.');
const OWNERS_ADMINS_ONLY = word('Only the owners and admins here can read who looked.');
const NOT_LISTED = word('Nobody here by that key.');
const SIGN_IT = word('Sign this request with your member key.');
const TOO_MANY = word('That is a lot of looking for one hour. Try again later.');
/** The committee's chip (slice C3): budgets, not people's credit. */
const VOUCHERS_FILTER = 'vouchers';

/** The list's reads per viewer an hour (design §5.2): 120, then the node's sentence. Per process. */
const LIST_READS_PER_HOUR = 120;
const HOUR_MS = 60 * 60 * 1000;
const listReads = new Map<string, { since: number; n: number }>();

function answer(ctx: any, status: number, error: string, code: string): void {
    ctx.status = status;
    ctx.body = { error, code };
}

/** The signing member's key, once each refusal before it is written: Beans off 404, unsigned or not the key's own 401. */
function signer(ctx: any): string | null {
    ctx.set('Cache-Control', 'private, no-store');
    if (!creditSightOn()) { answer(ctx, 404, BEANS_OFF_MESSAGE, 'beans_off'); return null; }
    const actor = ctx.state?.actor as string | undefined;
    const signed = (ctx.state as any)?.authSig?.signer as string | undefined;
    // Only a request the member's own key signed: a key session, a password session or a token sets an actor of its own.
    if (!actor || signed !== actor || ctx.state?.viaToken || ctx.state?.adminSessionId || ctx.state?.isBreakGlassAuth) {
        answer(ctx, 401, SIGN_IT, 'unsigned');
        return null;
    }
    return actor;
}

/** The signer's sight, or null once 403 is written. Decided now, from the node's tables. */
function sightOf(ctx: any, viewer: string): CreditSight | null {
    const sight = giverSight(viewer);
    if (!sight) answer(ctx, 403, NOT_A_GIVER, 'not_a_giver');
    return sight;
}

/** A standby answers no look: it records none (the voucher card's 409). */
function refusedOnStandby(ctx: any): boolean {
    if (getNodeRole() !== 'backup') return false;
    answer(ctx, 409, STANDBY_WRITE_MESSAGE, STANDBY_CODE);
    return true;
}

/**
 * Works out the answer and records its looks in ONE transaction, then answers: a look that can't be recorded rolls the
 * read back and answers 500 with no body, never the read.
 */
function answerAfterLooks(ctx: any, build: () => { body: unknown; viewer: string; sight: CreditSight; subjects: string[]; surface: 'list' | 'card' } | null): void {
    let out: ReturnType<typeof build>;
    try {
        out = db.transaction(() => {
            const built = build();
            if (built) recordLooks(built.viewer, built.sight, built.subjects, built.surface);
            return built;
        })();
    } catch (e) {
        if (e instanceof CreditSightError) return answer(ctx, e.status, e.message, e.code);
        if ((e as { code?: unknown })?.code === STANDBY_CODE) return answer(ctx, 409, STANDBY_WRITE_MESSAGE, STANDBY_CODE);
        logger.error('LEDGER', 'A credit look could not be recorded, so it was not answered', { error: (e as Error)?.message });
        ctx.status = 500;
        ctx.body = { error: SERVER_FAULT_TEXT, code: 'not_recorded' };
        return;
    }
    if (!out) return answer(ctx, 404, NOT_LISTED, 'not_listed');
    ctx.status = 200;
    ctx.body = out.body;
}

export function createCreditSightRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { clampLimit, clampOffset } = deps;

    router.get('/api/credit/people', (ctx) => {
        const viewer = signer(ctx);
        if (!viewer) return;
        const sight = sightOf(ctx, viewer);
        if (!sight || refusedOnStandby(ctx)) return;
        const now = Date.now();
        const reads = listReads.get(viewer);
        const window = reads && now - reads.since < HOUR_MS ? reads : { since: now, n: 0 };
        if (window.n >= LIST_READS_PER_HOUR) return answer(ctx, 429, TOO_MANY, 'too_many_looks');
        window.n++;
        listReads.set(viewer, window);
        if (ctx.query.filter === VOUCHERS_FILTER) {
            // The Vouchers chip is the committee's (slice C3): a plain admin, a voucher or anyone else gets no budget row.
            if (sight === 'voucher' || !isOnCreditCommittee(viewer)) return answer(ctx, 403, VOUCHER_WORDS.committeeOnly, 'committee_only');
            ctx.status = 200;
            ctx.body = { sight, filter: VOUCHERS_FILTER, vouchers: vouchersChip(viewer), next: null };
            return;
        }
        answerAfterLooks(ctx, () => {
            const page = creditPeople(viewer, sight, { filter: ctx.query.filter, q: ctx.query.q, after: ctx.query.after });
            return {
                body: { sight, told: TOLD, ...page },
                viewer, sight, subjects: page.people.map((p) => p.memberPubkey).filter((pk) => pk !== viewer), surface: 'list',
            };
        });
    });

    router.get('/api/credit/people/:member', (ctx) => {
        const viewer = signer(ctx);
        if (!viewer) return;
        const sight = sightOf(ctx, viewer);
        if (!sight || refusedOnStandby(ctx)) return;
        const member = memberKeyOf(ctx.params.member);
        if (!member) return answer(ctx, 400, word('A member key is 64 hexadecimal characters.'), 'bad_key');
        answerAfterLooks(ctx, () => {
            const person = creditPerson(viewer, sight, member);
            if (!person) return null;
            return { body: { sight, told: TOLD, person }, viewer, sight, subjects: member === viewer ? [] : [member], surface: 'card' };
        });
    });

    router.get('/api/credit/looks', (ctx) => {
        const viewer = signer(ctx);
        if (!viewer) return;
        const sight = giverSight(viewer);
        if (sight !== 'owner' && sight !== 'admin') return answer(ctx, 403, OWNERS_ADMINS_ONLY, 'owners_admins_only');
        const actor = ctx.query.actor === undefined ? null : memberKeyOf(ctx.query.actor);
        const member = ctx.query.member === undefined ? null : memberKeyOf(ctx.query.member);
        const day = typeof ctx.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.day) ? ctx.query.day : null;
        if ((ctx.query.actor !== undefined && !actor) || (ctx.query.member !== undefined && !member) || (ctx.query.day !== undefined && !day) || (!!actor !== !!day)) {
            return answer(ctx, 400, word('Ask for the groups, one looker on one day, or one member.'), 'bad_request');
        }
        ctx.status = 200;
        ctx.body = readLooks({ limit: clampLimit(ctx.query.limit, 50), offset: clampOffset(ctx.query.offset), actor, day, member });
    });

    router.post('/api/vouchers/ask', (ctx) => {
        const viewer = signer(ctx);
        if (!viewer) return;
        // One tap, no words and no amount: the level is the giver's pick (5 Nov §10). A body that says anything is refused
        // whole, before anything is read or written.
        const body = (ctx as any).requestBody;
        if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)) {
            return answer(ctx, 400, VOUCHER_WORDS.askNoBody, 'no_body');
        }
        if (refusedOnStandby(ctx)) return;
        try {
            const out = askForMore(viewer);
            for (const n of out.notices) tellVoucherNotice(n, { broadcast, dispatchPushNotification });
            ctx.status = 200;
            ctx.body = { askedAt: out.askedAt, askAgainAt: out.askAgainAt };
        } catch (e) {
            if (e instanceof VoucherError) {
                ctx.status = e.status;
                ctx.body = { error: e.message, code: e.code, ...(e.extra ?? {}) };
                return;
            }
            if ((e as { code?: unknown })?.code === STANDBY_CODE) return answer(ctx, 409, STANDBY_WRITE_MESSAGE, STANDBY_CODE);
            if (respondProfileRefusal(ctx, e)) return;
            throw e;
        }
    });

    router.get('/api/credit/me', (ctx) => {
        const viewer = signer(ctx);
        if (!viewer) return;
        const m = getMember(viewer);
        if (!m || isVisitorKey(viewer)) return answer(ctx, 403, word('Not a member of this community.'), NOT_A_MEMBER_CODE);
        const me = creditMe(viewer);
        if (!me) return answer(ctx, 404, NOT_LISTED, 'not_listed');
        ctx.status = 200;
        ctx.body = { told: TOLD, me };
    });

    router.post('/api/credit/known-floor', (ctx) => {
        const actor = signer(ctx);
        if (!actor) return;
        const sight = giverSight(actor);
        if (sight !== 'owner' && sight !== 'admin') return answer(ctx, 403, CREDIT_GIVE_WORDS.ownersAdminsOnly, 'owners_admins_only');
        if (refusedOnStandby(ctx)) return;
        try {
            // The member's notice is the credit-notices one Settings' writer makes, told once the raise has committed.
            ctx.body = raiseKnownFloor(actor, (ctx as any).requestBody || {}, (notice) => tellVoucherNotice(notice, { broadcast, dispatchPushNotification }));
            ctx.status = 200;
        } catch (e) {
            if (e instanceof CreditGiveError || e instanceof KnownFloorError) return answer(ctx, e.status, e.message, e.code);
            if ((e as { code?: unknown })?.code === STANDBY_CODE) return answer(ctx, 409, STANDBY_WRITE_MESSAGE, STANDBY_CODE);
            throw e;
        }
    });

    return router;
}
