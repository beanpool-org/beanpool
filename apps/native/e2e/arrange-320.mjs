#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Arrange in place (DESIGN-home-arrange-in-place-fable.md, slice A3) at the floor (320dp wide, phone text at 1.3×), in light
 * and dark: the app's own HomeCard, ArrangeBar, ArrangeStrip, ArrangeAddTile and ArrangeReset through react-native-web in
 * headless Chromium, with Done drawn as app/(tabs)/index.tsx draws it, over one list of cards drawn twice: as Home, and as Arrange.
 *
 * Checks, per theme:
 *  - **No drawn card changes its cell when Arrange opens** (a red check, not a tolerance): every card's left, width, height and
 *    its top inside the list are the same in Arrange as on Home (the bar stands above the list; only the community card, which
 *    comes after the strip and the tile, sits lower).
 *  - no sideways scroll; nothing past the 320dp edge; text whole; every target at least 44dp tall and every arrow as wide;
 *  - text contrast at least 4.5:1, and at least 3:1 for the cards' dimmed insides (inactive, so exempt from 4.5:1, but readable);
 *  - what Arrange adds to Home's height (the bar and the strip, the tile and Reset).
 * Screenshots with --shots <dir>: home-<scheme>, arrange-<scheme> (and -end, scrolled to the bottom).
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
import { ARRANGE_WORDS, t } from '@beanpool/core';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { HomeCard, HomeRow, HomeLink, HomeButton, homeStyles } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};
import { ArrangeAddTile, ArrangeBar, ArrangeReset, ArrangeStrip } from ${JSON.stringify(path.join(NATIVE, 'components/home/ArrangeParts'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;
const arrange = q.get('view') === 'arrange';
const s = homeStyles(colors);
const noop = () => {};

const thumb = () => <View style={[s.thumb, s.thumbEmpty]} />;
const row = (text, sub) => <HomeRow colors={colors} text={text} sub={sub} a11y={text} onPress={noop} left={thumb()} right={<Text style={s.trailing}>›</Text>} />;
const line = (text) => <HomeRow colors={colors} text={text} a11y={text} onPress={noop} />;

// Home as a member of the worldwide community can hold it: the cards that have something to say, in their saved order.
const CARDS = [
    { id: 'needs', caption: 'Needs you', hue: 'amber', accent: true, stays: true, body: <>{line('Kofi sent you a message')}{line('Your event "Seed swap" has 3 new answers')}</> },
    { id: 'steps', caption: 'First steps', hue: 'sky', body: <>{line('Choose a name')}{line('Say roughly where you are')}{line('Add a picture (a preset counts)')}</> },
    { id: 'tips', caption: 'Tips · 4 of 15', hue: 'indigo', body: <><Text style={s.note}>You can hold a card on Home to arrange the cards you see.</Text><View style={s.buttonRow}><HomeButton colors={colors} text="Next" onPress={noop} /><HomeButton colors={colors} text="Read more" onPress={noop} /></View></> },
    { id: 'events', caption: 'Coming up', hue: 'violet', body: <>{row('Seed swap', 'Sat 7 Nov · 16:00 · Town Hall')}{row('Repair café', 'Wed 11 Nov · 10:00')}</> },
    { id: 'market', caption: 'New in the Market', hue: 'orange', tune: true, body: <>{row('Sourdough', 'OFFER · 12 Beans')}{row('Help moving a couch', 'NEED · labour')}{row('Garlic', 'OFFER · food')}<HomeLink id="market" text="See all" a11y="See all" onPress={noop} colors={colors} /></> },
    { id: 'groups', caption: 'Your groups', hue: 'teal', body: <>{row('Garden swap group', '12 members')}</> },
];
const COMMUNITY = { id: 'community', caption: 'The global community', hue: 'sage', stays: true, body: <><Text style={s.note}>81 members, 23 trades this month.</Text><HomeLink id="c1" text="Add a card" a11y="Add a card to Home" onPress={noop} colors={colors} /><HomeLink id="c2" text="Arrange" a11y="Arrange: move the cards on Home" onPress={noop} colors={colors} /></> };
// On the member's list, with nothing to show right now: the strip, in Arrange only.
const STRIP = [
    { id: 'deals', name: 'Your deals', remove: { a11y: 'Remove Your deals from Home', onPress: noop } },
    { id: 'interests', name: 'What are you into?', remove: { a11y: 'Remove What are you into? from Home', onPress: noop } },
    { id: 'tips2', name: 'Needs · second hand children\\'s bicycles near the river', remove: { a11y: 'Remove "second hand children\\'s b…" (Needs) from Home', onPress: noop } },
    { id: 'sky', name: 'Sun and moon', note: 'Nothing to show now: no place is known.', settings: { a11y: 'Settings for Sun and moon', onPress: noop }, remove: { a11y: 'Remove Sun and moon from Home', onPress: noop } },
];

const Card = ({ c, first, last }) => (
    <View testID={'wrap-' + c.id}>
        <HomeCard id={c.id} caption={c.caption} colors={colors} hue={c.hue} accent={c.accent} testID={'home-card-' + c.id}
            onMenu={c.stays || arrange ? undefined : noop}
            right={c.tune && !arrange ? <Pressable style={{ minHeight: 48, minWidth: 48, paddingHorizontal: 8, justifyContent: 'center', alignItems: 'center' }}><Text style={{ fontSize: 13, fontWeight: '700', color: colors.card.orange.ink }}>Tune</Text></Pressable> : undefined}
            arrange={arrange ? (c.stays ? { label: c.caption, stays: true } : { label: c.caption, canUp: !first, canDown: !last, onMove: noop }) : undefined}
            quiet={arrange}>
            {c.body}
        </HomeCard>
    </View>
);

createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', backgroundColor: colors.surface.page }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 110, paddingTop: 8 }}>
            <Text style={{ marginHorizontal: 16, marginBottom: 8, fontSize: 24, fontWeight: '800', color: colors.text.heading }}>Home</Text>
            {arrange && <ArrangeBar colors={colors} notOnAccount={q.get('account') === 'no' ? "Your community's server needs an update before your cards follow you to other devices." : null} />}
            <View testID="home-list">
                {CARDS.map((c, i) => <Card key={c.id} c={c} first={i === 1} last={i === CARDS.length - 1} />)}
                {arrange && <><ArrangeStrip rows={STRIP} colors={colors} /><ArrangeAddTile colors={colors} onPress={noop} /></>}
                <Card c={COMMUNITY} />
                {arrange && <ArrangeReset colors={colors} onPress={noop} />}
            </View>
        </ScrollView>
        {arrange ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t(ARRANGE_WORDS.done)} testID="home-arrange-done"
                style={{ position: 'absolute', bottom: 32, right: 24, paddingVertical: 14, paddingHorizontal: 20, borderRadius: 28, backgroundColor: colors.action.fab, zIndex: 100 }}>
                <Text style={{ color: colors.text.inverse, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 }}>{t('Done')}</Text>
            </Pressable>
        ) : (
            <Pressable accessibilityRole="button" accessibilityLabel="Add a post"
                style={{ position: 'absolute', bottom: 32, right: 24, paddingVertical: 14, paddingHorizontal: 20, borderRadius: 28, backgroundColor: colors.action.fab, zIndex: 100 }}>
                <Text style={{ color: colors.text.inverse, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 }}>+ ADD POST</Text>
            </Pressable>
        )}
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

/** Every card's box, relative to the list's own top, and the list's height: the cells Home and Arrange are each compared by. */
const boxes = () => {
    const list = document.querySelector('[data-testid="home-list"]');
    const top = list.getBoundingClientRect().top;
    const out = {};
    for (const el of document.querySelectorAll('[data-testid^="home-card-"]')) {
        if (el.getAttribute('data-testid').endsWith('-menu')) continue;
        const r = el.getBoundingClientRect();
        out[el.getAttribute('data-testid')] = { left: r.left, width: r.width, height: r.height, top: r.top - top };
    }
    const content = list.parentElement.getBoundingClientRect();
    return { cards: out, listHeight: list.getBoundingClientRect().height, above: list.getBoundingClientRect().top - content.top };
};

const browser = await chromium.launch();
const problems = [];
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e}`));

    for (const scheme of ['light', 'dark']) {
        const seen = {};
        for (const view of ['home', 'arrange']) {
            for (const account of view === 'arrange' ? ['yes', 'no'] : ['yes']) {
                const label = `${view}-${scheme}${account === 'no' ? '-not-on-account' : ''}`;
                await page.goto(`${base}/?scheme=${scheme}&view=${view}&account=${account}`);
                await page.getByTestId('home-list').waitFor();
                await page.waitForTimeout(250);
                if (account === 'yes') seen[view] = await page.evaluate(boxes);
                const { found, quietLow } = await page.evaluate(({ WIDTH, view }) => {
                    const out = [];
                    const low = [];
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
                    // How much of its colour a text keeps once the views above it are dimmed (Arrange's quiet insides).
                    const dimmed = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
                    if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
                    for (const el of document.querySelectorAll('div[dir], span')) {
                        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                        if (el.getAttribute('aria-hidden') === 'true' && !el.closest('[data-testid^="home-card-"]')) continue;
                        // A disabled arrow (the first card can't go up) is exempt from contrast, as any disabled control is.
                        if (el.closest('[aria-disabled="true"]')) continue;
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        const what = el.textContent.trim().slice(0, 48);
                        if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
                        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`"${what}" is cut on the right (${el.scrollWidth} > ${el.clientWidth})`);
                        const cs = getComputedStyle(el);
                        const fg = rgb(cs.color);
                        if (!fg) continue;
                        const o = dimmed(el);
                        const under = backdrop(el);
                        const [a, b] = [lum(over({ ...fg, a: fg.a * o }, under)), lum(under)].sort((x, y) => y - x);
                        const ratio = (a + 0.05) / (b + 0.05);
                        const size = parseFloat(cs.fontSize);
                        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                        // A dimmed inside is inactive, so exempt from 4.5:1 (WCAG 1.4.3); it must still be readable, so 3:1.
                        const need = o < 0.99 ? 3 : (large ? 3 : 4.5);
                        if (ratio < need) out.push(`"${what}" has contrast ${ratio.toFixed(2)}:1 (${cs.color} at ${o.toFixed(2)} on rgb(${Math.round(under.r)},${Math.round(under.g)},${Math.round(under.b)}), ${size}px)`);
                        if (o < 0.99) low.push(ratio);
                    }
                    for (const el of document.querySelectorAll('[role="button"]')) {
                        const r = el.getBoundingClientRect();
                        const name = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40);
                        if (r.height < 43.5) out.push(`the button "${name}" is ${Math.round(r.height)}dp tall`);
                        if (/^Move /.test(name) && r.width < 43.5) out.push(`the arrow "${name}" is ${Math.round(r.width)}dp wide`);
                    }
                    return { found: out, quietLow: low.length ? Math.min(...low) : null };
                }, { WIDTH, view });
                for (const p of found) problems.push(`${label}: ${p}`);
                if (SHOTS) {
                    fs.mkdirSync(SHOTS, { recursive: true });
                    await page.screenshot({ path: path.join(SHOTS, `${label}.png`) });
                    await page.evaluate(() => { for (const el of document.querySelectorAll('div')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = el.scrollHeight; });
                    await page.waitForTimeout(100);
                    await page.screenshot({ path: path.join(SHOTS, `${label}-end.png`) });
                    if (view === 'arrange' && account === 'yes') {
                        // The strip, from its heading down.
                        await page.evaluate(() => { document.querySelector('[data-testid="home-arrange-strip"]').scrollIntoView({ block: 'start' }); });
                        await page.waitForTimeout(100);
                        await page.screenshot({ path: path.join(SHOTS, `${label}-strip.png`) });
                    }
                }
                console.log(`${found.length ? '✗' : '✓'} ${label}${quietLow ? `: the dimmed insides read at ${quietLow.toFixed(2)}:1 or better` : ''}${found.length ? `; ${found.length} problem(s)` : ''}`);
            }
        }
        // The check the design makes red, not a tolerance: no drawn card changes its cell when Arrange opens.
        const [home, arr] = [seen.home, seen.arrange];
        const ids = Object.keys(home.cards);
        let same = 0;
        for (const id of ids) {
            const [h, a] = [home.cards[id], arr.cards[id]];
            if (!a) { problems.push(`${scheme}: ${id} is not drawn in Arrange`); continue; }
            // The community card comes after the strip and the tile: it keeps its size and column, and sits lower.
            const keys = id === 'home-card-community' ? ['left', 'width', 'height'] : ['left', 'width', 'height', 'top'];
            const moved = keys.filter((k) => Math.abs(h[k] - a[k]) > 0.01);
            if (moved.length) problems.push(`${scheme}: ${id} changed its cell when Arrange opened (${moved.map((k) => `${k} ${h[k]} -> ${a[k]}`).join(', ')})`);
            else same++;
        }
        const barH = arr.above - home.above;
        const community = arr.cards['home-card-community'].top - home.cards['home-card-community'].top;
        console.log(`${same === ids.length ? '✓' : '✗'} ${scheme}: ${same} of ${ids.length} cards keep their cell in Arrange; the bar adds ${barH.toFixed(1)}dp above them, the strip and the tile ${community.toFixed(1)}dp before the community card; Home ${home.listHeight.toFixed(0)}dp tall, Arrange ${arr.listHeight.toFixed(0)}dp`);
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
