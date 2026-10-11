/**
 * WelcomePage and "An admin gave me a re-key code" (#1768; design DESIGN-rekey-redeem-fable.md §5, §8): the option on the
 * restore screen, `/?rekey=` opening it, a new key in the pending-join slot marked sent before the ask goes, the number
 * shown, and `bound` saving the key as this browser's account through the guarded write. The node is a stubbed fetch over
 * the real identity store (an in-memory IndexedDB).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { generateIdentity, importIdentity, loadIdentity, loadPendingJoin, type BeanPoolIdentity, type PendingJoin } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { WEB_REKEY_POLL_MS } from '../lib/web-rekey';

type Handler = (body: any, path: string) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} };

function stubNode(handlers: Record<string, Handler> = {}) {
    const calls: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '');
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body, headers: (init.headers ?? {}) as Record<string, string> });
        if (path === '/api/community/info') return json(200, LOCAL);
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        if (key) return handlers[key](body, path);
        return json(200, {});
    }));
    return calls;
}

const CODE = 'RK-AB12-CD34';

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCapturedAuthReturn();
});

describe('An admin gave me a re-key code', () => {
    it('is an option among the ways to restore, and opens the code screen', async () => {
        stubNode();
        render(<WelcomePage onComplete={vi.fn()} start="restore" />);
        fireEvent.click(await screen.findByRole('button', { name: /An admin gave me a re-key code/ }));
        expect(await screen.findByTestId('web-rekey-form')).toBeTruthy();
        expect(screen.getByLabelText('The code')).toHaveValue('');
    });

    it('/?rekey= from the admin\'s QR opens it with the code filled in', async () => {
        stubNode();
        window.history.replaceState(null, '', `/app?rekey=${CODE.toLowerCase()}`);
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByTestId('web-rekey-form')).toBeTruthy();
        expect(screen.getByLabelText('The code')).toHaveValue(CODE);
    });

    it('a new key is in the pending-join slot, marked sent, before the ask goes; the number shows; bound saves it', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let atAsk: PendingJoin | null = null;
        let polls = 0;
        const calls = stubNode({
            '/api/member/re-enroll/status': () => { polls++; return json(200, { state: 'bound', callsign: 'MiaMember', communityName: 'Mullum' }); },
            '/api/member/re-enroll': async () => {
                atAsk = await loadPendingJoin();
                return json(200, { state: 'waiting', match: '47', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
            },
        });
        window.history.replaceState(null, '', `/app?rekey=${CODE}`);
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

        expect((await screen.findByTestId('web-rekey-number')).textContent).toBe('47');
        const ask = calls.find((c) => c.path === '/api/member/re-enroll')!;
        expect(atAsk).not.toBeNull();
        expect(atAsk!.identity.publicKey).toBe(ask.body.newPublicKey);
        expect(typeof atAsk!.sentAt).toBe('number');
        expect(ask.body).toMatchObject({ code: CODE, signedFor: 'localhost' });
        expect(ask.headers['X-Public-Key']).toBe(ask.body.newPublicKey);
        expect(await loadIdentity()).toBeNull();

        await act(async () => { await vi.advanceTimersByTimeAsync(WEB_REKEY_POLL_MS + 50); });
        expect(await screen.findByTestId('web-rekey-words')).toBeTruthy();
        expect(polls).toBeGreaterThanOrEqual(1);
        const saved = (await loadIdentity())!;
        expect(saved.publicKey).toBe(ask.body.newPublicKey);
        expect(saved.callsign).toBe('MiaMember');
        expect(saved.mnemonic?.length).toBe(12);
        expect(await loadPendingJoin()).toBeNull();
        expect(screen.getByText(/12 words of your NEW key/)).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        expect(await screen.findByTestId('web-rekey-link-again')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(onComplete.mock.calls[0][0]).toMatchObject({ publicKey: saved.publicKey, callsign: 'MiaMember' });
        expect(window.location.search).toBe('');
    });

    it('a browser with an account asks with that key, and makes none', async () => {
        const mine: BeanPoolIdentity = await generateIdentity('Ada');
        await importIdentity(mine);
        const calls = stubNode({
            '/api/member/re-enroll': () => json(200, { state: 'waiting', match: '13', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
        });
        render(<WelcomePage onComplete={vi.fn()} start="restore" />);
        fireEvent.click(await screen.findByRole('button', { name: /An admin gave me a re-key code/ }));
        fireEvent.change(screen.getByLabelText('The code'), { target: { value: CODE } });
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        expect((await screen.findByTestId('web-rekey-number')).textContent).toBe('13');
        expect(calls.find((c) => c.path === '/api/member/re-enroll')!.body.newPublicKey).toBe(mine.publicKey);
        expect(await loadPendingJoin()).toBeNull();
        expect((await loadIdentity())?.publicKey).toBe(mine.publicKey);
    });

    it('a dead code: the node\'s one sentence, and the new key is let go', async () => {
        stubNode({
            '/api/member/re-enroll': () => json(404, { error: 'That code isn’t valid. Ask the admin for a new one.', code: 'code_not_valid' }),
        });
        window.history.replaceState(null, '', `/app?rekey=${CODE}`);
        render(<WelcomePage onComplete={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
        expect(await screen.findByText('That code isn’t valid. Ask the admin for a new one.')).toBeTruthy();
        await waitFor(async () => expect(await loadPendingJoin()).toBeNull());
        expect(await loadIdentity()).toBeNull();
    });
});
