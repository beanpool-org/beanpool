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

    it('defaults to Same as device', () => {
        expect(loadThemePreference()).toBe('system');
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('system');
    });

    it('carries an old dark toggle across once and drops the old key', () => {
        localStorage.setItem('beanpool-theme', 'dark');
        expect(loadThemePreference()).toBe('dark');
        expect(localStorage.getItem('beanpool-theme')).toBeNull();
    });

    it('treats the old toggle light value (written on every load) as no choice', () => {
        localStorage.setItem('beanpool-theme', 'light');
        expect(loadThemePreference()).toBe('system');
    });

    it('keeps a stored preference', () => {
        localStorage.setItem('beanpool-theme-mode', 'light');
        expect(loadThemePreference()).toBe('light');
    });
});
