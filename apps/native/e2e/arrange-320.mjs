#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Arrange (DESIGN-home-layout-fable.md §3.2, slice L2) at the floor (320dp wide, phone text at 1.3×), in light and dark: the
 * app's own HomeCard, ArrangeBar, FoldedLine, ArrangeAddTile and ArrangeReset through react-native-web in headless
 * Chromium, with Done drawn as app/(tabs)/index.tsx draws it, over a list a member could hold.
 *
 * Checks: no sideways scroll; nothing past the 320dp edge; text whole; every target at least 44dp tall and every arrow as
 * wide; text contrast at least 4.5:1 (3:1 for large text); the list's height. Screenshots with --shots <dir>.
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'arrange-320-'));

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
    // The real icon font isn't here: the arrows are drawn as what they are, so the pictures show them.
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
import { View, ScrollView, Text, Pressable } from 'react-native';
import { ARRANGE_WORDS, homeCardType, t } from '@beanpool/core';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { HomeCard } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};
import { ArrangeAddTile, ArrangeBar, ArrangeReset, FoldedLine } from ${JSON.stringify(path.join(NATIVE, 'components/home/ArrangeParts'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;

const noop = () => {};
const line = (type) => t(homeCardType(type).line);
const CARDS = [
    { id: 'needs', caption: 'Needs you', hue: 'amber', accent: true, stays: true, line: line('needs') },
    { id: 'steps', caption: 'First steps', hue: 'sky', line: line('steps'), first: true },
    { id: 'tips', caption: 'Tips', hue: 'indigo', line: line('tips') },
    { id: 'events', caption: 'Coming up', hue: 'violet', line: line('events') },
    { id: 'market', caption: 'New in the Market', hue: 'orange', line: line('market') },
    { id: 'search-a', caption: 'Needs · second hand bicycles', hue: 'orange', line: line('search') },
    { id: 'decide', caption: 'Decide', hue: 'plum', line: 'Nothing to show now', idle: true },
    { id: 'sky', caption: 'Sun and moon', hue: 'yellow', line: 'Nothing to show now: no place is known.', idle: true, settings: true, last: true },
];
const COMMUNITY = { id: 'community', caption: 'Byron Shire BeanPool', hue: 'sage', stays: true, line: line('community') };

const Card = ({ c }) => (
    <HomeCard id={c.id} caption={c.caption} colors={colors} hue={c.hue} accent={c.accent} testID={'home-card-' + c.id}
        arrange={c.stays ? { label: c.caption, stays: true } : { label: c.caption, canUp: !c.first, canDown: !c.last, onMove: noop }}>
        <FoldedLine id={c.id} text={c.line} colors={colors}
            settings={c.settings ? { a11y: 'Settings for ' + c.caption, onPress: noop } : undefined}
            remove={c.idle ? { a11y: 'Remove ' + c.caption + ' from Home', onPress: noop } : undefined} />
    </HomeCard>
);

createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', backgroundColor: colors.surface.page }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 110, paddingTop: 8 }}>
            <View testID="arrange-list">
                <ArrangeBar colors={colors} notOnAccount={q.get('account') === 'no' ? "Your community's server needs an update before your cards follow you to other devices." : null} />
                {CARDS.map(c => <Card key={c.id} c={c} />)}
                <ArrangeAddTile colors={colors} onPress={noop} />
                <Card c={COMMUNITY} />
                <ArrangeReset colors={colors} onPress={noop} />
            </View>
        </ScrollView>
        <Pressable accessibilityRole="button" accessibilityLabel={t(ARRANGE_WORDS.done)} testID="home-arrange-done"
            style={{ position: 'absolute', bottom: 32, right: 24, paddingVertical: 14, paddingHorizontal: 20, borderRadius: 28, backgroundColor: colors.action.fab, zIndex: 100 }}>
            <Text style={{ color: colors.text.inverse, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 }}>{t('Done')}</Text>
        </Pressable>
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

    for (const scheme of ['light', 'dark']) {
        for (const account of ['yes', 'no']) {
            const label = `arrange-${scheme}${account === 'no' ? '-not-on-account' : ''}`;
            await page.goto(`${base}/?scheme=${scheme}&account=${account}`);
            await page.getByTestId('arrange-list').waitFor();
            await page.waitForTimeout(250);
            const { found, tall } = await page.evaluate(({ WIDTH }) => {
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
                    let under = { r: 255, g: 255, b: 255, a: 1 };
                    for (const l of layers.reverse()) under = over(l, under);
                    return under;
                };
                if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
                for (const el of document.querySelectorAll('div[dir], span')) {
                    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                    if (el.getAttribute('aria-hidden') === 'true') continue;
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    const what = el.textContent.trim().slice(0, 48);
                    if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
                    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`"${what}" is cut on the right (${el.scrollWidth} > ${el.clientWidth})`);
                    const cs = getComputedStyle(el);
                    const fg = rgb(cs.color);
                    if (!fg) continue;
                    const under = backdrop(el);
                    const [a, b] = [lum(over(fg, under)), lum(under)].sort((x, y) => y - x);
                    const ratio = (a + 0.05) / (b + 0.05);
                    const size = parseFloat(cs.fontSize);
                    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                    if (ratio < (large ? 3 : 4.5)) out.push(`"${what}" has contrast ${ratio.toFixed(2)}:1 (${cs.color} on rgb(${Math.round(under.r)},${Math.round(under.g)},${Math.round(under.b)}), ${size}px)`);
                }
                for (const el of document.querySelectorAll('[role="button"]')) {
                    const r = el.getBoundingClientRect();
                    const name = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40);
                    if (r.height < 43.5) out.push(`the button "${name}" is ${Math.round(r.height)}dp tall`);
                    if (/^Move /.test(name) && r.width < 43.5) out.push(`the arrow "${name}" is ${Math.round(r.width)}dp wide`);
                }
                return { found: out, tall: Math.round(document.querySelector('[data-testid="arrange-list"]').getBoundingClientRect().height) };
            }, { WIDTH });
            for (const p of found) problems.push(`${label}: ${p}`);
            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await page.screenshot({ path: path.join(SHOTS, `${label}.png`) });
                await page.evaluate(() => { for (const el of document.querySelectorAll('div')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = el.scrollHeight; });
                await page.waitForTimeout(100);
                await page.screenshot({ path: path.join(SHOTS, `${label}-end.png`) });
            }
            console.log(`${found.length ? '✗' : '✓'} ${label}: nine folded cards, the tile and Reset stand ${tall}dp tall${found.length ? `; ${found.length} problem(s)` : ''}`);
        }
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
    console.log(problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
}
