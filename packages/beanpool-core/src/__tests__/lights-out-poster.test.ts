/**
 * The hall poster (lights-out mode H0; lights-out-poster.ts): its four lines are pinned in all 25 languages, and the page
 * that prints on A4 is checked for what it must and must not carry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGS, wordsFor, type Catalog, type Lang } from '../words.js';
import { LIGHTS_OUT_POSTER_WORDS, lightsOutPosterHtml, lightsOutPosterLines } from '../lights-out-poster.js';

const WORDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'words');
const catalogOf = (lang: Lang): Catalog => JSON.parse(fs.readFileSync(path.join(WORDS_DIR, `${lang}.json`), 'utf8'));
const OTHER = LANGS.filter((l): l is Exclude<Lang, 'en'> => l !== 'en');
const wordsIn = (lang: Lang) => wordsFor(lang, lang === 'en' ? [] : [catalogOf(lang)]);

/** The four lines as the design words them (§2.8) and the operator manual's checklist prints them. */
const ENGLISH_LINES = [
    'Turn on Airplane mode, then turn Wi-Fi back on.',
    "Join the hall's Wi-Fi. If your phone asks to stay connected, say yes.",
    'Open the BeanPool app and scan this code. It takes you to the hall laptop.',
    'No app on your Android phone? Scan this code to get it from the laptop.',
];

/** Every sentence the poster says, as the catalog keys. */
const SENTENCES = Object.values(LIGHTS_OUT_POSTER_WORDS) as string[];

/** The one label that is the same word in two languages (the word people there use for a Wi-Fi password). */
const SAME_AS_ENGLISH: Record<string, readonly string[]> = { [LIGHTS_OUT_POSTER_WORDS.wifiPassword]: ['it', 'fil'] };

describe('the four lines, in 25 languages', () => {
    it('there are 25 languages, English and 24 more', () => {
        expect(LANGS).toHaveLength(25);
        expect(OTHER).toHaveLength(24);
    });

    it('English: the four lines, word for word', () => {
        expect(lightsOutPosterLines(wordsIn('en'))).toEqual(ENGLISH_LINES);
    });

    it.each(OTHER)('%s: all four lines are translated, whole, and differ from one another', (lang) => {
        const lines = lightsOutPosterLines(wordsIn(lang));
        expect(lines).toHaveLength(4);
        for (const [i, line] of lines.entries()) {
            expect(line.trim().length, `line ${i + 1} is written`).toBeGreaterThan(10);
            expect(line, `line ${i + 1} is not the English`).not.toBe(ENGLISH_LINES[i]);
            expect(line, `line ${i + 1} holds no placeholder`).not.toMatch(/[{}]/);
        }
        expect(new Set(lines).size, 'four different lines').toBe(4);
        // The marks stay as they are: "BeanPool" is the mark, and the phone's own system is named.
        expect(lines[2]).toContain('BeanPool');
        expect(lines[3]).toContain('Android');
    });

    it.each(OTHER)('%s: every sentence the poster says has a translation in core\'s catalog, with the placeholder kept', (lang) => {
        const catalog = catalogOf(lang);
        for (const sentence of SENTENCES) {
            const said = catalog[sentence];
            expect(typeof said, `${lang}: "${sentence}"`).toBe('string');
            expect((said as string).length).toBeGreaterThan(0);
            if (!SAME_AS_ENGLISH[sentence]?.includes(lang)) expect(said, `${lang}: "${sentence}" is not left in English`).not.toBe(sentence);
        }
        expect(catalog[LIGHTS_OUT_POSTER_WORDS.record]).toContain('{when}');
        expect(wordsIn(lang).t(LIGHTS_OUT_POSTER_WORDS.record, { when: 'T1' })).toContain('T1');
    });

    it('is a machine draft where it says so: every catalog still labels itself', () => {
        for (const lang of OTHER) {
            const meta = catalogOf(lang)._meta as { review?: string; draftedBy?: string };
            expect(meta.review, lang).toBe('machine');
            expect(meta.draftedBy, lang).toContain('lights-out H0 poster');
        }
    });
});

describe('words the poster must not use', () => {
    it('English: neither "resilience" nor "survival" (Marty), nor "stale" or "out of date" for the record', () => {
        const english = SENTENCES.join('\n');
        expect(english).not.toMatch(/resilien|surviv/i);
        expect(english).not.toMatch(/\bstale\b|out of date/i);
    });
});

const OPTS = { communityName: 'Riverbend', address: '192.168.2.1:8080' };

