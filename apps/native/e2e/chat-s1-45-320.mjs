#!/usr/bin/env node
/* global process, console, document, getComputedStyle, globalThis, location */
/**
 * chat-s1-45 at the floor (memory product-audience-small-screens: 320dp wide, the phone's text at 1.3×), in the light and
 * the dark scheme, through react-native-web in headless Chromium, as e2e/own-profile-320.mjs draws its screens.
 *
 * What is drawn is the app's own code, not a copy of it (PR #2772 review, finding 4):
 *   - Chat's row for each other community where messages wait: components/OtherCommunityNotices.tsx, the very component
 *     app/(tabs)/chats.tsx renders, with a community named long enough to wrap, a number, and the note a tap that moved
 *     nothing leaves;
 *   - the BeanPool sheet: app/beanpool.tsx, opened as a member opens it (a long press on a saved community's row), with the
 *     Alerts switch pressed through every state it has: on, off, off with the community out of reach.
 * Stood in for, as the app's own tests do: the router, the device, storage, the theme and sign-in contexts, the guide, the
 * list of communities (the rows are given), and the two modules the switch calls to reach a community (the DELETE itself is
 * exercised against a fake community in utils/__tests__/beanpool-sheet-words-render.test.ts).
 *
 * Each state fails on: the page scrolling sideways; text past the 320 edge or cut; text under 4.5:1 (3:1 large); a button
 * under 44dp; the Alerts switch's thumb under 3:1 against the sheet's card, off or on.
 *
 * A stand-in for the phone, not an emulator: Android's fonts and line breaking differ. Nothing leaves the machine: the page
 * aborts every request but its own. The browser: run `pnpm --filter @beanpool/pwa exec playwright install --only-shell
 * chromium` once.
 *
 *   node apps/native/e2e/chat-s1-45-320.mjs [--shots <dir>]
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
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-s1-45-320-'));

// ─── Stubs: what the screens import that reaches the router, the device, the theme, storage or the network ─────────────
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
        export const TextInput = React.forwardRef((p, ref) => React.createElement(RNW.TextInput, { ...p, ref, style: scaled(p.style) }));
        export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o['android'] ?? o.default };
        export const DeviceEventEmitter = { addListener() { return { remove() {} }; }, emit() {} };
        export default { ...RNW, Text, TextInput, Platform, DeviceEventEmitter };
    `,
    'ThemeContext': `export const useTheme = () => globalThis.__theme; export const useStyles = (make) => make(globalThis.__theme);`,
    'IdentityContext': `export const useIdentity = () => ({ identity: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32), callsign: 'Kim' }, setIdentity() {} });`,
    'NodeStatusContext': `export const useNodeStatus = () => ({ recheck: async () => 'unknown' });`,
    'expo-router': `
        export const router = { back() {}, push() {}, navigate() {}, replace() {}, canGoBack: () => true };
        export const ErrorBoundary = () => null;
    `,
    'react-native-safe-area-context': `
        import React from 'react';
        import { View } from 'react-native-web';
        export const SafeAreaView = ({ children, style }) => React.createElement(View, { style }, children);
        export const useSafeAreaInsets = () => ({ top: 24, bottom: 0, left: 0, right: 0 });
    `,
    'expo-status-bar': `export const StatusBar = () => null;`,
    '@expo/vector-icons': `
        import React from 'react';
        import { Text } from 'react-native-web';
        const glyph = { 'chevron-right': '›', 'chevron-down': '⌄', close: '✕' };
        export const MaterialCommunityIcons = ({ name, style, size, color }) => React.createElement(Text, { style: [{ fontSize: size, color: color || '#000' }, style] }, glyph[name] || '•');
    `,
    'expo-constants': `export default { expoConfig: { version: '1.2.84' } };`,
    '@react-native-async-storage/async-storage': `
        const store = () => globalThis.__store || (globalThis.__store = new Map());
        export default { getItem: async (k) => store().get(k) ?? null, setItem: async (k, v) => { store().set(k, v); }, removeItem: async (k) => { store().delete(k); } };
    `,
    'use-communities': `
        export const useCommunities = () => ({
            active: globalThis.__rows[0].url, current: globalThis.__rows[0], rows: globalThis.__rows, lastSync: Date.now() - 5 * 60000,
            switching: false, switchTo: async () => {}, remove() {},
        });
        export const communitySwitchUnderWay = () => false;
        export const switchCommunity = async () => {};
    `,
    'use-global-door-open': `export const useGlobalDoor = () => ({ state: 'open', wordsDoor: true, retry() {} });`,
    'use-global-entry': `export const useGlobalEntry = () => 'join';`,
    'use-global-guest-visit': `export const useGlobalGuestVisit = () => ({ visiting: false, visit: async () => {} });`,
    'use-guide': `import { getBundledGuide } from './utils/guide'; export const useGuide = () => ({ guide: getBundledGuide(), source: 'bundled' });`,
    'nodes': `export const getSavedNodes = async () => JSON.parse(globalThis.__store.get('beanpool_saved_nodes') || '[]'); export const isGuestNode = async () => false;`,
    'global-join-existing': `export const isGlobalCommunity = (url) => !!url && url.trim().replace(/\\/+$/, '').toLowerCase() === 'https://global.beanpool.org';`,
    'beanpool-links': `export const openBeanPoolWebsite = async () => {};`,
    // The two modules the switch reaches a community through: the page gives the answer each state needs.
    'account-leaves-phone': `export const turnAlertsOff = async () => globalThis.__reached !== false;`,
    'push-notifications': `export const turnAlertsOnAt = async () => {};`,
};
const STUBBED_FILES = ['ThemeContext', 'IdentityContext', 'NodeStatusContext', 'use-communities', 'use-global-door-open', 'use-global-entry',
    'use-global-guest-visit', 'use-guide', 'nodes', 'global-join-existing', 'beanpool-links', 'account-leaves-phone', 'push-notifications'];
/** Import specifiers (bare, or a relative path's last part) that resolve to a stub. */
const stubFor = (spec) => {
    if (STUBS[spec] && !spec.startsWith('.')) return spec;
    if (!spec.startsWith('.')) return null;
    const base = path.basename(spec);
    return STUBBED_FILES.includes(base) ? base : null;
};

