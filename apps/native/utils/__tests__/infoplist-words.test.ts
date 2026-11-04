/**
 * Lights-out H2: iOS asks for Local Network the first time the app reaches the hall laptop's number (Apple TN3179), and
 * an app with no NSLocalNetworkUsageDescription gets a generic question or none. app.json carries the English, and Expo's
 * `locales` one file per language (apps/native/infoplist-words), so the question comes in the member's language.
 *
 * Each file nests the key under "ios": Expo gives a flat file's keys to Android too, as res/values-b+<lang>/strings.xml,
 * and a string found only in language folders is lint's ExtraTranslation, fatal in a release build (#2820 review).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { LANGS } from '@beanpool/core';

const NATIVE = path.resolve(__dirname, '../..');
const app = JSON.parse(fs.readFileSync(path.join(NATIVE, 'app.json'), 'utf8')).expo;

/** Expo's own reader of `locales` (the config-plugins the SDK ships, as prebuild runs it). */
type ResolveLocales = (root: string, locales: Record<string, string>, platform: 'android' | 'ios') =>
    Promise<{ localesMap: Record<string, Record<string, string>> }>;
function expoLocales(): ResolveLocales {
    const fromNative = createRequire(path.join(NATIVE, 'package.json'));
    const fromExpo = createRequire(fromNative.resolve('expo/config-plugins'));
    return fromExpo('@expo/config-plugins/build/utils/locales').getResolvedLocalesAsync;
}

describe('the Local Network question, in every language', () => {
    it('app.json carries the English sentence', () => {
        expect(app.ios.infoPlist.NSLocalNetworkUsageDescription).toBe(
            "BeanPool uses this to reach your community's laptop on the hall Wi-Fi when the internet is down.",
        );
        // Local networking stays allowed in plain http (the hall laptop's number).
        expect(app.ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking).toBe(true);
    });

    it('every language the app speaks has its file, with the sentence for iOS, and nothing else', () => {
        expect(Object.keys(app.locales).sort()).toEqual([...LANGS].sort());
        for (const lang of LANGS) {
            const file = path.join(NATIVE, app.locales[lang]);
            const words = JSON.parse(fs.readFileSync(file, 'utf8'));
            expect(Object.keys(words), lang).toEqual(['ios']);
            expect(Object.keys(words.ios), lang).toEqual(['NSLocalNetworkUsageDescription']);
            const s: string = words.ios.NSLocalNetworkUsageDescription;
            expect(s.length, lang).toBeGreaterThan(20);
            expect(s, lang).toContain('BeanPool');
            expect(s.toLowerCase(), lang).not.toMatch(/resilien|surviv/);
        }
    });

    it('Expo gives the sentence to iOS in every language, and nothing to Android', async () => {
        const resolve = expoLocales();
        const ios = (await resolve(NATIVE, app.locales, 'ios')).localesMap;
        const android = (await resolve(NATIVE, app.locales, 'android')).localesMap;
        for (const lang of LANGS) {
            expect(Object.keys(ios[lang] ?? {}), lang).toEqual(['NSLocalNetworkUsageDescription']);
            // Android writes res/values-b+<lang>/strings.xml from this: empty, so no string exists only in a language folder.
            expect(android[lang] ?? {}, lang).toEqual({});
        }
    });
});
