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
    /** Whether the doodle background is drawn. Off = the flat colour, per device. */
    patternEnabled: boolean;
    colors: typeof lightColors;
    setThemePreference: (preference: ThemePreference) => void;
    setLightPalette: (palette: LightPaletteMode) => void;
    setPatternEnabled: (enabled: boolean) => void;
}

const PATTERN_KEY = 'beanpool_background_pattern';

/** The flat colour the doodle tiles are drawn on — sampled from the art itself. */
const PATTERN_GROUND = { light: '#f1f1e4', dark: '#101717' } as const;

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    // Live: re-renders when the phone switches light/dark while the app is open.
    const systemScheme = useColorScheme();
    const [themePreference, setThemePreferenceState] = useState<ThemePreference>('system');
    const [lightPalette, setLightPaletteState] = useState<LightPaletteMode>('classic');
    // On by default; 'plain' is the opt-out, stored per device like the palette choice.
    const [patternEnabled, setPatternEnabledState] = useState(true);
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

    const setLightPalette = async (palette: LightPaletteMode) => {
        setLightPaletteState(palette);
        await AsyncStorage.setItem('beanpool_light_palette', palette);
    };

    const resolvedColors = useMemo(() => {
        const base = theme === 'dark'
            ? (darkColors as unknown as typeof lightColors)
            : lightPaletteColors[lightPalette];
        // The pattern is drawn once, behind the navigator. Page containers therefore go
        // transparent so it shows through; surface.app stays solid for the inputs, chips and
        // sunken rows that share the token and must not become see-through.
        if (!patternEnabled) return base;
        // Chrome that must stay opaque (the tab strip, the controls block that the feed slides
        // under) takes the tile's own ground colour, so it reads as the same surface as the
        // wallpaper rather than a second, paler one laid on top.
        const ground = theme === 'dark' ? PATTERN_GROUND.dark : PATTERN_GROUND.light;
        return { ...base, surface: { ...base.surface, page: 'transparent', chrome: ground } };
    }, [theme, lightPalette, patternEnabled]);

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
        patternEnabled,
        colors: resolvedColors,
        setThemePreference,
        setLightPalette,
        setPatternEnabled,
    }), [theme, themePreference, lightPalette, patternEnabled, resolvedColors]);

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
