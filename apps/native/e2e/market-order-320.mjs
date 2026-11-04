#!/usr/bin/env node
/* global process, console, document, getComputedStyle, window */
/**
 * The Market's order (Market order S1, DESIGN-market-order-fable.md) at the floor: 320dp wide, text at 1.3×, light and dark.
 * The app's own Market screen (app/(tabs)/market.tsx) through react-native-web in headless Chromium, with the device modules
 * (router, storage, the SQLite copy, sync, the pickers) stubbed at the boundary and the cards real. A stand-in for a phone:
 * Android's fonts and line breaks differ.
 *
 * Cases:
 *   local    a local community: Pinned block, then TODAY with an event that came back (posted weeks ago, starting within a day),
 *            then YESTERDAY. No Upcoming events heading.
 *   newsince / newsince-day   New since you last looked (S4): the line above the first post at or before the stamp, one line, whole, under
 *            Today or above the Yesterday heading; and not drawn in the other cases.
 *   global   the worldwide community with an area: the line "Newest within 250 km of your area." (two lines at most, none cut),
 *            each listing's and event's distance, nothing beyond 250 km.
 *
 * Checks (each case, each scheme): no sideways scroll; nothing drawn past the 320dp edge; the line is whole text on one line.
 * Screenshots go to --shots <dir> (not committed).
 *
 *   node apps/native/e2e/market-order-320.mjs --shots <dir>
 *   node apps/native/e2e/market-order-320.mjs --view grid --shots <dir>
 *
 * --view grid (market grid PG1, DESIGN-market-grid-sizes-fable.md §2.1) taps the real "Grid view" button, then runs the cases
 * `local` and `global` (the New since line is a list-view line). In the grid there is no Pinned heading or block: the pin is the
 * grid's first cell with its 📌 PINNED pill, the first stream card is beside it in the same row, and no card is drawn twice.
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
const HEIGHT = 1300; // tall, so one shot holds the whole list: the real phone scrolls it
const viewAt = process.argv.indexOf('--view');
const VIEW = viewAt > 0 ? process.argv[viewAt + 1] : 'list';
if (VIEW !== 'list' && VIEW !== 'grid') { console.log('--view is list or grid'); process.exit(2); }
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'market-order-320-'));

// ─── What is stubbed: files and packages that reach the device, the network, the router or the account ───────────────────
const STUB_FILES = [
    'app/IdentityContext', 'app/ThemeContext', 'utils/db', 'utils/node-post', 'utils/blocklist', 'utils/home-store', 'utils/tour-store',
    'utils/look-door', 'utils/use-looking-around', 'utils/use-global-guest-visit', 'utils/use-reader-features', 'utils/use-node-profile',
    'utils/members-only-listings', 'utils/market-fill', 'services/pillar-sync',
    'components/RadiusPickerModal', 'components/TrustPickerSheet', 'components/MyDealsSheet', 'components/ActivityWaterfall',
    'components/NewPollModal', 'components/NewEventModal', 'components/NewPostTypeSheet', 'components/OwnerWordsPrompt',
    'components/ExampleListings', 'components/MarketCircleLine', 'components/NoAreaLine', 'components/LookAroundCard',
    'components/SaveSearchButton', 'components/FilterChipRow', 'components/FilterChipPicker', 'components/QuickReturn',
    'components/PageTitle', 'components/PollCard', 'components/PostAuthorTrust', 'components/MarketCardPicture', 'components/CategoryTile',
    'components/ListingCopyLine', 'components/CurrencyDisplay', 'components/keyboardAwareList',
];
const STUB_PACKAGES = ['expo-secure-store', 'expo-router', 'expo-location', 'expo-image', '@expo/vector-icons', '@react-native-async-storage/async-storage', 'react-native-safe-area-context'];

// ─── The names each stub must export: read off the screen's own imports, so a new import never breaks the harness ──────────
const SOURCE_DIRS = ['app', 'components', 'utils', 'services', 'constants'].map(d => path.join(NATIVE, d));
const sources = [];
const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (/__tests__|node_modules/.test(full)) continue;
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) sources.push(full);
    }
};
SOURCE_DIRS.forEach(walk);
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
    'utils/db': {
        getPosts: `async () => globalThis.__posts`,
        getBalance: `async () => ({ isBlockedFromTrading: false })`,
        isRouteMissing: `() => false`,
        getNearbyKeptPostIds: `async () => new Set()`,
    },
    'utils/use-node-profile': { useNodeProfile: `() => globalThis.__profile` },
    'utils/use-reader-features': { useReaderFeatures: `() => globalThis.__profile.features` },
    'utils/use-global-guest-visit': { useGlobalGuestVisit: `() => false` },
    'utils/use-looking-around': { useLookingAround: `() => false` },
    'utils/members-only-listings': { refusalHere: `async () => null` },
    'utils/blocklist': { getBlockedUsers: `async () => []`, BLOCKLIST_UPDATED_EVENT: `'blocklist_updated'` },
    'utils/home-store': { readPhoneInterests: `async () => []` },
    'utils/node-post': { anchorUrl: `async () => null` },
    'services/pillar-sync': { isPillarSyncActive: `() => false`, syncLandedOnThisCopy: `async () => true`, PILLAR_SYNC_ENDED: `'pillar_sync_ended'` },
    'utils/market-fill': {
        ELSEWHERE_HEADING: `'Newest from elsewhere'`, fillWanted: `() => false`, readElsewhere: `async () => null`,
        marketServerFilter: `() => ''`, normalizeServerPosts: `(x) => x`,
    },
    'components/TrustPickerSheet': { TRUST_FILTERS: `[]` },
    'components/MyDealsSheet': { usePendingDealsCount: `() => 0` },
    'components/PostAuthorTrust': {
        PostAuthorTrust: `({ callsign }) => React.createElement(RN.Text, { style: { fontSize: 13, color: globalThis.__theme.colors.text.secondary, fontWeight: '600' } }, 'by ' + callsign)`,
        isElder: `() => false`,
    },
    'components/MarketCardPicture': {
        MARKET_GRID_CROP: `1`,
        // A thumbnail is drawn in the slot the card gives it (the list card's 80 dp slot, stretched to the card; compact's 32 dp
        // box), as the real picture is; the grid's stays a 120 dp block.
        MarketCardPicture: `({ size, imageStyle, tileBox }) => React.createElement(RN.View, { style: [size === 'thumb' ? (tileBox || imageStyle) : { width: '100%', height: 120, borderRadius: 8 }, { backgroundColor: globalThis.__theme.colors.surface.subtle }] })`,
    },
    'components/CurrencyDisplay': { CurrencyDisplay: `({ amount }) => React.createElement(RN.Text, null, amount + ' Beans')` },
    'components/PollCard': { PollCard: `({ post }) => React.createElement(RN.View, { style: { padding: 12, marginHorizontal: 16, marginBottom: 12, borderWidth: 1, borderColor: globalThis.__theme.colors.border.default, borderRadius: 12 } }, React.createElement(RN.Text, { style: { fontWeight: '800', color: globalThis.__theme.colors.text.heading } }, '🗳️ ' + post.title))` },
    'components/PageTitle': { PageTitle: `({ title }) => React.createElement(RN.Text, { style: { fontSize: 24, fontWeight: '800', paddingHorizontal: 16, paddingTop: 8, color: globalThis.__theme.colors.text.heading } }, title)`, useTabRetapScrollTop: `() => {}` },
    'components/QuickReturn': {
        useQuickReturn: `() => ({ show() {}, hidden: false, titleHeight: 0, listInset: 0, listProps: {} })`,
        QuickReturnBlock: `({ title, children }) => React.createElement(RN.View, null, title, children)`,
    },
    'components/FilterChipRow': { FilterChipRow: `() => null`, FilterChipBar: `() => null` },
    'components/FilterChipPicker': { FilterChipButton: `() => null`, FilterChipPanel: `() => null` },
    'components/CategoryTile': { CategoryTile: `() => null` },
    // The keyboard library's scroll view needs the phone: here a plain one (the list's own scroll view).
    'components/keyboardAwareList': { keyboardAwareList: `(props) => React.createElement(RN.ScrollView, props)` },
    'components/ListingCopyLine': { ListingCopyLine: `() => null` },
    'expo-router': {
        useFocusEffect: `(cb) => React.useEffect(() => cb(), [cb])`, router: `{ push() {}, navigate() {}, setParams() {}, back() {} }`,
        useLocalSearchParams: `() => ({})`, useNavigation: `() => ({ addListener: () => () => {}, isFocused: () => true })`,
    },
    'expo-location': { getForegroundPermissionsAsync: `async () => ({ status: 'denied' })`, getLastKnownPositionAsync: `async () => null` },
    'expo-secure-store': { getItemAsync: `async () => null`, setItemAsync: `async () => {}` },
    '@expo/vector-icons': { MaterialCommunityIcons: `() => null` },
    'react-native-safe-area-context': { useSafeAreaInsets: `() => ({ top: 24, bottom: 24, left: 0, right: 0 })` },
};

const stubSource = (key, rel) => {
    if (key === '@react-native-async-storage/async-storage') {
        return `const m = new Map(); const s = { getItem: async (k) => globalThis.__storage[k] ?? null, setItem: async (k, v) => { globalThis.__storage[k] = v; }, removeItem: async () => {} }; export default s;`;
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
    export const LayoutAnimation = { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } };
    export const RefreshControl = ({ children }) => children;
    export const useWindowDimensions = () => ({ width: ${WIDTH}, height: ${HEIGHT}, scale: 1.5, fontScale: ${SCALE} });
    export default { ...RNW, Text, TextInput, Platform, Alert, LayoutAnimation, RefreshControl, useWindowDimensions };
`;

const plugin = {
    name: 'market-order-stubs',
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

// ─── The page ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import MarketScreen from ${JSON.stringify(path.join(NATIVE, 'app/(tabs)/market'))};
import { nearbyAreaKeyOf } from ${JSON.stringify(path.join(NATIVE, 'utils/nearby-area'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
globalThis.__theme = { theme: scheme, colors: scheme === 'dark' ? darkColors : lightColors };
globalThis.__identity = { publicKey: 'my-own-member-key', callsign: 'Kim' };

const MIN = 60 * 1000;
const ago = (min) => new Date(Date.now() - min * MIN).toISOString();
const ahead = (min) => new Date(Date.now() + min * MIN).toISOString();
const post = (id, title, extra = {}) => ({
    id, title, type: 'offer', status: 'active', category: 'food', author_pubkey: 'k-' + id, author_callsign: 'Neighbour', author_energy_cycled: 0,
    credits: 5, price_type: 'fixed', photos: '[]', lat: -28.6, lng: 153.5, description: '', created_at: ago(5), ...extra,
});
const c = q.get('case');
globalThis.__storage = {};
if (c === 'local') {
    globalThis.__profile = { profile: 'local', features: { beans: true } };
    globalThis.__posts = [
        post('pin', 'Bike pump to share', { pinned_until: ahead(60 * 48), pinned_at: ago(60), created_at: ago(60 * 24 * 9), author_callsign: 'Jo' }),
        post('a', 'Lemons, a bucket', { created_at: ago(8), author_callsign: 'Sam' }),
        post('b', 'Lift to Lismore Thursday', { type: 'need', category: 'transport', created_at: ago(20), author_callsign: 'Mo' }),
        post('ev', 'Repair Café', { type: 'event', category: 'events', created_at: ago(60 * 24 * 35), author_callsign: 'Civic Hall',
            event_start_at: ahead(60 * 23), event_end_at: ahead(60 * 25), event_state: 'scheduled', event_going_count: 4, event_interested_count: 2 }),
        // The style box P2: an event pinned, with Byron's longest title, in the list's Pinned block (the grid's one-pin case keeps one).
        ...(${JSON.stringify(VIEW)} === 'list' ? [post('evpin', 'Byron Bay Twilight Market - Every Saturday', { type: 'event', category: 'events',
            created_at: ago(60 * 24 * 20), pinned_until: ahead(60 * 48), pinned_at: ago(30), author_callsign: 'Byron Markets',
            event_start_at: ahead(60 * 50), event_end_at: ahead(60 * 55), event_state: 'scheduled', event_place_name: 'Railway Park, Jonson Street',
            myRsvp: 'going', event_going_count: 12, event_interested_count: 5 })] : []),
        post('c', 'Firewood, split', { created_at: ago(40), author_callsign: 'Ana' }),
        post('y', 'Someone to mind two goats', { type: 'need', category: 'pets', created_at: ago(60 * 26), author_callsign: 'Mo' }),
    ];
} else if (c === 'newsince' || c === 'newsince-day') {
    // New since you last looked (Market order S4): the stamp is a post's own listed time. 'newsince' stops inside Today; 'newsince-day'
    // stops at the first post of Yesterday, so the line sits above that heading.
    globalThis.__profile = { profile: 'local', features: { beans: true } };
    const rows = [
        post('a', 'Lemons, a bucket', { created_at: ago(8), author_callsign: 'Sam' }),
        post('b', 'Lift to Lismore Thursday', { type: 'need', category: 'transport', created_at: ago(20), author_callsign: 'Mo' }),
        post('c', 'Firewood, split', { created_at: ago(40), author_callsign: 'Ana' }),
        post('y', 'Someone to mind two goats', { type: 'need', category: 'pets', created_at: ago(60 * 26), author_callsign: 'Mo' }),
    ];
    globalThis.__posts = rows;
    globalThis.__storage = { bp_market_seen_listed: String(Date.parse(rows[c === 'newsince' ? 2 : 3].created_at)) };
} else {
    globalThis.__profile = { profile: 'global', features: { beans: false, distanceSearch: true, nearbyListings: { radiusKm: 250, max: 500 } } };
    const URL = 'https://global.example';
    globalThis.__storage = {
        beanpool_anchor_url: URL,
        beanpool_node_profiles: JSON.stringify({ [URL]: { ...globalThis.__profile, checkedAt: new Date().toISOString() } }),
        // The member's area (Byron Bay), as the phone holds it after the node said so.
        [nearbyAreaKeyOf(URL)]: JSON.stringify({ key: 'my-own-member-key', area: { lat: -28.65, lng: 153.55 }, checkedAt: Date.now(), whole: false }),
    };
    globalThis.__posts = [
        post('g1', 'Sourdough starter', { created_at: ago(10), lat: -28.58, lng: 153.5, author_callsign: 'Lee', credits: 0 }),
        post('g2', 'Mutual credit 101, online', { type: 'event', category: 'events', created_at: ago(60 * 24 * 12), lat: null, lng: null, author_callsign: 'Ana',
            event_start_at: ahead(60 * 20), event_end_at: ahead(60 * 22), event_state: 'scheduled', credits: 0 }),
        post('g6', 'Byron Bay Farmers Market — Weekly Thursday', { type: 'event', category: 'events', created_at: ago(60 * 3), lat: -28.66, lng: 153.6,
            author_callsign: 'Byron Markets', event_start_at: ahead(60 * 30), event_end_at: ahead(60 * 34), event_state: 'scheduled',
            event_place_name: 'Butler Street Reserve', myRsvp: 'going', credits: 0 }),
        post('g3', 'Proofread a grant', { type: 'need', category: 'education', created_at: ago(60 * 5), lat: -27.47, lng: 153.03, author_callsign: 'Kai', credits: 0 }),
        post('g4', 'Surplus pumpkins', { created_at: ago(60 * 26), lat: -28.2, lng: 153.4, author_callsign: 'Pat', credits: 0 }),
        post('g5', 'Melbourne bike (beyond 250 km)', { created_at: ago(30), lat: -37.81, lng: 144.96, author_callsign: 'Far', credits: 0 }),
    ];
}
createRoot(document.getElementById('root')).render(
    <View style={{ width: ${WIDTH}, height: ${HEIGHT}, backgroundColor: globalThis.__theme.colors.surface.page, overflow: 'hidden' }}>
        <MarketScreen />
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

const browser = await chromium.launch();
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL', msg); };
for (const scheme of ['light', 'dark']) {
    for (const which of VIEW === 'grid' ? ['local', 'global'] : ['local', 'global', 'newsince', 'newsince-day']) {
        const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        page.on('console', m => { if (process.env.DEBUG_TEXT) console.log('  [console.' + m.type() + ']', m.text().slice(0, 300)); if (m.type() === 'error') errors.push(m.text()); });
        await page.goto(`http://127.0.0.1:${port}/?case=${which}&scheme=${scheme}`);
        await page.waitForTimeout(1500);
        if (VIEW === 'grid') {
            // The Market opens in list view; its view button goes list → grid.
            await page.click('[aria-label="Grid view"]');
            await page.waitForTimeout(700);
        }
        console.log(`${which} / ${scheme}${VIEW === 'grid' ? ' / grid' : ''}`);
        if (errors.length) fail(`page errors: ${errors.join(' | ').slice(0, 300)}`);
        const result = await page.evaluate(([W, TITLES]) => {
            const text = document.body.innerText;
            let past = 0;
            const pastIn = new Set();   // which card each such element is in, to say whose fault it is
            for (const el of Array.from(document.querySelectorAll('#root *'))) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0 && r.right > W + 1 && getComputedStyle(el).position !== 'fixed') {
                    past++;
                    const card = el.closest('[role="button"]');
                    pastIn.add(((card || el).innerText || '').split('\n').filter(Boolean).slice(0, 2).join(' / ').slice(0, 48));
                }
            }
            const line = Array.from(document.querySelectorAll('[data-testid="market-newest-within"]'))[0];
            const since = Array.from(document.querySelectorAll('[data-testid="new-since-line"]'));
            return {
                sinceCount: since.length, sinceText: since[0] ? since[0].textContent : null,
                sinceCut: since[0] ? Array.from(since[0].querySelectorAll('*')).some(e => e.scrollHeight > e.clientHeight + 1 && e.clientHeight > 0) : false,
                sinceHeight: since[0] ? since[0].getBoundingClientRect().height : null,
                text, past, pastIn: Array.from(pastIn), sideways: document.documentElement.scrollWidth > W,
                lineText: line ? line.textContent : null, lineHeight: line ? line.getBoundingClientRect().height : null,
                lineScrollH: line ? line.scrollHeight : null, lineClientH: line ? line.clientHeight : null,
                distances: Array.from(document.querySelectorAll('[data-testid="card-distance"]')).map(e => e.textContent),
                pinnedHeaders: document.querySelectorAll('[data-testid="pinned-section-header"]').length,
                pinnedBlocks: document.querySelectorAll('[data-testid="market-pinned-block"]').length,
                pinnedChips: document.querySelectorAll('[data-testid="pinned-chip"]').length,
                eventCards: Array.from(document.querySelectorAll('[data-testid^="event-card-"]')).map(card => {
                    const r = card.getBoundingClientRect();
                    const slot = card.firstElementChild.getBoundingClientRect();
                    const when = card.querySelector('[data-testid="event-when"]');
                    return { id: card.getAttribute('data-testid'), left: r.left, right: r.right, height: r.height, slotLeft: slot.left, slotWidth: slot.width,
                        slotHeight: slot.height, chipInWhen: when ? when.querySelectorAll('[data-testid]').length : -1,
                        buttons: card.querySelectorAll('[role="button"]').length, text: card.innerText.split('\n').filter(Boolean) };
                }),
                // Each title's card (its nearest button) and where the member sees it: for the grid's first-cells check.
                cards: TITLES.map(title => {
                    const leaves = Array.from(document.querySelectorAll('#root *')).filter(e => e.children.length === 0 && (e.textContent || '').includes(title));
                    const card = leaves[0] ? (leaves[0].closest('[role="button"]') || leaves[0]) : null;
                    const r = card ? card.getBoundingClientRect() : null;
                    return { title, drawn: leaves.length, left: r ? r.left : null, top: r ? r.top : null, width: r ? r.width : null,
                        pill: card ? card.querySelectorAll('[data-testid="pinned-chip"]').length : 0 };
                }),
            };
        }, [WIDTH, ['Bike pump to share', 'Lemons, a bucket', 'Lift to Lismore Thursday', 'Repair Café', 'Firewood, split', 'Someone to mind two goats']]);
        if (process.env.DEBUG_TEXT) console.log(JSON.stringify(result.text.slice(0, 600)), await page.evaluate(() => Array.from(document.querySelectorAll('#root *')).filter(e => e.scrollHeight > 0 && getComputedStyle(e).overflowY !== 'visible').map(e => e.tagName + ':' + e.clientHeight + '/' + e.scrollHeight + ':' + e.children.length).join(' ')));
        if (result.sideways) fail('sideways scroll');
        if (VIEW === 'list') {
            // The local and global cases hold two events each; the New since cases none.
            if ((which === 'local' || which === 'global') && result.eventCards.length !== 2) fail(`${result.eventCards.length} event card(s) drawn, not 2`);
            for (const e of result.eventCards) {
                if (Math.abs(e.slotLeft - (e.left + 1)) > 0.5 || Math.abs(e.slotWidth - 80) > 0.5) fail(`${e.id}: the picture is at ${e.slotLeft} x ${e.slotWidth}, not flush (${e.left + 1}) and 80 wide`);
                if (Math.abs(e.slotHeight - (e.height - 2)) > 0.5) fail(`${e.id}: the picture is ${e.slotHeight} tall, not the card's ${e.height - 2}`);
                if (e.chipInWhen !== 0) fail(`${e.id}: the when line holds ${e.chipInWhen} chip(s)`);
                if (e.buttons) fail(`${e.id}: ${e.buttons} button(s) inside the card`);
                if (e.text.some(l => /^Going$|^Interested$/.test(l))) fail(`${e.id}: a Going / Interested button's words are on the card`);
                if (e.text.some(l => /^👥 0 going · 0 interested$/.test(l))) fail(`${e.id}: zero counts drawn`);
            }
            console.log('  events:', result.eventCards.map(e => `${e.id} ${Math.round(e.height)} dp [${e.text.join(' | ')}]`).join(' || '));
        }
        if (result.past) fail(`${result.past} element(s) drawn past the ${WIDTH}dp edge, in: ${result.pastIn.map(s => `"${s}"`).join(', ')}`);
        for (const gone of ['UPCOMING EVENTS', 'NEAREST FIRST']) if (result.text.includes(gone)) fail(`heading still drawn: ${gone}`);
        if (which !== 'newsince' && which !== 'newsince-day' && result.sinceCount) fail(`the New since line is drawn where there is no stamp: ${result.sinceCount}`);
        if (which === 'newsince' || which === 'newsince-day') {
            const t = result.text;
            if (result.sinceCount !== 1 || result.sinceText !== 'NEW SINCE YOU LAST LOOKED') fail(`the line: ${result.sinceCount} x ${result.sinceText}`);
            if (result.sinceCut) fail('the line is cut at 320dp and 1.3x');
            const order = (which === 'newsince'
                ? ['TODAY', 'Lemons', 'Lift to Lismore', 'NEW SINCE YOU LAST LOOKED', 'Firewood', 'YESTERDAY', 'Someone to mind']
                : ['TODAY', 'Lemons', 'Firewood', 'NEW SINCE YOU LAST LOOKED', 'YESTERDAY', 'Someone to mind']).map(x => t.indexOf(x));
            if (order.some(i => i < 0) || order.some((v, i) => i && v < order[i - 1])) fail(`order wrong: ${order}`);
            console.log('  line height', result.sinceHeight);
        } else if (which === 'local' && VIEW === 'grid') {
            // The pin is the grid's first cell, with its pill on the photo; the stream carries on in the same row; nothing twice.
            if (result.pinnedHeaders || result.pinnedBlocks) fail(`the grid draws a Pinned heading/block: ${result.pinnedHeaders} heading(s), ${result.pinnedBlocks} block(s)`);
            if (result.pinnedChips !== 1) fail(`expected one 📌 PINNED pill (one pin), found ${result.pinnedChips}`);
            for (const c of result.cards) if (c.drawn !== 1) fail(`"${c.title}" is drawn ${c.drawn} times`);
            const placed = result.cards.filter(c => c.top != null).sort((a, b) => a.top - b.top || a.left - b.left);
            const pin = result.cards.find(c => c.title === 'Bike pump to share');
            if (placed[0] !== pin) fail(`the first cell is "${placed[0] && placed[0].title}", not the pin`);
            if (!pin.pill) fail('the pin has no 📌 PINNED pill on its card');
            if (pin.left !== 16) fail(`the pin starts at ${pin.left}, not the list's left edge (16)`);
            const beside = placed.filter(c => c !== pin && Math.abs(c.top - pin.top) < 1);
            if (beside.length !== 1) fail(`the pin's row holds ${beside.length + 1} card(s), not two: a cell is left empty`);
            else if (!(beside[0].left > pin.left) || Math.abs(beside[0].width - pin.width) > 1) fail('the card beside the pin is not its twin to the right');
            if (result.lineText) fail('local community drew the Newest within line');
            console.log('  cells:', placed.map(c => `${c.title} @${Math.round(c.left)},${Math.round(c.top)}`).join(' | '));
        } else if (which === 'global' && VIEW === 'grid') {
            if (result.pinnedHeaders || result.pinnedBlocks || result.pinnedChips) fail('the global grid has no pins, but draws a Pinned heading, block or pill');
            if (result.lineText !== 'Newest within 250 km of your area.') fail(`global line: ${result.lineText}`);
            if (result.text.includes('Melbourne bike')) fail('a listing beyond 250 km was drawn');
            if (!result.distances.length) fail('no distances on the cards');
        } else if (which === 'local') {
            const t = result.text;
            const order = ['PINNED', 'TODAY', 'Repair Café', 'YESTERDAY'].map(s => t.indexOf(s));
            if (order.some(i => i < 0) || order.some((v, i) => i && v < order[i - 1])) fail(`local order wrong: ${order}`);
            if (result.lineText) fail('local community drew the Newest within line');
        } else {
            if (result.lineText !== 'Newest within 250 km of your area.') fail(`global line: ${result.lineText}`);
            if (result.text.includes('Melbourne bike')) fail('a listing beyond 250 km was drawn');
            if (!result.distances.length) fail('no distances on the cards');
            console.log('  line:', result.lineText, '| height', result.lineHeight, '| scrollH/clientH', result.lineScrollH, result.lineClientH);
            if (result.lineScrollH > result.lineClientH + 1) fail('the line is cut: its words do not fit at 320dp and 1.3x');
            console.log('  distances:', result.distances.join(', '));
        }
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `market-order-${which}${VIEW === 'grid' ? '-grid' : ''}-${scheme}.png`) });
        await page.close();
    }
}
await browser.close();
server.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
