#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * The event page on the style box (DESIGN-detail-pages-fable.md §3 slice DP1) at the floor: 320dp wide, the phone's text at
 * 1.3x, light and dark. The app's own components/EventDetail.tsx through react-native-web in headless Chromium, with the
 * device, the router, the node and the account stubbed at the boundary (market-order-320.mjs's way: each stub exports exactly
 * the names the app imports from it) and the page, its boxes, the Share button and its sheet real. A stand-in for a phone:
 * Android's fonts and line breaks differ.
 *
 * The fixture is the Mullum market (Marty's shot, 4 Nov): a two-line title, a repeat rule, a photo, and the six next dates
 * the node sends by id (behind the rule on the page: "↻ Monthly, third Saturday · Next dates", one button under the when,
 * DESIGN-web-dates-stop-fable.md §4). Cases:
 *   member           a member who has not answered: Going / Interested, no counts
 *   going            a member who is Going: the chosen answer, the counts, the chat in the quiet row, Remind me, the note
 *   host             the host: "You're hosting this event", the counts, the guest list box with Edit event, no Report
 *   copy             a member's copy on the global community: the copy's door, the "from" line, no host box
 *   nophoto          the member case with no photo: the event's tile, 3:1
 *   member-nodates   the member case with no next dates (an older node, or before the node answers): the rule alone
 *   nophoto-nodates  the same with no photo
 *   member-open      the member case with the next dates opened: all six (nophoto-open: the same with no photo)
 *   host-open        the host's case opened: each date with Cancel this date and Change this date only
 *
 * Each case, each scheme, fails on: the page scrolling sideways; text past the edge or cut; a button under 47.5dp; text under
 * 4.5:1 (3:1 large); in a state a member arrives in, the answer row's top past 500dp, or the answer's bottom (Going's; the
 * host's line, the copy's door) past the 569dp screen (the stop, DESIGN-detail-pages-frame-fable.md §2); with the list a member
 * opened (member-open, nophoto-open), the answer row's top past the 569dp screen (DESIGN-web-dates-stop-fable.md §2). It
 * prints where both land. Shots go to --shots <dir>
 * (not committed): the page one 569dp screen at a time, the first is what a member sees on opening it.
 *
 *   node apps/native/e2e/event-page-320.mjs --shots <dir>
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
const SCREEN = 569; // 320 x 16:9, the floor's whole screen
// The stop (DESIGN-detail-pages-frame-fable.md §2): in every state a member arrives in, the answer row's top at or above 500dp.
const STOP = 500;
// The list a member opened themselves is exempt from 500 but keeps the answer's top on the first screen
// (DESIGN-web-dates-stop-fable.md §2): it is their own tap and the dates are what they asked to read, so the list may push
// the answer down, never off the screen. The host's opened date manager is not gated (see below).
const OPENED_STOP = SCREEN;
const TALL = 1500; // the whole page in one shot: the real phone scrolls it
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'event-page-320-'));

// ─── What is stubbed: files and packages that reach the device, the network, the router or the account ───────────────────
const STUB_FILES = [
    'app/IdentityContext', 'app/ThemeContext', 'app/NodeStatusContext', 'utils/db', 'utils/use-node-profile', 'utils/identity',
    'utils/nodes', 'utils/node-admin', 'utils/crypto', 'utils/peek', 'utils/haptics', 'utils/use-pin-role', 'utils/blocklist',
    'components/InviteAsks', 'components/NewEventModal', 'components/PinSheet', 'components/ShowOnGlobalRow',
];
const STUB_PACKAGES = [
    'expo-router', 'expo-image', '@expo/vector-icons', '@react-native-async-storage/async-storage', 'react-native-safe-area-context',
    'react-native-keyboard-controller', 'expo-file-system/legacy', 'expo-sharing', 'expo-intent-launcher', 'expo-secure-store',
    'expo-crypto', 'expo-constants', 'expo-location', 'expo-clipboard', 'expo-haptics',
];

