// @vitest-environment jsdom
/**
 * The phone's top bar, one banner per colour set (colour themes, slice T5, round 2; Marty, 12 Nov 2026: "no green in Dark").
 *
 * components/GlobalHeader.tsx drew the neon-vines banner behind the bean, the help, the invite and the Settings icons in every
 * look, so Dark's top bar was green while its wallpaper was charcoal. It now takes its picture from utils/header-banner.ts by
 * the colour set, the way components/PatternBackground.tsx takes its tile: Classic and Light draw the neon banner they
 * always have, Dark (stored `night`, always dark) its charcoal one, baked from the same art by scripts/bake-dark-doodle.mjs.
 *
 * Here the real header is drawn for each choice the Appearance list stores, on a light-mode and a dark-mode device, through
 * the real resolveSet (utils/theme-preference.ts, core's resolveLook), and the picture behind the icons is read off it. The
 * files are held too: the phone's Classic banner is still the bytes it was on main, Dark's is the web's Dark banner, and a
 * source check fails if the header goes back to naming the neon file itself. The banner's colour (charcoal, no green, its gaps
 * the library's web.banner under the 50 % wash) is held by scripts/dark-doodle.test.mjs on the same bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import React, { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;
// A bundled picture loads as its file's name, so a render can say which file it drew.
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    const path = (process as any).getBuiltinModule('node:path');
    const asName = (m: { exports: unknown }, filename: string) => { m.exports = `asset:${path.basename(filename)}`; };
    Loader._extensions['.jpg'] = asName;
    Loader._extensions['.png'] = asName;
    Loader._extensions['.webp'] = asName;
});

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
vi.mock('react-native', async () => {
    const native = (await import('./profile-events-words-harness')).nativeMock(alerts);
    // The harness draws an Image as a bare <img>; this one also says which picture it was given and whether it hides from a screen reader.
    const Image = (p: Record<string, any>) => createElement('img', { 'data-src': String(p.source), 'data-hidden': p.accessibilityElementsHidden ? 'true' : undefined });
    return { ...native, Image, DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: () => {} } };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-router', () => ({
    router: { push: () => {}, replace: () => {}, back: () => {}, canGoBack: () => true },
    usePathname: () => '/',
    useFocusEffect: (effect: () => void | (() => void)) => { useEffect(() => effect() ?? undefined, [effect]); },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.83' } } }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)), randomUUID: () => 'uuid' };
});
vi.mock('expo-image', () => ({ Image: (p: Record<string, any>) => createElement('img', { src: String(p.source?.uri ?? p.source) }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32), callsign: 'Ben' } }) }));
const state = vi.hoisted(() => ({ set: 'dark' as string }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ colors: lightColors, theme: state.set === 'light' ? 'light' : 'dark', set: state.set }),
        useStyles: (make: (t: unknown) => unknown) => make({ colors: lightColors, theme: 'light' }),
    };
});
vi.mock('../db', () => ({ getMemberProfile: vi.fn(async () => null) }));
vi.mock('../../components/NeedsYouIcons', () => ({ NeedsYouIcons: () => null }));
vi.mock('../../services/pillar-sync', () => ({ getLastSyncTime: async () => Date.now() }));

import { BRAND_SETS } from '@beanpool/core';
import { GlobalHeader } from '../../components/GlobalHeader';
import { headerBanner } from '../header-banner';
import { resolveSet } from '../theme-preference';

const NATIVE = path.join(__dirname, '..', '..');
const IMAGES = path.join(NATIVE, 'assets', 'images');
const WEB_ASSETS = path.join(NATIVE, '..', 'pwa', 'public', 'assets');
const md5 = (file: string) => createHash('md5').update(fs.readFileSync(file)).digest('hex');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    globalThis.fetch = vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** The picture behind the icons: the header's one image that hides from a screen reader (the bean is the other image, and it is announced). */
async function bannerDrawn(set: string): Promise<string | null> {
    state.set = set;
    await act(async () => { root.render(createElement(GlobalHeader) as any); });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const hidden = Array.from(host.querySelectorAll('img[data-hidden="true"]'));
    expect(hidden.length, 'exactly one hidden picture, the banner').toBe(1);
    return hidden[0].getAttribute('data-src');
}

