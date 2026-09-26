import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityPauseProvider, useActivityPause, usePausablePoll, IDLE_AFTER_MS } from './activity-pause';

describe('activity-pause', () => {
    let originalHidden: boolean;

    beforeEach(() => {
        vi.useFakeTimers();
        originalHidden = document.hidden;
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    });

    afterEach(() => {
        vi.useRealTimers();
        Object.defineProperty(document, 'hidden', { value: originalHidden, configurable: true });
    });

    describe('useActivityPause outside provider', () => {
        it('returns default active state without crashing', () => {
            const { result } = renderHook(() => useActivityPause());
            expect(result.current.paused).toBe(false);
            expect(result.current.reason).toBeNull();
            expect(typeof result.current.resume).toBe('function');

            expect(() => {
                act(() => {
                    result.current.resume();
                });
            }).not.toThrow();
        });
    });

    describe('ActivityPauseProvider & useActivityPause', () => {
        it('exports default IDLE_AFTER_MS constant of 10 minutes', () => {
            expect(IDLE_AFTER_MS).toBe(10 * 60 * 1000);
        });

        it('provides unpaused state when document is visible and user is active', () => {
            const wrapper = ({ children }: { children: React.ReactNode }) => (
                <ActivityPauseProvider>{children}</ActivityPauseProvider>
            );
            const { result } = renderHook(() => useActivityPause(), { wrapper });

            expect(result.current.paused).toBe(false);
            expect(result.current.reason).toBeNull();
        });

        it('pauses with reason "hidden" when tab is hidden via visibilitychange', () => {
            const wrapper = ({ children }: { children: React.ReactNode }) => (
                <ActivityPauseProvider>{children}</ActivityPauseProvider>
            );
            const { result } = renderHook(() => useActivityPause(), { wrapper });

            Object.defineProperty(document, 'hidden', { value: true, configurable: true });
            act(() => {
                document.dispatchEvent(new Event('visibilitychange'));
            });

            expect(result.current.paused).toBe(true);
            expect(result.current.reason).toBe('hidden');

            Object.defineProperty(document, 'hidden', { value: false, configurable: true });
            act(() => {
                document.dispatchEvent(new Event('visibilitychange'));
            });

            expect(result.current.paused).toBe(false);
            expect(result.current.reason).toBeNull();
        });

        it('pauses with reason "idle" after idleAfterMs threshold and resumes via resume()', () => {
            const idleAfterMs = 5000;
            const wrapper = ({ children }: { children: React.ReactNode }) => (
                <ActivityPauseProvider idleAfterMs={idleAfterMs}>{children}</ActivityPauseProvider>
            );
            const { result } = renderHook(() => useActivityPause(), { wrapper });

            act(() => {
                vi.advanceTimersByTime(4999);
            });
            expect(result.current.paused).toBe(false);

            act(() => {
                vi.advanceTimersByTime(1);
            });
            expect(result.current.paused).toBe(true);
            expect(result.current.reason).toBe('idle');

            act(() => {
                result.current.resume();
            });
            expect(result.current.paused).toBe(false);
            expect(result.current.reason).toBeNull();
        });

        it('resumes from idle state when user activity (keydown, pointermove, etc) occurs', () => {
            const idleAfterMs = 3000;
            const wrapper = ({ children }: { children: React.ReactNode }) => (
                <ActivityPauseProvider idleAfterMs={idleAfterMs}>{children}</ActivityPauseProvider>
            );
            const { result } = renderHook(() => useActivityPause(), { wrapper });

            act(() => {
                vi.advanceTimersByTime(idleAfterMs);
            });
            expect(result.current.paused).toBe(true);

            act(() => {
                window.dispatchEvent(new Event('keydown'));
            });

            expect(result.current.paused).toBe(false);
            expect(result.current.reason).toBeNull();
        });

        it('throttles activity re-arming while active', () => {
            const idleAfterMs = 5000;
            const wrapper = ({ children }: { children: React.ReactNode }) => (
                <ActivityPauseProvider idleAfterMs={idleAfterMs}>{children}</ActivityPauseProvider>
            );
            const { result } = renderHook(() => useActivityPause(), { wrapper });

            // Advance 2 seconds
            act(() => {
                vi.advanceTimersByTime(2000);
            });

            // Fire activity (throttled re-arm)
            act(() => {
                window.dispatchEvent(new Event('pointermove'));
            });

            // 3 seconds later (5s from start), it shouldn't pause yet because activity re-armed the timer
            act(() => {
                vi.advanceTimersByTime(3000);
            });
            expect(result.current.paused).toBe(false);

            // 2 more seconds (5s from re-arm), it pauses
            act(() => {
                vi.advanceTimersByTime(2000);
            });
            expect(result.current.paused).toBe(true);
        });
    });

    describe('usePausablePoll', () => {
        it('polls at given interval and respects runOnStart option', () => {
            const callback = vi.fn();
            renderHook(() => usePausablePoll(callback, 1000, { runOnStart: true }));

            expect(callback).toHaveBeenCalledTimes(1);

            act(() => {
                vi.advanceTimersByTime(1000);
            });
            expect(callback).toHaveBeenCalledTimes(2);

            act(() => {
                vi.advanceTimersByTime(2000);
            });
            expect(callback).toHaveBeenCalledTimes(4);
        });

        it('does not run on start if runOnStart is false', () => {
            const callback = vi.fn();
            renderHook(() => usePausablePoll(callback, 1000, { runOnStart: false }));

            expect(callback).not.toHaveBeenCalled();

            act(() => {
                vi.advanceTimersByTime(1000);
            });
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it('does not poll when disabled', () => {
            const callback = vi.fn();
            renderHook(() => usePausablePoll(callback, 1000, { enabled: false }));

            expect(callback).not.toHaveBeenCalled();

            act(() => {
                vi.advanceTimersByTime(5000);
            });
            expect(callback).not.toHaveBeenCalled();
        });

        it('pauses polling when ActivityPauseProvider enters paused state and immediately polls on resume', () => {
            const callback = vi.fn();
            const idleAfterMs = 2000;

            const wrapper = ({ children }: { children: React.ReactNode }) => (
                <ActivityPauseProvider idleAfterMs={idleAfterMs}>{children}</ActivityPauseProvider>
            );

            const { result } = renderHook(
                () => {
                    const pauseState = useActivityPause();
                    usePausablePoll(callback, 1000);
                    return pauseState;
                },
                { wrapper },
            );

            expect(callback).toHaveBeenCalledTimes(1); // runOnStart

            // Advance 1s -> poll tick 2
            act(() => {
                vi.advanceTimersByTime(1000);
            });
            expect(callback).toHaveBeenCalledTimes(2);

            // Advance 1s -> idle timer triggers at 2000ms (and 1s interval tick fires at 2000ms)
            act(() => {
                vi.advanceTimersByTime(1000);
            });
            expect(result.current.paused).toBe(true);
            expect(callback).toHaveBeenCalledTimes(3);

            // While paused, interval ticks shouldn't invoke callback
            act(() => {
                vi.advanceTimersByTime(5000);
            });
            expect(callback).toHaveBeenCalledTimes(3);

            // Resume -> triggers callback immediately upon resuming
            act(() => {
                result.current.resume();
            });
            expect(callback).toHaveBeenCalledTimes(4);

            // Interval resumes
            act(() => {
                vi.advanceTimersByTime(1000);
            });
            expect(callback).toHaveBeenCalledTimes(5);
        });

        it('restarts interval when restartKey changes', () => {
            const callback = vi.fn();
            let key = 'node-1';

            const { rerender } = renderHook(() => usePausablePoll(callback, 1000, { restartKey: key }));

            expect(callback).toHaveBeenCalledTimes(1);

            act(() => {
                vi.advanceTimersByTime(500);
            });

            // Key changes mid-interval
            key = 'node-2';
            rerender();

            // Rerender with new restartKey immediately triggers callback on start of new interval
            expect(callback).toHaveBeenCalledTimes(2);

            // Full 1000ms after restart
            act(() => {
                vi.advanceTimersByTime(1000);
            });
            expect(callback).toHaveBeenCalledTimes(3);
        });
    });
});
