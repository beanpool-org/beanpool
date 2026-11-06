#!/usr/bin/env node
/* global process, console, document */
/**
 * What are you into? with the cold-start N3 sentence ("…and we'll tell you when a neighbour asks for it"), at the floor (320dp
 * wide, phone text at 1.3×), in light and dark: the app's own InterestsBody inside HomeCard, through react-native-web in
 * headless Chromium, with the community saying askedPush. A stand-in for the phone, not the phone: Android's fonts and line
 * breaking differ.
 *
 * Checks, per theme: no sideways scroll; nothing past the 320dp edge; the note reads in full and wraps whole; every chip at
 * least 44dp tall and inside the card. Screenshots with --shots <dir>: interests-<scheme>.
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'asked-push-320-'));

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
import { View, ScrollView } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { HomeCard } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};
import { InterestsBody } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeCardBodies'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;
const noop = () => {};

createRoot(document.getElementById('root')).render(
    <View style={{ backgroundColor: colors.surface.page }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24, paddingTop: 8 }}>
            <HomeCard id="interests" caption="What are you into?" colors={colors} hue="sage" testID="home-card-interests" onMenu={noop}>
                <InterestsBody interests={['garden', 'tools']} colors={colors} onToggle={noop} askedPush />
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
        await page.getByTestId('home-card-interests').waitFor();
        await page.waitForTimeout(250);
        const m = await page.evaluate(() => {
            const card = document.querySelector('[data-testid="home-card-interests"]').getBoundingClientRect();
            const note = document.querySelector('[data-testid="home-interests-note"]');
            const n = note.getBoundingClientRect();
            const chips = Array.from(document.querySelectorAll('[data-testid^="home-interest-"]')).map((c) => {
                const b = c.getBoundingClientRect();
                return { h: Math.round(b.height), inside: b.left >= card.left - 0.5 && b.right <= card.right + 0.5 };
            });
            return {
                wide: document.documentElement.scrollWidth, text: note.textContent, noteInside: n.left >= card.left - 0.5 && n.right <= card.right + 0.5,
                noteCut: note.scrollWidth > note.clientWidth + 1, noteH: Math.round(n.height), chips,
            };
        });
        check(m.wide <= WIDTH, `${scheme}: no sideways scroll (${m.wide} wide)`);
        check(m.text === "Tap a few. What you star comes first here and in the Market, and we'll tell you when a neighbour asks for it.", `${scheme}: the note reads in full (${m.text})`);
        check(m.noteInside && !m.noteCut, `${scheme}: the note wraps whole inside the card (${m.noteH}dp tall)`);
        check(m.chips.length === 17 && m.chips.every((c) => c.h >= 44 && c.inside), `${scheme}: 17 chips, each at least 44dp (least ${Math.min(...m.chips.map((c) => c.h))}) and inside the card`);
        if (SHOTS) await page.getByTestId('home-card-interests').screenshot({ path: path.join(SHOTS, `interests-${scheme}.png`) });
    }
} finally {
    await browser.close();
    server.close();
}
if (problems.length) { console.error(`\n${problems.length} problem(s)`); process.exit(1); }
console.log(SHOTS ? `\nShots in ${SHOTS}` : '\nAll checks pass');
