/**
 * useTheme — light/dark: DARK by default (Marty, 16 Oct 2026), with Light and 'Same as device' offered in Settings.
 *
 * One stored preference, 'system' | 'light' | 'dark' (Settings → Appearance). With 'system' the
 * page follows prefers-color-scheme live, including a change made while it is open. Applies
 * .dark / .dark-theme or .light-theme to <html>, the matching color-scheme, and the browser's
 * theme-color. Independent of the map's dark mode toggle. public/theme-boot.js does the same
 * before the first paint, read-only; theme-boot.test.ts holds the two to one answer.
 *
 * Only a choice is stored. A browser with nothing stored gets DEFAULT_PREFERENCE and nothing is
 * written, so a change of default reaches it.
 */

import { useState, useEffect, useCallback } from 'react';
import { word, type WordKey } from '@beanpool/core';

export type Theme = 'dark' | 'light';
export type ThemePreference = 'system' | 'light' | 'dark';

/** What a browser with no choice stored gets. Never written to storage. */
export const DEFAULT_PREFERENCE: ThemePreference = 'dark';

const STORAGE_KEY = 'beanpool-theme-mode';
const DARK_QUERY = '(prefers-color-scheme: dark)';

// --header-bg in index.css, so the browser chrome runs on from the header.
const THEME_COLOR: Record<Theme, string> = { light: '#fbfaf8', dark: '#1d231d' };

/** Settings → Appearance's three choices. The labels are word() keys: Settings shows them through t(). */
export const THEME_PREFERENCE_OPTIONS: { value: ThemePreference; label: WordKey }[] = [
    { value: 'system', label: word('Same as device') },
    { value: 'light', label: word('Light', 'appearance') },
    { value: 'dark', label: word('Dark', 'appearance') },
];

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
    if (preference === 'light' || preference === 'dark') return preference;
    return systemDark ? 'dark' : 'light';
}

function readStorage(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}

/** Private mode throws on every write: the choice then lasts for this visit, not a crash. */
function writeStorage(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function loadThemePreference(): ThemePreference {
    const stored = readStorage(STORAGE_KEY);
    return stored === 'system' || stored === 'light' || stored === 'dark' ? stored : DEFAULT_PREFERENCE;
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
