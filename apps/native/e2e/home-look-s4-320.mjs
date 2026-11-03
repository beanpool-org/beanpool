#!/usr/bin/env node
/* global process, console, document, location, getComputedStyle */
/**
 * (home-look-s4) The phone's dark card lifts off the doodle wallpaper: Home's cards on the real doodle tile at 320dp wide
 * with the phone's text at 1.3×, light and dark, with main's tokens ("before") and this branch's ("after"):
 * node apps/native/e2e/home-look-s4-320.mjs --shots <dir>
 *
 * The app's own HomeCard through react-native-web in headless Chromium (as home-look-s2-320.mjs), over
 * assets/images/pattern-<theme>.webp laid at its 890dp size on ThemeContext's pattern ground. One card holds a sunken
 * row (surface.subtle) and a divider (border.default), so the shots show what the card change does to them.
 * Checks: no sideways scroll, text inside 320dp, and every card draws in the tokens' surface.card.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(HERE, '..');
const ROOT = path.resolve(NATIVE, '../..');
const SCALE = 1.3;
const WIDTH = 320;
const HEIGHT = 760;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'home-look-s4-'));
// "Before": main's colour tokens, beside this tree's, so one run shows both.
// It imports only @beanpool/core, which resolves through nodePaths, so it can sit in the throwaway folder.
const mainColors = path.join(work, 'colors-main.ts');
fs.writeFileSync(mainColors, execFileSync('git', ['show', 'origin/main:apps/native/constants/colors.ts'], { cwd: ROOT }));

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
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { lightColors as mainLight, darkColors as mainDark } from ${JSON.stringify(mainColors)};
import { HomeCard } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};

const q = new URLSearchParams(location.search);
const dark = q.get('scheme') === 'dark';
const colors = q.get('tokens') === 'main' ? (dark ? mainDark : mainLight) : (dark ? darkColors : lightColors);
window.__card = colors.surface.card;
const noop = () => {};

const CARDS = [
    { id: 'needs', caption: 'Needs you', hue: 'sage', lines: ['Nothing waits on you.'] },
    { id: 'events', caption: 'Coming up', hue: 'violet', lines: ['THU 5 NOV · 7:00', 'Seed swap at the hall'] },
    { id: 'market', caption: 'New in the Market', hue: 'orange', lines: ['Duck eggs · 4 Beans', 'Spare room · Need'], sunken: true },
    { id: 'groups', caption: 'Your groups', hue: 'rose', lines: ['Brunswick Heads · quiet', 'Byron Bay · quiet'] },
    { id: 'beans', caption: 'Your Beans', hue: 'green', lines: ['12 Beans'] },
    { id: 'tips', caption: 'Tips', hue: 'indigo', lines: ['Hold a card to move it.'] },
];

createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', backgroundColor: 'transparent' }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40, paddingTop: 8 }}>
            <View testID="shot-list">
                {CARDS.map((c) => (
                    <HomeCard key={c.id} id={c.id} caption={c.caption} colors={colors} hue={c.hue} testID={'home-card-' + c.id} onMenu={noop}>
                        {c.lines.map((l, i) => (
                            <View key={i} style={{ paddingVertical: 4, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border.default }}>
                                <Text style={{ color: i ? colors.text.secondary : colors.text.body, fontSize: 15 }}>{l}</Text>
                            </View>
                        ))}
                        {c.sunken ? (
                            <View testID="sunken-row" style={{ marginTop: 8, padding: 8, borderRadius: 10, backgroundColor: colors.surface.subtle }}>
                                <Text style={{ color: colors.text.muted, fontSize: 13 }}>A sunken row (surface.subtle)</Text>
                            </View>
                        ) : null}
                    </HomeCard>
                ))}
            </View>
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

const GROUND = /const PATTERN_GROUND = \{ light: '(#[0-9a-f]{6})', dark: '(#[0-9a-f]{6})' \}/.exec(fs.readFileSync(path.join(NATIVE, 'app/ThemeContext.tsx'), 'utf8'));
const html = (scheme) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<script>window.process = window.process || { env: {} }; window.global = window;</script>
<style>html,body,#root{margin:0;height:100%} body{font-family:sans-serif;
background:${scheme === 'dark' ? GROUND[2] : GROUND[1]} url(/tile-${scheme}.webp) repeat; background-size:890px 890px}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    const tile = /^\/tile-(light|dark)\.webp$/.exec(req.url);
    if (tile) { res.writeHead(200, { 'Content-Type': 'image/webp' }); res.end(fs.readFileSync(path.join(NATIVE, `assets/images/pattern-${tile[1]}.webp`))); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html(new URL(req.url, 'http://x').searchParams.get('scheme')));
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
    for (const tokens of ['main', 'branch']) {
        for (const scheme of ['light', 'dark']) {
            const label = `home-look-s4-${scheme}-${tokens === 'main' ? 'before' : 'after'}`;
            await page.goto(`${base}/?scheme=${scheme}&tokens=${tokens}`);
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
                const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
                const cards = ['needs', 'events', 'market', 'groups', 'beans', 'tips'].map((id) => document.querySelector(`[data-testid="home-card-${id}"]`)).filter(Boolean);
                if (cards.length < 6) out.push(`only ${cards.length} cards drawn`);
                for (const card of cards) {
                    const bg = hex(getComputedStyle(card).backgroundColor);
                    if (bg !== window.__card) out.push(`${card.getAttribute('data-testid')} draws ${bg}, not surface.card ${window.__card}`);
                }
                return out;
            }, { WIDTH });
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
