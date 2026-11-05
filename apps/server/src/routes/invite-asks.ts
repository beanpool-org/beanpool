/**
 * A member asks an admin to invite someone (engine/invite-asks.ts holds the rules and what is kept). Every route is signed;
 * the actor is always the signer, never a body field.
 *
 * The member, in good standing, where the door is `admins`:
 *   POST /api/invite/asks                 { firstName, howKnown } → 201 { ask: { id, firstName, howKnown, askedAt } }
 *   GET  /api/invite/asks/mine            → { waiting: [ask], answers: [{ id, outcome, askedAt, answeredAt, code?, state?, reason? }] }
 *   POST /api/invite/asks/:id/withdraw    → { ok: true } | 404 `not_found`
 * An owner or admin, by nodeRoleOf; anyone else 403 `admins_only`:
 *   GET  /api/invite/asks?limit&offset    → { asks: [ask + askerPubkey, askerCallsign], total, limit, offset }
 *   POST /api/invite/asks/:id/send        → { ok: true } | 404 `not_found`
 *   POST /api/invite/asks/:id/no          { reason? } → { ok: true } | 404 `not_found`
 *
 * All 404 `feature_off` where invites are off (routes/profile-feature-gate.ts). A standby refuses a write, 503 `standby`, and
 * reads from its copy. Whoever passes the signature middleware here holds the key: no route in this file reads
 * `checkAdminAuth`, so neither an automation token nor the node password reaches one.
 */
import Router from '@koa/router';
import { dispatchPushNotification, isNodeMember, assertMemberActive, getNodeRole, readsAsMember } from '../state-engine.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import { cleanMemberText } from '../agent/fence.js';
import {
    answerNo, answerWithInvite, answersInviteAsks, listInviteAsks, makeInviteAsk, myInviteAsks, withdrawInviteAsk, type AskRefusal,
} from '../engine/invite-asks.js';
import { ADMINS_ONLY } from '../config/door.js';
import { INVITE_ASK_LIMITS, pushNoticeWords, word, wordsFor } from '@beanpool/core';
import type { RouteDeps } from './types.js';

// A refusal with a value in it, in English as a template wrote it, its sentence marked for the way out to find again in the
// member's language (member-words.ts).
const { t: tr } = wordsFor('en');

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const ONLY_MEMBERS = word('Only a member of this community can ask an admin to invite someone.');
const PAUSED = word('Your account here is paused for now, so you can’t ask for an invite.');
const ANSWER_REFUSED = word('Only this community’s owners and admins read and answer these.');
const NOT_FOUND = word('This ask is no longer waiting. It may have been answered or taken back.');
const STANDBY = word('This server is a standby copy of the community, so it can’t take this. Please try again at the community’s own address.');

function answer(ctx: any, status: number, error: string, code: string): void {
    ctx.status = status;
    ctx.body = { error, code };
}

/** The signer, or null once the refusal is written. */
function signer(ctx: any): string | null {
    const actor = ctx.state?.actor as string | undefined;
    if (actor) return actor;
    answer(ctx, 401, word('A signed request is required.'), 'unsigned');
    return null;
}

/** An active member's key, or null once the refusal is written. */
function activeMember(ctx: any): string | null {
    const key = signer(ctx);
    if (!key) return null;
    if (!isNodeMember(key)) { answer(ctx, 403, ONLY_MEMBERS, 'not_member'); return null; }
    try {
        assertMemberActive(key);
    } catch {
        answer(ctx, 403, PAUSED, 'not_active');
        return null;
    }
    return key;
}

/** An owner's or admin's key, or null once the refusal is written. */
function answerer(ctx: any): string | null {
    const key = activeMember(ctx);
    if (!key) return null;
    if (!answersInviteAsks(key)) { answer(ctx, 403, ANSWER_REFUSED, ADMINS_ONLY); return null; }
    return key;
}

function refuseAsk(ctx: any, reason: AskRefusal): void {
    switch (reason) {
        case 'not_member': return answer(ctx, 403, ONLY_MEMBERS, reason);
        case 'not_active': return answer(ctx, 403, PAUSED, reason);
        case 'door_not_admins': return answer(ctx, 409, word('There’s nothing to ask here: this community doesn’t keep invites to its admins.'), reason);
        case 'may_invite': return answer(ctx, 409, word('You’re an owner or admin here, so you can make the invite yourself.'), reason);
        case 'too_many_waiting': return answer(ctx, 429, tr('You have {n} asks waiting. Take one back, or wait for an answer.', { n: INVITE_ASK_LIMITS.waiting }), reason);
        case 'asked_enough_today': return answer(ctx, 429, tr('You’ve asked {n} times today. You can ask again tomorrow.', { n: INVITE_ASK_LIMITS.perDay }), reason);
    }
}

/** One line of what a person typed: hidden characters out (agent/fence.ts), spaces closed up. Null: over `max` characters. */
function oneLine(raw: unknown, max: number): string | null {
    if (typeof raw !== 'string') return '';
    const line = cleanMemberText(raw, max * 4).replace(/\s+/g, ' ').trim();
    return Array.from(line).length > max ? null : line;
}

/**
 * A phone number or an email address, which a request must not hold: nine digits in a run (spaces, brackets, dots and dashes
 * between them allowed), or an address. Nine, so a span of years ("friends since 2019-2023", eight) is no phone number.
 */
