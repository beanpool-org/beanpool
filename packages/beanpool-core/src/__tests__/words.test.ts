/**
 * The words layer (words.ts, words-check.ts): scratch/global-node/DESIGN-translation-fable.md §7 slice S0.
 *
 * Plural rules, month and day names and date patterns of all 25 languages are checked against Node's own ICU (Intl),
 * which the tests may use and the phone may not; English is checked against what the apps print today, word for word.
 * When a new Node's CLDR changes a name, these ICU checks fail ON PURPOSE: re-check the table with
 * `node scripts/words/generate-date-words.mjs --check` (and PLURAL_RULES by hand); it is not a regression in the app.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    DATE_WORDS, LANGS, LANGUAGE_HEADER, PLURAL_CATEGORIES, PLURAL_RULES, PSEUDO_LANG, canonicalLang, currentLanguage, formatDate,
    formatNumber, isLang, normaliseLang, pluralCategory, pluralKey, pseudoLocalise, setLanguage, t, timeAgo, tn, withDigits, word,
    wordKey, wordsFor, type Lang, type UiLang,
} from '../words.js';
import { allowedPluralForms, callKey, callProblem, checkCatalog } from '../words-check.js';
import { BIP39_ENGLISH, normaliseRecoveryWords, packRecoveryWords, recoveryWordsMatchPublicKey } from '../recovery-words.js';
import { seedFromRecoveryWords } from '../recovery-words-seed.js';
import { recoveryKitHtml } from '../recovery-kit.js';

afterEach(() => setLanguage('en'));

/** ICU's tag for a language: Western digits and the Gregorian calendar, as the tables are (v1). */
const INTL_TAG = (lang: Lang) => `${lang}-u-ca-gregory-nu-latn`;
const RECHECK = 'ICU disagrees with the table: re-check it (scripts/words/generate-date-words.mjs --check; PLURAL_RULES by hand)';

