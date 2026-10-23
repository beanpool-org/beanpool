import { describe, it, expect } from 'vitest';
import { requestModeOf, requestAfterRead, requestAfterOwnLine, decisionFailureWords, requestPendingRefusal } from './dm-requests';

// The rules lib/dm-requests.ts reads from the node's answers (PR #2392 at 7d20c62d; shapes as its routes give them).

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const AT = '2026-10-23T01:31:26.627Z';
const dm = (request: unknown) => ({ type: 'dm' as const, request: request as never });
const lineBy = (who: string, timestamp: string, type: 'text' | 'image' | 'system' = 'text') => ({ authorPubkey: who, timestamp, type });

describe('requestModeOf', () => {
    it('an ordinary chat: no request, null, accepted, or not a DM', () => {
        expect(requestModeOf(dm(undefined), ME, [])).toBe('none');
        expect(requestModeOf(dm(null), ME, [])).toBe('none');
        expect(requestModeOf(dm({ state: 'accepted', from: PEER, at: AT }), ME, [])).toBe('none');
        expect(requestModeOf({ type: 'group_thread', request: { state: 'pending', from: PEER, at: AT } } as never, ME, [])).toBe('none');
        expect(requestModeOf(null, ME, [])).toBe('none');
    });

    it('someone else\'s request is the reader\'s to decide, whatever state it names', () => {
        for (const state of ['pending', 'ignored', 'expired']) expect(requestModeOf(dm({ state, from: PEER, at: AT }), ME, [])).toBe('to-me');
    });

    it('the reader\'s own: waiting once their line is in it, at or after the request was made', () => {
        const mine = dm({ state: 'pending', from: ME, at: AT });
        expect(requestModeOf(mine, ME, [])).toBe('mine-unsent');
        expect(requestModeOf(mine, ME, [lineBy(ME, '2026-10-23T01:31:26.000Z')])).toBe('mine-unsent');   // before it: an older line
        expect(requestModeOf(mine, ME, [lineBy(PEER, '2026-10-23T01:32:00.000Z')])).toBe('mine-unsent');  // not theirs
        expect(requestModeOf(mine, ME, [lineBy(ME, AT, 'system')])).toBe('mine-unsent');                  // a node notice
        expect(requestModeOf(mine, ME, [lineBy(ME, AT)])).toBe('mine-waiting');
        expect(requestModeOf(mine, ME, [lineBy(ME, '2026-10-23T01:31:26.628Z', 'image')])).toBe('mine-waiting');
    });

    it('where the node says whether the reader\'s next line is the request (nextLineIsRequest), its count, not the page\'s', () => {
        // A block lifted (PR #2404 review 4356625513): the line kept for the reader during it is in their read, and never
        // reached the other person, so the node doesn't count it and takes their next line as the request.
        const lifted = dm({ state: 'pending', from: ME, at: AT, nextLineIsRequest: true });
        expect(requestModeOf(lifted, ME, [lineBy(ME, AT)])).toBe('mine-unsent');
        expect(requestModeOf(dm({ state: 'pending', from: ME, at: AT, nextLineIsRequest: false }), ME, [lineBy(ME, AT)])).toBe('mine-waiting');
        expect(requestModeOf(dm({ state: 'pending', from: ME, at: AT, nextLineIsRequest: false }), ME, [])).toBe('mine-waiting');
        expect(requestModeOf(dm({ state: 'pending', from: ME, at: AT, nextLineIsRequest: true }), ME, [])).toBe('mine-unsent');
        // Not known until this chat's lines are read, as before; and the rest never depend on it.
        expect(requestModeOf(lifted, ME, null)).toBe('mine-loading');
        expect(requestModeOf(dm({ state: 'accepted', from: ME, at: AT, nextLineIsRequest: true }), ME, [])).toBe('none');
        expect(requestModeOf(dm({ state: 'pending', from: PEER, at: AT, nextLineIsRequest: true }), ME, [])).toBe('to-me');
    });

    it('30 days on (expired), the reader\'s next line is a new request', () => {
        expect(requestModeOf(dm({ state: 'expired', from: ME, at: AT }), ME, [lineBy(ME, AT)])).toBe('mine-unsent');
    });

    it('the reader\'s own waiting request, before this chat\'s lines are read (null): not known yet, never "unsent"', () => {
        expect(requestModeOf(dm({ state: 'pending', from: ME, at: AT }), ME, null)).toBe('mine-loading');
        // The rest never depend on the lines.
        expect(requestModeOf(dm({ state: 'expired', from: ME, at: AT }), ME, null)).toBe('mine-unsent');
        expect(requestModeOf(dm({ state: 'pending', from: PEER, at: AT }), ME, null)).toBe('to-me');
        expect(requestModeOf(dm({ state: 'accepted', from: ME, at: AT }), ME, null)).toBe('none');
        expect(requestModeOf(dm(null), ME, null)).toBe('none');
    });
});

