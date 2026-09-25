/**
 * Joining in a browser (design G11-b): the requests to the providers, the return page's parser, the GitHub wait, and
 * what each door answer turns into. No provider and no node is contacted: the door is a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    appleAuthUrl,
    captureAuthReturn,
    checkMembershipWithKey,
    checkSentJoin,
    consumeCapturedAuthReturn,
    doorOutcome,
    DOOR_TIMEOUT_MS,
    DoorUnreachableError,
    facebookAuthUrl,
    googleAuthUrl,
    joinBody,
    joinVerdict,
    jwtClaims,
    matchAuthReturn,
    offeredProviders,
    parseRetryAfter,
    probeMembership,
    readAuthReturn,
    refusalMessage,
    requestJoinNonce,
    resetCapturedAuthReturn,
    runGithubPoll,
    startGithubJoin,
    submitJoin,
    SENT_JOIN_CAN_LAND_MS,
    type DoorAnswer,
    type JoinNonce,
} from './web-join';
import { PENDING_JOIN_TTL_MS, type BeanPoolIdentity, type PendingJoin } from './identity';

const NONCE = 'n0nce-Abc_123-xyz';
const ORIGIN = 'https://global.beanpool.org';

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A token in the shape providers send. Unsigned: the page never verifies, the node does. */
function fakeJwt(claims: Record<string, unknown>): string {
    return `${b64url(JSON.stringify({ alg: 'RS256', kid: 'k1' }))}.${b64url(JSON.stringify(claims))}.c2lnbmF0dXJl`;
}

function params(url: string): URLSearchParams {
    return new URL(url).searchParams;
}

describe('the requests to the providers (design §3)', () => {
    it('Google: our Web client, id_token, openid email, nonce and state are the node\'s nonce, back to /app/auth/google', () => {
        const url = googleAuthUrl({ clientId: 'web-client.apps.googleusercontent.com', origin: ORIGIN, nonce: NONCE });
        expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
        const p = params(url);
        expect(Object.fromEntries(p)).toEqual({
            client_id: 'web-client.apps.googleusercontent.com',
            redirect_uri: 'https://global.beanpool.org/app/auth/google',
            response_type: 'id_token',
            scope: 'openid email',
            nonce: NONCE,
            state: NONCE,
            prompt: 'select_account',
        });
        expect(p.get('state')).toBe(p.get('nonce'));
    });

    it('Apple: the Services ID, code id_token by form_post, no scope at all', () => {
        const url = appleAuthUrl({ clientId: 'org.beanpool.web', origin: ORIGIN, nonce: NONCE });
        expect(url.startsWith('https://appleid.apple.com/auth/authorize?')).toBe(true);
        const p = params(url);
        expect(Object.fromEntries(p)).toEqual({
            client_id: 'org.beanpool.web',
            redirect_uri: 'https://global.beanpool.org/app/auth/apple',
            response_type: 'code id_token',
            response_mode: 'form_post',
            nonce: NONCE,
            state: NONCE,
        });
        expect(p.has('scope')).toBe(false);
        expect(url).not.toContain('scope');
    });

    it('Facebook: the measured request, token,id_token with openid,email, nonce === state', () => {
        const url = facebookAuthUrl({ clientId: '818892721251369', origin: ORIGIN, nonce: NONCE });
        expect(url.startsWith('https://www.facebook.com/v20.0/dialog/oauth?')).toBe(true);
        expect(url).toContain('&response_type=token,id_token&scope=openid,email');
        const p = params(url);
        expect(Object.fromEntries(p)).toEqual({
            client_id: '818892721251369',
            redirect_uri: 'https://global.beanpool.org/app/auth/facebook',
            response_type: 'token,id_token',
            scope: 'openid,email',
            nonce: NONCE,
            state: NONCE,
        });
    });

    it('the nonce is carried exactly, whatever characters it has', () => {
        const odd = 'a+b/c=d&e f';
        for (const url of [googleAuthUrl, appleAuthUrl, facebookAuthUrl].map((f) => f({ clientId: 'x', origin: ORIGIN, nonce: odd }))) {
            expect(params(url).get('nonce')).toBe(odd);
            expect(params(url).get('state')).toBe(odd);
        }
    });
});

