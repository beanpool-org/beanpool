/**
 * The phone's Invite people sheet says a refusal in the node's words (review of #1979, N2): a suspended convenor's 403
 * won't pass "when you have signal". Same rule as the web's lib/group-invite.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { inviteRefusalWords, sendGroupInvitations } from '../group-invite-send';

const SUSPENDED = 'UNAUTHORIZED: Your account is suspended, so you cannot act as a convenor until the suspension ends. You are still a convenor.';

describe('inviteRefusalWords', () => {
    it("a 403 is said in the node's words, UNAUTHORIZED taken off", () => {
        expect(inviteRefusalWords(Object.assign(new Error(SUSPENDED), { status: 403 })))
            .toBe('Your account is suspended, so you cannot act as a convenor until the suspension ends. You are still a convenor.');
    });
    it("a blip, a server fault, an error with no status, or a 403 with no words of the node's own say nothing", () => {
        expect(inviteRefusalWords(new Error('Network request failed'))).toBeNull();
        expect(inviteRefusalWords(Object.assign(new Error('Busy'), { status: 503 }))).toBeNull();
        expect(inviteRefusalWords(Object.assign(new Error('Request failed: 403'), { status: 403, unsaid: true }))).toBeNull();
        expect(inviteRefusalWords(new Error(SUSPENDED))).toBeNull();
        expect(inviteRefusalWords(null)).toBeNull();
    });
});

describe('sendGroupInvitations', () => {
    it('one call per person, four at a time; who failed and the first refusal come back', async () => {
        let inFlight = 0, most = 0;
        const invite = vi.fn(async (pk: string) => {
            inFlight++; most = Math.max(most, inFlight);
            await new Promise(r => setTimeout(r, 1));
            inFlight--;
            if (pk === 'p2') throw new Error('Network request failed');
            if (pk === 'p5') throw Object.assign(new Error(SUSPENDED), { status: 403 });
        });
        const res = await sendGroupInvitations(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], invite);
        expect(invite.mock.calls.map(c => c[0])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
        expect(most).toBeLessThanOrEqual(4);
        expect(res.sent).toEqual(['p1', 'p3', 'p4', 'p6']);
        expect(res.failed).toEqual(['p2', 'p5']);
        expect(res.refusal).toBe('Your account is suspended, so you cannot act as a convenor until the suspension ends. You are still a convenor.');
    });
    it('only blips: no refusal, so the sheet says "Try again when you have signal"', async () => {
        const res = await sendGroupInvitations(['a'], async () => { throw new Error('Network request failed'); });
        expect(res).toEqual({ sent: [], failed: ['a'], refusal: null });
    });
});
