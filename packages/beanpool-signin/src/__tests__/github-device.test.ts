import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    createGithubDeviceFlow,
    createJwksCache,
    createSignInVerifier,
    NONCE_TTL_MS,
    SsoProviderUnavailableError,
    SsoVerificationError,
    type FetchLike,
    type GithubDeviceFlow,
} from '../index.js';

/**
 * GitHub's device flow against a stub GitHub. No GitHub is contacted: `fetch` is this file's own, it plays
 * the three GitHub endpoints the flow uses, and anything else throws. The clock is injected, so GitHub's
 * interval is moved past rather than waited out.
 */

const CLIENT_ID = 'Ov23li8mmDfBr7GyJVRU';
const SUBJECT = 'member-key-a';
const T0 = 1_800_000_000_000;

type Answer = 'pending' | 'slow_down' | 'token' | 'denied' | 'expired' | 'down' | 'rate_limited_403' | 'bogus';

interface Request { url: string; method: string; headers: Record<string, string>; body: Record<string, string> }

let now = T0;
let requests: Request[] = [];
let startAnswer: 'ok' | 'down' | 'disabled' | 'bad_uri' = 'ok';
let pollQueue: Answer[] = [];
let userAnswer: 'ok' | 'down' | 'no_id' = 'ok';
let issuedTokens: string[] = [];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const stubGithub: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    requests.push({ url, method: String(init?.method), headers, body });
    if (url === 'https://github.com/login/device/code') {
        if (startAnswer === 'down') return new Response('unavailable', { status: 503 });
        if (startAnswer === 'disabled') return json({ error: 'device_flow_disabled' });
        return json({
            device_code: 'device-code-1',
            user_code: 'ABCD-1234',
            verification_uri: startAnswer === 'bad_uri' ? 'https://evil.example/login/device' : 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
        });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
        const next = pollQueue.shift() ?? 'pending';
        if (next === 'down') return new Response('bad gateway', { status: 502 });
        if (next === 'rate_limited_403') {
            return json({ message: 'API rate limit exceeded for 203.0.113.9.' }, 403, { 'x-ratelimit-remaining': '0' });
        }
        if (next === 'token') {
            const token = `gho_${crypto.randomBytes(18).toString('hex')}`;
            issuedTokens.push(token);
            return json({ access_token: token, token_type: 'bearer', scope: 'read:user,user:email' });
        }
        const error = { pending: 'authorization_pending', slow_down: 'slow_down', denied: 'access_denied', expired: 'expired_token', bogus: 'unsupported_grant_type' }[next];
        return json({ error });
    }
    if (url === 'https://api.github.com/user') {
        if (userAnswer === 'down') return new Response('unavailable', { status: 503 });
        if (userAnswer === 'no_id') return json({ login: 'octo' });
        return json({ id: 1234567, login: 'octo', email: null });
    }
    if (url === 'https://api.github.com/user/emails') {
        return json([{ email: 'other@example.com', primary: false, verified: true }, { email: 'octo@example.com', primary: true, verified: true }]);
    }
    throw new Error(`the test tried to contact ${url}`);
};

let flow: GithubDeviceFlow;

beforeEach(() => {
    now = T0;
    requests = [];
    startAnswer = 'ok';
    pollQueue = [];
    userAnswer = 'ok';
    issuedTokens = [];
    flow = createGithubDeviceFlow({ fetch: stubGithub, now: () => now });
});

async function refusal(promise: Promise<unknown> | (() => unknown)): Promise<Error> {
    try {
        await (typeof promise === 'function' ? promise() : promise);
    } catch (e) {
        return e as Error;
    }
    throw new Error('expected a refusal, and it went through');
}

/** Start, then poll past the interval until GitHub hands over a token. */
async function finishedSession(subject = SUBJECT): Promise<string> {
    const { sessionId } = await flow.start(subject, CLIENT_ID);
    pollQueue = ['token'];
    now += 5_000;
    expect(await flow.poll(sessionId, subject)).toEqual({ status: 'ok', sub: '1234567', email: 'octo@example.com' });
    return sessionId;
}

