#!/usr/bin/env node
/* global process, console, document, location */
/**
 * (home-look-s2) Home's colour by what a card is about, and the dot before a card is on Home, at 320dp wide with the
 * phone's text at 1.3×, light and dark: node apps/native/e2e/home-look-s2-320.mjs --shots <dir>
 *
 * The app's own HomeCard, FoldedLine and AddCardSheet through react-native-web in headless Chromium (as arrange-320.mjs).
 * Checks: no sideways scroll, text inside 320dp, and every picker row's dot is 10dp and leaves its name at least 140dp.
 * Screenshots: home (the cards), arrange (the same cards folded), picker (Add a card), each light and dark.
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
const HEIGHT = 700;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'home-look-s2-'));

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
        export default { ...RNW, Text, Platform };
    `,
    'react-native-safe-area-context': `
        export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
    `,
    '@expo/vector-icons': `
        import React from 'react';
        const GLYPHS = { 'arrow-up': '↑', 'arrow-down': '↓', 'dots-horizontal': '…' };
        export const MaterialCommunityIcons = ({ name, size, color, style }) => React.createElement('span', { 'aria-hidden': true, style: { color, fontSize: size, fontWeight: 900, ...(style || {}) } }, GLYPHS[name] ?? '');
    `,
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView, Text } from 'react-native';
import { homeCardHue, searchFromMarket } from '@beanpool/core';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { HomeCard } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};
import { FoldedLine } from ${JSON.stringify(path.join(NATIVE, 'components/home/ArrangeParts'))};
import { AddCardSheet } from ${JSON.stringify(path.join(NATIVE, 'components/home/AddCardSheet'))};
import { pickerGroups } from ${JSON.stringify(path.join(NATIVE, 'utils/home-cards'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;
const view = q.get('view');
const noop = () => {};

// A search saved from the Market with a category arrives in that category's colour (searchFromMarket, then homeCardHue).
const saved = (id, words, category) => {
    const settings = searchFromMarket({ q: words, category, kind: 'offer' });
    return { id, caption: 'Offers · ' + words, hue: homeCardHue({ type: 'search', settings }), line: 'Listings that match words you choose, near you.' };
};
const chat = (id, name, kind) => ({ id, caption: name, hue: homeCardHue({ type: 'chat', settings: { conversationId: id, kind, name } }), line: 'The last lines of this chat.' });
const CARDS = [
    saved('search-garden', 'seedlings', 'garden'),
    saved('search-food', 'duck eggs', 'food'),
    saved('search-housing', 'spare room', 'housing'),
    saved('search-tech', 'phone repair', 'tech'),
    saved('search-none', 'bicycles', undefined),
    chat('chat-dm', 'Sam', 'dm'),
    chat('chat-group', 'Garden group', 'group'),
    chat('chat-event', 'Seed swap', 'event'),
    chat('chat-ent', 'The bakery', 'enterprise'),
];

const home = (folded) => (
    <View style={{ height: '100vh', backgroundColor: colors.surface.page }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40, paddingTop: 8 }}>
            <View testID="shot-list">
                {CARDS.map((c, i) => (
                    <HomeCard key={c.id} id={c.id} caption={c.caption} colors={colors} hue={c.hue} testID={'home-card-' + c.id} onMenu={folded ? undefined : noop}
                        arrange={folded ? { label: c.caption, canUp: i > 0, canDown: i < CARDS.length - 1, onMove: noop } : undefined}>
                        {folded ? <FoldedLine id={c.id} text={c.line} colors={colors} /> : <Text style={{ color: colors.text.secondary, fontSize: 13 }}>{c.line}</Text>}
                    </HomeCard>
                ))}
            </View>
        </ScrollView>
    </View>
);

const { groups } = pickerGroups({ profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } }, null, 'admin');
const picker = (
    <View style={{ height: '100vh', backgroundColor: colors.surface.page }} testID="shot-list">
        <AddCardSheet visible groups={groups} full={false} colors={colors} onAdd={noop} onClose={noop} />
    </View>
);

createRoot(document.getElementById('root')).render(view === 'picker' ? picker : home(view === 'arrange'));
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
            b.onResolve({ filter: /.*/ }, (args) => (args.namespace !== 'stub' && STUBS[args.path] ? { path: args.path, namespace: 'stub' } : undefined));
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
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e}`));
    for (const view of ['home', 'arrange', 'picker']) {
        for (const scheme of ['light', 'dark']) {
            const label = `home-look-s2-${view}-${scheme}`;
            await page.goto(`${base}/?scheme=${scheme}&view=${view}`);
            await page.getByTestId(view === 'picker' ? 'add-card-sheet' : 'shot-list').first().waitFor({ timeout: 8000 }).catch((e) => { console.log(problems.join('\n')); throw e; });
            await page.waitForTimeout(300);
            const found = await page.evaluate(({ WIDTH, view }) => {
                const out = [];
                if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
                for (const el of document.querySelectorAll('div[dir], span')) {
                    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${el.textContent.trim().slice(0, 40)}" runs past the edge (${Math.round(r.left)}-${Math.round(r.right)})`);
                }
                if (view === 'picker') {
                    const dots = document.querySelectorAll('[data-testid^="add-card-"][data-testid$="-dot"]');
                    if (dots.length < 10) out.push(`only ${dots.length} dots drawn`);
                    for (const dot of dots) {
                        const d = dot.getBoundingClientRect();
                        const id = dot.getAttribute('data-testid');
                        if (Math.round(d.width) !== 10 || Math.round(d.height) !== 10) out.push(`${id} is ${d.width}x${d.height}`);
                        // The name row's width is the room the name has, with the dot and its 8dp gap taken off.
                        const room = dot.parentElement.getBoundingClientRect().width - 10 - 8;
                        if (room < 140) out.push(`${id}: the name has ${Math.round(room)}dp, under 140`);
                    }
                }
                return out;
            }, { WIDTH, view });
            for (const p of found) problems.push(`${label}: ${p}`);
            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await page.screenshot({ path: path.join(SHOTS, `${label}.png`) });
            }
            console.log(`${found.length ? 'x' : 'ok'} ${label}${found.length ? `; ${found.length} problem(s)` : ''}`);
        }
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
    console.log(problems.map((p) => `  x ${p}`).join('\n'));
    process.exit(1);
}
