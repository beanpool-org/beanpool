/**
 * The yes shows itself (Damo, 9 Nov 2026: "he didn't see the admin acceptance because the PWA doesn't automatically
 * refresh the page — he had to press refresh"). The waiting page asks its community again by itself: every 20 s for the
 * first 10 minutes, every 60 s to the hour, every 5 minutes after; never while the tab is hidden; at once when the tab
 * comes back or the window is focused; slower on a 429. A yes changes the page to "said yes" and a big Join button, announced
 * politely to a screen reader, and takes the member nowhere by itself (a browser blocks that, and Join needs the tap).
 * Fake timers; the node is a stubbed read.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KnockWaitingPage } from './KnockWaitingPage';
import * as knockModule from '../lib/knock';
import * as apiModule from '../lib/api';
import * as askHereModule from '../components/AskHere';
import type { BeanPoolIdentity } from '../lib/identity';

const ME = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Sam', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const ORIGIN = 'https://byron.example.org';
const PENDING = { ok: true, value: { status: 'pending' } } as const;
const YES = { ok: true, value: { status: 'approved', invite: 'BP-YES1-CODE', expiresAt: null } } as const;

let read: MockInstance<typeof knockModule.readKnockStatus>;

function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
}

async function pass(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function open(handlers: Partial<Parameters<typeof KnockWaitingPage>[0]> = {}) {
    const props = { identity: ME, onJoin: vi.fn(), onInvite: vi.fn(), onSignIn: vi.fn(), onForgotten: vi.fn(), ...handlers };
    render(<KnockWaitingPage {...props} />);
    await pass(0);
    return props;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    localStorage.clear();
    vi.spyOn(askHereModule, 'thisCommunityOrigin').mockReturnValue(ORIGIN);
    vi.spyOn(apiModule, 'getCommunityCard').mockResolvedValue(null);
    read = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue(PENDING);
});
afterEach(() => {
    cleanup();
    setHidden(false);
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('a yes arrives while the page is open', () => {
    it('shows itself within a read or two, with no reload: "said yes" and the Join button', async () => {
        const props = await open();
        expect(read).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('knock-waiting-yes')).toBeNull();
        expect(screen.getByTestId('knock-waiting-line').textContent).toMatch(/arrived/i);

        await pass(30_000);
        // The member says yes at 30 s; the next read is at 48 s at the very latest (the one before was by 24 s, ±20% on 20 s).
        read.mockResolvedValue(YES);
        await pass(20_000);

        expect(screen.getByTestId('knock-waiting-yes').textContent).toContain('said yes');
        const join = screen.getByTestId('knock-waiting-join');
        expect(join.textContent).toContain('Join');
        // Nothing took the member anywhere: Join is theirs to tap.
        expect(props.onJoin).not.toHaveBeenCalled();
        fireEvent.click(join);
        expect(props.onJoin).toHaveBeenCalledWith({ invite: 'BP-YES1-CODE', name: expect.any(String) });
    });

    it('is announced politely: the yes comes into a region that was already on the page', async () => {
        await open();
        const region = screen.getByTestId('knock-waiting-live');
        expect(region.getAttribute('role')).toBe('status');
        expect(region.getAttribute('aria-live')).toBe('polite');
        expect(region.textContent).not.toContain('said yes');
        read.mockResolvedValue(YES);
        await pass(25_000);
        // The same region, now holding the yes: a screen reader hears what was put into it.
        expect(screen.getByTestId('knock-waiting-live')).toBe(region);
        expect(region.textContent).toContain('said yes');
    });

    it('the Join button is the first thing after the yes, and is big', async () => {
        read.mockResolvedValue(YES);
        await open();
        const join = screen.getByTestId('knock-waiting-join');
        // First in the card (the language switch above it is not part of the answer).
        expect(document.querySelector('section button, section a')).toBe(join);
        expect(join.className).toContain('min-h-[56px]');
        expect(join.className).toContain('text-lg');
    });

    it('asks nothing more once there is a yes', async () => {
        read.mockResolvedValue(YES);
        await open();
        expect(read).toHaveBeenCalledTimes(1);
        await pass(30 * 60_000);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('asks nothing more after the page is closed', async () => {
        await open();
        cleanup();
        read.mockClear();
        await pass(30 * 60_000);
        expect(read).not.toHaveBeenCalled();
    });
});

describe('how often it asks', () => {
    it('about every 20 s in the first 10 minutes (16 to 24 s), without flickering "Checking…"', async () => {
        await open();
        expect(read).toHaveBeenCalledTimes(1);
        await pass(15_999);
        expect(read).toHaveBeenCalledTimes(1);
        await pass(24_000 - 15_999);
        expect(read).toHaveBeenCalledTimes(2);
        // A read in the background does not turn the button into "Checking…".
        const check = screen.getByTestId('knock-waiting-check');
        expect(check.textContent).toBe('Check again');
        expect(check.hasAttribute('disabled')).toBe(false);
    });

    it('about once a minute after the first 10 minutes, and every 5 minutes after the hour', async () => {
        await open();
        await pass(10 * 60_000);
        read.mockClear();
        await pass(10 * 60_000);
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(8);
        expect(read.mock.calls.length).toBeLessThanOrEqual(12);
        await pass(60 * 60_000);
        read.mockClear();
        await pass(30 * 60_000);
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(5);
        expect(read.mock.calls.length).toBeLessThanOrEqual(7);
    });
});

describe('a hidden tab makes no requests', () => {
    it('puts the timer away while hidden, and reads once at once when the tab is back', async () => {
        await open();
        read.mockClear();
        setHidden(true);
        await pass(30 * 60_000);
        expect(read).not.toHaveBeenCalled();

        setHidden(false);
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a tab opened in the background asks nothing until it is shown', async () => {
        setHidden(true);
        await open();
        await pass(10 * 60_000);
        expect(read).not.toHaveBeenCalled();
        setHidden(false);
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });
});

describe('back in front: read at once', () => {
    it('focusing the window reads at once, not at the next tick', async () => {
        await open();
        await pass(10_000);
        read.mockClear();
        fireEvent.focus(window);
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a visibilitychange and a focus together are one read', async () => {
        await open();
        await pass(10_000);
        read.mockClear();
        setHidden(true);
        await pass(60_000);
        setHidden(false);
        fireEvent.focus(window);
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('Check again reads at once and shows "Checking…" until the answer is in', async () => {
        await open();
        read.mockClear();
        let answer!: (r: unknown) => void;
        read.mockImplementationOnce(() => new Promise(r => { answer = r; }) as never);
        fireEvent.click(screen.getByTestId('knock-waiting-check'));
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('knock-waiting-check').textContent).toBe('Checking…');
        await act(async () => { answer(YES); });
        expect(screen.getByTestId('knock-waiting-yes')).toBeTruthy();
    });

    it('one request at a time: Check again while a read is out joins it', async () => {
        let answer!: (r: unknown) => void;
        read.mockImplementationOnce(() => new Promise(r => { answer = r; }) as never);
        await open();
        expect(read).toHaveBeenCalledTimes(1);
        fireEvent.focus(window);
        await pass(5_000);
        expect(read).toHaveBeenCalledTimes(1);
        await act(async () => { answer(PENDING); });
    });
});

describe('a community that is struggling', () => {
    it('a 429 with Retry-After: 300 waits 300 s, and a tab brought to the front does not break it', async () => {
        read.mockResolvedValueOnce({ ok: false, kind: 'refused', status: 429, code: null, message: 'Slow down.', retryAfterSeconds: 300 });
        await open();
        expect(read).toHaveBeenCalledTimes(1);
        await pass(120_000);
        fireEvent.focus(window);
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
        await pass(179_000);
        expect(read).toHaveBeenCalledTimes(1);
        await pass(1_000);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('a failed read (unreachable) is tried again, slower, and says so in the community\'s own words', async () => {
        read.mockResolvedValueOnce({ ok: false, kind: 'unreachable', message: 'Couldn\'t reach this community. Check your connection and try again.' });
        await open();
        expect(screen.getByTestId('knock-waiting-line').textContent).toContain('Couldn\'t reach');
        await pass(31_000); // 40 s ±20%: not yet
        expect(read).toHaveBeenCalledTimes(1);
        await pass(20_000);
        expect(read).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId('knock-waiting-line').textContent).toMatch(/arrived/i);
    });
});
