/**
 * "Ask to join" (G6, design §3.3): a stranger asks a local community to let them in, and any member answers.
 * The rules and what is kept: engine/knocks.ts.
 *
 * The applicant, signed with their own key (the same key on every node), not a member here (a key a re-key replaced
 * gets 403 `key_invalidated` from both):
 *   POST /api/join/knock          { message, callsign, avatar?, fromNode? }  → 201 { knock: { status: 'pending' } }
 *   GET  /api/join/knock/status   → { status: 'none' | 'pending' } | { status: 'approved', invite, expiresAt }
 * Any member (tiers gate nothing), signed:
 *   GET  /api/join/knocks?limit&offset          → { knocks: [{ id, pubkey, callsign, message, avatar, fromNode, createdAt }], total, limit, offset }
 *   POST /api/join/knocks/:id/approve           → { knock: { id, status: 'approved' }, invite: { code, expiresAt } }
 *   POST /api/join/knocks/:id/decline           → { knock: { id, status: 'declined' } }   ("Not now")
 * The operator (the admin session or password, like the rest of Settings):
 *   GET  /api/local/admin/knocks                → { acceptKnocks, takingKnocks, open }
 *   and `acceptKnocks` in GET /api/node/config and POST /api/local/admin/node/config (routes/settings.ts).
 *
 * Every /api/join/knock route answers 404 `feature_off` while the `knocks` switch is off (the global node, or a
 * community whose operator opted out), before any handler runs (routes/profile-feature-gate.ts). An unsigned write
 * never gets that far: the signature middleware refuses it first (401), as it does the open door's.
 *
 * ## The actor is always the signer
 *
 * No route here takes a key from the body or the query. The applicant is `ctx.state.actor`, verified by the real
 * `requireSignature` middleware, in the member table's spelling (lower-case hex); a body `publicKey` or `pubkey` naming
 * anyone else is refused by the middleware's spoof check. The body names where the app came from as `fromNode`, not
 * `from`: the middleware reads a `from` field as the sender's key and refuses any other value. A knock is a signed
 * write by a non-member, which the middleware allows (writes carry their own authorisation); the status read is on
 * the public list (https-server.ts) so a signed non-member reaches it, and it answers only for the signer. The list
 * and the answers are gated reads and writes for members: a non-member is refused by the middleware (read) or here.
 *
 * ## Limits
 *
 * The auth limiter (15 a minute per address) on a knock, and the knock rules: one open knock per key, 3 an address a
 * day, 30 days after a decline (engine/knocks.ts). The gateway's `invites` switch covers these routes too
 * (https-server.ts): a node that takes no invites takes no knocks.
 */
import Router from '@koa/router';
import { isNodeMember, assertMemberActive } from '../state-engine.js';
import { clientLimiterKey } from '../client-ip.js';
import { getConfiguredSwitches, getProfileSwitches } from '../config/node-profile.js';
import { isAcceptableAvatarValue } from '../engine/avatar.js';
import { stripImageValue } from '../storage/image-metadata.js';
import {
    KNOCK_RULES, submitKnock, knockStatusFor, listOpenKnocks, openKnockCount, approveKnock, declineKnock, knockerRefusal,
    type KnockRefusal, type AnswerRefusal,
} from '../engine/knocks.js';
import { openJoinKeyInvalidated } from '../engine/open-join.js';
import type { RouteDeps } from './types.js';

const DEFAULT_LIST_LIMIT = 20;
/** Each knock may carry an avatar (up to KNOCK_RULES.avatarChars), so a page is kept small. */
const MAX_LIST_LIMIT = 50;

/** The signer's key as the member table keeps it (lower-case hex), or null when it has no such spelling. */
function canonicalKey(signer: string): string | null {
    const key = signer.toLowerCase();
    return /^[0-9a-f]{64}$/.test(key) ? key : null;
}

function answer(ctx: any, status: number, error: string, code: string, extra: Record<string, unknown> = {}): void {
    ctx.status = status;
    ctx.body = { error, code, ...extra };
}

/** The signer, in the member table's spelling, or null once the refusal is written. */
function signer(ctx: any, unsignedMessage: string): string | null {
    const actor = ctx.state?.actor as string | undefined;
    if (!actor) { answer(ctx, 401, unsignedMessage, 'unsigned'); return null; }
    const key = canonicalKey(actor);
    if (!key) { answer(ctx, 400, 'The key that signed this request must be 64 hexadecimal characters.', 'bad_key'); return null; }
    return key;
}

