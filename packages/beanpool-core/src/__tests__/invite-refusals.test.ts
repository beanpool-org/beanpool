/**
 * Make invite's answers, read once for both apps (PR #3206 round 3; DESIGN-getting-paid-fable.md §4.5, slice B3). Two classes,
 * each as one invariant over a whole table:
 *
 *   C. Every refusal POST /api/invite/generate can answer is read as its own: "this community takes no invites" only for the
 *      invites' own 404 `feature_off` (isInvitesOffAnswer), never for a bill's (`feature: 'bills'`, bills switched off after
 *      the panel read the node); every other 4xx in the node's words is a refusal in those words (inviteBillAnswerOf); a busy
 *      network's 429 is the busy sentence; a 5xx, a page that isn't the node's, or no answer is "not known".
 *   D. A member's list holds each invite once, by its code (listWithInvite): an answer with an invite already listed replaces
 *      that row; a new one goes first.
 *
 * The rows are the server's refusals, read from apps/server: routes/community.ts POST /api/invite/generate, engine/invites.ts
 * generateInvite, engine/bills.ts checkInviteBill (and assertUnderLimits), engine/writer-bounds.ts assertMayMakeInvite,
 * config/door.ts, config/node-role.ts, routes/profile-feature-gate.ts and gateway-rate-limit.ts.
 */
import { describe, expect, it } from 'vitest';
import { billLines, inviteBillAfter, inviteBillAnswerOf, type InviteBillHeld } from '../bills.js';
import { isInvitesOffAnswer, listWithInvite } from '../invite-rows.js';
import { busyWords } from '../busy-answer.js';
import { t } from '../words.js';

/** One refusal as the node sends it: status, and its JSON body (null: not JSON, a page in front of the node). */
interface Refusal { status: number; body: { error?: string; code?: string; feature?: string } | null }
type Read = 'invites_off' | 'bill' | 'invite' | 'busy' | 'lost';

/** Every answer the route can give that is not an invite, and how it must be read. */
const REFUSALS: Array<[string, Refusal, Read]> = [
    // profileFeatureGate, and engine/invites.ts assertInvitesOn under it: the invites' own switch.
    ['invites off (the gate)', { status: 404, body: { error: 'This community doesn’t use invites.', code: 'feature_off', feature: 'invites' } }, 'invites_off'],
    ['invites off (no switch named)', { status: 404, body: { error: 'This community doesn’t use invites.', code: 'feature_off' } }, 'invites_off'],
    // checkInviteBill → assertBillsHere: bills switched off after the panel read the node (the finding of round 2).
    ['bills off', { status: 404, body: { error: 'Bills are switched off on this node.', code: 'feature_off', feature: 'bills' } }, 'bill'],
    ['Beans off', { status: 403, body: { error: 'Beans are switched off on this node.', code: 'profile_no_beans' } }, 'invite'],
    ['bill id', { status: 400, body: { error: billLines.badId(), code: 'bill_id' } }, 'bill'],
    ['bill sender', { status: 403, body: { error: billLines.notAMember(), code: 'bill_sender' } }, 'bill'],
    ['bill amount', { status: 400, body: { error: billLines.badAmount(), code: 'bill_amount' } }, 'bill'],
    ['bill what for', { status: 400, body: { error: billLines.badWhatFor(), code: 'bill_what_for' } }, 'bill'],
    ['bill id reused', { status: 409, body: { error: billLines.idReused(), code: 'bill_id_reused' } }, 'bill'],
    ['bills on hold', { status: 403, body: { error: billLines.onHold(), code: 'bills_on_hold' } }, 'bill'],
    ['bill on a names entry', { status: 400, body: { error: 'A bill goes only with an invite of your own.', code: 'bill_on_entry' } }, 'bill'],
    ['bills sent today', { status: 429, body: { error: 'You have sent 20 bills today.', code: 'bills_sent_day' } }, 'bill'],
    ['bills to new people today', { status: 429, body: { error: 'You have sent bills to 3 new people today.', code: 'bills_new_people_day' } }, 'bill'],
    ['bills to one person', { status: 429, body: { error: 'Two unpaid bills to one person.', code: 'bills_to_one' } }, 'bill'],
    ['bills out', { status: 429, body: { error: 'You have 30 bills out.', code: 'bills_out' } }, 'bill'],
    ['muted', { status: 403, body: { error: 'You are muted for an hour.', code: 'moderation_muted' } }, 'invite'],
    ['only admins invite', { status: 403, body: { error: 'In this community only its admins invite people.', code: 'admins_only' } }, 'invite'],
    ['paused', { status: 403, body: { error: 'Your account here is paused for now, so you can’t invite anyone.', code: 'paused' } }, 'invite'],
    ['not a member', { status: 403, body: { error: 'Only registered members can generate invites' } }, 'invite'],
    ['not signed', { status: 401, body: { error: 'A signed request is required' } }, 'invite'],
    ['no key', { status: 400, body: { error: 'publicKey is required' } }, 'invite'],
    ['invites today', { status: 429, body: { error: 'You can make 20 invites in any 24 hours.', code: 'invites_per_day' } }, 'invite'],
    ['invites unused', { status: 429, body: { error: 'You have 50 invites nobody has used yet.', code: 'invites_unused' } }, 'invite'],
    ['a standby', { status: 409, body: { error: 'This server is a standby copy of the community.', code: 'standby' } }, 'invite'],
    ['a vouch refused', { status: 403, body: { error: 'You are not a voucher.', code: 'not_a_voucher' } }, 'invite'],
    ['the gateway limit', { status: 429, body: { error: 'Gateway rate limit exceeded. Please try again in 9s.' } }, 'invite'],
    ['the day budget', { status: 429, body: { error: 'You have made 1,000 changes today.', code: 'day_budget' } }, 'invite'],
    // Not the node's: a busy network in front of it, a fault, a proxy's page.
    ['a busy network (no JSON)', { status: 429, body: null }, 'busy'],
    ['a server fault', { status: 500, body: { error: 'Something went wrong on the server.' } }, 'lost'],
    ['a proxy page', { status: 502, body: null }, 'lost'],
];

