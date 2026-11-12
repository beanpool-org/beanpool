#!/usr/bin/env node
/**
 * The phone's top bar and Home at 320 dp, text at 1.3x, in Classic and in Dark (colour themes, slice T5, round 2; Marty, 12 Nov
 * 2026: "no green in Dark"). Not part of CI: the proof that the guard (utils/__tests__/header-banner.test.ts) holds is a picture
 * you can look at.
 *
 * The REAL components/GlobalHeader.tsx (and components/PatternBackground.tsx) are bundled with esbuild and drawn with
 * react-native-web in Chromium: the bean, the help, the invite, the Settings and the avatar icons over the banner the header
 * takes for the colour set (utils/header-banner.ts). What is stubbed is what a header needs from the phone and cannot have here:
 * the theme (the app's own colours for the set), the signed-in key, the member's own row, the sync clock, the safe-area insets,
 * the router, the vector-icon font (a few letters stand in), the avatar, and the "needs you" icons (left out). It is a
 * stand-in, not an emulator: Android's fonts, line breaking and image decoder differ. Nothing leaves the machine: the page aborts
 * every request but its own, and `fetch` fails at once.
 *
 *   node apps/native/e2e/header-banner-320.mjs [--shots <dir>]
 *
 * Checks, per look: no page error; nothing runs past the 320 edge; the picture drawn behind the icons is the file of its set
 * (Classic's neon-vines-banner.jpg, Dark's vines-banner-night.jpg) and not the other; and in the rendered pixels of the bar
 * (the bean's corner left out: the bean is the logo) Classic has green and Dark has none. With --shots: header-<look>.png (the
 * bar), home-<look>.png (the bar over the doodle with three of Home's cards) and header-classic-vs-dark.png (side by side).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(HERE, '..');
const ROOT = path.resolve(NATIVE, '../..');
const SCALE = 1.3;
const WIDTH = 320;
const TOP = 24; // the status bar's height, as the header's safe-area inset
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'header-banner-320-'));

// Modules stubbed by import name (a package) ...
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
        export const DeviceEventEmitter = { addListener() { return { remove() {} }; }, emit() {} };
        export const AppState = { addEventListener() { return { remove() {} }; }, currentState: 'active' };
        export default { ...RNW, Text, Platform, DeviceEventEmitter, AppState };
    `,
    'expo-router': `
        export const router = { back() {}, push() {}, navigate() {}, replace() {}, canGoBack: () => true };
        export const usePathname = () => '/';
    `,
    'react-native-safe-area-context': `export const useSafeAreaInsets = () => ({ top: ${TOP}, bottom: 0, left: 0, right: 0 });`,
    'expo-constants': `export default { expoConfig: { version: '1.2.83' } };`,
    '@expo/vector-icons': `
        import React from 'react';
        import { Text } from 'react-native-web';
        const GLYPH = { 'help-circle-outline': '?', 'account-plus-outline': '+', tune: '≡' };
        export const MaterialCommunityIcons = ({ name, style, size, color }) => React.createElement(Text, { style: [{ fontSize: size, color: color || '#000', fontWeight: '700' }, style] }, GLYPH[name] ?? '•');
    `,
    '@react-native-async-storage/async-storage': `
        const store = () => globalThis.__store || (globalThis.__store = new Map());
        export default { getItem: async (k) => store().get(k) ?? null, setItem: async (k, v) => { store().set(k, v); }, removeItem: async (k) => { store().delete(k); } };
    `,
};
// ... and modules of the app stubbed by their path under apps/native (so a file of the same name elsewhere is never caught).
const APP_STUBS = {
    'app/ThemeContext': `export const useTheme = () => globalThis.__theme; export const useStyles = (make) => make(globalThis.__theme);`,
    'app/IdentityContext': `export const useIdentity = () => ({ identity: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32), callsign: 'Ben' } });`,
    'utils/use-own-profile': `export const useOwnProfile = () => ({ callsign: 'Ben', avatarUrl: null, updatedAt: null });`,
    'services/pillar-sync': `export const getLastSyncTime = async () => Date.now();`,
    'components/NeedsYouIcons': `export const NeedsYouIcons = () => null;`,
    'components/MemberAvatar': `
        import React from 'react';
        import { View, Text } from 'react-native';
        export const MemberAvatar = ({ size, callsign }) => (
            <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#64748b', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{String(callsign).slice(0, 1)}</Text>
            </View>
        );
    `,
};
const appStubFor = (resolved) => {
    const rel = path.relative(NATIVE, resolved).split(path.sep).join('/').replace(/\.(tsx?|jsx?)$/, '');
    return APP_STUBS[rel] ? rel : null;
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { COLOUR_SETS } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { drawnColours } from ${JSON.stringify(path.join(NATIVE, 'utils/drawn-colours'))};
import PatternBackground from ${JSON.stringify(path.join(NATIVE, 'components/PatternBackground'))};
import { GlobalHeader } from ${JSON.stringify(path.join(NATIVE, 'components/GlobalHeader'))};
import { HomeCard, HomeRow, HomeLink, homeStyles } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};

globalThis.fetch = async () => { throw new TypeError('offline'); };
globalThis.__store = new Map([['beanpool_anchor_url', 'https://community.example']]);
const q = new URLSearchParams(location.search);
const set = ['light', 'dark', 'night'].includes(q.get('set')) ? q.get('set') : 'dark';
const view = q.get('view') || 'header';
const doodle = view === 'home';
const colors = doodle ? drawnColours(set, true) : COLOUR_SETS[set];
globalThis.__theme = { theme: set === 'light' ? 'light' : 'dark', set, colors, patternEnabled: doodle };

const hs = homeStyles(colors);
const noop = () => {};
// Three of Home's real cards, as app/(tabs)/index.tsx lists them for a member (the same three as appearance-t3-320.mjs).
const Cards = () => (
    <View style={{ flex: 1, backgroundColor: 'transparent', paddingTop: 12 }}>
        <Text style={{ marginHorizontal: 16, marginBottom: 8, fontSize: 24, fontWeight: '800', color: colors.text.heading }}>Home</Text>
        <HomeCard id="needs" caption="Needs you" colors={colors} hue="amber" accent testID="home-card-needs">
            <HomeRow colors={colors} text="Kofi sent you a message" a11y="Kofi sent you a message" onPress={noop} />
            <HomeRow colors={colors} text="Your event Seed swap has 3 new answers" a11y="Your event Seed swap has 3 new answers" onPress={noop} />
        </HomeCard>
        <HomeCard id="market" caption="New in the Market" colors={colors} hue="orange" testID="home-card-market">
            <HomeRow colors={colors} text="Sourdough" sub="OFFER · 12 Beans" a11y="Sourdough" onPress={noop} left={<View style={[hs.thumb, hs.thumbEmpty]} />} />
            <HomeRow colors={colors} text="Help moving a couch" sub="NEED · labour" a11y="Help moving a couch" onPress={noop} left={<View style={[hs.thumb, hs.thumbEmpty]} />} />
            <HomeLink id="market" text="See all" a11y="See all" onPress={noop} colors={colors} />
        </HomeCard>
        <HomeCard id="community" caption="The community" colors={colors} hue="sage" testID="home-card-community">
            <Text style={hs.note}>81 members, 23 trades this month.</Text>
        </HomeCard>
    </View>
);

// The tab layout: the header on top, the screen under it (see-through over the wallpaper when it is on).
createRoot(document.getElementById('root')).render(
    <View data-view={view} data-set={set} style={{ height: '100vh', width: '100%', backgroundColor: doodle ? 'transparent' : colors.surface.app }}>
        {doodle ? <PatternBackground /> : null}
        <GlobalHeader />
        {doodle ? <Cards /> : null}
    </View>
);
`);

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.png': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl', '.ttf': 'empty' },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.mjs', '.json'],
    nodePaths: [path.join(ROOT, 'node_modules'), path.join(NATIVE, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {}, versions: {} }; globalThis.global = globalThis;' },
    logLevel: 'error',
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
                if (args.namespace === 'stub') return undefined;
                if (STUBS[args.path]) return { path: args.path, namespace: 'stub' };
                if (args.path.startsWith('.') || path.isAbsolute(args.path)) {
                    const resolved = path.resolve(path.isAbsolute(args.path) ? '' : args.resolveDir, args.path);
                    const rel = appStubFor(resolved);
                    if (rel) return { path: rel, namespace: 'app-stub' };
                }
                return undefined;
            });
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'jsx', resolveDir: NATIVE }));
            b.onLoad({ filter: /.*/, namespace: 'app-stub' }, (args) => ({ contents: APP_STUBS[args.path], loader: 'jsx', resolveDir: NATIVE }));
        },
    }],
});
const bundle = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<style>html,body,#root{margin:0;height:100%} body{font-family:sans-serif}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let failures = 0;
const check = (ok, what) => {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures++; console.log(`  ✗ ${what}`); }
};
const b64 = (file) => fs.readFileSync(path.join(NATIVE, 'assets/images', file)).toString('base64');
const BANNER_FILE = { dark: 'neon-vines-banner.jpg', night: 'vines-banner-night.jpg' };

