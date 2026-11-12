/**
 * The look a member picks in Settings -> Appearance: CLASSIC by default, with Same as phone, Light and Dark offered.
 *
 * One stored value, core's LookChoice (look.ts): 'system' | 'dark' | 'light' | 'night'. Members see Same as phone,
 * Classic, Light and Dark (Marty and Damo, 12 Nov 2026). The stored 'dark' has always been Classic's dark, so it still is:
 * nothing stored is read as anything else, converted or rewritten. Dark (charcoal and blue, always dark) is 'night', the
 * colour set's own name. Same as phone is Light when the phone is light and Classic when it is dark. core's resolveLook is
 * the one rule both apps use.
 *
 * Only a choice is stored (as the web does): a device with nothing stored gets DEFAULT_PREFERENCE and nothing is written,
 * so a change of default reaches it. The default was Light until 12 Nov 2026 and was WRITTEN to storage on first run, so a
 * phone that has opened the app before holds a 'light' it may never have chosen; it cannot be told from a choice and is
 * kept (Marty: a stored choice is kept). Only a phone with nothing stored opens Classic.
 *
 * Per device, the same in every community; never sent to a node and not set by an owner.
 */

import {
    DEFAULT_LOOK,
    brandScheme,
    parseLook,
    resolveLook,
    word,
    type BrandSet,
    type LookChoice,
    type WordKey,
} from '@beanpool/core';

export type ThemePreference = LookChoice;
/** The scheme being drawn: light or dark. Every dark look (Classic, Dark) is 'dark'. */
export type ResolvedTheme = 'light' | 'dark';

/** What a phone with no choice stored gets: Classic. Never written to storage. */
export const DEFAULT_PREFERENCE: ThemePreference = DEFAULT_LOOK;

export const THEME_PREFERENCE_KEY = 'beanpool_theme_mode';
export const LEGACY_THEME_KEY = 'beanpool_theme_pref';
/** Set once the 'system' default written by #930 has been moved to light. See loadThemePreference. */
export const DEFAULT_LIGHT_MIGRATION_KEY = 'beanpool_theme_default_light_v1';

/** One row of Settings -> Appearance: the stored value, its name and the line under it. Both are word() keys: Settings shows them with t(), in the member's language. */
export interface ThemePreferenceOption {
    value: ThemePreference;
    label: WordKey;
    line: WordKey;
}

/** The four choices, in the order Settings lists them: Same as phone, Classic, Light, Dark. core's LOOK_CHOICES holds the values. */
export const THEME_PREFERENCE_OPTIONS: ThemePreferenceOption[] = [
    { value: 'system', label: word('Same as phone'), line: word('Light when your phone is light, Classic when it is dark') },
    { value: 'dark', label: word('Classic', 'appearance'), line: word('Dark with olive green') },
    { value: 'light', label: word('Light', 'appearance'), line: word('Pale and warm') },
    { value: 'night', label: word('Dark', 'appearance'), line: word('Charcoal and blue') },
];

export function parseThemePreference(raw: string | null | undefined): ThemePreference | null {
    return parseLook(raw);
}

/**
 * The colour set to draw. `systemScheme` is whatever useColorScheme()/Appearance reports; the OS may report nothing
 * ('unspecified', null): then the phone is not dark, so Same as phone is Light. A value that is not a choice is Classic.
 */
export function resolveSet(preference: ThemePreference, systemScheme: string | null | undefined): BrandSet {
    return resolveLook(preference, systemScheme === 'dark');
}

/** The scheme of the set to draw (light or dark): what `theme === 'dark'` branches, the status bar and the map ask. */
export function resolveTheme(preference: ThemePreference, systemScheme: string | null | undefined): ResolvedTheme {
    return brandScheme(resolveSet(preference, systemScheme));
}

type PreferenceStorage = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
};

/**
 * Read the stored choice; with none (nothing stored, or a value this build does not know) the default, Classic, and
 * nothing is written for it. The old Dark Mode switch's key (LEGACY_THEME_KEY) is dropped if it is still there: its 'dark'
 * is Classic, which is the default now, and its 'light' said nothing about a choice, so it has nothing left to carry.
 *
 * Also runs the one-time move off the old 'system' default. #930 did not only change the default --
 * it WROTE 'system' to storage on first run, so every device that opened v1.2.39-v1.2.45 has a
 * stored 'system' that it never chose. A stored 'system' is indistinguishable from a deliberate one, so the move is gated
 * on DEFAULT_LIGHT_MIGRATION_KEY and happens exactly once per device: 'Same as phone' picked after
 * that is kept. The marker is written on every path, so choosing 'Same as phone' later never trips it. (The move lands on
 * 'light', the default of that time; it is left as it was.)
 */
export async function loadThemePreference(storage: PreferenceStorage): Promise<ThemePreference> {
    const migrated = (await storage.getItem(DEFAULT_LIGHT_MIGRATION_KEY)) !== null;
    const stored = parseThemePreference(await storage.getItem(THEME_PREFERENCE_KEY));
    if (stored) {
        if (!migrated && stored === 'system') {
            // ORDER MATTERS. The value is written BEFORE the marker, and both are awaited.
            // The marker is the record that this device has been dealt with, so it must never
            // outlive the write it vouches for: if the app is killed, or the write throws, after
            // the marker lands but before the value does, the device keeps 'system' while reading
            // as already-migrated, and nothing ever revisits it -- stranded on 'follow the phone'
            // for good, which is the exact fault this whole function exists to repair, and
            // indistinguishable afterwards from a deliberate choice. Written this way round, the
            // same interruption leaves the marker unset and the move simply retries next launch.
            // Residual cost, accepted: someone who opens Settings and picks 'Same as phone' inside
            // that one-launch window is moved to Light once more on the retry.
            await storage.setItem(THEME_PREFERENCE_KEY, 'light');
            await markMoveDone(storage, migrated);
            return 'light';
        }
        await markMoveDone(storage, migrated);
        return stored;
    }

    if ((await storage.getItem(LEGACY_THEME_KEY)) !== null) await storage.removeItem(LEGACY_THEME_KEY);
    await markMoveDone(storage, migrated);
    return DEFAULT_PREFERENCE;
}

/**
 * Record that the one-time move has run, AFTER whatever value write it vouches for.
 * A failed marker write must not reject the read -- a member with a stored Dark would open Classic for that launch --
 * so it is swallowed and the move retries next launch, which is harmless because the value it would rewrite is
 * already correct.
 */
async function markMoveDone(storage: PreferenceStorage, migrated = false): Promise<void> {
    if (migrated) return;
    try {
        await storage.setItem(DEFAULT_LIGHT_MIGRATION_KEY, 'done');
    } catch { /* retried next launch; the stored value is already right */ }
}
