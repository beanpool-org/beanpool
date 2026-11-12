import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SystemUI from 'expo-system-ui';
import * as NavigationBar from 'expo-navigation-bar';
import { brandScheme, type BrandSet } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import { drawnColours } from '../utils/drawn-colours';
import { onboardingColors } from '../utils/onboarding-colors';
import {
    type ResolvedTheme,
    type ThemePreference,
    THEME_PREFERENCE_KEY,
    loadThemePreference,
    resolveTheme,
} from '../utils/theme-preference';

export type ThemeMode = ResolvedTheme;
export type { ThemePreference };

export interface ThemeContextType {
    /**
     * The scheme being drawn, light or dark: the scheme of `set`. Everything that asks "is it dark?" (the status bar, the
     * map, `theme === 'dark'` in a screen) reads this, so a dark colour set needs no change there.
     */
    theme: ThemeMode;
    /**
     * The colour set being drawn (core's BRAND_SETS: `light`, `dark` = Classic, `night` = Dark); `colors` is its tree.
     * Today the stored preference only reaches `light` and `dark`, so the set is the theme; the picker (slice T3) widens it.
     */
    set: BrandSet;
    /** The stored choice is still being read, so `theme` may not be the member's yet. The Map waits this out: its first draw fixes its base. */
    themeLoading: boolean;
    /** What the member chose in Settings: follow the phone, or always light/dark. */
    themePreference: ThemePreference;
    /** Whether the doodle background is drawn. Off = the flat colour, per device. */
    patternEnabled: boolean;
    colors: AppColors;
    setThemePreference: (preference: ThemePreference) => void;
    setPatternEnabled: (enabled: boolean) => void;
}

const PATTERN_KEY = 'beanpool_background_pattern';

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    // Live: re-renders when the phone switches light/dark while the app is open.
    const systemScheme = useColorScheme();
    // Light until the stored preference loads. This is the value the first render draws with, and on
    // Android the map bakes its base light/dark in when it is created (userInterfaceStyle is an
    // initialProp there), so a 'system' default made a dark-phone user's map dark even after the
    // stored 'light' arrived. See utils/theme-preference.ts.
    const [themePreference, setThemePreferenceState] = useState<ThemePreference>('light');
    const [themeLoading, setThemeLoading] = useState(true);
    // On by default; 'plain' is the opt-out, stored per device like the theme choice.
    const [patternEnabled, setPatternEnabledState] = useState(true);
    // The set: 'light' or 'dark' (Classic), the only two the stored preference names until the picker (T3).
    const set: BrandSet = resolveTheme(themePreference, systemScheme);
    const theme: ThemeMode = brandScheme(set);

    useEffect(() => {
        loadThemePreference(AsyncStorage)
            .then(setThemePreferenceState)
            .catch(() => { /* keep 'light' */ })
            // On a failed read too: nothing waits for ever on this.
            .finally(() => setThemeLoading(false));
        AsyncStorage.getItem(PATTERN_KEY)
            .then((pref) => { if (pref === 'plain') setPatternEnabledState(false); })
            .catch(() => { /* keep the pattern on */ });
    }, []);

    const setThemePreference = async (preference: ThemePreference) => {
        setThemePreferenceState(preference);
        await AsyncStorage.setItem(THEME_PREFERENCE_KEY, preference);
    };

    const setPatternEnabled = async (enabled: boolean) => {
        setPatternEnabledState(enabled);
        await AsyncStorage.setItem(PATTERN_KEY, enabled ? 'pattern' : 'plain');
    };

    // The set's tree; with the pattern on, a see-through page and the doodle's ground as the chrome (utils/drawn-colours.ts).
    const resolvedColors = useMemo(() => drawnColours(set, patternEnabled), [set, patternEnabled]);

    // System bars and the root window follow the drawn theme, not the phone's: with an override
    // the two can differ. The status bar icons are set per screen with <StatusBar>; here the
    // window behind everything (seen during transitions and keyboard moves) and, on Android, the
    // navigation bar's button colour (needs enforceContrast: false in the expo-navigation-bar plugin).
    useEffect(() => {
        SystemUI.setBackgroundColorAsync(resolvedColors.surface.app).catch(() => {});
        if (Platform.OS === 'android') {
            try { NavigationBar.setStyle(theme === 'dark' ? 'dark' : 'light'); } catch { /* older module */ }
        }
    }, [theme, resolvedColors]);

    const value = useMemo(() => ({
        theme,
        set,
        themeLoading,
        themePreference,
        patternEnabled,
        colors: resolvedColors,
        setThemePreference,
        setPatternEnabled,
    }), [theme, set, themeLoading, themePreference, patternEnabled, resolvedColors]);

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
}

/** The drawn set's tokens for the onboarding screens; see utils/onboarding-colors.ts. */
export function useOnboardingColors() {
    const { set } = useTheme();
    return useMemo(() => onboardingColors(set), [set]);
}

export function useStyles<T extends Record<string, any>>(
    factory: (theme: ThemeContextType) => T
): T {
    const themeContext = useTheme();
    // Cache the created styles and only regenerate when the theme changes
    return useMemo(() => factory(themeContext), [themeContext]);
}