describe('the return parser (design §2 screen 4, §5.2)', () => {
    const expect_ = { provider: 'google' as const, nonce: NONCE };
    const token = fakeJwt({ iss: 'https://accounts.google.com', aud: 'web', sub: 'g-sub-1', nonce: NONCE, email: 'a@example.com' });

    it('reads the fragment only: a token in the query string is never read', () => {
        const ret = readAuthReturn('/app/auth/google', '')!;
        expect(ret).toEqual({ provider: 'google', state: null, idToken: null, error: null, errorDescription: null });
        // The same values in a query and nothing in the fragment: nothing to send.
        const url = new URL(`${ORIGIN}/app/auth/google?state=${NONCE}&id_token=${token}`);
        const fromQuery = readAuthReturn(url.pathname, url.hash)!;
        expect(fromQuery.idToken).toBeNull();
        expect(matchAuthReturn(fromQuery, expect_)).toEqual({ kind: 'refused', reason: 'no_state' });
    });

    it('is nothing on a page that is not a return', () => {
        expect(readAuthReturn('/app', `#state=${NONCE}&id_token=${token}`)).toBeNull();
        expect(readAuthReturn('/', '')).toBeNull();
    });

    it('a matching Google return gives the token, the nonce and the sub', () => {
        const ret = readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${token}&authuser=0&prompt=consent`)!;
        expect(matchAuthReturn(ret, expect_)).toEqual({ kind: 'token', provider: 'google', idToken: token, nonce: NONCE, sub: 'g-sub-1' });
    });

    it('refuses a return with no state', () => {
        const ret = readAuthReturn('/app/auth/google', `#id_token=${token}`)!;
        expect(matchAuthReturn(ret, expect_)).toEqual({ kind: 'refused', reason: 'no_state' });
    });

    it("refuses a foreign state: another tab's, an old one, or a crafted link", () => {
        const ret = readAuthReturn('/app/auth/google', `#state=someone-elses&id_token=${token}`)!;
        expect(matchAuthReturn(ret, expect_)).toEqual({ kind: 'refused', reason: 'foreign_state' });
        expect(refusalMessage('foreign_state', 'google')).toBe("That sign-in wasn't started here. Start again.");
    });

    it('refuses a return when nothing is pending', () => {
        const ret = readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${token}`)!;
        expect(matchAuthReturn(ret, null)).toEqual({ kind: 'refused', reason: 'no_pending' });
        expect(matchAuthReturn(ret, { provider: 'google', nonce: null })).toEqual({ kind: 'refused', reason: 'no_pending' });
    });

    it('refuses the wrong provider: the path must name the sign-in that was started', () => {
        const ret = readAuthReturn('/app/auth/apple', `#state=${NONCE}&id_token=${token}`)!;
        expect(matchAuthReturn(ret, expect_)).toEqual({ kind: 'refused', reason: 'wrong_provider' });
        const unknown = readAuthReturn('/app/auth/twitter', `#state=${NONCE}&id_token=${token}`)!;
        expect(unknown.provider).toBeNull();
        expect(matchAuthReturn(unknown, expect_)).toEqual({ kind: 'refused', reason: 'wrong_provider' });
    });

    it('refuses an access-token-only return: the node cannot check one without a secret', () => {
        const ret = readAuthReturn('/app/auth/facebook', `#access_token=EAAB-secret&expires_in=5000&state=${NONCE}`)!;
        expect(ret).not.toHaveProperty('accessToken');
        expect(JSON.stringify(ret)).not.toContain('EAAB-secret');
        expect(matchAuthReturn(ret, { provider: 'facebook', nonce: NONCE })).toEqual({ kind: 'refused', reason: 'no_id_token' });
    });

    it("Facebook's access and long-lived tokens beside the id_token are never read", () => {
        const fb = fakeJwt({ iss: 'https://www.facebook.com', aud: '818892721251369', sub: 'fb-sub', nonce: NONCE });
        const ret = readAuthReturn('/app/auth/facebook',
            `#access_token=EAAB-secret&data_access_expiration_time=1&expires_in=5000&id_token=${fb}&long_lived_token=LL-secret&state=${NONCE}`)!;
        const outcome = matchAuthReturn(ret, { provider: 'facebook', nonce: NONCE });
        expect(outcome).toEqual({ kind: 'token', provider: 'facebook', idToken: fb, nonce: NONCE, sub: 'fb-sub' });
        const kept = JSON.stringify([ret, outcome, joinBody('Alice', outcome as never)]);
        expect(kept).not.toContain('EAAB-secret');
        expect(kept).not.toContain('LL-secret');
    });

    it("refuses a token whose nonce claim is not this attempt's", () => {
        const other = fakeJwt({ sub: 'g-sub-1', nonce: 'a-different-nonce' });
        const ret = readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${other}`)!;
        expect(matchAuthReturn(ret, expect_)).toEqual({ kind: 'refused', reason: 'nonce_mismatch' });
        const none = fakeJwt({ sub: 'g-sub-1' });
        expect(matchAuthReturn(readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${none}`)!, expect_))
            .toEqual({ kind: 'refused', reason: 'nonce_mismatch' });
    });

    it("Google's nonce must be verbatim; Apple's may be its SHA-256, as the node allows", () => {
        const hashed = bytesToHex(sha256(utf8ToBytes(NONCE)));
        const g = readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${fakeJwt({ sub: 's', nonce: hashed })}`)!;
        expect(matchAuthReturn(g, expect_)).toEqual({ kind: 'refused', reason: 'nonce_mismatch' });
        const a = readAuthReturn('/app/auth/apple', `#state=${NONCE}&id_token=${fakeJwt({ sub: 'apple-sub', nonce: hashed })}`)!;
        expect(matchAuthReturn(a, { provider: 'apple', nonce: NONCE })).toMatchObject({ kind: 'token', sub: 'apple-sub' });
    });

    it('refuses what is not a token, and a token with no subject', () => {
        const junk = readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=not-a-jwt`)!;
        expect(matchAuthReturn(junk, expect_)).toEqual({ kind: 'refused', reason: 'not_a_token' });
        const noSub = readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${fakeJwt({ nonce: NONCE })}`)!;
        expect(matchAuthReturn(noSub, expect_)).toEqual({ kind: 'refused', reason: 'no_subject' });
        expect(jwtClaims('a.b')).toBeNull();
    });

    it('a cancel is quiet; any other provider error is shown as capped text', () => {
        const cancel = readAuthReturn('/app/auth/apple', `#state=${NONCE}&error=user_cancelled_authorize`)!;
        expect(matchAuthReturn(cancel, { provider: 'apple', nonce: NONCE })).toEqual({ kind: 'cancelled', provider: 'apple' });
        const denied = readAuthReturn('/app/auth/google', `#state=${NONCE}&error=access_denied`)!;
        expect(matchAuthReturn(denied, expect_)).toEqual({ kind: 'cancelled', provider: 'google' });
        const long = 'x'.repeat(500);
        const err = readAuthReturn('/app/auth/google', `#state=${NONCE}&error=server_error&error_description=${long}`)!;
        const out = matchAuthReturn(err, expect_);
        expect(out.kind).toBe('provider_error');
        expect((out as { message: string }).message.length).toBeLessThan(200);
    });

    it("a provider error with a foreign state is still refused: nobody else's return is described here", () => {
        const ret = readAuthReturn('/app/auth/google', '#state=elsewhere&error=server_error&error_description=<img src=x>')!;
        expect(matchAuthReturn(ret, expect_)).toEqual({ kind: 'refused', reason: 'foreign_state' });
    });
});

