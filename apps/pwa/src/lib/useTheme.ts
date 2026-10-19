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
 * written, so a change of default reaches it. That was not always so, and it decides who is moved:
 *
 * - The old toggle stored 'light' | 'dark' under LEGACY_KEY — and wrote 'light' on every load, so
 *   'light' there is either nobody's choice or a toggle back from Dark; the two read the same. Both
 *   are carried over as they are, to the new key, then the old key is removed — but only once that
 *   write has landed, or the choice is lost with nothing left to recover it from.
 * - #930 (2026-09-19) made the default 'system' and WROTE it on first load. #1003 (2026-09-20) made
 *   the default Light, moved that stored 'system' to light once per browser
 *   (DEFAULT_LIGHT_MIGRATION_KEY), and wrote 'light' on every first load from then on. So from
 *   2026-09-20 to this change a stored 'light' is the default, that move, or a pick in Settings, and
 *   nothing stored tells them apart: every stored 'light' is kept, as a possible choice. Only a
 *   'system' #930 wrote and #1003 has not yet moved (no marker) is still known to be nobody's: it
 *   goes, and the default applies. 'Same as device' chosen after the move is kept.
 */

import { useState, useEffect, useCallback } from 'react';

export type Theme = 'dark' | 'light';
export type ThemePreference = 'system' | 'light' | 'dark';

/** What a browser with no choice stored gets. Never written to storage. */
export const DEFAULT_PREFERENCE: ThemePreference = 'dark';

const STORAGE_KEY = 'beanpool-theme-mode';
const LEGACY_KEY = 'beanpool-theme';
// The name is #1003's; it now marks "#930's stored 'system' has been dealt with", whatever the default.
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

/** Returns whether the write actually landed. Private mode throws on every write: false, not a crash. */
function writeStorage(key: string, value: string | null): boolean {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
        return true;
    } catch { /* private mode: the choice lasts for this visit */ return false; }
}

export function loadThemePreference(): ThemePreference {
    const migrated = readStorage(DEFAULT_LIGHT_MIGRATION_KEY) !== null;
    const stored = readStorage(STORAGE_KEY);
    // Written on every path, a fresh browser's too: without it a 'Same as device' picked later would
    // read as #930's and be dropped on the next load.
    const markDone = () => { if (!migrated) writeStorage(DEFAULT_LIGHT_MIGRATION_KEY, 'done'); };

    if (stored === 'system' || stored === 'light' || stored === 'dark') {
        if (!migrated && stored === 'system') {
            // #930's written default: nobody chose it, so it goes and the default applies.
            // Value first, marker second, AND the marker only if the value actually landed — see the
            // note in the native copy. The marker must never outlive the write it vouches for, or the
            // browser reads as migrated while still holding 'system' and nothing revisits it.
            // Ordering alone is not enough here: writeStorage swallows its throw, so without the
            // return-value check the marker would still land after a failed value write and the
            // reorder would be a no-op for that case. In private mode BOTH writes fail, so nothing
            // persists and every load returns the default — the pre-existing, documented limitation.
            if (writeStorage(STORAGE_KEY, null)) markDone();
            return DEFAULT_PREFERENCE;
        }
        markDone();
        return stored;
    }

    const legacy = readStorage(LEGACY_KEY);
    if (legacy === 'light' || legacy === 'dark') {
        // Drop the old key only once the new one has actually landed. Deleting it after a write that
        // failed loses a carried-over choice for good: the next load finds neither key and gets the
        // default. Same fault as the marker ordering -- a destructive step running after a write that
        // did not land. The native copy is immune by accident: its unguarded await rejects before it
        // reaches removeItem.
        // Accepted, and deliberate: if the carry-over write fails AND a later pick also fails to
        // persist, storage healing afterwards resurrects the old value. That is the last durably
        // stored signal, and neither behaviour honours a choice that was never written. The only way
        // to avoid it is to delete the legacy key early, which is the bug above. Don't "fix" it.
        if (writeStorage(STORAGE_KEY, legacy)) writeStorage(LEGACY_KEY, null);
        markDone();
        return legacy;
    }

    markDone();
    return DEFAULT_PREFERENCE;
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
        // Second and last chance to reap the legacy key: the seed path is never re-entered once a
        // preference is stored, so a seed write that failed would otherwise leave it for ever.
        if (writeStorage(STORAGE_KEY, next)) writeStorage(LEGACY_KEY, null);
    }, []);

    return [theme, preference, setPreference];
}
