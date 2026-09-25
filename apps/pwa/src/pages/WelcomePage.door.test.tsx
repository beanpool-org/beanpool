/**
 * WelcomePage on a node whose door is open (design G11-b): which page a visitor gets, the steps after the join, and a
 * key restored here that is not a member yet. The node is a stubbed fetch; the join screens themselves are covered
 * in components/WebJoin.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { generateIdentity, loadIdentity, loadPendingJoin, savePendingJoin, PENDING_JOIN_TTL_MS, type BeanPoolIdentity } from '../lib/identity';
import { generateMnemonic } from '../lib/mnemonic';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

type Handler = (body: any) => Response;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubNode(info: unknown | Error, handlers: Record<string, Handler> = {}) {
    const calls: Array<{ path: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body });
        if (path === '/api/community/info') {
            if (info instanceof Error) throw info;
            return json(200, info);
        }
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        if (key) return handlers[key](body);
        return json(200, {});
    }));
    return calls;
}

const GLOBAL_OPEN = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true } };

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let identity: BeanPoolIdentity;
beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    identity = await generateIdentity('Alice');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCapturedAuthReturn();
});

describe('which welcome a visitor gets', () => {
    it('the open door: the join lobby, and never the invite form', async () => {
        stubNode(GLOBAL_OPEN);
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByTestId('join-screen-lobby');
        expect(screen.queryByText(/Join with Invite Code/)).toBeNull();
    });

    it('a local community: the invite form, as today', async () => {
        stubNode({ ...GLOBAL_OPEN, profile: 'local', features: { openJoin: false } });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        expect(screen.queryByTestId('join-start')).toBeNull();
    });

    it('a global node whose door is shut: the invite form', async () => {
        stubNode({ ...GLOBAL_OPEN, features: { openJoin: false } });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
    });

    it("an older node that says nothing about itself: the invite form", async () => {
        stubNode({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0 });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
    });

    it("no answer: says so in one line with Try again, and the page still works", async () => {
        stubNode(new TypeError('Failed to fetch'));
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByTestId('door-unreachable')).toHaveTextContent("Can't reach the community right now.");
        expect(screen.getByText(/Join with Invite Code/)).toBeInTheDocument();
    });
});

describe('after the door says yes: the same steps every new member has', () => {
    it('photo, 12 words, tour; "Sign in" on the bar, no going back, the new name said, storage kept', async () => {
        await savePendingJoin({ identity, provider: 'google', nonce: 'n1', startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
        const token = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: 'g1', nonce: 'n1' }))}.c2ln`;
        window.history.replaceState(null, '', `/app/auth/google#state=n1&id_token=${token}`);
        const calls = stubNode(GLOBAL_OPEN, {
            '/api/join': () => json(200, { success: true, member: { callsign: 'Alice2' } }),
        });
        const persist = vi.fn(async () => true);
        Object.defineProperty(navigator, 'storage', { value: { persist, persisted: vi.fn(async () => false) }, configurable: true });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);

        // The token left the address bar before anything else ran.
        expect(window.location.pathname).toBe('/app');
        expect(window.location.hash).toBe('');

        // Step 2, the photo.
        expect(await screen.findByTestId('joined-as-note')).toHaveTextContent("You're Alice2 here: Alice was taken.");
        expect(screen.getByTestId('onboarding-stepper')).toHaveTextContent('Sign in');
        expect(screen.queryByText('Your Name')).toBeNull();
        expect(screen.queryByRole('button', { name: '← Back' })).toBeNull();
        fireEvent.click(screen.getByTitle('Green Bean'));
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

        // Step 3, the 12 words of the key that joined.
        await screen.findByText(/Your Safety Backup/);
        for (const w of identity.mnemonic!) expect(screen.getAllByText(w).length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

        // Step 4, the tour, then in.
        fireEvent.click(await screen.findByRole('button', { name: "Let's Begin! 🚀" }));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(onComplete.mock.calls[0][0]).toMatchObject({ publicKey: identity.publicKey, callsign: 'Alice2' });
        expect(persist).toHaveBeenCalledTimes(1);
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
        // The door registered the member: nothing registers or redeems again.
        expect(calls.some((c) => c.path === '/api/community/register' || c.path === '/api/invite/redeem')).toBe(false);
        expect(calls.filter((c) => c.path === '/api/join')).toHaveLength(1);
    });
});

describe('a key restored here on the open door', () => {
    async function restoreWithWords(words: string[]) {
        await screen.findByTestId('join-screen-lobby');
        fireEvent.click(screen.getByRole('button', { name: 'Already have BeanPool?' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Use my 12 words' }));
        fireEvent.change(await screen.findByLabelText('Recovery word 1'), { target: { value: words.join(' ') } });
        fireEvent.click(screen.getByRole('button', { name: 'Recover Identity' }));
    }

    it('not a member here: nothing saved as the identity, and it goes through the door with the same key', async () => {
        const words = generateMnemonic();
        stubNode(GLOBAL_OPEN, {
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
            '/api/members/callsign-available/': () => json(200, { available: true }),
            '/api/join/sso-nonce': () => json(200, { nonce: 'n', expiresInSeconds: 600, providers: ['google'], clientIds: { google: 'g' } }),
        });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await restoreWithWords(words);
        // The 12 words carry no name: the door asks for one, for the same key.
        fireEvent.change(await screen.findByTestId('join-callsign'), { target: { value: 'Rowan' } });
        fireEvent.click(screen.getByTestId('join-name-next'));
        await screen.findByTestId('join-provider-google');
        const pending = (await loadPendingJoin())!;
        expect(pending.restored).toBe(true);
        expect(pending.identity.mnemonic).toEqual(words);
        expect(await loadIdentity()).toBeNull();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('already a member here: straight in with the name the node holds', async () => {
        stubNode(GLOBAL_OPEN, { '/api/community/membership/': () => json(200, { isMember: true, callsign: 'Sam' }) });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await restoreWithWords(generateMnemonic());
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(onComplete.mock.calls[0][0]).toMatchObject({ callsign: 'Sam' });
        expect((await loadIdentity())?.callsign).toBe('Sam');
        expect(await loadPendingJoin()).toBeNull();
    });

    it("the node can't be reached: says so on the words screen and saves nothing", async () => {
        stubNode(GLOBAL_OPEN, { '/api/community/membership/': () => { throw new TypeError('Failed to fetch'); } });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await restoreWithWords(generateMnemonic());
        expect(await screen.findByText("Can't reach the community right now. Try again in a minute.")).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Recover Identity' })).toBeInTheDocument();
        expect(await loadIdentity()).toBeNull();
        expect(onComplete).not.toHaveBeenCalled();
    });
});
