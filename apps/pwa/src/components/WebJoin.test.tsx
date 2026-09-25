/**
 * The join screens (design G11-b, §2): what the member sees for each step and each answer the door can give. The
 * node is a stubbed fetch and every provider is a URL the page is asked to go to; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WebJoin, type JoinedResult } from './WebJoin';
import {
    generateIdentity,
    loadIdentity,
    loadPendingJoin,
    savePendingJoin,
    PENDING_JOIN_TTL_MS,
    type BeanPoolIdentity,
    type PendingJoin,
} from '../lib/identity';
import { readAuthReturn, resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

const ORIGIN = 'https://global.beanpool.org';
const NONCE = 'node-nonce-1';

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(claims: Record<string, unknown>): string {
    return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.c2ln`;
}

type Handler = (body: any, init: RequestInit) => Response | Promise<Response>;

/** The node, as a fetch stub: one handler per path, and every call recorded with its body and headers. */
function stubNode(handlers: Record<string, Handler>) {
    const calls: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body, headers: (init.headers ?? {}) as Record<string, string> });
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        if (!key) return json(404, { error: 'Not Found' });
        return handlers[key](body, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls, joins: () => calls.filter((c) => c.path === '/api/join') };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function nonceAnswer(nonce = NONCE) {
    return json(200, {
        nonce, expiresInSeconds: 600, providers: ['google', 'apple', 'facebook', 'github'], githubFlow: 'node',
        clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: '818892721251369' },
    });
}

let identity: BeanPoolIdentity;

async function seedPending(overrides: Partial<PendingJoin> = {}): Promise<PendingJoin> {
    const now = Date.now();
    const p: PendingJoin = { identity, provider: 'google', nonce: NONCE, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false, ...overrides };
    await savePendingJoin(p);
    return p;
}

function googleReturn(nonce = NONCE, sub = 'g-sub-1') {
    return readAuthReturn('/app/auth/google', `#state=${nonce}&id_token=${fakeJwt({ sub, nonce })}`);
}

