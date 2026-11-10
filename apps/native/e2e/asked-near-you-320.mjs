#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * "Asked near you" and First steps' line "Ask for one thing you'd pay a neighbour for" (cold-start N2) at the floor (320dp wide,
 * phone text at 1.3×), in light and dark: the app's own AskedBody and StepsBody, inside HomeCard, through react-native-web in
 * headless Chromium. A stand-in for the phone, not the phone: Android's fonts and line breaking differ, and a photo does not
 * draw (the Needs here have none, so every row shows its category tile).
 *
 * Checks, per theme: no sideways scroll; nothing past the 320dp edge; every row and link at least 44dp tall; no title cut
 * without wrapping whole; the rows' second line reads "20.50 Beans /Hr · 2h ago" (the Home answer's price_c, whole hundredths).
 * Your Beans (BeansBody) with the widest figures the card writes (1,234.56 held, this month's in and out): both its rows
 * inside the card, 44dp, no words cut. Screenshots with --shots <dir>: asked-<scheme>, steps-<scheme>, beans-<scheme>.
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
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'asked-320-'));

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
    '@expo/vector-icons': `
        import React from 'react';
        export const MaterialCommunityIcons = ({ name, size, color, style }) => React.createElement('span', { 'aria-hidden': true, style: { color, fontSize: size, fontWeight: 900, ...(style || {}) } }, name === 'dots-horizontal' ? '…' : '');
    `,
    'expo-router': `export const router = { push() {}, navigate() {}, replace() {} }; export const useLocalSearchParams = () => ({});`,
    'expo-image': `import React from 'react'; export const Image = (p) => React.createElement('img', { src: p.source?.uri, alt: '' });`,
    '@react-native-async-storage/async-storage': `export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };`,
    'expo-secure-store': `export const getItemAsync = async () => null; export const setItemAsync = async () => {}; export const deleteItemAsync = async () => {};`,
    'expo-crypto': `export const getRandomBytes = (n) => new Uint8Array(n);`,
};
// Modules the two bodies import but never draw here (a face, the made-up listings, the bundled guide, the Pulse's thumbnails).
const EMPTY_BY_NAME = [/\/MemberAvatar$/, /\/ExampleListings$/, /\/utils\/guide$/, /\/utils\/pulse$/];

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView, Text } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { HomeCard } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};
import { AskedBody, BeansBody, StepsBody } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeCardBodies'))};
import { stepLines } from ${JSON.stringify(path.join(NATIVE, 'utils/home-cards'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;
const noop = () => {};
const now = Date.now();
const H = 3600000;
const ago = (h) => new Date(now - h * H).toISOString();
// The Home answer's asked-near-you rows: price_c, whole hundredths of a Bean (20.50 has its hundredths to show).
const items = [
    { id: 'n2', title: 'Someone to dig a bed, and a long title that has to wrap whole on a phone', category: 'labour', price_c: 30000, priceType: 'monthly', createdAt: ago(26), photoUrl: null },
    { id: 'n1', title: 'Borrow a trailer Saturday', category: 'tools', price_c: 2050, priceType: 'hourly', createdAt: ago(2), photoUrl: null },
    { id: 'n3', title: 'Lift to Lismore Thursday', category: 'transport', price_c: 0, createdAt: ago(72), photoUrl: null },
];
// The Home answer's Your Beans: balance_c, room_c and this month's in_c, out_c and fees_c, whole hundredths, as wide as they come.
const beans = { balance_c: 123456, room_c: 98765, tier: 'Resident', activated: true, frozen: false,
    month: { trades: 12, in_c: 123456, out_c: 98765, fees_c: 1234, more: false } };
const lines = stepLines({ joinedAt: ago(72), firstOffer: true, firstNeed: false, firstPost: true, photo: true, interests: true, invited: false, area: false, knocked: null }, true);

createRoot(document.getElementById('root')).render(
    <View style={{ backgroundColor: colors.surface.page }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24, paddingTop: 8 }}>
            <HomeCard id="steps" caption="First steps" colors={colors} hue="sky" testID="home-card-steps" onMenu={noop}>
                <StepsBody lines={lines} note={null} colors={colors} onStep={noop} />
            </HomeCard>
            <HomeCard id="asked" caption="Asked near you" colors={colors} hue="orange" testID="home-card-asked" onMenu={noop}>
                <AskedBody items={items} nodeUrl={null} showsBeans colors={colors} now={now} onSeeAll={noop} />
            </HomeCard>
            <HomeCard id="beans" caption="Your Beans" colors={colors} hue="green" testID="home-card-beans" onMenu={noop}>
                <BeansBody card={beans} colors={colors} />
            </HomeCard>
        </ScrollView>
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
                if (STUBS[args.path]) return { path: args.path, namespace: 'stub' };
                if (EMPTY_BY_NAME.some((re) => re.test(args.path))) return { path: args.path, namespace: 'stub' };
                if (/ThemeContext$/.test(args.path)) return { path: 'theme', namespace: 'stub' };
                return undefined;
            });
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
                if (args.path === 'theme') {
                    return { loader: 'jsx', resolveDir: NATIVE, contents: `
                        import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
                        const dark = new URLSearchParams(location.search).get('scheme') === 'dark';
                        export const useTheme = () => ({ colors: dark ? darkColors : lightColors, scheme: dark ? 'dark' : 'light', theme: dark ? 'dark' : 'light' });
                    ` };
                }
                if (STUBS[args.path]) return { contents: STUBS[args.path], loader: 'jsx', resolveDir: NATIVE };
                return { contents: 'export const MemberAvatar = () => null; export const ExampleListings = () => null; export const getBundledGuide = () => ({ guides: [] }); export const resolvePulseThumbnailUrl = () => null; export default {};', loader: 'js' };
            });
        },
    }],
});

