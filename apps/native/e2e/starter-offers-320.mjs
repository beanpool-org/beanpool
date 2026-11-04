#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * What could you offer? (cold start O2, DESIGN-cold-start-trades-fable.md §3.1) at the floor (320dp wide, phone text at 1.3×),
 * in light and dark: the app's own StarterOffersSheet through react-native-web in headless Chromium, with the rows core's
 * `starterSheet` makes. A stand-in for a phone: Android's fonts and line breaks differ.
 *
 * Checks, in each state:
 * - No sideways scroll
 * - Nothing past the 320dp edge
 * - Every row and Cancel at least 44dp tall, and on the screen
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-offers-320-'));

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
    // The chevron's icon font is not here: a plain glyph stands where it draws.
    '@expo/vector-icons': `
        import React from 'react';
        import { Text } from 'react-native-web';
        export const MaterialCommunityIcons = ({ color }) => React.createElement(Text, { style: { color, fontSize: 18 } }, '›');
    `,
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { DEFAULT_PRICING_CATALOG, starterSheet } from '@beanpool/core';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { StarterOffersSheet } from ${JSON.stringify(path.join(NATIVE, 'components/home/StarterOffersSheet'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;
const STATES = {
    fallback: starterSheet([], { beans: true, guide: DEFAULT_PRICING_CATALOG }),
    starred: starterSheet(['animals', 'transport'], { beans: true, guide: DEFAULT_PRICING_CATALOG }),
    longest: starterSheet(['arts', 'tech', 'housing'], { beans: true, guide: DEFAULT_PRICING_CATALOG }),
    noguide: starterSheet(['labour'], { beans: true, guide: null }),
    global: starterSheet([], { beans: false, guide: null }),
};
createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', backgroundColor: colors.surface.app }}>
        <StarterOffersSheet visible sheet={STATES[q.get('state')]} colors={colors} onPick={() => {}} onOther={() => {}} onClose={() => {}} />
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
                return STUBS[args.path] ? { path: args.path, namespace: 'stub' } : undefined;
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

    const measure = async (label, expectRows) => {
        states++;
        const found = await page.evaluate(({ WIDTH, HEIGHT, expectRows }) => {
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
            const sheet = document.querySelector('[data-testid="starter-offers-sheet"]');
            if (!sheet) return ['no sheet was drawn'];
            const rows = [...document.querySelectorAll('[data-testid^="starter-offer-"]')];
            if (rows.length !== expectRows) out.push(`${rows.length} rows, not ${expectRows}`);
            const texts = [...sheet.querySelectorAll('div[dir], span')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = el.textContent.trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
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
            for (const el of sheet.querySelectorAll('[role="button"]')) {
                const r = el.getBoundingClientRect();
                if (r.width === 0) continue;
                const what = el.textContent.trim().slice(0, 40);
                if (r.height < 43.5) out.push(`the button "${what}" is ${Math.round(r.height)}dp tall`);
                if (r.bottom > HEIGHT + 0.5) out.push(`the button "${what}" is off the screen (${Math.round(r.bottom)} of ${HEIGHT})`);
            }
            return out;
        }, { WIDTH, HEIGHT, expectRows });
        for (const p of found) problems.push(`${label}: ${p}`);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label}.png`) }); }
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };

    for (const scheme of ['light', 'dark']) {
        for (const state of ['fallback', 'starred', 'longest', 'noguide', 'global']) {
            await page.goto(`${base}/?scheme=${scheme}&state=${state}`);
            await page.waitForTimeout(250);
            await measure(`native-starter-${state}-${scheme}`, 4);
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
console.log('Every state holds: no sideways scroll, nothing past the edge, rows and Cancel on the screen at 44dp or more, text contrast passes.');
