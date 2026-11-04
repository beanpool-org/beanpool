#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * The map's pin card (components/MapPreviewCard.tsx, slice M1 of DESIGN-card-style-box-fable.md) at the floor: 320 dp wide, text
 * at 1.3x, light and dark, over the map's own ground. The real card and its real parts (EventCard, MarketCardPicture and the
 * CategoryTile, PostAuthorTrust, CurrencyDisplay) through react-native-web in headless Chromium; stubbed only where they reach
 * the device, the network, the router or the account. A stand-in for a phone: Android's fonts and line breaks differ. Nothing
 * leaves the machine: the page aborts every request but its own.
 *
 * Cases (Marty's shot of 4 Nov: an event pop-up with no photo, "0 going" and a big View event button):
 *   offer       an Elder's photoless recurring Offer (Kofi's duck eggs)
 *   need        a Need of my own, group-only (the 👤 YOU chip and the lock)
 *   going       Byron's Saturday market, my Going on it, a long title and place
 *   nobody      an event nobody has answered (where "0 going" was)
 *
 * Checks (each case, each scheme): the card is 16 in from either edge; its picture is the 80 dp slot, flush inside the border and
 * the card's full height; no button inside the card, the ✕ beside it and clear of the first row; no View event / View Details;
 * no zero count; nothing drawn past the 320 dp edge; no sideways scroll.
 *
 *   node apps/native/e2e/map-preview-card-320.mjs --shots <dir>
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
const SCALE = 1.3;
const WIDTH = 320;
const HEIGHT = 1400;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'map-preview-card-320-'));

// ─── What is stubbed: the files and packages that reach the device, the network, the router or the account ───────────────
const STUB_FILES = ['app/IdentityContext', 'app/ThemeContext', 'utils/db', 'utils/nodes', 'utils/node-post', 'utils/photo-refresh', 'components/MemberAvatar'];
const STUB_PACKAGES = ['expo-secure-store', 'expo-router', 'expo-image', '@expo/vector-icons', '@react-native-async-storage/async-storage'];

// The names each stub must export, read off the app's own imports, so a new import never breaks the harness.
const sources = [];
const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (/__tests__|node_modules/.test(full)) continue;
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) sources.push(full);
    }
};
['app', 'components', 'utils', 'services', 'constants'].map(d => path.join(NATIVE, d)).forEach(walk);
const IMPORT = /import\s+(type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+[\w$]+\s*)?from\s+'([^']+)'/g;
const namesFor = (key) => {
    const names = new Set();
    for (const file of sources) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
            if (m[1]) continue;
            const spec = m[4];
            const resolved = spec.startsWith('.') ? path.resolve(path.dirname(file), spec).replace(/\.tsx?$/, '') : spec;
            if (resolved !== key) continue;
            for (const part of (m[3] ?? '').split(',')) {
                const p = part.trim();
                if (!p || p.startsWith('type ')) continue;
                names.add(p.split(/\s+as\s+/)[0].trim());
            }
        }
    }
    return [...names];
};

const OVERRIDES = {
    'app/IdentityContext': { useIdentity: `() => ({ identity: globalThis.__identity, isLoading: false })` },
    'app/ThemeContext': { useTheme: `() => globalThis.__theme`, useStyles: `(make) => make(globalThis.__theme)` },
    'utils/db': { getMemberRatings: `async (k) => (k === 'kofi-key' ? { average: 4.6, count: 7 } : { average: 0, count: 0 })` },
    'utils/nodes': { getSavedNodes: `async () => []` },
    'utils/node-post': { anchorUrl: `async () => null`, getCachedAnchorUrl: `() => null` },
    'utils/photo-refresh': { refreshListingAfterPhotoError: `() => false` },
    // A face: the member's initial on a round ground, the size the who-line asks for.
    'components/MemberAvatar': {
        MemberAvatar: `({ callsign, size = 24 }) => React.createElement(RN.View, { style: { width: size, height: size, borderRadius: size / 2, backgroundColor: globalThis.__theme.colors.surface.subtle, alignItems: 'center', justifyContent: 'center' } }, React.createElement(RN.Text, { style: { fontSize: size * 0.45, fontWeight: '700', color: globalThis.__theme.colors.text.secondary } }, (callsign || '?').slice(0, 1)))`,
    },
    'expo-router': { router: `{ push() {}, navigate() {}, setParams() {}, back() {} }`, useFocusEffect: `(cb) => React.useEffect(() => cb(), [cb])`, useLocalSearchParams: `() => ({})` },
    'expo-image': { Image: `(p) => React.createElement(RN.Image, { ...p, source: p.source })` },
    'expo-secure-store': { getItemAsync: `async () => null`, setItemAsync: `async () => {}` },
    '@expo/vector-icons': { MaterialCommunityIcons: `() => null` },
};

