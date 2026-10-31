#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Bring my listings (Lounge L7, DESIGN-global-lounge-fable.md §6 L7) at the floor (320dp wide, phone text at 1.3×), in light
 * and dark: the app's own BringListingsSheetView through react-native-web in headless Chromium, each of its states. A stand-in
 * for a phone: Android's fonts and line breaks differ.
 *
 * Checks:
 * - No sideways scroll
 * - Nothing past the 320dp edge
 * - Buttons >= 44dp tall, and on the screen
 * - Text contrast >= 4.5:1 (or 3:1 for large text)
 * - Screenshots optionally written to --shots <dir>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(HERE, '..');
const ROOT = path.resolve(NATIVE, '../..');
const SCALE = 1.3;
const WIDTH = 320;
const HEIGHT = 569;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bring-listings-320-'));

const STUBS = {
    'react-native': `
        import React from 'react';
        import * as RNW from 'react-native-web';
        export * from 'react-native-web';
        const scaled = (style) => {
            const f = RNW.StyleSheet.flatten(style) || {};
            const o = { ...f, fontSize: (f.fontSize ?? 14) * ${SCALE} };
            if (typeof f.lineHeight === 'number') o.lineHeight = f.lineHeight * ${SCALE};
            return o;
        };
        export const Text = React.forwardRef((p, ref) => React.createElement(RNW.Text, { ...p, ref, style: scaled(p.style) }));
        export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o['android'] ?? o.default };
        export const Alert = { alert() {} };
        export default { ...RNW, Text, Platform, Alert };
    `,
    'react-native-safe-area-context': `export const useSafeAreaInsets = () => ({ top: 24, bottom: 24, left: 0, right: 0 });`,
    '@react-native-async-storage/async-storage': `export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };`,
    // The sheet's words are the app's own (utils/bring-listings.ts); what would reach a community or the phone's memory is not here.
    './node-post': `export const signedGet = async () => { throw new Error('no network here'); }; export const signedPost = signedGet;`,
    './node-profile': `export const GLOBAL_NODE_URL = 'https://global.beanpool.org'; export const getCachedNodeProfile = async () => null;`,
    './post-photo': `export const fetchedPostPhoto = async () => ({ failed: 'gone' });`,
    './db': `export const pushProfileToServer = async () => false;`,
    '../app/ThemeContext': `
        import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
        const dark = new URLSearchParams(location.search).get('scheme') === 'dark';
        export const useStyles = (make) => make({ theme: dark ? 'dark' : 'light', colors: dark ? darkColors : lightColors });
        export const useTheme = () => ({ theme: dark ? 'dark' : 'light', colors: dark ? darkColors : lightColors });
    `,
};

const stubFor = (spec) => (STUBS[spec] ? spec : null);

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { BringListingsSheetView } from ${JSON.stringify(path.join(NATIVE, 'components/BringListingsSheetView'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;
const name = 'Brunswick Valley Community Exchange';
const lines = [
    { kind: 'gone', title: 'Old bike' },
    { kind: 'fewer-photos', title: 'Tomato seedlings, six trays' },
    { kind: 'photos-failed', title: 'Honey from the top paddock' },
    { kind: 'no-photo', title: 'A ladder' },
    { kind: 'refused', title: 'A spade', reason: 'Please list an Offer before you ask for something.' },
];
const many = Array.from({ length: 24 }, (_, i) => ({ kind: 'gone', title: 'A rather long listing title, number ' + i }));
const STATES = {
    offer: { step: 'offer', name, count: 12, noPrice: true },
    one: { step: 'offer', name, count: 1, noPrice: true },
    bringing: { step: 'bringing', done: 3, total: 12 },
    done: { step: 'done', name, brought: 9, lines, kept: false },
    kept: { step: 'done', name, brought: 2, lines: [{ kind: 'fewer-photos', title: 'Tomato seedlings' }], kept: true },
    none: { step: 'done', name, brought: 0, lines: [{ kind: 'gone', title: 'Old bike' }], kept: false },
    many: { step: 'done', name, brought: 1, lines: many, kept: false },
};

createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', backgroundColor: colors.surface.app }}>
        <BringListingsSheetView view={STATES[q.get('state')]} onBring={() => {}} onNotNow={() => {}} onClose={() => {}} />
    </View>
);
`);

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.png': 'empty', '.ttf': 'empty' },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.mjs', '.json'],
    nodePaths: [path.join(ROOT, 'node_modules'), path.join(NATIVE, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {} }; globalThis.global = globalThis;' },
    logLevel: 'error',
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
                if (args.namespace === 'stub') return undefined;
                const name = stubFor(args.path);
                if (!name) return undefined;
                return { path: name, namespace: 'stub' };
            });
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'jsx', resolveDir: NATIVE }));
        },
    }],
});

const bundle = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<script>window.process = window.process || { env: {} }; window.global = window;</script>
<style>html,body,#root{margin:0;height:100%} body{font-family:sans-serif}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const problems = [];
let states = 0;
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => { console.error('PAGE ERROR:', e); errors.push(String(e)); });

    const measure = async (label) => {
        states++;
        const found = await page.evaluate(({ WIDTH, HEIGHT }) => {
            const out = [];
            const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
            const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
            const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
            const backdrop = (el) => {
                const layers = [];
                for (let e = el; e; e = e.parentElement) {
                    const c = rgb(getComputedStyle(e).backgroundColor);
                    if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
                }
                let base = { r: 255, g: 255, b: 255, a: 1 };
                for (const l of layers.reverse()) base = over(l, base);
                return base;
            };
            if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
            const texts = [...document.querySelectorAll('div[dir], span')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
            if (texts.length === 0) out.push('nothing was drawn');
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = el.textContent.trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
                if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`"${what}" is cut on the right (${el.scrollWidth} > ${el.clientWidth})`);
                const cs = getComputedStyle(el);
                const fg = rgb(cs.color);
                if (!fg) continue;
                const bg = backdrop(el);
                const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
                const ratio = (a + 0.05) / (b + 0.05);
                const size = parseFloat(cs.fontSize);
                const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                if (ratio < (large ? 3 : 4.5)) out.push(`"${what}" has contrast ${ratio.toFixed(2)}:1 (${cs.color} on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}), ${size}px)`);
            }
            for (const el of document.querySelectorAll('[role="button"]')) {
                const r = el.getBoundingClientRect();
                if (r.width === 0) continue;
                const what = el.textContent.trim().slice(0, 40);
                if (r.height < 43.5) out.push(`the button "${what}" is ${Math.round(r.height)}dp tall`);
                if (r.bottom > HEIGHT + 0.5) out.push(`the button "${what}" is off the screen (${Math.round(r.bottom)} of ${HEIGHT})`);
            }
            return out;
        }, { WIDTH, HEIGHT });
        for (const p of found) problems.push(`${label}: ${p}`);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label}.png`) }); }
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };

    for (const scheme of ['light', 'dark']) {
        for (const state of ['offer', 'one', 'bringing', 'done', 'kept', 'none', 'many']) {
            await page.goto(`${base}/?scheme=${scheme}&state=${state}`);
            await page.waitForTimeout(250);
            await measure(`native-bring-${state}-${scheme}`);
        }
    }
    for (const e of errors) problems.push(`page error: ${e}`);
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n${states} states at ${WIDTH}dp with ${SCALE}× text, light and dark`);
if (problems.length) {
    console.log(problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
}
console.log('Every state holds: no sideways scroll, nothing past the edge or cut, buttons on the screen, text contrast passes.');