describe('the header draws the banner of the colour set the Appearance list stored', () => {
    // [stored choice, device is dark, banner drawn]
    const CASES: Array<[string | null, boolean, string]> = [
        ['dark', false, 'asset:neon-vines-banner.jpg'],       // Classic, on a light-mode device
        ['dark', true, 'asset:neon-vines-banner.jpg'],        // Classic, on a dark-mode device
        ['light', false, 'asset:neon-vines-banner.jpg'],      // Light keeps today's banner
        ['light', true, 'asset:neon-vines-banner.jpg'],
        ['night', false, 'asset:vines-banner-night.jpg'],     // Dark ignores the phone: charcoal on a light-mode device
        ['night', true, 'asset:vines-banner-night.jpg'],      // and on a dark-mode one
        ['system', false, 'asset:neon-vines-banner.jpg'],     // Same as phone: Light on a light phone
        ['system', true, 'asset:neon-vines-banner.jpg'],      // and Classic on a dark one (never Dark)
        [null, true, 'asset:neon-vines-banner.jpg'],          // nothing stored: Classic
        ['dusk', false, 'asset:neon-vines-banner.jpg'],       // a value this build does not know: Classic
    ];
    for (const [stored, deviceDark, want] of CASES) {
        it(`${JSON.stringify(stored)} on a ${deviceDark ? 'dark' : 'light'}-mode device draws ${want.replace('asset:', '')}`, async () => {
            const set = resolveSet(stored as never, deviceDark ? 'dark' : 'light');
            expect(await bannerDrawn(set)).toBe(want);
        });
    }

    it('Dark and Classic are both dark by scheme, and still draw different banners: the banner follows the set, not the scheme', () => {
        expect(headerBanner('night')).toBe('asset:vines-banner-night.jpg');
        expect(headerBanner('dark')).toBe('asset:neon-vines-banner.jpg');
        expect(headerBanner('night')).not.toBe(headerBanner('dark'));
    });

    it('every colour set has a banner (a new set cannot ship without one), and only Dark\'s is not the neon one', () => {
        // The bundled picture is a number in the app and its file's name here (see the loader above): compare as text.
        const drawn = (set: (typeof BRAND_SETS)[number]) => String(headerBanner(set));
        expect(BRAND_SETS.every((set) => /^asset:.*\.jpg$/.test(drawn(set)))).toBe(true);
        expect(BRAND_SETS.filter((set) => drawn(set) !== 'asset:neon-vines-banner.jpg')).toEqual(['night']);
    });

    it('a set this build does not know draws Classic\'s banner, as resolveSet gives Classic for a look it does not know', () => {
        expect(headerBanner(undefined)).toBe('asset:neon-vines-banner.jpg');
        expect(headerBanner('dusk' as never)).toBe('asset:neon-vines-banner.jpg');
    });
});

describe('the banner files', () => {
    it('Classic\'s and Light\'s banner is the file main has, byte for byte (nothing was re-saved)', () => {
        // md5 of apps/native/assets/images/neon-vines-banner.jpg on main (and of the web's neon-vines-banner.png, the same bytes).
        expect(md5(path.join(IMAGES, 'neon-vines-banner.jpg'))).toBe('61dff4e10f779984b16b0b74609ce4cc');
    });

    it('the phone\'s Classic banner is the web\'s, so the one baked Dark banner stands in for both', () => {
        const phone = fs.readFileSync(path.join(IMAGES, 'neon-vines-banner.jpg'));
        const web = fs.readFileSync(path.join(WEB_ASSETS, 'neon-vines-banner.png'));
        expect(phone.equals(web)).toBe(true);
    });

    it('Dark\'s phone banner is the web\'s Dark banner, byte for byte, a 640 x 640 JPEG no bigger than Classic\'s', () => {
        const phone = fs.readFileSync(path.join(IMAGES, 'vines-banner-night.jpg'));
        const web = fs.readFileSync(path.join(WEB_ASSETS, 'vines-banner-night.jpg'));
        expect(phone.equals(web)).toBe(true);
        expect(phone.subarray(0, 3).toString('hex')).toBe('ffd8ff'); // a JPEG
        // The size is in the frame header (SOF0/SOF2): marker, length, precision, height, width.
        let i = 2, size: [number, number] | null = null;
        while (i < phone.length && !size) {
            const marker = phone[i + 1];
            if (marker === 0xc0 || marker === 0xc2) size = [phone.readUInt16BE(i + 5), phone.readUInt16BE(i + 7)];
            else i += 2 + phone.readUInt16BE(i + 2);
        }
        expect(size).toEqual([640, 640]);
        expect(phone.length).toBeLessThanOrEqual(fs.statSync(path.join(IMAGES, 'neon-vines-banner.jpg')).size);
    });
});

describe('the header does not name the neon file itself', () => {
    it('GlobalHeader.tsx takes its banner from headerBanner(set) (the line that gave every look the green one)', () => {
        const src = fs.readFileSync(path.join(NATIVE, 'components', 'GlobalHeader.tsx'), 'utf8');
        expect(src).not.toMatch(/neon-vines-banner/);
        expect(src).toMatch(/source=\{headerBanner\(set\)\}/);
        expect(src).toMatch(/const \{ colors, set \} = useTheme\(\)/);
    });

    it('utils/header-banner.ts is keyed by the colour set, so a new set is a type error until it has a banner', () => {
        const src = fs.readFileSync(path.join(NATIVE, 'utils', 'header-banner.ts'), 'utf8');
        expect(src).toMatch(/Record<BrandSet,/);
        expect(src).not.toMatch(/theme === 'dark'/);
    });
});
