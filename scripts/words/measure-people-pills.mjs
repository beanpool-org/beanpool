#!/usr/bin/env node
// measure-people-pills.mjs — writes apps/native/utils/__tests__/people-pill-widths.json: the width of People's three
// sub-tab labels (Friends, Community, Invites / Register, and Invites with its count) in every language, as Android
// draws them, which people-pills-320.test.ts holds to the row at 320 dp with text at 1.3×.
//
//   node scripts/words/measure-people-pills.mjs                  fetch the fonts, measure, write (run it by hand; committed)
//   node scripts/words/measure-people-pills.mjs --fonts <dir>    use fonts already in <dir> (the file names below)
//
// Why measured: the label is "<emoji> <word>", and English's "🏘️ Community" is 6.69 em, about 96 dp at 11 sp × 1.3,
// wider than the 93–95 dp a third of the row gives it. A model of "0.62 em a letter" cannot see that, nor that ml's
// "സുഹൃത്തുക്കൾ" is 8.5 em. Each label is shaped with HarfBuzz (`hb-shape`; brew install harfbuzz) in the font Android
// draws that script in: Roboto Bold-ish (wght 800, the active pill's weight, the wider) for Latin, Cyrillic and Greek;
// Noto Sans <script> Bold and its UI variant (the wider) for Arabic, Devanagari, Bengali, Tamil and Malayalam. The emoji is
// shaped in Noto Color Emoji (1.245 em, the same for all three). Japanese, Korean and Chinese labels are counted: an
// ideograph, kana or hangul syllable is one em, a digit or bracket 0.6, a space 0.25.
//
// Fonts at pinned commits: Roboto and Noto Color Emoji from google/fonts, Noto Sans <script> from notofonts.github.io,
// the UI variants from the noto-fonts archive. {n} in a count label is measured as "12".

/* global process, fetch, Buffer, console */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = 'apps/native/utils/__tests__/people-pill-widths.json';

const GOOGLE_FONTS = 'https://cdn.jsdelivr.net/gh/google/fonts@6183fc0d26361f6ddfd6f6b7a736e1467c6d8a43/ofl';
const NOTO = 'https://cdn.jsdelivr.net/gh/notofonts';
const SCRIPTS = { ar: 'Arabic', fa: 'Arabic', ur: 'Arabic', hi: 'Devanagari', bn: 'Bengali', ta: 'Tamil', ml: 'Malayalam' };
const CJK = new Set(['ja', 'ko', 'zh-Hans', 'zh-Hant']);
const FILES = [
    ['Roboto-VF.ttf', `${GOOGLE_FONTS}/roboto/Roboto%5Bwdth%2Cwght%5D.ttf`],
    // jsdelivr will not serve a file this large; raw.githubusercontent.com will.
    ['NotoColorEmoji-Regular.ttf', 'https://raw.githubusercontent.com/google/fonts/6183fc0d26361f6ddfd6f6b7a736e1467c6d8a43/ofl/notocoloremoji/NotoColorEmoji-Regular.ttf'],
    ...[...new Set(Object.values(SCRIPTS))].flatMap((family) => [
        [`NotoSans${family}-Bold.ttf`, `${NOTO}/notofonts.github.io@9566151bf4d9138cd83d3563196fb2efa5698eaa/fonts/NotoSans${family}/hinted/ttf/NotoSans${family}-Bold.ttf`],
        [`NotoSans${family}UI-Bold.ttf`, `${NOTO}/noto-fonts@ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSans${family}UI/NotoSans${family}UI-Bold.ttf`],
    ]),
];

/** What the English labels are in people.tsx (English is the key itself, so it has no catalog). */
const ENGLISH = ['👫 Friends', '🏘️ Community', '🎟️ Invites', '🎟️ Invites ({n})', '🎟️ Register'];
const COUNT = '🎟️ Invites ({n})';

const at = process.argv.indexOf('--fonts');
const fontDir = at > 0 ? path.resolve(process.argv[at + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'people-pill-fonts-'));
for (const [file, url] of FILES) {
    if (fs.existsSync(path.join(fontDir, file))) continue;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    fs.writeFileSync(path.join(fontDir, file), Buffer.from(await res.arrayBuffer()));
}

const shape = (file, text, variations) => {
    const args = ['--output-format=json', '--no-glyph-names', ...(variations ? [`--variations=${variations}`] : []), path.join(fontDir, file), text];
    return JSON.parse(execFileSync('hb-shape', args, { encoding: 'utf8' })).reduce((w, g) => w + g.ax, 0);
};
/** units per em, read from the font's head table. */
const upem = (file) => {
    const data = fs.readFileSync(path.join(fontDir, file));
    for (let i = 0; i < data.readUInt16BE(4); i++) {
        const entry = 12 + 16 * i;
        if (data.toString('latin1', entry, entry + 4) === 'head') return data.readUInt16BE(data.readUInt32BE(entry + 8) + 18);
    }
    throw new Error(`${file}: no head table`);
};

const EMOJI_EM = shape('NotoColorEmoji-Regular.ttf', '🏘️') / upem('NotoColorEmoji-Regular.ttf');

/** Width in em of text with no emoji in it, in the font Android draws the language in. */
function wordsEm(lang, text) {
    if (!text) return 0;
    if (CJK.has(lang)) return Array.from(text).reduce((w, c) => w + (/[0-9()（） ]/.test(c) ? (c === ' ' ? 0.25 : 0.6) : 1), 0);
    const family = SCRIPTS[lang];
    if (!family) return shape('Roboto-VF.ttf', text, 'wght=800') / upem('Roboto-VF.ttf');
    return Math.max(...[`NotoSans${family}-Bold.ttf`, `NotoSans${family}UI-Bold.ttf`].map((file) => shape(file, text) / upem(file)));
}

/** A label's one-line width in em: the emoji, a space, the words. */
function labelEm(lang, label) {
    const [emoji, ...rest] = label.replace('{n}', '12').split(' ');
    if (!/\p{Extended_Pictographic}/u.test(emoji)) throw new Error(`${lang}: "${label}" does not start with its emoji`);
    return EMOJI_EM + wordsEm(lang, ' ') + wordsEm(lang, rest.join(' '));
}

const widths = {};
const langs = ['en', ...fs.readdirSync(path.join(ROOT, 'apps/native/words')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()];
for (const lang of langs) {
    const labels = [];
    if (lang === 'en') labels.push(...ENGLISH);
    else {
        const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/native/words', `${lang}.json`), 'utf8'));
        for (const english of ENGLISH) {
            if (english === COUNT) labels.push(...new Set(Object.values(catalog[`${COUNT}|${COUNT}`])));
            else labels.push(catalog[english]);
        }
    }
    widths[lang] = {};
    for (const label of labels) {
        if (typeof label !== 'string') throw new Error(`${lang}: a People label is missing from its catalog`);
        widths[lang][label] = Number(labelEm(lang, label).toFixed(3));
    }
}
const harfbuzz = execFileSync('hb-shape', ['--version'], { encoding: 'utf8' }).split('\n')[0];
fs.writeFileSync(path.join(ROOT, OUT), `${JSON.stringify({
    about: 'People sub-tab labels in em (emoji, space, words), shaped by HarfBuzz in the font Android draws each script in. Written by scripts/words/measure-people-pills.mjs.',
    harfbuzz,
    emoji: Number(EMOJI_EM.toFixed(3)),
    widths,
}, null, 2)}\n`);
console.log(`measure-people-pills — wrote ${OUT}: ${Object.values(widths).reduce((n, w) => n + Object.keys(w).length, 0)} labels in ${langs.length} languages (${harfbuzz})`);
