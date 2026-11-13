/**
 * The Community list's sorts, shared by the phone and the web app (member-sort.ts): the phone's five, in its order, with
 * its words, so one catalog entry (core's) serves both apps.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, MEMBER_SORTS, MEMBER_SORT_WORDS, wordKey } from '../index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const catalog = (dir: string, lang: string): Record<string, unknown> | null => {
    const file = path.join(repo, dir, `${lang}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};
const translated = LANGS.filter((l) => l !== 'en');

describe('member sorts', () => {
    it('are the phone’s five, Newest first, in its order', () => {
        expect(MEMBER_SORTS).toEqual(['newest', 'name', 'friends', 'trusted', 'active']);
    });

    it('carry the phone’s words, each with the "member sort" context', () => {
        expect(MEMBER_SORT_WORDS).toEqual({
            newest: wordKey('Newest', 'member sort'),
            name: wordKey('Name', 'member sort'),
            friends: wordKey('Friends', 'member sort'),
            trusted: wordKey('Trusted', 'member sort'),
            active: wordKey('Active', 'member sort'),
        });
    });

    it('are translated in core’s catalog for every language, and neither app keeps a copy (core’s would win: it never shows)', () => {
        expect(translated.length).toBeGreaterThan(0);
        for (const lang of translated) {
            const core = catalog('packages/beanpool-core/words', lang);
            for (const key of Object.values(MEMBER_SORT_WORDS)) {
                expect(typeof core?.[key], `${lang}: ${JSON.stringify(key)}`).toBe('string');
                expect(catalog('apps/native/words', lang)?.[key], `phone ${lang}`).toBeUndefined();
                expect(catalog('apps/pwa/words', lang)?.[key], `web ${lang}`).toBeUndefined();
            }
        }
    });
});