/** Share of the bar's pixels that are clearly green (green above the mean of red and blue by 12 levels), the bean's corner (left 56 dp) left out. */
async function greenShare(png, height) {
    const { data, info } = await sharp(png).extract({ left: 56 * 2, top: 0, width: (WIDTH - 56) * 2, height: height * 2 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let green = 0;
    for (let i = 0; i < data.length; i += 3) if (data[i + 1] - (data[i] + data[i + 2]) / 2 > 12) green++;
    return green / (info.width * info.height);
}

const browser = await chromium.launch();
const bars = {};
try {
    for (const [set, name] of [['dark', 'Classic'], ['night', 'Dark']]) {
        const page = await browser.newPage({ viewport: { width: WIDTH, height: 700 }, deviceScaleFactor: 2 });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.route((u) => u.hostname !== '127.0.0.1', (route) => route.abort());
        await page.goto(`${base}/?view=header&set=${set}`);
        await page.waitForTimeout(900);
        // The banner: the header's one background image of a data URL (the bean is the other picture, a PNG).
        const read = await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('#root *')).find((e) => /^url\("data:image\/jpeg/.test(getComputedStyle(e).backgroundImage));
            const m = el && /^url\("data:image\/jpeg;base64,([^"]+)"\)/.exec(getComputedStyle(el).backgroundImage);
            const past = Array.from(document.querySelectorAll('#root *')).filter((e) => e.getBoundingClientRect().right > 320.5 && (e.textContent || '').trim() && e.children.length === 0).map((e) => e.textContent.trim().slice(0, 30));
            return { banner: m ? m[1] : null, past, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth };
        });
        console.log(`\ntop bar / ${name}`);
        check(errors.length === 0, `no page error${errors[0] ? `: ${errors[0]}` : ''}`);
        check(!read.sideways && read.past.length === 0, 'nothing scrolls sideways or runs past the 320 edge');
        check(read.banner !== null && read.banner === b64(BANNER_FILE[set]), `the banner behind the icons is ${BANNER_FILE[set]} (${read.banner?.length ?? 'none'} base64 characters drawn, ${b64(BANNER_FILE[set]).length} in the file)`);
        const other = b64(BANNER_FILE[set === 'night' ? 'dark' : 'night']);
        check(read.banner !== null && read.banner !== other, `and not the other look's banner (${BANNER_FILE[set === 'night' ? 'dark' : 'night']})`);
        const barHeight = TOP + 48;
        const bar = await page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: barHeight } });
        bars[name] = bar;
        const green = await greenShare(bar, barHeight);
        console.log(`    green pixels in the bar (the bean's corner left out): ${(green * 100).toFixed(2)} %`);
        if (set === 'dark') check(green > 0.05, 'Classic\'s bar has the leafy green (so the green check can see it)');
        else check(green < 0.005, 'Dark\'s bar has no green');
        if (SHOTS) fs.writeFileSync(path.join(SHOTS, `header-${name.toLowerCase()}.png`), bar);
        await page.close();

        const home = await browser.newPage({ viewport: { width: WIDTH, height: 700 }, deviceScaleFactor: 2 });
        const homeErrors = [];
        home.on('pageerror', (e) => homeErrors.push(String(e)));
        await home.route((u) => u.hostname !== '127.0.0.1', (route) => route.abort());
        await home.goto(`${base}/?view=home&set=${set}`);
        await home.waitForTimeout(900);
        console.log(`home / ${name}`);
        check(homeErrors.length === 0, `no page error${homeErrors[0] ? `: ${homeErrors[0]}` : ''}`);
        if (SHOTS) await home.screenshot({ path: path.join(SHOTS, `home-${name.toLowerCase()}.png`) });
        await home.close();
    }
    if (SHOTS) {
        const gap = 16, w = WIDTH * 2, h = (TOP + 48) * 2;
        await sharp({ create: { width: w * 2 + gap, height: h, channels: 3, background: '#808080' } })
            .composite([{ input: bars.Classic, left: 0, top: 0 }, { input: bars.Dark, left: w + gap, top: 0 }])
            .png().toFile(path.join(SHOTS, 'header-classic-vs-dark.png'));
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