describe('capturing the return scrubs the address bar (design §5.1)', () => {
    beforeEach(() => resetCapturedAuthReturn());
    afterEach(() => resetCapturedAuthReturn());

    function fakeWindow(pathname: string, hash: string) {
        const replaceState = vi.fn();
        return { win: { location: { pathname, hash }, history: { replaceState } } as unknown as Window, replaceState };
    }

    it('reads the fragment, then replaces the URL with /app, before returning', () => {
        const token = fakeJwt({ sub: 's', nonce: NONCE });
        const { win, replaceState } = fakeWindow('/app/auth/google', `#state=${NONCE}&id_token=${token}`);
        const ret = captureAuthReturn(win);
        expect(ret?.idToken).toBe(token);
        expect(replaceState).toHaveBeenCalledTimes(1);
        expect(replaceState).toHaveBeenCalledWith(null, '', '/app');
    });

    it('once per page load: a second read answers the same without touching the history again', () => {
        const { win, replaceState } = fakeWindow('/app/auth/google', `#state=${NONCE}&id_token=x.y.z`);
        const first = captureAuthReturn(win);
        const second = captureAuthReturn(fakeWindow('/app', '').win);
        expect(second).toBe(first);
        expect(replaceState).toHaveBeenCalledTimes(1);
        consumeCapturedAuthReturn();
        expect(captureAuthReturn(win)).toBeNull();
    });

    it('a page that is not a return is left as it is', () => {
        const { win, replaceState } = fakeWindow('/app', '#something');
        expect(captureAuthReturn(win)).toBeNull();
        expect(replaceState).not.toHaveBeenCalled();
    });
});

