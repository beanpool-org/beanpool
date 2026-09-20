/**
 * useTheme — light/dark: LIGHT by default, with 'Same as device' and Dark offered in Settings.
 *
 * One stored preference, 'system' | 'light' | 'dark' (Settings → Appearance). With 'system' the
 * page follows prefers-color-scheme live, including a change made while it is open. Applies
 * .dark / .dark-theme or .light-theme to <html>, the matching color-scheme, and the browser's
 * theme-color. Independent of the map's dark mode toggle.
 *
 * The old toggle stored 'light' | 'dark' under LEGACY_KEY — and wrote 'light' on every load, so
 * only 'dark' says anything about a choice. It is read once to seed the new key, then removed.
 *
 * The default was 'system' from #930 (2026-09-19) until 2026-09-20, matching the phone app. Both are
 * back to light: following the device surprised people whose device is in night mode. #930 also WROTE
 * 'system' to storage on first load, so DEFAULT_LIGHT_MIGRATION_KEY moves that stored default to light
 * exactly once per browser; 'Same as device' chosen after that is kept.
 */

import { useState, useEffect, useCallback } from 'react';

export type Theme = 'dark' | 'light';
export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'beanpool-theme-mode';
const LEGACY_KEY = 'beanpool-theme';
const DEFAULT_LIGHT_MIGRATION_KEY = 'beanpool-theme-default-light-v1';
const DARK_QUERY = '(prefers-color-scheme: dark)';

// --header-bg in index.css, so the browser chrome runs on from the header.
const THEME_COLOR: Record<Theme, string> = { light: '#fbfaf8', dark: '#1d231d' };

export const THEME_PREFERENCE_OPTIONS: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'Same as device' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
];

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
    if (preference === 'light' || preference === 'dark') return preference;
    return systemDark ? 'dark' : 'light';
}

function readStorage(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string | null) {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch { /* private mode: the choice lasts for this visit */ }
}

export function loadThemePreference(): ThemePreference {
    const migrated = readStorage(DEFAULT_LIGHT_MIGRATION_KEY) !== null;
    const stored = readStorage(STORAGE_KEY);
    if (!migrated) writeStorage(DEFAULT_LIGHT_MIGRATION_KEY, 'done');

    if (stored === 'system' || stored === 'light' || stored === 'dark') {
        if (!migrated && stored === 'system') {
            writeStorage(STORAGE_KEY, 'light');
            return 'light';
        }
        return stored;
    }

    const legacy = readStorage(LEGACY_KEY);
    const seeded: ThemePreference = legacy === 'dark' ? 'dark' : 'light';
    writeStorage(STORAGE_KEY, seeded);
    if (legacy !== null) writeStorage(LEGACY_KEY, null);
    return seeded;
}

function systemPrefersDark(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function useTheme(): [Theme, ThemePreference, (preference: ThemePreference) => void] {
    const [preference, setPreferenceState] = useState<ThemePreference>(loadThemePreference);
    const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);
    const theme = resolveTheme(preference, systemDark);

    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const mql = window.matchMedia(DARK_QUERY);
        const onChange = () => setSystemDark(mql.matches);
        onChange();
        mql.addEventListener?.('change', onChange);
        return () => mql.removeEventListener?.('change', onChange);
    }, []);

    useEffect(() => {
        const root = document.documentElement;
        if (theme === 'dark') {
            root.classList.add('dark', 'dark-theme');
            root.classList.remove('light-theme');
        } else {
            root.classList.remove('dark', 'dark-theme');
            root.classList.add('light-theme');
        }
        root.style.colorScheme = theme;
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
    }, [theme]);

    const setPreference = useCallback((next: ThemePreference) => {
        setPreferenceState(next);
        writeStorage(STORAGE_KEY, next);
    }, []);

    return [theme, preference, setPreference];
}
