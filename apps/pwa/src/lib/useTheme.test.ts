import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { loadThemePreference, resolveTheme, useTheme } from './useTheme';

describe('resolveTheme', () => {
    it.each([
        ['system', true, 'dark'],
        ['system', false, 'light'],
        ['light', true, 'light'],
        ['light', false, 'light'],
        ['dark', true, 'dark'],
        ['dark', false, 'dark'],
    ] as const)('preference %s with device dark=%s draws %s', (pref, systemDark, expected) => {
        expect(resolveTheme(pref, systemDark)).toBe(expected);
    });
});

describe('loadThemePreference', () => {
    beforeEach(() => localStorage.clear());

    // Marty, 16 Oct 2026: the web app opens in Dark for a visitor who never chose.
    it('defaults to Dark, and stores no theme, so a later change of default reaches this browser too', () => {
        expect(loadThemePreference()).toBe('dark');
        expect(localStorage.getItem('beanpool-theme-mode')).toBeNull();
        expect(loadThemePreference()).toBe('dark');
    });

    it.each(['light', 'dark', 'system'] as const)('keeps %s chosen in Settings, and rewrites nothing', (choice) => {
        localStorage.setItem('beanpool-theme-mode', choice);
        expect(loadThemePreference()).toBe(choice);
        expect(localStorage.getItem('beanpool-theme-mode')).toBe(choice);
    });

    it('treats a stored value it does not know as no choice', () => {
        localStorage.setItem('beanpool-theme-mode', 'junk');
        expect(loadThemePreference()).toBe('dark');
    });

    it('a retired key is not read: the old toggle no longer decides anything', () => {
        localStorage.setItem('beanpool-theme', 'light');
        expect(loadThemePreference()).toBe('dark');
    });

    it('a Light picked now survives the next load', () => {
        const { result } = renderHook(() => useTheme());
        expect(result.current[1]).toBe('dark');
        act(() => { result.current[2]('light'); });
        expect(loadThemePreference()).toBe('light');
    });

    it('a pick whose write fails still applies for this visit, and does not crash', () => {
        const stub = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
        try {
            const { result } = renderHook(() => useTheme());
            act(() => { result.current[2]('light'); });
            expect(result.current[1]).toBe('light');
            expect(result.current[0]).toBe('light');
        } finally {
            stub.mockRestore();
        }
    });
});

describe('useTheme draws the default on <html>', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.className = '';
        document.documentElement.style.colorScheme = '';
        document.head.innerHTML = '<meta name="theme-color" content="#0a0a0a">';
    });

    it('a fresh visitor: dark classes, color-scheme and theme-color', () => {
        const { result } = renderHook(() => useTheme());
        expect(result.current[0]).toBe('dark');
        const root = document.documentElement;
        expect(root.classList.contains('dark')).toBe(true);
        expect(root.classList.contains('dark-theme')).toBe(true);
        expect(root.classList.contains('light-theme')).toBe(false);
        expect(root.style.colorScheme).toBe('dark');
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#1d231d');
    });

    it('a kept Light: light classes, color-scheme and theme-color', () => {
        localStorage.setItem('beanpool-theme-mode', 'light');
        const { result } = renderHook(() => useTheme());
        expect(result.current[0]).toBe('light');
        const root = document.documentElement;
        expect(root.classList.contains('dark')).toBe(false);
        expect(root.classList.contains('light-theme')).toBe(true);
        expect(root.style.colorScheme).toBe('light');
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#fbfaf8');
    });
});
