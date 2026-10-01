/**
 * The join screens with the global node's two doors (two-doors design §2 to §4, slice S5): on a node whose
 * `features.wordsDoor` is true, 12 words or a sign-in, side by side, neither the lesser; the key made as the name
 * screen opens and its door work started at once; a join with 12 words alone, end to end; the work waited for when the
 * join comes first; a challenge that ran out replaced unseen; refused work replaced and the join sent again once; a
 * sign-in the node asks for work; the busy-level sentence with this browser's estimate; and every refusal a sentence.
 * A node without the feature looks exactly as today.
 *
 * The node is a stubbed fetch that issues real challenges and checks real solutions with core's door work (the node's
 * own check), so a join here is one the node would take. Nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
    checkDoorWorkChallenge,
    checkDoorWorkSolution,
    makeDoorWorkChallenge,
    solveDoorWorkSync,
    type DoorWorkDoor,
} from '@beanpool/core/door-work';
import { WebJoin, type JoinedResult } from './WebJoin';
import { loadIdentity, loadPendingJoin, savePendingJoin, generateIdentity, PENDING_JOIN_TTL_MS } from '../lib/identity';
import { readAuthReturn, resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import type { DoorWorkProgress, DoorWorkRun, DoorWorkSolver } from '../lib/door-work';

const ORIGIN = 'https://global.beanpool.org';
const NONCE = 'node-nonce-1';
const WORK_KEY = crypto.getRandomValues(new Uint8Array(32));

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(claims: Record<string, unknown>): string {
    return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.c2ln`;
}

interface Call { path: string; body: any; headers: Record<string, string> }
type Handler = (body: any, call: Call) => Response | Promise<Response>;

/**
 * The node. `/api/join/work` issues a real challenge for the key that signed it, at `level(door)`, valid `life(n)`
 * seconds; `/api/join` with `door: 'words'` checks it as the node does and takes the member. Any handler can be
 * replaced; paths match exactly.
 */
function stubNode(o: { level?: (door: DoorWorkDoor) => number | null; life?: (nth: number) => number; handlers?: Record<string, Handler> } = {}) {
    const calls: Call[] = [];
    const issued: string[] = [];
    const members = new Set<string>();
    const base: Record<string, Handler> = {
        '/api/join/work': (body, call) => {
            const key = call.headers['X-Public-Key'].toLowerCase();
            const level = (o.level ?? ((d) => (d === 'words' ? 0 : null)))(body.door);
            if (level === null) return json(200, { work: null, turnstile: null });
            const challenge = makeDoorWorkChallenge({ workKey: WORK_KEY, level, key, door: body.door });
            issued.push(challenge);
            return json(200, { work: { challenge, level, parts: 8, bits: 7 + level, size: 65_536, expiresInSeconds: o.life?.(issued.length) ?? 600 }, turnstile: null });
        },
        '/api/join': (body, call) => {
            const key = call.headers['X-Public-Key'].toLowerCase();
            const door: DoorWorkDoor = body.door === 'words' ? 'words' : 'sign-in';
            if (door === 'words' || body.work) {
                const c = checkDoorWorkChallenge(body.work?.challenge, { workKey: WORK_KEY, key, door });
                if (!c.ok) return json(400, { error: `work ${c.reason}`, code: c.reason === 'expired' ? 'work_expired' : 'work_invalid' });
                if (!checkDoorWorkSolution(body.work.challenge, body.work.counters).ok) return json(400, { error: 'bad counters', code: 'work_invalid' });
            }
            members.add(key);
            return json(200, { success: true, member: { callsign: body.callsign }, ...(door === 'words' ? { door: 'words' } : { provider: body.provider }) });
        },
        '/api/join/sso-nonce': () => json(200, {
            nonce: NONCE, expiresInSeconds: 600, providers: ['google', 'apple', 'facebook'],
            clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: '818892721251369' },
        }),
        '/api/community/membership/': (_b, call) => json(200, { isMember: members.has(call.headers['X-Public-Key']?.toLowerCase() ?? ''), callsign: null }),
        '/api/members/callsign-available/': () => json(200, { available: true }),
    };
    const handlers = { ...base, ...(o.handlers ?? {}) };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        const call = { path, body, headers: (init.headers ?? {}) as Record<string, string> };
        calls.push(call);
        const key = handlers[path] ? path : Object.keys(handlers).find((k) => k.endsWith('/') && path.startsWith(k));
        return key ? handlers[key](body, call) : json(404, { error: 'Not Found' });
    }));
    return {
        calls,
        issued,
        joins: () => calls.filter((c) => c.path === '/api/join'),
        works: () => calls.filter((c) => c.path === '/api/join/work'),
    };
}

