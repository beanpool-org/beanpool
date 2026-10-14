/**
 * The words layer: every sentence a member reads, in their language (scratch/global-node/DESIGN-translation-fable.md §2).
 *
 * The key IS the English sentence (gettext style). Tests run in `en`, where `t()` returns its argument, so every test that
 * pins an English sentence keeps working unchanged; a changed English sentence orphans its old translation on its own;
 * a missing translation falls back to the English it is keyed by (a fallback, never a break: onboarding-no-hard-gates).
 *
 *   t('{name} added you', { name })                         named placeholders; they may move or repeat, never be dropped
 *   t('Post', undefined, 'button: publish')                 a context for a word that means two things
 *   tn(n, '{n} new message', '{n} new messages')            plurals: a catalog entry holds the forms its language needs
 *   const SAVED = word('Saved');  …  t(SAVED)               a sentence kept in a table: marked where it is written,
 *                                                           translated where it is shown (never t() at module level)
 *   wordsFor('fr', catalogs).t('Save')                      an explicit language (a server rendering for one recipient)
 *
 * Whole sentences only: never `t('You have') + n + t('messages')` (`words:check` refuses a fragment).
 *
 * Dates, numbers and relative times come from tables, not from `Intl`: the phone avoids `Intl` on purpose (Hermes
 * implements it only partly) and the 320 px tests need the same text on every runtime. English is written here by hand;
 * every other language's names and word order are CLDR's, copied once by scripts/words/generate-date-words.mjs into
 * words-dates.ts and checked against Node's ICU by __tests__/words.test.ts.
 *
 * Never route a recovery word through `t()`: the 12 words stay English in every language, because the account key is
 * sha256(sha256(the words)) over the English strings (recovery-words-seed.ts; the invariant test in words.test.ts).
 * `t()` takes a string LITERAL or a `WordKey` from `word('…')`; a plain `string` (a recovery word, a member's text) does
 * not type-check, and words:check refuses a bare variable as well.
 *
 * Pure and universal: no Node built-ins, no Intl, no React; the phone, the web app and the server load the same module.
 */

import { CLDR_DATE_WORDS } from './words-dates.js';

/**
 * The 25 language versions (Marty, 15 Oct; design amendments 3–4), as BCP-47 tags, in the order the picker lists them.
 * Chinese is two versions by script, not by country: zh-Hans (Simplified) and zh-Hant (Traditional).
 */
export const LANGS = Object.freeze(['en', 'es', 'pt', 'hi', 'bn', 'fr', 'ar', 'id', 'ru', 'zh-Hans', 'zh-Hant', 'it', 'de', 'tr', 'sw', 'ml', 'ta', 'uk', 'ur', 'fa', 'vi', 'el', 'fil', 'ja', 'ko'] as const);
export type Lang = (typeof LANGS)[number];

export function isLang(tag: unknown): tag is Lang {
    return typeof tag === 'string' && (LANGS as readonly string[]).includes(tag);
}

/**
 * The pseudo-locale: every sentence accented and padded about 35 %, in brackets. Not a language anyone picks; the
 * 320 px render tests run in it so clipped text fails, and any text WITHOUT the brackets bypassed `t()`. Dates are
 * bracketed too (formatDate), so a date is never mistaken for text that bypassed the words layer.
 */
export const PSEUDO_LANG = 'xx' as const;
export type UiLang = Lang | typeof PSEUDO_LANG;

/**
 * A tag BeanPool can write in, or English: a stale stored tag, a device's `he` or `pt-BR` cast to UiLang, or '' reads
 * English and never throws, so a bad tag can never break every date on every screen (onboarding-no-hard-gates).
 */
const usableLang = (lang: UiLang): UiLang => (isLang(lang) || lang === PSEUDO_LANG ? lang : 'en');

/**
 * The request header that carries the device's language to a node: one of the LANGS tags exactly as written there
 * (`ru`, `zh-Hant`, `fil`), never "two letters" and never the browser's Accept-Language. A node reads it with
 * `normaliseLang` and stores or uses nothing that fails `isLang`. Never logged, never stored on its own.
 */
export const LANGUAGE_HEADER = 'X-Language';

// ── Language tags ──────────────────────────────────────────────────────────────────────────────────────────────

