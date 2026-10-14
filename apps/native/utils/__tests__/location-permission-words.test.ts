/**
 * What the phone says when BeanPool asks for location, and that it only ever asks while the app is in use.
 *
 * The words used to say BeanPool "relies exclusively on your device's GPS to plot your independent identity on the
 * community map". None of that was true: a member places their own pin, the privacy draft says BeanPool doesn't track
 * location, and since #1917 a town can be typed instead. What the code does with location (utils and screens that call
 * expo-location): centres the map when the member taps the button, finds communities near them, and shows how far away
 * listings and events are.
 *
 * iOS shows NSLocationWhenInUseUsageDescription. The expo-location plugin writes its locationWhenInUsePermission over
 * that key at build time, so both copies in app.json must say the same thing. Android has no such string: the system
 * asks in its own words, and the app's own location alerts are in the source sweep below.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const NATIVE = path.resolve(__dirname, '..', '..');
const expo = JSON.parse(fs.readFileSync(path.join(NATIVE, 'app.json'), 'utf8')).expo;
const plist = expo.ios.infoPlist;
const locationPlugin = (expo.plugins as unknown[]).find(p => Array.isArray(p) && p[0] === 'expo-location') as [string, Record<string, unknown>];

/** Claims the words must never make: tracking, GPS-only, location as an identity, or use outside the app. */
const FALSE_CLAIMS = /track|exclusive|GPS|identity|always|background/i;

describe('the location permission words', () => {
    const ios: string = plist.NSLocationWhenInUseUsageDescription;

    it('iOS and the expo-location plugin carry the same words (the plugin writes over the iOS key)', () => {
        expect(typeof ios).toBe('string');
        expect(locationPlugin?.[1].locationWhenInUsePermission).toBe(ios);
    });

    it('say what location is for, while the app is in use, and that a town can be typed instead', () => {
        expect(ios).toMatch(/while you use the app/i);
        expect(ios).toMatch(/near you/i);
        expect(ios).toMatch(/type your town/i);
    });

    it('make no claim of tracking, GPS-only, or plotting an identity', () => {
        expect(ios).not.toMatch(FALSE_CLAIMS);
    });

    it('the app never asks for location in the background, on either phone', () => {
        expect(locationPlugin?.[1].isIosBackgroundLocationEnabled).toBe(false);
        expect(plist.NSLocationAlwaysUsageDescription).toBeUndefined();
        expect(plist.NSLocationAlwaysAndWhenInUseUsageDescription).toBeUndefined();
        expect(plist.UIBackgroundModes).not.toContain('location');
        expect(expo.android.permissions).not.toContain('android.permission.ACCESS_BACKGROUND_LOCATION');
    });
});

describe('no screen claims BeanPool tracks the member or plots their identity from GPS', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
        }
    };
    ['app', 'components', 'utils'].forEach(d => walk(path.join(NATIVE, d)));

    it('the sweep found the screens', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it.each([
        /plot[s]? your (independent )?identity/i,
        /track(s|ing)? your (location|position|whereabouts)/i,
        /relies exclusively on your device/i,
    ])('no source says %s', claim => {
        const hits = files.filter(f => claim.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(NATIVE, f));
        expect(hits).toEqual([]);
    });
});