describe('the GitHub wait (design §3.3)', () => {
    function answer(status: number, body: Record<string, unknown> = {}, retryAfterSeconds: number | null = null): DoorAnswer {
        return { status, body, retryAfterSeconds };
    }

    function harness(answers: Array<DoorAnswer | Error>, { expiresAt = Number.MAX_SAFE_INTEGER } = {}) {
        const waits: number[] = [];
        let clock = 0;
        const poll = vi.fn(async () => {
            const next = answers.shift();
            if (!next) throw new Error('polled more than expected');
            if (next instanceof Error) throw next;
            return next;
        });
        const run = () => runGithubPoll({
            poll,
            sleep: async (ms) => { waits.push(ms); clock += ms; },
            intervalSeconds: 5,
            expiresAt,
            now: () => clock,
        });
        return { waits, poll, run };
    }

    it('polls at the interval until ok, and returns the sub', async () => {
        const h = harness([answer(200, { status: 'pending', intervalSeconds: 5 }), answer(200, { status: 'ok', sub: 'gh-42', email: 'e@x' })]);
        expect(await h.run()).toEqual({ status: 'ok', sub: 'gh-42' });
        expect(h.waits).toEqual([5000, 5000]);
    });

    it("follows a longer interval the node passes on (GitHub's slow_down)", async () => {
        const h = harness([answer(200, { status: 'pending', intervalSeconds: 10 }), answer(200, { status: 'ok', sub: 'gh-1' })]);
        await h.run();
        expect(h.waits).toEqual([5000, 10000]);
    });

    it('a 429 is still pending: the next poll waits the Retry-After it came with', async () => {
        const h = harness([answer(429, { error: 'Too many' }, 37), answer(200, { status: 'ok', sub: 'gh-1' })]);
        expect(await h.run()).toEqual({ status: 'ok', sub: 'gh-1' });
        expect(h.waits).toEqual([5000, 37000]);
    });

    it('a 429 with no Retry-After waits the interval', async () => {
        const h = harness([answer(429), answer(200, { status: 'ok', sub: 'gh-1' })]);
        await h.run();
        expect(h.waits).toEqual([5000, 5000]);
    });

    it('a 429 with a Retry-After of 0 (or a date already past) still waits the interval: never a poll straight after', async () => {
        const h = harness([answer(429, {}, 0), answer(429, {}, 0), answer(429, {}, 2), answer(200, { status: 'ok', sub: 'gh-1' })]);
        expect(await h.run()).toEqual({ status: 'ok', sub: 'gh-1' });
        expect(h.waits).toEqual([5000, 5000, 5000, 5000]);
        expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
    });

    it('denied and expired end the wait', async () => {
        expect(await harness([answer(200, { status: 'denied' })]).run()).toEqual({ status: 'denied' });
        expect(await harness([answer(200, { status: 'expired' })]).run()).toEqual({ status: 'expired' });
    });

    it('no answer, or a 503, is waited through; the code\'s own deadline ends it', async () => {
        const h = harness([new DoorUnreachableError(new Error('offline')), answer(503, { error: 'GitHub is down' }), answer(200, { status: 'ok', sub: 'gh-9' })]);
        expect(await h.run()).toEqual({ status: 'ok', sub: 'gh-9' });
        const late = harness([answer(200, { status: 'pending' }), answer(200, { status: 'pending' })], { expiresAt: 7000 });
        expect(await late.run()).toEqual({ status: 'expired' });
        expect(late.poll).toHaveBeenCalledTimes(1);
    });

    it('any other refusal stops, with the answer, rather than waiting forever', async () => {
        const refused = answer(409, { error: 'This key is already a member of this community.', code: 'already_member' });
        expect(await harness([refused]).run()).toEqual({ status: 'failed', answer: refused });
        expect(await harness([answer(200, { status: 'ok' })]).run()).toMatchObject({ status: 'failed' });
    });

    it('stops at once when the page leaves the screen', async () => {
        const controller = new AbortController();
        const poll = vi.fn();
        const result = runGithubPoll({
            poll,
            sleep: async () => { controller.abort(); },
            intervalSeconds: 5,
            expiresAt: Number.MAX_SAFE_INTEGER,
            signal: controller.signal,
        });
        expect(await result).toEqual({ status: 'aborted' });
        expect(poll).not.toHaveBeenCalled();
    });

    it('Retry-After in seconds or as a date', () => {
        expect(parseRetryAfter('12')).toBe(12);
        expect(parseRetryAfter(null)).toBeNull();
        expect(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString())).toBeGreaterThanOrEqual(28);
    });
});