/** Legacy and synonym base subtags a device may still send (Android's Java Locale keeps the 1988 codes). */
const LANG_ALIASES: Readonly<Record<string, string>> = Object.freeze({ in: 'id', iw: 'he', tl: 'fil' });
/** Chinese regions that write Traditional characters when the tag names no script. */
const HANT_REGIONS: ReadonlySet<string> = new Set(['tw', 'hk', 'mo']);

/**
 * A device or browser tag in canonical form, whether or not BeanPool has that language: `ru-RU` → ru, `pt_BR` → pt,
 * `in-ID` → id, `iw-IL` → he, `tl` → fil; Chinese by script: zh, zh-CN, zh-SG, zh-Hans-HK → zh-Hans;
 * zh-TW, zh-HK, zh-MO, zh-Hant → zh-Hant (a script subtag wins over a region). Android's `zh_CN_#Hans` is read too.
 */
export function canonicalLang(tag: string | null | undefined): string | null {
    if (typeof tag !== 'string') return null;
    const subtags = tag.trim().split(/[-_]/).map((s) => s.replace(/^#/, '').toLowerCase()).filter(Boolean);
    if (subtags.length === 0 || !/^[a-z]{2,3}$/.test(subtags[0])) return null;
    const base = LANG_ALIASES[subtags[0]] ?? subtags[0];
    if (base !== 'zh') return base;
    const rest = subtags.slice(1);
    if (rest.includes('hant')) return 'zh-Hant';
    if (rest.includes('hans')) return 'zh-Hans';
    return rest.some((r) => HANT_REGIONS.has(r)) ? 'zh-Hant' : 'zh-Hans';
}

/** A device or browser tag to one of LANGS, or null when BeanPool has no version in that language. */
export function normaliseLang(tag: string | null | undefined): Lang | null {
    const c = canonicalLang(tag);
    return isLang(c) ? c : null;
}

// ── Plural rules (CLDR; checked against Intl.PluralRules for every language in LANGS by the tests) ─────────────

/** CLDR's six categories. A language uses some of them; `other` is always one. */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
export const PLURAL_CATEGORIES: readonly PluralCategory[] = Object.freeze(['zero', 'one', 'two', 'few', 'many', 'other']);
export type PluralForms = Partial<Record<PluralCategory, string>>;

/** CLDR's operands for a number as written in decimal: n absolute value, i integer digits, v count and f value of the fraction digits. */
export interface PluralOperands { n: number; i: number; v: number; f: number }

function operands(num: number): PluralOperands {
    const n = Math.abs(num);
    const s = String(n);
    if (!/^\d+(\.\d+)?$/.test(s)) return { n, i: Math.floor(n), v: 0, f: 0 };
    const [int, frac = ''] = s.split('.');
    return { n, i: Number(int), v: frac.length, f: frac ? Number(frac) : 0 };
}

export interface PluralRule {
    /** CLDR's rule for the language. */
    select(o: PluralOperands): PluralCategory;
    /** The forms a translated plural entry must carry. */
    forms: readonly PluralCategory[];
    /** Forms it may carry (fr/pt/es/it `many`: only round millions use it; a missing form falls back to `other`). */
    optional: readonly PluralCategory[];
    /**
     * The forms that only ever hold ONE number (en `one` is 1 and nothing else; ar `zero`/`one`/`two` are 0/1/2). Only
     * these may write the number in words and leave `{n}` out; fr `one` also holds 0 and 1.5, ru `one` holds 21 and 101.
     */
    exact: readonly PluralCategory[];
}

const isInt = (x: number) => Number.isInteger(x);
const roundMillion = ({ i, v }: PluralOperands) => v === 0 && i !== 0 && i % 1_000_000 === 0;

/** en, de, it-without-millions, tr, sw, ml, ta, ur, el: `one` is exactly 1. */
const ONE_IS_ONE: PluralRule = { select: ({ i, v }) => (i === 1 && v === 0 ? 'one' : 'other'), forms: ['one', 'other'], optional: [], exact: ['one'] };
/** zh, id, vi, ja, ko: no plural forms. */
const OTHER_ONLY: PluralRule = { select: () => 'other', forms: ['other'], optional: [], exact: [] };
/** fr, pt: 0 and 1 (and 1.5) are `one`; a round million takes `many`. */
const ZERO_ONE_ARE_ONE: PluralRule = {
    select: (o) => (o.i === 0 || o.i === 1 ? 'one' : roundMillion(o) ? 'many' : 'other'), forms: ['one', 'other'], optional: ['many'], exact: [],
};
/** hi, bn, fa: 0 is `one` (i = 0 or n = 1), so 0.5 is too. */
const ZERO_IS_ONE: PluralRule = { select: ({ i, n }) => (i === 0 || n === 1 ? 'one' : 'other'), forms: ['one', 'other'], optional: [], exact: [] };
/** ru, uk: one 1, 21, 101 …; few 2–4, 22–24 …; many 0, 5–20, 25 …; other the fractions. */
const EAST_SLAVIC: PluralRule = {
    select: ({ i, v }) => {
        if (v !== 0) return 'other';
        const m10 = i % 10;
        const m100 = i % 100;
        if (m10 === 1 && m100 !== 11) return 'one';
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'few';
        return 'many';
    },
    forms: ['one', 'few', 'many', 'other'], optional: [], exact: [],
};

export const PLURAL_RULES: Readonly<Record<Lang, PluralRule>> = Object.freeze({
    en: ONE_IS_ONE, de: ONE_IS_ONE, tr: ONE_IS_ONE, sw: ONE_IS_ONE, ml: ONE_IS_ONE, ta: ONE_IS_ONE, ur: ONE_IS_ONE, el: ONE_IS_ONE,
    es: { select: (o) => (o.n === 1 ? 'one' : roundMillion(o) ? 'many' : 'other'), forms: ['one', 'other'], optional: ['many'], exact: ['one'] },
    it: { select: (o) => (o.i === 1 && o.v === 0 ? 'one' : roundMillion(o) ? 'many' : 'other'), forms: ['one', 'other'], optional: ['many'], exact: ['one'] },
    fr: ZERO_ONE_ARE_ONE, pt: ZERO_ONE_ARE_ONE,
    hi: ZERO_IS_ONE, bn: ZERO_IS_ONE, fa: ZERO_IS_ONE,
    ru: EAST_SLAVIC, uk: EAST_SLAVIC,
    ar: {
        select: ({ n }) => {
            if (n === 0) return 'zero';
            if (n === 1) return 'one';
            if (n === 2) return 'two';
            const m100 = n % 100;
            if (isInt(m100) && m100 >= 3 && m100 <= 10) return 'few';
            if (isInt(m100) && m100 >= 11 && m100 <= 99) return 'many';
            return 'other';
        },
        forms: ['zero', 'one', 'two', 'few', 'many', 'other'], optional: [], exact: ['zero', 'one', 'two'],
    },
    fil: {
        // v = 0 and i = 1,2,3 or v = 0 and i % 10 != 4,6,9 or v != 0 and f % 10 != 4,6,9
        select: ({ i, v, f }) => {
            const bad = (x: number) => x % 10 === 4 || x % 10 === 6 || x % 10 === 9;
            if (v === 0) return i === 1 || i === 2 || i === 3 || !bad(i) ? 'one' : 'other';
            return bad(f) ? 'other' : 'one';
        },
        forms: ['one', 'other'], optional: [], exact: [],
    },
    'zh-Hans': OTHER_ONLY, 'zh-Hant': OTHER_ONLY, id: OTHER_ONLY, vi: OTHER_ONLY, ja: OTHER_ONLY, ko: OTHER_ONLY,
});

/** The plural forms each language's catalog entry must carry (from PLURAL_RULES). */
export const PLURAL_FORMS: Readonly<Record<Lang, readonly PluralCategory[]>> = Object.freeze(
    Object.fromEntries(LANGS.map((l) => [l, PLURAL_RULES[l].forms])) as Record<Lang, readonly PluralCategory[]>,
);

export function pluralCategory(lang: UiLang, n: number): PluralCategory {
    if (!Number.isFinite(n)) return 'other';
    return PLURAL_RULES[isLang(lang) ? lang : 'en'].select(operands(n));
}

// ── Keys ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One package's words in one language: `{ "<english>": "<translation>" }`, plurals as `{ "<one>|<other>": { one, few, … } }`. */
export type Catalog = Readonly<Record<string, unknown>>;

/** The separator between context and sentence in a key: `Post\u0004button: publish` (gettext's). */
export const CONTEXT_SEPARATOR = '\u0004';
/** The separator between the English singular and plural in a plural key. */
export const PLURAL_SEPARATOR = '|';

export function wordKey(source: string, context?: string): string {
    return context ? `${source}${CONTEXT_SEPARATOR}${context}` : source;
}

export function pluralKey(one: string, other: string): string {
    return `${one}${PLURAL_SEPARATOR}${other}`;
}

declare const WORD_KEY: unique symbol;
/** A sentence marked with `word('…')`: the only kind of non-literal `t()` accepts. */
export type WordKey = string & { readonly [WORD_KEY]: true };

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
/**
 * What `t()` / `tn()` / `word()` accept: a string literal, or a `WordKey`. A plain `string`, `any` or a union of literals
 * becomes `never`, so `t(someWord)` with `someWord: string` does not compile (tsc, not only words:check, guards it).
 */
export type Sentence<S extends string> = IsAny<S> extends true ? never : string extends S ? never : true extends IsUnion<S> ? never : S;

/**
 * Mark a sentence that is written in one place (a table of push kinds, tour steps, help lines) and shown in another:
 * the extractor collects it like a `t()` call, and `t(key)` translates it where it is shown, in the language of that
 * moment. Returns the key unchanged (identity in English).
 */
export function word<S extends string>(source: S & Sentence<S>, context?: string): WordKey {
    return wordKey(source, context) as WordKey;
}

// ── Dates and numbers ──────────────────────────────────────────────────────────────────────────────────────────

export type DatePattern = 'day-month' | 'day-month-year' | 'weekday-day-month' | 'weekday' | 'time';
/** The patterns a language writes in its own word order. */
export type WrittenDatePattern = Exclude<DatePattern, 'weekday' | 'time'>;

export interface DateWords {
    /** Month names as they read inside a date ("15 октября"): CLDR's `format` context, wide. */
    monthsLong: readonly string[];
    /** The same, abbreviated ("15 окт."). */
    monthsShort: readonly string[];
    /** A month named on its own (a heading: "Октябрь"): CLDR's `stand-alone` context, wide. */
    monthsStandalone: readonly string[];
    /** Only where a month reads differently before a year (fa's ezafe: "ژانویهٔ 2026"); else monthsShort / monthsLong. */
    monthsWithYear?: Readonly<Partial<Record<'short' | 'long', readonly string[]>>>;
    /** Weekday names inside a date (de "Do., 15. Okt."), Sunday first, like Date#getDay. */
    daysShort: readonly string[];
    daysLong: readonly string[];
    /** A weekday on its own (de "Do"), only where it differs from daysShort / daysLong: the `weekday` pattern. */
    daysShortStandalone?: readonly string[];
    daysLongStandalone?: readonly string[];
    /**
     * Word order and punctuation per width: {d} day, {M} month name (monthsShort or monthsLong by width), {m} month
     * number, {y} year, {W} weekday name. de "{d}. {M}", zh "{m}月{d}日{W}", tr "{d} {M} {W}", ml "{y} {M} {d}".
     */
    patterns: Readonly<Record<'short' | 'long', Readonly<Record<WrittenDatePattern, string>>>>;
    /** The time of day, 24 h: {H} hour 00–23, {h} hour 0–23 unpadded, {mm} minutes. id "{H}.{mm}". */
    time: string;
    /** The decimal separator. Amounts never group thousands (`1.000` reads as one in es/pt). */
    decimal: string;
    /** Ten glyphs for 0–9, or null for Western digits. Null in every language for v1 (bn and fa could switch later). */
    digits: string | null;
    /**
     * How a date is written in capitals (an event card's day label): `upper` toUpperCase; `turkic` dotted capital İ
     * (Turkish "Eki" → "EKİ", never "EKI"); `greek` capitals without accents, as Greek writes them ("Πέμ" → "ΠΕΜ").
     */
    caps: 'upper' | 'turkic' | 'greek';
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EN_DATE_PATTERNS = { 'day-month': '{d} {M}', 'day-month-year': '{d} {M} {y}', 'weekday-day-month': '{W} {d} {M}' } as const;

/** English as the apps have always printed it ("3 Oct", "Sat 3 Oct", "9:05"); every other language from CLDR. */
const EN_DATE_WORDS: DateWords = Object.freeze({
    monthsLong: EN_MONTHS,
    // Ours, not CLDR's en-GB ("Sept"): the apps have always printed three letters.
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    monthsStandalone: EN_MONTHS,
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    daysLong: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    patterns: { short: EN_DATE_PATTERNS, long: EN_DATE_PATTERNS },
    time: '{h}:{mm}',
    decimal: '.',
    digits: null,
    caps: 'upper',
});

const dateTables: Partial<Record<Lang, DateWords>> = { en: EN_DATE_WORDS, ...CLDR_DATE_WORDS };

/**
 * The date words of each language this build carries. The phone and the server carry all of them (words-dates.ts
 * gathers every language's module). The web app's first chunk carries English alone: its build puts an empty table in
 * words-dates.ts's place, and a language's dates arrive with its words, in that language's own chunk, through
 * `addDateWords` (apps/pwa/src/lib/language.ts; #1941 review N-f). A language whose table has not arrived writes its
 * dates and numbers in English, never a throw.
 */
export const DATE_WORDS: Readonly<Partial<Record<Lang, DateWords>>> = dateTables;

/** Add one language's date words (packages/beanpool-core/src/words-dates/<lang>.ts), as the web app loads that language. */
export function addDateWords(lang: Lang, words: DateWords): void {
    if (isLang(lang) && lang !== 'en') dateTables[lang] = words;
}

const dateWordsOf = (lang: UiLang): DateWords => dateTables[isLang(lang) ? lang : 'en'] ?? EN_DATE_WORDS;

export interface DateOptions {
    /** 'short' (default): "3 Oct", "Sat"; 'long': "3 October", "Saturday". */
    width?: 'short' | 'long';
    /** Read the date in UTC rather than the device's own time (dates the node already fixed to a calendar day). */
    utc?: boolean;
    /** The language to write it in; the current language when absent. A server always passes one. */
    lang?: UiLang;
    /** In capitals, the language's way (DateWords.caps): an event card's day label. */
    caps?: boolean;
}

/** Western digits to the language's own, when its table has any (none in v1). */
export function withDigits(text: string, digits: string | null): string {
    return digits ? text.replace(/[0-9]/g, (c) => digits[Number(c)]) : text;
}

function inCapitals(text: string, caps: DateWords['caps']): string {
    if (caps === 'turkic') return text.replace(/i/g, 'İ').toUpperCase();
    // Greek capitals drop the accents (oxia/tonos, varia, perispomeni) and keep the dialytika: Μαΐ → ΜΑΪ, as ICU writes it;
    // without it ΜΑΙ reads as the diphthong "αι". The tests compare every name with ICU's toLocaleUpperCase('el').
    if (caps === 'greek') return text.toUpperCase().normalize('NFD').replace(/[\u0300\u0301\u0342]/g, '').normalize('NFC');
    return text.toUpperCase();
}

function numberIn(lang: UiLang, n: number, decimals?: number): string {
    if (!Number.isFinite(n)) return String(n);
    const w = dateWordsOf(lang);
    const text = decimals === undefined ? String(n) : n.toFixed(decimals);
    return withDigits(w.decimal === '.' ? text : text.replace('.', w.decimal), w.digits);
}

function dateIn(lang: UiLang, d: Date, pattern: DatePattern, opts: DateOptions): string {
    const w = dateWordsOf(lang);
    const width = opts.width === 'long' ? 'long' : 'short';
    const utc = opts.utc === true;
    const month = utc ? d.getUTCMonth() : d.getMonth();
    const hours = utc ? d.getUTCHours() : d.getHours();
    const weekday = utc ? d.getUTCDay() : d.getDay();
    const days = pattern === 'weekday'
        ? (width === 'long' ? w.daysLongStandalone ?? w.daysLong : w.daysShortStandalone ?? w.daysShort)
        : (width === 'long' ? w.daysLong : w.daysShort);
    const months = (pattern === 'day-month-year' ? w.monthsWithYear?.[width] : undefined) ?? (width === 'long' ? w.monthsLong : w.monthsShort);
    const tokens: Record<string, string> = {
        d: String(utc ? d.getUTCDate() : d.getDate()),
        m: String(month + 1),
        M: months[month],
        y: String(utc ? d.getUTCFullYear() : d.getFullYear()),
        W: days[weekday],
        H: String(hours).padStart(2, '0'),
        h: String(hours),
        mm: String(utc ? d.getUTCMinutes() : d.getMinutes()).padStart(2, '0'),
    };
    const template = pattern === 'time' ? w.time : pattern === 'weekday' ? '{W}' : w.patterns[width][pattern];
    let text = withDigits(template.replace(/\{(d|m|M|y|W|H|h|mm)\}/g, (_, k: string) => tokens[k]), w.digits);
    if (opts.caps) text = inCapitals(text, w.caps);
    return lang === PSEUDO_LANG ? pseudoLocalise(text) : text;
}

// ── Pseudo-locale ──────────────────────────────────────────────────────────────────────────────────────────────

const ACCENTED: Record<string, string> = {
    a: 'ā', b: 'ƀ', c: 'ç', d: 'đ', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ö',
    p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ū', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
    A: 'Ā', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö',
    P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Ŝ', T: 'Ţ', U: 'Ū', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/** The opening and closing marks of a pseudo-locale sentence. */
export const PSEUDO_OPEN = '[';
export const PSEUDO_CLOSE = ']';

/** "Save" → "[Šāṽé~~]": accented, padded ~35 % (at least one ~), placeholders and `**bold**` marks kept intact. */
export function pseudoLocalise(source: string): string {
    const parts = source.split(/(\{[A-Za-z0-9_]+\})/);
    const body = parts.map((part) => (/^\{[A-Za-z0-9_]+\}$/.test(part) ? part : part.replace(/[A-Za-z]/g, (c) => ACCENTED[c] ?? c))).join('');
    const pad = '~'.repeat(Math.max(1, Math.ceil(source.length * 0.35)));
    return `${PSEUDO_OPEN}${body}${pad}${PSEUDO_CLOSE}`;
}

// ── t / tn ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type WordValues = Record<string, string | number>;

/** The `{name}` placeholders a sentence carries, each once, in order of first use. */
export function placeholdersOf(sentence: string): string[] {
    const seen: string[] = [];
    for (const m of sentence.matchAll(/\{([A-Za-z0-9_]+)\}/g)) if (!seen.includes(m[1])) seen.push(m[1]);
    return seen;
}

export type TFunction = <S extends string>(source: S & Sentence<S>, values?: WordValues, context?: string) => string;
export type TnFunction = <A extends string, B extends string>(n: number, one: A & Sentence<A>, other: B & Sentence<B>, values?: WordValues) => string;

/** Everything that writes words, bound to ONE language: what a server uses to render for a recipient. */
export interface Words {
    readonly lang: UiLang;
    /** One sentence; the English (the key) when there is no translation. Takes a literal or a `word()` key. */
    t: TFunction;
    /** A sentence with a count: `tn(n, '{n} new message', '{n} new messages')`; a missing form falls back to `other`, then English. */
    tn: TnFunction;
    formatDate(d: Date, pattern: DatePattern, opts?: Omit<DateOptions, 'lang'>): string;
    formatNumber(n: number, decimals?: number): string;
    timeAgo(ms: number): string;
}

/** "just now", "3 minutes ago", "2 hours ago", "5 days ago": from a duration in milliseconds. */
function timeAgoWith(t: TFunction, tn: TnFunction, ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return t('just now');
    const min = Math.floor(s / 60);
    if (min < 60) return tn(min, '{n} minute ago', '{n} minutes ago');
    const h = Math.floor(min / 60);
    if (h < 24) return tn(h, '{n} hour ago', '{n} hours ago');
    const days = Math.floor(h / 24);
    return tn(days, '{n} day ago', '{n} days ago');
}

/**
 * The words of one language: the app's catalogs and core's for that language (`en` needs none: the key is the
 * English). Holds no global state, so two requests rendering for two recipients never see each other's language.
 * A tag that is not one of LANGS (or xx) gives English, never a throw.
 */
export function wordsFor(requested: UiLang, catalogs: readonly Catalog[] = []): Words {
    const lang = usableLang(requested);
    const table = new Map<string, string | PluralForms>();
    if (lang !== 'en' && lang !== PSEUDO_LANG) {
        for (const catalog of catalogs) {
            for (const [key, value] of Object.entries(catalog ?? {})) {
                if (key === '_meta') continue;
                if (typeof value === 'string' && value.length > 0) table.set(key, value);
                else if (value && typeof value === 'object') table.set(key, value as PluralForms);
            }
        }
    }
    const interpolate = (sentence: string, values?: WordValues): string => {
        if (!values) return sentence;
        return sentence.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
            if (!Object.prototype.hasOwnProperty.call(values, name)) return whole;
            const v = values[name];
            return typeof v === 'number' ? numberIn(lang, v) : String(v);
        });
    };
    const t: TFunction = (source, values, context) => {
        const key = wordKey(source, context);
        const english = key.split(CONTEXT_SEPARATOR)[0];
        if (lang === PSEUDO_LANG) return interpolate(pseudoLocalise(english), values);
        const hit = lang === 'en' ? undefined : table.get(key);
        return interpolate(typeof hit === 'string' ? hit : english, values);
    };
    const tn: TnFunction = (n, one, other, values) => {
        const all: WordValues = { n, ...values };
        const englishPick: string = pluralCategory('en', n) === 'one' ? one : other;
        if (lang === PSEUDO_LANG) return interpolate(pseudoLocalise(englishPick), all);
        const hit = lang === 'en' ? undefined : table.get(pluralKey(one, other));
        if (hit && typeof hit === 'object') {
            const chosen = hit[pluralCategory(lang, n)] ?? hit.other;
            if (typeof chosen === 'string' && chosen.length > 0) return interpolate(chosen, all);
        }
        return interpolate(englishPick, all);
    };
    return Object.freeze({
        lang,
        t,
        tn,
        formatDate: (d: Date, pattern: DatePattern, opts: Omit<DateOptions, 'lang'> = {}) => dateIn(lang, d, pattern, opts),
        formatNumber: (n: number, decimals?: number) => numberIn(lang, n, decimals),
        timeAgo: (ms: number) => timeAgoWith(t, tn, ms),
    });
}

// ── The device's language (the apps' one global; a server never sets it) ─────────────────────────────────────

let active: Words = wordsFor('en');

/**
 * Switch the device's language: the app passes its own catalogs and core's for that language. Live: the next `t()`
 * reads the new table; the app's provider re-renders. A server never calls this: it uses `wordsFor(lang)` per request.
 */
export function setLanguage(lang: UiLang, catalogs: readonly Catalog[] = []): void {
    active = wordsFor(lang, catalogs);
}

export function currentLanguage(): UiLang {
    return active.lang;
}

/** One sentence in the current language; the English (the key) when there is no translation. */
export const t: TFunction = (source, values, context) => active.t(source, values, context);

/**
 * A sentence with a count in it: `tn(n, '{n} new message', '{n} new messages')`. `{n}` is filled in (with the
 * language's decimal separator). A missing form falls back to `other`, then to the English.
 */
export const tn: TnFunction = (n, one, other, values) => active.tn(n, one, other, values);

/** A number with the language's decimal separator and no thousands grouping: 12.5 → "12,5" in ru/fr/pt/es. */
export function formatNumber(n: number, decimals?: number, lang?: UiLang): string {
    return numberIn(lang ?? active.lang, n, decimals);
}

/**
 * A date from the tables, never Intl, in `opts.lang` or the current language. en reads exactly as the apps always
 * have: "3 Oct", "3 Oct 2026", "Sat 3 Oct", "Sat", "9:05" (24 h, hour unpadded).
 */
export function formatDate(d: Date, pattern: DatePattern, opts: DateOptions = {}): string {
    return dateIn(opts.lang ?? active.lang, d, pattern, opts);
}

/** "just now", "3 minutes ago", "2 hours ago", "5 days ago", in the current language. */
export function timeAgo(ms: number): string {
    return active.timeAgo(ms);
}
