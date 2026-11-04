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
 * The lattice (PG2, §2.2, §2.5): the local case holds a poll too; every Offer / Need tile is half the row less the gutter, the
 * tiles of a row are one height, each tile's text block is four rows (24 + (4 x 18 + 3 x 4) x 1.3 = 133.2 dp), and the poll is
 * a row of its own at the list's width. An event is a tile on the lattice too (P3'): held to the same width, row height and text
 * block as the Offer / Need tiles, with its date and time rows, no button inside it and its mark ("Going ✓") whole on the photo;
 * the counts are the page's in the grid. The local case's Repair Café has counts and no answer; the global case holds the
 * member's own event (no mark: the host's line is the page's) and one they are going to.
 * The when rows (#2885 review): an event's date row and time row are each whole, never cut (scrollWidth > clientWidth fails).
 * The global grid case holds an event that ends the next day (the date, then its start time) and a Byron event read in another
 * zone: the browser's clock is set to Queensland (Perth while NSW is off daylight time, so the two clocks always differ), and
 * that tile shows the reader's own time with "🕒 your time" whole at the start of its last row, never the place's bare time.
 *
 * Fonts: Chromium on a Mac draws the system font, wider than Android's Roboto (a plain "10:26–14:26" is 113.5 dp in it, in a
 * 110 dp row). Pass Android's own Roboto to measure what a phone draws, e.g. pulled from an emulator's /system/fonts:
 *   node apps/native/e2e/market-order-320.mjs --view grid --font <Roboto-Regular.ttf> --shots <dir>
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
const fontAt = process.argv.indexOf('--font');
const FONT = fontAt > 0 ? fs.readFileSync(path.resolve(process.argv[fontAt + 1])) : null;
// The reader's zone for the grid's cross-zone event (a Byron event, NSW clock): Queensland while NSW is on daylight time, else
// Perth, so the reader's clock always differs from the place's whatever the date the harness runs on.
const zoneOffset = (tz, ms) => Math.round((Date.parse(new Date(ms).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T') + 'Z') - ms) / 60000);
const CROSS_AT = Date.now() + 28 * 60 * 60 * 1000;
const READER_TZ = zoneOffset('Australia/Sydney', CROSS_AT) !== zoneOffset('Australia/Brisbane', CROSS_AT) ? 'Australia/Brisbane' : 'Australia/Perth';

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
        // Every picture is drawn in the slot the card gives it, as the real one is: the list card's 80 dp slot, stretched to the
        // card; compact's 32 dp box; the grid tile's 4:3 frame (PG2: a fixed block ran out of the frame over the title).
        MarketCardPicture: `({ size, imageStyle, tileBox }) => React.createElement(RN.View, { style: [size === 'thumb' ? (tileBox || imageStyle) : imageStyle, { backgroundColor: globalThis.__theme.colors.surface.subtle }] })`,
    },
    // In the style it is given, as the real one draws its amount (the grid's price pill is light words on the scrim).
    'components/CurrencyDisplay': { CurrencyDisplay: `({ amount, style }) => React.createElement(RN.Text, { style }, amount + ' Beans')` },
    // The poll card's box as the real one draws it (no side margin: it is the list's width; 14 under it), with its question.
    'components/PollCard': { PollCard: `({ post }) => React.createElement(RN.View, { testID: 'poll-card', style: { padding: 16, marginBottom: 14, borderWidth: 1, borderColor: globalThis.__theme.colors.border.default, borderRadius: 16, backgroundColor: globalThis.__theme.colors.surface.card } }, React.createElement(RN.Text, { style: { fontWeight: '800', color: globalThis.__theme.colors.text.heading } }, '🗳️ ' + post.title))` },
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
// An instant on NSW's wall clock, "YYYY-MM-DDTHH:MM", as a node stores an event's local clock; the cross-zone event's start.
const placeClock = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Australia/Sydney' }).slice(0, 16).replace(' ', 'T');
window.__crossStart = ahead(60 * 28);
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
        // The lattice (PG2): a poll in the grid is a row of its own; a recurring Offer with a two-line title beside a short one.
        ...(${JSON.stringify(VIEW)} === 'grid' ? [
            post('poll', 'Where should the new tool shed go?', { type: 'poll', category: 'general', created_at: ago(30), author_callsign: 'Dee' }),
            post('r', 'Seedlings every week from the nursery bench', { created_at: ago(50), author_callsign: 'Lee', repeatable: 1 }),
        ] : []),
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
            author_pubkey: 'my-own-member-key',
            event_start_at: ahead(60 * 20), event_end_at: ahead(60 * 22), event_state: 'scheduled', credits: 0 }),
        post('g6', 'Byron Bay Farmers Market — Weekly Thursday', { type: 'event', category: 'events', created_at: ago(60 * 3), lat: -28.66, lng: 153.6,
            author_callsign: 'Byron Markets', event_start_at: ahead(60 * 30), event_end_at: ahead(60 * 34), event_state: 'scheduled',
            event_place_name: 'Butler Street Reserve', myRsvp: 'going', credits: 0 }),
        // The when rows (#2885): an event that ends the next day, and a Byron event (NSW clock) read in the browser's other zone.
        ...(${JSON.stringify(VIEW)} === 'grid' ? [
            post('g7', 'Seed swap weekend', { type: 'event', category: 'events', created_at: ago(60 * 4), lat: -28.55, lng: 153.5,
                author_callsign: 'Seed Library', event_start_at: ahead(60 * 26), event_end_at: ahead(60 * 50), event_state: 'scheduled',
                event_place_name: 'Mullumbimby Hall', credits: 0 }),
            post('g8', 'Byron Bay Twilight Market', { type: 'event', category: 'events', created_at: ago(60 * 6), lat: -28.64, lng: 153.61,
                author_callsign: 'Byron Markets', event_start_at: window.__crossStart, event_end_at: ahead(60 * 32), event_state: 'scheduled',
                event_start_local: placeClock(window.__crossStart), event_end_local: placeClock(ahead(60 * 32)), event_tz: 'Australia/Sydney',
                event_place_name: 'Railway Park', credits: 0 }),
        ] : []),
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

