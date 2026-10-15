/**
 * public/theme-boot.js draws the theme before the first paint; useTheme.ts takes over once the app mounts. If the two
 * disagree, the page flips on load (a light page before Dark, or the reverse). This runs the real file for every
 * stored state the keys can hold, with the device light and dark, and asks both for the same answer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadThemePreference, resolveTheme } from './useTheme';

const BOOT = fs.readFileSync(path.resolve(__dirname, '../../public/theme-boot.js'), 'utf8');
const INDEX = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');

const MODE = [null, 'light', 'dark', 'system', 'junk'] as const;
const MARKER = [null, 'done'] as const;
const LEGACY = [null, 'light', 'dark'] as const;

function setDevice(dark: boolean) {
    window.matchMedia = ((query: string) => ({
        matches: dark && query === '(prefers-color-scheme: dark)',
        media: query,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
}

function store(key: string, value: string | null) {
    if (value !== null) localStorage.setItem(key, value);
}

function bootTheme(): { theme: string; scheme: string; color: string | null | undefined; classes: string } {
    new Function(BOOT)();
    const root = document.documentElement;
    return {
        theme: root.classList.contains('dark-theme') ? 'dark' : 'light',
        scheme: root.style.colorScheme,
        color: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
        classes: [...root.classList].sort().join(' '),
    };
}

describe('theme-boot.js agrees with useTheme for every stored state', () => {
    const realMatchMedia = window.matchMedia;
    beforeEach(() => {
        localStorage.clear();
        // As index.html ships it: dark, before the script runs.
        document.documentElement.className = 'dark dark-theme';
        document.documentElement.style.colorScheme = 'dark';
        document.head.innerHTML = '<meta name="theme-color" content="#1d231d">';
    });
    afterEach(() => { window.matchMedia = realMatchMedia; });

    const cases = MODE.flatMap((mode) => MARKER.flatMap((marker) => LEGACY.flatMap((legacy) =>
        [false, true].map((deviceDark) => [mode, marker, legacy, deviceDark] as const))));

    it.each(cases)('mode=%s marker=%s legacy=%s device dark=%s', (mode, marker, legacy, deviceDark) => {
        store('beanpool-theme-mode', mode);
        store('beanpool-theme-default-light-v1', marker);
        store('beanpool-theme', legacy);
        setDevice(deviceDark);

        const boot = bootTheme();
        const expected = resolveTheme(loadThemePreference(), deviceDark);

        expect(boot.theme).toBe(expected);
        expect(boot.scheme).toBe(expected);
        expect(boot.color).toBe(expected === 'dark' ? '#1d231d' : '#fbfaf8');
        expect(boot.classes).toBe(expected === 'dark' ? 'dark dark-theme' : 'light-theme');
    });

    it('draws Dark when storage is blocked, as useTheme does', () => {
        const desc = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
        Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
        try {
            expect(bootTheme().theme).toBe('dark');
            expect(loadThemePreference()).toBe('dark');
        } finally {
            Object.defineProperty(window, 'localStorage', desc);
        }
    });

    it('only reads storage: the first paint never writes a theme', () => {
        store('beanpool-theme-mode', 'system');
        store('beanpool-theme', 'light');
        bootTheme();
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('system');
        expect(localStorage.getItem('beanpool-theme')).toBe('light');
        expect(localStorage.getItem('beanpool-theme-default-light-v1')).toBeNull();
    });
});

describe('index.html', () => {
    it('ships dark, and runs theme-boot.js in <head> after the theme-color it sets', () => {
        expect(INDEX).toMatch(/<html lang="en" class="dark dark-theme" style="color-scheme: dark">/);
        const head = INDEX.slice(0, INDEX.indexOf('</head>'));
        const meta = head.indexOf('<meta name="theme-color" content="#1d231d"');
        const script = head.indexOf('<script src="/theme-boot.js"></script>');
        expect(meta).toBeGreaterThan(-1);
        expect(script).toBeGreaterThan(meta);
    });
});