function renderJoin(props: Partial<React.ComponentProps<typeof WebJoin>> = {}) {
    const onJoined = vi.fn<(r: JoinedResult) => void>();
    const onRestore = vi.fn();
    const navigate = vi.fn();
    render(<WebJoin onJoined={onJoined} onRestore={onRestore} navigate={navigate} origin={ORIGIN} authReturn={null} {...props} />);
    return { onJoined, onRestore, navigate };
}

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    identity = await generateIdentity('Alice');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('screens 0 to 3: from the lobby to leaving for the provider', () => {
    it('lobby → new → name → sign-in; Google leaves the page with state === the node nonce, and the key waits as a pending join', async () => {
        const node = stubNode({
            '/api/members/callsign-available/': () => json(200, { available: true }),
            '/api/join/sso-nonce': () => nonceAnswer(),
        });
        const { navigate } = renderJoin();

        const join = await screen.findByTestId('join-start');
        await waitFor(() => expect(join).not.toBeDisabled());
        fireEvent.click(join);
        fireEvent.click(await screen.findByTestId('join-new'));
        fireEvent.change(await screen.findByTestId('join-callsign'), { target: { value: 'Bea' } });
        fireEvent.click(screen.getByTestId('join-name-next'));

        await screen.findByTestId('join-screen-providers');
        expect(screen.getByTestId('join-as')).toHaveTextContent('Bea');
        for (const p of ['google', 'apple', 'facebook', 'github']) await screen.findByTestId(`join-provider-${p}`);
        // The nonce was asked for with the new key, which is not the app's identity.
        const nonceCall = node.calls.find((c) => c.path === '/api/join/sso-nonce')!;
        const pending = (await loadPendingJoin())!;
        expect(nonceCall.headers['X-Public-Key']).toBe(pending.identity.publicKey);
        expect(await loadIdentity()).toBeNull();

        fireEvent.click(screen.getByTestId('join-provider-google'));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        const url = new URL(navigate.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(url.searchParams.get('state')).toBe(NONCE);
        expect(url.searchParams.get('nonce')).toBe(NONCE);
        expect(url.searchParams.get('client_id')).toBe('web-client');
        expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/app/auth/google`);
        const left = (await loadPendingJoin())!;
        expect(left).toMatchObject({ provider: 'google', nonce: NONCE, restored: false });
        expect(left.identity.callsign).toBe('Bea');
        expect(left.identity.mnemonic).toHaveLength(12);
        expect(await loadIdentity()).toBeNull();
    });

    it('Apple and Facebook go to their own pages with the same nonce', async () => {
        await seedPending({ provider: null, nonce: null });
        stubNode({ '/api/join/sso-nonce': () => nonceAnswer() });
        const { navigate } = renderJoin();
        fireEvent.click(await screen.findByTestId('join-provider-apple'));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        const apple = new URL(navigate.mock.calls[0][0]);
        expect(apple.hostname).toBe('appleid.apple.com');
        expect(apple.searchParams.get('state')).toBe(NONCE);
        expect(apple.searchParams.has('scope')).toBe(false);
        expect((await loadPendingJoin())?.provider).toBe('apple');
    });

    it('a provider the node gives no client id for is not offered', async () => {
        await seedPending({ provider: null, nonce: null });
        stubNode({
            '/api/join/sso-nonce': () => json(200, {
                nonce: NONCE, expiresInSeconds: 600, providers: ['google', 'apple', 'facebook', 'github'], githubFlow: 'node',
                clientIds: { google: 'web-client', apple: null, facebook: null },
            }),
        });
        renderJoin();
        await screen.findByTestId('join-provider-google');
        expect(screen.queryByTestId('join-provider-apple')).toBeNull();
        expect(screen.queryByTestId('join-provider-facebook')).toBeNull();
        expect(screen.getByTestId('join-provider-github')).toBeInTheDocument();
    });

    it("the node can't be reached: the sign-in screen says so and offers to try again, never a blank", async () => {
        await seedPending({ provider: null, nonce: null });
        stubNode({ '/api/join/sso-nonce': () => { throw new TypeError('Failed to fetch'); } });
        renderJoin();
        expect(await screen.findByTestId('join-nonce-problem')).toHaveTextContent("Can't reach the community right now");
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('"I use BeanPool on my phone" and "I have my 12 words" hand over to the restore screens before any key is made', async () => {
        stubNode({});
        const { onRestore } = renderJoin();
        const join = await screen.findByTestId('join-start');
        await waitFor(() => expect(join).not.toBeDisabled());
        fireEvent.click(join);
        fireEvent.click(await screen.findByRole('button', { name: 'I use BeanPool on my phone' }));
        expect(onRestore).toHaveBeenCalledWith('phone');
        fireEvent.click(screen.getByRole('button', { name: 'I have my 12 words' }));
        expect(onRestore).toHaveBeenCalledWith('words');
        expect(await loadPendingJoin()).toBeNull();
    });

    it('going back past the name drops the key made for it', async () => {
        await seedPending({ provider: null, nonce: null });
        stubNode({ '/api/join/sso-nonce': () => nonceAnswer() });
        renderJoin();
        await screen.findByTestId('join-provider-google');
        fireEvent.click(screen.getByRole('button', { name: '← Change name' }));
        fireEvent.click(await screen.findByRole('button', { name: '← Back' }));
        await screen.findByTestId('join-screen-guard');
        expect(await loadPendingJoin()).toBeNull();
    });
});

describe('screen 4: the return, and each door answer → its screen', () => {
    it('200: the identity moves into the app slot with the name the node gave, and the pending join goes', async () => {
        await seedPending();
        const node = stubNode({ '/api/join': () => json(200, { success: true, member: { callsign: 'Alice2', publicKey: identity.publicKey }, provider: 'google' }) });
        const { onJoined } = renderJoin({ authReturn: googleReturn() });
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        const result = onJoined.mock.calls[0][0];
        expect(result).toMatchObject({ requestedCallsign: 'Alice', restored: false, recovery: null });
        expect(result.identity).toMatchObject({ publicKey: identity.publicKey, callsign: 'Alice2' });
        expect(await loadIdentity()).toMatchObject({ publicKey: identity.publicKey, callsign: 'Alice2', mnemonic: identity.mnemonic });
        expect(await loadPendingJoin()).toBeNull();
        // One join, signed by the pending key, carrying the token and the nonce the page sent it with.
        const [sent] = node.joins();
        expect(sent.headers['X-Public-Key']).toBe(identity.publicKey);
        expect(sent.body).toEqual({ callsign: 'Alice', provider: 'google', idToken: expect.stringContaining('.'), nonce: NONCE });
    });

    it('409 already_member: you are in', async () => {
        await seedPending();
        stubNode({ '/api/join': () => json(409, { code: 'already_member', error: 'This key is already a member of this community.' }) });
        const { onJoined } = renderJoin({ authReturn: googleReturn() });
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
    });

    it('409 already_joined: the restore buttons, and the new key is thrown away', async () => {
        await seedPending();
        stubNode({ '/api/join': () => json(409, { code: 'already_joined', error: 'node text' }) });
        const { onRestore, onJoined } = renderJoin({ authReturn: googleReturn() });
        expect(await screen.findByTestId('join-already-joined')).toHaveTextContent('This Google account already has a BeanPool identity here. Restore it instead.');
        fireEvent.click(screen.getByTestId('join-restore-words'));
        expect(onRestore).toHaveBeenCalledWith('words');
        fireEvent.click(screen.getByTestId('join-restore-phone'));
        expect(onRestore).toHaveBeenCalledWith('phone');
        expect(onJoined).not.toHaveBeenCalled();
        expect(await loadPendingJoin()).toBeNull();
        expect(await loadIdentity()).toBeNull();
    });

    it('401 sign_in: one automatic retry with a fresh nonce, back to the same provider', async () => {
        await seedPending();
        const node = stubNode({
            '/api/join/sso-nonce': () => nonceAnswer('fresh-nonce'),
            '/api/join': () => json(401, { code: 'sign_in', error: 'Google sign-in could not be matched to this request.' }),
        });
        const { navigate } = renderJoin({ authReturn: googleReturn() });
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        const url = new URL(navigate.mock.calls[0][0]);
        expect(url.hostname).toBe('accounts.google.com');
        expect(url.searchParams.get('state')).toBe('fresh-nonce');
        expect(await loadPendingJoin()).toMatchObject({ provider: 'google', nonce: 'fresh-nonce', retriedExpired: true });
        expect(node.joins()).toHaveLength(1);
    });

    it('401 again after the automatic retry: the message and the buttons, no third trip', async () => {
        await seedPending({ retriedExpired: true });
        stubNode({
            '/api/join/sso-nonce': () => nonceAnswer('another'),
            '/api/join': () => json(401, { code: 'sign_in', error: 'x' }),
        });
        const { navigate } = renderJoin({ authReturn: googleReturn() });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("That took a while and the sign-in expired. Let's try once more.");
        await screen.findByTestId('join-provider-google');
        expect(navigate).not.toHaveBeenCalled();
    });

    it("429 rate_limited: the node's sentence verbatim, and the key is kept for an hour", async () => {
        await seedPending();
        const text = 'Too many new accounts have joined from this network in the last hour (5). Please try again later.';
        stubNode({
            '/api/join/sso-nonce': () => nonceAnswer('later'),
            '/api/join': () => json(429, { code: 'rate_limited', error: text }),
        });
        const before = Date.now();
        renderJoin({ authReturn: googleReturn() });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent(text);
        const kept = (await loadPendingJoin())!;
        expect(kept.identity.publicKey).toBe(identity.publicKey);
        expect(kept.expiresAt).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
        expect(await loadIdentity()).toBeNull();
    });

    it("503: the node's text, and Try again sends the same sign-in (the node did not spend it)", async () => {
        await seedPending();
        let n = 0;
        const node = stubNode({
            '/api/join': () => (++n === 1
                ? json(503, { code: 'sign_in_unavailable', error: 'Google sign-in could not be checked right now. Please try again in a minute.' })
                : json(200, { success: true, member: { callsign: 'Alice' } })),
        });
        const { onJoined } = renderJoin({ authReturn: googleReturn() });
        expect(await screen.findByTestId('join-unavailable')).toHaveTextContent('Google sign-in could not be checked right now.');
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        const [first, second] = node.joins();
        expect(second.body).toEqual(first.body);
    });

    it("no answer: \"we can't tell\", then the membership check decides; a member carries on", async () => {
        await seedPending();
        stubNode({
            '/api/join': () => { throw new TypeError('Failed to fetch'); },
            '/api/community/membership/': () => json(200, { isMember: true, callsign: 'Alice7' }),
        });
        const { onJoined } = renderJoin({ authReturn: googleReturn() });
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect((await loadIdentity())?.callsign).toBe('Alice7');
    });

    it('no answer and not a member: never a false success, and Try again is offered', async () => {
        await seedPending();
        stubNode({
            '/api/join': () => { throw new TypeError('Failed to fetch'); },
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
        });
        const { onJoined } = renderJoin({ authReturn: googleReturn() });
        expect(await screen.findByTestId('join-unknown')).toHaveTextContent("We can't tell if that worked, and you're not in yet.");
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(onJoined).not.toHaveBeenCalled();
        expect(await loadIdentity()).toBeNull();
    });

    it('404: the door is shut, said plainly on the lobby', async () => {
        await seedPending();
        stubNode({ '/api/join': () => json(404, { code: 'invite_only', error: 'This community is invite-only.' }) });
        renderJoin({ authReturn: googleReturn() });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("This community isn't taking new members right now.");
        await screen.findByTestId('join-screen-lobby');
    });

    it("403: the node's words, back on the sign-in screen", async () => {
        await seedPending();
        stubNode({
            '/api/join/sso-nonce': () => nonceAnswer(),
            '/api/join': () => json(403, { code: 'removed', error: 'The BeanPool identity this Google account joined with was removed from this community, so it can\'t join again.' }),
        });
        renderJoin({ authReturn: googleReturn() });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent('was removed from this community');
        await screen.findByTestId('join-screen-providers');
    });
});

describe('returns the page refuses before spending a request', () => {
    it("a foreign state: \"wasn't started here\", nothing sent, the pending join left as it was", async () => {
        const p = await seedPending();
        const node = stubNode({ '/api/join/sso-nonce': () => nonceAnswer() });
        renderJoin({ authReturn: googleReturn('someone-elses') });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("That sign-in wasn't started here. Start again.");
        expect(node.joins()).toHaveLength(0);
        expect((await loadPendingJoin())?.nonce).toBe(p.nonce);
    });

    it('a return with nothing pending: the lobby, and no join', async () => {
        const node = stubNode({});
        renderJoin({ authReturn: googleReturn() });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("That sign-in wasn't started here.");
        await screen.findByTestId('join-screen-lobby');
        expect(node.joins()).toHaveLength(0);
    });

    it('a token carrying another nonce is not sent', async () => {
        await seedPending();
        const node = stubNode({ '/api/join/sso-nonce': () => nonceAnswer() });
        renderJoin({ authReturn: readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${fakeJwt({ sub: 's', nonce: 'other' })}`) });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("Google didn't send back what we need.");
        expect(node.joins()).toHaveLength(0);
    });

    it('a cancel at the provider is said quietly and the buttons come back', async () => {
        await seedPending();
        stubNode({ '/api/join/sso-nonce': () => nonceAnswer() });
        renderJoin({ authReturn: readAuthReturn('/app/auth/google', `#state=${NONCE}&error=access_denied`) });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent('Sign-in was cancelled.');
        await screen.findByTestId('join-provider-google');
    });
});

