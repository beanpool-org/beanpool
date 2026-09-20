import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LIGHT_MIGRATION_KEY,
    LEGACY_THEME_KEY,
    THEME_PREFERENCE_KEY,
    THEME_PREFERENCE_OPTIONS,
    loadThemePreference,
    parseThemePreference,
    resolveTheme,
} from '../theme-preference';

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: async (k: string) => data.get(k) ?? null,
        setItem: async (k: string, v: string) => { data.set(k, v); },
        removeItem: async (k: string) => { data.delete(k); },
    };
}

describe('resolveTheme', () => {
    it.each([
        ['system', 'dark', 'dark'],
        ['system', 'light', 'light'],
        ['light', 'dark', 'light'],
        ['light', 'light', 'light'],
        ['dark', 'dark', 'dark'],
        ['dark', 'light', 'dark'],
    ] as const)('preference %s with phone %s draws %s', (pref, phone, expected) => {
        expect(resolveTheme(pref, phone)).toBe(expected);
    });

    it('falls back to light when the phone reports no scheme', () => {
        expect(resolveTheme('system', 'unspecified')).toBe('light');
        expect(resolveTheme('system', null)).toBe('light');
        expect(resolveTheme('system', undefined)).toBe('light');
        expect(resolveTheme('dark', null)).toBe('dark');
    });
});

describe('parseThemePreference', () => {
    it('accepts the three values and rejects anything else', () => {
        expect(parseThemePreference('system')).toBe('system');
        expect(parseThemePreference('light')).toBe('light');
        expect(parseThemePreference('dark')).toBe('dark');
        expect(parseThemePreference('true')).toBeNull();
        expect(parseThemePreference(null)).toBeNull();
    });
});

describe('loadThemePreference', () => {
    it('defaults a fresh install to Light', async () => {
        const s = memoryStorage();
        expect(await loadThemePreference(s)).toBe('light');
        expect(s.data.get(THEME_PREFERENCE_KEY)).toBe('light');
    });

    it('carries an old Dark Mode switch that was on across once, then drops the old key', async () => {
        const s = memoryStorage({ [LEGACY_THEME_KEY]: 'dark' });
        expect(await loadThemePreference(s)).toBe('dark');
        expect(s.data.get(THEME_PREFERENCE_KEY)).toBe('dark');
        expect(s.data.has(LEGACY_THEME_KEY)).toBe(false);
    });

    it('treats an old switch left off as no choice: the Light default', async () => {
        const s = memoryStorage({ [LEGACY_THEME_KEY]: 'light' });
        expect(await loadThemePreference(s)).toBe('light');
        expect(s.data.has(LEGACY_THEME_KEY)).toBe(false);
        // The marker must be written on this path too, or a later 'Same as phone' is clobbered.
        expect(s.data.get(DEFAULT_LIGHT_MIGRATION_KEY)).toBe('done');
    });

    it('keeps a stored preference and ignores any leftover old key', async () => {
        const s = memoryStorage({ [THEME_PREFERENCE_KEY]: 'light', [LEGACY_THEME_KEY]: 'dark' });
        expect(await loadThemePreference(s)).toBe('light');
    });

    it('re-seeds when the stored value is garbage', async () => {
        const s = memoryStorage({ [THEME_PREFERENCE_KEY]: 'sepia' });
        expect(await loadThemePreference(s)).toBe('light');
        expect(s.data.get(DEFAULT_LIGHT_MIGRATION_KEY)).toBe('done');
    });

    it('still returns a stored Dark when the marker write fails', async () => {
        const s = memoryStorage({ [THEME_PREFERENCE_KEY]: 'dark' });
        s.setItem = async () => { throw new Error('disk full'); };
        expect(await loadThemePreference(s)).toBe('dark');
    });
});

// #930 wrote 'system' to storage on first run, so changing the seed alone leaves every device that
// opened v1.2.39-v1.2.45 following the phone for ever. These cover the one-time move off it.
describe('loadThemePreference: the one-time move off the #930 system default', () => {
    it('moves a stored system to Light and records that it has done so', async () => {
        const s = memoryStorage({ [THEME_PREFERENCE_KEY]: 'system' });
        expect(await loadThemePreference(s)).toBe('light');
        expect(s.data.get(THEME_PREFERENCE_KEY)).toBe('light');
        expect(s.data.get(DEFAULT_LIGHT_MIGRATION_KEY)).toBe('done');
    });

    it('keeps Same as phone when it was chosen after the move', async () => {
        const s = memoryStorage({
            [THEME_PREFERENCE_KEY]: 'system',
            [DEFAULT_LIGHT_MIGRATION_KEY]: 'done',
        });
        expect(await loadThemePreference(s)).toBe('system');
        expect(s.data.get(THEME_PREFERENCE_KEY)).toBe('system');
    });

    it('runs only once, so Same as phone picked later survives the next launch', async () => {
        const s = memoryStorage({ [THEME_PREFERENCE_KEY]: 'system' });
        expect(await loadThemePreference(s)).toBe('light');
        await s.setItem(THEME_PREFERENCE_KEY, 'system');
        expect(await loadThemePreference(s)).toBe('system');
    });

    it('does not disturb a stored dark or light', async () => {
        const dark = memoryStorage({ [THEME_PREFERENCE_KEY]: 'dark' });
        expect(await loadThemePreference(dark)).toBe('dark');
        expect(dark.data.get(DEFAULT_LIGHT_MIGRATION_KEY)).toBe('done');

        const light = memoryStorage({ [THEME_PREFERENCE_KEY]: 'light' });
        expect(await loadThemePreference(light)).toBe('light');
    });

    it('marks a fresh install done, so a later Same as phone is never clobbered', async () => {
        const s = memoryStorage();
        expect(await loadThemePreference(s)).toBe('light');
        expect(s.data.get(DEFAULT_LIGHT_MIGRATION_KEY)).toBe('done');
        await s.setItem(THEME_PREFERENCE_KEY, 'system');
        expect(await loadThemePreference(s)).toBe('system');
    });
});

it('offers Same as phone first, then Light and Dark', () => {
    expect(THEME_PREFERENCE_OPTIONS.map(o => o.value)).toEqual(['system', 'light', 'dark']);
});