describe('each door answer → its screen (design §2 screen 4)', () => {
    const a = (status: number, body: Record<string, unknown>): DoorAnswer => ({ status, body, retryAfterSeconds: null });

    it('200: joined, with the name the node gave and what it said about recovery', () => {
        expect(doorOutcome(a(200, { success: true, member: { callsign: 'Alice2' }, provider: 'google' }), 'google'))
            .toEqual({ kind: 'joined', callsign: 'Alice2', recovery: null });
        expect(doorOutcome(a(200, { success: true, member: { callsign: 'Al' }, recovery: { enrolled: true } }), 'google'))
            .toEqual({ kind: 'joined', callsign: 'Al', recovery: { enrolled: true } });
    });

    it('409 already_member: you are in', () => {
        expect(doorOutcome(a(409, { code: 'already_member', error: 'x' }), 'google')).toEqual({ kind: 'already_member' });
    });

    it('409 already_joined: restore instead, naming the sign-in', () => {
        expect(doorOutcome(a(409, { code: 'already_joined', error: 'node text' }), 'apple')).toEqual({
            kind: 'already_joined',
            message: 'This Apple account already has a BeanPool identity here. Restore it instead.',
        });
    });

    it('401 sign_in: expired, try once more', () => {
        expect(doorOutcome(a(401, { code: 'sign_in', error: 'Google sign-in could not be matched to this request.' }), 'google'))
            .toEqual({ kind: 'expired', message: "That took a while and the sign-in expired. Let's try once more." });
    });

    it("429: the node's sentence, verbatim", () => {
        const text = 'Too many new accounts have joined from this network in the last hour (5). Please try again later.';
        expect(doorOutcome(a(429, { code: 'rate_limited', error: text }), 'google')).toEqual({ kind: 'rate_limited', message: text });
    });

    it("503: the node's text, to try again with the same sign-in", () => {
        const text = 'Google sign-in could not be checked right now. Please try again in a minute.';
        expect(doorOutcome(a(503, { code: 'sign_in_unavailable', error: text }), 'google')).toEqual({ kind: 'unavailable', message: text });
    });

    it('404: the door is shut', () => {
        expect(doorOutcome(a(404, { code: 'invite_only', error: 'This community is invite-only.' }), 'github').kind).toBe('door_closed');
    });

    it("403 and 400: the node's words", () => {
        expect(doorOutcome(a(403, { code: 'removed', error: 'removed text' }), 'google')).toEqual({ kind: 'refused', message: 'removed text' });
        expect(doorOutcome(a(400, { error: "'idToken' is required." }), 'google')).toEqual({ kind: 'refused', message: "'idToken' is required." });
    });
});

