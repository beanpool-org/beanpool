/**
 * A sent key's fate, over every answer the door can give a join and everything that can follow it (PR #1154, review
 * round 2). Once a join has gone, the node may hold its key as a member while the pending join is the only copy of
 * it and its 12 words. So, whatever the answer and whatever happens next:
 *
 *   - a key the node holds is never deleted, and never loses its sent mark (a key without one is dropped on its
 *     clock), until it is this browser's identity;
 *   - a key the node does not hold is let go (deleted or unsent) only after the door refused its join definitely AND
 *     the node then said it is not a member;
 *   - and the page never claims a join the node did not take.
 *
 * The node is a stubbed fetch that keeps its own member list; IndexedDB is the in-memory one. Nothing leaves the test.
 */
import { StrictMode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { WebJoin, type JoinedResult } from './WebJoin';
import {
    generateIdentity,
    loadPendingJoin,
    savePendingJoin,
    type BeanPoolIdentity,
    type PendingJoin,
} from '../lib/identity';
import { readAuthReturn, resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB, type MemoryIndexedDB } from '../lib/memory-indexeddb';

const ORIGIN = 'https://global.beanpool.org';
const NONCE = 'node-nonce-1';
const MIN = 60_000;

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function googleReturn(nonce = NONCE) {
    const jwt = `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify({ sub: 'g-sub-1', nonce }))}.c2ln`;
    return readAuthReturn('/app/auth/google', `#state=${nonce}&id_token=${jwt}`);
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const raw = (status: number, text: string | null, type = 'application/json') => () =>
    new Response(text, { status, headers: text === null ? {} : { 'Content-Type': type } });
const page = (status: number) => raw(status, '<html><body>Something went wrong</body></html>', 'text/html');
const unreachable = (): never => { throw new TypeError('Failed to fetch'); };

// ---------- every answer the door can give a join ----------

interface Shape {
    name: string;
    reply: () => Response;
    /** What the answer says for sure: a yes, a refusal the door gives before it writes a member, or nothing. */
    says: 'yes' | 'refused' | 'nothing';
}

const SHAPES: Shape[] = [
    { name: '200 success', reply: () => json(200, { success: true, member: { callsign: 'Alice' }, provider: 'google' }), says: 'yes' },
    { name: '200, the body cut off', reply: raw(200, '{"success":tr'), says: 'nothing' },
    { name: '200, no body', reply: raw(200, null), says: 'nothing' },
    { name: '200 {} (no success)', reply: () => json(200, {}), says: 'nothing' },
    { name: '204', reply: raw(204, null), says: 'nothing' },
    { name: '302', reply: raw(302, null), says: 'nothing' },
    { name: '400 bad_request', reply: () => json(400, { code: 'bad_request', error: "'idToken' is required." }), says: 'refused' },
    { name: '400, an HTML page', reply: page(400), says: 'nothing' },
    { name: "400 naming a code the door sends only with 409", reply: () => json(400, { code: 'already_joined', error: 'x' }), says: 'nothing' },
    { name: '401 sign_in', reply: () => json(401, { code: 'sign_in', error: 'Google sign-in could not be matched to this request.' }), says: 'refused' },
    { name: '401 with no code (the signature check)', reply: () => json(401, { error: 'Request timestamp is stale or invalid' }), says: 'nothing' },
    { name: '403 removed', reply: () => json(403, { code: 'removed', error: 'was removed from this community' }), says: 'refused' },
    { name: '403 key_invalidated', reply: () => json(403, { code: 'key_invalidated', error: 'This key was replaced.' }), says: 'refused' },
    { name: '403, an HTML page', reply: page(403), says: 'nothing' },
    { name: '404 invite_only', reply: () => json(404, { code: 'invite_only', error: 'This community is invite-only.' }), says: 'refused' },
    { name: '404, an HTML page', reply: page(404), says: 'nothing' },
    { name: '409 already_member', reply: () => json(409, { code: 'already_member', error: 'This key is already a member of this community.' }), says: 'yes' },
    { name: '409 already_joined', reply: () => json(409, { code: 'already_joined', error: 'This Google account already has a BeanPool identity here.' }), says: 'refused' },
    { name: '409, the body cut off', reply: raw(409, '{"code":"already_'), says: 'nothing' },
    { name: '409 {} (no code)', reply: () => json(409, {}), says: 'nothing' },
    { name: '429 rate_limited', reply: () => json(429, { code: 'rate_limited', error: 'Too many new accounts have joined from this network in the last hour (5). Please try again later.' }), says: 'refused' },
    { name: '429 with no code (the auth limiter)', reply: () => json(429, { error: 'Too many attempts. Try again in 42s' }), says: 'nothing' },
    { name: '500', reply: () => json(500, { error: 'Internal Server Error' }), says: 'nothing' },
    { name: '502, an HTML page', reply: page(502), says: 'nothing' },
    { name: '503 sign_in_unavailable', reply: () => json(503, { code: 'sign_in_unavailable', error: 'Google sign-in could not be checked right now. Please try again in a minute.' }), says: 'nothing' },
    { name: '503 join_failed', reply: () => json(503, { code: 'join_failed', error: 'Your join could not be completed, and nothing was saved.' }), says: 'nothing' },
    { name: '504, no body', reply: raw(504, null), says: 'nothing' },
    { name: 'no answer (a network error)', reply: unreachable, says: 'nothing' },
    { name: 'no answer (a timeout)', reply: () => { throw new DOMException('The community took too long to answer.', 'TimeoutError'); }, says: 'nothing' },
];

// ---------- the node ----------

interface World {
    /** The node wrote the member before this answer (a lost or garbled yes), or it did not. */
    took: boolean;
    /** 'up': the membership probe and the nonce answer truthfully. 'down': nothing but the first join's answer arrives. */
    node: 'up' | 'down';
}

let me: BeanPoolIdentity;
let other: BeanPoolIdentity;
let idb: MemoryIndexedDB;

function stubNode(shape: Shape, world: World) {
    const members = new Set<string>();
    const log = { joins: 0, refusedAt: null as number | null, notMemberAfterRefusal: false };
    let nonces = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const key = ((init.headers ?? {}) as Record<string, string>)['X-Public-Key'];
        if (path === '/api/join') {
            log.joins++;
            if (log.joins === 1) {
                if (world.took) members.add(key);
                if (shape.says === 'refused') log.refusedAt = Date.now();
                return shape.reply();
            }
            if (world.node === 'down') return unreachable();
            // A join sent again: a node that holds the key may still refuse it at the door, which it checks before
            // the member table (open-join.ts), and one that does not says what it said the first time.
            if (world.took) {
                log.refusedAt = Date.now();
                return json(404, { code: 'invite_only', error: 'This community is invite-only.' });
            }
            if (shape.says === 'refused') log.refusedAt = Date.now();
            return shape.reply();
        }
        if (world.node === 'down') return unreachable();
        if (path.startsWith('/api/community/membership/')) {
            const isMember = members.has(key);
            if (!isMember && log.refusedAt !== null) log.notMemberAfterRefusal = true;
            return json(200, { isMember, callsign: isMember ? 'Alice' : null });
        }
        if (path === '/api/join/sso-nonce') {
            if (members.has(key)) return json(409, { code: 'already_member', error: 'This key is already a member of this community.' });
            return json(200, {
                nonce: `nonce-${++nonces}`, expiresInSeconds: 600, providers: ['google', 'apple', 'facebook', 'github'], githubFlow: 'node',
                clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: '818892721251369' },
            });
        }
        if (path.startsWith('/api/members/callsign-available/')) return json(200, { available: true });
        return json(404, { error: 'Not Found' });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { members, log };
}

// ---------- a tab ----------

interface Tab {
    scope: ReturnType<typeof within>;
    container: HTMLElement;
    onJoined: ReturnType<typeof vi.fn<(r: JoinedResult) => void>>;
    navigate: ReturnType<typeof vi.fn>;
    unmount: () => void;
}

function open(props: { authReturn?: ReturnType<typeof googleReturn>; restored?: BeanPoolIdentity | null; strict?: boolean } = {}): Tab {
    const onJoined = vi.fn<(r: JoinedResult) => void>();
    const navigate = vi.fn();
    const el = (
        <WebJoin onJoined={onJoined} onRestore={vi.fn()} navigate={navigate} origin={ORIGIN}
            authReturn={props.authReturn ?? null} restored={props.restored ?? null} />
    );
    const { container, unmount } = render(props.strict ? <StrictMode>{el}</StrictMode> : el);
    return { scope: within(container), container, onJoined, navigate, unmount };
}

function screenOf(tab: Tab): string {
    const el = tab.container.querySelector('[data-testid^="join-screen-"]');
    return el?.getAttribute('data-testid')?.slice('join-screen-'.length) ?? '(none)';
}

/** The tab has stopped: on a screen the member can act on, joined, or gone to the provider. */
async function settle(tab: Tab) {
    await waitFor(() => {
        if (tab.onJoined.mock.calls.length || tab.navigate.mock.calls.length) return;
        const name = screenOf(tab);
        expect(['loading', 'joining', '(none)']).not.toContain(name);
        const text = tab.container.textContent ?? '';
        expect(text).not.toMatch(/Checking|One moment|Getting the sign-ins ready/);
    }, { timeout: 3000 });
    // The writes that follow the last screen change.
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

const gone = (tab: Tab) => tab.onJoined.mock.calls.length > 0 || tab.navigate.mock.calls.length > 0;

function click(tab: Tab, name: string | RegExp) {
    fireEvent.click(tab.scope.getByRole('button', { name }));
}

/** From whatever screen the tab is on, to the name screen, the way a member would get there. */
async function toNameScreen(tab: Tab): Promise<boolean> {
    for (let step = 0; step < 8; step++) {
        await settle(tab);
        if (gone(tab)) return false;
        const name = screenOf(tab);
        switch (name) {
            case 'name': return true;
            case 'providers': click(tab, '← Change name'); break;
            case 'unknown': case 'unavailable': case 'github': click(tab, '← Choose another way'); break;
            case 'lobby': {
                const join = tab.scope.getByTestId('join-start');
                await waitFor(() => expect(join).not.toBeDisabled());
                fireEvent.click(join);
                break;
            }
            case 'guard': fireEvent.click(tab.scope.getByTestId('join-new')); break;
            case 'abandon': click(tab, '← Keep it'); break;
            // Every other screen has a way back (review 4106401183: no screen without a way out).
            default: click(tab, '← Back'); break;
        }
    }
    throw new Error(`never reached the name screen; stuck on ${screenOf(tab)}`);
}

// ---------- everything that can follow ----------

type Action =
    | 'reload after the TTL'
    | 'Change name + Back'
    | 'Change name + Next'
    | 'Try again'
    | 'restore another key after the TTL'
    | 'a second tab (opened before the join went): Change name + Back'
    | 'a second tab (opened before the join went): Change name + Next, then a reload after the TTL';

const ACTIONS: Action[] = [
    'reload after the TTL',
    'Change name + Back',
    'Change name + Next',
    'Try again',
    'restore another key after the TTL',
    'a second tab (opened before the join went): Change name + Back',
    'a second tab (opened before the join went): Change name + Next, then a reload after the TTL',
];

interface Case { shape: Shape; world: World; action: Action }

const CASES: Case[] = SHAPES.flatMap((shape) =>
    // A yes from a node that did not take the member is not a world this page can be tested in: it would be believed.
    (shape.says === 'yes' ? [true] : [true, false]).flatMap((took) =>
        (['up', 'down'] as const).flatMap((node) => ACTIONS.map((action) => ({ shape, world: { took, node }, action })))));

function caseName(c: Case) {
    return `${c.shape.name} | node ${c.world.took ? 'took the member' : 'did not take it'}, then ${c.world.node} | ${c.action}`;
}

const peekPending = () => idb.peek('beanpool-identity', 'keys', 'pending-join') as PendingJoin | undefined;
const peekIdentity = () => idb.peek('beanpool-identity', 'keys', 'sovereign-identity') as BeanPoolIdentity | undefined;

/** The rule, checked against what is stored and what the node said. */
function expectKeyKept(world: World, log: ReturnType<typeof stubNode>['log'], when: string) {
    const stored = peekPending();
    const saved = peekIdentity();
    const heldSent = stored?.identity?.publicKey === me.publicKey && typeof stored.sentAt === 'number';
    if (world.took) {
        expect(saved?.publicKey === me.publicKey || heldSent,
            `${when}: the node holds the key, so it is this browser's identity or still a sent pending join`
            + ` (stored: ${stored ? `${stored.identity.publicKey === me.publicKey ? 'this key' : 'another key'}, sentAt ${stored.sentAt}` : 'nothing'})`).toBe(true);
    } else {
        expect(saved?.publicKey, `${when}: never a join the node did not take`).not.toBe(me.publicKey);
        if (!heldSent) {
            expect(log.notMemberAfterRefusal,
                `${when}: the key was let go (${stored?.identity?.publicKey === me.publicKey ? 'unsent' : 'deleted'}) without the door refusing it and the node then saying "not a member"`).toBe(true);
        }
    }
}

beforeAll(async () => {
    me = await generateIdentity('Alice');
    other = await generateIdentity('Phoebe');
});

beforeEach(() => {
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
    resetCapturedAuthReturn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function seed(): Promise<{ t0: number; p: PendingJoin }> {
    const t0 = Date.now();
    // Four minutes at Google: the pending join's own clock has six left when the join goes.
    const p: PendingJoin = { identity: me, provider: 'google', nonce: NONCE, startedAt: t0 - 4 * MIN, expiresAt: t0 + 6 * MIN, restored: false };
    await savePendingJoin(p);
    return { t0, p };
}

describe("a sent key's fate: every answer × everything that can follow", () => {
    it.each(CASES.map((c) => [caseName(c), c] as const))('%s', async (_name, { shape, world, action }) => {
        const { t0 } = await seed();
        const { log } = stubNode(shape, world);

        // A second tab, open on the sign-in screen before the join went: its copy of the pending join is unsent.
        let second: Tab | null = null;
        if (action.startsWith('a second tab')) {
            second = open();
            await settle(second);
            expect(screenOf(second)).toBe('providers');
        }

        let tab = open({ authReturn: googleReturn() });
        await settle(tab);
        expect(log.joins).toBe(1);
        expectKeyKept(world, log, 'after the answer');
        // And the rule is not "keep everything": a node that can be asked settles it either way.
        if (world.took && world.node === 'up') {
            expect(tab.onJoined, 'the node holds the key and says so: the member is in').toHaveBeenCalledTimes(1);
        }
        if (!world.took && world.node === 'up' && shape.says === 'refused') {
            const stored = peekPending();
            expect(stored?.identity.publicKey === me.publicKey && typeof stored.sentAt === 'number',
                'refused definitely, and the node says not a member: the key is let go as the door said').toBe(false);
        }

        const reopenAfterTtl = (props: Parameters<typeof open>[0] = {}) => {
            cleanup();
            vi.spyOn(Date, 'now').mockReturnValue(t0 + 30 * MIN);
            return open(props);
        };
        /** A tab that left for the provider is reopened, as a member coming back without finishing would find it. */
        const here = (t: Tab) => (t.navigate.mock.calls.length ? (t.unmount(), open()) : t);

        switch (action) {
            case 'reload after the TTL':
                tab = reopenAfterTtl();
                await settle(tab);
                break;
            case 'Change name + Back':
                tab = here(tab);
                if (await toNameScreen(tab)) {
                    click(tab, '← Back');
                    await settle(tab);
                }
                break;
            case 'Change name + Next':
                tab = here(tab);
                if (await toNameScreen(tab)) {
                    fireEvent.change(tab.scope.getByTestId('join-callsign'), { target: { value: 'Bea' } });
                    fireEvent.click(tab.scope.getByTestId('join-name-next'));
                    await settle(tab);
                }
                break;
            case 'Try again': {
                tab = here(tab);
                await settle(tab);
                const again = tab.scope.queryAllByRole('button', { name: /^(Try again|Check again)$/ })[0];
                if (again && !gone(tab)) {
                    fireEvent.click(again);
                    await settle(tab);
                }
                break;
            }
            case 'restore another key after the TTL':
                tab = reopenAfterTtl({ restored: other });
                await settle(tab);
                break;
            case 'a second tab (opened before the join went): Change name + Back':
                if (await toNameScreen(second!)) {
                    click(second!, '← Back');
                    await settle(second!);
                }
                break;
            case 'a second tab (opened before the join went): Change name + Next, then a reload after the TTL':
                if (await toNameScreen(second!)) {
                    fireEvent.change(second!.scope.getByTestId('join-callsign'), { target: { value: 'Bea' } });
                    fireEvent.click(second!.scope.getByTestId('join-name-next'));
                    await settle(second!);
                }
                tab = reopenAfterTtl();
                await settle(tab);
                break;
        }
        expectKeyKept(world, log, `after "${action}"`);
    }, 20_000);
});

describe('the reviewers\' reproductions, one by one', () => {
    const keyOf = (init: RequestInit) => (init.headers as Record<string, string>)['X-Public-Key'];

    it('4106400570: a 200 whose body is cut off is not a refusal: the key stays sent, "← Change name" then "← Back" keeps it, and the page never says "could not add you (200)"', async () => {
        await seed();
        stubNode({ name: '200 cut off', reply: raw(200, '{"success":tr'), says: 'nothing' }, { took: true, node: 'down' });
        const tab = open({ authReturn: googleReturn() });
        await settle(tab);
        expect(peekPending()).toMatchObject({ identity: { publicKey: me.publicKey }, sentAt: expect.any(Number) });
        expect(tab.container.textContent).not.toContain('could not add you (200)');
        expect(await toNameScreen(tab)).toBe(true);
        click(tab, '← Back');
        await settle(tab);
        expect(await loadPendingJoin()).toMatchObject({ identity: { publicKey: me.publicKey, mnemonic: me.mnemonic }, sentAt: expect.any(Number) });
        expect(peekIdentity()).toBeUndefined();
    });

    it('4106400570: a 200 with no body, the tab closed and reopened after its clock ran out: the node is asked, says member, and the member is in', async () => {
        const { p } = await seed();
        const { members } = stubNode({ name: '200 no body', reply: raw(200, null), says: 'nothing' }, { took: true, node: 'down' });
        const tab = open({ authReturn: googleReturn() });
        await settle(tab);
        cleanup();
        vi.spyOn(Date, 'now').mockReturnValue(p.expiresAt + MIN);
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => (
            String(input).startsWith('/api/community/membership/')
                ? json(200, { isMember: members.has(keyOf(init)), callsign: 'Alice' })
                : json(404, { error: 'Not Found' }))));
        const again = open();
        await waitFor(() => expect(again.onJoined).toHaveBeenCalledTimes(1));
        expect(again.onJoined.mock.calls[0][0]).toMatchObject({ identity: { publicKey: me.publicKey, mnemonic: me.mnemonic }, restored: false });
        expect(peekIdentity()?.publicKey).toBe(me.publicKey);
    });

    it('4106400570: a 409 whose body is lost is not "already joined": the key stays sent', async () => {
        await seed();
        stubNode({ name: '409 lost', reply: raw(409, null), says: 'nothing' }, { took: true, node: 'down' });
        const tab = open({ authReturn: googleReturn() });
        await settle(tab);
        expect(screenOf(tab)).not.toBe('already_joined');
        expect(peekPending()).toMatchObject({ identity: { publicKey: me.publicKey }, sentAt: expect.any(Number) });
    });

    for (const [status, body] of [[404, { code: 'invite_only', error: 'This community is invite-only.' }], [429, { error: 'Too many attempts. Try again in 42s' }]] as const) {
        it(`4106400810: "Try again" after a 503 asks the node first; a member is in, and no second join goes to be answered ${status}`, async () => {
            await seed();
            const members = new Set<string>();
            let joins = 0;
            vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
                const path = String(input);
                if (path === '/api/join') {
                    members.add(keyOf(init));
                    return ++joins === 1 ? json(503, { code: 'sign_in_unavailable', error: 'Google sign-in could not be checked right now.' }) : json(status, body);
                }
                if (path.startsWith('/api/community/membership/')) return json(200, { isMember: members.has(keyOf(init)), callsign: 'Alice' });
                return json(404, { error: 'Not Found' });
            }));
            const tab = open({ authReturn: googleReturn() });
            await settle(tab);
            if (!tab.onJoined.mock.calls.length) {
                fireEvent.click(tab.scope.getByRole('button', { name: 'Try again' }));
                await settle(tab);
            }
            expect(tab.onJoined).toHaveBeenCalledTimes(1);
            expect(joins).toBe(1);
            expect(peekIdentity()?.publicKey).toBe(me.publicKey);
        });

        it(`4106400810: a 503, then the node says not a member, and the join sent again is answered ${status}: the key stays sent, for the first join may land yet`, async () => {
            await seed();
            let joins = 0;
            vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
                const path = String(input);
                if (path === '/api/join') return ++joins === 1 ? json(503, { code: 'sign_in_unavailable', error: 'x' }) : json(status, body);
                if (path.startsWith('/api/community/membership/')) return json(200, { isMember: false, callsign: null });
                if (path === '/api/join/sso-nonce') return json(200, { nonce: 'n2', expiresInSeconds: 600, providers: ['google'], clientIds: { google: 'g' } });
                return json(404, { error: 'Not Found' });
            }));
            const tab = open({ authReturn: googleReturn() });
            await settle(tab);
            fireEvent.click(tab.scope.getByRole('button', { name: 'Try again' }));
            await settle(tab);
            expect(joins).toBe(2);
            const kept = peekPending();
            expect(kept).toMatchObject({ identity: { publicKey: me.publicKey }, sentAt: expect.any(Number) });
            // Not re-clocked into an unsent key that its hour would drop.
            expect(kept?.sentAt).toEqual(expect.any(Number));
        });
    }

    it('4106401013: a second tab whose copy is unsent never undoes the mark: "← Change name" then "← Back" keeps the key, and Next keeps the stored sentAt', async () => {
        const { p } = await seed();
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input) === '/api/join/sso-nonce'
            ? json(200, { nonce: 'n', expiresInSeconds: 600, providers: ['google'], clientIds: { google: 'g' } })
            : String(input).startsWith('/api/members/callsign-available/') ? json(200, { available: true }) : unreachable())));
        const tabB = open();
        await settle(tabB);
        expect(screenOf(tabB)).toBe('providers');
        // Tab A sends the join, the node takes it, the answer is lost, and tab A is closed: all tab B sees is this.
        const sentAt = Date.now();
        await savePendingJoin({ ...p, nonce: null, sentAt });

        expect(await toNameScreen(tabB)).toBe(true);
        fireEvent.change(tabB.scope.getByTestId('join-callsign'), { target: { value: 'Bea' } });
        fireEvent.click(tabB.scope.getByTestId('join-name-next'));
        await settle(tabB);
        expect(peekPending()).toMatchObject({ identity: { publicKey: me.publicKey }, sentAt });

        expect(await toNameScreen(tabB)).toBe(true);
        click(tabB, '← Back');
        await settle(tabB);
        expect(peekPending()).toMatchObject({ identity: { publicKey: me.publicKey, mnemonic: me.mnemonic }, sentAt });
    });

    it('4106401183: a key restored while a sent join may still land: its own words, the time left, and a way back', async () => {
        const t0 = Date.now();
        await savePendingJoin({ identity: me, provider: 'google', nonce: null, startedAt: t0 - 4 * MIN, expiresAt: t0 + 6 * MIN, restored: false, sentAt: t0 - MIN });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input).startsWith('/api/community/membership/')
            ? json(200, { isMember: false, callsign: null }) : json(404, { error: 'Not Found' }))));
        const tab = open({ restored: other });
        await settle(tab);
        expect(screenOf(tab)).toBe('held');
        const text = tab.scope.getByTestId('join-held').textContent ?? '';
        expect(text).toContain('may still go through');
        expect(text).toContain('Alice');
        expect(text).toMatch(/about 10 minutes/);
        expect(text).not.toMatch(/check your connection/i);
        expect(tab.scope.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
        expect(tab.scope.getByRole('button', { name: 'Finish joining as Alice' })).toBeInTheDocument();
        click(tab, '← Back');
        await settle(tab);
        expect(screenOf(tab)).toBe('lobby');
        expect(peekPending()).toMatchObject({ identity: { publicKey: me.publicKey }, sentAt: t0 - MIN });
    });

    it('4106401183: once that join can no longer land, the member may let it go, told what that means, and only then does the restored key take the slot', async () => {
        const t0 = Date.now();
        await savePendingJoin({ identity: me, provider: 'google', nonce: null, startedAt: t0 - 30 * MIN, expiresAt: t0 - 20 * MIN, restored: false, sentAt: t0 - 25 * MIN });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const path = String(input);
            if (path.startsWith('/api/community/membership/')) return json(200, { isMember: false, callsign: null });
            if (path === '/api/join/sso-nonce') return json(200, { nonce: 'n', expiresInSeconds: 600, providers: ['google'], clientIds: { google: 'g' } });
            return json(404, { error: 'Not Found' });
        }));
        const tab = open({ restored: other });
        await settle(tab);
        expect(screenOf(tab)).toBe('held');
        expect(tab.scope.getByTestId('join-held')).toHaveTextContent("isn't a member");
        click(tab, 'Use Phoebe instead');
        await settle(tab);
        expect(screenOf(tab)).toBe('abandon');
        expect(tab.scope.getByTestId('join-abandon')).toHaveTextContent('for good');
        // Not yet: nothing has changed until the member says so.
        expect(peekPending()?.identity.publicKey).toBe(me.publicKey);
        click(tab, '← Keep it');
        await settle(tab);
        expect(screenOf(tab)).toBe('held');
        click(tab, 'Use Phoebe instead');
        await settle(tab);
        click(tab, 'Let go of Alice');
        await settle(tab);
        expect(screenOf(tab)).toBe('providers');
        expect(tab.scope.getByTestId('join-as')).toHaveTextContent('Phoebe');
        expect(peekPending()).toMatchObject({ restored: true, identity: { publicKey: other.publicKey } });
        expect(peekPending()?.sentAt).toBeUndefined();
    });

    it('4106401367: under <StrictMode> the sign-in buttons appear', async () => {
        await seed();
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input) === '/api/join/sso-nonce'
            ? json(200, { nonce: 'n', expiresInSeconds: 600, providers: ['google', 'github'], githubFlow: 'node', clientIds: { google: 'g' } })
            : json(404, { error: 'Not Found' }))));
        const tab = open({ strict: true });
        expect(await tab.scope.findByTestId('join-provider-google')).toBeInTheDocument();
        expect(tab.scope.getByTestId('join-provider-github')).toBeInTheDocument();
    });

    it('4106401367: under <StrictMode> a sent join settles: the node says member, and the member is in', async () => {
        const t0 = Date.now();
        await savePendingJoin({ identity: me, provider: 'google', nonce: null, startedAt: t0, expiresAt: t0 + 6 * MIN, restored: false, sentAt: t0 });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input).startsWith('/api/community/membership/')
            ? json(200, { isMember: true, callsign: 'Alice' }) : json(404, { error: 'Not Found' }))));
        const tab = open({ strict: true });
        await waitFor(() => expect(tab.onJoined).toHaveBeenCalledTimes(1));
        expect(peekIdentity()?.publicKey).toBe(me.publicKey);
    });

    it('4106401367: under <StrictMode> a join sent from the return settles too', async () => {
        await seed();
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input) === '/api/join'
            ? json(200, { success: true, member: { callsign: 'Alice' } }) : json(404, { error: 'Not Found' }))));
        const tab = open({ strict: true, authReturn: googleReturn() });
        await waitFor(() => expect(tab.onJoined).toHaveBeenCalledTimes(1));
        expect(peekIdentity()?.publicKey).toBe(me.publicKey);
    });
});
