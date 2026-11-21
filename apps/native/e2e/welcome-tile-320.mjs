#!/usr/bin/env node
/* global process, console, document, location */
/**
 * (S5, scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.1-§4.4) The WELCOME TO BEANPOOL! tile, its band after
 * seven days, the global community's lines, and First steps as a tick list, at 320dp wide with the phone's text at 1.3×,
 * light and dark: node apps/native/e2e/welcome-tile-320.mjs --shots <dir>
 *
 * The app's own WelcomeTile, HomeCard and StepsBody through react-native-web in headless Chromium (as home-look-s2-320.mjs).
 * Checks: no sideways scroll, text inside 320dp, the tile's two buttons at least 48dp tall. The pixels of the real phone are
 * the emulator walk's.
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
const HEIGHT = 900;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-tile-'));

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
        const GLYPHS = { 'swap-horizontal': '⇄', 'scale-balance': '⚖', 'circle-outline': '◯', 'account-group-outline': '☺', 'map-marker-radius-outline': '⌖' };
        export const MaterialCommunityIcons = ({ name, size, color }) => React.createElement('span', { 'aria-hidden': true, style: { color, fontSize: size, fontWeight: 900, lineHeight: size + 'px' } }, GLYPHS[name] || '•');
    `,
    'expo-router': `export const router = { push() {}, navigate() {} };`,
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView } from 'react-native';
import { welcomeTileLines, t } from '@beanpool/core';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { HomeCard } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};
import { WelcomeTile } from ${JSON.stringify(path.join(NATIVE, 'components/home/WelcomeTile'))};
import { StepsBody } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeCardBodies'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;
const view = q.get('view');
const noop = () => {};
const lines = [
    { id: 'photo', text: 'Add a photo', done: true },
    { id: 'offer', text: 'Post your first Offer', done: false },
    { id: 'interests', text: 'Pick a few things you like', done: false },
    { id: 'notify', text: 'Hear when someone answers you', done: false },
];
const tile = (shape, profile, beans) => (
    <WelcomeTile shape={shape} place={profile === 'global' ? "You're in the global community" : "You're in Riverside."}
        lines={welcomeTileLines({ profile, beans })} tourLabel={t('Show me around')} colors={colors} onTour={noop} onGotIt={noop} />
);
const body = view === 'band' ? tile('band', 'local', true)
    : view === 'global' ? tile('full', 'global', false)
    : view === 'steps' ? (
        <HomeCard id="steps" caption="FIRST STEPS" colors={colors} hue="sky" testID="home-card-steps">
            <StepsBody lines={lines} left={lines.filter(l => !l.done)} count={t('{n} of {m} done', { n: 1, m: 4 })} colors={colors} onStep={noop} />
        </HomeCard>
    )
    : tile('full', 'local', true);
createRoot(document.getElementById('root')).render(
    <View style={{ minHeight: '100vh', backgroundColor: colors.surface.page }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 12 }}>
            <View testID="shot-list">{body}</View>
        </ScrollView>
    </View>,
);
`);

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.png': 'empty', '.ttf': 'empty', '.webp': 'empty', '.jpg': 'empty', '.gif': 'empty', '.svg': 'empty', '.otf': 'empty' },
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
    for (const view of ['tile', 'band', 'global', 'steps']) {
        for (const scheme of ['light', 'dark']) {
            const label = `welcome-tile-${view}-${scheme}`;
            await page.goto(`${base}/?scheme=${scheme}&view=${view}`);
            await page.getByTestId('shot-list').first().waitFor({ timeout: 8000 }).catch((e) => { console.log(problems.join('\n')); throw e; });
            await page.waitForTimeout(300);
            const found = await page.evaluate(({ WIDTH }) => {
                const out = [];
                if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
                for (const el of document.querySelectorAll('div[dir], span')) {
                    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${el.textContent.trim().slice(0, 40)}" runs past the edge (${Math.round(r.left)}-${Math.round(r.right)})`);
                }
                for (const id of ['home-start-look', 'home-start-skip', 'home-welcome-band-open']) {
                    const b = document.querySelector(`[data-testid="${id}"]`);
                    if (b && b.getBoundingClientRect().height < 47.5) out.push(`${id} is ${Math.round(b.getBoundingClientRect().height)}dp tall`);
                }
                return out;
            }, { WIDTH });
            for (const p of found) problems.push(`${label}: ${p}`);
            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await page.screenshot({ path: path.join(SHOTS, `${label}.png`), fullPage: true });
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