const stubSource = (key, rel) => {
    if (key === '@react-native-async-storage/async-storage') {
        return `const s = { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, multiGet: async () => [] }; export default s;`;
    }
    const over = OVERRIDES[rel] ?? {};
    const names = new Set([...namesFor(key), ...Object.keys(over)]);
    const lines = [`import React from 'react'; import * as RN from 'react-native';`];
    for (const n of names) {
        const body = over[n] ?? (/^[A-Z][A-Z0-9_]+$/.test(n) ? `[]` : /^[A-Z]/.test(n) ? `() => null` : /^use[A-Z]/.test(n) ? `() => null` : /^(get|fetch|read|list)/.test(n) ? `async () => []` : `async () => null`);
        lines.push(`export const ${n} = ${body};`);
    }
    return lines.join('\n');
};

// Text at 1.3x, as the phone's font scale draws it.
const RN_STUB = `
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
    export const Alert = { alert() {} };
    export const useWindowDimensions = () => ({ width: ${WIDTH}, height: ${HEIGHT}, scale: 1.5, fontScale: ${SCALE} });
    export default { ...RNW, Text, Platform, Alert, useWindowDimensions };
`;

const plugin = {
    name: 'map-preview-card-stubs',
    setup(b) {
        b.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native', namespace: 'rn-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'rn-stub' }, () => ({ contents: RN_STUB, loader: 'tsx', resolveDir: NATIVE }));
        b.onResolve({ filter: /.*/ }, (args) => {
            if (args.namespace === 'rn-stub' || args.namespace === 'stub') return null;
            if (STUB_PACKAGES.includes(args.path)) return { path: args.path, namespace: 'stub', pluginData: { rel: args.path } };
            if (args.path.startsWith('.')) {
                const abs = path.resolve(args.resolveDir, args.path).replace(/\.tsx?$/, '');
                const rel = path.relative(NATIVE, abs);
                if (STUB_FILES.includes(rel)) return { path: abs, namespace: 'stub', pluginData: { rel } };
            }
            return null;
        });
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
            const rel = STUB_PACKAGES.includes(args.path) ? args.path : path.relative(NATIVE, args.path);
            return { contents: stubSource(args.path, rel), loader: 'tsx', resolveDir: NATIVE };
        });
    },
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { eventCopyOf } from '@beanpool/core';
import { MapPreviewCard } from ${JSON.stringify(path.join(NATIVE, 'components/MapPreviewCard'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
globalThis.__theme = { theme: scheme, colors: scheme === 'dark' ? darkColors : lightColors };
globalThis.__identity = { publicKey: 'my-own-member-key', callsign: 'Kim' };
// The map behind the card: Google's light map, and map.tsx's dark style (its geometry colour), as map-event-pin-320 draws it.
const ground = scheme === 'dark' ? '#242f3e' : '#e8eaed';

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();
const CASES = {
    offer: { id: 'p-eggs', type: 'offer', status: 'active', title: 'Fresh duck eggs', category: 'food', repeatable: 1,
        author_pubkey: 'kofi-key', author_callsign: 'Kofi', author_energy_cycled: 12000, credits: 5, price_type: 'fixed', photos: [] },
    need: { id: 'p-ladder', type: 'need', status: 'active', title: 'Borrow a long ladder for the gutters', category: 'tools',
        author_pubkey: 'my-own-member-key', author_callsign: 'Kim', author_energy_cycled: 700, credits: 3, price_type: 'daily', photos: [],
        audience_scope: 'group', target_group_name: 'Mullum Gardeners' },
    going: { id: 'ev-twilight', type: 'event', status: 'active', title: 'Byron Bay Twilight Market - Every Saturday', category: 'events',
        author_pubkey: 'byron-key', author_callsign: 'Byron Markets', event_start_at: iso(now + 2 * DAY), event_end_at: iso(now + 2 * DAY + 5 * 3600000),
        event_state: 'scheduled', event_place_name: 'Railway Park, Jonson Street, Byron Bay', myRsvp: 'going', goingCount: 0, interestedCount: 0, photos: [] },
    nobody: { id: 'ev-repair', type: 'event', status: 'active', title: 'Repair café', category: 'events', author_pubkey: 'mia-key', author_callsign: 'Mia',
        event_start_at: iso(now + 3 * DAY), event_end_at: iso(now + 3 * DAY + 2 * 3600000), event_state: 'updated', event_place_name: 'Scout hall',
        goingCount: 0, interestedCount: 0, photos: [] },
};
const order = Object.keys(CASES);
createRoot(document.getElementById('root')).render(
    <View style={{ width: ${WIDTH}, backgroundColor: ground }}>
        {order.map((k) => (
            <View key={k} testID={'frame-' + k} style={{ width: ${WIDTH}, paddingTop: 8, borderBottomWidth: 1, borderBottomColor: scheme === 'dark' ? '#1b2330' : '#d5d8dc' }}>
                <Text style={{ fontSize: 10, color: scheme === 'dark' ? '#9aa3b2' : '#5f6368', paddingHorizontal: 16 }}>{k}</Text>
                <MapPreviewCard post={CASES[k]} copy={eventCopyOf(CASES[k])} showsBeans={true} onOpen={() => {}} onClose={() => {}} />
            </View>
        ))}
    </View>
);
`);

const outfile = path.join(work, 'bundle.js');
await build({
    entryPoints: [entry], bundle: true, outfile, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error',
    plugins: [plugin],
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.ttf': 'dataurl', '.json': 'json' },
    resolveExtensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.js', '.json'],
    alias: { 'react-native-svg': 'react-native-svg-web' },
    banner: { js: 'var process = { env: {}, platform: "web" };' },
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"', global: 'window' },
    nodePaths: [path.join(NATIVE, 'node_modules'), path.resolve(NATIVE, '../../node_modules')],
});

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}"><style>html,body,#root{margin:0;padding:0;width:${WIDTH}px;overflow-x:hidden}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/bundle.js')) { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(outfile)); return; }
    res.setHeader('content-type', 'text/html'); res.end(html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const own = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL', msg); };
for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
    await page.route('**/*', (route) => (route.request().url().startsWith(own) ? route.continue() : route.abort()));
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${own}/?scheme=${scheme}`);
    await page.waitForTimeout(1200);
    console.log(scheme);
    if (errors.length) fail(`page errors: ${errors.join(' | ').slice(0, 400)}`);
    const result = await page.evaluate((W) => {
        const frames = Array.from(document.querySelectorAll('[data-testid^="frame-"]'));
        let past = 0;
        for (const el of Array.from(document.querySelectorAll('#root *'))) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && r.right > W + 1 && getComputedStyle(el).position !== 'fixed') past++;
        }
        return {
            past, sideways: document.documentElement.scrollWidth > W,
            cards: frames.map((frame) => {
                const card = frame.querySelector('[data-testid="map-preview-open"]');
                const close = frame.querySelector('[data-testid="map-preview-close"]');
                const r = card.getBoundingClientRect();
                const slot = card.firstElementChild.getBoundingClientRect();
                const head = card.lastElementChild.firstElementChild.getBoundingClientRect();
                const x = close.getBoundingClientRect();
                const border = parseFloat(getComputedStyle(card).borderLeftWidth);
                return {
                    id: frame.getAttribute('data-testid').slice(6), left: r.left, right: r.right, height: r.height, border,
                    slotLeft: slot.left, slotWidth: slot.width, slotHeight: slot.height, headRight: head.right, closeLeft: x.left,
                    closeTop: x.top - r.top, closeRight: r.right - x.right, closeSize: [x.width, x.height],
                    buttonsInside: card.querySelectorAll('[role="button"]').length,
                    buttons: frame.querySelectorAll('[role="button"]').length,
                    text: card.innerText.split('\n').filter(Boolean),
                };
            }),
        };
    }, WIDTH);
    if (result.sideways) fail('sideways scroll');
    if (result.past) fail(`${result.past} element(s) drawn past the ${WIDTH} dp edge`);
    for (const c of result.cards) {
        if (Math.abs(c.left - 16) > 0.5 || Math.abs(c.right - (WIDTH - 16)) > 0.5) fail(`${c.id}: the card is at ${c.left}..${c.right}, not 16 in from either edge`);
        if (Math.abs(c.slotLeft - (c.left + c.border)) > 0.5 || Math.abs(c.slotWidth - 80) > 0.5) fail(`${c.id}: the picture is at ${c.slotLeft} x ${c.slotWidth}, not flush and 80 wide`);
        if (Math.abs(c.slotHeight - (c.height - 2)) > 0.5) fail(`${c.id}: the picture is ${c.slotHeight} tall, not the card's ${c.height - 2}`);
        if (c.buttonsInside) fail(`${c.id}: ${c.buttonsInside} button(s) inside the card`);
        if (c.buttons !== 2) fail(`${c.id}: ${c.buttons} buttons in the pop-up, not the card and the ✕`);
        if (c.closeSize[0] !== 28 || c.closeSize[1] !== 28 || Math.abs(c.closeTop - 8) > 0.5 || Math.abs(c.closeRight - 8) > 0.5) fail(`${c.id}: the ✕ is ${c.closeSize} at ${c.closeTop} / ${c.closeRight} from the corner`);
        if (c.headRight > c.closeLeft + 0.5) fail(`${c.id}: the first row runs under the ✕ (${c.headRight} > ${c.closeLeft})`);
        if (c.text.some(l => /View (event|Details|listing)/.test(l))) fail(`${c.id}: a View button's words are on the card`);
        if (c.text.some(l => /(^|\D)0 (going|interested)/.test(l))) fail(`${c.id}: a zero count is drawn`);
        // The check must be able to fail: Marty's shot of 4 Nov read "👥 0 going".
        if (!/(^|\D)0 (going|interested)/.test('👥 0 going')) fail('the zero-count check cannot see a zero count');
        console.log(`  ${c.id}: ${Math.round(c.height)} dp [${c.text.join(' | ')}]`);
    }
    if (SHOTS) {
        await page.screenshot({ path: path.join(SHOTS, `map-preview-card-${scheme}.png`), fullPage: true });
        for (const c of result.cards) await page.locator(`[data-testid="frame-${c.id}"]`).screenshot({ path: path.join(SHOTS, `map-preview-card-${c.id}-${scheme}.png`) });
    }
    await page.close();
}
await browser.close();
server.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
