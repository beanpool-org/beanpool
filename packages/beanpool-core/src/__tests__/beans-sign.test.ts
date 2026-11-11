/**
 * The "Beans accepted here" sign (beans-sign.ts, qr-matrix.ts): the page both apps print, A4 for a window and A6 for a stall.
 * Checked for what it must say, what it must never say (beanpool.org, anyone's markup), that it is one page of the right paper,
 * that it prints in black and white, and that its seven sentences are in all 25 languages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGS, wordsFor, type Catalog, type Lang } from '../words.js';
import { BRAND_COLOURS, contrastRatio } from '../brand-colours.js';
import {
    BEANS_SIGN_FRAME, BEANS_SIGN_SIZES, BEANS_SIGN_WORDS, beansSignAddress, beansSignHtml, beansSignUrl, type BeansSignOptions, type BeansSignSize,
} from '../beans-sign.js';
import { qrMatrix } from '../qr-matrix.js';
import { printedQrSvg } from '../lights-out-poster.js';

const WORDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'words');
const catalogOf = (lang: Lang): Catalog => JSON.parse(fs.readFileSync(path.join(WORDS_DIR, `${lang}.json`), 'utf8'));
const OTHER = LANGS.filter((l): l is Exclude<Lang, 'en'> => l !== 'en');
const wordsIn = (lang: Lang) => wordsFor(lang, lang === 'en' ? [] : [catalogOf(lang)]);
const SIZES: BeansSignSize[] = ['a4', 'a6'];

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const optionsFor = (size: BeansSignSize, address = 'https://mullum.beanpool.org'): BeansSignOptions => ({
    size,
    communityName: 'Mullumbimby Community',
    address: beansSignAddress(address),
    qr: qrMatrix(beansSignUrl(address)),
});

describe('where the code leads', () => {
    it('is the community\'s own address, at its root, whatever the domain', () => {
        expect(beansSignUrl('https://mullum.beanpool.org')).toBe('https://mullum.beanpool.org/');
        expect(beansSignUrl('https://shop.example.org/app?door=ask#x')).toBe('https://shop.example.org/');
        expect(beansSignUrl('http://192.168.2.1:8080/')).toBe('http://192.168.2.1:8080/');
    });

    it('is printed to be typed: no scheme where it is https, no slash; a plain-IP address keeps its scheme and port', () => {
        expect(beansSignAddress('https://mullum.beanpool.org')).toBe('mullum.beanpool.org');
        expect(beansSignAddress('https://shop.example.org/app')).toBe('shop.example.org');
        expect(beansSignAddress('http://192.168.2.1:8080')).toBe('http://192.168.2.1:8080');
    });

    it.each(['', 'not a url', 'javascript:alert(1)', 'ftp://example.org', 'data:text/html,<b>x</b>'])('refuses %j', (bad) => {
        expect(() => beansSignUrl(bad)).toThrow();
    });
});

describe('the code', () => {
    it('is a square grid with the three finder squares, and the poster\'s own drawing accepts it', () => {
        const m = qrMatrix('https://mullum.beanpool.org/');
        expect(m.length).toBeGreaterThanOrEqual(21);
        expect(m.every((row) => row.length === m.length)).toBe(true);
        // The top-left finder: a dark 7x7 ring (rows 0 and 6 and columns 0 and 6 dark), a light ring inside it, a dark 3x3 centre.
        for (let i = 0; i < 7; i++) {
            expect(m[0][i]).toBe(true);
            expect(m[6][i]).toBe(true);
            expect(m[i][0]).toBe(true);
            expect(m[i][6]).toBe(true);
        }
        expect(m[1][1]).toBe(false);
        expect(m[3][3]).toBe(true);
        const n = m.length;
        expect(m[0][n - 1]).toBe(true); // the top-right finder
        expect(m[n - 1][0]).toBe(true); // the bottom-left finder
        expect(printedQrSvg(m)).toContain('<svg');
    });

    it('is the same for the same address, and a longer address makes a bigger code', () => {
        expect(qrMatrix('https://a.example.org/')).toEqual(qrMatrix('https://a.example.org/'));
        expect(qrMatrix('https://a-much-longer-address.example.org/with/a/path?and=query').length).toBeGreaterThan(qrMatrix('https://a.example.org/').length);
    });

    it('is not made from nothing', () => {
        expect(() => qrMatrix('')).toThrow();
    });
});

describe.each(SIZES)('the %s sign', (size) => {
    const html = beansSignHtml(wordsIn('en'), { ...optionsFor(size), logoDataUri: PNG });

    it('says Beans accepted here, the community, BeanPool and the address, and draws the code', () => {
        expect(html).toContain('<h1>Beans accepted here</h1>');
        expect(html).toContain('Mullumbimby Community');
        expect(html).toContain('BeanPool');
        expect(html).toContain('mullum.beanpool.org');
        expect(html).toContain('Scan this code with your phone camera to find our community.');
        expect(html).toContain('Or type this address:');
        expect(html).toContain('<svg');
        expect(html).toContain(PNG);
    });

    it('is one self-contained page: no script, no outside file, no link', () => {
        expect(html).not.toMatch(/<script|<link|<a |@import|url\(/i);
        expect(html.match(/src="/g)).toHaveLength(1); // the mark, inline
        expect(html.match(/<main/g)).toHaveLength(1);
    });

    it('sets its own paper in millimetres and is shorter than the paper inside its margins, so it is never two pages', () => {
        const s = BEANS_SIGN_SIZES[size];
        expect(html).toContain(`@page { size: ${s.widthMm}mm ${s.heightMm}mm; margin: ${s.marginMm}mm; }`);
        const sheet = /\.sheet \{ height: ([\d.]+)mm;/.exec(html);
        expect(sheet).not.toBeNull();
        expect(Number(sheet![1])).toBeLessThan(s.heightMm - 2 * s.marginMm);
        // The two sizes are A4 and A6 in portrait, and the points a phone's PDF maker is given are the same paper (1 pt = 1/72 in).
        expect(s.widthMm).toBeLessThan(s.heightMm);
        expect(Math.abs(s.widthPt - (s.widthMm / 25.4) * 72)).toBeLessThan(1);
        expect(Math.abs(s.heightPt - (s.heightMm / 25.4) * 72)).toBeLessThan(1);
    });

    it('prints in black and white: every colour is black, white or the one brand frame, which holds 3:1 on white', () => {
        const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
        const colours = new Set((css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((c) => c.toLowerCase()));
        expect([...colours].sort()).toEqual(['#000', '#fff', BEANS_SIGN_FRAME.toLowerCase()].sort());
        expect(BEANS_SIGN_FRAME).toBe(BRAND_COLOURS.commit.fill.light);
        expect(contrastRatio(BEANS_SIGN_FRAME, '#ffffff')).toBeGreaterThanOrEqual(3);
        // The code itself: black modules on a white square.
        expect(html).toContain('<g fill="#000">');
        expect(html).toContain('fill="#fff"');
    });

    it('never names beanpool.org on its own: a community on its own domain, or a plain IP, prints its own address', () => {
        const own = beansSignHtml(wordsIn('en'), optionsFor(size, 'https://shop.example.org/'));
        expect(own).toContain('shop.example.org');
        expect(own).not.toMatch(/beanpool\.org|https?:\/\//i);
        const lan = beansSignHtml(wordsIn('en'), optionsFor(size, 'http://192.168.2.1:8080'));
        expect(lan).toContain('http://192.168.2.1:8080');
        expect(lan).not.toMatch(/beanpool\.org/i);
    });

    it('escapes what a person typed and keeps the mark safe', () => {
        const nasty = beansSignHtml(wordsIn('en'), {
            ...optionsFor(size),
            communityName: '<script>alert(1)</script> & "co"',
            address: '"><img src=x onerror=alert(1)>',
            logoDataUri: 'data:image/png;base64,AAAA" onerror="alert(1)',
        });
        expect(nasty).not.toContain('<script>alert');
        expect(nasty).not.toContain('<img src=x');
        expect(nasty).not.toContain('onerror="alert');
        expect(nasty).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;');
        expect(nasty).not.toContain('<img'); // an unsafe mark is left out, the word stands for it
    });

    it('stands without the mark, and refuses a mark that is not a plain PNG', () => {
        for (const logoDataUri of [undefined, '', 'https://beanpool.org/logo.png', 'data:image/svg+xml;base64,AAAA', 'javascript:alert(1)']) {
            const page = beansSignHtml(wordsIn('en'), { ...optionsFor(size), logoDataUri });
            expect(page).not.toContain('<img');
            expect(page).toContain('<span class="brand">BeanPool</span>');
        }
    });

    it('is not made without a code', () => {
        expect(() => beansSignHtml(wordsIn('en'), { ...optionsFor(size), qr: '<svg onload=alert(1)>' as never })).toThrow();
        expect(() => beansSignHtml(wordsIn('en'), { ...optionsFor(size), qr: [[true, false]] })).toThrow();
        // Only the two sizes: not another paper, and not a name every object has (`in` would let "constructor" draw a page with no paper).
        for (const bad of ['a3', 'constructor', 'toString', '__proto__', '']) {
            expect(() => beansSignHtml(wordsIn('en'), { ...optionsFor(size), size: bad as never }), bad).toThrow();
        }
    });
});

describe('the two sizes', () => {
    it('are different pages: the window sign is larger type and a larger code than the stall card', () => {
        const a4 = BEANS_SIGN_SIZES.a4;
        const a6 = BEANS_SIGN_SIZES.a6;
        expect(a4.headlinePt).toBeGreaterThan(a6.headlinePt);
        expect(a4.qrMm).toBeGreaterThan(a6.qrMm);
        // A code needs about 20 mm to scan from a hand's reach, and the stall card's must fit its own width with the frame.
        expect(a6.qrMm).toBeGreaterThanOrEqual(40);
        expect(a6.qrMm).toBeLessThan(a6.widthMm - 2 * (a6.marginMm + a6.borderMm + a6.padMm));
        expect(a4.qrMm).toBeLessThan(a4.widthMm - 2 * (a4.marginMm + a4.borderMm + a4.padMm));
    });
});

describe('right to left', () => {
    it.each(['ar', 'fa', 'ur'] as const)('%s: the page runs right to left, and the address and the name keep their own direction', (lang) => {
        const page = beansSignHtml(wordsIn(lang), optionsFor('a4'));
        expect(page).toContain(`lang="${lang}" dir="rtl"`);
        expect(page).toContain('<bdi>Mullumbimby Community</bdi>');
        expect(page).toContain('.url { direction: ltr; unicode-bidi: isolate;');
    });

    it('English runs left to right', () => {
        expect(beansSignHtml(wordsIn('en'), optionsFor('a4'))).toContain('lang="en" dir="ltr"');
    });
});

describe('the sentences, in 25 languages', () => {
    const SENTENCES = Object.values(BEANS_SIGN_WORDS) as string[];

    it('there are 25 languages, English and 24 more, and seven sentences', () => {
        expect(LANGS).toHaveLength(25);
        expect(OTHER).toHaveLength(24);
        expect(SENTENCES).toHaveLength(7);
    });

    it('English: the sentences, word for word', () => {
        const w = wordsIn('en');
        expect(w.t(BEANS_SIGN_WORDS.title)).toBe('Beans accepted here');
        expect(w.t(BEANS_SIGN_WORDS.a4)).toBe('Make a window sign (A4)');
        expect(w.t(BEANS_SIGN_WORDS.a6)).toBe('Make a stall card (A6)');
    });

    it.each(OTHER)('%s: every sentence is translated, whole, with the paper sizes kept and no placeholder left', (lang) => {
        const catalog = catalogOf(lang);
        const w = wordsIn(lang);
        for (const sentence of SENTENCES) {
            const said = catalog[sentence];
            expect(typeof said, `${lang}: "${sentence}"`).toBe('string');
            expect((said as string).trim().length, `${lang}: "${sentence}" is written`).toBeGreaterThan(5);
            expect(said, `${lang}: "${sentence}" is not the English`).not.toBe(sentence);
            expect(said as string, `${lang}: "${sentence}" holds no placeholder`).not.toMatch(/[{}]/);
            expect(w.t(sentence as never)).toBe(said);
        }
        expect(catalog[BEANS_SIGN_WORDS.a4] as string).toContain('A4');
        expect(catalog[BEANS_SIGN_WORDS.a6] as string).toContain('A6');
    });

    it.each(OTHER)('%s: the catalog still says it is a machine draft, and names this round', (lang) => {
        const meta = catalogOf(lang)._meta as { review?: string; reviewed?: boolean; draftedBy?: string };
        expect(meta.review).toBe('machine');
        expect(meta.reviewed).toBe(false);
        expect(meta.draftedBy).toContain('Beans accepted here sign');
    });

    it.each(OTHER)('%s: the whole page is made in that language', (lang) => {
        const page = beansSignHtml(wordsIn(lang), optionsFor('a4'));
        expect(page).toContain(`lang="${lang}"`);
        expect(page).toContain(wordsIn(lang).t(BEANS_SIGN_WORDS.title));
        expect(page).toContain(wordsIn(lang).t(BEANS_SIGN_WORDS.scan));
        expect(page).not.toContain('Scan this code');
    });
});