describe('a reload, and a key restored here', () => {
    it('a reload with a pending join resumes at the sign-in with the same name and key, and a fresh nonce', async () => {
        await seedPending({ nonce: 'old-spent-nonce' });
        const node = stubNode({ '/api/join/sso-nonce': () => nonceAnswer('fresh') });
        const { navigate } = renderJoin();
        expect(await screen.findByTestId('join-as')).toHaveTextContent('Alice');
        fireEvent.click(await screen.findByTestId('join-provider-google'));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        expect(new URL(navigate.mock.calls[0][0]).searchParams.get('state')).toBe('fresh');
        expect(node.calls.find((c) => c.path === '/api/join/sso-nonce')?.headers['X-Public-Key']).toBe(identity.publicKey);
    });

    it('an expired pending join is not resumed: the lobby', async () => {
        await seedPending({ expiresAt: Date.now() - 1 });
        stubNode({});
        renderJoin();
        await screen.findByTestId('join-screen-lobby');
        expect(await loadPendingJoin()).toBeNull();
    });

    it('a restored key with a name goes straight to the sign-in, and joins as itself', async () => {
        const restored = { ...identity, callsign: 'Phoebe' };
        const node = stubNode({
            '/api/join/sso-nonce': () => nonceAnswer(),
        });
        renderJoin({ restored });
        await screen.findByTestId('join-provider-google');
        expect(screen.getByTestId('join-as')).toHaveTextContent('Phoebe');
        expect(await loadPendingJoin()).toMatchObject({ restored: true });
        expect(node.calls.find((c) => c.path === '/api/join/sso-nonce')?.headers['X-Public-Key']).toBe(identity.publicKey);
    });

    it('a restored key with no name asks for one first, and keeps the key', async () => {
        stubNode({ '/api/join/sso-nonce': () => nonceAnswer(), '/api/members/callsign-available/': () => json(200, { available: true }) });
        renderJoin({ restored: { ...identity, callsign: '' } });
        fireEvent.change(await screen.findByTestId('join-callsign'), { target: { value: 'Quinn' } });
        fireEvent.click(screen.getByTestId('join-name-next'));
        await screen.findByTestId('join-provider-google');
        expect(await loadPendingJoin()).toMatchObject({ restored: true, identity: { publicKey: identity.publicKey, callsign: 'Quinn' } });
    });

    it('a restored key that is already a member here is simply in', async () => {
        stubNode({ '/api/join/sso-nonce': () => json(409, { code: 'already_member', error: 'x' }) });
        const { onJoined } = renderJoin({ restored: { ...identity, callsign: 'Phoebe' } });
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect(onJoined.mock.calls[0][0]).toMatchObject({ restored: true });
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
    });
});