describe('the join body and the sign-ins offered', () => {
    it('an OIDC sign-in sends idToken and nonce; GitHub sends proof.sessionId; sub is never sent', () => {
        expect(joinBody('Alice', { provider: 'google', idToken: 't', nonce: NONCE, sub: 'g' }))
            .toEqual({ callsign: 'Alice', provider: 'google', idToken: 't', nonce: NONCE });
        expect(joinBody('Alice', { provider: 'github', sessionId: 'sess', sub: 'gh' }))
            .toEqual({ callsign: 'Alice', provider: 'github', proof: { sessionId: 'sess' } });
    });

    it('recovery rides along only when given (the G11-c seam)', () => {
        const recovery = { shares: [{ holderType: 'sso', holderRef: 'google', shareIndex: 1 }] };
        expect(joinBody('Alice', { provider: 'google', idToken: 't', nonce: NONCE, sub: 'g' }, recovery)).toMatchObject({ recovery });
    });

    it("offers what the node takes and a browser can do: a provider with no client id stays hidden, GitHub needs the node's flow", () => {
        const n: JoinNonce = {
            nonce: NONCE, expiresInSeconds: 600, providers: ['google', 'apple', 'facebook', 'github'], githubFlow: 'node',
            clientIds: { google: 'g', apple: null, facebook: 'f' },
        };
        expect(offeredProviders(n)).toEqual(['google', 'facebook', 'github']);
        expect(offeredProviders({ ...n, githubFlow: undefined })).toEqual(['google', 'facebook']);
        expect(offeredProviders({ ...n, clientIds: {} })).toEqual(['github']);
    });
});

describe('the door calls are signed by the joining key', () => {
    let identity: BeanPoolIdentity;
    beforeEach(async () => {
        const { generateIdentity } = await import('./identity');
        identity = await generateIdentity('Alice');
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('the nonce request carries the pending key in X-Public-Key and a signature', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            nonce: NONCE, expiresInSeconds: 600, providers: ['google', 'github'], githubFlow: 'node', clientIds: { google: 'g', apple: null, facebook: null },
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const got = await requestJoinNonce(identity);
        expect(got).toMatchObject({ nonce: { nonce: NONCE, providers: ['google', 'github'] } });
        const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(path).toBe('/api/join/sso-nonce');
        const headers = init.headers as Record<string, string>;
        expect(headers['X-Public-Key']).toBe(identity.publicKey);
        expect(headers['X-Signature']).toMatch(/^[A-Za-z0-9+/]+=*$/);
        expect(init.method).toBe('POST');
    });

    it('only the four sign-ins are read from the answer: not a name every object has, which would draw a function as a button', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            nonce: NONCE, expiresInSeconds: 600, providers: ['google', 'toString', 'constructor', '__proto__', 'hasOwnProperty', 7, 'github'],
            githubFlow: 'node', clientIds: { google: 'g', toString: 'x', constructor: 'x' },
        }), { status: 200 })));
        const got = await requestJoinNonce(identity);
        expect(got).toMatchObject({ nonce: { providers: ['google', 'github'] } });
        expect(offeredProviders((got as { nonce: JoinNonce }).nonce)).toEqual(['google', 'github']);
    });

    it('no answer at all is DoorUnreachableError, never a guess', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        await expect(requestJoinNonce(identity)).rejects.toBeInstanceOf(DoorUnreachableError);
    });

    it("GitHub's start: a link to anywhere but GitHub is replaced with GitHub's own page", async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            sessionId: 's', userCode: 'ABCD-1234', verificationUri: 'javascript:alert(1)', expiresInSeconds: 900, intervalSeconds: 5,
        }), { status: 200 })));
        expect(await startGithubJoin(identity)).toMatchObject({ start: { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' } });
    });

    it("GitHub's start: another page on github.com is replaced too, an OAuth app's consent screen included", async () => {
        for (const elsewhere of [
            'https://github.com/login/oauth/authorize?client_id=Iv1.someone-else&scope=repo',
            'https://github.com/someone/phish',
            'https://github.com/login/device/../../someone/phish',
            'https://github.com/login/device.evil.example',
        ]) {
            vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
                sessionId: 's', userCode: 'ABCD-1234', verificationUri: elsewhere, expiresInSeconds: 900, intervalSeconds: 5,
            }), { status: 200 })));
            expect(await startGithubJoin(identity)).toMatchObject({ start: { verificationUri: 'https://github.com/login/device' } });
        }
    });
});


