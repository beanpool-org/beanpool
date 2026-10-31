#!/usr/bin/env node
/* global process, console, document */
/**
 * The phone map's event pin beside an Offer's and a Need's (Marty, 31 Oct: events join the listings' pins and clusters),
 * at the floor (320dp wide), on a light and a dark map: components/UnifiedMapPin.tsx's PinVisual — what the off-screen
 * capture rasterises into each pin's image — drawn through react-native-web in headless Chromium, once at its own size
 * and once enlarged 1.7× to look at.
 *
 * A stand-in for the phone, not an emulator: Android's emoji font and Google Maps' drawing of the image differ, and the
 * capture itself (react-native-view-shot) is not run. Nothing leaves the machine: the page aborts every request but its
 * own. The browser: run `pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium` once.
 *
 *   node apps/native/e2e/map-event-pin-320.mjs --shots <dir>
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
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'map-event-pin-320-'));

// The capture is not run here: UnifiedMapPin imports it at load.
const STUBS = { 'react-native-view-shot': 'export const captureRef = async () => "";' };

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { PinVisual, buildVariantList, PIN_RENDER_W, PIN_RENDER_H } from ${JSON.stringify(path.join(NATIVE, 'components/UnifiedMapPin'))};
import { POST_CATEGORIES } from ${JSON.stringify(path.join(NATIVE, 'constants/categories'))};

const dark = new URLSearchParams(location.search).get('scheme') === 'dark';
// The ground of the map behind the pins: Google's light map, and map.tsx's dark style (its geometry colour).
const ground = dark ? '#242f3e' : '#e8eaed';
const ink = dark ? '#f3f4f6' : '#1c1d1a';
// The three pins as the map's variant list makes them: an Offer of food, a Need for tools, an event.
const variants = buildVariantList(
    [{ type: 'offer', category: 'food' }, { type: 'need', category: 'tools' }, { type: 'event', category: 'community' }],
    POST_CATEGORIES,
);
const [offer, need] = variants.filter((v) => !v.glyph);
const event = variants.find((v) => v.glyph);
const pins = [['Offer', offer], ['Need', need], ['Event', event]];
const Row = ({ scale }) => (
    <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12 }}>
        {pins.map(([label, v]) => (
            <View key={label} style={{ alignItems: 'center' }}>
                <View style={{ width: PIN_RENDER_W * scale, height: PIN_RENDER_H * scale }}>
                    <View data-pin={label} style={{ width: PIN_RENDER_W, height: PIN_RENDER_H, transform: [{ scale }], transformOrigin: 'top left' }}>
                        <PinVisual emoji={v.emoji} bgColor={v.bgColor} isElder={v.isElder} glyph={v.glyph} />
                    </View>
                </View>
                <Text style={{ color: ink, fontSize: 12, marginTop: 4 }}>{label}</Text>
            </View>
        ))}
    </View>
);
createRoot(document.getElementById('root')).render(
    <View style={{ width: ${WIDTH}, backgroundColor: ground, paddingVertical: 8 }}>
        <Text style={{ color: ink, fontSize: 12, paddingHorizontal: 16 }}>At their own size (56dp)</Text>
        <Row scale={1} />
        <Text style={{ color: ink, fontSize: 12, paddingHorizontal: 16 }}>Enlarged 1.7x to look at</Text>
        <Row scale={1.7} />
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
    alias: { 'react-native': 'react-native-web' },
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"' },
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
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 360 }, deviceScaleFactor: 2 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    for (const scheme of ['light', 'dark']) {
        await page.goto(`${base}/?scheme=${scheme}`);
        await page.waitForSelector('[data-pin="Event"] svg');
        const found = await page.evaluate((WIDTH) => {
            const out = [];
            if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
            const pins = [...document.querySelectorAll('[data-pin]')];
            const event = pins.filter((p) => p.getAttribute('data-pin') === 'Event');
            for (const p of event) {
                if (p.textContent.trim() !== '') out.push(`the event pin holds words or an emoji: "${p.textContent.trim()}"`);
                if (p.querySelectorAll('svg path').length !== 1) out.push('the event pin is not the one teardrop');
            }
            for (const p of pins.filter((x) => x.getAttribute('data-pin') !== 'Event')) {
                if (p.textContent.trim() === '') out.push(`the ${p.getAttribute('data-pin')} pin lost its emoji`);
            }
            const fills = pins.map((p) => `${p.getAttribute('data-pin')}=${p.querySelector('svg path')?.getAttribute('fill')}`);
            return { out, fills };
        }, WIDTH);
        problems.push(...found.out.map((p) => `${scheme}: ${p}`));
        console.log(`${scheme}: pins ${found.fills.slice(0, 3).join(', ')}`);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            const file = path.join(SHOTS, `map-event-pin-320-${scheme}.png`);
            await page.locator('#root > div').screenshot({ path: file });
            console.log(`  shot: ${file}`);
        }
    }
    if (errors.length) problems.push(...errors.map((e) => `page error: ${e}`));
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}
if (problems.length) {
    console.error(`FAILED:\n  ${problems.join('\n  ')}`);
    process.exit(1);
}
console.log('ok: the event pin is the listings\' teardrop with a calendar and no emoji, at 320dp, light and dark (a stand-in, not a phone)');