describe('plural categories', () => {
    // The design's fail-first table, with every plural family of the 25: {0, 1, 2, 5, 21}.
    const EXPECTED: Partial<Record<Lang, string[]>> = {
        en: ['other', 'one', 'other', 'other', 'other'],
        ru: ['many', 'one', 'few', 'many', 'one'],
        uk: ['many', 'one', 'few', 'many', 'one'],
        fr: ['one', 'one', 'other', 'other', 'other'],
        pt: ['one', 'one', 'other', 'other', 'other'],
        es: ['other', 'one', 'other', 'other', 'other'],
        hi: ['one', 'one', 'other', 'other', 'other'],
        ar: ['zero', 'one', 'two', 'few', 'many'],
        fil: ['one', 'one', 'one', 'one', 'one'],
        'zh-Hans': ['other', 'other', 'other', 'other', 'other'],
    };
    for (const [lang, want] of Object.entries(EXPECTED) as [Lang, string[]][]) {
        it(`${lang}: 0, 1, 2, 5, 21`, () => {
            expect([0, 1, 2, 5, 21].map((n) => pluralCategory(lang, n))).toEqual(want);
        });
    }

    it('agrees with Node ICU for 0–1200, round millions and decimals, in every language in LANGS', () => {
        const numbers = [...Array.from({ length: 1201 }, (_, i) => i), 1_000_000, 2_000_000, 1_500_000, 0.5, 1.5, 2.5, 3.5, 11.5, 21.1, 0.4, 1.4, 2.6, 103.5];
        expect(LANGS.length).toBe(25);
        for (const lang of LANGS) {
            const rules = new Intl.PluralRules(lang);
            for (const n of numbers) expect([lang, n, pluralCategory(lang, n)], RECHECK).toEqual([lang, n, rules.select(n)]);
        }
    });

    it('each language\'s forms (required + optional) are exactly the categories ICU gives it', () => {
        for (const lang of LANGS) {
            const icu = new Intl.PluralRules(lang).resolvedOptions().pluralCategories as string[];
            const ours = allowedPluralForms(lang);
            expect([lang, [...ours].sort()], RECHECK).toEqual([lang, [...icu].sort()]);
            expect(PLURAL_CATEGORIES).toEqual(expect.arrayContaining(ours as string[]));
        }
    });

    it('EXACT forms: only the categories that hold ONE number may drop {n}, measured against ICU', () => {
        const numbers = [...Array.from({ length: 1201 }, (_, i) => i), 1_000_000, 2_000_000, 0.5, 1.5, 2.5, 0.1, 1.1, 21.1, 101.5];
        for (const lang of LANGS) {
            const rules = new Intl.PluralRules(lang);
            const by = new Map<string, Set<number>>();
            for (const n of numbers) by.set(rules.select(n), (by.get(rules.select(n)) ?? new Set()).add(n));
            const exact = [...by].filter(([, ns]) => ns.size === 1).map(([c]) => c).sort();
            expect([lang, [...PLURAL_RULES[lang].exact].sort()], RECHECK).toEqual([lang, exact]);
        }
        expect(PLURAL_RULES.fr.exact).toEqual([]);
        expect(PLURAL_RULES.ru.exact).toEqual([]);
        expect(PLURAL_RULES.ar.exact).toEqual(['zero', 'one', 'two']);
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

    it('ar plurals take all six forms; uk takes ru\'s three', () => {
        const key = pluralKey('{n} bean', '{n} beans');
        setLanguage('ar', [{ [key]: { zero: 'لا حبوب', one: 'حبة واحدة', two: 'حبتان', few: '{n} حبات', many: '{n} حبة', other: '{n} حبة.' } }]);
        expect([0, 1, 2, 3, 11, 100].map((n) => tn(n, '{n} bean', '{n} beans'))).toEqual(['لا حبوب', 'حبة واحدة', 'حبتان', '3 حبات', '11 حبة', '100 حبة.']);
        setLanguage('uk', [{ [key]: { one: '{n} біб', few: '{n} боби', many: '{n} бобів', other: '{n} боба' } }]);
        expect([1, 3, 5, 21, 1.5].map((n) => tn(n, '{n} bean', '{n} beans'))).toEqual(['1 біб', '3 боби', '5 бобів', '21 біб', '1,5 боба']);
    });

    it('word() marks a sentence in a table; t(key) translates it where it is shown, context included', () => {
        const KINDS = { paid: { body: word('{name} paid you') }, post: { label: word('Post', 'button: publish') } };
        expect(KINDS.paid.body).toBe('{name} paid you');
        expect(t(KINDS.paid.body, { name: 'Ana' })).toBe('Ana paid you');
        expect(t(KINDS.post.label)).toBe('Post');
        setLanguage('fr', [{ '{name} paid you': '{name} vous a payé', [wordKey('Post', 'button: publish')]: 'Publier' }]);
        expect(t(KINDS.paid.body, { name: 'Ana' })).toBe('Ana vous a payé');
        expect(t(KINDS.post.label)).toBe('Publier');
        setLanguage(PSEUDO_LANG);
        expect(t(KINDS.post.label)).toMatch(/^\[Þöšţ~+\]$/);
    });

    it('wordsFor(lang) renders in one language with no global state: a server renders per recipient', async () => {
        setLanguage('ru', [{ 'Save': 'Сохранить' }]);
        const fr = wordsFor('fr', [{ 'Save': 'Enregistrer', [pluralKey('{n} bean', '{n} beans')]: { one: '{n} haricot', other: '{n} haricots' } }]);
        const en = wordsFor('en');
        // Two renders interleaved across awaits: neither sees the other's language, nor the device's.
        const [a, b] = await Promise.all([
            (async () => { await Promise.resolve(); const x = fr.t('Save'); await new Promise((r) => setTimeout(r, 5)); return [x, fr.tn(0, '{n} bean', '{n} beans'), fr.formatNumber(2.5)]; })(),
            (async () => { const x = en.t('Save'); await Promise.resolve(); return [x, en.tn(0, '{n} bean', '{n} beans'), en.formatNumber(2.5)]; })(),
        ]);
        expect(a).toEqual(['Enregistrer', '0 haricot', '2,5']);
        expect(b).toEqual(['Save', '0 beans', '2.5']);
        expect(t('Save')).toBe('Сохранить');
        expect(currentLanguage()).toBe('ru');
        const dec = new Date(Date.UTC(2026, 11, 17, 23, 30));
        expect(formatDate(dec, 'day-month-year', { utc: true, lang: 'en' })).toBe('17 Dec 2026');
        expect(fr.formatDate(dec, 'day-month', { utc: true })).toBe('17 déc.');
        expect(formatDate(dec, 'day-month', { utc: true })).toBe('17 дек.');
        expect(formatNumber(2.5, undefined, 'en')).toBe('2.5');
        expect(fr.timeAgo(5e3)).toBe('just now');
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

    it('normaliseLang maps device tags to the 25 BCP-47 tags, and nothing else', () => {
        expect(['ru-RU', 'pt-BR', 'pt_PT', 'ES', 'fr-CA', 'en-AU', 'de-DE', 'nl-NL', 'he', '', '1x', null].map(normaliseLang)).toEqual([
            'ru', 'pt', 'pt', 'es', 'fr', 'en', 'de', null, null, null, null, null,
        ]);
        // Chinese by script, never collapsed to "zh": Simplified for zh / CN / SG / Hans, Traditional for TW / HK / MO / Hant.
        expect(['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-HK', 'zh_CN_#Hans', 'ZH-hans-cn'].map(normaliseLang)).toEqual(Array(7).fill('zh-Hans'));
        expect(['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-CN', 'zh_TW_#Hant', 'zh-hant'].map(normaliseLang)).toEqual(Array(7).fill('zh-Hant'));
        // Android's legacy codes and Tagalog.
        expect(['in-ID', 'in', 'tl', 'tl-PH', 'fil-PH', 'iw-IL'].map(normaliseLang)).toEqual(['id', 'id', 'fil', 'fil', 'fil', null]);
        expect(canonicalLang('iw-IL')).toBe('he');
        expect(LANGS.every((l) => normaliseLang(l) === l && isLang(l))).toBe(true);
        expect([isLang('zh'), isLang('tl'), isLang('xx'), isLang(7)]).toEqual([false, false, false, false]);
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
        expect(checkCatalog('fr', { [key]: { one: '{n} haricot', other: 'haricots' } }, sources, sources)[0].problem).toContain('dropped {n}');
    });

    it('a plural form may leave {n} out only where its category holds one number (else it prints the wrong count)', () => {
        const key = pluralKey('{n} bean', '{n} beans');
        const sources = new Set([key]);
        // fr "one" is also 0 and 1.5; ru "one" is also 21 and 101: "un haricot" / "один боб" would print the wrong number.
        expect(checkCatalog('fr', { [key]: { one: 'un haricot', other: '{n} haricots' } }, sources, sources).map((p) => p.problem))
            .toEqual(['the one form\'s placeholders differ from the English: dropped {n}']);
        expect(checkCatalog('ru', { [key]: { one: 'один боб', few: '{n} боба', many: '{n} бобов', other: '{n} боба' } }, sources, sources).map((p) => p.problem))
            .toEqual(['the one form\'s placeholders differ from the English: dropped {n}']);
        expect(checkCatalog('hi', { [key]: { one: 'एक बीन', other: '{n} बीन' } }, sources, sources)).toHaveLength(1);
        // es/de "one" is exactly 1; ar "zero"/"one"/"two" are exactly 0/1/2: words are fine there, never in "few".
        expect(checkCatalog('es', { [key]: { one: 'un frijol', other: '{n} frijoles' } }, sources, sources)).toEqual([]);
        expect(checkCatalog('de', { [key]: { one: 'eine Bohne', other: '{n} Bohnen' } }, sources, sources)).toEqual([]);
        const ar = { zero: 'لا حبوب', one: 'حبة واحدة', two: 'حبتان', few: '{n} حبات', many: '{n} حبة', other: '{n} حبة' };
        expect(checkCatalog('ar', { [key]: ar }, sources, sources)).toEqual([]);
        expect(checkCatalog('ar', { [key]: { ...ar, few: 'حبات' } }, sources, sources)).toHaveLength(1);
    });

    it('each language accepts only its own forms: ar six, fr no "few", zh only "other"; a missing one is named', () => {
        const key = pluralKey('{n} bean', '{n} beans');
        const sources = new Set([key]);
        expect(checkCatalog('fr', { [key]: { one: '{n} haricot', few: '{n} haricots', other: '{n} haricots' } }, sources, sources).map((p) => p.problem))
            .toEqual(['fr has no "few" form (its forms: one, other, many)']);
        expect(checkCatalog('fr', { [key]: { one: '{n} haricot', many: 'un million de haricots {n}', other: '{n} haricots' } }, sources, sources)).toEqual([]);
        expect(checkCatalog('ar', { [key]: { one: '{n} حبة', other: '{n} حبة' } }, sources, sources).map((p) => p.problem)).toEqual([
            'ar needs the "zero" form (zero, one, two, few, many, other)',
            'ar needs the "two" form (zero, one, two, few, many, other)',
            'ar needs the "few" form (zero, one, two, few, many, other)',
            'ar needs the "many" form (zero, one, two, few, many, other)',
        ]);
        expect(checkCatalog('zh-Hant', { [key]: { other: '{n} 顆豆' } }, sources, sources)).toEqual([]);
        expect(checkCatalog('ja', { [key]: { one: '{n} 豆', other: '{n} 豆' } }, sources, sources).map((p) => p.problem))
            .toEqual(['ja has no "one" form (its forms: other)']);
        expect(checkCatalog('fr', { [key]: { one: '{n} haricot', other: '{n} haricots', plenty: 'x' } }, sources, sources).map((p) => p.problem))
            .toEqual(['"plenty" is not a plural form']);
        expect(checkCatalog('zh' as Lang, {}, null)[0].problem).toContain('is not one of');
        expect(checkCatalog('en', {}, null)[0].problem).toContain('en has no catalog');
    });

    it('tn() always supplies {n}: a translation may use it even where the English forms do not', () => {
        const key = pluralKey('a bean', 'some beans');
        const sources = new Set([key]);
        expect(checkCatalog('ru', { [key]: { one: '{n} боб', few: '{n} боба', many: '{n} бобов', other: '{n} боба' } }, sources, sources)).toEqual([]);
        expect(checkCatalog('ru', { [key]: { one: '{x} боб', few: '{n} боба', many: '{n} бобов', other: '{n} боба' } }, sources, sources)[0].problem)
            .toContain('unknown {x}');
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

    it('word() is collected like t(); t(table.key) is checked by tsc; t()/tn() at module level is refused', () => {
        const at = 'x.ts:1';
        expect(callKey({ fn: 'word', text: 'Post', context: 'button', concatenated: false, at })).toBe('Post\u0004button');
        expect(callProblem({ fn: 'word', text: null, concatenated: false, at })).toContain('string literal');
        expect(callProblem({ fn: 'word', text: 'Saved', concatenated: false, at, moduleLevel: true })).toBeNull();
        expect(callProblem({ fn: 't', text: null, keyed: true, concatenated: false, at })).toBeNull();
        expect(callKey({ fn: 't', text: null, keyed: true, concatenated: false, at })).toBeNull();
        expect(callProblem({ fn: 't', text: 'Save', concatenated: false, at, moduleLevel: true })).toContain('module level');
        expect(callProblem({ fn: 'tn', text: '{n} a', other: '{n} b', concatenated: false, at, moduleLevel: true })).toContain('module level');
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

    it('every language\'s month and day tables are CLDR\'s (checked against Node ICU)', () => {
        for (const lang of LANGS.filter((l) => l !== 'en')) {
            const w = DATE_WORDS[lang]!;
            for (let m = 0; m < 12; m++) {
                const d = new Date(Date.UTC(2026, m, 15, 12));
                const part = (o: Intl.DateTimeFormatOptions) =>
                    new Intl.DateTimeFormat(INTL_TAG(lang), { ...o, timeZone: 'UTC' }).formatToParts(d).find((p) => p.type === 'month')!.value;
                expect([lang, m, w.monthsLong[m]], RECHECK).toEqual([lang, m, part({ day: 'numeric', month: 'long' })]);
                expect([lang, m, w.monthsShort[m]], RECHECK).toEqual([lang, m, part({ day: 'numeric', month: 'short' })]);
                expect([lang, m, w.monthsStandalone[m]], RECHECK).toEqual([lang, m, part({ month: 'long' })]);
            }
            for (let i = 0; i < 7; i++) {
                const d = new Date(Date.UTC(2026, 9, 11 + i, 12)); // 11 Oct 2026 is a Sunday
                const fmt = (weekday: 'short' | 'long') => new Intl.DateTimeFormat(INTL_TAG(lang), { weekday, timeZone: 'UTC' }).format(d);
                expect([lang, i, w.daysShortStandalone?.[i] ?? w.daysShort[i]], RECHECK).toEqual([lang, i, fmt('short')]);
                expect([lang, i, w.daysLongStandalone?.[i] ?? w.daysLong[i]], RECHECK).toEqual([lang, i, fmt('long')]);
            }
            // Western digits everywhere in v1 (bn and fa default to their own in CLDR): a data decision, not code.
            expect([lang, w.digits]).toEqual([lang, null]);
        }
    });

    it('every language\'s dates read the way ICU writes them, in its own word order (all 24 beside English)', () => {
        const dates = [dec, new Date(Date.UTC(2026, 0, 1, 0, 2)), new Date(Date.UTC(2026, 4, 9, 9, 5)), new Date(Date.UTC(2027, 7, 28, 13, 59))];
        for (const lang of LANGS.filter((l) => l !== 'en')) {
            setLanguage(lang);
            for (const d of dates) {
                const intl = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(INTL_TAG(lang), { ...o, timeZone: 'UTC' }).format(d);
                for (const width of ['short', 'long'] as const) {
                    const opts = { width, utc: true };
                    const at = [lang, width, d.toISOString()];
                    expect([...at, formatDate(d, 'day-month', opts)], RECHECK).toEqual([...at, intl({ day: 'numeric', month: width })]);
                    expect([...at, formatDate(d, 'day-month-year', opts)], RECHECK).toEqual([...at, intl({ day: 'numeric', month: width, year: 'numeric' })]);
                    expect([...at, formatDate(d, 'weekday-day-month', opts)], RECHECK).toEqual([...at, intl({ weekday: width, day: 'numeric', month: width })]);
                    expect([...at, formatDate(d, 'weekday', opts)], RECHECK).toEqual([...at, intl({ weekday: width })]);
                }
                expect([lang, formatDate(d, 'time', { utc: true })], RECHECK).toEqual([lang, intl({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })]);
            }
        }
        // The review's examples, by hand: day-dot, CJK suffixes and order, year first, numeric month, weekday last, year suffix, dot time.
        const oct15 = new Date(Date.UTC(2026, 9, 15, 9, 5));
        const say = (lang: Lang, p: Parameters<typeof formatDate>[1], width: 'short' | 'long' = 'short') => formatDate(oct15, p, { utc: true, width, lang });
        expect([say('de', 'day-month'), say('de', 'day-month-year', 'long')]).toEqual(['15. Okt.', '15. Oktober 2026']);
        expect([say('zh-Hans', 'day-month'), say('zh-Hans', 'day-month-year'), say('zh-Hans', 'weekday-day-month')]).toEqual(['10月15日', '2026年10月15日', '10月15日周四']);
        expect([say('zh-Hant', 'weekday-day-month'), say('ja', 'weekday-day-month'), say('ko', 'day-month-year')]).toEqual(['10月15日週四', '10月15日(木)', '2026년 10월 15일']);
        expect([say('ml', 'day-month-year', 'long'), say('ta', 'day-month'), say('vi', 'day-month'), say('tr', 'weekday-day-month')]).toEqual([
            '2026 ഒക്‌ടോബർ 15', 'அக். 15', '15 thg 10', '15 Eki Per',
        ]);
        expect([say('uk', 'day-month-year'), say('id', 'time'), say('fa', 'day-month-year', 'long')]).toEqual(['15 жовт. 2026 р.', '09.05', '15 اکتبر 2026']);
    });

    it('capitals on an event card are a per-language choice: Turkish dotted İ, Greek without accents but with the dialytika', () => {
        const oct15 = new Date(Date.UTC(2026, 9, 15, 9, 5));
        const caps = (lang: Lang) => formatDate(oct15, 'weekday-day-month', { utc: true, lang, caps: true });
        expect(caps('en')).toBe('THU 15 OCT');
        expect(caps('tr')).toBe('15 EKİ PER');
        expect(formatDate(new Date(Date.UTC(2026, 3, 15)), 'day-month', { utc: true, lang: 'tr', caps: true })).toBe('15 NİS');
        expect(caps('el')).toBe('ΠΕΜ 15 ΟΚΤ');
        expect(formatDate(oct15, 'weekday', { utc: true, lang: 'el', caps: true, width: 'long' })).toBe('ΠΕΜΠΤΗ');
        expect(caps('de')).toBe('DO., 15. OKT.');
        expect(caps('zh-Hans')).toBe('10月15日周四');
        // May keeps its dialytika (N-b): ΜΑΙ would read as the diphthong "αι".
        const may = new Date(Date.UTC(2026, 4, 15));
        expect(formatDate(may, 'day-month', { utc: true, lang: 'el', caps: true })).toBe('15 ΜΑΪ');
        expect(formatDate(may, 'day-month-year', { utc: true, lang: 'el', caps: true, width: 'long' })).toBe('15 ΜΑΪΟΥ 2026');
    });

    it('capitals equal ICU\'s toLocaleUpperCase in every language, for every month and day name in every pattern', () => {
        const differ: string[][] = [];
        for (const lang of LANGS) {
            for (let m = 0; m < 12; m++) {
                for (let i = 0; i < 7; i++) {
                    const d = new Date(Date.UTC(2026, m, 1 + i, 9, 5));
                    for (const width of ['short', 'long'] as const) {
                        for (const p of ['day-month', 'day-month-year', 'weekday-day-month', 'weekday'] as const) {
                            const plain = formatDate(d, p, { utc: true, lang, width });
                            const caps = formatDate(d, p, { utc: true, lang, width, caps: true });
                            if (caps !== plain.toLocaleUpperCase(lang)) differ.push([lang, p, width, plain, caps, plain.toLocaleUpperCase(lang)]);
                        }
                    }
                }
            }
        }
        expect(differ, RECHECK).toEqual([]);
    });

    it('digits are data: ten glyphs would replace 0–9 (none in v1)', () => {
        expect(withDigits('15 Oct 2026, 09:05', '০১২৩৪৫৬৭৮৯')).toBe('১৫ Oct ২০২৬, ০৯:০৫');
        expect(withDigits('15', null)).toBe('15');
    });

    it('the pseudo-locale brackets dates too, so a date never looks like text that bypassed t()', () => {
        setLanguage(PSEUDO_LANG);
        expect(formatDate(sat, 'weekday-day-month')).toMatch(/^\[Ŝāţ 26 Ŝéþ~+\]$/);
        expect(formatDate(sat, 'time')).toMatch(/^\[9:05~+\]$/);
    });

    it('numbers: the language\'s decimal separator, never a thousands group', () => {
        expect(formatNumber(1234.5)).toBe('1234.5');
        expect(formatNumber(12, 2)).toBe('12.00');
        for (const lang of ['ru', 'fr', 'pt', 'es'] as const) {
            setLanguage(lang);
            expect(formatNumber(1234.5)).toBe('1234,5');
            expect(formatNumber(-0.25, 2)).toBe('-0,25');
        }
        for (const lang of LANGS) {
            const icu = new Intl.NumberFormat(INTL_TAG(lang)).formatToParts(1.5).find((p) => p.type === 'decimal')!.value;
            expect([lang, DATE_WORDS[lang]!.decimal], RECHECK).toEqual([lang, icu]);
        }
    });

    it('a tag that is not one of LANGS reads English and never throws (N-a: a stale stored tag must not break every date)', () => {
        const oct15 = new Date(Date.UTC(2026, 9, 15, 9, 5));
        for (const bad of ['zh', 'he', 'pt-BR', 'EN', '', undefined, null, 42] as unknown as UiLang[]) {
            const at = String(bad);
            setLanguage(bad, [{ 'Save': 'Enregistrer' }]);
            expect([at, currentLanguage()]).toEqual([at, 'en']);
            expect([at, t('Save'), tn(1, '{n} bean', '{n} beans'), tn(2.5, '{n} bean', '{n} beans')]).toEqual([at, 'Save', '1 bean', '2.5 beans']);
            expect([at, formatDate(oct15, 'weekday-day-month', { utc: true }), timeAgo(3 * 60e3), formatNumber(1.5)]).toEqual([at, 'Thu 15 Oct', '3 minutes ago', '1.5']);
            setLanguage('ru');
            // A tag passed per call (undefined and null there mean "the current language", ru here).
            const perCall = bad == null ? ['15 окт.', '1,5'] : ['15 Oct', '1.5'];
            expect([at, formatDate(oct15, 'day-month', { utc: true, lang: bad }), formatNumber(1.5, 1, bad), pluralCategory(bad, 1)]).toEqual([at, ...perCall, 'one']);
            const w = wordsFor(bad);
            expect([at, w.lang, w.tn(3, '{n} bean', '{n} beans'), w.formatDate(oct15, 'time', { utc: true }), w.timeAgo(2 * 3600e3)]).toEqual([at, 'en', '3 beans', '9:05', '2 hours ago']);
            setLanguage('en');
        }
        // A real language and the pseudo-locale are kept.
        expect([wordsFor('fil').lang, wordsFor(PSEUDO_LANG).lang, wordsFor('zh-Hant').lang]).toEqual(['fil', PSEUDO_LANG, 'zh-Hant']);
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
                else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/beanpool-core\/src\/(words(-dates)?\.ts|words-dates\/[A-Za-z-]+\.ts)$/.test(path)) {
                    if (table.test(readFileSync(path, 'utf8'))) found.push(relative(root, path));
                }
            }
        };
        for (const dir of dirs) walk(join(root, dir));
        expect(found).toEqual([]);
    });
});

/**
 * What a server or engine file does with core's device-language globals (N11): every way it can reach them — a named
 * import or re-export (also from a deep path), a destructured dynamic import or require, a namespace or default import
 * (`core.t(…)`, `const { t } = core`), `export * from` — and every formatDate without a lang.
 */
function deviceLanguageUses(rel: string, src: string): string[] {
    const problems: string[] = [];
    const globals = ['t', 'tn', 'timeAgo', 'setLanguage', 'formatNumber'];
    const core = String.raw`['"]@beanpool\/core(?:\/[^'"]*)?['"]`;
    const names = (list: string) => list.split(',').map((x) => x.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:\s*/)[0]);
    const refuse = (list: string, how: string) => {
        for (const name of names(list)) if (globals.includes(name)) problems.push(`${rel}: ${how} ${name} (use wordsFor(lang))`);
    };
    for (const m of src.matchAll(new RegExp(String.raw`\b(import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${core}`, 'g'))) refuse(m[2], m[1] === 'import' ? 'imports' : 're-exports');
    for (const m of src.matchAll(new RegExp(String.raw`\{([^}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\(\s*${core}\s*\)`, 'g'))) refuse(m[1], 'imports');
    if (new RegExp(String.raw`\bexport\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*${core}`).test(src)) problems.push(`${rel}: re-exports all of core`);
    const spaces = new Set<string>();
    for (const m of src.matchAll(new RegExp(String.raw`\bimport\s+(?:([\w$]+)\s*,\s*)?(?:\*\s*as\s+([\w$]+)|([\w$]+))?\s*(?:,\s*\{[^}]*\}\s*)?from\s*${core}`, 'g'))) {
        for (const ns of [m[1], m[2], m[3]]) if (ns) spaces.add(ns);
    }
    for (const m of src.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?(?:import|require)\(\s*${core}\s*\)`, 'g'))) spaces.add(m[1]);
    for (const ns of spaces) {
        const at = ns.replace(/\$/g, '\\$');
        for (const m of src.matchAll(new RegExp(String.raw`(?<![\w$.])${at}\s*(?:\.\s*|\[\s*['"])(${globals.join('|')})\b`, 'g'))) problems.push(`${rel}: ${ns}.${m[1]} (use wordsFor(lang))`);
        for (const m of src.matchAll(new RegExp(String.raw`\{([^}]*)\}\s*=\s*${at}(?![\w$])`, 'g'))) refuse(m[1], `takes from ${ns}`);
    }
    src.split('\n').forEach((line, i) => {
        if (/\bformatDate\(/.test(line) && !/\blang:/.test(line) && !/function formatDate/.test(line)) problems.push(`${rel}:${i + 1}: formatDate without lang`);
    });
    return problems;
}

describe('a node never writes in the device language (N11)', () => {
    it('the guard sees every way to reach the globals: named, deep, namespace, default, dynamic, destructured, re-exported (N-e)', () => {
        const seen = (src: string) => deviceLanguageUses('x.ts', src);
        // The review's probe, which the named-import check alone passed.
        expect(seen("import * as core from '@beanpool/core';\ncore.setLanguage('fr');\nconst s = core.t('Saved');")).toEqual([
            'x.ts: core.t (use wordsFor(lang))', 'x.ts: core.setLanguage (use wordsFor(lang))',
        ].reverse());
        expect(seen("import { t } from '@beanpool/core';")).toEqual(['x.ts: imports t (use wordsFor(lang))']);
        expect(seen("import { tn as plural } from '@beanpool/core/dist/words.js';")).toEqual(['x.ts: imports tn (use wordsFor(lang))']);
        expect(seen("export { timeAgo } from '@beanpool/core';")).toEqual(['x.ts: re-exports timeAgo (use wordsFor(lang))']);
        expect(seen("export * from '@beanpool/core';")).toEqual(['x.ts: re-exports all of core']);
        expect(seen("const { t: say } = await import('@beanpool/core');")).toEqual(['x.ts: imports t (use wordsFor(lang))']);
        expect(seen("const core = await import('@beanpool/core');\nawait core.tn(2, 'a', 'b');")).toEqual(['x.ts: core.tn (use wordsFor(lang))']);
        expect(seen("const c = require('@beanpool/core');\nc['formatNumber'](1);")).toEqual(['x.ts: c.formatNumber (use wordsFor(lang))']);
        expect(seen("import core, { wordsFor } from '@beanpool/core';\nconst { timeAgo } = core;")).toEqual(['x.ts: takes from core timeAgo (use wordsFor(lang))']);
        expect(seen("import * as core from '@beanpool/core';\ncore.formatDate(d, 'time');")).toEqual(['x.ts:2: formatDate without lang']);
        // What a server may do: wordsFor, a date with a lang, anything else core exports, a local t.
        expect(seen([
            "import * as core from '@beanpool/core';",
            "import { wordsFor, formatDate, openEnvelope } from '@beanpool/core';",
            "const { sealSeedToSso } = await import('@beanpool/core');",
            "const w = core.wordsFor('fr'); w.t('Saved'); core.wordsFor(lang).tn(2, 'a', 'b'); core.tokens; core.timeAgoish;",
            "core.formatDate(d, 'time', { lang: 'en' }); formatDate(d, 'time', { lang });",
            'const t = (s: string) => s; t(x); other.t(y);',
        ].join('\n'))).toEqual([]);
    });

    it('server and engine code pass a language to every date, and never use the global t/tn/timeAgo/setLanguage', () => {
        const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
        const problems: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
                if (statSync(path).isDirectory()) { walk(path); continue; }
                if (!/\.ts$/.test(name) || /^test-|\.test\.ts$/.test(name)) continue;
                problems.push(...deviceLanguageUses(relative(root, path), readFileSync(path, 'utf8')));
            }
        };
        walk(join(root, 'apps/server/src'));
        walk(join(root, 'packages/beanpool-engine/src'));
        expect(problems).toEqual([]);
    });
});