// ─── The names each stub must export: read off the app's own imports, so a new import never breaks the harness ──────────
const sources = [];
const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (/__tests__|node_modules/.test(full)) continue;
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) sources.push(full);
    }
};
['app', 'components', 'utils', 'services', 'constants'].map((d) => path.join(NATIVE, d)).forEach(walk);
const IMPORT = /import\s+(type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+[\w$]+\s*)?from\s+'([^']+)'/g;
const namesFor = (key) => {
    const names = new Set();
    for (const file of sources) {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(IMPORT)) {
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

/** Hand-written bodies where the default (a component that draws nothing, a function that answers nothing) is wrong. */
const OVERRIDES = {
    'app/IdentityContext': { useIdentity: `() => ({ identity: globalThis.__identity, isLoading: false })` },
    'app/ThemeContext': { useTheme: `() => globalThis.__theme`, useStyles: `(make) => make(globalThis.__theme)` },
    'app/NodeStatusContext': { useNodeStatus: `() => ({ recognition: 'member', nodeUrl: 'https://mullum.example', recheck: async () => 'member' })` },
    'utils/db': {
        fetchEventDetail: `async () => globalThis.__view`,
        getMemberRatings: `async () => ({ ratings: [], average: 0, count: 0 })`,
        fetchMyEvents: `async () => []`,
        fetchMemberPreferences: `async () => ({})`,
        isRouteMissing: `() => false`,
    },
    'utils/use-node-profile': { useNodeProfile: `() => ({ profile: 'local', checkedAt: '', features: { beans: true, invites: true, knocks: true, door: 'members' } })` },
    'utils/identity': { loadIdentity: `async () => globalThis.__identity` },
    'utils/nodes': { isGuestNode: `async () => false` },
    'utils/node-admin': {
        askNodeRole: `async () => ({ role: null, communityName: 'Mullumbimby' })`, cachedNodeRoleHeard: `async () => ({ role: null, communityName: 'Mullumbimby' })`,
        persistNodeRole: `async () => {}`, readPersistedNodeRole: `async () => undefined`,
    },
    'utils/crypto': { buildSignedHeaders: `async () => ({})` },
    'utils/peek': { peekStopsHere: `() => 0` },
    'utils/use-pin-role': { usePinRole: `() => 'none'` },
    'utils/blocklist': { getBlockedUsers: `async () => []`, BLOCKLIST_UPDATED_EVENT: `'blocklist_updated'` },
    'expo-router': {
        router: `({ back() {}, push() {}, replace() {}, navigate() {}, canGoBack: () => true, setParams() {} })`,
        useLocalSearchParams: `() => ({})`,
        useFocusEffect: `(cb) => React.useEffect(() => cb(), [cb])`,
        useNavigation: `() => ({ addListener: () => () => {}, isFocused: () => true })`,
    },
    'expo-image': { Image: `({ source, style }) => React.createElement(RN.Image, { source, style, resizeMode: 'cover' })` },
    'react-native-safe-area-context': {
        useSafeAreaInsets: `() => ({ top: 24, bottom: 0, left: 0, right: 0 })`,
        SafeAreaView: `({ children, style }) => React.createElement(RN.View, { style }, children)`,
    },
    'react-native-keyboard-controller': {
        KeyboardAwareScrollView: `({ children, contentContainerStyle }) => React.createElement(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle }, children)`,
        KeyboardAvoidingView: `({ children, style }) => React.createElement(RN.View, { style }, children)`,
        KeyboardStickyView: `({ children, style }) => React.createElement(RN.View, { style }, children)`,
        KeyboardProvider: `({ children }) => children`,
    },
    'expo-file-system/legacy': { cacheDirectory: `'/tmp/'`, EncodingType: `({ UTF8: 'utf8' })` },
    'expo-constants': { default: `({ expoConfig: { version: '1.2.98' } })` },
};

const stubSource = (key, rel) => {
    if (key === '@react-native-async-storage/async-storage') {
        return `export default { getItem: async (k) => (k === 'beanpool_anchor_url' ? 'https://mullum.example' : null), setItem: async () => {}, removeItem: async () => {} };`;
    }
    const over = OVERRIDES[rel] ?? {};
    const names = new Set([...namesFor(key), ...Object.keys(over)]);
    const lines = [`import React from 'react'; import * as RN from 'react-native';`];
    for (const n of names) {
        if (n === 'default') continue;
        const body = over[n] ?? (/^[A-Z][A-Z0-9_]+$/.test(n) ? `[]` : /^[A-Z]/.test(n) ? `() => null` : /^use[A-Z]/.test(n) ? `() => null` : /^(get|fetch|read|list)/.test(n) ? `async () => []` : `async () => null`);
        lines.push(`export const ${n} = ${body};`);
    }
    lines.push(`export default ${over.default ?? '{}'};`);
    return lines.join('\n');
};

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
    export const TextInput = React.forwardRef((p, ref) => React.createElement(RNW.TextInput, { ...p, ref, style: scaled(p.style) }));
    export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o['android'] ?? o.default };
    export const Alert = { alert() {} };
    export const useWindowDimensions = () => ({ width: ${WIDTH}, height: ${SCREEN}, scale: 1.5, fontScale: ${SCALE} });
    export default { ...RNW, Text, TextInput, Platform, Alert, useWindowDimensions };
`;

const plugin = {
    name: 'event-page-stubs',
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

// ─── The page: each case renders the real EventDetail for one state ───────────────────────────────────────────────────────
const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { EventDetail } from ${JSON.stringify(path.join(NATIVE, 'components/EventDetail'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__theme = { theme: scheme, colors };
const ME = '9'.repeat(64);
const HOST = '7'.repeat(64);
const c = q.get('case') || 'member';
const hosting = c === 'host' || c === 'host-open';
globalThis.__identity = { publicKey: hosting ? HOST : ME, privateKey: '8'.repeat(64), callsign: hosting ? 'Damo' : 'Wren' };
// A 4:3 photo of a market, drawn, from the harness's own server: no network.
const PHOTO = location.origin + '/market.svg';
const DAY = 86400000;
// The third Saturday from now, at 8:00 to 14:00 Mullumbimby time, as the market runs.
const start = new Date(Date.now() + 9 * DAY); start.setUTCHours(22, 0, 0, 0);
const base = {
    id: '11111111-2222-4333-8444-555555555555', type: 'event', title: 'Mullumbimby Community Market',
    description: 'The farmers and community market at Summers Park: local food, plants, makers and music, every third Saturday. Bring a bag.',
    author_pubkey: HOST, authorPublicKey: HOST, authorCallsign: 'Damo',
    eventStartAt: start.toISOString(), eventEndAt: new Date(start.getTime() + 6 * 3600000).toISOString(), eventTz: 'Australia/Sydney',
    eventRepeat: { freq: 'monthly', interval: 1, byDay: 'SA', pos: 3 },
    eventPlaceName: 'Summers Park', lat: -28.5537, lng: 153.4994,
    photos: c.startsWith('nophoto') ? [] : [PHOTO], goingCount: 0, interestedCount: 0, tags: ['food'],
};
// What the node adds on a by-id read of a repeating event (packages/beanpool-engine/src/posts.ts, EVENT_NEXT_DATES = 6): the
// next six dates, the event's own date first (the one its when line shows), then the third Saturday of each month after it.
// The event's own date where it runs (its when line is drawn in Australia/Sydney, whatever the machine's zone): YYYY-MM-DD.
const nextDates = [new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(start)];
const [y0, m0] = nextDates[0].split('-').map(Number);
for (let m = 1; nextDates.length < 6; m++) {
    const first = new Date(Date.UTC(y0, m0 - 1 + m, 1));
    nextDates.push(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 15 + ((6 - first.getUTCDay() + 7) % 7))).toISOString().slice(0, 10));
}
const byIdDates = nextDates.map((date) => ({ date, startLocal: date + 'T08:00', startAt: date + 'T08:00:00+10:00', endAt: date + 'T14:00:00+10:00', cancelled: false }));
let post = base;
const byId = /-nodates$/.test(c) ? base : { ...base, eventNextDates: byIdDates };
let view = { ...byId, myRsvp: null };
if (c === 'going') view = { ...byId, myRsvp: 'going', goingCount: 3, interestedCount: 1, eventPrivateNote: 'Stall holders park behind the hall, not on the oval.' };
if (c === 'host' || c === 'host-open') view = { ...byId, goingCount: 3, interestedCount: 1, eventRsvps: [
    { memberPubkey: '1'.repeat(64), memberCallsign: 'Sam', status: 'going', updatedAt: '2026-11-01T00:00:00.000Z' },
    { memberPubkey: '2'.repeat(64), memberCallsign: 'Tia', status: 'interested', updatedAt: '2026-11-01T00:00:00.000Z' },
] };
if (c === 'copy') {
    post = { ...base, shown_from: JSON.stringify({ host: 'mullum.example', name: 'Mullumbimby', url: 'https://mullum.example', door: 'ask', price: { amount: 0, unit: 'fixed' } }) };
    view = null;
}
globalThis.__view = view;
createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', backgroundColor: colors.surface.app }}>
        <EventDetail post={post} />
    </View>,
);
`);

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.png': 'empty', '.ttf': 'empty', '.webp': 'empty', '.jpg': 'empty' },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.mjs', '.json'],
    nodePaths: [path.join(ROOT, 'node_modules'), path.join(NATIVE, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"', global: 'window' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {} };' },
    logLevel: 'error',
    plugins: [plugin],
});
const bundle = result.outputFiles[0].text;
const PHOTO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#7a9e7e"/><rect y="380" width="800" height="220" fill="#c9a66b"/><g fill="#f2efe6"><path d="M80 380 l90 -120 90 120z"/><path d="M300 380 l90 -120 90 120z"/><path d="M520 380 l90 -120 90 120z"/></g><circle cx="680" cy="110" r="60" fill="#f6d365"/></svg>';
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<style>html,body,#root{margin:0;height:100%} body{font-family:sans-serif}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    if (req.url === '/market.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(PHOTO_SVG); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const problems = [];
const rows = [];
let states = 0;
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: TALL }, deviceScaleFactor: 1.5 }); // a 569dp screen is 853px: each shot opens whole at 900px
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    const measure = async (label) => {
        states++;
        const found = await page.evaluate(({ WIDTH }) => {
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
                let bg = { r: 255, g: 255, b: 255, a: 1 };
                for (const l of layers.reverse()) bg = over(l, bg);
                return bg;
            };
            if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
            // Not this slice's, and not a phone's fault: the header's "Back" shrinks to fit on Android (adjustsFontSizeToFit), which
            // react-native-web does not do; the header is drawn as it was.
            const header = document.querySelector('[aria-label="Back"]');
            const texts = [...document.querySelectorAll('div[dir], span, input, textarea')]
                .filter((el) => !header?.contains(el))
                .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = el.textContent.trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
                if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`"${what}" is cut on the right (${el.scrollWidth} > ${el.clientWidth})`);
                if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') out.push(`"${what}" is cut at the bottom (${el.scrollHeight} > ${el.clientHeight})`);
                const cs = getComputedStyle(el);
                const fg = rgb(cs.color);
                if (!fg) continue;
                // An emoji alone is drawn in its own colours: its text colour is no measure of it.
                if (/^[\p{Extended_Pictographic}️‍\s←·▼▲]+$/u.test(what)) continue;
                const bg = backdrop(el);
                const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
                const ratio = (a + 0.05) / (b + 0.05);
                const size = parseFloat(cs.fontSize);
                const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                if (ratio < (large ? 3 : 4.5)) out.push(`"${what}" has contrast ${ratio.toFixed(2)}:1 (${cs.color} on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}), ${size}px)`);
            }
            for (const el of document.querySelectorAll('[role="button"]')) {
                const r = el.getBoundingClientRect();
                if (r.width === 0) continue;
                // The tag chips are 44dp by their own design (components/PostTagChips.tsx, event-tag-chips-render.test.ts), not this slice's.
                if (el.closest('[data-testid="detail-tags-row"]')) continue;
                if (r.height < 47.5) out.push(`the button "${el.textContent.trim().slice(0, 40) || el.getAttribute('aria-label')}" is ${Math.round(r.height)}dp tall`);
            }
            return out;
        }, { WIDTH });
        for (const p of found) problems.push(`${label}: ${p}`);
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };

    for (const scheme of ['light', 'dark']) {
        for (const c of ['member', 'going', 'host', 'copy', 'nophoto', 'member-nodates', 'nophoto-nodates', 'member-open', 'nophoto-open', 'host-open']) {
            const tag = `${scheme} · ${c}`;
            await page.goto(`${base}/?scheme=${scheme}&case=${c}`);
            await page.locator('[data-testid="event-chip-row"]').waitFor();
            await page.waitForTimeout(600);
            // The next dates as a member opens them: the compact line's one button, then the whole list.
            if (c.endsWith('-open')) {
                await page.locator('[data-testid="event-next-dates-open"]').click();
                await page.locator('[data-testid="event-next-date"]').first().waitFor();
            }
            await measure(tag);
            // Where the answer (or the host's line, or the copy's door) starts and ends, from the screen's top; the photo's top.
            const at = await page.evaluate(() => {
                const action = document.querySelector('[data-testid="event-action"]');
                const photo = document.querySelector('[data-testid="event-photo-frame"]') || document.querySelector('[data-testid="event-tile-banner"]');
                const p = photo?.getBoundingClientRect();
                // The answer itself: Going (chosen or not), else the action's first part (the host's line, the copy's door), not the counts under it.
                const answer = (document.querySelector('[aria-label^="Going"]') || action?.firstElementChild)?.getBoundingClientRect();
                const dates = document.querySelector('[data-testid="event-next-dates-open"]') || document.querySelector('[data-testid="event-next-dates"]');
                return {
                    action: action ? action.getBoundingClientRect().top : null, photo: p ? `${Math.round(p.width)} x ${Math.round(p.height)}` : null,
                    photoTop: p ? p.top : null, answer: answer ? answer.bottom : null, going: !!document.querySelector('[aria-label^="Going"]'),
                    dates: dates ? Math.round(dates.getBoundingClientRect().height) : 0,
                };
            });
            const dp = (n) => (n == null ? '—' : String(Math.round(n * 10) / 10));
            const whose = at.going ? "Going's" : "the answer's";
            rows.push(`${tag}: the answer row's top at ${dp(at.action)} dp, ${whose} bottom at ${dp(at.answer)} dp, the photo's top at ${dp(at.photoTop)} dp, the next dates ${at.dates} dp tall, the picture ${at.photo}`);
            // The stop (DESIGN-detail-pages-frame-fable.md §2): fail, not print. The states a member arrives in at STOP and the
            // screen; the member's opened list at OPENED_STOP. Not on host-open: the host opened their own date manager (six
            // dates, each with Cancel and Change, about 610dp by itself), and their line is no answer to make; it is printed
            // above, and the stop's cases are the member's (§1.4's table), the host's compact page and the copy.
            const opened = c === 'member-open' || c === 'nophoto-open';
            if (c !== 'host-open') {
                if (at.action == null) problems.push(`${tag}: no answer row`);
                else if (opened && at.action > OPENED_STOP) problems.push(`${tag}: opened, the answer row's top at ${dp(at.action)} dp, past the ${OPENED_STOP} dp screen`);
                else if (!opened && at.action > STOP) problems.push(`${tag}: the answer row's top at ${dp(at.action)} dp, past ${STOP}`);
                if (!opened && at.answer != null && at.answer > SCREEN) problems.push(`${tag}: ${whose} bottom at ${dp(at.answer)} dp, past the ${SCREEN} dp screen`);
            }
            if (SHOTS) {
                const name = `phone-event-${scheme}-${c}`;
                // The page as a member scrolls it, one 569dp screen at a time, to the end (a little under the last button).
                const end = await page.evaluate(() => {
                    const last = [...document.querySelectorAll('[role="button"]')].pop();
                    return Math.ceil((last?.getBoundingClientRect().bottom ?? 0) + 24);
                });
                for (let i = 0, y = 0; y < Math.min(TALL, end); i++, y += SCREEN) {
                    await page.screenshot({ path: path.join(SHOTS, `${name}-${i + 1}.png`), clip: { x: 0, y, width: WIDTH, height: Math.min(SCREEN, TALL - y) } });
                }
            }
        }
    }
    for (const e of errors) problems.push(`page error: ${e}`);
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n${rows.join('\n')}`);
console.log(`\n${states} states at ${WIDTH}dp with ${SCALE}× text, light and dark`);
if (problems.length) {
    console.log(problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
}
console.log(`Every state holds: no sideways scroll, nothing past the edge or cut, every button 48dp, text at 4.5:1 or better, the answer on the first screen (top ≤ ${STOP}dp and bottom ≤ ${SCREEN}dp as a member arrives; top ≤ ${OPENED_STOP}dp with the list they opened).`);
