// @vitest-environment jsdom
/**
 * Two grounds that stayed light in a dark set (walk 148, the 1.4.8 build on API 26), from the theme now:
 *  1. The empty picture frame (PhotoCarousel, as a Learn page draws it) was a near-white box in Dark: module-level light
 *     styles. It takes the drawn set's sunken ground; the counter and the dots sit on the photo and stay white.
 *  2. Android 8 and 9's navigation bar was a light grey strip with the page's words behind it (React Native's own colour,
 *     from the PHONE's night mode): modules/nav-bar-colour paints it the app's chrome, in every set, and nothing from
 *     Android 10 on. Its Kotlin isn't run here: the wiring to it is read from its files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const phone = vi.hoisted(() => ({ Version: 26 as number | string, OS: 'android', store: new Map<string, string>() }));
vi.mock('react-native', async () => {
    const React = await import('react');
    const flat = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(4).filter((s) => s && typeof s === 'object'));
    const el = (tag: string) => (p: any) => React.createElement(tag, { 'data-testid': p.testID, 'data-style': JSON.stringify(flat(p.style)) }, p.children);
    return {
        Platform: { get OS() { return phone.OS; }, get Version() { return phone.Version; } },
        useColorScheme: () => 'light',
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: React.forwardRef((p: any, _ref) => React.createElement('div', null, p.children)),
        StyleSheet: { create: (s: unknown) => s },
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async (k: string) => phone.store.get(k) ?? null, setItem: async (k: string, v: string) => { phone.store.set(k, v); }, removeItem: async () => {} } }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: async () => undefined }));
vi.mock('expo-navigation-bar', () => ({ setStyle: () => {} }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));

import { ThemeProvider } from '../../app/ThemeContext';
import { PhotoCarousel } from '../../components/PhotoCarousel';
import { COLOUR_SETS } from '../../constants/colors';
import { argbOf, CLEAR_NAV_BAR_API, NAV_BAR_MODULE, paintNavBar } from '../../modules/nav-bar-colour';
import { drawnColours } from '../drawn-colours';
import { THEME_PREFERENCE_KEY } from '../theme-preference';

const SETS = ['light', 'dark', 'night'] as const;
const painted: number[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
const withBar = (set: (argb: number) => Promise<void> = async (argb) => { painted.push(argb); }) => { (globalThis as any).expo = { modules: { [NAV_BAR_MODULE]: { set } } }; };
beforeEach(() => { painted.length = 0; phone.Version = 26; phone.OS = 'android'; phone.store.clear(); withBar(); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; delete (globalThis as any).expo; });

async function draw(set: (typeof SETS)[number], child: unknown = null) {
    phone.store.set(THEME_PREFERENCE_KEY, set);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(ThemeProvider, null, child as any) as any); });
    for (let i = 0; i < 4; i++) await act(async () => {});
}
const style = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') || '{}');

describe('the empty picture frame', () => {
    it.each(SETS)('%s: the set\'s own sunken ground; the counter and the lit dot white on the photo', async (set) => {
        await draw(set, createElement(PhotoCarousel, { photos: ['https://node.example/a.jpg', 'https://node.example/b.jpg'], height: 220 }));
        const frame = Array.from(host!.querySelectorAll('div')).find((d) => style(d).height === 220 && style(d).overflow === 'hidden')!;
        expect(style(frame).backgroundColor).toBe(COLOUR_SETS[set].surface.subtle);
        const counter = Array.from(host!.querySelectorAll('span')).find((s) => /1\s*\/\s*2/.test(s.textContent ?? ''))!;
        expect(style(counter).color).toBe('#ffffff');
        const lit = Array.from(host!.querySelectorAll('div')).find((d) => style(d).width === 18)!;
        expect(style(lit).backgroundColor).toBe('#ffffff');
    });
    it('light is the frame it was, and no dark set draws a light box', () => {
        expect(COLOUR_SETS.light.surface.subtle).toBe('#f1efea');
        for (const set of ['dark', 'night'] as const) expect(parseInt(COLOUR_SETS[set].surface.subtle.slice(1, 3), 16)).toBeLessThan(0x40);
    });
});

describe("Android 8 and 9's navigation bar", () => {
    it.each(SETS)('%s: painted the app\'s chrome, opaque, as a signed Android colour', async (set) => {
        await draw(set);
        const chrome = drawnColours(set, true).surface.chrome;
        expect(chrome).toMatch(/^#[0-9a-f]{6}$/i);
        expect(painted.at(-1)).toBe(argbOf(chrome));
        expect(painted.at(-1)! >>> 24, 'opaque').toBe(0xff);
        expect(Number.isInteger(painted.at(-1)!) && painted.at(-1)! < 0).toBe(true);
    });

    it('the pattern off, the chrome is the flat page: never a see-through token', () => {
        for (const set of SETS) for (const pattern of [true, false]) expect(argbOf(drawnColours(set, pattern).surface.chrome), `${set} ${pattern}`).not.toBeNull();
        expect(argbOf('transparent')).toBeNull();
        expect(argbOf('rgba(0,0,0,0.5)')).toBeNull();
        expect(argbOf('#000000')).toBe(-16777216);
        expect(argbOf('#ffffff')).toBe(-1);
    });

    it('only there: nothing from Android 10 on, on iOS, or in a build without the module; a refusal is quiet', async () => {
        expect(CLEAR_NAV_BAR_API).toBe(29);
        for (const api of [29, 30, 35, Number('18.2'.replace('18.2', 'NaN')), Number(undefined)]) paintNavBar('#101010', api);
        expect(painted).toEqual([]);
        paintNavBar('#101010', 28);
        paintNavBar('#101010', 26);
        expect(painted).toHaveLength(2);
        phone.Version = 35;
        await draw('night');
        expect(painted).toHaveLength(2);
        act(() => root?.unmount());
        phone.OS = 'ios'; phone.Version = '18.2';
        await draw('night');
        expect(painted).toHaveLength(2);
        delete (globalThis as any).expo;
        expect(() => paintNavBar('#101010', 26)).not.toThrow();
        withBar(() => { throw new Error('no'); });
        expect(() => paintNavBar('#101010', 26)).not.toThrow();
        withBar(() => Promise.reject(new Error('no activity')));
        expect(() => paintNavBar('#101010', 26)).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));
    });

    it('the module is what Expo links: its config, its package, its name and its function', () => {
        const dir = path.resolve(__dirname, '../../modules/nav-bar-colour');
        const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
        const config = JSON.parse(read('expo-module.config.json'));
        expect(config).toEqual({ platforms: ['android'], android: { modules: ['org.beanpool.navbarcolour.NavBarColourModule'] } });
        const kotlin = read('android/src/main/java/org/beanpool/navbarcolour/NavBarColourModule.kt');
        expect(kotlin).toContain('package org.beanpool.navbarcolour');
        expect(kotlin).toContain('class NavBarColourModule : Module()');
        expect(kotlin).toContain(`Name("${NAV_BAR_MODULE}")`);
        expect(kotlin).toContain('AsyncFunction("set") { argb: Int ->');
        // A window is touched on the main thread, and never from Android 10 on.
        expect(kotlin).toContain('}.runOnQueue(Queues.MAIN)');
        expect(kotlin).toContain('if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return');
        expect(read('android/build.gradle')).toContain('namespace "org.beanpool.navbarcolour"');
        expect(fs.existsSync(path.join(dir, 'android/src/main/AndroidManifest.xml'))).toBe(true);
    });
});
