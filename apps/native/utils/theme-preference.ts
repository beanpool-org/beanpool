/**
 * Light/dark choice: LIGHT by default, with 'Same as phone' and Dark offered in Settings.
 *
 * The default was 'system' until 2026-09-20. It was changed because following the phone surprised
 * people whose phone is in night mode -- they opened a light-looking app and got a dark one -- and
 * because the map's base colours can't follow a late theme change on Android (see (tabs)/map.tsx),
 * so starting light keeps the map and the chrome agreeing. Anyone who wants the old behaviour picks
 * 'Same as phone'.
 *
 * One stored preference — 'system' | 'light' | 'dark'. The old Settings → Dark Mode switch stored
 * 'light' | 'dark' under LEGACY_THEME_KEY; it is read once to seed the new key and then removed.
 * Only a stored 'dark' carries over: 'light' was the switch's default state, so it says nothing
 * about a choice, and those users start on the default like everyone else.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREFERENCE_KEY = 'beanpool_theme_mode';
export const LEGACY_THEME_KEY = 'beanpool_theme_pref';
/** Set once the 'system' default written by #930 has been moved to light. See loadThemePreference. */
export const DEFAULT_LIGHT_MIGRATION_KEY = 'beanpool_theme_default_light_v1';

export const THEME_PREFERENCE_OPTIONS: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'Same as phone' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
];

export function parseThemePreference(raw: string | null | undefined): ThemePreference | null {
    return raw === 'system' || raw === 'light' || raw === 'dark' ? raw : null;
}

/** The seed for a device that has no stored preference yet. */
export function preferenceFromLegacy(legacy: string | null | undefined): ThemePreference {
    return legacy === 'dark' ? 'dark' : 'light';
}

/**
 * The theme to draw. `systemScheme` is whatever useColorScheme()/Appearance reports; the OS may
 * report nothing ('unspecified', null) — then light, the app's long-standing default.
 */
export function resolveTheme(preference: ThemePreference, systemScheme: string | null | undefined): ResolvedTheme {
    if (preference === 'light' || preference === 'dark') return preference;
    return systemScheme === 'dark' ? 'dark' : 'light';
}

type PreferenceStorage = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
};

/**
 * Read the stored preference, seeding it from the old switch the first time and dropping that key.
 *
 * Also runs the one-time move off the old 'system' default. #930 did not only change the default --
 * it WROTE 'system' to storage on first run, so every device that opened v1.2.39-v1.2.45 has a
 * stored 'system' that it never chose. Changing the seed alone would leave all of them following the
 * phone for ever. A stored 'system' is indistinguishable from a deliberate one, so the move is gated
 * on DEFAULT_LIGHT_MIGRATION_KEY and happens exactly once per device: 'Same as phone' picked after
 * that is kept. The marker is written on every path, so choosing 'Same as phone' later never trips it.
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

    const legacy = await storage.getItem(LEGACY_THEME_KEY);
    const seeded = preferenceFromLegacy(legacy);
    await storage.setItem(THEME_PREFERENCE_KEY, seeded);
    if (legacy !== null) await storage.removeItem(LEGACY_THEME_KEY);
    await markMoveDone(storage, migrated);
    return seeded;
}

/**
 * Record that the one-time move has run, AFTER whatever value write it vouches for.
 * A failed marker write must not reject the read -- a member with a stored Dark would open Light
 * for that launch -- so it is swallowed and the move retries next launch, which is harmless
 * because the value it would rewrite is already correct.
 */
async function markMoveDone(storage: PreferenceStorage, migrated = false): Promise<void> {
    if (migrated) return;
    try {
        await storage.setItem(DEFAULT_LIGHT_MIGRATION_KEY, 'done');
    } catch { /* retried next launch; the stored value is already right */ }
}