// ─── The page: each case renders the real Chat rows, or the real BeanPool sheet ────────────────────────────────────────
const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { OtherCommunityNotices } from ${JSON.stringify(path.join(NATIVE, 'components/OtherCommunityNotices'))};
import BeanPoolSheet from ${JSON.stringify(path.join(NATIVE, 'app/beanpool'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const view = q.get('view') || 'chat';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__theme = { theme: scheme, colors };
globalThis.__rows = [
    { url: 'https://mullum.example', name: 'Mullumbimby Community Exchange', status: 'online' },
    { url: 'https://castlemaine.example', name: 'Castlemaine and the Goldfields Region Network', status: 'online' },
];
globalThis.__reached = q.get('reached') !== '0';
globalThis.__store = new Map([
    ['beanpool_anchor_url', 'https://mullum.example'],
    ['beanpool_saved_nodes', JSON.stringify([{ url: 'https://mullum.example' }, { url: 'https://castlemaine.example' }])],
]);

const Chat = () => (
    <View style={{ flex: 1, backgroundColor: colors.surface.page }}>
        <OtherCommunityNotices
            notices={[
                { url: 'https://castlemaine.example', name: 'Castlemaine and the Goldfields Region Network', count: 3 },
                { url: 'https://byron.example', name: 'Byron', count: 1 },
            ]}
            busy={false}
            onOpen={() => {}}
            note={q.get('note') === '1' ? 'Something went wrong. Try again in a moment.' : null}
        />
        <Text style={{ padding: 16, color: colors.text.secondary, fontSize: 13 }}>(the conversation list, not drawn here)</Text>
    </View>
);

createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', width: '100%', backgroundColor: colors.surface.app }}>
        {view === 'chat' ? <Chat /> : <BeanPoolSheet />}
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
                const name = stubFor(args.path);
                if (!name) return undefined;
                return { path: name, namespace: 'stub' };
            });
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'jsx', resolveDir: NATIVE }));
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

