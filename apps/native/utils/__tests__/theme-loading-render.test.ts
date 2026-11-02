// @vitest-environment jsdom
/**
 * The real ThemeProvider's `themeLoading`. The Map waits on it before it makes its first map (utils/map-scheme.ts), so it has
 * to end whatever the stored read does: a read that fails must not leave a member with no map (memory: no hard gates).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const store = vi.hoisted(() => ({ fails: false, map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => {
            if (store.fails) throw new Error('storage unavailable');
            return store.map.get(k) ?? null;
        },
        setItem: async (k: string, v: string) => { store.map.set(k, v); },
        removeItem: async (k: string) => { store.map.delete(k); },
    },
}));
vi.mock('react-native', () => ({
    Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
    StyleSheet: { create: <T,>(s: T) => s, flatten: <T,>(s: T) => s },
    useColorScheme: () => 'dark',
}));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: async () => {} }));
vi.mock('expo-navigation-bar', () => ({ setStyle: () => {} }));

import { ThemeProvider, useTheme } from '../../app/ThemeContext';
import { DEFAULT_LIGHT_MIGRATION_KEY, THEME_PREFERENCE_KEY } from '../theme-preference';

const seen: Array<{ theme: string; themeLoading: boolean }> = [];
function Probe() {
    const { theme, themeLoading } = useTheme();
    seen.push({ theme, themeLoading });
    return null;
}

let root: Root;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const open = async () => {
    await act(async () => { root.render(createElement(ThemeProvider as any, null, createElement(Probe)) as any); });
    await settle();
};

beforeEach(() => {
    root = createRoot(document.createElement('div'));
    seen.length = 0;
    store.fails = false;
    store.map.clear();
});
afterEach(() => { act(() => root.unmount()); });

describe('themeLoading', () => {
    it('starts true, on the light the provider starts with', async () => {
        await open();
        expect(seen[0]).toEqual({ theme: 'light', themeLoading: true });
    });

    it('never goes false before the member\'s own theme is in', async () => {
        store.map.set(THEME_PREFERENCE_KEY, 'dark');
        store.map.set(DEFAULT_LIGHT_MIGRATION_KEY, '1');
        await open();
        expect(seen[seen.length - 1]).toEqual({ theme: 'dark', themeLoading: false });
        expect(seen.filter((s) => !s.themeLoading && s.theme === 'light')).toEqual([]);
    });

    it('ends when the stored read fails, so the map still shows', async () => {
        store.fails = true;
        await open();
        expect(seen[seen.length - 1]).toEqual({ theme: 'light', themeLoading: false });
    });
});
