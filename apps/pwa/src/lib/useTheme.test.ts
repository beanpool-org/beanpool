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

    it('carries an old dark toggle across once and drops the old key', () => {
        localStorage.setItem('beanpool-theme', 'dark');
        expect(loadThemePreference()).toBe('dark');
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('dark');
        expect(localStorage.getItem('beanpool-theme')).toBeNull();
    });

    // The old toggle wrote 'light' on every load, but a toggle back from Dark wrote the same: it may be a choice.
    it('keeps the old toggle light value, carried across like a choice', () => {
        localStorage.setItem('beanpool-theme', 'light');
        expect(loadThemePreference()).toBe('light');
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('light');
        expect(localStorage.getItem('beanpool-theme')).toBeNull();
    });

    it('keeps a stored preference', () => {
        localStorage.setItem('beanpool-theme-mode', 'dark');
        expect(loadThemePreference()).toBe('dark');
    });
});

// Who keeps what. Light chosen in Settings, #1003's move of #930's 'system' to light, and #1003's
// first-load default all left the same 'light' plus marker: nothing tells them apart, so all are kept.
describe('loadThemePreference: an explicit choice is never moved to the new default', () => {
    beforeEach(() => localStorage.clear());

    it.each(['light', 'dark', 'system'] as const)('keeps %s chosen in Settings', (choice) => {
        localStorage.setItem('beanpool-theme-mode', choice);
        localStorage.setItem('beanpool-theme-default-light-v1', 'done');
        expect(loadThemePreference()).toBe(choice);
        expect(localStorage.getItem('beanpool-theme-mode')).toBe(choice);
    });

    it('keeps Light picked in Settings while #930 was live (no marker then; #930 itself never wrote light)', () => {
        localStorage.setItem('beanpool-theme-mode', 'light');
        expect(loadThemePreference()).toBe('light');
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('light');
        expect(localStorage.getItem('beanpool-theme-default-light-v1')).toBe('done');
    });

    it('keeps the light #1003 wrote for a fresh browser, as it reads the same as a pick', () => {
        localStorage.setItem('beanpool-theme-mode', 'light');
        localStorage.setItem('beanpool-theme-default-light-v1', 'done');
        expect(loadThemePreference()).toBe('light');
    });

    it('a Light picked now survives the next load', () => {
        const { result } = renderHook(() => useTheme());
        expect(result.current[1]).toBe('dark');
        act(() => { result.current[2]('light'); });
        expect(loadThemePreference()).toBe('light');
    });
});

