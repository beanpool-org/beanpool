#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * The phone map's list of a bubble (components/MapStackList.tsx; Marty, 2 Nov), at the floor: 320 dp wide with text at
 * 1.3×, light and dark, drawn through react-native-web in headless Chromium over a stand-in for the map. Reports anything
 * past the screen's edge, a button under 44 dp, or a row whose words are cut by their own box.
 *
 * A stand-in for the phone, not an emulator: Android's fonts and line breaking differ, and react-native-web ignores font
 * scale, so Text is wrapped here to scale its size by 1.3. Nothing leaves the machine: the page aborts every request but
 * its own. The browser: run `pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium` once.
 *
 *   node apps/native/e2e/map-stack-list-320.mjs --shots <dir>
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
const WIDTH = 320;
const HEIGHT = 568;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'map-stack-list-320-'));

const shim = path.join(work, 'rn-shim.js');
fs.writeFileSync(shim, `
import * as RNW from 'react-native-web';
import { createElement, forwardRef } from 'react';
export * from 'react-native-web';
const SCALE = 1.3;
export const Text = forwardRef((props, ref) => {
    const s = RNW.StyleSheet.flatten(props.style) || {};
    const style = { ...s, fontSize: (s.fontSize || 14) * SCALE, ...(s.lineHeight ? { lineHeight: s.lineHeight * SCALE } : {}) };
    return createElement(RNW.Text, { ...props, style, ref });
});
`);

const STUBS = {
    '../app/ThemeContext': `
        import { darkColors, lightColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
        const dark = new URLSearchParams(location.search).get('scheme') === 'dark';
        const value = { theme: dark ? 'dark' : 'light', colors: dark ? darkColors : lightColors };
        export const useTheme = () => value;
        export const useStyles = (make) => make(value);`,
    'expo-image': `
        import { createElement } from 'react';
        import { Image as RNImage } from 'react-native';
        export const Image = ({ source, style }) => createElement(RNImage, { source, style });`,
    '../utils/photo-refresh': 'export const refreshListingAfterPhotoError = () => {};',
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { MapStackList } from ${JSON.stringify(path.join(NATIVE, 'components/MapStackList'))};
const dark = new URLSearchParams(location.search).get('scheme') === 'dark';
const HOUR = 3600000;
const iso = (h) => new Date(Date.now() + h * HOUR).toISOString();
const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#7fb069"/><circle cx="40" cy="40" r="20" fill="#f4d35e"/></svg>');
const ev = (id, title, h, extra = {}) => ({ id, type: 'event', status: 'active', title, category: 'community', event_state: 'scheduled', event_start_at: iso(h), event_end_at: iso(h + 2), lat: -28.69, lng: 153.52, ...extra });
const listing = (id, type, title, extra = {}) => ({ id, type, status: 'active', title, category: type === 'offer' ? 'food' : 'tools', created_at: iso(-24), lat: -28.69, lng: 153.52, ...extra });
const posts = [
    ev('a', 'Bangalow Hall working bee and a shared lunch for everyone in the valley who wants to help out', 26, { event_place_name: 'Bangalow Hall', photos: [photo] }),
    ev('b', 'Repair café', 50),
    ev('c', 'Seed swap', 74, { event_tz: 'Australia/Sydney' }),
    listing('d', 'offer', 'A dozen duck eggs, collected this morning, from a very small flock', { photos: [photo] }),
    listing('e', 'need', 'A ladder'),
    listing('f', 'offer', 'Lemons'),
];
createRoot(document.getElementById('root')).render(
    <View style={{ width: ${WIDTH}, height: ${HEIGHT}, backgroundColor: dark ? '#242f3e' : '#e8eaed', overflow: 'hidden' }}>
        <MapStackList posts={posts} onOpen={() => {}} onClose={() => {}} />
    </View>,
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
    alias: { 'react-native': shim },
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"', global: 'globalThis' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {} };' },
    logLevel: 'error',
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => (STUBS[args.path] && args.namespace !== 'stub' ? { path: args.path, namespace: 'stub' } : undefined));
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js', resolveDir: NATIVE }));
        },
    }],
});
const bundle = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<style>html,body{margin:0} body{font-family:sans-serif}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const problems = [];
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1.5 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    for (const scheme of ['light', 'dark']) {
        await page.goto(`${base}/?scheme=${scheme}`);
        await page.waitForSelector('[data-testid="map-stack-list"]', { timeout: 15000 }).catch((e) => {
            throw new Error(`${e.message}\npage errors: ${errors.join('\n') || 'none'}`);
        });
        const found = await page.evaluate((WIDTH) => {
            const out = [];
            if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
            const panel = document.querySelector('[data-testid="map-stack-list"]');
            for (const el of panel.querySelectorAll('[role="button"]')) {
                const r = el.getBoundingClientRect();
                if (r.height < 44) out.push(`a button is ${r.height}px tall: ${el.getAttribute('aria-label')}`);
                if (r.right > WIDTH + 0.5) out.push(`a button runs past the edge: ${el.getAttribute('aria-label')}`);
            }
            for (const el of panel.querySelectorAll('[dir="auto"]')) {
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                if (r.right > WIDTH + 0.5) out.push(`words past the edge: ${el.textContent}`);
                const cutsOnPurpose = s.webkitLineClamp !== 'none' || s.textOverflow === 'ellipsis';
                if (!cutsOnPurpose && el.scrollWidth > el.clientWidth + 1) out.push(`words cut: ${el.textContent}`);
            }
            return { out, rows: panel.querySelectorAll('[role="button"]').length - 1, heading: panel.querySelector('[role="heading"]')?.textContent };
        }, WIDTH);
        problems.push(...found.out.map((p) => `${scheme}: ${p}`));
        console.log(`${scheme}: "${found.heading}", ${found.rows} rows`);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `map-stack-list-320-${scheme}.png`) });
        }
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('map-stack-list-320: nothing past the edge, every button 44 dp, no words cut');
