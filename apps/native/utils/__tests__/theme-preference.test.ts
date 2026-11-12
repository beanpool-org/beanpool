import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LIGHT_MIGRATION_KEY,
    DEFAULT_PREFERENCE,
    LEGACY_THEME_KEY,
    THEME_PREFERENCE_KEY,
    THEME_PREFERENCE_OPTIONS,
    loadThemePreference,
    parseThemePreference,
    resolveSet,
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

// The stored values are core's LookChoice (look.ts): system | dark (= Classic) | light | night (= Dark). Members see Same as
// phone, Classic, Light, Dark. core's look.test.ts holds the rule itself; these hold the phone's use of it.
describe('resolveSet', () => {
    it.each([
        ['system', 'dark', 'dark'],
        ['system', 'light', 'light'],
        ['light', 'dark', 'light'],
        ['light', 'light', 'light'],
        ['dark', 'dark', 'dark'],
        ['dark', 'light', 'dark'],
        ['night', 'dark', 'night'],
        ['night', 'light', 'night'],
    ] as const)('preference %s with phone %s draws the %s set', (pref, phone, expected) => {
        expect(resolveSet(pref, phone)).toBe(expected);
    });

    it('Same as phone is Light when the phone reports no scheme (a phone that does not say is not dark)', () => {
        expect(resolveSet('system', 'unspecified')).toBe('light');
        expect(resolveSet('system', null)).toBe('light');
        expect(resolveSet('system', undefined)).toBe('light');
        expect(resolveSet('dark', null)).toBe('dark');
        expect(resolveSet('night', null)).toBe('night');
    });
});

