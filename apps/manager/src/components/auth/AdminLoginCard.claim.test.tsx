import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

// The QR's text is what matters here, not its picture: record what the card asks to encode.
const qrTexts: string[] = [];
vi.mock('../../lib/qr', () => ({
    generateOfflineQrUrl: (text: string) => {
        qrTexts.push(text);
        return `data:text/plain,${encodeURIComponent(text)}`;
    },
}));

import { AdminLoginCard } from './AdminLoginCard';
import { CLAIM_POLL_MS } from '../../lib/node-claim';

/**
 * The unclaimed card (sign-in step 8, stage B4): before sign-in the page asks GET /api/local/claim, and while the node
 * has no owner it shows how to claim it instead of the password form. The page is public: the QR carries the node's
 * address and the code's public id, never the code.
 */

const CODE_ID = 'a1b2c3d4';
const CLAIM_CODE = 'claim-1111-2222-3333-4444'; // what the server holds; must never reach this page's QR

type Answer = { status: number; body?: unknown } | 'network-error';

function stubNode(answers: Answer[]) {
    const claimCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    let i = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/local/claim')) {
            claimCalls.push({ url, init });
            const answer = answers[Math.min(i++, answers.length - 1)];
            if (answer === 'network-error') throw new TypeError('Failed to fetch');
            return {
                ok: answer.status >= 200 && answer.status < 300,
                status: answer.status,
                json: async () => answer.body,
            } as Response;
        }
        throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, claimCalls };
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

    function renderCard() {
        return render(
            <AdminLoginCard nodeUrl={window.location.origin} onPasswordSession={onPasswordSession} onKeySession={onKeySession} />,
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

    it('shows the sign-in form when the node has an owner', async () => {
        const { claimCalls } = stubNode([claimed]);
        renderCard();
        await waitFor(() => expect(claimCalls).toHaveLength(1));
        expect(screen.getByRole('button', { name: /Unlock Settings/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Sign in with your phone/i })).toBeInTheDocument();
        expect(screen.queryByTestId('claim-card')).toBeNull();
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
});
