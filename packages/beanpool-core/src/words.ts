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
 *
 * Whole sentences only: never `t('You have') + n + t('messages')` (`words:check` refuses a fragment).
 *
 * Dates, numbers and relative times come from the tables below, not from `Intl`: the phone avoids `Intl` on purpose
 * (Hermes implements it only partly) and the 320 px tests need the same text on every runtime. The month and day names
 * of ru/fr/pt/es are CLDR's, checked against Node's ICU by __tests__/words.test.ts.
 *
 * Never route a recovery word through `t()`: the 12 words stay English in every language, because the account key is
 * sha256(sha256(the words)) over the English strings (recovery-words-seed.ts; the invariant test in words.test.ts).
 *
 * Pure and universal: no Node built-ins, no Intl, no React; the phone, the web app and the server load the same module.
 */

export type Lang = 'en' | 'ru' | 'fr' | 'pt' | 'es';
/** The five languages, in the order the language picker lists them. */
export const LANGS: readonly Lang[] = Object.freeze(['en', 'ru', 'fr', 'pt', 'es'] as const);

/**
 * The pseudo-locale: every sentence accented and padded about 35 %, in brackets. Not a language anyone picks; the
 * 320 px render tests run in it so clipped text fails, and any text WITHOUT the brackets bypassed `t()`.
 */
export const PSEUDO_LANG = 'xx' as const;
export type UiLang = Lang | typeof PSEUDO_LANG;

/** The request header that carries the device's language to a node (two letters; never logged, never stored). */
export const LANGUAGE_HEADER = 'X-Language';

export type PluralCategory = 'one' | 'few' | 'many' | 'other';
export type PluralForms = Partial<Record<PluralCategory, string>>;
/** One package's words in one language: `{ "<english>": "<translation>" }`, plurals as `{ "<one>|<other>": { one, few, … } }`. */
export type Catalog = Readonly<Record<string, unknown>>;

/** The plural forms each language's catalog entry must carry (`many` is optional in fr/pt/es: only round millions use it). */
export const PLURAL_FORMS: Readonly<Record<Lang, readonly PluralCategory[]>> = Object.freeze({
    en: ['one', 'other'],
    ru: ['one', 'few', 'many', 'other'],
    fr: ['one', 'other'],
    pt: ['one', 'other'],
    es: ['one', 'other'],
});

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

/** A device or browser language tag to one of the five: `ru-RU` → ru, `pt-BR` and `pt-PT` → pt; anything else → null. */
export function normaliseLang(tag: string | null | undefined): Lang | null {
    if (typeof tag !== 'string') return null;
    const base = tag.trim().toLowerCase().split(/[-_]/)[0];
    return (LANGS as readonly string[]).includes(base) ? (base as Lang) : null;
}

// ── Plural rules (CLDR, the five languages; checked against Intl.PluralRules in the tests) ─────────────────────────

/** CLDR's operands for a number as written in decimal: i = integer digits, v = count of visible fraction digits. */
function operands(n: number): { i: number; v: number; f: number } {
    const abs = Math.abs(n);
    const s = String(abs);
    if (!/^\d+(\.\d+)?$/.test(s)) return { i: Math.floor(abs), v: 0, f: 0 };
    const [int, frac = ''] = s.split('.');
    return { i: Number(int), v: frac.length, f: frac ? Number(frac) : 0 };
}

export function pluralCategory(lang: UiLang, n: number): PluralCategory {
    if (!Number.isFinite(n)) return 'other';
    const { i, v } = operands(n);
    // fr/pt/es: a round million (1 000 000, 2 000 000 …) takes `many` ("1 million de haricots").
    const roundMillion = v === 0 && i !== 0 && i % 1_000_000 === 0;
    switch (lang) {
        case 'ru': {
            if (v !== 0) return 'other';
            const m10 = i % 10;
            const m100 = i % 100;
            if (m10 === 1 && m100 !== 11) return 'one';
            if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'few';
            return 'many';
        }
        case 'fr':
            if (i === 0 || i === 1) return 'one';
            return roundMillion ? 'many' : 'other';
        case 'pt':
            if (i === 0 || i === 1) return 'one';
            return roundMillion ? 'many' : 'other';
        case 'es':
            if (Math.abs(n) === 1) return 'one';
            return roundMillion ? 'many' : 'other';
        default:
            return i === 1 && v === 0 ? 'one' : 'other';
    }
}

