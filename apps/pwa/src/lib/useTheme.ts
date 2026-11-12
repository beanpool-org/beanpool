/**
 * useTheme -- the look: Classic by default, with Light, Dark and 'Same as device' offered in Settings.
 *
 * One stored preference (Settings -> Appearance), core's LookChoice: 'system' | 'dark' | 'light' | 'night'. Members see
 * them as Same as device, Classic, Light and Dark (Marty and Damo, 12 Nov 2026): the stored 'dark' has always been
 * Classic's dark, so it still is, and Dark (charcoal and blue, always dark) is 'night', the colour set's own name. With
 * 'system' the page follows prefers-color-scheme live, including a change made while it is open: Light when the device
 * is light, Classic when it is dark. core's resolveLook is the one rule (look.ts); the choice is per browser, never sent
 * to a node.
 *
 * Applies .dark / .dark-theme or .light-theme to <html>, data-bp-theme="night" for Dark (the CSS block is
 * :root.dark-theme[data-bp-theme="night"], so the attribute alone does nothing), the matching color-scheme, and the
 * browser's theme-color. Independent of the map's dark mode toggle. public/theme-boot.js does the same before the first
 * paint, read-only; theme-boot.test.ts holds the two to one answer.
 *
 * Only a choice is stored. A browser with nothing stored gets DEFAULT_PREFERENCE and nothing is written, so a change of
 * default reaches it; a value this build does not know reads as no choice.
 */

import { useState, useEffect, useCallback } from 'react';
import {
    BRAND_SETS,
    DEFAULT_LOOK,
    brandScheme,
    parseLook,
    resolveLook,
    word,
    type BrandSet,
    type LookChoice,
    type WordKey,
} from '@beanpool/core';
import { brandGrounds } from '@beanpool/core/brand-colours';

/** The scheme drawn: light or dark. Everything that asks "is it dark?" (the .dark class, color-scheme) reads this. */
export type Theme = 'dark' | 'light';
/** What is stored and picked: core's LookChoice. */
export type ThemePreference = LookChoice;

/** What a browser with no choice stored gets: Classic. Never written to storage. */
export const DEFAULT_PREFERENCE: ThemePreference = DEFAULT_LOOK;

const STORAGE_KEY = 'beanpool-theme-mode';
const DARK_QUERY = '(prefers-color-scheme: dark)';

// The banner's ground (--header-bg in index.css, the library's web.banner), so the browser chrome runs on from the header.
const THEME_COLOR = Object.fromEntries(BRAND_SETS.map(set => [set, brandGrounds(set).web.banner])) as Record<BrandSet, string>;

/** One row of Settings -> Appearance: the stored value, its name and the line under it. Both are word() keys: Settings shows them through t(). */
export interface ThemePreferenceOption {
    value: ThemePreference;
    label: WordKey;
    line: WordKey;
}

/** The four choices, in the order Settings lists them: Same as device, Classic, Light, Dark. core's LOOK_CHOICES holds the values. */
export const THEME_PREFERENCE_OPTIONS: ThemePreferenceOption[] = [
    { value: 'system', label: word('Same as device'), line: word('Light when your device is light, Classic when it is dark') },
    { value: 'dark', label: word('Classic', 'appearance'), line: word('Dark with olive green') },
    { value: 'light', label: word('Light', 'appearance'), line: word('Pale and warm') },
    { value: 'night', label: word('Dark', 'appearance'), line: word('Charcoal and blue') },
];

/** The colour set to draw: core's resolveLook (Light on a light device and Classic on a dark one for 'system'; Classic for what is not a choice). */
export function resolveSet(preference: ThemePreference, systemDark: boolean): BrandSet {
    return resolveLook(preference, systemDark);
}

/** The scheme of what is drawn. */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
    return brandScheme(resolveSet(preference, systemDark));
}

function readStorage(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}

/** Private mode throws on every write: the choice then lasts for this visit, not a crash. */
function writeStorage(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function loadThemePreference(): ThemePreference {
    return parseLook(readStorage(STORAGE_KEY)) ?? DEFAULT_PREFERENCE;
}

function systemPrefersDark(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function useTheme(): [Theme, ThemePreference, (preference: ThemePreference) => void, BrandSet] {
    const [preference, setPreferenceState] = useState<ThemePreference>(loadThemePreference);
    const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);
    const set = resolveSet(preference, systemDark);
    const theme = brandScheme(set);

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
        // Light and Classic are the two plain blocks; Dark adds its attribute on top of .dark-theme.
        if (set === 'light' || set === 'dark') root.removeAttribute('data-bp-theme');
        else root.setAttribute('data-bp-theme', set);
        root.style.colorScheme = theme;
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[set]);
    }, [set, theme]);

    const setPreference = useCallback((next: ThemePreference) => {
        setPreferenceState(next);
        writeStorage(STORAGE_KEY, next);
    }, []);

    return [theme, preference, setPreference, set];
}
