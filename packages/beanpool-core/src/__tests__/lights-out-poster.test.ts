/**
 * The hall poster (lights-out mode H0; lights-out-poster.ts): its four lines are pinned in all 25 languages, and the page
 * that prints on A4 is checked for what it must and must not carry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGS, wordsFor, type Catalog, type Lang } from '../words.js';
import { LIGHTS_OUT_POSTER_WORDS, lightsOutPosterHtml, lightsOutPosterLines, type QrMatrix } from '../lights-out-poster.js';

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

/** A code as data, from rows of '#' (a dark module) and '.' (a light one). */
const matrix = (...rows: string[]): QrMatrix => rows.map((r) => [...r].map((c) => c === '#'));
const CODE = matrix('#.#', '.#.', '#.#');
/** What stands where a code cannot be drawn. */
const EMPTY_FRAME = '<div class="qr empty" aria-hidden="true"></div>';
/** Every frame on the page, whole. */
const framesOf = (html: string) => html.match(/<div class="qr[^"]*"[^>]*>[\s\S]*?<\/div>/g) ?? [];

describe('the printable page', () => {
    it('is one A4 page with no script and nothing fetched', () => {
        const html = lightsOutPosterHtml(wordsIn('en'), { ...OPTS, hallQr: CODE, androidQr: CODE });
        expect(html).toMatch(/^<!doctype html>/i);
        expect(html).toContain('@page { size: A4;');
        // Not even a web address: the codes are drawn here, so no namespace or link is written either.
        expect(html).not.toMatch(/<script|<link|\ssrc=|\shref=|url\(|@import|https?:|xmlns/i);
        expect(html).not.toMatch(/resilien|surviv/i);
    });

    it.each(LANGS)('%s: carries the title, the four lines, the readable line and the trouble line in that language', (lang) => {
        const w = wordsIn(lang);
        const html = lightsOutPosterHtml(w, { ...OPTS, hallQr: CODE, androidQr: CODE });
        const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        for (const line of lightsOutPosterLines(w)) expect(html).toContain(escaped(line));
        expect(html).toContain(escaped(w.t(LIGHTS_OUT_POSTER_WORDS.title)));
        expect(html).toContain(escaped(w.t(LIGHTS_OUT_POSTER_WORDS.readable)));
        expect(html).toContain(escaped(w.t(LIGHTS_OUT_POSTER_WORDS.trouble)));
        expect(html).toContain(`<html lang="${lang}" dir="${['ar', 'fa', 'ur'].includes(lang) ? 'rtl' : 'ltr'}">`);
    });

    it('line 4 and its frame are printed only when the laptop holds the Android app', () => {
        const w = wordsIn('en');
        const without = lightsOutPosterHtml(w, { ...OPTS, hallQr: CODE });
        expect(without).toContain(ENGLISH_LINES[2]);
        expect(without).not.toContain('Android');
        expect((without.match(/class="step"/g) ?? []).length).toBe(3);
        const withApk = lightsOutPosterHtml(w, { ...OPTS, hallQr: CODE, androidQr: CODE });
        expect((withApk.match(/class="step"/g) ?? []).length).toBe(4);
        expect(withApk).toContain(ENGLISH_LINES[3]);
        // null stands for "print line 4 with an empty frame to paste a code on"; undefined leaves line 4 off.
        const empty = lightsOutPosterHtml(w, { ...OPTS, androidQr: null });
        expect((empty.match(/class="step"/g) ?? []).length).toBe(4);
        expect(framesOf(empty)).toEqual([EMPTY_FRAME, EMPTY_FRAME]);
    });

    it('a code is drawn here from its modules: a white page, and one black rectangle for each run of dark modules', () => {
        const rows = ['###..', '.....', '#.#.#', '.###.', '#...#'];
        const frame = framesOf(lightsOutPosterHtml(wordsIn('en'), { ...OPTS, hallQr: matrix(...rows) }))[0] ?? '';
        expect(frame).not.toBe('');
        // 5 modules and the 4-module quiet zone scanners need on each side: 13 x 13.
        expect(frame).toContain('<svg viewBox="0 0 13 13" shape-rendering="crispEdges" aria-hidden="true">');
        expect(frame).toContain('<rect width="13" height="13" fill="#fff"/>');
        const rects = frame.match(/<rect x="\d+" y="\d+" width="\d+" height="1"\/>/g) ?? [];
        // Row 0 is one run of 3, row 1 none, row 2 three single modules, row 3 one run of 3, row 4 two single modules.
        expect(rects).toEqual([
            '<rect x="4" y="4" width="3" height="1"/>',
            '<rect x="4" y="6" width="1" height="1"/>', '<rect x="6" y="6" width="1" height="1"/>', '<rect x="8" y="6" width="1" height="1"/>',
            '<rect x="5" y="7" width="3" height="1"/>',
            '<rect x="4" y="8" width="1" height="1"/>', '<rect x="8" y="8" width="1" height="1"/>',
        ]);
        // Every module is accounted for: the dark ones drawn are the dark ones given, and no others.
        const drawn = new Set<string>();
        for (const m of rects) {
            const [x, y, width] = (m.match(/\d+/g) ?? []).map(Number);
            for (let i = 0; i < width; i++) drawn.add(`${x - 4 + i},${y - 4}`);
        }
        const given = new Set<string>();
        matrix(...rows).forEach((row, y) => row.forEach((dark, x) => { if (dark) given.add(`${x},${y}`); }));
        expect(drawn).toEqual(given);
    });

    it("nothing but the page's own tags and numbers is in a frame: the tags and attributes are an allowlist", () => {
        const html = lightsOutPosterHtml(wordsIn('en'), { ...OPTS, hallQr: CODE, androidQr: matrix('##', '#.') });
        const frames = framesOf(html);
        expect(frames).toHaveLength(2);
        for (const frame of frames) {
            const tags = new Set([...frame.matchAll(/<\/?([a-z]+)/gi)].map((m) => m[1]));
            expect([...tags].sort()).toEqual(['div', 'g', 'rect', 'svg']);
            for (const m of frame.matchAll(/\s([a-z-]+)="([^"]*)"/gi)) {
                expect(['class', 'viewBox', 'shape-rendering', 'aria-hidden', 'width', 'height', 'fill', 'x', 'y'], m[1]).toContain(m[1]);
                // Every value is a number, a fixed word or one of this file's own colours.
                expect(m[2], `${m[1]}="${m[2]}"`).toMatch(/^(\d+|\d+ \d+ \d+ \d+|qr|crispEdges|true|#fff|#000)$/);
            }
        }
    });

    it('a code that is not a square of booleans is never drawn; an empty frame stands there', () => {
        const w = wordsIn('en');
        const big = (n: number) => Array.from({ length: n }, () => Array<boolean>(n).fill(true));
        const refused: Array<[string, unknown]> = [
            ['a string of markup (the old way)', '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'],
            ['a number', 7], ['an object', { length: 3 }], ['no rows', []], ['no columns', [[]]],
            ['a ragged matrix', [[true, false, true], [true, false], [true, false, true]]],
            ['a matrix that is not square', [[true, false, true], [true, false, true]]],
            ['numbers for modules', [[1, 0], [0, 1]]], ['strings for modules', [['1', '0'], ['0', '1']]],
            // eslint-disable-next-line no-sparse-arrays
            ['a hole in a row', [[true, , true], [true, false, true], [true, false, true]]],
            ['rows that are strings', ['#.#', '.#.', '#.#']],
            ['one more module a side than version 40 has', big(178)],
        ];
        for (const [what, bad] of refused) {
            const html = lightsOutPosterHtml(w, { ...OPTS, hallQr: bad as QrMatrix, androidQr: bad as QrMatrix });
            expect(framesOf(html), what).toEqual([EMPTY_FRAME, EMPTY_FRAME]);
        }
        // The largest code there is (version 40, 177 modules a side) is drawn.
        expect(framesOf(lightsOutPosterHtml(w, { ...OPTS, hallQr: big(177) }))[0]).toContain('viewBox="0 0 185 185"');
    });

    // Opus review of #2823, second round (non-blocking note): the length was read three times and the rows were read by the
    // array's iterator, so an Array subclass with an iterator of its own gave fewer rows than `side`, and rows[y][x] threw
    // where the docblock promises an empty frame. The length is read once and every row by its index.
    it('a code whose array has an iterator of its own, or a length that changes, never throws: the rows are read by index, once', () => {
        const w = wordsIn('en');
        class ShortIterator extends Array<boolean[]> {
            *[Symbol.iterator](): Generator<boolean[]> { yield this[0]; }
        }
        const short = new ShortIterator();
        for (const row of CODE) short.push([...row]);
        expect(short.length).toBe(3);
        expect(Array.isArray(short)).toBe(true);
        let html = '';
        expect(() => { html = lightsOutPosterHtml(w, { ...OPTS, hallQr: short as unknown as QrMatrix }); }).not.toThrow();
        // Read by index it is the whole 3 x 3 code, drawn exactly as the same code is drawn from a plain array.
        const plain = framesOf(lightsOutPosterHtml(w, { ...OPTS, hallQr: CODE }))[0];
        expect(framesOf(html)[0]).toBe(plain);
        expect(plain).toContain('viewBox="0 0 11 11"');

        // A length that answers differently each time it is asked is read once: the frame is whole or empty, never half a code.
        for (const answers of [[3, 1], [3, 5], [3, 0], [3, 3, 2]]) {
            let asked = 0;
            const flaky = new Proxy(CODE.map((r) => [...r]), {
                get: (target, key, receiver) => (key === 'length' ? answers[Math.min(asked++, answers.length - 1)] : Reflect.get(target, key, receiver)),
            });
            let out = '';
            expect(() => { out = lightsOutPosterHtml(w, { ...OPTS, hallQr: flaky as unknown as QrMatrix }); }, answers.join(',')).not.toThrow();
            expect([plain, EMPTY_FRAME], answers.join(',')).toContain(framesOf(out)[0]);
        }
    });

    it('markup cannot cross: the inputs the Opus review of #2823 tried, and the older ones, reach no part of the page', () => {
        const w = wordsIn('en');
        const MARKUP = [
            '<svg><img src="x"/onerror="alert(1)"></svg>',
            '<svg><a href="jav&#x61;script:alert(1)">x</a></svg>',
            '<svg><image href="https://evil.example/x.png"/></svg>',
            '<svg><style>@import url(https://evil.example/x.css)</style></svg>',
            '<img src=x onerror=alert(1)>', '<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"></svg>',
            '<svg><foreignObject></foreignObject></svg>', 'javascript:alert(1)',
        ];
        const GONE = /alert|onerror|onload|evil\.example|javascript|jav&#x61|foreignObject|<img|<image|<a\b|@import|https?:/i;
        for (const bad of MARKUP) {
            // As a code (the old, string, way), as a row, and as modules: only a boolean is ever read from a matrix.
            for (const hostile of [bad, [bad], [[bad]], [[bad, true], [true, bad]], matrix('#.', '.#').map((r) => [...r, bad])]) {
                const html = lightsOutPosterHtml(w, { ...OPTS, hallQr: hostile as unknown as QrMatrix, androidQr: hostile as unknown as QrMatrix });
                expect(html, JSON.stringify(hostile).slice(0, 60)).not.toMatch(GONE);
                expect(framesOf(html)).toEqual([EMPTY_FRAME, EMPTY_FRAME]);
            }
        }
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
