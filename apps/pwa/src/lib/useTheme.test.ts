import { beforeEach, describe, expect, it } from 'vitest';
import { loadThemePreference, resolveTheme } from './useTheme';

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

    it('marks a fresh browser done, so a later Same as device is never clobbered', () => {
        expect(loadThemePreference()).toBe('light');
        localStorage.setItem('beanpool-theme-mode', 'system');
        expect(loadThemePreference()).toBe('system');
    });
});