// #930 wrote 'system' to localStorage on first load. #1003 moved it to light once per browser; a
// browser that has not loaded since still holds it, unmarked, and that one is known to be nobody's.
describe('loadThemePreference: the one-time move off the #930 system default', () => {
    beforeEach(() => localStorage.clear());

    it('drops a stored #930 system, so the default (Dark) applies, and records that it has done so', () => {
        localStorage.setItem('beanpool-theme-mode', 'system');
        expect(loadThemePreference()).toBe('dark');
        expect(localStorage.getItem('beanpool-theme-mode')).toBeNull();
        expect(localStorage.getItem('beanpool-theme-default-light-v1')).toBe('done');
    });

    it('drops it whatever the old toggle had left beside it', () => {
        localStorage.setItem('beanpool-theme-mode', 'system');
        localStorage.setItem('beanpool-theme', 'light');
        expect(loadThemePreference()).toBe('dark');
    });

    it('keeps Same as device when it was chosen after the move', () => {
        localStorage.setItem('beanpool-theme-mode', 'system');
        localStorage.setItem('beanpool-theme-default-light-v1', 'done');
        expect(loadThemePreference()).toBe('system');
    });

    it('runs only once, so Same as device picked later survives the next load', () => {
        localStorage.setItem('beanpool-theme-mode', 'system');
        expect(loadThemePreference()).toBe('dark');
        localStorage.setItem('beanpool-theme-mode', 'system');
        expect(loadThemePreference()).toBe('system');
    });

    // The reviewer's catch: ordering alone was a no-op here, because writeStorage swallows its
    // throw, so the marker landed even when the value write failed. Gated on the write landing now.
    it('keeps the old dark toggle when the seed write fails, so it can carry over next load', () => {
        localStorage.setItem('beanpool-theme', 'dark');
        const realSet = localStorage.setItem.bind(localStorage);
        const stub = vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
            if (k === 'beanpool-theme-mode') throw new Error('quota exceeded');
            realSet(k, v);
        });
        try {
            expect(loadThemePreference()).toBe('dark');
        } finally {
            stub.mockRestore();
        }
        // The old key must survive: it is the only record of the choice until the new one lands.
        expect(localStorage.getItem('beanpool-theme')).toBe('dark');
        expect(loadThemePreference()).toBe('dark');
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('dark');
        expect(localStorage.getItem('beanpool-theme')).toBeNull();
    });

    it('does NOT record the move when the value write fails, so it retries next load', () => {
        localStorage.setItem('beanpool-theme-mode', 'system');
        const realRemove = localStorage.removeItem.bind(localStorage);
        const stub = vi.spyOn(localStorage, 'removeItem').mockImplementation((k: string) => {
            if (k === 'beanpool-theme-mode') throw new Error('storage blocked');
            realRemove(k);
        });
        try {
            expect(loadThemePreference()).toBe('dark');
        } finally {
            stub.mockRestore();
        }
        expect(localStorage.getItem('beanpool-theme-default-light-v1')).toBeNull();
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('system');
        // Next load, with storage working, completes the move rather than reading as already done.
        expect(loadThemePreference()).toBe('dark');
        expect(localStorage.getItem('beanpool-theme-mode')).toBeNull();
        expect(localStorage.getItem('beanpool-theme-default-light-v1')).toBe('done');
    });

    it('marks a fresh browser done, so a later Same as device is never clobbered', () => {
        expect(loadThemePreference()).toBe('dark');
        localStorage.setItem('beanpool-theme-mode', 'system');
        expect(loadThemePreference()).toBe('system');
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
        localStorage.setItem('beanpool-theme-default-light-v1', 'done');
        const { result } = renderHook(() => useTheme());
        expect(result.current[0]).toBe('light');
        const root = document.documentElement;
        expect(root.classList.contains('dark')).toBe(false);
        expect(root.classList.contains('light-theme')).toBe(true);
        expect(root.style.colorScheme).toBe('light');
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#fbfaf8');
    });
});

// The reaping guard in setPreference is new code, and dropping its `if` is a smaller and more
// inviting edit than the try/catch that would break native's copy. Without these, removing it
// reintroduces the permanent Dark loss at the second site and all 496 tests still pass.
describe('setPreference reaps the legacy key, but only once the new one has landed', () => {
    beforeEach(() => localStorage.clear());

    const throwFor = (key: string) => {
        const realSet = localStorage.setItem.bind(localStorage);
        return vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
            if (k === key) throw new Error('quota exceeded');
            realSet(k, v);
        });
    };

    it('keeps the old key when the pick does not persist either', () => {
        localStorage.setItem('beanpool-theme', 'dark');
        const stub = throwFor('beanpool-theme-mode');
        try {
            const { result } = renderHook(() => useTheme());
            act(() => { result.current[2]('light'); });
        } finally {
            stub.mockRestore();
        }
        // Still the only record of the choice, so it must survive.
        expect(localStorage.getItem('beanpool-theme')).toBe('dark');
        expect(localStorage.getItem('beanpool-theme-mode')).toBeNull();
    });

    it('drops the old key once a pick lands, so it is not orphaned for ever', () => {
        localStorage.setItem('beanpool-theme', 'dark');
        const stub = throwFor('beanpool-theme-mode');
        let result: any;
        try {
            ({ result } = renderHook(() => useTheme()));
        } finally {
            stub.mockRestore();
        }
        expect(localStorage.getItem('beanpool-theme')).toBe('dark');
        act(() => { result.current[2]('light'); });
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('light');
        expect(localStorage.getItem('beanpool-theme')).toBeNull();
    });
});