describe('requestAfterRead', () => {
    const accepted = { state: 'accepted' as const, from: PEER, at: AT };
    it('takes the node\'s read, and none when it names none (requests off)', () => {
        expect(requestAfterRead({ state: 'pending', from: PEER, at: AT }, { request: accepted })).toEqual(accepted);
        expect(requestAfterRead({ state: 'pending', from: PEER, at: AT }, {})).toBeNull();
        expect(requestAfterRead(accepted, { request: null })).toBeNull();
    });
    it('an acceptance isn\'t undone by a read of the same request still naming it waiting', () => {
        expect(requestAfterRead(accepted, { request: { state: 'pending', from: PEER, at: AT } })).toEqual(accepted);
        // Another request (another time): the node's.
        const fresh = { state: 'pending' as const, from: PEER, at: '2026-11-30T00:00:00.000Z' };
        expect(requestAfterRead(accepted, { request: fresh })).toEqual(fresh);
    });
});

describe('requestAfterOwnLine', () => {
    it('the node took the reader\'s line where it said the next was the request: the next one is not', () => {
        expect(requestAfterOwnLine({ state: 'pending', from: ME, at: AT, nextLineIsRequest: true }, ME))
            .toEqual({ state: 'pending', from: ME, at: AT, nextLineIsRequest: false });
    });
    it('anything else as it was: someone else\'s, accepted, expired, or a node that doesn\'t say', () => {
        for (const r of [
            { state: 'pending' as const, from: PEER, at: AT, nextLineIsRequest: true },
            { state: 'accepted' as const, from: ME, at: AT, nextLineIsRequest: true },
            { state: 'expired' as const, from: ME, at: AT, nextLineIsRequest: true },
            { state: 'pending' as const, from: ME, at: AT },
            { state: 'pending' as const, from: ME, at: AT, nextLineIsRequest: false },
        ]) expect(requestAfterOwnLine(r, ME)).toBe(r);
        expect(requestAfterOwnLine(null, ME)).toBeNull();
        expect(requestAfterOwnLine(undefined, ME)).toBeUndefined();
    });
});

describe('the words when a decision fails', () => {
    it('no answer, or a page that was not the node\'s: the offline sentence', () => {
        expect(decisionFailureWords(new TypeError('Failed to fetch'))).toBe('Connect to your community to accept or ignore.');
        expect(decisionFailureWords(Object.assign(new Error('Bad Gateway'), { status: 502, unsaid: true }))).toBe('Connect to your community to accept or ignore.');
        expect(decisionFailureWords(null)).toBe('Connect to your community to accept or ignore.');
    });
    it('the node\'s refusal: its own words', () => {
        const gone = Object.assign(new Error('There is no message request for you in this chat.'), { status: 404, code: 'request_not_found' });
        expect(decisionFailureWords(gone)).toBe('There is no message request for you in this chat.');
    });
    it('only a waiting request\'s refusal is one (403 dm_request_pending)', () => {
        const words = 'Your first message is waiting for Ann. You can write more once they accept it.';
        expect(requestPendingRefusal(Object.assign(new Error(words), { status: 403, code: 'dm_request_pending' }))).toBe(words);
        expect(requestPendingRefusal(Object.assign(new Error('Muted'), { status: 403, code: 'moderation_muted' }))).toBeNull();
        expect(requestPendingRefusal(new Error(words))).toBeNull();
    });
});
