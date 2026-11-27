/**
 * utils/unbreakable.ts: People's sub-tab names drawn with no place to break them (Marty, 28 Nov 2026, Android 1.4.8: the
 * unselected middle tab read "🏘️" alone, its word cut). Every name the sub-nav can draw, in all 25 languages, comes out with
 * no ordinary space, the emoji joined to its words, and nothing else changed.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unbreakable } from '../unbreakable';

const NATIVE_WORDS = path.resolve(__dirname, '../../words');
const NAMES = ['👫 Friends', '🏘️ Community', '🎟️ Invites', '🎟️ Register'];
const COUNT = '🎟️ Invites ({n})';

/** Every sub-nav name in one language: the three panes, Register, and each plural form of Invites with its count. */
function namesIn(lang: string): string[] {
    if (lang === 'en') return [...NAMES, COUNT.replace('{n}', '3')];
    const catalog: Record<string, string | Record<string, string>> = JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, `${lang}.json`), 'utf8'));
    const counts = Object.values(catalog[`${COUNT}|${COUNT}`] as Record<string, string>).map((s) => s.replace('{n}', '3'));
    return [...NAMES.map((k) => catalog[k] as string), ...counts];
}

describe('unbreakable: a one-line label with no place to break it', () => {
    it('makes every ordinary space a no-break space and leaves the rest as it was', () => {
        expect(unbreakable('🏘️ Community')).toBe('🏘️ Community');
        expect(unbreakable('🎟️ Invites (3)')).toBe('🎟️ Invites (3)');
        expect(unbreakable('Community')).toBe('Community');
        expect(unbreakable('')).toBe('');
        // A zero-width non-joiner shapes a Persian word and is no break: it stays.
        expect(unbreakable('🎟️ دعوت‌ها')).toBe('🎟️ دعوت‌ها');
    });

    it('every People sub-nav name, in all 25 languages: no ordinary space, the emoji joined to its words, the same words', () => {
        const languages = ['en', ...fs.readdirSync(NATIVE_WORDS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))];
        expect(languages.length).toBe(25);
        let checked = 0;
        for (const lang of languages) {
            for (const name of namesIn(lang)) {
                const where = `${lang} ${JSON.stringify(name)}`;
                expect(typeof name, where).toBe('string');
                const drawn = unbreakable(name);
                expect(drawn, where).not.toMatch(/ /);
                expect(drawn, where).toMatch(/^\p{Extended_Pictographic}️? \S/u);
                // Only the spaces changed: same length, and back to the catalog's words when the no-break spaces are undone.
                expect(drawn.length, where).toBe(name.length);
                expect(drawn.replace(/ /g, ' '), where).toBe(name);
                checked += 1;
            }
        }
        // 25 languages × (4 names + at least one count form).
        expect(checked).toBeGreaterThanOrEqual(25 * 5);
    });
});
