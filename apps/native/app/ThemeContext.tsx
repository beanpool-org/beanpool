import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { lightColors, darkColors, earthColors, slateColors } from '../constants/colors';

export type ThemeMode = 'light' | 'dark';
export type LightPaletteMode = 'classic' | 'earth' | 'slate';

export const lightPaletteColors: Record<LightPaletteMode, typeof lightColors> = {
    classic: lightColors,
    earth: earthColors as unknown as typeof lightColors,
    slate: slateColors as unknown as typeof lightColors,
};

export interface ThemeContextType {
    theme: ThemeMode;
    lightPalette: LightPaletteMode;
    colors: typeof lightColors;
    toggleTheme: () => void;
    setLightPalette: (palette: LightPaletteMode) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme, setTheme] = useState<ThemeMode>('light');
    const [lightPalette, setLightPaletteState] = useState<LightPaletteMode>('classic');

    useEffect(() => {
        Promise.all([
            AsyncStorage.getItem('beanpool_theme_pref'),
            AsyncStorage.getItem('beanpool_light_palette'),
        ]).then(([themePref, palettePref]) => {
            if (themePref === 'light' || themePref === 'dark') {
                setTheme(themePref);
            }
            if (palettePref === 'classic' || palettePref === 'earth' || palettePref === 'slate') {
                setLightPaletteState(palettePref);
            }
        });
    }, []);

    const toggleTheme = async () => {
        const nextTheme = theme === 'light' ? 'dark' : 'light';
        setTheme(nextTheme);
        await AsyncStorage.setItem('beanpool_theme_pref', nextTheme);
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

    const value = useMemo(() => ({
        theme,
        lightPalette,
        colors: resolvedColors,
        toggleTheme,
        setLightPalette,
    }), [theme, lightPalette, resolvedColors]);

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
