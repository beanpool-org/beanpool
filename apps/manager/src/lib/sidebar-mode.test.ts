import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    readSidebarMode,
    nextSidebarMode,
    useSidebarMode,
    SIDEBAR_MODE_KEY,
    SidebarMode,
} from './sidebar-mode';

describe('sidebar-mode utility functions', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    describe('readSidebarMode', () => {
        it('returns "full" by default when storage is empty', () => {
            expect(readSidebarMode()).toBe('full');
        });

        it('returns valid modes ("icons", "hidden") from storage', () => {
            localStorage.setItem(SIDEBAR_MODE_KEY, 'icons');
            expect(readSidebarMode()).toBe('icons');

            localStorage.setItem(SIDEBAR_MODE_KEY, 'hidden');
            expect(readSidebarMode()).toBe('hidden');
        });

        it('falls back to "full" when stored value is invalid', () => {
            localStorage.setItem(SIDEBAR_MODE_KEY, 'invalid-mode');
            expect(readSidebarMode()).toBe('full');
        });

        it('falls back to "full" when storage throws an exception', () => {
            const throwingStorage = {
                getItem: () => {
                    throw new Error('Storage access blocked');
                },
            };
            expect(readSidebarMode(throwingStorage)).toBe('full');
        });

        it('handles undefined storage gracefully', () => {
            expect(readSidebarMode(undefined)).toBe('full');
        });
    });

    describe('nextSidebarMode', () => {
        it('cycles "full" -> "icons"', () => {
            expect(nextSidebarMode('full')).toBe('icons');
        });

        it('cycles "icons" -> "hidden"', () => {
            expect(nextSidebarMode('icons')).toBe('hidden');
        });

        it('returns "hidden" when current mode is "hidden"', () => {
            expect(nextSidebarMode('hidden')).toBe('hidden');
        });
    });

    describe('useSidebarMode hook', () => {
        it('initializes with mode from localStorage', () => {
            localStorage.setItem(SIDEBAR_MODE_KEY, 'icons');
            const { result } = renderHook(() => useSidebarMode());
            expect(result.current[0]).toBe('icons');
        });

        it('updates mode state and persists to localStorage', () => {
            const { result } = renderHook(() => useSidebarMode());
            expect(result.current[0]).toBe('full');

            act(() => {
                result.current[1]('hidden');
            });

            expect(result.current[0]).toBe('hidden');
            expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('hidden');
        });

        it('handles localStorage setItem throwing an exception gracefully', () => {
            const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                throw new Error('QuotaExceededError');
            });

            const { result } = renderHook(() => useSidebarMode());

            act(() => {
                result.current[1]('icons');
            });

            // State should still update in memory despite storage error
            expect(result.current[0]).toBe('icons');

            setItemSpy.mockRestore();
        });
    });
});