/** How an app reads one: its status, its words, its code (`busy` for a busy network), whether it was JSON, its switch. */
const answerOf = ({ status, body }: Refusal) => {
    const busy = status === 429 && body === null;
    return inviteBillAnswerOf(status, body?.error ?? null, busy ? 'busy' : body?.code, body === null, body?.feature);
};

describe('C: every refusal of Make invite is read as its own (the whole table)', () => {
    const held: InviteBillHeld = { key: '1200 Bread', id: 'id-1' };

    it('the table holds every row once, and both the bills switch and the invites switch', () => {
        expect(new Set(REFUSALS.map(([name]) => name)).size).toBe(REFUSALS.length);
        expect(REFUSALS.filter(([, r]) => r.body?.code === 'feature_off').map(([, r]) => r.body?.feature)).toEqual(['invites', undefined, 'bills']);
    });

    it.each(REFUSALS)('%s', (_name, refusal, read) => {
        const { status, body } = refusal;
        // "No invites here" (and the web's page taken away) for the invites' own switch only.
        expect(isInvitesOffAnswer(status, body?.code, body?.feature), 'read as invites off').toBe(read === 'invites_off');
        if (read === 'invites_off') return;
        const answer = answerOf(refusal);
        const after = inviteBillAfter(held, answer);
        if (read === 'lost') {
            expect(answer).toEqual({ kind: 'lost' });
            expect(after.title).toBe(t('No answer'));
            expect(after.held).toBe(held);
            return;
        }
        expect(answer.kind).toBe('refused');
        // Its own words: the node's sentence, or the busy sentence for a busy network.
        expect(after.words).toBe(read === 'busy' ? busyWords() : body!.error);
        // A bill's own refusal under the bill's title, anything else under "Invite not made"; never "No invites here".
        expect(after.title).toBe(read === 'bill' ? t('Could not add the bill') : t('Invite not made'));
        // The id is let go only when the node says it is spent.
        expect(after.held).toBe(body?.code === 'bill_id_reused' ? null : held);
    });

    it('a switch the invites never had (any other `feature`) is never invites off', () => {
        for (const feature of ['bills', 'beans', 'forum', 'knocks', null, '', 'Invites']) {
            expect(isInvitesOffAnswer(404, 'feature_off', feature)).toBe(false);
        }
        expect(isInvitesOffAnswer(403, 'feature_off', 'invites')).toBe(false);
        expect(isInvitesOffAnswer(404, 'not_found', 'invites')).toBe(false);
    });
});

describe('D: an invite is in the list once, by its code (the whole table)', () => {
    type Row = { code: string; createdAt: string; expiresAt?: string; bill?: { whatFor: string; amount_c: number } };
    const OLD: Row = { code: 'INV-OLD1', createdAt: '2026-11-01T00:00:00.000Z' };
    const X: Row = { code: 'INV-XXXX', createdAt: '2026-11-10T00:00:00.000Z', expiresAt: '2026-12-10T00:00:00.000Z' };
    const NEWER: Row = { code: 'INV-NEW2', createdAt: '2026-11-12T00:00:00.000Z' };
    const ANSWER_X: Row = { code: 'INV-XXXX', createdAt: '2026-11-10T00:00:00.000Z', bill: { whatFor: 'Bread', amount_c: 1200 } };

    const TABLE: Array<[string, Row[], Row, string[]]> = [
        ['a new invite, nothing listed', [], NEWER, ['INV-NEW2']],
        ['a new invite goes first', [X, OLD], NEWER, ['INV-NEW2', 'INV-XXXX', 'INV-OLD1']],
        ['the same invite as listed first: replaced, not added', [X, OLD], ANSWER_X, ['INV-XXXX', 'INV-OLD1']],
        ['the same invite listed further down: replaced where it stands', [NEWER, X, OLD], ANSWER_X, ['INV-NEW2', 'INV-XXXX', 'INV-OLD1']],
        ['the same invite in another case: still one row', [NEWER, { ...X, code: 'inv-xxxx' }], ANSWER_X, ['INV-NEW2', 'INV-XXXX']],
        ['a list that somehow held it twice: once after', [X, OLD, X], ANSWER_X, ['INV-XXXX', 'INV-OLD1']],
    ];

    it.each(TABLE)('%s', (_name, list, invite, codes) => {
        const before = structuredClone(list);
        const out = listWithInvite(list, invite);
        expect(out.map((r) => r.code), 'codes in order').toEqual(codes);
        expect(new Set(out.map((r) => r.code.toLowerCase())).size, 'each code once').toBe(out.length);
        expect(out.find((r) => r.code === invite.code), 'the answer is the row').toMatchObject(invite);
        expect(list, 'the list it was given is left as it was').toEqual(before);
    });

    it('a replaced row keeps what only the list knew (its expiry) and takes the answer\'s bill', () => {
        const [row] = listWithInvite([X], ANSWER_X);
        expect(row).toEqual({ ...X, bill: ANSWER_X.bill });
    });

    it('the same answer again and again: still one row', () => {
        let list: Row[] = [OLD];
        for (let i = 0; i < 3; i++) list = listWithInvite(list, ANSWER_X);
        expect(list.map((r) => r.code)).toEqual(['INV-XXXX', 'INV-OLD1']);
    });
});
