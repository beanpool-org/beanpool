/**
 * An amount a member types (Send Beans, a pledge, a sweep, a grant, a price, hours worked), read ONE way on the phone
 * and on the web (#2202). `parseFloat("12,5")` is 12, so a member whose language writes a decimal comma sent 12 Beans
 * for "12,5"; a bare `Number("12,5")` refused it as not a number.
 *
 * The rule never guesses: an input with one reading in every convention gives that number, and an input that could
 * mean two numbers is refused with a reason, never read as one of them.
 *
 *   - The language's own decimal mark ('.' or ',', and the Arabic '٫' where the language types Arabic-script digits) is
 *     always a decimal mark: fr "12,5" → 12.5, en "12.5" → 12.5, en "1.000" → 1 with three decimals.
 *   - The other mark is read as a decimal mark too (fr "12.5" → 12.5, en "12,50" → 12.5, as the pay-back form always
 *     read it), unless exactly three digits follow it: fr "1.000" and en "1,000" are a thousand in one convention and
 *     one in the other, so they are refused ('grouped').
 *   - Two marks ("1.000,5", "1,000.5", "1.2.3"), a space or apostrophe inside ("1 000"), a sign, an exponent, letters:
 *     refused. A minus is refused as 'negative'. A leading '+' and surrounding spaces are fine.
 *   - Digits: 0–9, and the digits the language's own keyboard types (Arabic-Indic, Persian, Bengali, Devanagari,
 *     Malayalam, Tamil; full-width in Chinese, Japanese and Korean). One digit system per amount.
 *   - Decimals are counted as typed: "12.500" has three. A money door takes cents (`maxDecimals` 2, the default).
 *
 * The guards stay where they are: this only turns the text into a number. Above 0, to the cent, within the balance:
 * each door checks those itself, as before (ledger-transaction-rules).
 */

import { isLang, t, tn, type Lang, type UiLang, currentLanguage } from './words.js';

export type AmountRefusal = 'empty' | 'not-a-number' | 'two-separators' | 'grouped' | 'negative' | 'too-many-decimals';

export type ParsedAmount = { ok: true; value: number } | { ok: false; refusal: AmountRefusal };

export interface AmountOptions {
    /** The most decimals the door takes: 2 (cents, the default) for money; Infinity where any decimals were taken before. */
    maxDecimals?: number;
}

/**
 * The languages that write a decimal comma (CLDR's, as words-dates/<lang>.ts carries it; the tests check this list
 * against every language's table). Here, not read from those tables: the web app's first chunk carries English's
 * table alone, and an amount must read the same before a language's table arrives as after.
 */
const DECIMAL_COMMA_LANGS: ReadonlySet<Lang> = new Set<Lang>(['es', 'pt', 'fr', 'id', 'ru', 'it', 'de', 'tr', 'uk', 'vi', 'el']);

