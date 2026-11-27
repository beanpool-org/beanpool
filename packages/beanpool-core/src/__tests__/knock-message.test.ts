import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { KNOCK_MESSAGE_MIN_CHARS, knockMessageChars, knockMessageText } from '../knock-message.js';
import { PLACE_CIRCLE_WORDS, circleKnockMessage } from '../place-circle.js';
import { LANGS, setLanguage, type Catalog, type UiLang } from '../words.js';

/** The node's own spelling (apps/server routes/knocks.ts CONTROL), which a Node test may use and an old phone may not. */
const NODE_CONTROL = /(?![\n\t])\p{Cc}/gu;
const nodeCount = (raw: string) => Array.from(raw.replace(NODE_CONTROL, '').trim()).length;

describe('the fewest characters an Ask to join message may have', () => {
    it('is 20 (Marty, 27 Nov 2026)', () => {
        expect(KNOCK_MESSAGE_MIN_CHARS).toBe(20);
    });

    // Lengths either side of the fewest and the most (280), in letters, accents, emoji and Chinese: a character is one
    // whatever its bytes, as the node's most is counted.
    const UNITS = ['x', 'é', '🌿', '鸡'];
    const LENGTHS = [0, 1, 19, 20, 280, 281];
    it.each(UNITS.flatMap(u => LENGTHS.map(n => [u, n] as const)))('%s × %i counts %i', (unit, n) => {
        const message = unit.repeat(n);
        expect(knockMessageChars(message)).toBe(n);
        expect(knockMessageChars(message)).toBe(nodeCount(message));
        expect(knockMessageChars(message) >= KNOCK_MESSAGE_MIN_CHARS).toBe(n >= 20);
    });

    it('spaces at the ends and control characters do not count; line breaks and tabs inside do', () => {
        expect(knockMessageChars(`   ${'a'.repeat(19)}   `)).toBe(19);
        expect(knockMessageChars(`${'a'.repeat(19)}\u0000\u0007\u001b\u007f\u0085`)).toBe(19);
        expect(knockMessageText(`\u0000 Hello,\tI live\nnearby. \u0007`)).toBe('Hello,\tI live\nnearby.');
        expect(knockMessageChars(`${'a'.repeat(9)}\n${'b'.repeat(10)}`)).toBe(20);
        // Nothing but control characters and spaces: empty, as the node reads it.
        expect(knockMessageChars('\u0000\u0001 \u0002')).toBe(0);
    });

    it('takes out exactly the characters the node takes out, every code point', () => {
        const differ: number[] = [];
        for (let cp = 0; cp <= 0x10ffff; cp++) {
            const ch = String.fromCodePoint(cp);
            const s = `a${ch}b`;
            if (knockMessageText(s) !== s.replace(NODE_CONTROL, '').trim()) differ.push(cp);
        }
        expect(differ).toEqual([]);
    });
});

describe('the place circle\'s request message is never too short to send', () => {
    afterEach(() => setLanguage('en'));

    const catalogDir = new URL('../../words/', import.meta.url);
    const langs = readdirSync(catalogDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
        .filter((l): l is UiLang => (LANGS as readonly string[]).includes(l));

    it('in English it is the sentence itself', () => {
        expect(circleKnockMessage()).toBe('I asked to be told when a community started here.');
    });

    it.each(langs)('%s: the translation when it is long enough, otherwise the English; never under the fewest', lang => {
        const catalog = JSON.parse(readFileSync(new URL(`${lang}.json`, catalogDir), 'utf8')) as Catalog;
        setLanguage(lang, [catalog]);
        const sent = circleKnockMessage();
        expect(knockMessageChars(sent)).toBeGreaterThanOrEqual(KNOCK_MESSAGE_MIN_CHARS);
        const translated = catalog[PLACE_CIRCLE_WORDS.knockMessage];
        if (typeof translated === 'string' && knockMessageChars(translated) >= KNOCK_MESSAGE_MIN_CHARS) expect(sent).toBe(translated);
        else expect(sent).toBe(PLACE_CIRCLE_WORDS.knockMessage);
    });

    it('the Chinese drafts are shorter than the fewest today, so they send the English', () => {
        const zh = JSON.parse(readFileSync(new URL('zh-Hans.json', catalogDir), 'utf8')) as Catalog;
        expect(knockMessageChars(String(zh[PLACE_CIRCLE_WORDS.knockMessage]))).toBeLessThan(KNOCK_MESSAGE_MIN_CHARS);
        setLanguage('zh-Hans', [zh]);
        expect(circleKnockMessage()).toBe(PLACE_CIRCLE_WORDS.knockMessage);
    });
});