/** A solver the test can hold back: core's synchronous solve, answered when `release()` is called (or at once). */
function heldSolver(hold = false) {
    const waiting: Array<() => void> = [];
    const progress: Array<(p: DoorWorkProgress) => void> = [];
    const solver: DoorWorkSolver = (challenge, callbacks): DoorWorkRun => {
        if (callbacks?.onProgress) progress.push(callbacks.onProgress);
        let cancelled = false;
        const done = new Promise<number[] | null>((resolve) => {
            const answer = () => resolve(cancelled ? null : solveDoorWorkSync(challenge));
            if (hold) waiting.push(answer);
            else setTimeout(answer, 0);
        });
        return { done, cancel: () => { cancelled = true; } };
    };
    return { solver, release: () => waiting.splice(0).forEach((f) => f()), progress };
}

function renderJoin(props: Partial<React.ComponentProps<typeof WebJoin>> = {}) {
    const onJoined = vi.fn<(r: JoinedResult) => void>();
    const onRestore = vi.fn();
    const navigate = vi.fn();
    render(<WebJoin onJoined={onJoined} onRestore={onRestore} navigate={navigate} origin={ORIGIN} authReturn={null} {...props} />);
    return { onJoined, onRestore, navigate };
}

async function toNameScreen() {
    const join = await screen.findByTestId('join-start');
    await waitFor(() => expect(join).not.toBeDisabled());
    fireEvent.click(join);
    fireEvent.click(await screen.findByTestId('join-new'));
    return screen.findByTestId('join-callsign');
}