/** The language's own decimal mark: ',' or '.'. A tag that is not a language reads English's. */
export function decimalMarkOf(lang: UiLang): ',' | '.' {
    return isLang(lang) && DECIMAL_COMMA_LANGS.has(lang) ? ',' : '.';
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const FULL_WIDTH = '０１２３４５６７８９';

/**
 * The digits a language's own keyboard types, where they are not 0–9: CLDR's native digits (the Arabic, Persian and
 * Urdu number pads, Bengali, Hindi, Malayalam, Tamil), and the full-width digits a Chinese, Japanese or Korean input
 * method types. Each glyph has one value, so reading it is not a guess.
 */
export const AMOUNT_DIGITS: Readonly<Partial<Record<Lang, string>>> = Object.freeze({
    ar: ARABIC_INDIC,
    fa: PERSIAN,
    ur: PERSIAN,
    bn: '০১২৩৪৫৬৭৮৯',
    hi: '०१२३४५६७८९',
    ml: '൦൧൨൩൪൫൬൭൮൯',
    ta: '௦௧௨௩௪௫௬௭௮௯',
    ja: FULL_WIDTH,
    ko: FULL_WIDTH,
    'zh-Hans': FULL_WIDTH,
    'zh-Hant': FULL_WIDTH,
});

/** The Arabic decimal separator, as the Arabic, Persian and Urdu number pads type it: only ever a decimal mark. */
const ARABIC_DECIMAL = '٫';
const ARABIC_DECIMAL_LANGS: ReadonlySet<Lang> = new Set<Lang>(['ar', 'fa', 'ur']);
/** Full-width '.' and ',' as a CJK input method types them: the same marks. */
const FULL_WIDTH_MARKS: Readonly<Record<string, string>> = { '．': '.', '，': ',' };

/** Marks that only ever group thousands: a space of any width, an apostrophe, the Arabic thousands separator. */
const GROUP_MARK = /[\s'’٬]/;
/** Invisible marks a right-to-left keyboard or a paste can leave in a number: direction marks, zero-width characters. */
const INVISIBLE = /[​-‏؜‪-‮⁦-⁩﻿]/g;

const refuse = (refusal: AmountRefusal): ParsedAmount => ({ ok: false, refusal });

/**
 * The amount in `text`, read in `lang` (the device's language when absent), or why it is refused. Never throws.
 * en "12.5" → 12.5 exactly as `parseFloat` read it; fr "12,5" → 12.5; fr "1.000" → refused ('grouped').
 */
export function parseAmount(text: string, lang?: UiLang, opts: AmountOptions = {}): ParsedAmount {
    const maxDecimals = opts.maxDecimals ?? 2;
    const l = lang ?? currentLanguage();
    const own = decimalMarkOf(l);
    const native = isLang(l) ? AMOUNT_DIGITS[l] : undefined;
    const arabicDecimal = isLang(l) && ARABIC_DECIMAL_LANGS.has(l);

    let s = (typeof text === 'string' ? text : '').replace(INVISIBLE, '').trim();
    if (s === '') return refuse('empty');
    let negative = false;
    if (s[0] === '-' || s[0] === '−') { negative = true; s = s.slice(1); } else if (s[0] === '+') s = s.slice(1);

    // To ASCII: the language's digits to 0–9, its marks to '.' and ','. Anything else stays, and is refused below.
    let body = '';
    let ascii = false;
    let nativeDigits = false;
    for (const ch of s) {
        if (ch >= '0' && ch <= '9') { ascii = true; body += ch; continue; }
        const d = native ? native.indexOf(ch) : -1;
        if (d >= 0) { nativeDigits = true; body += String(d); continue; }
        if (arabicDecimal && ch === ARABIC_DECIMAL) { body += own; continue; }
        if (native === FULL_WIDTH && FULL_WIDTH_MARKS[ch]) { body += FULL_WIDTH_MARKS[ch]; continue; }
        body += ch;
    }
    if (ascii && nativeDigits) return refuse('not-a-number');
    if (!/[0-9]/.test(body)) return refuse('not-a-number');

    if (GROUP_MARK.test(body)) return /^[0-9.,\s'’٬]+$/.test(body) ? refuse('grouped') : refuse('not-a-number');
    if (!/^[0-9.,]+$/.test(body)) return refuse('not-a-number');

    const marks = body.replace(/[0-9]/g, '');
    if (marks.length > 1) {
        if (marks.includes('.') && marks.includes(',')) return refuse('grouped');
        // "1.000.000", Indian "1,00,000": groups of two or three digits after the first are thousands; "1.2.3" is not.
        const groups = body.split(/[.,]/);
        return groups.slice(1).every((g) => g.length === 2 || g.length === 3) && groups[0].length > 0 ? refuse('grouped') : refuse('two-separators');
    }

    let whole = body;
    let fraction = '';
    if (marks.length === 1) {
        const at = body.indexOf(marks);
        whole = body.slice(0, at);
        fraction = body.slice(at + 1);
        // The other mark before three digits is a thousands separator in some convention: a thousand, or one.
        if (marks !== own && fraction.length === 3) return refuse('grouped');
        if (fraction.length > maxDecimals) return refuse('too-many-decimals');
    }
    const value = Number(fraction ? `${whole || '0'}.${fraction}` : whole);
    if (!Number.isFinite(value)) return refuse('not-a-number');
    if (negative) return refuse('negative');
    return { ok: true, value };
}

/**
 * The sentence a refusal shows, in the device's language, with its example in the language's own way of writing a
 * number ("like 12,5" in French). `maxDecimals` as the door's parseAmount had it.
 */
export function amountRefusalWords(refusal: AmountRefusal, maxDecimals = 2): string {
    switch (refusal) {
        case 'empty': return t('Type an amount.');
        case 'negative': return t('The amount can’t be below 0.');
        case 'grouped': return t('Type the amount without thousands separators, like {example}.', { example: 1000.5 });
        case 'two-separators': return t('Type one decimal mark at most, like {example}.', { example: 12.5 });
        case 'too-many-decimals': return tn(maxDecimals, 'Type at most {n} decimal, like {example}.', 'Type at most {n} decimals, like {example}.', { example: 12.5 });
        default: return t('Type the amount as a number, like {example}.', { example: 12.5 });
    }
}