/** A member here in good standing, who may see and answer knocks, or null once the refusal is written. */
function answeringMember(ctx: any): string | null {
    const key = signer(ctx, 'A signed request is required.');
    if (!key) return null;
    if (!isNodeMember(key)) {
        answer(ctx, 403, 'Only a member of this community can see or answer requests to join.', 'not_member');
        return null;
    }
    try {
        assertMemberActive(key);
    } catch {
        answer(ctx, 403, 'Your account here is suspended, so you can’t answer requests to join.', 'not_active');
        return null;
    }
    return key;
}

// ── Reading the knock ─────────────────────────────────────────────────────────────────────────────────────────────

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Line breaks and tabs are kept; every other control character goes. */
const CONTROL = /(?![\n\t])\p{Cc}/gu;
const chars = (s: string) => Array.from(s).length;

function parseCallsign(raw: unknown): Parsed<string> {
    if (typeof raw !== 'string') return { ok: false, error: "'callsign' is required: the name you'd like this community to see." };
    const callsign = raw.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
    if (chars(callsign) < 2) return { ok: false, error: 'Please give a name of at least 2 characters.' };
    if (chars(callsign) > KNOCK_RULES.callsignChars) return { ok: false, error: `Please keep your name to ${KNOCK_RULES.callsignChars} characters.` };
    return { ok: true, value: callsign };
}

function parseMessage(raw: unknown): Parsed<string> {
    if (typeof raw !== 'string') return { ok: false, error: "'message' is required: a few words about yourself." };
    const message = raw.replace(CONTROL, '').trim();
    if (!message) return { ok: false, error: 'Please say a few words about yourself.' };
    if (chars(message) > KNOCK_RULES.messageChars) return { ok: false, error: `Please keep your message to ${KNOCK_RULES.messageChars} characters.` };
    return { ok: true, value: message };
}

/** Optional: a photo as a data URL (JPEG, PNG, WebP or GIF, its metadata taken off here) or a shipped `bundled://` one. */
function parseAvatar(raw: unknown): Parsed<string | null> {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, error: "'avatar' must be a picture." };
    const value = raw.trim();
    if (/^bundled:\/\/[A-Za-z0-9_-]{1,64}$/.test(value)) return { ok: true, value };
    if (value.length > KNOCK_RULES.avatarChars) return { ok: false, error: 'That picture is too large. Please choose a smaller one.' };
    if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(value) || !isAcceptableAvatarValue(value)) {
        return { ok: false, error: 'The picture must be a JPEG, PNG, WebP or GIF image.' };
    }
    return { ok: true, value: stripImageValue(value) };
}

/** Optional: the node the app came from, as a host name (`global.beanpool.org`). Shown to members; not checked. */
function parseFromNode(raw: unknown): Parsed<string | null> {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
    if (typeof raw !== 'string' || raw.length > 300) return { ok: false, error: "'fromNode' must be a node's address." };
    const host = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    if (host.length > 253 || !new RegExp(`^${label}(?:\\.${label})*(?::\\d{1,5})?$`).test(host)) {
        return { ok: false, error: "'fromNode' must be a node's address, like global.beanpool.org." };
    }
    return { ok: true, value: host };
}

const KEY_INVALIDATED = 'This key was replaced by a new one, so it can’t ask to join. Use the device or the 12 words that hold the new key.';

function refuseKnock(ctx: any, reason: KnockRefusal): void {
    switch (reason) {
        case 'already_member':
            return answer(ctx, 409, 'You are already a member of this community.', reason);
        case 'account_closed':
            return answer(ctx, 403, 'This key’s account in this community was closed, so it can’t ask to join again.', reason);
        case 'key_invalidated':
            return answer(ctx, 403, KEY_INVALIDATED, reason);
        case 'knock_open':
            // An open knock, and a declined one in its 30 days, get this same answer: a decline is never a message.
            return answer(ctx, 409, 'You’ve already asked to join. There’s no answer yet.', reason);
        case 'knock_approved':
            return answer(ctx, 409, 'A member has already invited you. Your app can join with that invite now.', reason);
        case 'rate_limited':
            return answer(ctx, 429, `Too many requests to join have come from this network today (${KNOCK_RULES.perAddressPerDay}). Please try again tomorrow.`, reason);
    }
}

