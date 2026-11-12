/**
 * public/theme-boot.js draws the look before the first paint; useTheme.ts takes over once the app mounts. If the two
 * disagree, the page flips on load (a Classic page before a chosen Light or Dark, or the reverse). This runs the real file
 * for every stored state the keys can hold, with the device light and dark, and asks it, useTheme and core's resolveLook
 * (the one rule, look.ts: theme-boot.js carries a copy of it) for the same answer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brandGrounds } from '@beanpool/core/brand-colours';
import { brandScheme, resolveLook } from '@beanpool/core';
import { loadThemePreference, resolveSet, resolveTheme } from './useTheme';

const BOOT = fs.readFileSync(path.resolve(__dirname, '../../public/theme-boot.js'), 'utf8');
const INDEX = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');

const MODE = [null, 'light', 'dark', 'night', 'system', 'dusk', 'junk'] as const;

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

function bootTheme(): { theme: string; scheme: string; color: string | null | undefined; classes: string; look: string | null } {
    new Function(BOOT)();
    const root = document.documentElement;
    return {
        theme: root.classList.contains('dark-theme') ? 'dark' : 'light',
        scheme: root.style.colorScheme,
        color: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
        classes: [...root.classList].sort().join(' '),
        look: root.getAttribute('data-bp-theme'),
    };
}

/** The browser bar in each set: the banner's ground, as the library has it. */
const BAR = { light: '#fbfaf8', dark: '#1d231d', night: '#202126' } as const;

describe('theme-boot.js agrees with useTheme for every stored state', () => {
    const realMatchMedia = window.matchMedia;
    beforeEach(() => {
        localStorage.clear();
        // As index.html ships it: dark, before the script runs.
        document.documentElement.className = 'dark dark-theme';
        document.documentElement.removeAttribute('data-bp-theme');
        document.documentElement.style.colorScheme = 'dark';
        document.head.innerHTML = '<meta name="theme-color" content="#1d231d">';
    });
    afterEach(() => { window.matchMedia = realMatchMedia; });

    const cases = MODE.flatMap((mode) => [false, true].map((deviceDark) => [mode, deviceDark] as const));

    it.each(cases)('mode=%s device dark=%s', (mode, deviceDark) => {
        store('beanpool-theme-mode', mode);
        setDevice(deviceDark);

        const boot = bootTheme();
        const expected = resolveTheme(loadThemePreference(), deviceDark);
        const set = resolveSet(loadThemePreference(), deviceDark);

        // The three agree: the hook, core's one rule on the raw stored value, and the boot script's copy of it.
        expect(set).toBe(resolveLook(mode, deviceDark));
        expect(expected).toBe(brandScheme(set));
        expect(boot.theme).toBe(expected);
        expect(boot.scheme).toBe(expected);
        // The browser bar is the banner's ground, as the library has it (theme-boot.js cannot import it, so this holds the copy).
        expect(boot.color).toBe(brandGrounds(set).web.banner);
        expect(boot.color).toBe(BAR[set]);
        expect(boot.classes).toBe(expected === 'dark' ? 'dark dark-theme' : 'light-theme');
        // Dark carries its attribute on top of .dark-theme; Classic and Light carry none.
        expect(boot.look).toBe(set === 'night' ? 'night' : null);
    });

    it('nothing stored, or a value this build does not know, is Classic whatever the device says', () => {
        for (const mode of [null, 'dusk', 'ember', 'junk', 'Dark']) {
            for (const deviceDark of [false, true]) {
                localStorage.clear();
                store('beanpool-theme-mode', mode);
                setDevice(deviceDark);
                const boot = bootTheme();
                expect(boot.classes).toBe('dark dark-theme');
                expect(boot.look).toBeNull();
                expect(boot.color).toBe('#1d231d');
            }
        }
    });

    it('Dark takes the attribute and a stored Light or Classic takes it away again', () => {
        store('beanpool-theme-mode', 'night');
        setDevice(false);
        expect(bootTheme().look).toBe('night');
        localStorage.clear();
        store('beanpool-theme-mode', 'light');
        expect(bootTheme().look).toBeNull();
        expect(document.documentElement.getAttribute('data-bp-theme')).toBeNull();
    });

    it('draws Dark when storage is blocked, as useTheme does', () => {
        const desc = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
        Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
        try {
            expect(bootTheme().theme).toBe('dark');
            expect(bootTheme().look).toBeNull();
            expect(loadThemePreference()).toBe('dark');
        } finally {
            Object.defineProperty(window, 'localStorage', desc);
        }
    });

    it('only reads storage: the first paint never writes a theme', () => {
        store('beanpool-theme-mode', 'system');
        bootTheme();
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('system');
        expect(localStorage.length).toBe(1);
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
