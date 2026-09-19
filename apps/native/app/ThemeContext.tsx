import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SystemUI from 'expo-system-ui';
import * as NavigationBar from 'expo-navigation-bar';
import { lightColors, darkColors, earthColors, slateColors } from '../constants/colors';
import {
    type ResolvedTheme,
    type ThemePreference,
    THEME_PREFERENCE_KEY,
    loadThemePreference,
    resolveTheme,
} from '../utils/theme-preference';

export type ThemeMode = ResolvedTheme;
export type { ThemePreference };
export type LightPaletteMode = 'classic' | 'earth' | 'slate';

export const lightPaletteColors: Record<LightPaletteMode, typeof lightColors> = {
    classic: lightColors,
    earth: earthColors as unknown as typeof lightColors,
    slate: slateColors as unknown as typeof lightColors,
};

export interface ThemeContextType {
    /** The theme being drawn — the preference resolved against the phone's setting. */
    theme: ThemeMode;
    /** What the member chose in Settings: follow the phone, or always light/dark. */
    themePreference: ThemePreference;
    lightPalette: LightPaletteMode;
    colors: typeof lightColors;
    setThemePreference: (preference: ThemePreference) => void;
    setLightPalette: (palette: LightPaletteMode) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    // Live: re-renders when the phone switches light/dark while the app is open.
    const systemScheme = useColorScheme();
    const [themePreference, setThemePreferenceState] = useState<ThemePreference>('system');
    const [lightPalette, setLightPaletteState] = useState<LightPaletteMode>('classic');
    const theme = resolveTheme(themePreference, systemScheme);

    useEffect(() => {
        loadThemePreference(AsyncStorage)
            .then(setThemePreferenceState)
            .catch(() => { /* keep 'system' */ });
        AsyncStorage.getItem('beanpool_light_palette').then((palettePref) => {
            if (palettePref === 'classic' || palettePref === 'earth' || palettePref === 'slate') {
                setLightPaletteState(palettePref);
            }
        });
    }, []);

    const setThemePreference = async (preference: ThemePreference) => {
        setThemePreferenceState(preference);
        await AsyncStorage.setItem(THEME_PREFERENCE_KEY, preference);
    };

    const setLightPalette = async (palette: LightPaletteMode) => {
        setLightPaletteState(palette);
        await AsyncStorage.setItem('beanpool_light_palette', palette);
    };

    const resolvedColors = useMemo(() => {
        if (theme === 'dark') {
            return darkColors as unknown as typeof lightColors;
        }
        return lightPaletteColors[lightPalette];
    }, [theme, lightPalette]);

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
        themePreference,
        lightPalette,
        colors: resolvedColors,
        setThemePreference,
        setLightPalette,
    }), [theme, themePreference, lightPalette, resolvedColors]);

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

export function useStyles<T extends Record<string, any>>(
    factory: (theme: ThemeContextType) => T
): T {
    const themeContext = useTheme();
    // Cache the created styles and only regenerate when the theme or light palette changes
    return useMemo(() => factory(themeContext), [themeContext]);
}