function refuseAnswer(ctx: any, reason: AnswerRefusal): void {
    switch (reason) {
        case 'not_found':
            return answer(ctx, 404, 'There’s no such request to join.', reason);
        case 'answered':
            return answer(ctx, 409, 'Another member has already answered this request.', reason);
        case 'lapsed':
            return answer(ctx, 409, 'This request is more than 30 days old and has lapsed. They can ask again.', reason);
        case 'already_member':
            return answer(ctx, 409, 'They have already joined this community.', reason);
        case 'key_invalidated':
            return answer(ctx, 409, 'This request came from a key that has since been replaced by a new one, so there is nothing to answer.', reason);
    }
}

function wholeQuery(raw: unknown, fallback: number, max: number): number | null {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) return null;
    const n = Number(raw);
    return n > max ? null : n;
}

export function createKnockRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { rateLimit, checkAdminAuth } = deps;

    router.post('/api/join/knock', async (ctx) => {
        const applicant = signer(ctx, 'This request must be signed by the key you are asking to join with.');
        if (!applicant) return;
        if (!rateLimit(ctx)) return;
        // Who can't knock at all is told before their words are read, so a member's app learns it plainly.
        const refusal = knockerRefusal(applicant);
        if (refusal) return refuseKnock(ctx, refusal);

        const body = (ctx as any).requestBody || {};
        const callsign = parseCallsign(body.callsign);
        if (!callsign.ok) return answer(ctx, 400, callsign.error, 'bad_request');
        const message = parseMessage(body.message);
        if (!message.ok) return answer(ctx, 400, message.error, 'bad_request');
        const avatar = parseAvatar(body.avatar);
        if (!avatar.ok) return answer(ctx, 400, avatar.error, 'bad_request');
        const fromNode = parseFromNode(body.fromNode);
        if (!fromNode.ok) return answer(ctx, 400, fromNode.error, 'bad_request');

        const outcome = submitKnock({
            pubkey: applicant,
            callsign: callsign.value,
            message: message.value,
            avatar: avatar.value,
            fromNode: fromNode.value,
            address: clientLimiterKey(ctx),
        });
        if (!outcome.ok) return refuseKnock(ctx, outcome.reason);
        ctx.status = 201;
        ctx.body = { knock: { status: 'pending' } };
    });

    router.get('/api/join/knock/status', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const applicant = signer(ctx, 'Sign this request with the key you asked to join with.');
        if (!applicant) return;
        // A key a re-key replaced gets the knock's own refusal, and never an invite (engine/knocks.ts, "A re-key").
        if (openJoinKeyInvalidated(applicant)) return refuseKnock(ctx, 'key_invalidated');
        ctx.body = knockStatusFor(applicant);
    });

    router.get('/api/join/knocks', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = answeringMember(ctx);
        if (!member) return;
        const limit = wholeQuery(ctx.query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const offset = wholeQuery(ctx.query.offset, 0, 1_000_000);
        if (limit === null || limit < 1) return answer(ctx, 400, `limit must be a whole number from 1 to ${MAX_LIST_LIMIT}.`, 'bad_request');
        if (offset === null) return answer(ctx, 400, 'offset must be a whole number.', 'bad_request');
        const { knocks, total } = listOpenKnocks(limit, offset);
        ctx.body = { knocks, total, limit, offset };
    });

    router.post('/api/join/knocks/:id/approve', async (ctx) => {
        const member = answeringMember(ctx);
        if (!member) return;
        const outcome = approveKnock(String(ctx.params.id), member);
        if (!outcome.ok) return refuseAnswer(ctx, outcome.reason);
        ctx.body = { knock: { id: outcome.knockId, status: outcome.status }, ...(outcome.status === 'approved' ? { invite: outcome.invite } : {}) };
    });

    router.post('/api/join/knocks/:id/decline', async (ctx) => {
        const member = answeringMember(ctx);
        if (!member) return;
        const outcome = declineKnock(String(ctx.params.id), member);
        if (!outcome.ok) return refuseAnswer(ctx, outcome.reason);
        ctx.body = { knock: { id: outcome.knockId, status: outcome.status } };
    });

    // The operator's Settings: whether this community takes knocks, and how many are waiting. Not behind the switch,
    // so Settings can show the count beside the toggle that turns knocks back on.
    router.get('/api/local/admin/knocks', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = {
            acceptKnocks: getConfiguredSwitches().knocks,
            takingKnocks: getProfileSwitches().knocks,
            open: openKnockCount(),
        };
    });

    return router;
}
