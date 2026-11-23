/**
 * Core's one list of what shows as nothing (shows-nothing.ts), read by a free tag's contact check and a person's name
 * (#3275 r3 decide: names lacked the Mongolian free variation selectors and the blank braille cell that free tags had, two
 * copies apart). It is Unicode's Default_Ignorable_Code_Point plus U+2800, checked against \p{DI} as Node knows it, code
 * point by code point, and it holds no property escape, which old Android engines throw on.
 */
import { describe, expect, it } from 'vitest';
import { SHOWS_NOTHING_CHARS } from '../shows-nothing.js';
import { cleanName } from '../name-line.js';
import { FREE_TAG_HIDDEN_CHARACTER, FREE_TAG_NOT_A_CONTACT, freeTagRefusal } from '../tags/free-tags.js';

const LIST = new RegExp(`^[${SHOWS_NOTHING_CHARS}]$`, 'u');
const BY_PROPERTY = /^[\p{DI}⠀]$/u;

function everyCodePoint(): string[] {
    const all: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) if (cp < 0xd800 || cp > 0xdfff) all.push(String.fromCodePoint(cp));
    return all;
}
const hex = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`;

describe('what shows as nothing: one list, Default_Ignorable_Code_Point and the blank braille cell', () => {
    it('holds exactly \\p{DI} and U+2800, every code point', () => {
        const differ = everyCodePoint().filter((ch) => LIST.test(ch) !== BY_PROPERTY.test(ch)).map(hex);
        expect(differ).toEqual([]);
    });

    it('is written out: no property escape, which an old Android engine throws on', () => {
        expect(SHOWS_NOTHING_CHARS).not.toMatch(/\\p\{/i);
        expect(() => new RegExp(`[${SHOWS_NOTHING_CHARS}]`, 'gu')).not.toThrow();
    });

    // The code points names lacked: each one rows on both readers.
    const ADDED: Array<[string, string]> = [
        ['U+180B', '᠋'], ['U+180C', '᠌'], ['U+180D', '᠍'], ['U+180F', '᠏'], ['U+2800', '⠀'],
        ['U+2065', '⁥'], ['U+FFF0', '￰'], ['U+E0000', '\u{E0000}'], ['U+E0080', '\u{E0080}'], ['U+E01F0', '\u{E01F0}'],
    ];
    it.each(ADDED)('%s: a name padded with it reads "Ana"; a free tag reads a contact past it', (_u, ch) => {
        expect(LIST.test(ch)).toBe(true);
        expect(cleanName(`${ch}Ana ${ch}`)).toBe('Ana');
        expect([FREE_TAG_NOT_A_CONTACT, FREE_TAG_HIDDEN_CHARACTER]).toContain(freeTagRefusal(`0412${ch}345678`));
        expect([FREE_TAG_NOT_A_CONTACT, FREE_TAG_HIDDEN_CHARACTER]).toContain(freeTagRefusal(`example.${ch}com`));
    });
});
