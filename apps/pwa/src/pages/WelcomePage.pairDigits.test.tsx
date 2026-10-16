/**
 * "Link with Mobile App (Scan QR)" and number matching (fable-security-signin finding 1): once the phone has sent the
 * account, the relay holds it until this browser types the two digits the phone shows. The page swaps the QR for the
 * digit entry, sends what is typed to /api/pair/confirm, says so on wrong digits, and stops on a burned session. The
 * node is a stubbed fetch; the relay's side is test-pairing-routes / test-pairing-relay.
 *
 * And when nothing comes from the phone (Marty, 16 Oct: Damo's phone refused global's code as a server it doesn't use;
 * an old store app never shows the digits and the server now refuses its transfer): 20 s after the code went up the
 * page says both causes and what to do, naming the code's server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

import { WelcomePage } from './WelcomePage';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const COMMUNITY = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} };

/** The relay: the phone has sent, so polls say "confirming"; /confirm answers from `answers` in turn. */
function stubRelay(answers: Array<[number, unknown]>, pollStatus = () => 'confirming', pollCode = 200) {
    const confirms: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '');
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        if (path === '/api/community/info') return json(200, COMMUNITY);
        if (path === '/api/pair/init') return json(200, { success: true, expiresAt: Date.now() + 120_000 });
        if (path.startsWith('/api/pair/poll')) return json(pollCode, { status: pollStatus() });
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
    vi.useRealTimers();
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

    it('a page the relay cannot tie to its code (no binding cookie: another address) stops at once and says why', async () => {
        stubRelay([], () => 'wrong-browser', 403);
        render(<WelcomePage onComplete={vi.fn()} start="restore" />);
        fireEvent.click((await screen.findAllByRole('button', { name: /Link with Mobile App/ }))[0]);
        expect(await screen.findByText(/This page can't finish linking from here\. Open your community's own web address/, {}, { timeout: 4_000 })).toBeTruthy();
        expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    });

    it('the right digits from a page the relay cannot tie to its code: said, not "try again"', async () => {
        stubRelay([[403, { result: 'wrong-browser' }]]);
        const input = await openQrAndWaitForDigits();
        fireEvent.change(input, { target: { value: '12' } });
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        expect(await screen.findByText(/This page can't finish linking from here/)).toBeTruthy();
        expect(screen.queryByText('That did not go through. Try again.')).toBeNull();
    });

    it('shows the QR, not the digit entry, while the phone has not sent', async () => {
        stubRelay([], () => 'waiting');
        render(<WelcomePage onComplete={vi.fn()} start="restore" />);
        fireEvent.click((await screen.findAllByRole('button', { name: /Link with Mobile App/ }))[0]);
        expect(await screen.findByRole('img', { name: /QR code/ })).toBeTruthy();
        await new Promise((r) => setTimeout(r, 1_700));
        expect(screen.queryByLabelText('Type the two digits your phone shows')).toBeNull();
    });

    const SILENT = /^Nothing has come from your phone yet\. This code is from (\S+)\. If your phone says it is from a server it doesn't use, open BeanPool at your own community's address, or join \1 on your phone first, then scan again\. If your phone shows no digits, update the BeanPool app on it, then scan again\.$/;

    it('20 s with nothing from the phone: the page says both causes, naming the code\'s server; not before', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        stubRelay([], () => 'waiting');
        render(<WelcomePage onComplete={vi.fn()} start="restore" />);
        fireEvent.click((await screen.findAllByRole('button', { name: /Link with Mobile App/ }))[0]);
        expect(await screen.findByRole('img', { name: /QR code/ })).toBeTruthy();
        // From the countdown the page shows, not from the wall clock: real time also moves these timers, and on a busy
        // machine whole seconds pass between the code going up and the QR being found (one run in four failed at load 60).
        const left = () => Number(/Expires in (\d+) seconds/.exec(screen.getByLabelText(/Expires in \d+ seconds/).getAttribute('aria-label') ?? '')?.[1]);
        // The countdown's interval is set by an effect that, under load, runs after the QR is found: wait until it ticks
        // (real time moves it once it exists), or the advance below moves nothing (PR #2025 confirm-1 B1).
        await waitFor(() => expect(left()).toBeLessThan(120));
        expect(left()).toBeGreaterThanOrEqual(115);
        await act(async () => { vi.advanceTimersByTime((left() - 103) * 1_000); });
        expect(left()).toBeGreaterThan(100);
        expect(screen.queryByText(SILENT)).toBeNull();
        await act(async () => { vi.advanceTimersByTime(5_000); });
        expect(left()).toBeLessThanOrEqual(100);
        const hint = screen.getByText(SILENT);
        expect(hint.getAttribute('role')).toBe('status');
        expect(SILENT.exec(hint.textContent ?? '')?.[1]).toBe(window.location.host);
        // The QR stays up: the member can still scan it once the phone is ready.
        expect(screen.getByRole('img', { name: /QR code/ })).toBeTruthy();
    });

    it('no such line once the phone has sent: the digit entry is up instead', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        stubRelay([]);
        await openQrAndWaitForDigits();
        await act(async () => { vi.advanceTimersByTime(25_000); });
        expect(screen.queryByText(SILENT)).toBeNull();
    });
});