const bundle = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<script>window.process = window.process || { env: {} }; window.global = window;</script>
<style>html,body,#root{margin:0} body{font-family:sans-serif}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const check = (ok, what) => { if (ok) console.log(`  ok ${what}`); else { problems.push(what); console.error(`  x ${what}`); } };
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e}`));
    for (const scheme of ['light', 'dark']) {
        await page.goto(`${base}/?scheme=${scheme}`);
        await page.getByTestId('home-card-asked').waitFor();
        await page.waitForTimeout(250);
        const m = await page.evaluate(() => {
            const asked = document.querySelector('[data-testid="home-card-asked"]').getBoundingClientRect();
            const rows = Array.from(document.querySelectorAll('[data-testid^="home-asked-n"]')).map((r) => {
                const b = r.getBoundingClientRect();
                const words = Array.from(r.querySelectorAll('div,span')).filter((e) => e.children.length === 0 && e.textContent.trim());
                return { text: r.textContent.trim(), h: Math.round(b.height), inside: b.left >= asked.left - 0.5 && b.right <= asked.right + 0.5, cut: words.some((e) => e.scrollWidth > e.clientWidth + 1) };
            });
            const link = document.querySelector('[data-testid="home-asked-all"]').getBoundingClientRect();
            const step = document.querySelector('[data-testid="home-step-need"]').getBoundingClientRect();
            const card = document.querySelector('[data-testid="home-card-beans"]').getBoundingClientRect();
            const beans = ['home-beans-line', 'home-beans-month'].map((id) => {
                const r = document.querySelector('[data-testid="' + id + '"]');
                if (!r) return { id, text: '', h: 0, inside: false, cut: true };
                const b = r.getBoundingClientRect();
                const words = Array.from(r.querySelectorAll('div,span')).filter((e) => e.children.length === 0 && e.textContent.trim());
                return { id, text: r.textContent.trim(), h: Math.round(b.height), inside: b.left >= card.left - 0.5 && b.right <= card.right + 0.5, cut: words.some((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > card.right + 0.5) };
            });
            return { rows, beans, link: Math.round(link.height), step: Math.round(step.height), wide: document.documentElement.scrollWidth, text: document.querySelector('[data-testid="home-step-need"]').textContent };
        });
        check(m.wide <= WIDTH, `${scheme}: no sideways scroll (${m.wide} wide)`);
        check(m.rows.length === 3, `${scheme}: three rows`);
        check(m.rows.every((r) => r.h >= 44 && r.inside && !r.cut), `${scheme}: every row is at least 44dp (least ${Math.min(...m.rows.map((r) => r.h))}), inside the card, no words cut`);
        check(m.rows.some((r) => /20\.50 Beans \/Hr · 2h ago/.test(r.text)) && m.rows.some((r) => /Free · 3d ago/.test(r.text)) && m.rows.some((r) => /300 Beans \/Mo · 1d ago/.test(r.text)), `${scheme}: the second lines read "20.50 Beans /Hr · 2h ago", "300 Beans /Mo · 1d ago", "Free · 3d ago"`);
        check(m.beans.every((r) => r.h >= 44 && r.inside && !r.cut), `${scheme}: Your Beans' two rows are at least 44dp (${m.beans.map((r) => r.h).join(', ')}), inside the card, no words cut`);
        check(/1,234\.56/.test(m.beans[0].text) && /987\.65/.test(m.beans[0].text) && /1,234\.56/.test(m.beans[1].text), `${scheme}: Your Beans reads 1,234.56 held, 987.65 room and 1,234.56 in, every figure from hundredths (${m.beans.map((r) => r.text).join(' | ')})`);
        check(m.link >= 44 && m.step >= 44, `${scheme}: See all Needs (${m.link}dp) and the step line (${m.step}dp) are at least 44dp`);
        check(/Ask for one thing you'd pay a neighbour for/.test(m.text), `${scheme}: the step line reads in full`);
        if (SHOTS) {
            await page.getByTestId('home-card-asked').screenshot({ path: path.join(SHOTS, `asked-${scheme}.png`) });
            await page.getByTestId('home-card-steps').screenshot({ path: path.join(SHOTS, `steps-${scheme}.png`) });
            await page.getByTestId('home-card-beans').screenshot({ path: path.join(SHOTS, `beans-${scheme}.png`) });
        }
    }
} finally {
    await browser.close();
    server.close();
}
if (problems.length) { console.error(`\n${problems.length} problem(s)`); process.exit(1); }
console.log(SHOTS ? `\nShots in ${SHOTS}` : '\nAll checks pass');
