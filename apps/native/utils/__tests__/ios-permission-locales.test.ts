/**
 * The iOS permission pop-ups in every language the build declares (plugins/ios-permission-locales.js, constants/
 * ios-permission-words.ts, app.config.js): one entry per declared language, the catalog's sentence where the language has
 * one and the English until it does, and the English the one app.json holds.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { LANGS } from '@beanpool/core';
import { IOS_PERMISSION_WORDS } from '../../constants/ios-permission-words';

const nodeRequire = createRequire(import.meta.url);
const { iosPermissionLocales, stringsValue, IOS_PERMISSION_KEYS } = nodeRequire('../../plugins/ios-permission-locales.js');
const { APP_LANGUAGES } = nodeRequire('../../plugins/withAppLanguages.js');
const appConfig = nodeRequire('../../app.config.js');

const APP_JSON = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../app.json'), 'utf8')).expo;
const INFO_PLIST = APP_JSON.ios.infoPlist as Record<string, string>;
const WORDS_DIR = path.resolve(__dirname, '../../words');

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
/** A folder of catalogs, as { <lang>: <file's text> }. */
function catalogsIn(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-locales-'));
    temps.push(dir);
    for (const [lang, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${lang}.json`), text);
    return dir;
}

describe('the iOS permission texts, one entry per declared language', () => {
    it('names the four Info.plist keys, and app.json holds each one in English', () => {
        expect([...IOS_PERMISSION_KEYS].sort()).toEqual(['NSCameraUsageDescription', 'NSContactsUsageDescription', 'NSFaceIDUsageDescription', 'NSLocationWhenInUseUsageDescription']);
        for (const key of IOS_PERMISSION_KEYS) expect(typeof INFO_PLIST[key], key).toBe('string');
    });

    it('has an entry for every language the build declares, with every text', () => {
        expect([...APP_LANGUAGES]).toEqual([...LANGS]);
        const locales = iosPermissionLocales(INFO_PLIST, WORDS_DIR);
        expect(Object.keys(locales)).toEqual([...APP_LANGUAGES]);
        for (const lang of APP_LANGUAGES) {
            expect(Object.keys(locales[lang].ios).sort(), lang).toEqual([...IOS_PERMISSION_KEYS].sort());
            for (const key of IOS_PERMISSION_KEYS) expect(locales[lang].ios[key].length, `${lang} ${key}`).toBeGreaterThan(20);
        }
    });

    it('is English, as app.json has it, for English and for every language with no translation yet', () => {
        const locales = iosPermissionLocales(INFO_PLIST, catalogsIn({}));
        for (const lang of APP_LANGUAGES) {
            for (const key of IOS_PERMISSION_KEYS) expect(locales[lang].ios[key], `${lang} ${key}`).toBe(stringsValue(INFO_PLIST[key]));
        }
        // English needs no catalog, and a stray file for it is never read.
        const english = iosPermissionLocales(INFO_PLIST, catalogsIn({ en: JSON.stringify({ [INFO_PLIST.NSCameraUsageDescription]: 'not this' }) }));
        expect(english.en.ios.NSCameraUsageDescription).toBe(INFO_PLIST.NSCameraUsageDescription);
    });

    it('uses the catalog\'s sentence where the language has one, the English for the others, and the English for a bad file', () => {
        const dir = catalogsIn({
            es: JSON.stringify({ _meta: { language: 'es' }, [INFO_PLIST.NSCameraUsageDescription]: 'BeanPool usa tu cámara para escanear códigos QR.' }),
            fr: JSON.stringify({ [INFO_PLIST.NSCameraUsageDescription]: '   ' }),
            de: '{ not json',
            ru: JSON.stringify(['an', 'array']),
        });
        const locales = iosPermissionLocales(INFO_PLIST, dir);
        expect(locales.es.ios.NSCameraUsageDescription).toBe('BeanPool usa tu cámara para escanear códigos QR.');
        // The other two texts are not in es yet: English, whole.
        expect(locales.es.ios.NSFaceIDUsageDescription).toBe(INFO_PLIST.NSFaceIDUsageDescription);
        for (const lang of ['fr', 'de', 'ru', 'ja']) expect(locales[lang].ios.NSCameraUsageDescription, lang).toBe(INFO_PLIST.NSCameraUsageDescription);
    });

    it('writes a translation as a .strings value: a quote, a backslash or a line break cannot end the string early', () => {
        expect(stringsValue('Say "hi" \\ now\nthen')).toBe('Say \\"hi\\" \\\\ now\\nthen');
        const dir = catalogsIn({ it: JSON.stringify({ [INFO_PLIST.NSCameraUsageDescription]: 'Usa la «fotocamera» e "scansiona"' }) });
        expect(iosPermissionLocales(INFO_PLIST, dir).it.ios.NSCameraUsageDescription).toBe('Usa la «fotocamera» e \\"scansiona\\"');
    });

    it('the contacts question (private contacts C3) is drafted in every language, never in English, never "encrypted"', () => {
        const locales = iosPermissionLocales(INFO_PLIST, WORDS_DIR);
        for (const lang of APP_LANGUAGES.filter((l: string) => l !== 'en')) {
            const said: string = locales[lang].ios.NSContactsUsageDescription;
            // Mutation: leave a language's catalog without it → the English shows there.
            expect(said, lang).not.toBe(stringsValue(INFO_PLIST.NSContactsUsageDescription));
            expect(said, lang).toContain('BeanPool');
            expect(said.toLowerCase(), lang).not.toMatch(/encrypt|resilien|surviv/);
        }
    });

    it('keeps app.json\'s own file for each language (the Local Network question) beside the catalog\'s texts', () => {
        const built = appConfig({ config: APP_JSON });
        const fileOf = (lang: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../..', APP_JSON.locales[lang]), 'utf8')).ios;
        for (const lang of APP_LANGUAGES) {
            // Mutation: spread only the catalog's texts over app.json's locales (as before C3) → the file's sentence is gone.
            expect(built.locales[lang].ios.NSLocalNetworkUsageDescription, lang).toBe(stringsValue(fileOf(lang).NSLocalNetworkUsageDescription));
            for (const key of IOS_PERMISSION_KEYS) expect(typeof built.locales[lang].ios[key], `${lang} ${key}`).toBe('string');
        }
        // A file's text is written as a .strings value, as the catalog's are.
        const dir = catalogsIn({ 'x.json': JSON.stringify({ ios: { NSLocalNetworkUsageDescription: 'Say "hi"' } }) });
        const own = iosPermissionLocales(INFO_PLIST, catalogsIn({}), { fr: 'x.json.json' }, dir);
        expect(own.fr.ios.NSLocalNetworkUsageDescription).toBe('Say \\"hi\\"');
        // A file that is missing or broken adds nothing, and never fails the build.
        expect(Object.keys(iosPermissionLocales(INFO_PLIST, catalogsIn({}), { fr: './nowhere.json' }).fr.ios).sort()).toEqual([...IOS_PERMISSION_KEYS].sort());
    });

    it('marks the same English sentences app.json has, word for word, so the translation pass sees them', () => {
        expect(Object.keys(IOS_PERMISSION_WORDS).sort()).toEqual([...IOS_PERMISSION_KEYS].sort());
        for (const key of IOS_PERMISSION_KEYS) expect(IOS_PERMISSION_WORDS[key as keyof typeof IOS_PERMISSION_WORDS], key).toBe(INFO_PLIST[key]);
    });

    it('is in the app\'s config as Expo\'s `locales`, beside whatever else it holds, with the English untouched', () => {
        const built = appConfig({ config: { ...APP_JSON, locales: { 'x-other': './other.json' } } });
        expect(Object.keys(built.locales).sort()).toEqual(['x-other', ...APP_LANGUAGES].sort());
        expect(built.locales['x-other']).toBe('./other.json');
        for (const key of IOS_PERMISSION_KEYS) {
            expect(built.locales.en.ios[key]).toBe(INFO_PLIST[key]);
            // The Info.plist's own value (what a phone in a language with no lproj shows) is app.json's, unchanged.
            expect(built.ios.infoPlist[key]).toBe(INFO_PLIST[key]);
        }
        // Android's strings are not touched: every text sits under `ios`.
        for (const lang of APP_LANGUAGES) expect(Object.keys(built.locales[lang]), lang).toEqual(['ios']);
    });
});
