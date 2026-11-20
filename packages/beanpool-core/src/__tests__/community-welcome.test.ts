import { describe, expect, it } from 'vitest';
import {
    cleanCommunityWelcome, isKeptCommunityWelcome, welcomeLineBreaks, COMMUNITY_WELCOME_MAX_CHARS, COMMUNITY_WELCOME_MAX_LINE_BREAKS,
} from '../community-welcome';

describe('the community welcome (onboarding design §4.5, slice S6)', () => {
    it('holds the decided limits: 280 characters, three line breaks', () => {
        expect(COMMUNITY_WELCOME_MAX_CHARS).toBe(280);
        expect(COMMUNITY_WELCOME_MAX_LINE_BREAKS).toBe(3);
    });

    // One table: what the owner sends, and what is kept or why it is refused.
    const a = (n: number) => 'a'.repeat(n);
    const cases: Array<[string, unknown, { text: string } | { problem: string }]> = [
        ['nothing sent clears it', null, { text: '' }],
        ['spaces only clear it', '   \n  ', { text: '' }],
        ['plain text is kept as written', "G'day and welcome. Market day is Saturday.", { text: "G'day and welcome. Market day is Saturday." }],
        ['the ends are trimmed', '  Hello  \n', { text: 'Hello' }],
        ['280 characters are kept', a(280), { text: a(280) }],
        ['281 characters are refused', a(281), { problem: 'too_long' }],
        ['spaces around 280 characters are trimmed, not counted', ` ${a(280)} `, { text: a(280) }],
        ['an emoji counts as its two UTF-16 units, as maxLength does', '🌱'.repeat(140), { text: '🌱'.repeat(140) }],
        ['141 emoji are 282 units: refused', '🌱'.repeat(141), { problem: 'too_long' }],
        ['three line breaks (four lines) are kept', 'one\ntwo\nthree\nfour', { text: 'one\ntwo\nthree\nfour' }],
        ['four line breaks are refused', 'one\ntwo\nthree\nfour\nfive', { problem: 'too_many_lines' }],
        ['blank lines count', 'one\n\n\n\nfive', { problem: 'too_many_lines' }],
        ['a Windows line end is one break', 'one\r\ntwo', { text: 'one\ntwo' }],
        ['an old Mac line end is one break', 'one\rtwo', { text: 'one\ntwo' }],
        ['a line separator is a break, and counts', 'one\u2028two\u2029three\nfour\nfive', { problem: 'too_many_lines' }],
        ['a tab becomes a space', 'one\ttwo', { text: 'one two' }],
        ["Android's bidi isolates are dropped", '\u2068مرحبا\u2069 welcome', { text: 'مرحبا welcome' }],
        ['a NUL is refused', 'one\u0000two', { problem: 'control_character' }],
        ['a bell is refused', 'one\u0007two', { problem: 'control_character' }],
        ['an escape is refused', 'one\u001b[31mtwo', { problem: 'control_character' }],
        ['a vertical tab is refused', 'one\u000btwo', { problem: 'control_character' }],
        ['DEL is refused', 'one\u007ftwo', { problem: 'control_character' }],
        ['a C1 next-line is refused', 'one\u0085two', { problem: 'control_character' }],
        ['a number is not text', 42, { problem: 'not_text' }],
        ['an object is not text', { text: 'hi' }, { problem: 'not_text' }],
        ['links stay plain text', 'See https://riverside.example/hall', { text: 'See https://riverside.example/hall' }],
    ];
    it.each(cases)('%s', (_name, raw, want) => {
        const got = cleanCommunityWelcome(raw);
        if ('text' in want) expect(got).toEqual({ ok: true, text: want.text });
        else expect(got).toEqual({ ok: false, problem: want.problem });
    });

    it('counts line breaks', () => {
        expect(welcomeLineBreaks('')).toBe(0);
        expect(welcomeLineBreaks('a\nb\n\nc')).toBe(3);
    });

    it('a kept welcome is one cleaning leaves as it is, never empty', () => {
        expect(isKeptCommunityWelcome('Welcome!\nSay hello.')).toBe(true);
        expect(isKeptCommunityWelcome('')).toBe(false);
        expect(isKeptCommunityWelcome(' Welcome')).toBe(false);
        expect(isKeptCommunityWelcome('one\r\ntwo')).toBe(false);
        expect(isKeptCommunityWelcome(a(281))).toBe(false);
        expect(isKeptCommunityWelcome('a\nb\nc\nd\ne')).toBe(false);
        expect(isKeptCommunityWelcome('bad\u0000')).toBe(false);
        expect(isKeptCommunityWelcome(null)).toBe(false);
        expect(isKeptCommunityWelcome(7)).toBe(false);
    });
});
