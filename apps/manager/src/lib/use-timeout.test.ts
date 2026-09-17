import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTimeout } from './use-timeout';

describe('useTimeout', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs the callback after the delay', () => {
        const fn = vi.fn();
        const { result } = renderHook(() => useTimeout());
        act(() => result.current.schedule(fn, 1000));
        vi.advanceTimersByTime(999);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the pending timer before re-arming', () => {
        const first = vi.fn();
        const second = vi.fn();
        const { result } = renderHook(() => useTimeout());
        act(() => result.current.schedule(first, 1000));
        vi.advanceTimersByTime(500);
        act(() => result.current.schedule(second, 1000));
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(600);
        expect(first).not.toHaveBeenCalled();
        vi.advanceTimersByTime(400);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('clears the pending timer on unmount', () => {
        const fn = vi.fn();
        const { result, unmount } = renderHook(() => useTimeout());
        act(() => result.current.schedule(fn, 1000));
        unmount();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(5000);
        expect(fn).not.toHaveBeenCalled();
    });

    it('keeps a stable schedule function across renders', () => {
        const { result, rerender } = renderHook(() => useTimeout());
        const { schedule } = result.current;
        rerender();
        expect(result.current.schedule).toBe(schedule);
    });
});