describe('resolveTheme (the scheme)', () => {
    it.each([
        ['system', 'dark', 'dark'],
        ['system', 'light', 'light'],
        ['light', 'dark', 'light'],
        ['light', 'light', 'light'],
        ['dark', 'dark', 'dark'],
        ['dark', 'light', 'dark'],
        ['night', 'dark', 'dark'],
        ['night', 'light', 'dark'],
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
    it('accepts the four values and rejects anything else', () => {
        expect(parseThemePreference('system')).toBe('system');
        expect(parseThemePreference('light')).toBe('light');
        expect(parseThemePreference('dark')).toBe('dark');
        expect(parseThemePreference('night')).toBe('night');
        expect(parseThemePreference('true')).toBeNull();
        expect(parseThemePreference('dusk')).toBeNull();
        expect(parseThemePreference('ember')).toBeNull();
        expect(parseThemePreference(null)).toBeNull();
    });
});

describe('loadThemePreference', () => {
    it('opens a fresh install in Classic, and stores no choice for it (only the marker below)', async () => {
        const s = memoryStorage();
        expect(DEFAULT_PREFERENCE).toBe('dark');
        expect(await loadThemePreference(s)).toBe('dark');
        expect(s.data.has(THEME_PREFERENCE_KEY)).toBe(false);
    });

    it('an old Dark Mode switch, on or off, reads as Classic (the default now), and its key is dropped', async () => {
        for (const legacy of ['dark', 'light']) {
            const s = memoryStorage({ [LEGACY_THEME_KEY]: legacy });
            expect(await loadThemePreference(s)).toBe('dark');
            expect(s.data.has(THEME_PREFERENCE_KEY)).toBe(false);
            expect(s.data.has(LEGACY_THEME_KEY)).toBe(false);
            // The marker must be written on this path too, or a later 'Same as phone' is clobbered.
            expect(s.data.get(DEFAULT_LIGHT_MIGRATION_KEY)).toBe('done');
        }
    });

    it('keeps a stored preference and ignores any leftover old key', async () => {
        const s = memoryStorage({ [THEME_PREFERENCE_KEY]: 'light', [LEGACY_THEME_KEY]: 'dark' });
        expect(await loadThemePreference(s)).toBe('light');
        expect(s.data.get(THEME_PREFERENCE_KEY)).toBe('light');
    });

    it.each(['light', 'dark', 'night', 'system'] as const)('keeps a stored %s, and rewrites nothing', async (choice) => {
        // A Light stored by the old first-run seed cannot be told from one chosen, so it stays Light (Marty: a stored choice is kept).
        const s = memoryStorage({ [THEME_PREFERENCE_KEY]: choice, [DEFAULT_LIGHT_MIGRATION_KEY]: 'done' });
        expect(await loadThemePreference(s)).toBe(choice);
        expect(s.data.get(THEME_PREFERENCE_KEY)).toBe(choice);
    });

    it('a stored value this build does not know is no choice: Classic, and the value is left as it is', async () => {
        for (const junk of ['sepia', 'dusk', 'ember', '']) {
            const s = memoryStorage({ [THEME_PREFERENCE_KEY]: junk });
            expect(await loadThemePreference(s)).toBe('dark');
            expect(s.data.get(THEME_PREFERENCE_KEY)).toBe(junk);
            expect(s.data.get(DEFAULT_LIGHT_MIGRATION_KEY)).toBe('done');
        }
    });

    it('still returns a stored Dark (night) or Classic when the marker write fails', async () => {
        for (const stored of ['dark', 'night'] as const) {
            const s = memoryStorage({ [THEME_PREFERENCE_KEY]: stored });
            s.setItem = async () => { throw new Error('disk full'); };
            expect(await loadThemePreference(s)).toBe(stored);
        }
    });

    it('opens Classic even when the marker write fails: a failed write never rejects the read', async () => {
        const s = memoryStorage();
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

    it('does not disturb a stored dark, night or light', async () => {
        const dark = memoryStorage({ [THEME_PREFERENCE_KEY]: 'dark' });
        expect(await loadThemePreference(dark)).toBe('dark');
        expect(dark.data.get(DEFAULT_LIGHT_MIGRATION_KEY)).toBe('done');

        const night = memoryStorage({ [THEME_PREFERENCE_KEY]: 'night' });
        expect(await loadThemePreference(night)).toBe('night');
        expect(night.data.get(THEME_PREFERENCE_KEY)).toBe('night');

        const light = memoryStorage({ [THEME_PREFERENCE_KEY]: 'light' });
        expect(await loadThemePreference(light)).toBe('light');
    });

    // The gap that survived three review rounds: the marker used to be written BEFORE the value it
    // vouches for, so an interruption in between left the device reading as migrated while still
    // holding 'system' -- stranded on 'follow the phone' for ever, which is the fault this function
    // exists to repair. These fail against that ordering.
    it('does NOT record the move when the value write fails, so it retries next launch', async () => {
        const s = memoryStorage({ [THEME_PREFERENCE_KEY]: 'system' });
        const realSet = s.setItem;
        s.setItem = async (k: string, v: string) => {
            if (k === THEME_PREFERENCE_KEY) throw new Error('write failed');
            return realSet(k, v);
        };
        await expect(loadThemePreference(s)).rejects.toThrow('write failed');
        expect(s.data.has(DEFAULT_LIGHT_MIGRATION_KEY)).toBe(false);
        expect(s.data.get(THEME_PREFERENCE_KEY)).toBe('system');
    });

    it('completes the move on the next launch after an interrupted one', async () => {
        const s = memoryStorage({ [THEME_PREFERENCE_KEY]: 'system' });
        const realSet = s.setItem;
        let fail = true;
        s.setItem = async (k: string, v: string) => {
            if (fail && k === THEME_PREFERENCE_KEY) throw new Error('killed mid-write');
            return realSet(k, v);
        };
        await expect(loadThemePreference(s)).rejects.toThrow('killed mid-write');
        fail = false;
        expect(await loadThemePreference(s)).toBe('light');
        expect(s.data.get(THEME_PREFERENCE_KEY)).toBe('light');
        expect(s.data.get(DEFAULT_LIGHT_MIGRATION_KEY)).toBe('done');
    });

    it('marks a fresh install done, so a later Same as phone is never clobbered', async () => {
        const s = memoryStorage();
        expect(await loadThemePreference(s)).toBe('dark');
        expect(s.data.get(DEFAULT_LIGHT_MIGRATION_KEY)).toBe('done');
        await s.setItem(THEME_PREFERENCE_KEY, 'system');
        expect(await loadThemePreference(s)).toBe('system');
    });
});

describe('the list in Settings', () => {
    it('is exactly Same as phone, Classic, Light, Dark -- stored as system, dark, light, night', () => {
        expect(THEME_PREFERENCE_OPTIONS.map(o => o.value)).toEqual(['system', 'dark', 'light', 'night']);
    });

    it('gives every row a name and a line of its own', () => {
        const words = THEME_PREFERENCE_OPTIONS.flatMap(o => [o.label, o.line]);
        expect(new Set(words).size).toBe(words.length);
    });
});
