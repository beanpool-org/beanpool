/**
 * Which language the phone writes in (utils/language-choice.ts; translation design §1, slice S1), what it tells a node,
 * which languages the build declares (plugins/withAppLanguages.js; director amendment 1), and that every language has
 * its catalogs and the loader reaches every catalog on disk (utils/words-catalogs.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }));
vi.mock('../nodes', () => ({ recordRequestSigning: vi.fn() }));
vi.mock('../request-signing-version', () => ({ trackInfoRead: vi.fn() }));

import { LANGS, setLanguage } from '@beanpool/core';
import { LANGUAGE_NAMES, LANGUAGE_OPTIONS, chooseLanguage, defaultLanguage, languageForNode, languageHeader, storedChoice } from '../language-choice';
import { readNodeProfile } from '../node-profile';

const nodeRequire = createRequire(import.meta.url);
const plugin = nodeRequire('../../plugins/withAppLanguages.js');
const NATIVE_WORDS = path.resolve(__dirname, '../../words');
const CORE_WORDS = path.resolve(__dirname, '../../../../packages/beanpool-core/words');

afterEach(() => setLanguage('en'));

describe('the language a phone writes in', () => {
    it("the member's choice, else the phone's language when BeanPool has it, else the community's, else English", () => {
        expect(chooseLanguage({ stored: 'fr', deviceTags: ['ru-RU'], nodeDefault: 'es' })).toBe('fr');
        expect(chooseLanguage({ stored: null, deviceTags: ['ru-RU'], nodeDefault: 'es' })).toBe('ru');
        expect(chooseLanguage({ deviceTags: ['zh-TW'] })).toBe('zh-Hant');
        expect(chooseLanguage({ deviceTags: ['zh_CN_#Hans'] })).toBe('zh-Hans');
        expect(chooseLanguage({ deviceTags: ['in-ID'] })).toBe('id');
        expect(chooseLanguage({ deviceTags: ['tl-PH'] })).toBe('fil');
        expect(chooseLanguage({ deviceTags: ['pt-PT'] })).toBe('pt');
        // The phone's first language BeanPool has, in the phone's order.
        expect(chooseLanguage({ deviceTags: ['he-IL', 'de-AT', 'fr-FR'] })).toBe('de');
        // A phone in a language BeanPool doesn't have: the community's default, else English.
        expect(chooseLanguage({ deviceTags: ['he-IL'], nodeDefault: 'fr' })).toBe('fr');
        expect(chooseLanguage({ deviceTags: ['he-IL'], nodeDefault: 'he' })).toBe('en');
        expect(chooseLanguage({})).toBe('en');
    });

    it('a stored value that is not one of the 25 is no choice, never a broken screen', () => {
        for (const stale of ['klingon', '', 'xx', 'ru-RU', 'zh', null, undefined]) {
            expect(storedChoice(stale as any)).toBeNull();
            expect(chooseLanguage({ stored: stale as any, deviceTags: ['es-MX'] })).toBe('es');
        }
        expect(defaultLanguage({ deviceTags: [null, undefined, 'garbage!!'] })).toBe('en');
    });

    it('what a node hears: the language exactly as LANGS spells it, never the pseudo-locale', () => {
        expect(languageHeader()).toEqual({ 'X-Language': 'en' });
        setLanguage('ru');
        expect(languageHeader()).toEqual({ 'X-Language': 'ru' });
        expect(languageForNode()).toBe('ru');
        setLanguage('zh-Hant');
        expect(languageHeader()).toEqual({ 'X-Language': 'zh-Hant' });
        setLanguage('xx');
        expect(languageForNode()).toBe('en');
    });

    it("a community's default language is read from its info only when it is one of the 25", () => {
        expect(readNodeProfile({ profile: 'local', language: 'fr' })?.language).toBe('fr');
        expect(readNodeProfile({ profile: 'local', language: 'pt-BR' })?.language).toBe('pt');
        expect(readNodeProfile({ profile: 'local', language: 'he' })).not.toHaveProperty('language');
        expect(readNodeProfile({ profile: 'local', language: 7 })).not.toHaveProperty('language');
        expect(readNodeProfile({ profile: 'local' })).not.toHaveProperty('language');
    });
});

describe('the languages the build declares and carries', () => {
    it('the picker lists every language once, in its own name, in LANGS order', () => {
        expect(LANGUAGE_OPTIONS.map((o) => o.value)).toEqual([...LANGS]);
        expect(new Set(Object.values(LANGUAGE_NAMES)).size).toBe(LANGS.length);
    });

    it('the Expo config plugin declares exactly LANGS (iOS CFBundleLocalizations, Android locales_config)', () => {
        expect(plugin.APP_LANGUAGES).toEqual([...LANGS]);
        const xml: string = plugin.localesConfigXml(plugin.APP_LANGUAGES);
        for (const tag of LANGS) expect(xml).toContain(`<locale android:name="${tag}"/>`);
        expect((xml.match(/<locale /g) ?? []).length).toBe(LANGS.length);
        const app = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../app.json'), 'utf8'));
        expect(app.expo.plugins).toContain('./plugins/withAppLanguages');
    });

    it('right to left stays off: the manifest says supportsRtl="false" from the first launch, and the app turns RTL off at boot', () => {
        // The plugin's manifest change, run on a plain manifest as Expo hands it over (review of #1954, N4).
        const manifest: { manifest: { application: { $: Record<string, string> }[] } } = { manifest: { application: [{ $: { 'android:name': '.MainApplication', 'android:supportsRtl': 'true' } }] } };
        plugin.applyAppLanguagesManifest(manifest.manifest);
        expect(manifest.manifest.application[0].$['android:supportsRtl']).toBe('false');
        expect(manifest.manifest.application[0].$['android:localeConfig']).toBe('@xml/locales_config');
        expect(manifest.manifest.application[0].$['android:name']).toBe('.MainApplication');
        // …and the plugin's Android mod is that function.
        const pluginSource = fs.readFileSync(path.resolve(__dirname, '../../plugins/withAppLanguages.js'), 'utf8');
        expect(pluginSource).toMatch(/withAndroidManifest\(config, \(config\) => \{\s*applyAppLanguagesManifest\(config\.modResults\.manifest\);/);
        // I18nManager, at module load in the root layout, before anything renders: allowRTL(false) and forceRTL(false).
        const layout = fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf8');
        expect(layout).toMatch(/^try \{ I18nManager\.allowRTL\(false\); I18nManager\.forceRTL\(false\); \}/m);
        expect(layout).toMatch(/import \{[^}]*\bI18nManager\b[^}]*\} from 'react-native';/);
    });

    it('every other language has a phone catalog and a core catalog, marked a machine draft, and the loader requires each', () => {
        const loader = fs.readFileSync(path.resolve(__dirname, '../words-catalogs.ts'), 'utf8');
        for (const lang of LANGS.filter((l) => l !== 'en')) {
            for (const [dir, spec] of [[NATIVE_WORDS, `'../words/${lang}.json'`], [CORE_WORDS, `'@beanpool/core/words/${lang}.json'`]] as const) {
                const file = path.join(dir, `${lang}.json`);
                expect(fs.existsSync(file), file).toBe(true);
                const meta = JSON.parse(fs.readFileSync(file, 'utf8'))._meta;
                expect(meta.language).toBe(lang);
                expect(meta.review).toBe('machine');
                expect(typeof meta.glossary?.Beans, `${lang}: Beans is translated (Marty's call M2)`).toBe('string');
                expect(loader).toContain(`require(${spec})`);
            }
        }
        // Nothing on disk the loader can't reach.
        for (const dir of [NATIVE_WORDS, CORE_WORDS]) {
            for (const f of fs.readdirSync(dir).filter((n) => /^[A-Za-z-]+\.json$/.test(n))) expect(LANGS as readonly string[]).toContain(f.slice(0, -5));
        }
    });
});
