/**
 * "Reports cleared your message requests" in the member's language (requests-cleared-words.ts, #2710's open end): the
 * refusal and the notice are one sentence, in all 24 languages beside English, and a translation keeps the date.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LANGS, setLanguage, type Catalog, type Lang } from '../words.js';
import { REQUESTS_CLEARED_KIND, requestsClearedNotice, requestsClearedSentence, requestsClearedTitle, requestsLimitedWords } from '../requests-cleared-words.js';

const WORDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'words');
const catalogOf = (lang: Lang): Catalog => JSON.parse(fs.readFileSync(path.join(WORDS_DIR, `${lang}.json`), 'utf8'));

/** The sentence engine/moderation-notices.ts requestsClearedBody writes (its test pins this file's pattern to it). */
const SERVER = "People you wrote to reported your message requests, so they were cleared and you can't send new ones until 2026-11-08. You can still answer people who wrote to you, and post.";
const OTHER = LANGS.filter((l) => l !== 'en');

afterEach(() => setLanguage('en'));

describe('the refusal sentence', () => {
    it('English: the server\'s own sentence, word for word, whether the pattern or the helper writes it', () => {
        expect(requestsLimitedWords(SERVER)).toBe(SERVER);
        expect(requestsClearedSentence('2026-11-08T09:00:00.000Z')).toBe(SERVER);
    });

    it('anything that is not that sentence is shown exactly as given', () => {
        for (const other of ['Not allowed', 'People you wrote to reported you.', `${SERVER} More.`, SERVER.replace('2026-11-08', 'tomorrow')]) {
            expect(requestsLimitedWords(other)).toBe(other);
        }
    });

    it.each(OTHER)('%s: a translation, with the date, and nothing left in English', (lang) => {
        setLanguage(lang, [catalogOf(lang)]);
        const said = requestsLimitedWords(SERVER);
        expect(said).not.toBe(SERVER);
        expect(said).toContain('2026-11-08');
        expect(said).not.toContain('{date}');
        expect(said).not.toMatch(/\bpeople\b|\bcleared\b|\bmessage requests\b/i);
    });
});

describe('the notice', () => {
    it('English: the title the server sends, and the same sentence as the refusal', () => {
        expect(requestsClearedTitle()).toBe('🛡️ Your message requests were cleared');
        expect(requestsClearedNotice({ kind: REQUESTS_CLEARED_KIND, until: '2026-11-08T09:00:00.000Z' })).toEqual({
            title: '🛡️ Your message requests were cleared',
            body: SERVER,
        });
    });

    it('is no other notice, and needs its date', () => {
        expect(requestsClearedNotice({ kind: 'requests_back' })).toBeNull();
        expect(requestsClearedNotice({ kind: REQUESTS_CLEARED_KIND })).toBeNull();
        expect(requestsClearedNotice({ kind: REQUESTS_CLEARED_KIND, until: 'soon' })).toBeNull();
        expect(requestsClearedNotice(undefined)).toBeNull();
    });

    it.each(OTHER)('%s: title and body in the language, the body the refusal\'s sentence', (lang) => {
        setLanguage(lang, [catalogOf(lang)]);
        const notice = requestsClearedNotice({ kind: REQUESTS_CLEARED_KIND, until: '2026-11-08T09:00:00.000Z' });
        expect(notice).not.toBeNull();
        expect(notice!.title.startsWith('🛡️ ')).toBe(true);
        expect(notice!.title).not.toBe('🛡️ Your message requests were cleared');
        expect(notice!.body).toBe(requestsLimitedWords(SERVER));
        expect(notice!.body).toContain('2026-11-08');
    });
});
