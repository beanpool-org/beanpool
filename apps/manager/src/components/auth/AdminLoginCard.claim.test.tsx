import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

// The QR's text is what matters here, not its picture: record what the card asks to encode.
const qrTexts: string[] = [];
vi.mock('../../lib/qr', () => ({
    generateOfflineQrUrl: (text: string) => {
        qrTexts.push(text);
        return `data:text/plain,${encodeURIComponent(text)}`;
    },
}));

import { AdminLoginCard } from './AdminLoginCard';
import { CLAIM_POLL_MS, CLAIM_TIMEOUT_MS } from '../../lib/node-claim';

/**
 * The unclaimed card (sign-in step 8, stage B4): before sign-in the page asks GET /api/local/claim, and while the node
 * has no owner it shows how to claim it instead of the password form. The page is public: the QR carries the node's
 * address and the code's public id, never the code.
 */

const CODE_ID = 'a1b2c3d4';
const CLAIM_CODE = 'claim-1111-2222-3333-4444'; // what the server holds; must never reach this page's QR

type Answer = { status: number; body?: unknown } | 'network-error' | 'not-json' | 'hang';

function stubNode(answers: Answer[], opts: { communityInfo?: { primaryAddress?: string | null; addresses?: string[] } } = {}) {
    const claimCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const infoCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    let i = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/local/claim')) {
            claimCalls.push({ url, init });
            const answer = answers[Math.min(i++, answers.length - 1)];
            if (answer === 'network-error') throw new TypeError('Failed to fetch');
            if (answer === 'hang') {
                return new Promise<Response>((_, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                });
            }
            if (answer === 'not-json') {
                return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } } as unknown as Response;
            }
            return {
                ok: answer.status >= 200 && answer.status < 300,
                status: answer.status,
                json: async () => answer.body,
            } as Response;
        }
        if (url.endsWith('/api/community/info')) {
            infoCalls.push({ url, init });
            return {
                ok: true,
                status: 200,
                json: async () => opts.communityInfo ?? { addresses: [], primaryAddress: null },
            } as Response;
        }
        throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, claimCalls, infoCalls };
}

const unclaimed = (extra: Record<string, unknown> = {}): Answer => ({
    status: 200,
    body: { unclaimed: true, codeId: CODE_ID, communityName: 'Test Town', ...extra },
});
const claimed: Answer = { status: 200, body: { unclaimed: false } };

let hidden = false;