// With --font, every line is drawn in that font (Android's Roboto: its weight axis gives 500, 700 and 800 as a phone draws them).
const fontCss = FONT ? `@font-face{font-family:'PhoneFont';src:url(/font.ttf);font-weight:100 900}#root,#root *{font-family:'PhoneFont',sans-serif!important}` : '';
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}"><style>html,body,#root{margin:0;padding:0;width:${WIDTH}px;overflow-x:hidden}${fontCss}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/bundle.js')) { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(outfile)); return; }
    if (FONT && req.url?.startsWith('/font.ttf')) { res.setHeader('content-type', 'font/ttf'); res.end(FONT); return; }
    res.setHeader('content-type', 'text/html'); res.end(html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch();
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL', msg); };
for (const scheme of ['light', 'dark']) {
    for (const which of VIEW === 'grid' ? ['local', 'global'] : ['local', 'global', 'newsince', 'newsince-day']) {
        const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2, ...(VIEW === 'grid' ? { timezoneId: READER_TZ } : {}) });
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
        if (FONT) await page.evaluate(() => document.fonts.ready);
        console.log(`${which} / ${scheme}${VIEW === 'grid' ? ` / grid / reader in ${READER_TZ}` : ''}`);
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
                        // The status line (the mark, the host's line, the counts) is never cut at 320dp and 1.3x.
                        cut: ['event-mark', 'event-counts'].filter(id => { const e = card.querySelector(`[data-testid="${id}"]`); return e && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1); }),
                        buttons: card.querySelectorAll('[role="button"]').length, text: card.innerText.split('\n').filter(Boolean) };
                }),
                // The grid's tiles (an Offer / Need / Pulse tile is its own button, market-card-<id>; an event's, event-card-<id>,
                // since P3'), each with its text block; the poll.
                tiles: Array.from(document.querySelectorAll('[data-testid^="market-card-"], [data-testid^="event-card-"]')).map(card => {
                    const r = card.getBoundingClientRect();
                    const block = card.querySelector('[data-testid="grid-text-block"]');
                    const b = block ? block.getBoundingClientRect() : null;
                    const inner = block ? Array.from(block.children).map(x => x.getBoundingClientRect()) : [];
                    return { id: card.getAttribute('data-testid'), left: r.left, top: r.top, width: r.width, height: r.height,
                        block: b ? b.height : null, spills: b ? inner.filter(x => x.bottom > b.bottom - 12 + 0.5).length : -1,
                        title: (card.innerText || '').split('\n').filter(Boolean).slice(-3).join(' / ').slice(0, 40) };
                }),
                polls: Array.from(document.querySelectorAll('[data-testid="poll-card"]')).map(p => { const r = p.getBoundingClientRect(); return { left: r.left, width: r.width, top: r.top, bottom: r.bottom }; }),
                // An event tile (P3'): its rows, any button inside it, its mark whole, and no counts.
                eventTiles: Array.from(document.querySelectorAll('[data-testid^="event-card-"]')).map(e => {
                    const block = e.querySelector('[data-testid="grid-text-block"]');
                    const mark = e.querySelector('[data-testid="event-mark"]');
                    // The when rows (the date, the time) and the "your time" label: each whole, never cut.
                    const whole = (el) => !el || el.scrollWidth <= el.clientWidth + 1;
                    const whenRows = ['event-when', 'event-time'].map(id => e.querySelector(`[data-testid="${id}"]`));
                    const yours = e.querySelector('[data-testid="event-your-time"]');
                    const lastRow = block ? block.children[3] : null;
                    // The cross-zone event's start on this browser's clock, "15:00" (the app's clock drops a leading zero).
                    const own = e.getAttribute('data-testid') === 'event-card-g8' ? new Date(window.__crossStart) : null;
                    return { id: e.getAttribute('data-testid'), rows: block ? Array.from(block.children).map(r => r.innerText) : null,
                        cutRows: whenRows.map((el, i) => (whole(el) ? null : `row ${i + 1} "${el.innerText}" (${el.scrollWidth} in ${el.clientWidth})`)).filter(Boolean),
                        whenWidths: whenRows.map(el => (el ? `${el.scrollWidth}/${el.clientWidth}` : '-')).join(' '),
                        yours: yours ? yours.innerText : null,
                        // Cut by its own "…" (its text wider than its box), or drawn past the row's end. An inline label has no box
                        // of its own (clientWidth 0), and inside a longer truncating line the line's "…" can fall in it: that fails too.
                        yoursCut: yours && lastRow ? yours.clientWidth === 0 || !whole(yours) || yours.getBoundingClientRect().right > lastRow.getBoundingClientRect().right + 0.5 : false,
                        ownStart: own ? `${own.getHours()}:${String(own.getMinutes()).padStart(2, '0')}` : null,
                        buttons: e.querySelectorAll('[role="button"]').length, mark: mark ? mark.innerText : null,
                        markCut: mark ? Array.from(mark.querySelectorAll('*')).some(x => x.scrollWidth > x.clientWidth + 1) : false,
                        counts: !!e.querySelector('[data-testid="event-counts"]') };
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
                if (e.cut.length) fail(`${e.id}: its ${e.cut.join(', ')} line is cut`);
                if (e.text.some(l => /^Going$|^Interested$/.test(l))) fail(`${e.id}: a Going / Interested button's words are on the card`);
                if (e.text.some(l => /^👥 0 going · 0 interested$/.test(l))) fail(`${e.id}: zero counts drawn`);
            }
            console.log('  events:', result.eventCards.map(e => `${e.id} ${Math.round(e.height)} dp [${e.text.join(' | ')}]`).join(' || '));
        }
        if (VIEW === 'grid') {
            // The lattice (PG2): every Offer / Need tile half the row less the 16 dp gutter; the tiles of a row one height; each
            // text block four rows, the same number; nothing in a block below its padding; a poll the list's width.
            const BLOCK = 24 + (4 * 18 + 3 * 4) * SCALE;
            const HALF = (WIDTH - 32 - 16) / 2;
            if (!result.tiles.length) fail('no grid tiles drawn');
            for (const t of result.tiles) {
                if (Math.abs(t.width - HALF) > 0.5) fail(`${t.id} is ${t.width} wide, not half the row (${HALF})`);
                if (t.block == null || Math.abs(t.block - BLOCK) > 0.5) fail(`${t.id}: text block ${t.block}, not ${BLOCK.toFixed(1)}`);
                if (t.spills) fail(`${t.id}: ${t.spills} row(s) of its text block run past it`);
            }
            const rows = [];
            for (const t of [...result.tiles].sort((a, b) => a.top - b.top)) {
                const row = rows.find(r => Math.abs(r.top - t.top) < 1);
                if (row) row.tiles.push(t); else rows.push({ top: t.top, tiles: [t] });
            }
            for (const r of rows) {
                const hs = r.tiles.map(t => t.height);
                if (Math.max(...hs) - Math.min(...hs) > 0.5) fail(`a row's tiles differ in height: ${r.tiles.map(t => `${t.id} ${t.height}`).join(', ')}`);
            }
            const lone = rows.filter(r => r.tiles.length === 1);
            console.log('  tiles:', result.tiles.map(t => `${t.id.replace('market-card-', '')} ${Math.round(t.height * 10) / 10}`).join(', '), '| rows', rows.length);
            if (lone.length > 1) fail(`${lone.length} rows hold a lone tile; only the last may`);
            // The events (P3'): tiles on the lattice (held above with the rest), four rows each, no button inside, the mark whole.
            if ((which === 'local' || which === 'global') && !result.eventTiles.length) fail('no event tile drawn');
            for (const e of result.eventTiles) {
                if (!e.rows || e.rows.length !== 4) fail(`${e.id}: its text block holds ${e.rows && e.rows.length} rows, not 4`);
                for (const cut of e.cutRows) fail(`${e.id}: its when ${cut} is cut`);
                if (e.yoursCut) fail(`${e.id}: its "${e.yours}" label is cut`);
                if (e.buttons) fail(`${e.id}: ${e.buttons} button(s) inside the tile`);
                if (e.markCut) fail(`${e.id}: its mark "${e.mark}" is cut`);
                if (e.counts) fail(`${e.id}: the counts are drawn on the tile`);
            }
            console.log('  events:', result.eventTiles.map(e => `${e.id} [${(e.rows || []).join(' | ')}]${e.mark ? ` mark ${e.mark}` : ''} (when rows ${e.whenWidths})`).join(' || '));
            if (which === 'global' && !result.eventTiles.some(e => e.mark === 'Going ✓')) fail('the event the member is going to shows no "Going ✓" on its tile');
            if (which === 'global') {
                // The two-day event: the date row holds no time, the time row no date (its start; the end is on the page).
                const two = result.eventTiles.find(e => e.id === 'event-card-g7');
                if (!two) fail('the event that ends the next day is not drawn');
                else if (/\d:\d\d/.test(two.rows[0]) || /[A-Z]/.test(two.rows[1])) fail(`the two-day event's rows mix the date and the time: ${two.rows.slice(0, 2).join(' | ')}`);
                // The Byron event read in another zone: the reader's own start, and "🕒 your time" opening the last row.
                const cross = result.eventTiles.find(e => e.id === 'event-card-g8');
                if (!cross) fail('the event read across the zone line is not drawn');
                else {
                    if (!cross.rows[1].startsWith(cross.ownStart)) fail(`the cross-zone event's time row "${cross.rows[1]}" is not the reader's own start ${cross.ownStart}`);
                    if (cross.yours !== '🕒 your time' || !cross.rows[3].startsWith('🕒 your time')) fail(`the cross-zone event's last row "${cross.rows[3]}" does not open with "🕒 your time"`);
                }
                if (result.eventTiles.some(e => e.id !== 'event-card-g8' && e.yours)) fail('a tile in the reader\'s own clock says "your time"');
            }
            if (which === 'local') {
                if (result.polls.length !== 1) fail(`expected one poll, found ${result.polls.length}`);
                for (const p of result.polls) {
                    if (Math.abs(p.width - (WIDTH - 32)) > 0.5 || Math.abs(p.left - 16) > 0.5) fail(`the poll is ${p.width} wide at ${p.left}, not the list's ${WIDTH - 32} at 16`);
                    if (result.tiles.some(t => t.top < p.bottom && t.top + t.height > p.top)) fail('a tile sits beside the poll');
                }
                console.log('  poll:', result.polls.map(p => `${p.width} wide at ${p.left}`).join(', '));
            }
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