// ── Dates and numbers ──────────────────────────────────────────────────────────────────────────────────────────

export interface DateWords {
    /** Month names as they read inside a date ("15 октября"): CLDR's `format` context, wide. */
    monthsLong: readonly string[];
    /** The same, abbreviated ("15 окт."). */
    monthsShort: readonly string[];
    /** A month named on its own (a heading: "Октябрь"): CLDR's `stand-alone` context, wide. */
    monthsStandalone: readonly string[];
    /** Sunday first, like Date#getDay. */
    daysShort: readonly string[];
    daysLong: readonly string[];
    /** The decimal separator. Amounts never group thousands (`1.000` reads as one in es/pt). */
    decimal: string;
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const DATE_WORDS: Readonly<Record<Lang, DateWords>> = Object.freeze({
    en: {
        monthsLong: EN_MONTHS,
        // Ours, not CLDR's en-GB ("Sept"): the apps have always printed three letters.
        monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        monthsStandalone: EN_MONTHS,
        daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        daysLong: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        decimal: '.',
    },
    ru: {
        monthsLong: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
        monthsShort: ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'],
        monthsStandalone: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
        daysShort: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
        daysLong: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
        decimal: ',',
    },
    fr: {
        monthsLong: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
        monthsShort: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
        monthsStandalone: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
        daysShort: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
        daysLong: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
        decimal: ',',
    },
    pt: {
        monthsLong: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
        monthsShort: ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'],
        monthsStandalone: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
        daysShort: ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'],
        daysLong: ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'],
        decimal: ',',
    },
    es: {
        monthsLong: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
        monthsShort: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'],
        monthsStandalone: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
        daysShort: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
        daysLong: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
        decimal: ',',
    },
});

export type DatePattern = 'day-month' | 'day-month-year' | 'weekday-day-month' | 'weekday' | 'time';

export interface DateOptions {
    /** 'short' (default): "3 Oct", "Sat"; 'long': "3 October", "Saturday". */
    width?: 'short' | 'long';
    /** Read the date in UTC rather than the device's own time (dates the node already fixed to a calendar day). */
    utc?: boolean;
}

// ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────

let current: UiLang = 'en';
let table: Map<string, string | PluralForms> = new Map();

/**
 * Switch the language: the app passes its own catalogs and core's for that language. `en` needs none (the key is
 * the English). Live: the next `t()` reads the new table; the app's provider re-renders.
 */
export function setLanguage(lang: UiLang, catalogs: readonly Catalog[] = []): void {
    const next = new Map<string, string | PluralForms>();
    if (lang !== 'en' && lang !== PSEUDO_LANG) {
        for (const catalog of catalogs) {
            for (const [key, value] of Object.entries(catalog ?? {})) {
                if (key === '_meta') continue;
                if (typeof value === 'string' && value.length > 0) next.set(key, value);
                else if (value && typeof value === 'object') next.set(key, value as PluralForms);
            }
        }
    }
    current = lang;
    table = next;
}

export function currentLanguage(): UiLang {
    return current;
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

function interpolate(sentence: string, values?: WordValues): string {
    if (!values) return sentence;
    return sentence.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
        if (!Object.prototype.hasOwnProperty.call(values, name)) return whole;
        const v = values[name];
        return typeof v === 'number' ? formatNumber(v) : String(v);
    });
}

/** One sentence in the current language; the English (the key) when there is no translation. */
export function t(source: string, values?: WordValues, context?: string): string {
    if (current === PSEUDO_LANG) return interpolate(pseudoLocalise(source), values);
    if (current === 'en') return interpolate(source, values);
    const hit = table.get(wordKey(source, context));
    return interpolate(typeof hit === 'string' ? hit : source, values);
}