describe('AdminLoginCard: the unclaimed card', () => {
    const onPasswordSession = vi.fn();
    const onKeySession = vi.fn();

    beforeEach(() => {
        qrTexts.length = 0;
        hidden = false;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function renderCard(nodeUrl = window.location.origin) {
        return render(
            <AdminLoginCard nodeUrl={nodeUrl} onPasswordSession={onPasswordSession} onKeySession={onKeySession} />,
        );
    }


    it('asks the claim route with no cookie and, while the node is unclaimed, shows the card instead of the form', async () => {
        const { claimCalls } = stubNode([unclaimed()]);
        renderCard();

        expect(await screen.findByText('This community has no owner yet.')).toBeInTheDocument();
        expect(screen.getByTestId('claim-card')).toHaveTextContent('On the server, run:');
        expect(screen.getByTestId('claim-command')).toHaveTextContent('docker compose exec beanpool-node beanpool claim');
        expect(screen.getByTestId('claim-card')).toHaveTextContent('Then on your phone, open BeanPool → Claim a community, or scan this.');
        // The form is not the page's first thing any more, and no phone sign-in is offered: no one can sign in yet.
        expect(screen.queryByRole('button', { name: /Unlock Settings/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /Sign in with your phone/i })).toBeNull();

        expect(claimCalls).toHaveLength(1);
        expect(claimCalls[0].init?.credentials).toBe('omit');
        expect(JSON.stringify(claimCalls[0].init?.headers ?? {})).not.toMatch(/authorization|x-csrf/i);
    });

    it('draws a QR of beanpool://claim with this page\'s origin and the code id, and never the code', async () => {
        stubNode([unclaimed({ code: CLAIM_CODE })]);
        renderCard();
        const img = await screen.findByTestId('claim-qr');

        const text = qrTexts[qrTexts.length - 1];
        expect(text).toBe(`beanpool://claim?node=${encodeURIComponent(window.location.origin)}&id=${CODE_ID}`);
        expect(text).not.toContain(CLAIM_CODE);
        expect(text).not.toMatch(/claim-[0-9a-f]{4}/i);
        expect(text).not.toMatch(/[?&]code=/);
        expect(img.getAttribute('src')).toBe(`data:text/plain,${encodeURIComponent(text)}`);
        // The address the QR names is written out too, so a reader can check it.
        expect(screen.getByTestId('claim-origin')).toHaveTextContent(window.location.origin);
    });

    it('leaves the id out of the QR when the node has no code waiting', async () => {
        stubNode([unclaimed({ codeId: null })]);
        renderCard();
        await screen.findByTestId('claim-qr');
        expect(qrTexts[qrTexts.length - 1]).toBe(`beanpool://claim?node=${encodeURIComponent(window.location.origin)}`);
    });

    it('puts nothing but a code id in the QR, whatever the node answers as one', async () => {
        stubNode([unclaimed({ codeId: CLAIM_CODE })]);
        renderCard();
        await screen.findByTestId('claim-qr');
        expect(qrTexts[qrTexts.length - 1]).toBe(`beanpool://claim?node=${encodeURIComponent(window.location.origin)}`);
    });

    it('reads community info once across several polls', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        const { claimCalls, infoCalls } = stubNode(
            [unclaimed(), unclaimed(), unclaimed(), unclaimed()],
            { communityInfo: { primaryAddress: 'town.beanpool.org', addresses: ['town.beanpool.org'] } },
        );
        renderCard('https://town.beanpool.org');
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(claimCalls).toHaveLength(1);
        expect(infoCalls).toHaveLength(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS); });
        expect(claimCalls).toHaveLength(2);
        expect(infoCalls).toHaveLength(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS); });
        expect(claimCalls).toHaveLength(3);
        expect(infoCalls).toHaveLength(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS); });
        expect(claimCalls).toHaveLength(4);
        expect(infoCalls).toHaveLength(1);
    });

    it('keeps http and port in the QR when opened at an http LAN page origin with a matching listed host', async () => {
        const lanOrigin = 'http://192.168.1.100:8080';
        const origLocation = window.location;
        const win = window as unknown as { location: Location };
        delete (window as { location?: Location }).location;
        win.location = new URL(lanOrigin) as unknown as Location;
        try {
            stubNode([unclaimed()], {
                communityInfo: { primaryAddress: '192.168.1.100', addresses: ['192.168.1.100'] },
            });
            renderCard(lanOrigin);
            await screen.findByTestId('claim-qr');
            expect(qrTexts[qrTexts.length - 1]).toBe(`beanpool://claim?node=${encodeURIComponent(lanOrigin)}&id=${CODE_ID}`);
            expect(screen.getByTestId('claim-origin')).toHaveTextContent(lanOrigin);
            expect(screen.queryByTestId('claim-unlisted-notice')).toBeNull();
        } finally {
            win.location = origLocation;
        }
    });

    it('keeps :8443 in the QR for page on https://town.example.org:8443 listed as town.example.org', async () => {
        const portOrigin = 'https://town.example.org:8443';
        const origLocation = window.location;
        const win = window as unknown as { location: Location };
        delete (window as { location?: Location }).location;
        win.location = new URL(portOrigin) as unknown as Location;
        try {
            stubNode([unclaimed()], {
                communityInfo: { primaryAddress: 'town.example.org', addresses: ['town.example.org'] },
            });
            renderCard(portOrigin);
            await screen.findByTestId('claim-qr');
            expect(qrTexts[qrTexts.length - 1]).toBe(`beanpool://claim?node=${encodeURIComponent(portOrigin)}&id=${CODE_ID}`);
            expect(screen.getByTestId('claim-origin')).toHaveTextContent(portOrigin);
            expect(screen.queryByTestId('claim-unlisted-notice')).toBeNull();
        } finally {
            win.location = origLocation;
        }
    });

    it('shows the line "Open this page at ... to scan" instead of the QR when page host is unlisted with a listed name', async () => {
        stubNode([unclaimed()], {
            communityInfo: { primaryAddress: 'town.beanpool.org', addresses: ['town.beanpool.org'] },
        });
        renderCard(); // opened at window.location.origin (http://localhost:3000, not town.beanpool.org)
        const notice = await screen.findByTestId('claim-unlisted-notice');
        expect(notice).toHaveTextContent('Open this page at https://town.beanpool.org to scan');
        expect(screen.queryByTestId('claim-qr')).toBeNull();
    });

    it('draws QR with page origin and no line when listed names all fail sanitising', async () => {
        stubNode([unclaimed()], {
            communityInfo: {
                primaryAddress: 'javascript:alert(1)',
                addresses: ['javascript:alert(1)', 'ftp://files.example.com', '//hostile.example.com'],
            },
        });
        renderCard();
        await screen.findByTestId('claim-qr');
        expect(qrTexts[qrTexts.length - 1]).toBe(`beanpool://claim?node=${encodeURIComponent(window.location.origin)}&id=${CODE_ID}`);
        expect(screen.getByTestId('claim-origin')).toHaveTextContent(window.location.origin);
        expect(screen.queryByTestId('claim-unlisted-notice')).toBeNull();
    });

    it('draws QR with page origin when community addresses list is empty', async () => {
        stubNode([unclaimed()], {
            communityInfo: { primaryAddress: null, addresses: [] },
        });
        renderCard();
        await screen.findByTestId('claim-qr');
        expect(qrTexts[qrTexts.length - 1]).toBe(`beanpool://claim?node=${encodeURIComponent(window.location.origin)}&id=${CODE_ID}`);
        expect(screen.getByTestId('claim-origin')).toHaveTextContent(window.location.origin);
        expect(screen.queryByTestId('claim-unlisted-notice')).toBeNull();
    });



    it('shows the sign-in form when the node has an owner', async () => {
        const { claimCalls } = stubNode([claimed]);
        renderCard();
        await waitFor(() => expect(claimCalls).toHaveLength(1));
        expect(screen.getByRole('button', { name: /Unlock Settings/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Sign in with your phone/i })).toBeInTheDocument();
        expect(screen.queryByTestId('claim-card')).toBeNull();
    });

    it('shows the phone sign-in and no password form on a claimed server with no admin password (a new install)', async () => {
        const { claimCalls } = stubNode([{ status: 200, body: { unclaimed: false, password: false } }]);
        renderCard();
        const box = await screen.findByTestId('no-password-signin');
        expect(box).toHaveTextContent('This server has no admin password. Owners and admins sign in with the BeanPool app on your phone.');
        expect(box).not.toHaveTextContent(/retired/);
        expect(screen.getByTestId('phone-signin')).toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Password')).toBeNull();
        expect(screen.queryByRole('button', { name: /Unlock Settings/i })).toBeNull();
        expect(screen.queryByTestId('password-retired-signin')).toBeNull();
        expect(claimCalls).toHaveLength(1);
    });

    it('says an owner retired the password only when the claim answer says so', async () => {
        stubNode([{ status: 200, body: { unclaimed: false, password: false, passwordRetired: true } }]);
        renderCard();
        expect(await screen.findByTestId('password-retired-signin')).toHaveTextContent('This server has no admin password: an owner retired it.');
        expect(screen.queryByTestId('no-password-signin')).toBeNull();
        expect(screen.queryByPlaceholderText('Password')).toBeNull();
    });

    it('asks again every 5 s and swaps to the sign-in form the moment the node is claimed, then stops asking', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        const { claimCalls } = stubNode([unclaimed(), unclaimed(), claimed]);
        renderCard();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByTestId('claim-card')).toBeInTheDocument();
        expect(claimCalls).toHaveLength(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS - 1); });
        expect(claimCalls).toHaveLength(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(claimCalls).toHaveLength(2);
        expect(screen.getByTestId('claim-card')).toBeInTheDocument();

        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS); });
        expect(claimCalls).toHaveLength(3);
        expect(screen.queryByTestId('claim-card')).toBeNull();
        expect(screen.getByRole('button', { name: /Unlock Settings/i })).toBeInTheDocument();

        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS * 4); });
        expect(claimCalls).toHaveLength(3);
    });

    it('stops asking when the page is closed', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        const { claimCalls } = stubNode([unclaimed()]);
        const view = renderCard();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(claimCalls).toHaveLength(1);
        view.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS * 4); });
        expect(claimCalls).toHaveLength(1);
    });

    it('stops asking while the tab is hidden and asks at once when it is shown again', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        const { claimCalls } = stubNode([unclaimed(), claimed]);
        renderCard();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(claimCalls).toHaveLength(1);

        hidden = true;
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS * 4); });
        expect(claimCalls).toHaveLength(1);
        expect(screen.getByTestId('claim-card')).toBeInTheDocument();

        hidden = false;
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(claimCalls).toHaveLength(2);
        expect(screen.queryByTestId('claim-card')).toBeNull();
    });

    it('keeps the card when one later ask fails, and keeps asking', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        const { claimCalls } = stubNode([unclaimed(), 'network-error', claimed]);
        renderCard();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS); });
        expect(claimCalls).toHaveLength(2);
        expect(screen.getByTestId('claim-card')).toBeInTheDocument();
        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS); });
        expect(claimCalls).toHaveLength(3);
        expect(screen.queryByTestId('claim-card')).toBeNull();
    });

    it('keeps today\'s password form under a closed fold, and it still signs in', async () => {
        const { fetchMock } = stubNode([unclaimed()]);
        renderCard();
        const fold = await screen.findByTestId('claim-password-fold');
        expect(fold.tagName).toBe('DETAILS');
        expect(fold).not.toHaveAttribute('open');
        expect(fold.querySelector('summary')).toHaveTextContent('This server also has an admin password');
        // The form is the card's second thing, under the claim, not beside it.
        const card = screen.getByTestId('claim-card');
        expect(card.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        fireEvent.click(fold.querySelector('summary')!);
        const input = screen.getByPlaceholderText('Password');
        expect(fold).toContainElement(input);

        fetchMock.mockImplementationOnce(async () => ({
            ok: true, status: 200, json: async () => ({ success: true, role: 'owner', csrfToken: 'csrf-fold' }),
        }) as Response);
        fireEvent.change(input, { target: { value: 'pw' } });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));
        await waitFor(() => expect(onPasswordSession).toHaveBeenCalledWith('csrf-fold', false));
    });

    it('has no fold and no password form when the node answers password: false', async () => {
        stubNode([unclaimed({ password: false })]);
        renderCard();
        await screen.findByTestId('claim-card');
        expect(screen.queryByTestId('claim-password-fold')).toBeNull();
        expect(screen.queryByText('This server also has an admin password')).toBeNull();
        expect(screen.queryByPlaceholderText('Password')).toBeNull();
    });

    it('keeps the fold for any answer other than password: false', async () => {
        stubNode([unclaimed({ password: true })]);
        renderCard();
        expect(await screen.findByTestId('claim-password-fold')).toBeInTheDocument();
    });

    it.each([
        ['an unreachable node', 'network-error' as Answer],
        ['a server error', { status: 500, body: { error: 'boom' } } as Answer],
        ['an older node without the route', { status: 404, body: { error: 'Not Found' } } as Answer],
        ['an answer that is not JSON (a proxy page)', 'not-json' as Answer],
        ['an answer of the wrong shape', { status: 200, body: { hello: 'world' } } as Answer],
    ])('shows today\'s sign-in, and asks no more, after %s', async (_label, answer) => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        const { claimCalls } = stubNode([answer, unclaimed()]);
        renderCard();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(claimCalls).toHaveLength(1);
        expect(screen.getByRole('button', { name: /Unlock Settings/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Sign in with your phone/i })).toBeInTheDocument();
        expect(screen.queryByTestId('claim-card')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS * 4); });
        expect(claimCalls).toHaveLength(1);
        expect(screen.queryByTestId('claim-card')).toBeNull();
    });

    it('never waits on the check: the sign-in is there while it is asked, and a check that hangs gives up', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
        const { claimCalls } = stubNode(['hang']);
        renderCard();
        // Before any answer.
        expect(screen.getByRole('button', { name: /Unlock Settings/i })).toBeInTheDocument();
        await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_TIMEOUT_MS); });
        expect((claimCalls[0].init?.signal as AbortSignal).aborted).toBe(true);
        expect(screen.getByRole('button', { name: /Unlock Settings/i })).toBeInTheDocument();
        expect(screen.queryByTestId('claim-card')).toBeNull();
    });

    it('keeps the password form open in the fold if the operator submitted before a slow claim check answered unclaimed', async () => {
        let resolveClaim!: (res: Response) => void;
        const claimPromise = new Promise<Response>((resolve) => {
            resolveClaim = resolve;
        });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/api/local/claim')) {
                return claimPromise;
            }
            if (url.endsWith('/api/local/admin/auth/password')) {
                return {
                    ok: false,
                    status: 401,
                    json: async () => ({ error: 'Invalid password' }),
                } as Response;
            }
            if (url.endsWith('/api/community/info')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ addresses: [], primaryAddress: null }),
                } as Response;
            }
            throw new Error(`unexpected request ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        renderCard();

        const passwordInput = screen.getByPlaceholderText('Password');
        fireEvent.change(passwordInput, { target: { value: 'wrong-password' } });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));

        expect(await screen.findByText('Invalid password')).toBeInTheDocument();

        await act(async () => {
            resolveClaim({
                ok: true,
                status: 200,
                json: async () => ({ unclaimed: true, codeId: CODE_ID }),
            } as Response);
        });

        expect(await screen.findByTestId('claim-card')).toBeInTheDocument();
        const fold = screen.getByTestId('claim-password-fold');
        expect(fold).toHaveAttribute('open');
        expect(screen.getByText('Invalid password')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
    });

    it('keeps the fold open with the 2FA field if 2FA was required before a slow claim check answered unclaimed', async () => {
        let resolveClaim!: (res: Response) => void;
        const claimPromise = new Promise<Response>((resolve) => {
            resolveClaim = resolve;
        });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/api/local/claim')) {
                return claimPromise;
            }
            if (url.endsWith('/api/local/admin/auth/password')) {
                return {
                    ok: false,
                    status: 401,
                    json: async () => ({ totpRequired: true, error: '2FA required' }),
                } as Response;
            }
            if (url.endsWith('/api/community/info')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ addresses: [], primaryAddress: null }),
                } as Response;
            }
            throw new Error(`unexpected request ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        renderCard();

        const passwordInput = screen.getByPlaceholderText('Password');
        fireEvent.change(passwordInput, { target: { value: 'my-password' } });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));

        expect(await screen.findByPlaceholderText(/6-digit code/)).toBeInTheDocument();

        await act(async () => {
            resolveClaim({
                ok: true,
                status: 200,
                json: async () => ({ unclaimed: true, codeId: CODE_ID }),
            } as Response);
        });

        expect(await screen.findByTestId('claim-card')).toBeInTheDocument();
        const fold = screen.getByTestId('claim-password-fold');
        expect(fold).toHaveAttribute('open');
        expect(screen.getByPlaceholderText(/6-digit code/)).toBeInTheDocument();
    });
});

