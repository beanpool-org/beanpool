/**
 * Home's Find card keeps the answers to this browser's requests fresh while Home is on screen (Damo, 9 Nov 2026: the yes
 * only showed after a reload). Before: each request was read once, when the card opened. Now the same schedule as the
 * waiting page (@beanpool/core knock-status-watch.ts): every 20 s for 10 minutes, then every 60 s, then every 5 minutes;
 * never while the tab is hidden; at once when it comes back; a request that has its answer (a yes, or nothing open) is not
 * asked again. Fake timers; the community is a stubbed read.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import * as knockModule from './knock';
import { useKnockStatuses } from './use-knock-statuses';
import type { BeanPoolIdentity } from './identity';
import type { RememberedKnock } from './knock';

const ME = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const BYRON: RememberedKnock = { url: 'https://byron.example.org', name: 'Byron', key: null, sentAt: '2026-11-08T00:00:00.000Z' };
const SLEEPY: RememberedKnock = { url: 'https://sleepy.example.org', name: 'Sleepy', key: null, sentAt: '2026-11-08T00:00:00.000Z' };
const PENDING = { ok: true, value: { status: 'pending' } } as const;
const YES = { ok: true, value: { status: 'approved', invite: 'BP-YES1', expiresAt: null } } as const;
const NONE = { ok: true, value: { status: 'none' } } as const;

let read: MockInstance<typeof knockModule.readKnockStatus>;
const asked = (url: string) => read.mock.calls.filter(c => c[0] === url).length;

function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
}
async function pass(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    read = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue(PENDING);
});
afterEach(() => {
    cleanup();
    setHidden(false);
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('the answers to this browser\'s requests, kept fresh', () => {
    it('reads each request at once, and shows what each community said', async () => {
        read.mockImplementation(async (url: unknown) => (url === BYRON.url ? YES : PENDING));
        const { result } = renderHook(() => useKnockStatuses([BYRON, SLEEPY], ME));
        await pass(0);
        expect(asked(BYRON.url)).toBe(1);
        expect(asked(SLEEPY.url)).toBe(1);
        expect(result.current[0][BYRON.url]).toEqual(YES);
        expect(result.current[0][SLEEPY.url]).toEqual(PENDING);
    });

    it('a yes that comes after 30 s shows with no reload, and that request is not asked again', async () => {
        const { result } = renderHook(() => useKnockStatuses([BYRON, SLEEPY], ME));
        await pass(30_000);
        read.mockImplementation(async (url: unknown) => (url === BYRON.url ? YES : PENDING));
        await pass(20_000); // by 50 s the next round has run (48 s at the latest)
        expect(result.current[0][BYRON.url]).toEqual(YES);
        const byron = asked(BYRON.url);
        await pass(10 * 60_000);
        expect(asked(BYRON.url)).toBe(byron);
        // Sleepy Hollow, still waiting, carries on.
        expect(asked(SLEEPY.url)).toBeGreaterThan(byron + 10);
    });

    it('asks nothing more once every request has its answer (a yes, or nothing open)', async () => {
        read.mockImplementation(async (url: unknown) => (url === BYRON.url ? YES : NONE));
        renderHook(() => useKnockStatuses([BYRON, SLEEPY], ME));
        await pass(0);
        read.mockClear();
        await pass(30 * 60_000);
        expect(read).not.toHaveBeenCalled();
    });

    it('about every 20 s at first (16 to 24 s), once a minute after 10 minutes', async () => {
        renderHook(() => useKnockStatuses([BYRON], ME));
        await pass(0);
        expect(asked(BYRON.url)).toBe(1);
        await pass(15_999);
        expect(asked(BYRON.url)).toBe(1);
        await pass(8_001);
        expect(asked(BYRON.url)).toBe(2);
        await pass(10 * 60_000);
        read.mockClear();
        await pass(10 * 60_000);
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(8);
        expect(read.mock.calls.length).toBeLessThanOrEqual(12);
    });

    it('a hidden tab asks nothing; coming back reads at once', async () => {
        renderHook(() => useKnockStatuses([BYRON], ME));
        await pass(0);
        read.mockClear();
        setHidden(true);
        await pass(30 * 60_000);
        expect(read).not.toHaveBeenCalled();
        setHidden(false);
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('focusing the window reads at once', async () => {
        renderHook(() => useKnockStatuses([BYRON], ME));
        await pass(10_000);
        read.mockClear();
        act(() => { window.dispatchEvent(new Event('focus')); });
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a 429 with Retry-After: 300 is waited out, for every request', async () => {
        read.mockResolvedValueOnce({ ok: false, kind: 'refused', status: 429, code: null, message: 'Slow.', retryAfterSeconds: 300 });
        renderHook(() => useKnockStatuses([BYRON], ME));
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
        await pass(299_000);
        expect(read).toHaveBeenCalledTimes(1);
        await pass(1_000);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('a new request is read at once, and one that already has its answer is not asked again with it', async () => {
        read.mockImplementation(async (url: unknown) => (url === BYRON.url ? YES : PENDING));
        const { rerender } = renderHook(({ list }) => useKnockStatuses(list, ME), { initialProps: { list: [BYRON] } });
        await pass(0);
        read.mockClear();
        rerender({ list: [BYRON, SLEEPY] });
        await pass(0);
        expect(asked(SLEEPY.url)).toBe(1);
        expect(asked(BYRON.url)).toBe(0);
    });

    it('with no account or no requests, nothing is asked', async () => {
        renderHook(() => useKnockStatuses([BYRON], null));
        renderHook(() => useKnockStatuses([], ME));
        await pass(30 * 60_000);
        expect(read).not.toHaveBeenCalled();
    });

    it('a request that leaves the list is no longer asked, and its answer goes with it', async () => {
        const { result, rerender } = renderHook(({ list }) => useKnockStatuses(list, ME), { initialProps: { list: [BYRON, SLEEPY] } });
        await pass(0);
        rerender({ list: [SLEEPY] });
        await pass(0);
        read.mockClear();
        await pass(60_000);
        expect(asked(BYRON.url)).toBe(0);
        expect(asked(SLEEPY.url)).toBeGreaterThan(0);
        expect(result.current[0][BYRON.url]).toBeUndefined();
    });

    it('the answer can be set by hand too (a Cancel that finds nothing open reads again and says so)', async () => {
        const { result } = renderHook(() => useKnockStatuses([BYRON], ME));
        await pass(0);
        act(() => { result.current[1](was => ({ ...was, [BYRON.url]: NONE })); });
        expect(result.current[0][BYRON.url]).toEqual(NONE);
    });
});
