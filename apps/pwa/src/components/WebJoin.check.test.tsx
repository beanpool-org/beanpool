/**
 * The person check at the 12-words door in the browser (apps/server services/door-check.ts): the join leaves the page for
 * the check's own origin, as a sign-in leaves for a provider, and comes back in the fragment. Nothing of Cloudflare's ever
 * runs on this origin. The node is a stubbed fetch; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { checkDoorWorkChallenge, checkDoorWorkSolution, makeDoorWorkChallenge, solveDoorWorkSync } from '@beanpool/core/door-work';
import { WebJoin } from './WebJoin';
import { generateIdentity, loadPendingJoin, savePendingJoin, PENDING_JOIN_TTL_MS } from '../lib/identity';
import { readAuthReturn, requestDoorWork, doorCheckUrl, doorOutcome, joinVerdict, resetCapturedAuthReturn, wordsWorkRefusal } from '../lib/web-join';
import { WordsWork } from '../lib/words-work';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import type { DoorWorkSolver } from '../lib/door-work';

const ORIGIN = 'https://global.beanpool.org';
const PAGE = 'https://check.beanpool.org/';
const WORK_KEY = crypto.getRandomValues(new Uint8Array(32));
const CHECK_REQUIRED = {
    error: 'Lots of people are joining right now, so a 12-words account starts with a quick check. Sign in to join now, or try again later.',
    code: 'check_required', turnstile: { siteKey: '0x4AAA', page: PAGE },
};

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const solver: DoorWorkSolver = (challenge) => ({ done: Promise.resolve(solveDoorWorkSync(challenge)), cancel: () => {} });

/**
 * The node, busy: work only with a good token (or a pass from one), and a join only with work. `joinAsks`: it got busy
 * after the work was handed out, so the work route hands it out and the join asks for the check. `asksAgain`: it couldn't
 * judge the token (Cloudflare lost the call, or is limiting this node), so it asks for the check again.
 */
function busyNode(o: { goodToken?: string; joinAsks?: boolean; asksAgain?: boolean } = {}) {
    const works: any[] = [];
    const joins: any[] = [];
    let passed = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        const key = ((init.headers ?? {}) as Record<string, string>)['X-Public-Key']?.toLowerCase();
        if (path === '/api/join/work') {
            works.push(body);
            if (body.door === 'sign-in') return json(200, { work: null, turnstile: null });
            if (body.turnstile) {
                if (o.asksAgain) return json(429, CHECK_REQUIRED);
                if (body.turnstile !== o.goodToken) return json(403, { error: "That check didn't pass. Try again, or sign in to join now.", code: 'check_failed' });
                passed = true;
            }
            if (!passed && !o.joinAsks) return json(429, CHECK_REQUIRED);
            return json(200, { work: { challenge: makeDoorWorkChallenge({ workKey: WORK_KEY, level: 2, key, door: 'words' }), level: 2, parts: 8, bits: 9, size: 65_536, expiresInSeconds: 600 }, turnstile: null });
        }
        if (path === '/api/join') {
            joins.push(body);
            if (o.joinAsks && !passed) return json(429, CHECK_REQUIRED);
            const c = checkDoorWorkChallenge(body.work?.challenge, { workKey: WORK_KEY, key, door: 'words' });
            if (!c.ok || !checkDoorWorkSolution(body.work.challenge, body.work.counters).ok) return json(400, { error: 'bad', code: 'work_invalid' });
            return json(200, { success: true, member: { callsign: body.callsign }, door: 'words' });
        }
        if (path === '/api/join/sso-nonce') return json(200, { nonce: 'n', expiresInSeconds: 600, providers: ['google'], clientIds: { google: 'web' } });
        if (path.startsWith('/api/community/membership/')) return json(200, { isMember: false, callsign: null });
        if (path.startsWith('/api/members/callsign-available/')) return json(200, { available: true });
        return json(404, { error: 'Not Found' });
    }));
    return { works, joins };
}

