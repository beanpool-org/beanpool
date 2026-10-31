/**
 * The tags a member types, as the node stores and copies them (DESIGN-tags-free-entry-fable.md §2, slice F1): tags/free-tags.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    FREE_TAGS_CHARS, FREE_TAGS_MAX, FREE_TAG_HIDDEN_CHARACTER, FREE_TAG_HOLDS_A_COMMA, FREE_TAG_MAX_CHARS, FREE_TAG_NOT_A_CONTACT,
    FREE_TAG_TOO_LONG, FREE_TAG_TOO_MANY_WORDS, FREE_TAG_TOO_SHORT, copiedFreeTags, freeTagRefusal, freeTagStored, freeTagsOf,
    storedFreeTags,
} from '../tags/free-tags.js';

describe('a free tag\'s stored form', () => {
    it('drops a leading #, lower-cases, keeps accents, holds one space between words', () => {
        expect(freeTagStored('#Limón')).toBe('limón');
        expect(freeTagStored('  ## Second   Hand\t\nLaptop ')).toBe('second hand laptop');
        expect(freeTagStored('＃Vintage')).toBe('vintage');
        expect(freeTagStored('a #b')).toBe('a #b');
        expect(freeTagStored('二手。笔记本')).toBe('二手。笔记本');
    });

    it('writes the same letters one way (NFC), so the same tag is one', () => {
        expect(freeTagStored('Limo\u0301n')).toBe('limón');
        expect(freeTagStored('Limo\u0301n')).toBe(freeTagStored('LIMÓN'));
    });

    it('replaces a lone surrogate, which SQLite would read back as three characters', () => {
        expect(freeTagStored('ab\ud83d')).toBe('ab�');
    });

    it('gives a stored tag back unchanged, so a copy holds the bytes its main server holds', () => {
        for (const text of ['#Limón', 'Limo\u0301n', 'İstanbul', 'ΟΔΟΣ ΑΣ', 'Straße', 'ﬁne', '  a   b ', '二手 笔记本', '#＃x y', 'ǅabc']) {
            const once = freeTagStored(text);
            expect(freeTagStored(once)).toBe(once);
        }
    });
});

describe('what a free tag may not be', () => {
    it('passes the shapes members type', () => {
        for (const tag of ['2nd hand', 'wi-fi router', 'Limón 🍋 fresco', '二手 笔记本', 'segunda mano', 'don\'t panic', '3.5mm jack', 'a.k.a', '24/7', '1/4 inch', '50/50', '120/240v',
            'г.москва', 'ดร.สมชาย', '二手。笔记本', 'iphone 15 pro', '1984', 'rtx4090 ti 2024', 'میوه\u200cفروشی', 'ab', '👩\u200d🌾 farmer', '❤\ufe0f vintage']) {
            expect(freeTagRefusal(tag), tag).toBeNull();
        }
    });

    it('refuses too short, and a tag with no two letters or numbers (an emoji is no search word)', () => {
        for (const tag of ['', ' ', '#', '##', 'a', '#a', '🍋', '🍋🍋🍋', '...', 'a🍋', '\u3164\u3164', '\uffa0\uffa0', '\u1160\u1160', '\u115f\u115f', 'a\u3164', '\u3164\u3164🍋']) expect(freeTagRefusal(tag), tag).toBe(FREE_TAG_TOO_SHORT);
    });

    it('refuses over 30 characters, an emoji counting as one', () => {
        expect(freeTagRefusal('x'.repeat(FREE_TAG_MAX_CHARS))).toBeNull();
        expect(freeTagRefusal('x'.repeat(FREE_TAG_MAX_CHARS + 1))).toBe(FREE_TAG_TOO_LONG);
        expect(freeTagRefusal(`ab${'🍋'.repeat(FREE_TAG_MAX_CHARS - 2)}`)).toBeNull();
    });

    it('refuses five words', () => {
        expect(freeTagRefusal('one two three four')).toBeNull();
        expect(freeTagRefusal('one two three four five')).toBe(FREE_TAG_TOO_MANY_WORDS);
    });

    it('refuses a contact in every shape, its full-width forms too', () => {
        for (const tag of ['@handle', 'me@example.com', 'hello @ you', 'a＠b', '0412 345 678', '0412345678', '+61 412 345 678', '(04) 1234 5678', '04-12-34-56-78',
            '04 12 34 56 78', '1234567', 'call 0412 345 678', '0412/345/678', '０４１２／３４５／６７８', '02/9876/543', '０４１２３４５６７８', '٠٤١٢٣٤٥٦٧٨', 'http://x', 'https://example.com/a', 'www.example.com', 'example.com',
            'bit.ly/abc', 't.me/someone', 'wa.me', 'ＥＸＡＭＰＬＥ．ＣＯＭ', 'example。com', 'example｡com', 'wa。me/chat', 't。me/someone', 'bit｡ly/abc', '0412。345。678', 'example.\u{1d402}\u{1d40e}\u{1d40c}', 'example.\u2102\u{1d546}\u{1d544}', 'example.\u{1f132}\u{1f13e}\u{1f13c}']) {
            expect(freeTagRefusal(tag), tag).toBe(FREE_TAG_NOT_A_CONTACT);
        }
    });

    it('reads every dash between the digits of a number as a dash, a minus sign among them', () => {
        const dashes = Array.from({ length: 0x10000 }, (_, unit) => String.fromCharCode(unit)).filter((unit) => /^\p{Pd}$/u.test(unit));
        for (const dash of [...dashes, '\u2212', '\u207b', '\u208b', '\u02d7', '\u2043', '\u2053', '\u2796', '\u30fc', '\uff70']) {
            expect(freeTagRefusal(`0412${dash}345${dash}678`), dash).toBe(FREE_TAG_NOT_A_CONTACT);
        }
        expect(freeTagRefusal('+61\u2212412\u2212345\u2212678')).toBe(FREE_TAG_NOT_A_CONTACT);
    });

    it('reads a contact past what shows as nothing, and keeps those characters in a tag that is none', () => {
        for (const tag of ['0412\u200c345678', '0412\u200d345\u200d678', 'example.\u200ccom', 'exam\u200dple.\u200dcom', 'ht\u200dtps:/\u200c/x', 'me\u200c@example',
            '0412\ufe0f345678', 'example.\ufe0fcom', '0412\u034f345678', 'example.\u034fcom', '0412\u3164345678', '0412\u17b4345678', 'example.\u180bcom', '0412\uffa0345678',
            '0412\u2800345678', '0412\u{e0100}345678', '0412\u{e0041}345678']) {
            expect(freeTagRefusal(tag), JSON.stringify(tag)).toBe(FREE_TAG_NOT_A_CONTACT);
        }
        expect(freeTagStored('میوه\u200cفروشی')).toBe('میوه\u200cفروشی');
    });

    it('refuses control and hidden characters', () => {
        for (const tag of ['ab\u0000cd', 'ab\u0007cd', 'ab\u007fcd', 'ab\u0085cd', 'ab\u00adcd', 'ab\u200bcd', 'ab\u202ecd', 'ab\u2066cd', 'ab\ufeffcd', 'example\ufeff.com', 'example.\ufeffcom', '0412\ufeff345678', '\ufefflimón']) {
            expect(freeTagRefusal(tag), JSON.stringify(tag)).toBe(FREE_TAG_HIDDEN_CHARACTER);
        }
    });

    it('refuses a comma, which `free=` and the pickers read as two tags', () => {
        expect(freeTagRefusal('wood, fire')).toBe(FREE_TAG_HOLDS_A_COMMA);
    });
});

describe('on an old Android engine, with no Unicode property escapes', () => {
    it('loads, and holds the rule by the fallbacks', async () => {
        // Every digit the real class finds in one UTF-16 unit, which is every one a fallback's class can hold.
        const units = Array.from({ length: 0x10000 }, (_, unit) => String.fromCharCode(unit));
        const digits = units.filter((unit) => /^\p{Nd}$/u.test(unit));
        const showNothing = units.filter((unit) => /^[\p{DI}\u2800]$/u.test(unit));
        const Real = RegExp;
        vi.stubGlobal('RegExp', class extends Real {
            constructor(source: string | RegExp, flags?: string) {
                if (String(source).includes('\\p{')) throw new SyntaxError('Invalid escape');
                super(source, flags);
            }
        });
        vi.resetModules();
        try {
            const old = await import('../tags/free-tags.js');
            expect(old.freeTagRefusal('🍋🍋🍋')).toBe(old.FREE_TAG_TOO_SHORT);
            expect(old.freeTagRefusal('a🍋')).toBe(old.FREE_TAG_TOO_SHORT);
            for (const tag of ['2nd hand', 'Limón 🍋 fresco', '二手 笔记本', 'яйца', 'ไข่ไก่']) expect(old.freeTagRefusal(tag), tag).toBeNull();
            expect(old.freeTagRefusal('0412 345 678')).toBe(old.FREE_TAG_NOT_A_CONTACT);
            expect(old.freeTagRefusal('０４１２３４５６７８')).toBe(old.FREE_TAG_NOT_A_CONTACT);
            for (const tag of ['٠٤١٢٣٤٥٦٧٨', '٠٤١٢ ٣٤٥ ٦٧٨', '۰۴۱۲-۳۴۵-۶۷۸', '०४१२ ३४५ ६७८', '๐๔๑๒.๓๔๕.๖๗๘']) {
                expect(old.freeTagRefusal(tag), tag).toBe(old.FREE_TAG_NOT_A_CONTACT);
            }
            expect(old.freeTagRefusal('0412/345/678')).toBe(old.FREE_TAG_NOT_A_CONTACT);
            expect(old.freeTagRefusal('0412\u2212345\u2212678')).toBe(old.FREE_TAG_NOT_A_CONTACT);
            for (const digit of digits) expect(old.freeTagRefusal(digit.repeat(7)), digit).toBe(old.FREE_TAG_NOT_A_CONTACT);
            for (const unit of showNothing) {
                expect([old.FREE_TAG_NOT_A_CONTACT, old.FREE_TAG_HIDDEN_CHARACTER], unit).toContain(old.freeTagRefusal(`0412${unit}345678`));
                expect([old.FREE_TAG_NOT_A_CONTACT, old.FREE_TAG_HIDDEN_CHARACTER], unit).toContain(old.freeTagRefusal(`example.${unit}com`));
            }
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
    });
});

describe('the column', () => {
    it('round-trips, \'\' for none', () => {
        const tags = ['2nd hand', 'say "hi"', 'back\\slash'];
        expect(freeTagsOf(storedFreeTags(tags))).toEqual(tags);
        expect(storedFreeTags([])).toBe('');
        expect(freeTagsOf('')).toEqual([]);
        expect(freeTagsOf(null)).toEqual([]);
        expect(freeTagsOf(undefined)).toEqual([]);
    });

    it('reads anything that is not a list of text as none', () => {
        for (const held of ['not json', '{"a":1}', '7', 'null']) expect(freeTagsOf(held), held).toEqual([]);
        expect(freeTagsOf('["ok",7,null]')).toEqual(['ok']);
    });
});

describe('a copy', () => {
    it('keeps what the rule passes, once each, in its order, five at most, and refuses nothing', () => {
        expect(copiedFreeTags(['#Two Words', 'two words', 'me@example.com', 7, 'x', 'c', 'dd', 'ee', 'ff', 'gg', 'hh']))
            .toEqual(['two words', 'dd', 'ee', 'ff', 'gg']);
    });

    it('holds its tags to the column\'s length', () => {
        const long = (letter: string) => `${letter}a${'🍋'.repeat(28)}`;
        const tags = copiedFreeTags(['a', 'b', 'c', 'd', 'e'].map(long));
        expect(tags.length).toBeLessThan(FREE_TAGS_MAX);
        expect(storedFreeTags(tags).length).toBeLessThanOrEqual(FREE_TAGS_CHARS);
        expect(tags.length).toBeGreaterThan(0);
    });

    it('reads what is not a list as none', () => {
        for (const raw of [undefined, null, 'a b', 7, {}]) expect(copiedFreeTags(raw)).toEqual([]);
    });

    it('gives what a node stored back unchanged', () => {
        const held = copiedFreeTags(['limón', '2nd hand', 'wi-fi router']);
        expect(copiedFreeTags(freeTagsOf(storedFreeTags(held)))).toEqual(held);
    });
});