const CONTACT = /(?:\d[\s().-]*){9}|[^\s@]+@[^\s@]+\.[^\s@]+/;

function refusedOnStandby(ctx: any): boolean {
    if (getNodeRole() === 'primary') return false;
    answer(ctx, 503, STANDBY, 'standby');
    return true;
}

function wholeQuery(raw: unknown, fallback: number, max: number): number | null {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) return null;
    const n = Number(raw);
    return n > max ? null : n;
}

export function createInviteAskRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { rateLimit } = deps;

    /** Tells the member an ask of theirs was answered: fixed words only, to their own phones. Their kept notice does the rest. */
    const tellAsker = (asker: string): void => {
        const { title, body } = pushNoticeWords('community.invite-ask');
        try { dispatchPushNotification([asker], 'SYSTEM', title, body, { screen: 'people' }, 'marketplace', 'community.invite-ask'); } catch { /* it is kept */ }
    };

    router.post('/api/invite/asks', async (ctx) => {
        const member = activeMember(ctx);
        if (!member) return;
        if (refusedOnStandby(ctx)) return;
        if (!rateLimit(ctx, 'knock')) return;
        const body = ((ctx as any).requestBody || {}) as Record<string, unknown>;
        const firstName = oneLine(body.firstName, INVITE_ASK_LIMITS.firstName);
        const howKnown = oneLine(body.howKnown, INVITE_ASK_LIMITS.howKnown);
        if (firstName === null) return answer(ctx, 400, tr('Please keep this to {n} characters.', { n: INVITE_ASK_LIMITS.firstName }), 'too_long');
        if (howKnown === null) return answer(ctx, 400, tr('Please keep this to {n} characters.', { n: INVITE_ASK_LIMITS.howKnown }), 'too_long');
        if (!firstName || !howKnown) return answer(ctx, 400, word('Please fill in their first name and how you know them.'), 'bad_request');
        if (CONTACT.test(firstName) || CONTACT.test(howKnown)) {
            return answer(ctx, 400, word('Please leave out phone numbers and email addresses. A first name and how you know them is all an admin needs.'), 'contact_details');
        }
        let outcome: ReturnType<typeof makeInviteAsk>;
        try {
            outcome = makeInviteAsk(member, firstName, howKnown);
        } catch (e) {
            if (respondProfileRefusal(ctx, e)) return;
            throw e;
        }
        if (!outcome.ok) return refuseAsk(ctx, outcome.reason);
        ctx.status = 201;
        ctx.body = { ask: outcome.ask };
    });

    router.get('/api/invite/asks/mine', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = activeMember(ctx);
        if (!member) return;
        ctx.body = myInviteAsks(member);
    });

    router.post('/api/invite/asks/:id/withdraw', async (ctx) => {
        const key = signer(ctx);
        if (!key) return;
        // Paused or not, an ask is theirs to take back.
        if (!isNodeMember(key)) return answer(ctx, 403, ONLY_MEMBERS, 'not_member');
        if (refusedOnStandby(ctx)) return;
        if (!withdrawInviteAsk(key, String(ctx.params.id))) return answer(ctx, 404, NOT_FOUND, 'not_found');
        ctx.body = { ok: true };
    });

    router.get('/api/invite/asks', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const admin = answerer(ctx);
        if (!admin) return;
        if (!readsAsMember(admin)) return answer(ctx, 403, ANSWER_REFUSED, ADMINS_ONLY);
        const limit = wholeQuery(ctx.query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const offset = wholeQuery(ctx.query.offset, 0, 1_000_000);
        if (limit === null || limit < 1 || offset === null) return answer(ctx, 400, `limit is 1 to ${MAX_LIST_LIMIT}, and offset a whole number.`, 'bad_request');
        const { asks, total } = listInviteAsks(limit, offset);
        ctx.body = { asks, total, limit, offset };
    });

    router.post('/api/invite/asks/:id/send', async (ctx) => {
        const admin = answerer(ctx);
        if (!admin) return;
        if (refusedOnStandby(ctx)) return;
        let outcome: ReturnType<typeof answerWithInvite>;
        try {
            outcome = answerWithInvite(String(ctx.params.id), admin);
        } catch (e) {
            if (respondProfileRefusal(ctx, e)) return;
            throw e;
        }
        if (!outcome.ok) return answer(ctx, 404, NOT_FOUND, outcome.reason);
        tellAsker(outcome.asker);
        ctx.body = { ok: true };
    });

    router.post('/api/invite/asks/:id/no', async (ctx) => {
        const admin = answerer(ctx);
        if (!admin) return;
        if (refusedOnStandby(ctx)) return;
        const reason = oneLine(((ctx as any).requestBody || {}).reason, INVITE_ASK_LIMITS.reason);
        if (reason === null) return answer(ctx, 400, tr('Please keep this to {n} characters.', { n: INVITE_ASK_LIMITS.reason }), 'too_long');
        const outcome = answerNo(String(ctx.params.id), reason);
        if (!outcome.ok) return answer(ctx, 404, NOT_FOUND, outcome.reason);
        tellAsker(outcome.asker);
        ctx.body = { ok: true };
    });

    return router;
}