describe('a join that went out: only the node says whether its key may go (checkSentJoin)', () => {
    let identity: BeanPoolIdentity;
    const SENT_AT = 1_800_000_000_000;
    beforeEach(async () => {
        const { generateIdentity } = await import('./identity');
        identity = await generateIdentity('Alice');
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function sent(overrides: Partial<PendingJoin> = {}): PendingJoin {
        return { identity, provider: 'google', nonce: null, startedAt: SENT_AT - 60_000, expiresAt: SENT_AT + PENDING_JOIN_TTL_MS, restored: false, sentAt: SENT_AT, ...overrides };
    }
    function membershipAnswers(res: () => Response) {
        const fetchMock = vi.fn(async () => res());
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }
    const answer = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

    it('the window is the node\'s nonce life and a minute: nothing the join carried can be spent after it', () => {
        expect(SENT_JOIN_CAN_LAND_MS).toBe(11 * 60 * 1000);
    });

    it('a member: the join landed. Asked with the pending key, signed by it', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(SENT_AT + 60 * 60_000);
        const fetchMock = membershipAnswers(answer(200, { isMember: true, callsign: 'Alice2' }));
        expect(await checkSentJoin(sent())).toEqual({ kind: 'member', callsign: 'Alice2' });
        const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(path).toBe(`/api/community/membership/${identity.publicKey}`);
        expect((init.headers as Record<string, string>)['X-Public-Key']).toBe(identity.publicKey);
    });

    it('not a member, asked once the join can no longer land: no join it sent can land any more', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(SENT_AT + SENT_JOIN_CAN_LAND_MS);
        membershipAnswers(answer(200, { isMember: false, callsign: null }));
        expect(await checkSentJoin(sent())).toEqual({ kind: 'not_member' });
    });

    it('not a member, asked while the join could still land: keep it', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(SENT_AT + SENT_JOIN_CAN_LAND_MS - 1);
        membershipAnswers(answer(200, { isMember: false, callsign: null }));
        expect(await checkSentJoin(sent())).toEqual({ kind: 'may_still_land' });
    });

    it('a sent time this page cannot read is never "past the window"', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(SENT_AT + 24 * 60 * 60_000);
        membershipAnswers(answer(200, { isMember: false, callsign: null }));
        expect(await checkSentJoin(sent({ sentAt: Number.NaN }))).toEqual({ kind: 'may_still_land' });
    });

    it('no answer, another status, or a reply that does not say: unknown, never "not a member"', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(SENT_AT + 60 * 60_000);
        const replies: Array<() => Response> = [
            () => { throw new TypeError('Failed to fetch'); },
            answer(500, { error: 'boom' }),
            answer(502, {}),
            answer(429, { isMember: false }),
            // A captive portal's page, and bodies that do not say isMember as a boolean.
            () => new Response('<html>Sign in to the Wi-Fi</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
            answer(200, {}),
            answer(200, { isMember: 'false' }),
            answer(200, { isMember: null }),
        ];
        for (const reply of replies) {
            membershipAnswers(reply);
            expect(await checkSentJoin(sent())).toEqual({ kind: 'unknown' });
        }
    });

    it('checkMembershipWithKey reads "not a member" only from a reply that says it', async () => {
        membershipAnswers(answer(200, { isMember: false, callsign: null }));
        expect(await checkMembershipWithKey(identity)).toEqual({ isMember: false, callsign: null });
        membershipAnswers(answer(200, {}));
        await expect(checkMembershipWithKey(identity)).rejects.toBeInstanceOf(DoorUnreachableError);
    });
});