describe('screen 3b: GitHub', () => {
    it('shows the code, waits, and joins with the session', async () => {
        await seedPending({ provider: null, nonce: null });
        const node = stubNode({
            '/api/join/sso-nonce': () => nonceAnswer(),
            '/api/join/github/start': () => json(200, { sessionId: 'sess-1', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, intervalSeconds: 1 }),
            '/api/join/github/poll': () => json(200, { status: 'ok', sub: 'gh-77' }),
            '/api/join': () => json(200, { success: true, member: { callsign: 'Alice' } }),
        });
        const { onJoined, navigate } = renderJoin();
        fireEvent.click(await screen.findByTestId('join-provider-github'));
        expect(await screen.findByTestId('join-github-code')).toHaveTextContent('WDJB-MJHT');
        expect(screen.getByTestId('join-github-link')).toHaveAttribute('href', 'https://github.com/login/device');
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect(navigate).not.toHaveBeenCalled();
        const poll = node.calls.find((c) => c.path === '/api/join/github/poll')!;
        expect(poll.body).toEqual({ sessionId: 'sess-1' });
        expect(node.joins()[0].body).toEqual({ callsign: 'Alice', provider: 'github', proof: { sessionId: 'sess-1' } });
    });

    it('a 429 on the poll is still waiting, then denied says so', async () => {
        await seedPending({ provider: null, nonce: null });
        let polls = 0;
        stubNode({
            '/api/join/sso-nonce': () => nonceAnswer(),
            '/api/join/github/start': () => json(200, { sessionId: 's', userCode: 'AAAA-BBBB', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, intervalSeconds: 1 }),
            '/api/join/github/poll': () => (++polls === 1 ? json(429, { error: 'slow down' }, { 'Retry-After': '1' }) : json(200, { status: 'denied' })),
        });
        renderJoin();
        fireEvent.click(await screen.findByTestId('join-provider-github'));
        expect(await screen.findByTestId('join-notice', {}, { timeout: 10_000 })).toHaveTextContent('GitHub said no.');
        expect(polls).toBe(2);
    });
});