async function toTheDoors(name = 'Bea') {
    fireEvent.change(await toNameScreen(), { target: { value: name } });
    fireEvent.click(screen.getByTestId('join-name-next'));
    return screen.findByTestId('door-words');
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('a node without the 12-words door looks exactly as today', () => {
    it('no key before Next, no work asked for, and the sign-in screen as it was', async () => {
        const node = stubNode();
        renderJoin({ wordsDoor: false });
        fireEvent.change(await toNameScreen(), { target: { value: 'Bea' } });
        await new Promise((r) => setTimeout(r, 50));
        expect(await loadPendingJoin()).toBeNull();
        fireEvent.click(screen.getByTestId('join-name-next'));
        await screen.findByText("Prove you're a person");
        expect(screen.queryByTestId('door-words')).toBeNull();
        expect(screen.queryByTestId('join-words')).toBeNull();
        await screen.findByTestId('join-provider-google');
        expect(node.works()).toHaveLength(0);
        expect(screen.getByText(/It stops one person making many accounts/)).toBeInTheDocument();
    });
});

describe('the two doors', () => {
    it('the key is made as the name screen opens, its work starts at once, and the name check is signed with it', async () => {
        const node = stubNode();
        const s = heldSolver(true);
        renderJoin({ wordsDoor: true, solveWork: s.solver });
        expect(screen.getByTestId('join-screen-loading')).toBeInTheDocument();
        await screen.findByText(/It takes a name, and 12 secret words or a sign-in\. No invite needed\./);
        const field = await toNameScreen();
        await waitFor(async () => expect((await loadPendingJoin())?.identity.publicKey).toMatch(/^[0-9a-f]{64}$/));
        const key = (await loadPendingJoin())!.identity.publicKey;
        await waitFor(() => expect(node.works()).toHaveLength(1));
        expect(node.works()[0].body).toEqual({ door: 'words' });
        expect(node.works()[0].headers['X-Public-Key']).toBe(key);
        // The name is checked once the field rests, signed by the joining key (the door's limiter, per key).
        fireEvent.change(field, { target: { value: 'Bea' } });
        await waitFor(() => expect(node.calls.some((c) => c.path.startsWith('/api/members/callsign-available/Bea'))).toBe(true), { timeout: 3000 });
        const check = node.calls.find((c) => c.path.startsWith('/api/members/callsign-available/'))!;
        expect(check.headers['X-Public-Key']).toBe(key);
        await screen.findByText('✓ Available');
        // Typed again to the same name: asked once.
        fireEvent.change(field, { target: { value: 'Be' } });
        fireEvent.change(field, { target: { value: 'Bea' } });
        await screen.findByText('✓ Available');
        await new Promise((r) => setTimeout(r, 900));
        expect(node.calls.filter((c) => c.path.startsWith('/api/members/callsign-available/Bea'))).toHaveLength(1);
    });

    it('a reload mid-work carries on with the same key: its work is asked for again, and the join goes with that key', async () => {
        const node = stubNode();
        const held = heldSolver(true);
        renderJoin({ wordsDoor: true, solveWork: held.solver });
        fireEvent.change(await toNameScreen(), { target: { value: 'Bea' } });
        await waitFor(() => expect(node.works()).toHaveLength(1));
        const key = (await loadPendingJoin())!.identity.publicKey;
        // The page goes away with the work half done (a reload, a closed tab), and opens again.
        cleanup();
        const { onJoined } = renderJoin({ wordsDoor: true, solveWork: heldSolver().solver });
        const field = await screen.findByTestId('join-callsign');
        await waitFor(() => expect(node.works()).toHaveLength(2));
        expect(node.works()[1].headers['X-Public-Key']).toBe(key);
        fireEvent.change(field, { target: { value: 'Bea' } });
        fireEvent.click(screen.getByTestId('join-name-next'));
        fireEvent.click(await screen.findByTestId('join-words'));
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect(onJoined.mock.calls[0][0].identity.publicKey).toBe(key);
        expect(node.joins()[0].body.work.challenge).toBe(node.issued[1]);
    });

    it('12 words first, then the sign-ins, each a full-width choice with its one line', async () => {
        stubNode();
        renderJoin({ wordsDoor: true, solveWork: heldSolver().solver });
        const words = await toTheDoors();
        const signIn = screen.getByTestId('door-sign-in');
        expect(words.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByTestId('join-words')).toHaveTextContent('Create an account with 12 secret words');
        expect(words).toHaveTextContent('No Google, Apple or Facebook needed. Your 12 words are the only way back in.');
        expect(signIn).toHaveTextContent('Or sign in');
        expect(signIn).toHaveTextContent('Also a way back if you lose this device.');
        expect(await screen.findByTestId('join-provider-google')).toBeInTheDocument();
        // Nothing here says one is the lesser, or that a sign-in stops people making many accounts.
        expect(screen.queryByText(/It stops one person making many accounts/)).toBeNull();
        expect(screen.getByTestId('join-as')).toHaveTextContent('Bea');
    });

    it('a join with 12 words alone, end to end: one signed join the node checks and takes; the identity is saved', async () => {
        const node = stubNode();
        const { onJoined, navigate } = renderJoin({ wordsDoor: true, solveWork: heldSolver().solver });
        await toTheDoors('Bea');
        const key = (await loadPendingJoin())!.identity;
        fireEvent.click(screen.getByTestId('join-words'));
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        const joined = onJoined.mock.calls[0][0];
        expect(joined).toMatchObject({ door: 'words', restored: false, recovery: null, requestedCallsign: null });
        expect(joined.identity.publicKey).toBe(key.publicKey);
        expect(joined.identity.callsign).toBe('Bea');
        const [join] = node.joins();
        expect(Object.keys(join.body).sort()).toEqual(['callsign', 'door', 'work']);
        expect(join.body).toMatchObject({ door: 'words', callsign: 'Bea' });
        expect(join.body.work.challenge).toBe(node.issued[0]);
        expect(join.headers['X-Public-Key']).toBe(key.publicKey);
        // No provider was visited, no nonce asked for the join, and the browser holds the account now.
        expect(navigate).not.toHaveBeenCalled();
        expect((await loadIdentity())?.publicKey).toBe(key.publicKey);
        expect(await loadPendingJoin()).toBeNull();
    });

    it('Join before the work is done: "Setting up your account…" with the 8-step bar, then the join', async () => {
        const node = stubNode();
        const s = heldSolver(true);
        const { onJoined } = renderJoin({ wordsDoor: true, solveWork: s.solver });
        await toTheDoors();
        fireEvent.click(screen.getByTestId('join-words'));
        await screen.findByText('Setting up your account…');
        const bar = screen.getByTestId('join-work-bar');
        expect(bar).toHaveAttribute('aria-valuenow', '0');
        expect(bar).toHaveAttribute('aria-valuemax', '8');
        s.progress.at(-1)?.({ done: 5, of: 8, tries: 600, rate: 6000 });
        await waitFor(() => expect(screen.getByTestId('join-work-bar')).toHaveAttribute('aria-valuetext', '5 of 8'));
        expect(node.joins()).toHaveLength(0);
        s.release();
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect(node.joins()).toHaveLength(1);
    });

    it('from level 3: the busy sentence with this browser\'s own estimate, beside the sign-in, and never a refusal', async () => {
        stubNode({ level: (d) => (d === 'words' ? 3 : null) });
        const s = heldSolver(true);
        renderJoin({ wordsDoor: true, solveWork: s.solver });
        await toTheDoors();
        s.progress.at(-1)?.({ done: 1, of: 8, tries: 1_000, rate: 500 });
        expect(await screen.findByTestId('join-busy')).toHaveTextContent(
            'Lots of people are joining right now. Setting up a 12-words account will take about 15 seconds in this browser. Or sign in to join now.');
        expect(screen.getByTestId('join-words')).not.toBeDisabled();
        expect(await screen.findByTestId('join-provider-google')).not.toBeDisabled();
    });

    it('a challenge about to run out is replaced without a word, and never sent; the join carries the new one', async () => {
        // The first challenge has half a minute left (as one left on the screen for nine and a half minutes would);
        // the ones after it are fresh.
        const node = stubNode({ life: (nth) => (nth === 1 ? 30 : 600) });
        const { onJoined } = renderJoin({ wordsDoor: true, solveWork: heldSolver().solver });
        await toTheDoors();
        fireEvent.click(screen.getByTestId('join-words'));
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect(node.issued).toHaveLength(2);
        expect(node.joins()).toHaveLength(1);
        expect(node.joins()[0].body.work.challenge).toBe(node.issued[1]);
        expect(screen.queryByTestId('join-notice')).toBeNull();
    });

    it('refused work (the node restarted, say): new work and the same join once more, unseen; twice, it is said', async () => {
        let refuse = 1;
        const node = stubNode({
            handlers: {
                '/api/join': (body) => (refuse-- > 0
                    ? json(400, { error: 'That took a while, so setting up your account has to start again. Please try again.', code: 'work_expired' })
                    : json(200, { success: true, member: { callsign: body.callsign }, door: 'words' })),
            },
        });
        const { onJoined } = renderJoin({ wordsDoor: true, solveWork: heldSolver().solver });
        await toTheDoors();
        fireEvent.click(screen.getByTestId('join-words'));
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
        expect(node.joins()).toHaveLength(2);
        expect(node.joins()[0].body.work.challenge).not.toBe(node.joins()[1].body.work.challenge);
        cleanup();

        // Refused every time: once more by itself, then the sentence, back at the two doors with the same key.
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        const always = stubNode({ handlers: { '/api/join': () => json(400, { error: 'Setting up your account didn\'t work out. Please try again.', code: 'work_invalid' }) } });
        renderJoin({ wordsDoor: true, solveWork: heldSolver().solver });
        await toTheDoors();
        const key = (await loadPendingJoin())!.identity.publicKey;
        fireEvent.click(screen.getByTestId('join-words'));
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("Setting up your account didn't work out. Please try again.");
        expect(always.joins()).toHaveLength(2);
        expect(screen.getByTestId('door-words')).toBeInTheDocument();
        expect((await loadPendingJoin())?.identity.publicKey).toBe(key);
    });

    it("a network's ceiling for the 12 words: the node's sentence under the button, and the sign-in still there", async () => {
        const WORDS_CEILING = 'A very large number of 12-words accounts were made from your network in the last hour. Sign in to join now, or try again in about 12 minutes.';
        stubNode({ handlers: { '/api/join/work': () => json(429, { error: WORDS_CEILING, code: 'network_busy', door: 'words' }, { 'Retry-After': '720' }) } });
        renderJoin({ wordsDoor: true, solveWork: heldSolver().solver });
        await toTheDoors();
        expect(await screen.findByTestId('join-words-problem')).toHaveTextContent(WORDS_CEILING);
        expect(await screen.findByTestId('join-provider-google')).not.toBeDisabled();
    });

    it('the 12-words door shut here by its operator: said, and the sign-in is the way in', async () => {
        const node = stubNode({
            handlers: { '/api/join/work': () => json(403, { error: 'This community needs a sign-in to join: Google, Apple or Facebook.', code: 'sign_in_required' }) },
        });
        renderJoin({ wordsDoor: true, solveWork: heldSolver().solver });
        await toTheDoors();
        expect(await screen.findByTestId('join-words-problem')).toHaveTextContent('This community needs a sign-in to join');
        expect(screen.getByTestId('join-words')).toBeDisabled();
        expect(node.joins()).toHaveLength(0);
    });
});

describe('a sign-in the node asks for work (from the 30th join an hour from one network)', () => {
    it('work_required: the work is done here and the same sign-in sent again, unseen; the nonce was not spent', async () => {
        const identity = await generateIdentity('Cal');
        const now = Date.now();
        await savePendingJoin({ identity, provider: 'google', nonce: NONCE, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false });
        let first = true;
        const node = stubNode({
            level: (d) => (d === 'sign-in' ? 0 : null),
            handlers: {
                '/api/join': (body, call) => {
                    if (first) {
                        first = false;
                        return json(400, { error: 'Lots of people have joined from your network lately… Please update the BeanPool app, or try again later.', code: 'work_required' });
                    }
                    const c = checkDoorWorkChallenge(body.work?.challenge, { workKey: WORK_KEY, key: call.headers['X-Public-Key'], door: 'sign-in' });
                    if (!c.ok || !checkDoorWorkSolution(body.work.challenge, body.work.counters).ok) return json(400, { code: 'work_invalid' });
                    return json(200, { success: true, member: { callsign: body.callsign }, provider: 'google' });
                },
            },
        });
        const authReturn = readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${fakeJwt({ sub: 'g-sub-1', nonce: NONCE })}`);
        const { onJoined } = renderJoin({ wordsDoor: true, authReturn, solveWork: heldSolver().solver });
        await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1), { timeout: 10_000 });
        expect(onJoined.mock.calls[0][0]).toMatchObject({ door: 'sign-in' });
        const [without, withWork] = node.joins();
        expect(without.body.work).toBeUndefined();
        expect(node.works().map((c) => c.body)).toEqual([{ door: 'sign-in' }]);
        // The same sign-in both times: the node checks the work before the token, so the first spent nothing.
        expect(withWork.body).toMatchObject({ provider: 'google', nonce: NONCE, idToken: without.body.idToken });
        expect(withWork.body.work.challenge).toBe(node.issued[0]);
        expect(screen.queryByTestId('join-notice')).toBeNull();
    });

    it("the sign-in ceiling: the node's sentence with its Retry-After as minutes", async () => {
        const identity = await generateIdentity('Cal');
        const now = Date.now();
        await savePendingJoin({ identity, provider: 'google', nonce: NONCE, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false });
        stubNode({
            handlers: {
                '/api/join': () => json(429, { error: 'Too many new accounts have joined from your network in the last hour. Please try again later.', code: 'network_busy', door: 'sign-in' }, { 'Retry-After': '1500' }),
            },
        });
        const authReturn = readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${fakeJwt({ sub: 'g-sub-1', nonce: NONCE })}`);
        renderJoin({ wordsDoor: true, authReturn, solveWork: heldSolver().solver });
        expect(await screen.findByTestId('join-notice')).toHaveTextContent(
            /^Too many new accounts have joined from your network in the last hour\. Try again in 25 minutes\. Everyone joining from the same network counts together/);
    });
});