describe('what an answer to a join says for sure (joinVerdict, review round 2)', () => {
    const KEY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Alice', createdAt: '2026-09-26T00:00:00.000Z' };
    const SENT = { identity: KEY, sentAt: 1_800_000_000_000 };
    const at = (status: number, body: Record<string, unknown> = {}): DoorAnswer => ({ status, body, retryAfterSeconds: null });

    it('a yes only from a 2xx that parsed with success, or a 409 that parsed with already_member', () => {
        expect(joinVerdict(at(200, { success: true, member: { callsign: 'Alice2' } }), SENT, 'google')).toEqual({ kind: 'joined', callsign: 'Alice2', recovery: null });
        expect(joinVerdict(at(409, { code: 'already_member' }), SENT, 'google')).toEqual({ kind: 'already_member' });
    });

    it('a refusal the door gives before it writes a member, with its own status, is definite, and carries what the release needs', () => {
        const cases: Array<[number, string]> = [
            [404, 'invite_only'], [400, 'bad_request'], [400, 'bad_key'], [400, 'recovery_invalid'], [401, 'sign_in'],
            [403, 'key_invalidated'], [403, 'removed'], [409, 'already_joined'], [429, 'rate_limited'],
        ];
        for (const [status, code] of cases) {
            const v = joinVerdict(at(status, { code, error: 'x' }), SENT, 'google', SENT.sentAt + 5);
            expect(v, `${status} ${code}`).toMatchObject({
                kind: 'refused',
                refusal: { publicKey: KEY.publicKey, sentAt: SENT.sentAt, answeredAt: SENT.sentAt + 5, status, code },
            });
        }
    });

    it('everything else is unknown, and the page asks the node first (review 4106400570)', () => {
        const unknownThenCantTell: DoorAnswer[] = [
            at(200), at(200, { success: 'true' }), at(201, {}), at(204), at(302), at(304),
            // A 409 whose body was lost, or names no code the door sends with it.
            at(409), at(409, { error: 'x' }), at(409, { code: 'already_' }),
        ];
        for (const a of unknownThenCantTell) expect(joinVerdict(a, SENT, 'google'), `${a.status} ${JSON.stringify(a.body)}`).toEqual({ kind: 'unknown', outcome: null });

        const unknownThenByStatus: DoorAnswer[] = [
            at(400), at(400, { code: 'already_joined' }), at(401, { error: 'Request timestamp is stale or invalid' }), at(403),
            at(404), at(429, { error: 'Too many attempts. Try again in 42s' }), at(418, { code: 'teapot' }), at(403, { code: 'toString' }),
            at(500, { error: 'boom' }), at(502), at(503, { code: 'sign_in_unavailable', error: 'x' }), at(503, { code: 'join_failed' }), at(504),
        ];
        for (const a of unknownThenByStatus) {
            const v = joinVerdict(a, SENT, 'google');
            expect(v.kind, `${a.status} ${JSON.stringify(a.body)}`).toBe('unknown');
            expect((v as { outcome: unknown }).outcome).toEqual(doorOutcome(a, 'google'));
        }
    });

    it('a refusal for a join this page never marked sent is not evidence for anything', () => {
        expect(joinVerdict(at(403, { code: 'removed' }), { identity: KEY }, 'google').kind).toBe('unknown');
    });
});

describe('asking the node (probeMembership) and waiting for it (DOOR_TIMEOUT_MS)', () => {
    let identity: BeanPoolIdentity;
    beforeEach(async () => {
        const { generateIdentity } = await import('./identity');
        identity = await generateIdentity('Alice');
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('"not a member" comes with the key and when it was asked (taken before the request went)', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ isMember: false, callsign: null }), { status: 200 })));
        expect(await probeMembership(identity)).toEqual({ kind: 'not_member', answer: { publicKey: identity.publicKey, askedAt: 1_800_000_000_000 } });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ isMember: true, callsign: 'Al' }), { status: 200 })));
        expect(await probeMembership(identity)).toEqual({ kind: 'member', callsign: 'Al' });
        for (const reply of [() => { throw new TypeError('Failed to fetch'); }, () => new Response('{}', { status: 200 }), () => new Response('{"isMember":false}', { status: 429 })]) {
            vi.stubGlobal('fetch', vi.fn(async () => reply()));
            expect(await probeMembership(identity)).toEqual({ kind: 'unknown' });
        }
    });

    it('a join that never answers is given up after DOOR_TIMEOUT_MS: no answer, never a guess', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
            const signal = init.signal!;
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener('abort', () => reject(signal.reason));
        }));
        vi.stubGlobal('fetch', fetchMock);
        const result = submitJoin(identity, { callsign: 'Alice' }).then(() => 'answered', (e) => e);
        // The request is signed first (WebCrypto, no timers); the clock runs from before that.
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(DOOR_TIMEOUT_MS - 1_000);
        let settled = false;
        void result.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        const err = await result;
        expect(err).toBeInstanceOf(DoorUnreachableError);
        expect(String(err.message)).toContain('took too long');
    });

    it('a 200 whose body stops arriving is cut off by the same clock, and read as a 200 with no body: unknown', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
            const signal = init.signal!;
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"success":tr'));
                    signal.addEventListener('abort', () => controller.error(signal.reason));
                },
            });
            return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        vi.stubGlobal('fetch', fetchMock);
        const answer = submitJoin(identity, { callsign: 'Alice' });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(DOOR_TIMEOUT_MS);
        const got = await answer;
        expect(got).toMatchObject({ status: 200, body: {} });
        expect(joinVerdict(got, { identity, sentAt: 1 }, 'google')).toEqual({ kind: 'unknown', outcome: null });
    });
});
