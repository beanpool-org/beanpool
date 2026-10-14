/**
 * "Link with Mobile App (Scan QR)" and number matching (fable-security-signin finding 1): once the phone has sent the
 * account, the relay holds it until this browser types the two digits the phone shows. The page swaps the QR for the
 * digit entry, sends what is typed to /api/pair/confirm, says so on wrong digits, and stops on a burned session. The
 * node is a stubbed fetch; the relay's side is test-pairing-routes / test-pairing-relay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

import { WelcomePage } from './WelcomePage';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const COMMUNITY = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} };

/** The relay: the phone has sent, so polls say "confirming"; /confirm answers from `answers` in turn. */
function stubRelay(answers: Array<[number, unknown]>, pollStatus = () => 'confirming') {
    const confirms: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '');
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        if (path === '/api/community/info') return json(200, COMMUNITY);
        if (path === '/api/pair/init') return json(200, { success: true, expiresAt: Date.now() + 120_000 });
        if (path.startsWith('/api/pair/poll')) return json(200, { status: pollStatus() });
        if (path === '/api/pair/confirm') {
            confirms.push(body);
            const [status, answer] = answers[Math.min(confirms.length - 1, answers.length - 1)];
            return json(status, answer);
        }
        return json(200, {});
    }));
    return confirms;
}

async function openQrAndWaitForDigits() {
    render(<WelcomePage onComplete={vi.fn()} start="restore" />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Link with Mobile App/ }))[0]);
    return screen.findByLabelText('Type the two digits your phone shows', {}, { timeout: 4_000 });
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCapturedAuthReturn();
});

describe('linking with the phone: the two digits', () => {
    it('swaps the QR for the digit entry once the phone has sent, and sends what is typed with the session', async () => {
        const confirms = stubRelay([[400, { result: 'wrong', triesLeft: 2 }], [200, { result: 'released' }]]);
        const input = await openQrAndWaitForDigits();
        expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
        expect((input as HTMLInputElement).inputMode).toBe('numeric');

        fireEvent.change(input, { target: { value: '4a7' } });
        expect((input as HTMLInputElement).value).toBe('47');
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await waitFor(() => expect(confirms.length).toBe(1));
        expect(confirms[0]).toEqual({ sessionId: expect.stringMatching(/^[0-9a-f]{16,64}$/), code: '47' });
        expect(await screen.findByText('Those are not the digits on the phone. Check them and try again.')).toBeTruthy();
        expect((input as HTMLInputElement).value).toBe('');

        fireEvent.change(input, { target: { value: '12' } });
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await waitFor(() => expect(confirms.length).toBe(2));
        expect(confirms[1].code).toBe('12');
        await waitFor(() => expect(screen.queryByText('Those are not the digits on the phone. Check them and try again.')).toBeNull());
    });

    it('stops on a burned session: nothing was sent, make a new code', async () => {
        stubRelay([[410, { result: 'burned' }]]);
        const input = await openQrAndWaitForDigits();
        fireEvent.change(input, { target: { value: '00' } });
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        expect(await screen.findByText('Too many wrong digits, so nothing was sent. Make a new code and try again.')).toBeTruthy();
        expect(screen.queryByLabelText('Type the two digits your phone shows')).toBeNull();
    });

    it('shows the QR, not the digit entry, while the phone has not sent', async () => {
        stubRelay([], () => 'waiting');
        render(<WelcomePage onComplete={vi.fn()} start="restore" />);
        fireEvent.click((await screen.findAllByRole('button', { name: /Link with Mobile App/ }))[0]);
        expect(await screen.findByRole('img', { name: /QR code/ })).toBeTruthy();
        await new Promise((r) => setTimeout(r, 1_700));
        expect(screen.queryByLabelText('Type the two digits your phone shows')).toBeNull();
    });
});
