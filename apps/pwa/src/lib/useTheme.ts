/**
 * useTheme — light/dark theme toggle
 *
 * Persists to localStorage. Applies .light-theme class to <html>.
 * Independent of the map's dark mode toggle.
 */

import { useState, useEffect, useCallback } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'beanpool-theme';

export function useTheme(): [Theme, () => void] {
    const [theme, setTheme] = useState<Theme>(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        // Default to light if no stored preference
        return stored === 'dark' ? 'dark' : 'light';
    });

    useEffect(() => {
        const root = document.documentElement;
        if (theme === 'dark') {
            root.classList.add('dark', 'dark-theme');
            root.classList.remove('light-theme');
        } else {
            root.classList.remove('dark', 'dark-theme');
            root.classList.add('light-theme');
        }
        localStorage.setItem(STORAGE_KEY, theme);
    }, [theme]);

    const toggleTheme = useCallback(() => {
        setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
    }, []);

    return [theme, toggleTheme];
}
