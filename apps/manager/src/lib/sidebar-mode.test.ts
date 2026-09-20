import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readSidebarMode, nextSidebarMode, useSidebarMode, SIDEBAR_MODE_KEY } from './sidebar-mode';

describe('sidebar-mode utility', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    describe('readSidebarMode', () => {
        it('returns "full" by default when storage is empty or undefined', () => {
            expect(readSidebarMode(undefined)).toBe('full');
            expect(readSidebarMode()).toBe('full');
        });

        it('returns "icons" or "hidden" when valid values exist in storage', () => {
            localStorage.setItem(SIDEBAR_MODE_KEY, 'icons');
            expect(readSidebarMode()).toBe('icons');

            localStorage.setItem(SIDEBAR_MODE_KEY, 'hidden');
            expect(readSidebarMode()).toBe('hidden');
        });

        it('returns "full" for invalid stored values or storage error', () => {
            localStorage.setItem(SIDEBAR_MODE_KEY, 'invalid-mode');
            expect(readSidebarMode()).toBe('full');

            const mockStorage = {
                getItem: () => {
                    throw new Error('Storage access error');
                },
            };
            expect(readSidebarMode(mockStorage)).toBe('full');
        });
    });

    describe('nextSidebarMode', () => {
        it('cycles through sidebar modes: full -> icons -> hidden', () => {
            expect(nextSidebarMode('full')).toBe('icons');
            expect(nextSidebarMode('icons')).toBe('hidden');
            expect(nextSidebarMode('hidden')).toBe('hidden');
        });
    });

    describe('useSidebarMode', () => {
        it('initializes state from readSidebarMode and updates localStorage on change', () => {
            localStorage.setItem(SIDEBAR_MODE_KEY, 'icons');
            const { result } = renderHook(() => useSidebarMode());

            expect(result.current[0]).toBe('icons');

            act(() => {
                result.current[1]('hidden');
            });

            expect(result.current[0]).toBe('hidden');
            expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('hidden');
        });

        it('handles localStorage errors gracefully during state updates', () => {
            const spySetItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                throw new Error('QuotaExceeded');
            });

            const { result } = renderHook(() => useSidebarMode());

            act(() => {
                result.current[1]('icons');
            });

            expect(result.current[0]).toBe('icons');
            spySetItem.mockRestore();
        });
    });
});