/**
 * A sentence with a count in it: `tn(n, '{n} new message', '{n} new messages')`. `{n}` is filled in (with the
 * language's decimal separator). A missing form falls back to `other`, then to the English.
 */
export function tn(n: number, one: string, other: string, values?: WordValues): string {
    const all: WordValues = { n, ...values };
    const englishPick = pluralCategory('en', n) === 'one' ? one : other;
    if (current === PSEUDO_LANG) return interpolate(pseudoLocalise(englishPick), all);
    if (current === 'en') return interpolate(englishPick, all);
    const hit = table.get(pluralKey(one, other));
    if (hit && typeof hit === 'object') {
        const forms = hit as PluralForms;
        const chosen = forms[pluralCategory(current, n)] ?? forms.other;
        if (typeof chosen === 'string' && chosen.length > 0) return interpolate(chosen, all);
    }
    return interpolate(englishPick, all);
}

// ── Formatting ─────────────────────────────────────────────────────────────────────────────────────────────────

function dateLang(): Lang {
    return current === PSEUDO_LANG ? 'en' : current;
}

/** A number with the language's decimal separator and no thousands grouping: 12.5 → "12,5" in ru/fr/pt/es. */
export function formatNumber(n: number, decimals?: number): string {
    if (!Number.isFinite(n)) return String(n);
    const text = decimals === undefined ? String(n) : n.toFixed(decimals);
    const sep = DATE_WORDS[dateLang()].decimal;
    return sep === '.' ? text : text.replace('.', sep);
}

/**
 * A date from the tables, never Intl. en reads exactly as the apps always have: "3 Oct", "3 Oct 2026",
 * "Sat 3 Oct", "Sat", "9:05" (24 h, hour unpadded).
 */
export function formatDate(d: Date, pattern: DatePattern, opts: DateOptions = {}): string {
    const lang = dateLang();
    const w = DATE_WORDS[lang];
    const long = opts.width === 'long';
    const utc = opts.utc === true;
    const day = utc ? d.getUTCDate() : d.getDate();
    const month = utc ? d.getUTCMonth() : d.getMonth();
    const year = utc ? d.getUTCFullYear() : d.getFullYear();
    const weekday = utc ? d.getUTCDay() : d.getDay();
    const hours = utc ? d.getUTCHours() : d.getHours();
    const minutes = utc ? d.getUTCMinutes() : d.getMinutes();
    const M = (long ? w.monthsLong : w.monthsShort)[month];
    const W = (long ? w.daysLong : w.daysShort)[weekday];
    // pt always says "de"; es only in the long form ("3 de octubre", but "3 oct").
    const de = lang === 'pt' || (lang === 'es' && long) ? ' de' : '';

    switch (pattern) {
        case 'time': {
            const mm = String(minutes).padStart(2, '0');
            return lang === 'en' ? `${hours}:${mm}` : `${String(hours).padStart(2, '0')}:${mm}`;
        }
        case 'weekday':
            return W;
        case 'day-month':
            return `${day}${de} ${M}`;
        case 'day-month-year':
            if (lang === 'ru') return `${day} ${M} ${year} г.`;
            return `${day}${de} ${M}${de} ${year}`;
        case 'weekday-day-month':
            if (lang === 'en' || lang === 'fr') return `${W} ${day} ${M}`;
            return `${W}, ${day}${de} ${M}`;
    }
}

/** "just now", "3 minutes ago", "2 hours ago", "5 days ago": from a duration in milliseconds. */
export function timeAgo(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return t('just now');
    const min = Math.floor(s / 60);
    if (min < 60) return tn(min, '{n} minute ago', '{n} minutes ago');
    const h = Math.floor(min / 60);
    if (h < 24) return tn(h, '{n} hour ago', '{n} hours ago');
    const days = Math.floor(h / 24);
    return tn(days, '{n} day ago', '{n} days ago');
}