function renderJoin(props: Partial<React.ComponentProps<typeof WebJoin>> = {}) {
    const onJoined = vi.fn();
    const navigate = vi.fn();
    render(<WebJoin onJoined={onJoined} onRestore={vi.fn()} navigate={navigate} origin={ORIGIN} authReturn={null} wordsDoor solveWork={solver} {...props} />);
    return { onJoined, navigate };
}

async function toTheDoors(name = 'Bea') {
    const join = await screen.findByTestId('join-start');
    await waitFor(() => expect(join).not.toBeDisabled());
    fireEvent.click(join);
    fireEvent.click(await screen.findByTestId('join-new'));
    fireEvent.change(await screen.findByTestId('join-callsign'), { target: { value: name } });
    fireEvent.click(screen.getByTestId('join-name-next'));
    return screen.findByTestId('door-words');
}

async function pendingHere(extra: Record<string, unknown> = {}) {
    const identity = { ...(await generateIdentity('Bea')) };
    const now = Date.now();
    return savePendingJoin({ identity, provider: null, nonce: null, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false, ...extra });
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('the hop', () => {
    it('the fragment carries the site key, the first 32 hex of the key, this origin and the theme; none of it is in a request line', () => {
        const url = doorCheckUrl({ siteKey: '0x4AAA', page: PAGE }, 'ab'.repeat(32), ORIGIN, 'dark');
        expect(url).toBe(`${PAGE}#sitekey=0x4AAA&cdata=${'ab'.repeat(16)}&return=${encodeURIComponent(ORIGIN)}&theme=dark`);
    });

    it('the return page is read from its fragment only, and a provider\'s return has no check in it', () => {
        expect(readAuthReturn('/app/auth/check', '#token=0.tok')?.check).toEqual({ token: '0.tok', error: null });
        expect(readAuthReturn('/app/auth/check', '#error=failed')?.check).toEqual({ token: null, error: 'failed' });
        expect(readAuthReturn('/app/auth/check', '')?.check).toEqual({ token: null, error: null });
        expect(readAuthReturn('/app/auth/google', '#state=s&id_token=t')?.check).toBeUndefined();
    });

    it('the work route: check_required is the check, a token goes in the body, and no good page is a sentence', async () => {
        const identity = await generateIdentity('Bea');
        const node = busyNode();
        expect(await requestDoorWork(identity, 'words')).toEqual({ kind: 'check', check: CHECK_REQUIRED.turnstile });
        await requestDoorWork(identity, 'words', Date.now, 'tok');
        expect(node.works[1]).toEqual({ door: 'words', turnstile: 'tok' });
        const noPage = { status: 429, body: { error: 'x', code: 'check_required', turnstile: { siteKey: 'k', page: 'http://check' } } };
        expect(wordsWorkRefusal(noPage).kind).toBe('busy');
    });

    it('a join the node refuses for a check is a definite refusal: the join did not land', async () => {
        const identity = await generateIdentity('Bea');
        const answer = { status: 429, body: CHECK_REQUIRED };
        const verdict = joinVerdict(answer, { identity, sentAt: 1 }, null);
        expect(verdict).toMatchObject({ kind: 'refused', outcome: { kind: 'check', check: CHECK_REQUIRED.turnstile } });
        expect(doorOutcome(answer, null).kind).toBe('check');
    });

    it('WordsWork: no work is asked for past the check; a token goes on the next ask only', async () => {
        const identity = await generateIdentity('Bea');
        const tokens: Array<string | undefined> = [];
        const w = new WordsWork(identity, {
            solver,
            request: async (_i, _d, _n, token) => {
                tokens.push(token);
                return { kind: 'check', check: CHECK_REQUIRED.turnstile };
            },
        });
        expect(await w.take()).toMatchObject({ ok: false, state: { status: 'check', check: CHECK_REQUIRED.turnstile } });
        w.passCheck('tok');
        await w.take();
        await w.take();
        expect(tokens).toEqual([undefined, 'tok', undefined]);
        w.dispose();
    });
});

describe('the join', () => {
    it('leaves for the check at Join, keeping the join; says beforehand what it is; never loads anything from Cloudflare here', async () => {
        const node = busyNode();
        const { navigate, onJoined } = renderJoin();
        await toTheDoors();
        await screen.findByTestId('join-check-first');
        expect(navigate).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('join-words'));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        const url = String(navigate.mock.calls[0][0]);
        const p = await loadPendingJoin();
        expect(url.startsWith(`${PAGE}#sitekey=0x4AAA&cdata=${p!.identity.publicKey.slice(0, 32)}&return=`)).toBe(true);
        expect(p?.checkHop).toBe(true);
        expect(node.joins).toHaveLength(0);
        expect(onJoined).not.toHaveBeenCalled();
        expect(document.querySelector('script[src*="cloudflare"], iframe')).toBeNull();
    });

    it('back with a token, the join carries on by itself and the member is in', async () => {
        const p = await pendingHere({ checkHop: true });
        const node = busyNode({ goodToken: '0.tok' });
        const { onJoined } = renderJoin({ authReturn: readAuthReturn('/app/auth/check', '#token=0.tok') });
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect(onJoined.mock.calls[0][0]).toMatchObject({ door: 'words' });
        expect(node.works[0]).toEqual({ door: 'words', turnstile: '0.tok' });
        expect(node.joins).toHaveLength(1);
        expect((await loadPendingJoin())?.identity.publicKey ?? p.identity.publicKey).toBe(p.identity.publicKey);
    });

    it('the node refuses the token: said in its words at the two ways in, and the sign-ins are there', async () => {
        await pendingHere();
        busyNode({ goodToken: '0.other' });
        renderJoin({ authReturn: readAuthReturn('/app/auth/check', '#token=0.tok') });
        expect((await screen.findByTestId('join-notice')).textContent).toMatch(/didn't pass\. Try again, or sign in/);
        await screen.findByTestId('join-provider-google');
    });

    it('the node asks again straight after a token: said at the two ways in, with no second hop, so it can\'t go round', async () => {
        await pendingHere();
        const node = busyNode({ asksAgain: true });
        const { navigate } = renderJoin({ authReturn: readAuthReturn('/app/auth/check', '#token=0.tok') });
        expect((await screen.findByTestId('join-notice')).textContent).toMatch(/didn't work in this browser\. Try again, or sign in/);
        await screen.findByTestId('join-provider-google');
        expect(navigate).not.toHaveBeenCalled();
        expect(node.works.filter((w) => w.turnstile)).toEqual([{ door: 'words', turnstile: '0.tok' }]);
        expect(node.joins).toHaveLength(0);
    });

    it('back with no pass: said in words, with the sign-ins beside it, and nothing sent', async () => {
        await pendingHere({ checkHop: true });
        const node = busyNode();
        renderJoin({ authReturn: readAuthReturn('/app/auth/check', '#error=wont_load') });
        expect((await screen.findByTestId('join-notice')).textContent).toMatch(/didn't work in this browser\. Try again, or sign in/);
        await screen.findByTestId('join-provider-google');
        expect(node.joins).toHaveLength(0);
        expect((await loadPendingJoin())?.checkHop).toBe(false);
    });

    it('closed by the member: back at the two ways in, and nothing is said against them', async () => {
        await pendingHere({ checkHop: true });
        busyNode();
        renderJoin({ authReturn: readAuthReturn('/app/auth/check', '#error=closed') });
        await screen.findByTestId('door-words');
        expect(screen.queryByTestId('join-notice')).toBeNull();
    });

    it('a page that never came back (the check didn\'t load, the browser\'s Back): said at the two ways in', async () => {
        await pendingHere({ checkHop: true });
        busyNode();
        renderJoin();
        expect((await screen.findByTestId('join-notice')).textContent).toMatch(/didn't work in this browser/);
        await screen.findByTestId('join-provider-google');
    });

    it('the door got busy after the work: the join is refused, and leaves for the check', async () => {
        const node = busyNode({ joinAsks: true });
        const { navigate } = renderJoin();
        await toTheDoors();
        fireEvent.click(screen.getByTestId('join-words'));
        await waitFor(() => expect(node.joins).toHaveLength(1));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        expect(String(navigate.mock.calls[0][0])).toContain(PAGE);
        expect((await loadPendingJoin())?.sentAt).toBeUndefined();
    });
});
