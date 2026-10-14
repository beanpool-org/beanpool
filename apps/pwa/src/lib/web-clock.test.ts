/**
 * A wrong clock at the web door (matches the phone's `phone_clock`, PR #1452): the node refuses a signed request whose
 * timestamp is more than 5 minutes off with a 401 and no code. For a 12-words join, the browser-side links, and a
 * restore, nobody can act on a "sign in again" or the node's raw "Request timestamp is stale or invalid": the
 * sentence says to check this device's date and time. The node is a stubbed fetch; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { door, doorOutcome, joinVerdict, requestDoorWork, wordsWorkRefusal, WRONG_CLOCK } from './web-join';
import { requestLinkNonce, linkRefusalMessage } from './link-signin';
import { makeEphemeralKey, openRestoreSession, releaseRefusalMessage, sessionRefusalMessage } from './web-restore';
import { generateIdentity, type BeanPoolIdentity } from './identity';

const STALE = { error: 'Request timestamp is stale or invalid' };

function stub401(body: unknown = STALE) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 401, headers: { 'Content-Type': 'application/json' } })));
}

function expectClockSentence(text: string) {
    expect(text).toMatch(/date and time/);
    expect(text).toMatch(/this device/i);
    expect(text).not.toMatch(/sign in again|sign-in again|timestamp/i);
}

describe('a wrong clock, said at the web door', () => {
    let identity: BeanPoolIdentity;
    beforeEach(async () => { identity = await generateIdentity('Bea'); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('the sentence names the date and time, in the phone\'s words, and never says sign in again', () => {
        expectClockSentence(WRONG_CLOCK);
        expect(WRONG_CLOCK).toBe("The community couldn't accept this because this device's date and time look wrong. Check them in this device's settings (set them to automatic), then try again.");
    });

    it('the work route: a 401 with no code is the clock', async () => {
        stub401();
        const got = await requestDoorWork(identity, 'words');
        expect(got.kind).toBe('refused');
        if (got.kind !== 'refused') return;
        expect(wordsWorkRefusal(got.answer)).toEqual({ kind: 'failed', message: WRONG_CLOCK });
    });

    it('the 12-words join: a 401 with no code is the clock, whatever the node worded', async () => {
        stub401();
        const answer = await door('POST', '/api/join', { door: 'words', callsign: 'Bea' }, identity);
        const out = doorOutcome(answer, null);
        expect(out).toEqual({ kind: 'refused', message: WRONG_CLOCK });
        const verdict = joinVerdict(answer, { identity, sentAt: Date.now() }, null);
        expect(verdict.kind).toBe('unknown');
        expect((verdict as { outcome: { message: string } }).outcome).toEqual(out);
    });

    it('a sign-in join keeps its own 401 (the sign-in expired, with a code); a coded 401 without a provider is not the clock', () => {
        expect(doorOutcome({ status: 401, body: { code: 'sign_in', error: 'x' } }, 'google').kind).toBe('expired');
        expect(doorOutcome({ status: 401, body: { code: 'ticket_used', error: 'That ticket was used.' } }, null))
            .toEqual({ kind: 'refused', message: 'That ticket was used.' });
    });

    it('adding a sign-in: the nonce request and the link both say the clock', async () => {
        stub401();
        expect(await requestLinkNonce(identity)).toEqual({ message: WRONG_CLOCK });
        expect(linkRefusalMessage({ status: 401, body: STALE }, 'google')).toBe(WRONG_CLOCK);
        // The sign-in's own 401 (a code) is still the sign-in's.
        expect(linkRefusalMessage({ status: 401, body: { code: 'sign_in', error: 'x' } }, 'google')).toBe("Google couldn't confirm that sign-in. Try again.");
    });

    it('restoring: opening the session, and releasing the copy, say the clock', async () => {
        stub401();
        const eph = makeEphemeralKey();
        const opened = await openRestoreSession(eph, 'Bea');
        expect('answer' in opened).toBe(true);
        if (!('answer' in opened)) return;
        expect(sessionRefusalMessage(opened.answer, 'Bea')).toBe(WRONG_CLOCK);
        expect(releaseRefusalMessage(opened.answer, 'google', 'Bea')).toBe(WRONG_CLOCK);
        // A sign-in's own 401 keeps its sentence.
        expect(releaseRefusalMessage({ status: 401, body: { code: 'sign_in', error: 'x' } }, 'google', 'Bea'))
            .toBe("Google sign-in couldn't be checked or took too long. Try again.");
    });
});
