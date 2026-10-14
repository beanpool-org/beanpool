/**
 * The two doors in the web app's door library (two-doors design §2 to §4, slice S5): every refusal the door gives (PR
 * #1425's codes) is a sentence a member can act on, with the node's `Retry-After` said as "Try again in N minutes"; the
 * work route's answers are read as the node gives them; the bodies carry what the node expects and nothing else; and
 * the name check is signed by the joining key, so the node counts it against the door's limiter for that key. The node
 * is a stubbed fetch; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    checkCallsign,
    doorOutcome,
    doorRefusalMessage,
    joinBody,
    requestDoorWork,
    retryAfterOf,
    tryAgainIn,
    withRetryAfter,
    wordsJoinBody,
    wordsWorkRefusal,
    type DoorAnswer,
} from './web-join';
import { generateIdentity, isDefiniteJoinRefusal, type BeanPoolIdentity } from './identity';

function answer(status: number, body: Record<string, unknown>, retryAfterSeconds: number | null = null): DoorAnswer {
    return { status, body, retryAfterSeconds };
}

// The node's own sentences (apps/server/src/routes/open-join.ts), as #1425 words them.
const WORDS_CEILING = 'A very large number of 12-words accounts were made from your network in the last hour. Sign in to join now, or try again in about 12 minutes.';
const SIGN_IN_CEILING = 'Too many new accounts have joined from your network in the last hour. Please try again later.';
const WORK_REQUIRED = 'Lots of people have joined from your network lately, so joining here now takes a moment of setting up on your phone first, which this version of the app can\'t do. Please update the BeanPool app, or try again later.';

describe('Retry-After, said as a wait', () => {
    it('read from the header (seconds or a date), else the body', () => {
        expect(retryAfterOf('600')).toBe(600);
        expect(retryAfterOf(new Date(1_000_000 + 90_000).toUTCString(), {}, 1_000_000)).toBe(90);
        expect(retryAfterOf(null, { retryAfterSeconds: 42.2 })).toBe(43);
        expect(retryAfterOf('soon', {})).toBeNull();
        expect(retryAfterOf(undefined)).toBeNull();
    });

    it('"Try again in N minutes": whole minutes, at least one; hours past ninety minutes', () => {
        expect(tryAgainIn(5)).toBe('Try again in 1 minute.');
        expect(tryAgainIn(600)).toBe('Try again in 10 minutes.');
        expect(tryAgainIn(601)).toBe('Try again in 11 minutes.');
        expect(tryAgainIn(90 * 60)).toBe('Try again in 90 minutes.');
        expect(tryAgainIn(3 * 3600)).toBe('Try again in about 3 hours.');
    });

    it('replaces "Please try again later." when the node named the wait, and leaves a sentence that already says when', () => {
        expect(withRetryAfter(SIGN_IN_CEILING, 1200)).toBe('Too many new accounts have joined from your network in the last hour. Try again in 20 minutes.');
        expect(withRetryAfter(WORDS_CEILING, 720)).toBe(WORDS_CEILING);
        expect(withRetryAfter('Busy.', 60)).toBe('Busy. Try again in 1 minute.');
        expect(withRetryAfter(SIGN_IN_CEILING, null)).toBe(SIGN_IN_CEILING);
    });
});

describe('every refusal of a join as a sentence (doorOutcome)', () => {
    it('the 12-words ceiling: the node\'s sentence, which says when and that a sign-in works now', () => {
        expect(doorOutcome(answer(429, { error: WORDS_CEILING, code: 'network_busy', door: 'words' }, 720), null))
            .toEqual({ kind: 'rate_limited', message: WORDS_CEILING });
    });

    it('the sign-in ceiling: Retry-After becomes "Try again in N minutes"', () => {
        expect(doorOutcome(answer(429, { error: SIGN_IN_CEILING, code: 'network_busy', door: 'sign-in' }, 1500), 'google'))
            .toEqual({ kind: 'rate_limited', message: 'Too many new accounts have joined from your network in the last hour. Try again in 25 minutes.' });
    });

    it("the door's limiter (no code, the node's terse text): a plain sentence with the wait", () => {
        expect(doorOutcome(answer(429, { error: 'Too many attempts. Try again in 42s' }, 42), null))
            .toEqual({ kind: 'rate_limited', message: 'Too many tries from this network just now. Try again in 1 minute.' });
    });

    it('the work refusals: new work, and only the second time a sentence, never "update the app" in a browser', () => {
        expect(doorOutcome(answer(400, { error: WORK_REQUIRED, code: 'work_required' }), 'google'))
            .toEqual({ kind: 'work', code: 'work_required', message: "Setting up your account didn't work out. Please try again." });
        for (const code of ['work_invalid', 'work_expired', 'work_spent'] as const) {
            const out = doorOutcome(answer(400, { error: `the node's words for ${code}`, code }), null);
            expect(out).toEqual({ kind: 'work', code, message: `the node's words for ${code}` });
        }
    });

    it('the 12-words door shut here: the sign-in is the way in', () => {
        expect(doorOutcome(answer(403, { error: 'This community needs a sign-in to join: Google, Apple or Facebook.', code: 'sign_in_required' }), null))
            .toEqual({ kind: 'sign_in_required', message: 'This community needs a sign-in to join: Google, Apple or Facebook.' });
    });

    it('the rest keep their sentences: removed, a replaced key, the door key missing, the door shut, a sign-in already used', () => {
        expect(doorOutcome(answer(403, { error: 'The BeanPool identity this Google account joined with was removed from this community, so it can\'t join again.', code: 'removed' }), 'google'))
            .toMatchObject({ kind: 'refused', message: expect.stringMatching(/was removed from this community/) });
        expect(doorOutcome(answer(403, { error: 'This key was replaced by a new one, so it can\'t join.', code: 'key_invalidated' }), null))
            .toMatchObject({ kind: 'refused', message: expect.stringMatching(/replaced by a new one/) });
        expect(doorOutcome(answer(503, { error: 'This community can\'t check sign-ins right now, so it isn\'t taking new members this way.', code: 'door_key_missing' }), 'apple'))
            .toMatchObject({ kind: 'unavailable', message: expect.stringMatching(/can't check sign-ins right now/) });
        expect(doorOutcome(answer(503, {}), null)).toEqual({ kind: 'unavailable', message: "The community couldn't take your join right now. Please try again in a minute." });
        expect(doorOutcome(answer(404, { code: 'invite_only' }), null)).toEqual({ kind: 'door_closed', message: "This community isn't taking new members right now." });
        expect(doorOutcome(answer(409, { code: 'already_joined' }), 'facebook')).toMatchObject({ kind: 'already_joined', message: expect.stringMatching(/^This Facebook account already has a BeanPool identity here/) });
        // A 401 to a 12-words join is no expired sign-in: there was none.
        expect(doorOutcome(answer(401, { error: 'This request must be signed by the key you are joining with.' }), null).kind).toBe('refused');
        expect(doorOutcome(answer(401, { code: 'sign_in' }), 'google').kind).toBe('expired');
    });

    it("the new refusals are definite (given before the node writes a member), so a refused key's sent mark can be let go", () => {
        expect(isDefiniteJoinRefusal('network_busy', 429)).toBe(true);
        for (const code of ['work_required', 'work_invalid', 'work_expired', 'work_spent']) expect(isDefiniteJoinRefusal(code, 400)).toBe(true);
        expect(isDefiniteJoinRefusal('sign_in_required', 403)).toBe(true);
        // Only with their own status: a code under another is not the door's answer.
        expect(isDefiniteJoinRefusal('network_busy', 503)).toBe(false);
        expect(isDefiniteJoinRefusal('work_expired', 500)).toBe(false);
        // A 5xx is never definite: the node may have written the member.
        expect(isDefiniteJoinRefusal('join_failed', 503)).toBe(false);
        expect(isDefiniteJoinRefusal('door_key_missing', 503)).toBe(false);
    });

    it("the nonce request's 429 is said the same way", () => {
        expect(doorRefusalMessage(answer(429, { error: 'Too many attempts. Try again in 30s' }, 30))).toBe('Too many tries from this network just now. Try again in 1 minute.');
    });

    it("the work route's refusals for the 12 words: busy (the sign-in still open), shut here, or as the node said", () => {
        expect(wordsWorkRefusal(answer(429, { error: WORDS_CEILING, code: 'network_busy' }, 720))).toEqual({ kind: 'busy', message: WORDS_CEILING });
        expect(wordsWorkRefusal(answer(403, { error: 'This community needs a sign-in to join: Google, Apple or Facebook.', code: 'sign_in_required' })).kind).toBe('closed');
        expect(wordsWorkRefusal(answer(404, { code: 'invite_only' })).kind).toBe('closed');
        expect(wordsWorkRefusal(answer(409, { error: 'This key is already a member of this community.', code: 'already_member' })))
            .toEqual({ kind: 'failed', message: 'This key is already a member of this community.' });
    });
});

describe('the bodies', () => {
    const work = { challenge: 'v1.0.1.aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', counters: [1, 2, 3, 4, 5, 6, 7, 8] };

    it('a 12-words join: the door, the name and the work; no provider, token, nonce, recovery or ticket', () => {
        expect(wordsJoinBody('Bea', work)).toEqual({ door: 'words', callsign: 'Bea', work });
    });

    it('a sign-in join carries work only when the node asked for some', () => {
        const proof = { provider: 'google' as const, idToken: 't', nonce: 'n', sub: 's' };
        expect(joinBody('Bea', proof)).toEqual({ callsign: 'Bea', provider: 'google', idToken: 't', nonce: 'n' });
        expect(joinBody('Bea', proof, undefined, work)).toEqual({ callsign: 'Bea', provider: 'google', idToken: 't', nonce: 'n', work });
        // `sub` is never sent: the node takes it from the verified token.
        expect(JSON.stringify(joinBody('Bea', proof, undefined, work))).not.toContain('"sub"');
    });
});

describe('asking for work (POST /api/join/work)', () => {
    let identity: BeanPoolIdentity;
    beforeEach(async () => { identity = await generateIdentity('Bea'); });
    afterEach(() => { vi.unstubAllGlobals(); });

    function stub(status: number, body: unknown, headers: Record<string, string> = {}) {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url: String(url), init });
            return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
        }));
        return calls;
    }

    it('signed by the joining key, naming the door; the challenge with when it runs out by this clock', async () => {
        const calls = stub(200, { work: { challenge: 'v1.c', level: 2, parts: 8, bits: 9, size: 65536, expiresInSeconds: 600 }, turnstile: null });
        const got = await requestDoorWork(identity, 'words', () => 1_000);
        expect(got).toEqual({ kind: 'work', work: { challenge: 'v1.c', level: 2, parts: 8, bits: 9, expiresAt: 1_000 + 600_000 } });
        expect(calls[0].url).toMatch(/\/api\/join\/work$/);
        expect(JSON.parse(String(calls[0].init.body))).toEqual({ door: 'words' });
        expect((calls[0].init.headers as Record<string, string>)['X-Public-Key']).toBe(identity.publicKey);
    });

    it('`work: null` (a sign-in at ordinary rates) and a node from before the work need none', async () => {
        stub(200, { work: null, turnstile: null });
        expect(await requestDoorWork(identity, 'sign-in')).toEqual({ kind: 'none' });
        stub(404, { error: 'Not Found' });
        expect(await requestDoorWork(identity, 'sign-in')).toEqual({ kind: 'none' });
    });

    it('a refusal keeps its answer, with its Retry-After', async () => {
        stub(429, { error: WORDS_CEILING, code: 'network_busy' }, { 'Retry-After': '720' });
        const got = await requestDoorWork(identity, 'words');
        expect(got).toEqual({ kind: 'refused', answer: { status: 429, body: { error: WORDS_CEILING, code: 'network_busy' }, retryAfterSeconds: 720 } });
        stub(404, { error: 'This community is invite-only.', code: 'invite_only' });
        expect((await requestDoorWork(identity, 'words')).kind).toBe('refused');
    });
});

describe('the name check, signed by the joining key (design §4.4)', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('with a joining key: signed by it, so the door limiter counts it per key; without one: unsigned, as before', async () => {
        const seen: Array<Record<string, string>> = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
            seen.push((init.headers ?? {}) as Record<string, string>);
            return new Response(JSON.stringify({ available: true }), { status: 200 });
        }));
        const joining = await generateIdentity('');
        expect(await checkCallsign('Bea', undefined, joining)).toBe('available');
        expect(seen[0]['X-Public-Key']).toBe(joining.publicKey);
        expect(seen[0]['X-Signature']).toBeTruthy();
        expect(await checkCallsign('Bea')).toBe('available');
        expect(seen[1]['X-Public-Key']).toBeUndefined();
    });
});