describe('the printable page', () => {
    it('is one A4 page with no script and nothing fetched', () => {
        const html = lightsOutPosterHtml(wordsIn('en'), { ...OPTS, hallQr: '<svg viewBox="0 0 1 1"></svg>', androidQr: '<svg viewBox="0 0 1 1"></svg>' });
        expect(html).toMatch(/^<!doctype html>/i);
        expect(html).toContain('@page { size: A4;');
        expect(html).not.toMatch(/<script|<link|\ssrc=|\shref=|url\(|@import/i);
        expect(html).not.toMatch(/resilien|surviv/i);
    });

    it.each(LANGS)('%s: carries the title, the four lines, the readable line and the trouble line in that language', (lang) => {
        const w = wordsIn(lang);
        const html = lightsOutPosterHtml(w, { ...OPTS, hallQr: '<svg></svg>', androidQr: '<svg></svg>' });
        const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        for (const line of lightsOutPosterLines(w)) expect(html).toContain(escaped(line));
        expect(html).toContain(escaped(w.t(LIGHTS_OUT_POSTER_WORDS.title)));
        expect(html).toContain(escaped(w.t(LIGHTS_OUT_POSTER_WORDS.readable)));
        expect(html).toContain(escaped(w.t(LIGHTS_OUT_POSTER_WORDS.trouble)));
        expect(html).toContain(`<html lang="${lang}" dir="${['ar', 'fa', 'ur'].includes(lang) ? 'rtl' : 'ltr'}">`);
    });

    it('line 4 and its frame are printed only when the laptop holds the Android app', () => {
        const w = wordsIn('en');
        const without = lightsOutPosterHtml(w, { ...OPTS, hallQr: '<svg></svg>' });
        expect(without).toContain(ENGLISH_LINES[2]);
        expect(without).not.toContain('Android');
        expect((without.match(/class="step"/g) ?? []).length).toBe(3);
        const withApk = lightsOutPosterHtml(w, { ...OPTS, hallQr: '<svg></svg>', androidQr: '<svg></svg>' });
        expect((withApk.match(/class="step"/g) ?? []).length).toBe(4);
        expect(withApk).toContain(ENGLISH_LINES[3]);
        // An empty string stands for "print line 4 with an empty frame to paste a code on".
        const empty = lightsOutPosterHtml(w, { ...OPTS, androidQr: '' });
        expect((empty.match(/class="step"/g) ?? []).length).toBe(4);
        expect((empty.match(/class="qr empty"/g) ?? []).length).toBe(2);
    });

    it('a code that is not a plain <svg> is never put on the page; an empty frame stands there', () => {
        const w = wordsIn('en');
        for (const bad of ['<img src=x onerror=alert(1)>', '<svg><script>alert(1)</script></svg>', '<svg onload="x()"></svg>', '<svg><foreignObject></foreignObject></svg>', 'javascript:alert(1)']) {
            const html = lightsOutPosterHtml(w, { ...OPTS, hallQr: bad });
            expect(html, bad).not.toMatch(/alert\(1\)|onerror|onload|foreignObject/i);
            expect(html, bad).toContain('class="qr empty"');
        }
        expect(lightsOutPosterHtml(w, { ...OPTS, hallQr: '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>' })).toContain('<div class="qr"><svg viewBox="0 0 1 1">');
    });

    it('every text it is given is escaped', () => {
        const html = lightsOutPosterHtml(wordsIn('en'), {
            communityName: '<b>Riv"er</b> & Co', address: '<i>1</i>', peerShort: '<u>12D3</u>', wifiName: '<s>net</s>', wifiPassword: "'x'", recordAsOf: '<em>Tue</em>',
        });
        expect(html).not.toMatch(/<b>|<i>|<u>|<s>|<em>/);
        expect(html).toContain('&lt;b&gt;Riv&quot;er&lt;/b&gt; &amp; Co');
        expect(html).toContain('&#39;x&#39;');
    });

    it('the Wi-Fi name and password are lines to write on by hand when they are not given', () => {
        const html = lightsOutPosterHtml(wordsIn('en'), OPTS);
        expect((html.match(/class="blank"/g) ?? []).length).toBe(2);
        const given = lightsOutPosterHtml(wordsIn('en'), { ...OPTS, wifiName: 'Hall', wifiPassword: 'beans4all' });
        expect(given).not.toContain('class="blank"');
        expect(given).toContain('beans4all');
    });

    it('the record line is printed only when the record has an age, in the reader\'s language', () => {
        expect(lightsOutPosterHtml(wordsIn('en'), OPTS)).not.toContain('The record on this laptop');
        // The date is wrapped in an isolate (U+2068 … U+2069) so that it keeps its own order inside a right-to-left sentence;
        // the marks are invisible, and what is read is the sentence as written.
        const unmarked = (s: string) => s.replace(/[⁦-⁩]/g, '');
        const en = lightsOutPosterHtml(wordsIn('en'), { ...OPTS, recordAsOf: 'Tue 3 Nov, 14:02' });
        expect(unmarked(en)).toContain('The record on this laptop is as of Tue 3 Nov, 14:02. Trades made since then on the old server are not here.');
        expect(en).toContain('⁨Tue 3 Nov, 14:02⁩');
        const fr = lightsOutPosterHtml(wordsIn('fr'), { ...OPTS, recordAsOf: 'mar. 3 nov., 14:02' });
        expect(unmarked(fr)).toContain('mar. 3 nov., 14:02');
        expect(fr).not.toContain('The record on this laptop');
    });

    it('the address and the short peer id are drawn left to right in every language, even on a right-to-left page', () => {
        const html = lightsOutPosterHtml(wordsIn('ar'), { ...OPTS, peerShort: '12D3Koo…abcd' });
        expect(html).toContain('dir="rtl"');
        expect(html).toMatch(/\.address, \.peer \{ direction: ltr;/);
        expect(html).toContain('<span class="address">192.168.2.1:8080</span>');
    });
});
