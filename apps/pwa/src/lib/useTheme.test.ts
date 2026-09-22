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

    it('defaults to Light', () => {
        expect(loadThemePreference()).toBe('light');
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('light');
    });

    it('carries an old dark toggle across once and drops the old key', () => {
        localStorage.setItem('beanpool-theme', 'dark');
        expect(loadThemePreference()).toBe('dark');
        expect(localStorage.getItem('beanpool-theme')).toBeNull();
    });

    it('treats the old toggle light value (written on every load) as no choice', () => {
        localStorage.setItem('beanpool-theme', 'light');
        expect(loadThemePreference()).toBe('light');
    });

    it('keeps a stored preference', () => {
        localStorage.setItem('beanpool-theme-mode', 'dark');
        expect(loadThemePreference()).toBe('dark');
    });
});

// #930 wrote 'system' to localStorage on first load, so changing the default alone would leave every
// browser that opened the web app between 2026-09-19 and 2026-09-20 following the device for ever.
describe('loadThemePreference: the one-time move off the #930 system default', () => {
    beforeEach(() => localStorage.clear());

    it('moves a stored system to Light and records that it has done so', () => {
        localStorage.setItem('beanpool-theme-mode', 'system');
        expect(loadThemePreference()).toBe('light');
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('light');
        expect(localStorage.getItem('beanpool-theme-default-light-v1')).toBe('done');
    });

    it('keeps Same as device when it was chosen after the move', () => {
        localStorage.setItem('beanpool-theme-mode', 'system');
        localStorage.setItem('beanpool-theme-default-light-v1', 'done');
        expect(loadThemePreference()).toBe('system');
    });

    it('runs only once, so Same as device picked later survives the next load', () => {
        localStorage.setItem('beanpool-theme-mode', 'system');
        expect(loadThemePreference()).toBe('light');
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
        const realSet = localStorage.setItem.bind(localStorage);
        const stub = vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
            if (k === 'beanpool-theme-mode') throw new Error('quota exceeded');
            realSet(k, v);
        });
        try {
            expect(loadThemePreference()).toBe('light');
        } finally {
            stub.mockRestore();
        }
        expect(localStorage.getItem('beanpool-theme-default-light-v1')).toBeNull();
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('system');
        // Next load, with storage working, completes the move rather than reading as already done.
        expect(loadThemePreference()).toBe('light');
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('light');
        expect(localStorage.getItem('beanpool-theme-default-light-v1')).toBe('done');
    });

    it('marks a fresh browser done, so a later Same as device is never clobbered', () => {
        expect(loadThemePreference()).toBe('light');
        localStorage.setItem('beanpool-theme-mode', 'system');
        expect(loadThemePreference()).toBe('system');
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
