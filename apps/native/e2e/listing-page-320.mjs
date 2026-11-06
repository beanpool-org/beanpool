#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * The listing page (an Offer or a Need) on the style box (DESIGN-detail-pages-fable.md §3 slice DP3, in the order
 * DESIGN-detail-pages-frame-fable.md §1.7 and §3 give it) at the floor: 320dp wide, the phone's text at 1.3x, light and dark.
 * The app's own app/post/[id].tsx through react-native-web in headless Chromium, with the device, the router, the node and
 * the account stubbed at the boundary (event-page-320.mjs's way: each stub exports exactly the names the app imports from it)
 * and the page, its boxes, the Share button and its sheet real. A stand-in for a phone: Android's fonts and line breaks differ.
 *
 * Cases:
 *   apples          Marty's apples: a Need on the worldwide community, Beans off (IN RETURN, the long note, the local
 *                   community's line), I can do this for a member who is not Marty; a photo
 *   apples-nophoto  the same with no photo: the category's tile, 3:1
 *   apples-more     the apples with the note opened ("More"): the take-up pushed down, still on the first screen
 *   offer           an Offer with Beans (30 B / Hr): the price box, Accept Offer
 *   own             the author's own Offer: Pause, Edit, Delete where the take-up goes
 *   deal            a deal under way: the member took the Offer up, the Beans held, Release, Message, Cancel
 *   need-open       (cold start N4) another member's Need, "I can do this" tapped: the confirmation's one sentence (the amount,
 *                   the name, who agrees), no fee line, no Trust Wallet box
 *   need-hours-open the same priced by the hour, 3 hours typed: the total follows (60 Beans)
 *   need-free-open  a free Need: "You'd do it for free", never "0 Beans"
 *
 * Each case, each scheme, fails on: the page scrolling sideways; text past the edge or cut; a button under 47.5dp; text under
 * 4.5:1 (3:1 large); and where there is a take-up (apples, offer), its top past 500dp or its bottom past the 569dp screen
 * (the stop, DESIGN-detail-pages-frame-fable.md §2); with the note a member opened (apples-more), its top past the 569dp
 * screen. The note clamped under its "More" is cut on purpose and not counted. It prints where the take-up, the terms box,
 * the photo and Share land. Shots go to --shots <dir>
 * (not committed): the page one 569dp screen at a time; the first is what a member sees on opening it.
 *
 *   node apps/native/e2e/listing-page-320.mjs --shots <dir>
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
// The stop (DESIGN-detail-pages-frame-fable.md §2): the take-up's top at or above 500dp, its bottom on the 569dp screen.
const STOP = 500;
const TALL = 1500; // the whole page in one shot: the real phone scrolls it
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-page-320-'));

// ─── What is stubbed: files and packages that reach the device, the network, the router or the account ───────────────────
const STUB_FILES = [
    'app/IdentityContext', 'app/ThemeContext', 'app/NodeStatusContext', 'utils/db', 'utils/use-node-profile', 'utils/identity',
    'utils/nodes', 'utils/node-admin', 'utils/crypto', 'utils/peek', 'utils/haptics', 'utils/use-pin-role', 'utils/blocklist',
    'components/InviteAsks', 'components/NewEventModal', 'components/PinSheet', 'components/ShowOnGlobalRow',
    'utils/use-reader-features', 'utils/reads-own', 'utils/profile-status', 'services/pillar-sync', 'utils/shop', 'utils/post-photo',
    'components/MyDealsSheet', 'components/ReviewModal', 'components/EventDetail', 'utils/look-door', 'components/useKeepCaretVisible',
];
const STUB_PACKAGES = [
    'expo-router', 'expo-image', '@expo/vector-icons', '@react-native-async-storage/async-storage', 'react-native-safe-area-context',
    'react-native-keyboard-controller', 'expo-file-system/legacy', 'expo-sharing', 'expo-intent-launcher', 'expo-secure-store',
    'expo-crypto', 'expo-constants', 'expo-location', 'expo-clipboard', 'expo-haptics', 'expo-image-picker', 'expo-image-manipulator',
    '@react-native-picker/picker',
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
        getPost: `async () => globalThis.__post`,
        // The phone's own copy of the deals: the deal held on this listing, as the database row (snake case).
        getDb: `async () => ({ getFirstAsync: async (sql) => (sql.includes('FROM marketplace_transactions') ? (globalThis.__dbTx ?? null) : null), getAllAsync: async () => [], runAsync: async () => ({}) })`,
        getMemberRatings: `async () => ({ ratings: [], average: null, count: 0 })`,
        getMarketplaceTransactions: `async () => globalThis.__txs ?? []`,
        getDealsFor: `async () => []`,
        getUnreadCountForPost: `async () => 0`,
        getBalance: `async () => ({ isBlockedFromTrading: false, keeperOf: [] })`,
        fetchGroupDetails: `async () => null`,
        isRouteMissing: `() => false`,
    },
    'utils/use-node-profile': {
        useNodeProfile: `() => globalThis.__profile`,
        useNodeProfileState: `() => ({ profile: globalThis.__profile, copyRead: true })`,
    },
    'utils/use-reader-features': { useReaderFeatures: `() => ({ node: globalThis.__profile.features, reader: null, effective: globalThis.__profile.features, known: true })` },
    'utils/reads-own': { readsOwn: `async () => true`, readsOwnWith: `() => true` },
    'utils/profile-status': { getProfileStatus: `async () => ({ complete: true, missingName: false, missingAvatar: false })`, acceptNeedsProfileLine: `() => ''` },
    'services/pillar-sync': { requestSync: `async () => {}`, isPillarSyncActive: `() => false`, syncLandedOnThisCopy: `async () => false`, PILLAR_SYNC_ENDED: `'pillar_sync_ended'` },
    'utils/shop': { readListingShopId: `async () => null`, readMyShop: `async () => null` },
    // Reanimated's worklets do not run on the web: the scroll keeps no caret here (no field is typed into).
    'components/useKeepCaretVisible': { useKeepCaretVisible: `() => ({ scrollRef: React.useRef(null), scrollProps: {} })` },
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
        useLocalSearchParams: `() => globalThis.__params`,
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
        return `export default { getItem: async (k) => (k === 'beanpool_anchor_url' ? 'https://mullum.example' : null), setItem: async () => {}, removeItem: async () => {}, multiGet: async (ks) => ks.map((k) => [k, null]), getAllKeys: async () => [] };`;
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
    name: 'listing-page-stubs',
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

// ─── The page: each case renders the real listing screen for one reader ───────────────────────────────────────────────────
const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import PostDetail from ${JSON.stringify(path.join(NATIVE, 'app/post/[id]'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__theme = { theme: scheme, colors };
const ME = '9'.repeat(64);
const MARTY = '7'.repeat(64);
const DAMO = '6'.repeat(64);
const KOFI = '5'.repeat(64);
const c = q.get('case') || 'apples';
globalThis.__identity = { publicKey: ME, privateKey: '8'.repeat(64), callsign: 'Wren' };
// A 4:3 photo, drawn, from the harness's own server: no network.
const PHOTO = location.origin + '/apples.svg';
const DAY = 86400000;
const LOCAL = { profile: 'local', checkedAt: new Date().toISOString(), features: { beans: true, escrow: true, invites: true, knocks: true, door: 'members', enterprises: true } };
// The worldwide community as Marty's shot has it: Beans off and shown as a local community's (the showcase), deals on.
const GLOBAL = { profile: 'global', checkedAt: new Date().toISOString(), features: { beans: false, escrow: true, showcase: true, invites: true, decisions: false } };
const apples = {
    id: 'p-apples', type: 'need', status: 'active', title: 'Apples needed', description: 'Looking for fresh apples', category: 'food',
    author_pubkey: MARTY, author_callsign: 'Marty', credits: 0, price_type: 'fixed', repeatable: 1, audience_scope: 'public',
    photos: c === 'apples-nophoto' ? '[]' : JSON.stringify([PHOTO]), created_at: new Date(Date.now() - 3 * DAY).toISOString(),
};
const offer = {
    id: 'p-pots', type: 'offer', status: 'active', title: 'Pottery lessons on the wheel', description: 'Six weeks on the wheel, clay and glazes included. Bring an apron.',
    category: 'education', author_pubkey: DAMO, author_callsign: 'Damo', credits: 30, price_type: 'hourly', repeatable: 1, audience_scope: 'public',
    photos: JSON.stringify([PHOTO]), created_at: new Date(Date.now() - 2 * DAY).toISOString(),
};
// Cold start N4: another member's Need on a community with Beans, the take-up tapped (the case's own -open ending).
const fence = {
    id: 'p-fence', type: 'need', status: 'active', title: 'Help mending the fence', description: 'Saturday morning, tools provided.', category: 'labour',
    author_pubkey: KOFI, author_callsign: 'Kofi', credits: 40, price_type: 'fixed', repeatable: 1, audience_scope: 'public',
    photos: JSON.stringify([PHOTO]), created_at: new Date(Date.now() - 2 * DAY).toISOString(),
};
let post = apples;
let profile = GLOBAL;
if (c === 'offer') { post = offer; profile = LOCAL; }
if (c === 'own') { post = { ...offer, author_pubkey: ME, author_callsign: 'Wren' }; profile = LOCAL; }
if (c === 'need-open') { post = fence; profile = LOCAL; }
if (c === 'need-hours-open') { post = { ...fence, id: 'p-bed', title: 'Dig a vegetable bed', price_type: 'hourly', credits: 20 }; profile = LOCAL; }
if (c === 'need-free-open') { post = { ...fence, id: 'p-chairs', title: 'Carry chairs to the hall', credits: 0 }; profile = LOCAL; }
if (c === 'deal') {
    // A one-off Offer the member took up two days ago: the Beans held for Damo until the member releases them.
    post = { ...offer, id: 'p-ladder', title: 'Ladder and a hand to clean the gutters', repeatable: 0, credits: 45, price_type: 'fixed', status: 'pending', accepted_by: ME, pending_transaction_id: 'tx-1' };
    profile = LOCAL;
    const at = new Date(Date.now() - 2 * DAY).toISOString();
    globalThis.__txs = [{ id: 'tx-1', postId: 'p-ladder', status: 'pending', buyerPublicKey: ME, buyerCallsign: 'Wren', sellerPublicKey: DAMO, sellerCallsign: 'Damo', credits: 45, hours: null, createdAt: at }];
    globalThis.__dbTx = { id: 'tx-1', post_id: 'p-ladder', status: 'pending', buyer_pubkey: ME, buyer_callsign: 'Wren', seller_pubkey: DAMO, seller_callsign: 'Damo', credits: 45, hours: null, created_at: at };
}
globalThis.__post = post;
globalThis.__profile = profile;
globalThis.__params = { id: post.id };
createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', backgroundColor: colors.surface.app }}>
        <PostDetail />
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
const PHOTO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#9cb38a"/><rect y="420" width="800" height="180" fill="#b58b5a"/><g fill="#c0392b"><circle cx="250" cy="380" r="70"/><circle cx="400" cy="400" r="70"/><circle cx="550" cy="380" r="70"/><circle cx="325" cy="300" r="70"/><circle cx="475" cy="300" r="70"/></g><circle cx="680" cy="110" r="60" fill="#f6d365"/></svg>';
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<style>html,body,#root{margin:0;height:100%} body{font-family:sans-serif}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    if (req.url === '/apples.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(PHOTO_SVG); return; }
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
            // The IN RETURN note clamps to three lines while its "More" is there (the frame's first fallback): cut on purpose.
            const clampedNote = document.querySelector('[data-testid="no-beans-terms-more"]') ? document.querySelector('[data-testid="no-beans-terms-note"]') : null;
            const texts = [...document.querySelectorAll('div[dir], span, input, textarea')]
                .filter((el) => !header?.contains(el))
                .filter((el) => !clampedNote?.contains(el))
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
        for (const c of ['apples', 'apples-nophoto', 'apples-more', 'offer', 'own', 'deal', 'need-open', 'need-hours-open', 'need-free-open']) {
            const tag = `${scheme} · ${c}`;
            await page.goto(`${base}/?scheme=${scheme}&case=${c}`);
            await page.locator('[data-testid="post-chip-row"]').waitFor({ timeout: 15000 }).catch(async (e) => {
                // Say what the screen drew instead (a stub the page now needs, a page error), not a bare timeout.
                const drawn = await page.evaluate(() => document.body.innerText.slice(0, 400));
                throw new Error(`${tag}: the page never drew its chips. Errors: ${errors.join(' | ') || 'none'}. Drawn: ${drawn}`, { cause: e });
            });
            await page.waitForTimeout(800);
            // The note as a member opens it: "More", then the whole note, nothing cut.
            if (c === 'apples-more') {
                await page.locator('[data-testid="no-beans-terms-more"]').click();
                await page.locator('[data-testid="no-beans-terms-more"]').waitFor({ state: 'detached' });
            }
            // Cold start N4: "I can do this" tapped; the confirmation says one plain sentence and nothing of the fee.
            if (c.endsWith('-open')) {
                const want = {
                    'need-open': "You'd do it for 40 Beans. Kofi agrees, you do it, Kofi confirms, and the Beans are yours.",
                    'need-hours-open': "You'd do it for 60 Beans. Kofi agrees, you do it, Kofi confirms, and the Beans are yours.",
                    'need-free-open': "You'd do it for free. Kofi agrees, you do it, and Kofi confirms.",
                }[c];
                if ((await page.locator('[data-testid="post-take-up"]').innerText()).trim() !== '✋ I can do this') problems.push(`${tag}: the take-up does not read "✋ I can do this"`);
                await page.locator('[data-testid="post-take-up"]').click();
                await page.locator('[data-testid="need-answer-line"]').waitFor({ timeout: 5000 });
                if (c === 'need-hours-open') {
                    await page.locator('input').first().fill('3');
                    await page.waitForTimeout(200);
                }
                const said = (await page.locator('[data-testid="need-answer-line"]').innerText()).replace(/\s+/g, ' ').trim();
                if (said !== want) problems.push(`${tag}: the sentence reads "${said}", not "${want}"`);
                const body = await page.evaluate(() => document.body.innerText);
                if (/1\.5%|Trust Wallet|Commons Pool|Offer to Fulfill/.test(body)) problems.push(`${tag}: the first screen still carries the fee, the Trust Wallet box or the old words`);
                if (!body.includes('I can do this')) problems.push(`${tag}: the confirmation is not headed "I can do this"`);
                await page.locator('[data-testid="need-answer-line"]').scrollIntoViewIfNeeded();
                await page.waitForTimeout(200);
            }
            await measure(tag);
            // Where the take-up (or the case's first action) starts and ends, from the screen's top; the photo's top.
            const at = await page.evaluate(() => {
                const take = document.querySelector('[data-testid="post-take-up"]');
                const photo = document.querySelector('[data-testid="post-photo-frame"]') || document.querySelector('[data-testid="post-tile-banner"]');
                const p = photo?.getBoundingClientRect();
                const t = take?.getBoundingClientRect();
                const terms = (document.querySelector('[data-testid="no-beans-terms"]') || document.querySelector('[data-testid="price-terms"]'))?.getBoundingClientRect();
                return {
                    top: t ? t.top : null, bottom: t ? t.bottom : null, photoTop: p ? p.top : null, photo: p ? `${Math.round(p.width)} x ${Math.round(p.height)}` : null,
                    terms: terms ? `${Math.round(terms.top)}–${Math.round(terms.bottom)}` : null,
                    share: document.querySelector('[data-testid="share-post"]')?.getBoundingClientRect().left ?? null,
                };
            });
            const dp = (n) => (n == null ? '—' : String(Math.round(n * 10) / 10));
            rows.push(`${tag}: the take-up's top at ${dp(at.top)} dp, its bottom at ${dp(at.bottom)} dp; the terms box ${at.terms ?? '—'}; the photo's top at ${dp(at.photoTop)} dp, ${at.photo}; Share's left at ${dp(at.share)}`);
            // The stop (DESIGN-detail-pages-frame-fable.md §2): fail, not print, where a member can take the listing up.
            // The note a member opened themselves may push the take-up down, never off the first screen (the event page's rule
            // for the dates a member opens, DESIGN-web-dates-stop-fable.md §2): its top on the 569dp screen.
            if (c === 'apples-more') {
                if (at.top == null || at.top > SCREEN) problems.push(`${tag}: opened, the take-up's top at ${dp(at.top)} dp, past the ${SCREEN} dp screen`);
            }
            if (c === 'apples' || c === 'apples-nophoto' || c === 'offer') {
                if (at.top == null) problems.push(`${tag}: no take-up`);
                else if (at.top > STOP) problems.push(`${tag}: the take-up's top at ${dp(at.top)} dp, past ${STOP}`);
                if (at.bottom != null && at.bottom > SCREEN) problems.push(`${tag}: the take-up's bottom at ${dp(at.bottom)} dp, past the ${SCREEN} dp screen`);
            }
            // The author has no Message beside it: Share alone starts the quiet row, at the column's 16 (it ran edge to edge).
            if (c === 'own' && (at.share == null || Math.abs(at.share - 16) > 0.5)) problems.push(`${tag}: Share's left at ${dp(at.share)}, not the column's 16`);
            if (SHOTS) {
                const name = `phone-listing-${scheme}-${c}`;
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
console.log(`Every state holds: no sideways scroll, nothing past the edge or cut, every button 48dp, text at 4.5:1 or better, the take-up on the first screen (top ≤ ${STOP}dp and bottom ≤ ${SCREEN}dp).`);