const browser = await chromium.launch();
const problems = [];
let states = 0;
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 640 }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => { console.error('PAGE ERROR:', e); errors.push(String(e)); });

    const measure = async (label, { switchState } = {}) => {
        states++;
        const found = await page.evaluate(({ WIDTH, switchState }) => {
            const out = [];
            const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
            const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
            const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
            const ratioOf = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
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
            if (document.scrollingElement.scrollWidth > WIDTH) out.push('the page scrolls sideways (' + document.scrollingElement.scrollWidth + 'px)');
            const texts = [...document.querySelectorAll('div[dir], span, input, textarea')].filter((el) => {
                const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
                return own || ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'hidden' && el.value);
            });
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = (el.value ?? el.textContent).trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push('"' + what + '" runs past the edge (' + Math.round(r.left) + '–' + Math.round(r.right) + ')');
                // A name set to one line ends in "…" by design (numberOfLines={1}); anything else cut is a fault.
                if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible' && getComputedStyle(el).textOverflow !== 'ellipsis') out.push('"' + what + '" is cut on the right (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
                const cs = getComputedStyle(el);
                const fg = rgb(cs.color);
                if (!fg) continue;
                if (/^[\p{Extended_Pictographic}️‍\s›⌄✕•]+$/u.test(what)) continue;
                const bg = backdrop(el);
                const ratio = ratioOf(over(fg, bg), bg);
                const size = parseFloat(cs.fontSize);
                const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                if (ratio < (large ? 3 : 4.5)) out.push('"' + what + '" has contrast ' + ratio.toFixed(2) + ':1 (' + cs.color + ' on rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + '), ' + size + 'px)');
            }
            for (const el of document.querySelectorAll('[role="button"]')) {
                const r = el.getBoundingClientRect();
                if (r.width === 0) continue;
                if (r.height < 43.5) out.push('the button "' + (el.textContent.trim().slice(0, 40) || el.getAttribute('aria-label')) + '" is ' + Math.round(r.height) + 'dp tall');
            }
            if (switchState) {
                // The switch: the thumb is the smallest painted box in it; it must stand off the sheet's card by 3:1.
                const input = document.querySelector('input[role="switch"]');
                const host = input && input.parentElement;
                const painted = host ? [...host.querySelectorAll('div')].filter((d) => { const c = rgb(getComputedStyle(d).backgroundColor); return c && c.a > 0.5; }) : [];
                const area = (d) => { const r = d.getBoundingClientRect(); return r.width * r.height; };
                painted.sort((a, b) => area(a) - area(b));
                const thumb = painted[0];
                const card = document.querySelector('[data-testid="community-options-modal"]');
                if (!thumb || !card) out.push('the Alerts switch was not found');
                else {
                    const t = rgb(getComputedStyle(thumb).backgroundColor);
                    const c = backdrop(card);
                    const ratio = ratioOf(t, c);
                    out.push(...(ratio < 3 ? ['the Alerts switch (' + switchState + ') thumb is ' + ratio.toFixed(2) + ':1 against the card'] : []));
                    window.__thumb = ratio.toFixed(2);
                }
            }
            return out;
        }, { WIDTH, switchState });
        for (const p of found) problems.push(`${label}: ${p}`);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label}.png`) }); }
        const thumb = switchState ? await page.evaluate(() => window.__thumb) : null;
        console.log(`${found.length ? '✗' : '✓'} ${label}${thumb ? ` (thumb ${thumb}:1 on the card)` : ''}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };

    const openOptions = async () => {
        await page.waitForSelector('[aria-label*="Castlemaine"]');
        // A long press, as a finger makes it: held past the half second that makes it one.
        const box = await page.locator('[aria-label*="Castlemaine"]').first().boundingBox();
        await page.mouse.move(box.x + 20, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(800);
        await page.mouse.up();
        await page.waitForSelector('[data-testid="community-options-modal"]');
        await page.waitForTimeout(150);
    };

    for (const scheme of ['light', 'dark']) {
        await page.goto(`${base}/?view=chat&scheme=${scheme}`);
        await page.waitForTimeout(250);
        await measure(`chat-row-320-${scheme}`);
        await page.goto(`${base}/?view=chat&scheme=${scheme}&note=1`);
        await page.waitForTimeout(250);
        await measure(`chat-row-note-320-${scheme}`);

        await page.goto(`${base}/?view=sheet&scheme=${scheme}`);
        await openOptions();
        await measure(`beanpool-options-on-320-${scheme}`, { switchState: 'on' });
        await page.locator('input[role="switch"]').click({ force: true });
        await page.waitForTimeout(300);
        await measure(`beanpool-options-off-320-${scheme}`, { switchState: 'off' });

        await page.goto(`${base}/?view=sheet&scheme=${scheme}&reached=0`);
        await openOptions();
        await page.locator('input[role="switch"]').click({ force: true });
        await page.waitForTimeout(300);
        await measure(`beanpool-options-off-unreached-320-${scheme}`, { switchState: 'off, community out of reach' });
    }
    for (const e of errors) problems.push('page error: ' + e);
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

console.log('\n' + states + ' states measured at ' + WIDTH + 'dp with ' + SCALE + '× text');
if (problems.length) {
    console.log(problems.map((p) => '  ✗ ' + p).join('\n'));
    process.exit(1);
}
console.log('All states hold at 320dp x 1.3: no sideways scroll, nothing past edge, tap targets >= 44dp, contrast passes, the switch reads.');