describe('starting', () => {
    it('asks GitHub for a device code under the client id, as JSON, with a User-Agent', async () => {
        const start = await flow.start(SUBJECT, CLIENT_ID);
        expect(start).toMatchObject({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, intervalSeconds: 5 });
        expect(start.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toEqual({
            url: 'https://github.com/login/device/code',
            method: 'POST',
            headers: { Accept: 'application/json', 'User-Agent': 'BeanPool-Node', 'Content-Type': 'application/json' },
            body: { client_id: CLIENT_ID, scope: 'read:user user:email' },
        });
    });

    it('refuses with no subject or no client id, before asking GitHub', async () => {
        const noSubject = await refusal(flow.start('', CLIENT_ID));
        expect(noSubject).toBeInstanceOf(SsoVerificationError);
        expect(noSubject.message).toBe('A GitHub sign-in must be bound to a member.');
        const noClient = await refusal(flow.start(SUBJECT, undefined));
        expect(noClient.message).toBe('This node has no GitHub client ID configured, so it cannot run a GitHub sign-in.');
        expect(requests).toHaveLength(0);
    });

    it('says GitHub failed when it is down, and names a disabled device flow as the app setting it is', async () => {
        startAnswer = 'down';
        const down = await refusal(flow.start(SUBJECT, CLIENT_ID));
        expect(down).toBeInstanceOf(SsoProviderUnavailableError);
        expect(down.message).toBe('GitHub is not answering right now (HTTP 503). Please try again in a minute.');
        startAnswer = 'disabled';
        const disabled = await refusal(flow.start(SUBJECT, CLIENT_ID));
        expect(disabled).not.toBeInstanceOf(SsoProviderUnavailableError);
        expect(disabled.message).toBe('GitHub sign-in is not enabled for this app yet.');
    });

    it('never hands the phone a sign-in page that is not GitHub\'s own', async () => {
        startAnswer = 'bad_uri';
        const e = await refusal(flow.start(SUBJECT, CLIENT_ID));
        expect(e).toBeInstanceOf(SsoProviderUnavailableError);
        expect(e.message).toBe('GitHub did not issue a usable sign-in code. Please try again in a minute.');
    });
});

describe('polling', () => {
    it('answers pending inside the interval without asking GitHub', async () => {
        const { sessionId } = await flow.start(SUBJECT, CLIENT_ID);
        requests = [];
        now += 4_999;
        expect(await flow.poll(sessionId, SUBJECT)).toEqual({ status: 'pending', intervalSeconds: 5 });
        expect(requests).toHaveLength(0);
        now += 1;
        expect(await flow.poll(sessionId, SUBJECT)).toEqual({ status: 'pending', intervalSeconds: 5 });
        expect(requests.map(r => r.body)).toEqual([{ client_id: CLIENT_ID, device_code: 'device-code-1', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }]);
    });

    it('grows the interval by five seconds on slow_down', async () => {
        const { sessionId } = await flow.start(SUBJECT, CLIENT_ID);
        pollQueue = ['slow_down'];
        now += 5_000;
        expect(await flow.poll(sessionId, SUBJECT)).toEqual({ status: 'pending', intervalSeconds: 10 });
    });

    it('keeps the session through GitHub being down or rate-limiting a poll', async () => {
        const { sessionId } = await flow.start(SUBJECT, CLIENT_ID);
        pollQueue = ['down', 'rate_limited_403', 'token'];
        for (let i = 0; i < 2; i++) {
            now += 5_000;
            expect((await flow.poll(sessionId, SUBJECT)).status).toBe('pending');
        }
        now += 5_000;
        expect((await flow.poll(sessionId, SUBJECT)).status).toBe('ok');
    });

    it('ends the session on access_denied, expired_token, or an error GitHub gives no other meaning', async () => {
        for (const [answer, status] of [['denied', 'denied'], ['expired', 'expired']] as const) {
            const { sessionId } = await flow.start(SUBJECT, CLIENT_ID);
            pollQueue = [answer];
            now += 5_000;
            expect(await flow.poll(sessionId, SUBJECT)).toEqual({ status });
            expect(flow.session(sessionId)).toBeUndefined();
        }
        const { sessionId } = await flow.start(SUBJECT, CLIENT_ID);
        pollQueue = ['bogus'];
        now += 5_000;
        const e = await refusal(flow.poll(sessionId, SUBJECT));
        expect(e.message).toBe('GitHub refused the sign-in (unsupported_grant_type). Start again.');
        expect(flow.session(sessionId)).toBeUndefined();
    });

    it('keeps only { sub, email } from a finished sign-in: the access token is not reachable from the session', async () => {
        const sessionId = await finishedSession();
        expect(issuedTokens).toHaveLength(1);
        expect(JSON.stringify(flow.session(sessionId))).not.toContain(issuedTokens[0]);
        // The token went to GitHub's user endpoints as a bearer, and nowhere else.
        const bearers = requests.filter(r => r.headers.Authorization).map(r => [r.url, r.headers.Authorization]);
        expect(bearers).toEqual([
            ['https://api.github.com/user', `Bearer ${issuedTokens[0]}`],
            ['https://api.github.com/user/emails', `Bearer ${issuedTokens[0]}`],
        ]);
    });

    it('tells the member to start again when GitHub cannot say who signed in after issuing the token', async () => {
        const { sessionId } = await flow.start(SUBJECT, CLIENT_ID);
        pollQueue = ['token'];
        userAnswer = 'down';
        now += 5_000;
        const e = await refusal(flow.poll(sessionId, SUBJECT));
        expect(e).toBeInstanceOf(SsoVerificationError);
        expect(e).not.toBeInstanceOf(SsoProviderUnavailableError);
        expect(e.message).toBe('GitHub could not say who signed in just now. Start the GitHub sign-in again.');
        expect(flow.session(sessionId)).toBeUndefined();
    });

    it('answers "no session" the same for an unknown id and for someone else\'s', async () => {
        const { sessionId } = await flow.start(SUBJECT, CLIENT_ID);
        const theirs = await refusal(flow.poll(sessionId, 'member-key-b'));
        const unknown = await refusal(flow.poll('no-such-session', SUBJECT));
        expect(theirs.message).toBe('There is no GitHub sign-in in progress for this device. Start again.');
        expect(unknown.message).toBe(theirs.message);
    });

    it('replaces a subject\'s old session when it starts again', async () => {
        const first = await flow.start(SUBJECT, CLIENT_ID);
        const second = await flow.start(SUBJECT, CLIENT_ID);
        expect(flow.session(first.sessionId)).toBeUndefined();
        expect(flow.session(second.sessionId)).toBeDefined();
    });
});

describe('spending', () => {
    it('is once, by the subject it was started for, and a wrong subject does not consume it', async () => {
        const sessionId = await finishedSession();
        const wrong = await refusal(() => flow.consume(sessionId, 'member-key-b'));
        expect(wrong.message).toBe('There is no GitHub sign-in in progress for this device. Start again.');
        const identity = flow.consume(sessionId, SUBJECT);
        expect(identity).toEqual({
            provider: 'github',
            sub: '1234567',
            email: 'octo@example.com',
            audience: CLIENT_ID,
            issuedAt: Math.floor((T0 + 5_000) / 1000),
            expiresAt: Math.floor((T0 + 5_000 + NONCE_TTL_MS) / 1000),
        });
        const again = await refusal(() => flow.consume(sessionId, SUBJECT));
        expect(again.message).toBe('There is no GitHub sign-in in progress for this device. Start again.');
    });

    it('refuses an unfinished session without consuming it', async () => {
        const { sessionId } = await flow.start(SUBJECT, CLIENT_ID);
        const e = await refusal(() => flow.consume(sessionId, SUBJECT));
        expect(e.message).toBe('The GitHub sign-in has not finished yet. Enter the code at GitHub first.');
        expect(flow.session(sessionId)).toBeDefined();
    });

    it('refuses a result left unspent past NONCE_TTL_MS', async () => {
        const sessionId = await finishedSession();
        now += NONCE_TTL_MS;
        const e = await refusal(() => flow.consume(sessionId, SUBJECT));
        expect(e.message).toBe('The GitHub sign-in has expired. Start again.');
    });

    it('is what verifySignIn spends for GitHub, against the audiences the caller accepts', async () => {
        const verifier = createSignInVerifier({
            jwks: createJwksCache({ fetch: stubGithub }),
            consumeNonce: () => false,
            consumeGithubSession: (id, subject) => flow.consume(id, subject),
            now: () => now,
        });
        const sessionId = await finishedSession();
        const identity = await verifier.verifySignIn('github', { sessionId }, [CLIENT_ID], '', SUBJECT);
        expect(identity.sub).toBe('1234567');

        const other = await finishedSession();
        const e = await refusal(verifier.verifySignIn('github', { sessionId: other }, ['some-other-client'], '', SUBJECT));
        expect(e.message).toBe('GitHub sign-in was run for a different application.');
    });
});
