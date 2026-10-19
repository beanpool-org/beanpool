/**
 * An amount a member types, read one way (#2202): the language's decimal mark and digits, and a refusal (never a
 * guess) for anything that could mean two numbers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseAmount, amountRefusalWords, decimalMarkOf, AMOUNT_DIGITS, type AmountRefusal } from '../amount-input';
import { DATE_WORDS, LANGS, formatNumber, setLanguage, type Lang } from '../words';

const value = (text: string, lang: Lang | 'xx', maxDecimals?: number) => {
    const r = parseAmount(text, lang, maxDecimals === undefined ? {} : { maxDecimals });
    return r.ok ? r.value : r.refusal;
};

afterEach(() => setLanguage('en'));

describe("each language's decimal mark", () => {
    it.each(LANGS)('%s: its own mark is CLDR\'s, and "12<mark>5" and "12.5" are both 12.5', (lang) => {
        const mark = DATE_WORDS[lang]!.decimal;
        expect(decimalMarkOf(lang)).toBe(mark);
        expect(value(`12${mark}5`, lang)).toBe(12.5);
        expect(value('12.5', lang)).toBe(12.5);
        expect(value('12', lang)).toBe(12);
        expect(value(`0${mark}05`, lang)).toBe(0.05);
    });

    it('the decimal-comma languages are exactly the ones the issue names, and the rest', () => {
        expect(LANGS.filter((l) => decimalMarkOf(l) === ',').sort()).toEqual(['de', 'el', 'es', 'fr', 'id', 'it', 'pt', 'ru', 'tr', 'uk', 'vi']);
    });

    it('fr "12,5" is 12.5, not the 12 parseFloat reads', () => {
        expect(parseFloat('12,5')).toBe(12);
        expect(parseAmount('12,5', 'fr')).toEqual({ ok: true, value: 12.5 });
        expect(parseAmount('12.5', 'fr')).toEqual({ ok: true, value: 12.5 });
        expect(parseAmount('12,50', 'de')).toEqual({ ok: true, value: 12.5 });
    });

    it('the device language when none is given', () => {
        setLanguage('fr');
        expect(parseAmount('12,5')).toEqual({ ok: true, value: 12.5 });
        expect(parseAmount('1.000')).toEqual({ ok: false, refusal: 'grouped' });
        setLanguage('en');
        expect(parseAmount('1.000')).toEqual({ ok: false, refusal: 'too-many-decimals' });
    });

    it('a tag that is not a language (the pseudo-locale, a stale "he") reads as English, never a throw', () => {
        expect(value('12.5', 'xx')).toBe(12.5);
        expect(value('1,000', 'xx')).toBe('grouped');
        expect(value('12.5', 'he' as Lang)).toBe(12.5);
    });
});

describe('en reads exactly as before', () => {
    it('every amount to the cent from 0 to 300, as typed in English, is what parseFloat read', () => {
        for (let cents = 0; cents <= 30000; cents++) {
            for (const typed of [String(cents / 100), (cents / 100).toFixed(2), (cents / 100).toFixed(1)]) {
                expect(parseAmount(typed, 'en')).toEqual({ ok: true, value: parseFloat(typed) });
            }
        }
    });

    it('the shapes parseFloat took that have one reading: ".5", "5.", "+5", "007", spaces round it', () => {
        for (const typed of ['.5', '5.', '+5', '007', ' 12.5 ', '\t12.5\n', '1234567.89']) {
            expect(parseAmount(typed, 'en')).toEqual({ ok: true, value: parseFloat(typed) });
        }
    });

    it('"12,50" in English is 12.5, as the pay-back form always read it; "1,000" is refused, where parseFloat read 1', () => {
        expect(value('12,50', 'en')).toBe(12.5);
        expect(value('12,5', 'en')).toBe(12.5);
        expect(parseFloat('1,000')).toBe(1);
        expect(value('1,000', 'en')).toBe('grouped');
    });
});

describe('what is shown is what is read', () => {
    it.each(LANGS)('%s: an amount written the language\'s way (formatNumber) reads back as the same amount', (lang) => {
        for (let cents = 1; cents <= 5000; cents += 7) {
            const amount = cents / 100;
            expect(value(formatNumber(amount, 2, lang), lang)).toBe(amount);
            expect(value(formatNumber(amount, undefined, lang), lang)).toBe(amount);
        }
    });
});

describe("the language's digits", () => {
    it('en: 0–9 only; another script\'s digits are not a number', () => {
        expect(value('12.5', 'en')).toBe(12.5);
        expect(value('١٢٫٥', 'en')).toBe('not-a-number');
        expect(value('১২.৫', 'en')).toBe('not-a-number');
    });

    it('fr: 0–9 only', () => {
        expect(value('12,5', 'fr')).toBe(12.5);
        expect(value('١٢,٥', 'fr')).toBe('not-a-number');
    });

    it('ar: Arabic-Indic digits and the Arabic decimal separator, or 0–9; never a mix', () => {
        expect(value('١٢٫٥', 'ar')).toBe(12.5);
        expect(value('١٢.٥', 'ar')).toBe(12.5);
        expect(value('١٢', 'ar')).toBe(12);
        expect(value('12.5', 'ar')).toBe(12.5);
        expect(value('12٫5', 'ar')).toBe(12.5);
        expect(value('١2', 'ar')).toBe('not-a-number');
        expect(value('١٬٠٠٠', 'ar')).toBe('grouped');
        expect(value('١٫٠٠٠', 'ar')).toBe('too-many-decimals');
    });

    it('fa and ur: Persian digits; bn, hi, ml, ta: their own; zh, ja, ko: full-width', () => {
        expect(value('۱۲٫۵', 'fa')).toBe(12.5);
        expect(value('۱۲.۵', 'ur')).toBe(12.5);
        expect(value('১২.৫', 'bn')).toBe(12.5);
        expect(value('१२.५', 'hi')).toBe(12.5);
        expect(value('൧൨.൫', 'ml')).toBe(12.5);
        expect(value('௧௨.௫', 'ta')).toBe(12.5);
        expect(value('１２．５', 'ja')).toBe(12.5);
        expect(value('１２．５', 'zh-Hans')).toBe(12.5);
        expect(value('１２，５０', 'ko')).toBe(12.5);
        expect(value('১২.৫', 'fa')).toBe('not-a-number');
    });

    it("each language's digits are its CLDR numbering system's, 0 to 9 in order (Node's ICU)", () => {
        const systems: Partial<Record<Lang, string>> = {
            ar: 'arab', fa: 'arabext', ur: 'arabext', bn: 'beng', hi: 'deva', ml: 'mlym', ta: 'tamldec',
            ja: 'fullwide', ko: 'fullwide', 'zh-Hans': 'fullwide', 'zh-Hant': 'fullwide',
        };
        expect(Object.keys(AMOUNT_DIGITS).sort()).toEqual(Object.keys(systems).sort());
        for (const [lang, system] of Object.entries(systems) as [Lang, string][]) {
            const icu = Array.from({ length: 10 }, (_, d) => new Intl.NumberFormat('en', { numberingSystem: system, useGrouping: false }).format(d)).join('');
            expect(AMOUNT_DIGITS[lang], lang).toBe(icu);
        }
    });

    it('a language that writes its own digits on screen (DateWords.digits) reads them back', () => {
        for (const lang of LANGS) {
            const digits = DATE_WORDS[lang]!.digits;
            if (digits) expect(AMOUNT_DIGITS[lang], lang).toBe(digits);
        }
    });
});

describe('refused, never guessed', () => {
    const cases: Array<[AmountRefusal, Lang, string[]]> = [
        ['empty', 'en', ['', '   ', '‏', ' ']],
        ['empty', 'fr', ['', ' ']],
        ['not-a-number', 'en', ['abc', '12abc', '1e3', '0x10', '.', ',', '+', '-', 'Infinity', 'NaN', '12-5', '$12', '12B', '1/2', '+-5']],
        ['not-a-number', 'fr', ['douze', '12,5€', '1e3']],
        ['two-separators', 'en', ['1.2.3', '12..5', '1,2,3']],
        ['two-separators', 'fr', ['1,2,3', '12,,5']],
        ['grouped', 'fr', ['1.000,5', '1,000.5', '1 000', '1 000,5', '1 000', '1.000', '12.500', '1.000.000', "1'000"]],
        ['grouped', 'de', ['1.000', '1.000,50', '10.000']],
        ['grouped', 'en', ['1,000', '1,000.5', '1.000,5', '1,000,000', '12 500']],
        ['grouped', 'hi', ['1,00,000', '1,000']],
        ['negative', 'en', ['-5', '−5', '-0', '-12.5']],
        ['negative', 'fr', ['-12,5', '−12,5']],
        ['too-many-decimals', 'en', ['12.345', '1.000', '12.500', '0.001', '1,2345']],
        ['too-many-decimals', 'fr', ['12,345', '1,000', '1.2345']],
    ];
    it.each(cases)('%s in %s', (refusal, lang, inputs) => {
        for (const typed of inputs) expect([typed, value(typed, lang)]).toEqual([typed, refusal]);
    });

    it('a door that takes any decimals (hours, a price) still refuses what could be a thousand', () => {
        expect(value('1.333', 'en', Infinity)).toBe(1.333);
        expect(value('1,333', 'fr', Infinity)).toBe(1.333);
        expect(value('1.000', 'en', Infinity)).toBe(1);
        expect(value('1.333', 'fr', Infinity)).toBe('grouped');
        expect(value('1,333', 'en', Infinity)).toBe('grouped');
        expect(value('2,5', 'en', Infinity)).toBe(2.5);
    });

    it('never throws, whatever it is given', () => {
        for (const odd of [undefined, null, 12, {}, '\uD800', '9'.repeat(400)] as unknown as string[]) {
            expect(() => parseAmount(odd, 'en')).not.toThrow();
        }
        expect(value('9'.repeat(400), 'en')).toBe('not-a-number');
    });
});

describe('the sentence a refusal shows', () => {
    it('one for each reason, in English', () => {
        expect(amountRefusalWords('empty')).toBe('Type an amount.');
        expect(amountRefusalWords('not-a-number')).toBe('Type the amount as a number, like 12.5.');
        expect(amountRefusalWords('two-separators')).toBe('Type one decimal mark at most, like 12.5.');
        expect(amountRefusalWords('grouped')).toBe('Type the amount without thousands separators, like 1000.5.');
        expect(amountRefusalWords('negative')).toBe('The amount can’t be below 0.');
        expect(amountRefusalWords('too-many-decimals')).toBe('Type at most 2 decimals, like 12.5.');
    });

    it("the example is written the language's way: fr \"1000,5\"", () => {
        setLanguage('fr');
        expect(amountRefusalWords('grouped')).toContain('1000,5');
        expect(amountRefusalWords('not-a-number')).toContain('12,5');
    });
});
