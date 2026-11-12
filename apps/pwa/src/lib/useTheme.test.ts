import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { DEFAULT_PREFERENCE, THEME_PREFERENCE_OPTIONS, loadThemePreference, resolveSet, resolveTheme, useTheme } from './useTheme';

describe('resolveTheme', () => {
    it.each([
        ['system', true, 'dark'],
        ['system', false, 'light'],
        ['light', true, 'light'],
        ['light', false, 'light'],
        ['dark', true, 'dark'],
        ['dark', false, 'dark'],
        ['night', true, 'dark'],
        ['night', false, 'dark'],
    ] as const)('preference %s with device dark=%s draws the %s scheme', (pref, systemDark, expected) => {
        expect(resolveTheme(pref, systemDark)).toBe(expected);
    });
});

// The stored values are core's LookChoice: system | dark (= Classic) | light | night (= Dark). core's look.test.ts holds the rule.
describe('resolveSet', () => {
    it.each([
        ['system', true, 'dark'],
        ['system', false, 'light'],
        ['dark', true, 'dark'],
        ['dark', false, 'dark'],
        ['light', true, 'light'],
        ['light', false, 'light'],
        ['night', true, 'night'],
        ['night', false, 'night'],
    ] as const)('preference %s with device dark=%s draws the %s set', (pref, systemDark, expected) => {
        expect(resolveSet(pref, systemDark)).toBe(expected);
    });
});

describe('the list in Settings', () => {
    it('is exactly Same as device, Classic, Light, Dark -- stored as system, dark, light, night', () => {
        expect(THEME_PREFERENCE_OPTIONS.map(o => o.value)).toEqual(['system', 'dark', 'light', 'night']);
    });
});

describe('loadThemePreference', () => {
    beforeEach(() => localStorage.clear());

    // Marty, 16 Oct 2026: the web app opens dark for a visitor who never chose; since 12 Nov that dark is called Classic.
    it('defaults to Classic, and stores no theme, so a later change of default reaches this browser too', () => {
        expect(DEFAULT_PREFERENCE).toBe('dark');
        expect(loadThemePreference()).toBe('dark');
        expect(localStorage.getItem('beanpool-theme-mode')).toBeNull();
        expect(loadThemePreference()).toBe('dark');
    });

    it.each(['light', 'dark', 'night', 'system'] as const)('keeps %s chosen in Settings, and rewrites nothing', (choice) => {
        localStorage.setItem('beanpool-theme-mode', choice);
        expect(loadThemePreference()).toBe(choice);
        expect(localStorage.getItem('beanpool-theme-mode')).toBe(choice);
    });

    it('treats a stored value it does not know as no choice: Classic, and the value is left alone', () => {
        for (const junk of ['junk', 'dusk', 'ember']) {
            localStorage.setItem('beanpool-theme-mode', junk);
            expect(loadThemePreference()).toBe('dark');
            expect(localStorage.getItem('beanpool-theme-mode')).toBe(junk);
        }
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
        document.documentElement.removeAttribute('data-bp-theme');
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
        expect(root.getAttribute('data-bp-theme')).toBeNull();
        expect(root.style.colorScheme).toBe('dark');
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#1d231d');
    });

    it('a kept Dark: the dark classes AND data-bp-theme="night" (the CSS block needs both), color-scheme dark, its banner colour', () => {
        localStorage.setItem('beanpool-theme-mode', 'night');
        const { result } = renderHook(() => useTheme());
        expect(result.current[0]).toBe('dark');
        expect(result.current[3]).toBe('night');
        const root = document.documentElement;
        expect(root.classList.contains('dark')).toBe(true);
        expect(root.classList.contains('dark-theme')).toBe(true);
        expect(root.getAttribute('data-bp-theme')).toBe('night');
        expect(root.style.colorScheme).toBe('dark');
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#202126');
    });

    it('moving from Dark to Classic or Light takes the attribute away again', () => {
        const { result } = renderHook(() => useTheme());
        const root = document.documentElement;
        act(() => { result.current[2]('night'); });
        expect(root.getAttribute('data-bp-theme')).toBe('night');
        act(() => { result.current[2]('dark'); });
        expect(root.getAttribute('data-bp-theme')).toBeNull();
        expect(root.classList.contains('dark-theme')).toBe(true);
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#1d231d');
        act(() => { result.current[2]('night'); });
        act(() => { result.current[2]('light'); });
        expect(root.getAttribute('data-bp-theme')).toBeNull();
        expect(root.classList.contains('light-theme')).toBe(true);
        expect(root.classList.contains('dark-theme')).toBe(false);
    });

    it('a kept Light: light classes, color-scheme and theme-color', () => {
        localStorage.setItem('beanpool-theme-mode', 'light');
        const { result } = renderHook(() => useTheme());
        expect(result.current[0]).toBe('light');
        const root = document.documentElement;
        expect(root.classList.contains('dark')).toBe(false);
        expect(root.classList.contains('light-theme')).toBe(true);
        expect(root.getAttribute('data-bp-theme')).toBeNull();
        expect(root.style.colorScheme).toBe('light');
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#fbfaf8');
    });
});
