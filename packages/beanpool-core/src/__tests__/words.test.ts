/**
 * The words layer (words.ts, words-check.ts): scratch/global-node/DESIGN-translation-fable.md §7 slice S0.
 *
 * Plural rules and the ru/fr/pt/es month and day names are checked against Node's own ICU (Intl), which the tests may
 * use and the phone may not; English is checked against what the apps print today, word for word.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    DATE_WORDS, LANGS, LANGUAGE_HEADER, PSEUDO_LANG, currentLanguage, formatDate, formatNumber, normaliseLang, pluralCategory,
    pluralKey, pseudoLocalise, setLanguage, t, timeAgo, tn, wordKey, type Lang, type UiLang,
} from '../words.js';
import { callKey, callProblem, checkCatalog } from '../words-check.js';
import { BIP39_ENGLISH, normaliseRecoveryWords, packRecoveryWords, recoveryWordsMatchPublicKey } from '../recovery-words.js';
import { seedFromRecoveryWords } from '../recovery-words-seed.js';
import { recoveryKitHtml } from '../recovery-kit.js';

afterEach(() => setLanguage('en'));

const INTL_TAG: Record<Lang, string> = { en: 'en', ru: 'ru', fr: 'fr', pt: 'pt', es: 'es' };

describe('plural categories', () => {
    // The design's fail-first table: the five languages × {0, 1, 2, 5, 21}.
    const EXPECTED: Record<Lang, string[]> = {
        en: ['other', 'one', 'other', 'other', 'other'],
        ru: ['many', 'one', 'few', 'many', 'one'],
        fr: ['one', 'one', 'other', 'other', 'other'],
        pt: ['one', 'one', 'other', 'other', 'other'],
        es: ['other', 'one', 'other', 'other', 'other'],
    };
    for (const lang of LANGS) {
        it(`${lang}: 0, 1, 2, 5, 21`, () => {
            expect([0, 1, 2, 5, 21].map((n) => pluralCategory(lang, n))).toEqual(EXPECTED[lang]);
        });
    }

    it('agrees with Node ICU for 0–250, round millions and decimals, in all five', () => {
        const numbers = [...Array.from({ length: 251 }, (_, i) => i), 1000, 1_000_000, 2_000_000, 1_500_000, 0.5, 1.5, 2.5, 11.5, 21.1];
        for (const lang of LANGS) {
            const rules = new Intl.PluralRules(INTL_TAG[lang]);
            for (const n of numbers) expect([lang, n, pluralCategory(lang, n)]).toEqual([lang, n, rules.select(n)]);
        }
    });
});

describe('t and tn', () => {
    it('`en` returns the key itself (every test that pins English keeps working)', () => {
        expect(currentLanguage()).toBe('en');
        expect(t('List an Offer first')).toBe('List an Offer first');
        expect(t('Post', undefined, 'button: publish')).toBe('Post');
        expect(t('{name} added you', { name: 'Ana' })).toBe('Ana added you');
        expect(tn(1, '{n} new message', '{n} new messages')).toBe('1 new message');
        expect(tn(5, '{n} new message', '{n} new messages')).toBe('5 new messages');
        // en ignores any catalog it is handed.
        setLanguage('en', [{ 'List an Offer first': 'Wrong' }]);
        expect(t('List an Offer first')).toBe('List an Offer first');
    });

    it('a translation is used when present; the English when not; context keys apart', () => {
        setLanguage('fr', [
            { _meta: { model: 'test' }, 'Save': 'Enregistrer', '{name} added you': '{name} vous a ajouté' },
            { [wordKey('Post', 'button: publish')]: 'Publier', 'Post': 'Annonce' },
        ]);
        expect(currentLanguage()).toBe('fr');
        expect(t('Save')).toBe('Enregistrer');
        expect(t('Not in the catalog')).toBe('Not in the catalog');
        expect(t('{name} added you', { name: 'Ana' })).toBe('Ana vous a ajouté');
        expect(t('Post', undefined, 'button: publish')).toBe('Publier');
        expect(t('Post')).toBe('Annonce');
    });

    it('placeholders may move or repeat in a translation', () => {
        setLanguage('ru', [{ '{a} paid {b}': '{b} получил от {a} ({a})' }]);
        expect(t('{a} paid {b}', { a: 'Ana', b: 'Bo' })).toBe('Bo получил от Ana (Ana)');
    });

    it('ru plurals take one / few / many; a missing form falls back to other, a missing entry to English', () => {
        const key = pluralKey('{n} bean', '{n} beans');
        setLanguage('ru', [{ [key]: { one: '{n} боб', few: '{n} боба', many: '{n} бобов', other: '{n} боба' } }]);
        expect([1, 2, 5, 11, 21, 22, 25, 1.5].map((n) => tn(n, '{n} bean', '{n} beans'))).toEqual([
            '1 боб', '2 боба', '5 бобов', '11 бобов', '21 боб', '22 боба', '25 бобов', '1,5 боба',
        ]);
        setLanguage('ru', [{ [key]: { one: '{n} боб', other: '{n} боба' } }]);
        expect(tn(5, '{n} bean', '{n} beans')).toBe('5 боба');
        setLanguage('ru', []);
        expect(tn(5, '{n} bean', '{n} beans')).toBe('5 beans');
    });

    it('the pseudo-locale pads at least 35 %, accents, brackets, and keeps placeholders whole', () => {
        const out = pseudoLocalise('Save {name} now');
        expect(out.startsWith('[') && out.endsWith(']')).toBe(true);
        expect(out).toContain('{name}');
        expect(out.replace('{name}', '')).not.toMatch(/[A-Za-z]/);
        expect(out.length - 2).toBeGreaterThanOrEqual(Math.ceil('Save {name} now'.length * 1.35));
        setLanguage(PSEUDO_LANG);
        expect(t('Save')).toBe('[Ŝāṽé~~]');
        expect(t('Hello {name}', { name: 'Ana' })).toMatch(/^\[Ĥéļļö Ana~+\]$/);
        expect(tn(3, '{n} new message', '{n} new messages')).toMatch(/^\[3 ñéŵ ɱéššāĝéš~+\]$/);
    });

    it('normaliseLang maps device tags to the five, and nothing else', () => {
        expect(['ru-RU', 'pt-BR', 'pt_PT', 'ES', 'fr-CA', 'en-AU', 'de-DE', '', null].map(normaliseLang)).toEqual([
            'ru', 'pt', 'pt', 'es', 'fr', 'en', null, null, null,
        ]);
        expect(LANGUAGE_HEADER).toBe('X-Language');
    });
});

describe('words:check (structural only)', () => {
    it('placeholder parity: a dropped or invented placeholder is refused; moved and repeated are fine', () => {
        const sources = new Set(['{name} added you', 'Save', '{a} paid {b}']);
        expect(checkCatalog('fr', { '{name} added you': '{name} vous a ajouté', '{a} paid {b}': '{b} de {a}' }, sources)).toEqual([]);
        const bad = checkCatalog('fr', { '{name} added you': 'vous a ajouté', 'Save': 'Enregistrer {x}' }, sources);
        expect(bad.map((p) => p.key)).toEqual(['{name} added you', 'Save']);
        expect(bad[0].problem).toContain('dropped {name}');
        expect(bad[1].problem).toContain('unknown {x}');
    });

    it('a ru plural entry missing a form is refused; an empty one is an untranslated fallback', () => {
        const key = pluralKey('{n} bean', '{n} beans');
        const sources = new Set([key]);
        expect(checkCatalog('ru', { [key]: { one: '{n} боб', other: '{n} боба' } }, sources, sources).map((p) => p.problem)).toEqual([
            'ru needs the "few" form (one, few, many, other)',
            'ru needs the "many" form (one, few, many, other)',
        ]);
        expect(checkCatalog('ru', { [key]: {} }, sources, sources)).toEqual([]);
        expect(checkCatalog('fr', { [key]: { one: 'un haricot', other: '{n} haricots' } }, sources, sources)).toEqual([]);
        expect(checkCatalog('fr', { [key]: { one: '{n} haricot', other: 'haricots' } }, sources, sources)[0].problem).toContain('dropped {n}');
    });

    it('a key no source uses any more is refused; a missing translation never is', () => {
        expect(checkCatalog('es', { 'Old sentence': 'Frase vieja', 'Save': '' }, new Set(['Save']))).toEqual([
            { key: 'Old sentence', problem: 'no source uses this key any more (the English changed or the sentence was removed)' },
        ]);
    });

    it('a sentence fragment fails: a space at either end, a "+" join, or a non-literal argument', () => {
        const at = 'x.tsx:1';
        expect(callProblem({ fn: 't', text: 'You have ', concatenated: false, at })).toContain('fragment');
        expect(callProblem({ fn: 't', text: ' messages', concatenated: false, at })).toContain('fragment');
        expect(callProblem({ fn: 't', text: 'You have', concatenated: true, at })).toContain('fragment');
        expect(callProblem({ fn: 't', text: null, concatenated: false, at })).toContain('string literal');
        expect(callProblem({ fn: 'tn', text: '{n} bean', other: null, concatenated: false, at })).toContain('string literal');
        expect(callProblem({ fn: 't', text: 'You have {n} messages', concatenated: false, at })).toBeNull();
        expect(callKey({ fn: 't', text: 'Post', context: 'button', concatenated: false, at })).toBe('Post\u0004button');
        expect(callKey({ fn: 'tn', text: 'a', other: 'b', concatenated: false, at })).toBe('a|b');
    });
});

describe('dates and numbers from tables', () => {
    const sat = new Date(2026, 8, 26, 9, 5); // Sat 26 Sep 2026, 9:05 local
    const dec = new Date(Date.UTC(2026, 11, 17, 23, 30));

    it('en reads exactly as the apps always have', () => {
        expect(formatDate(sat, 'day-month')).toBe('26 Sep');
        expect(formatDate(sat, 'day-month', { width: 'long' })).toBe('26 September');
        expect(formatDate(sat, 'day-month-year')).toBe('26 Sep 2026');
        expect(formatDate(sat, 'day-month-year', { width: 'long' })).toBe('26 September 2026');
        expect(formatDate(sat, 'weekday-day-month')).toBe('Sat 26 Sep');
        expect(formatDate(sat, 'weekday')).toBe('Sat');
        expect(formatDate(sat, 'time')).toBe('9:05');
        expect(formatDate(dec, 'day-month-year', { utc: true })).toBe('17 Dec 2026');
    });

    it('the ru/fr/pt/es month and day tables are CLDR\'s (checked against Node ICU)', () => {
        for (const lang of LANGS.filter((l) => l !== 'en')) {
            const tag = INTL_TAG[lang];
            const w = DATE_WORDS[lang];
            for (let m = 0; m < 12; m++) {
                const d = new Date(Date.UTC(2026, m, 15, 12));
                const part = (o: Intl.DateTimeFormatOptions) =>
                    new Intl.DateTimeFormat(tag, { ...o, timeZone: 'UTC' }).formatToParts(d).find((p) => p.type === 'month')!.value;
                expect([lang, m, w.monthsLong[m]]).toEqual([lang, m, part({ day: 'numeric', month: 'long' })]);
                expect([lang, m, w.monthsShort[m]]).toEqual([lang, m, part({ day: 'numeric', month: 'short' })]);
                expect([lang, m, w.monthsStandalone[m]]).toEqual([lang, m, part({ month: 'long' })]);
            }
            for (let i = 0; i < 7; i++) {
                const d = new Date(Date.UTC(2026, 9, 11 + i, 12)); // 11 Oct 2026 is a Sunday
                const fmt = (weekday: 'short' | 'long') => new Intl.DateTimeFormat(tag, { weekday, timeZone: 'UTC' }).format(d);
                expect([lang, i, w.daysShort[i]]).toEqual([lang, i, fmt('short')]);
                expect([lang, i, w.daysLong[i]]).toEqual([lang, i, fmt('long')]);
            }
        }
    });

    it('ru/fr/pt/es dates read the way ICU writes them', () => {
        for (const lang of LANGS.filter((l) => l !== 'en')) {
            setLanguage(lang);
            const intl = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(INTL_TAG[lang], { ...o, timeZone: 'UTC' }).format(dec);
            for (const width of ['short', 'long'] as const) {
                const opts = { width, utc: true };
                expect([lang, width, formatDate(dec, 'day-month', opts)]).toEqual([lang, width, intl({ day: 'numeric', month: width })]);
                expect([lang, width, formatDate(dec, 'day-month-year', opts)])
                    .toEqual([lang, width, intl({ day: 'numeric', month: width, year: 'numeric' })]);
                expect([lang, width, formatDate(dec, 'weekday-day-month', opts)])
                    .toEqual([lang, width, intl({ weekday: width, day: 'numeric', month: width })]);
            }
            expect(formatDate(dec, 'time', { utc: true })).toBe(intl({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
        }
    });

    it('numbers: the language\'s decimal separator, never a thousands group', () => {
        expect(formatNumber(1234.5)).toBe('1234.5');
        expect(formatNumber(12, 2)).toBe('12.00');
        for (const lang of ['ru', 'fr', 'pt', 'es'] as const) {
            setLanguage(lang);
            expect(formatNumber(1234.5)).toBe('1234,5');
            expect(formatNumber(-0.25, 2)).toBe('-0,25');
        }
    });

    it('timeAgo in en, and in ru from a catalog', () => {
        expect([5e3, 3 * 60e3, 61 * 60e3, 2 * 3600e3, 26 * 3600e3, 5 * 86400e3].map(timeAgo)).toEqual([
            'just now', '3 minutes ago', '1 hour ago', '2 hours ago', '1 day ago', '5 days ago',
        ]);
        setLanguage('ru', [{
            'just now': 'только что',
            [pluralKey('{n} minute ago', '{n} minutes ago')]: { one: '{n} минуту назад', few: '{n} минуты назад', many: '{n} минут назад', other: '{n} минуты назад' },
        }]);
        expect([5e3, 1 * 60e3, 3 * 60e3, 5 * 60e3, 2 * 3600e3].map(timeAgo)).toEqual([
            'только что', '1 минуту назад', '3 минуты назад', '5 минут назад', '2 hours ago',
        ]);
    });
});

describe('the 12 recovery words stay English in every language (Director amendment 1, invariant 1)', () => {
    // A hostile catalog: every one of the 2048 words "translated". If any recovery path ever routed a word through t(),
    // the words a member types would stop making their key in that language.
    const hostile = Object.fromEntries(BIP39_ENGLISH.flatMap((w) => [[w, `${w}-x`], [w[0].toUpperCase() + w.slice(1), `${w}-X`]]));
    const words = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'zoo'];
    const typed = ' Abandon ability ABLE about above absent absorb abstract absurd abuse access zoo ';

    it('the same words derive the same key whatever the UI language', () => {
        setLanguage('en');
        const seedEn = bytesToHex(seedFromRecoveryWords(normaliseRecoveryWords(typed)));
        const publicKey = bytesToHex(ed25519.getPublicKey(seedFromRecoveryWords(words)));
        const packedEn = bytesToHex(packRecoveryWords(words));
        for (const lang of [...LANGS, PSEUDO_LANG] as UiLang[]) {
            setLanguage(lang, [hostile]);
            expect([lang, BIP39_ENGLISH.length, BIP39_ENGLISH[0], BIP39_ENGLISH[2047]]).toEqual([lang, 2048, 'abandon', 'zoo']);
            expect([lang, normaliseRecoveryWords(typed)]).toEqual([lang, words]);
            expect([lang, bytesToHex(seedFromRecoveryWords(normaliseRecoveryWords(typed)))]).toEqual([lang, seedEn]);
            expect([lang, recoveryWordsMatchPublicKey(typed, publicKey)]).toEqual([lang, true]);
            expect([lang, bytesToHex(packRecoveryWords(words))]).toEqual([lang, packedEn]);
            // The printed kit carries the words exactly as the key is made from them.
            const html = recoveryKitHtml({ words, communityName: 'Lyon', communityAddress: 'lyon.example', date: new Date(2026, 9, 3) });
            expect([lang, words.filter((w) => !html.includes(`>${w}<`))]).toEqual([lang, []]);
        }
    });

    it('no file that turns words into a key reaches the words layer', () => {
        const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
        const derive = [
            'packages/beanpool-core/src/recovery-words.ts',
            'packages/beanpool-core/src/recovery-words-seed.ts',
            'packages/beanpool-core/src/bip39-english.ts',
            'packages/beanpool-core/src/owner-words-check.ts',
            'apps/native/utils/crypto.ts',
            'apps/pwa/src/lib/mnemonic.ts',
        ];
        for (const file of derive) {
            const src = readFileSync(join(root, file), 'utf8');
            expect([file, /from\s+['"](?:[^'"]*\/)?words(?:\.js)?['"]/.test(src), /\bt\(|\btn\(/.test(src)]).toEqual([file, false, false]);
        }
    });
});

describe('one table of month and day names', () => {
    it('no English month or day table is left outside words.ts', () => {
        const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
        const dirs = ['packages/beanpool-core/src', 'apps/native/app', 'apps/native/components', 'apps/native/utils', 'apps/pwa/src', 'apps/server/src/engine', 'apps/server/src/routes'];
        const table = /\[\s*['"](Jan|January|JAN)['"]\s*,\s*['"](Feb|February|FEB)['"]|\[\s*['"](Sun|Sunday|SUN)['"]\s*,\s*['"](Mon|Monday|MON)['"]/;
        const found: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
                if (statSync(path).isDirectory()) walk(path);
                else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.endsWith('beanpool-core/src/words.ts')) {
                    if (table.test(readFileSync(path, 'utf8'))) found.push(relative(root, path));
                }
            }
        };
        for (const dir of dirs) walk(join(root, dir));
        expect(found).toEqual([]);
    });
});
