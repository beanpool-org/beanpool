#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Your name and picture follow the community you're in (Profile S1, scratch/fable-design/DESIGN-per-community-profile-fable.md
 * §4), drawn at the floor (memory product-audience-small-screens: 320dp wide, the phone's text at 1.3×), in the light and
 * the dark scheme: the app's own header (components/GlobalHeader.tsx) with its real avatar (components/MemberAvatar.tsx),
 * hook (utils/use-own-profile.ts) and switch notice (utils/community-switch.ts), through react-native-web in headless
 * Chromium, as e2e/peek-320.mjs draws its screens.
 *
 * The header is the tabs' own (app/(tabs)/_layout.tsx), the same over Home, Talk and Settings' Edit Profile; each is
 * drawn under it with that tab's name as a stand-in body. My Profile is the real screen (app/public-profile.tsx), opened
 * for the member's own key with the phone-wide name as the door's name, its reads stood in for.
 *
 * States, each in both schemes: on community A with A's photo; after the switch to B, B's photo and B's name; B's photo
 * failing to load (the ready-made picture the key picks, never a blank disc). Each fails on: the page scrolling sideways;
 * text past the 320 edge or cut; the header avatar blank or not the community's; My Profile showing the phone-wide name.
 *
 * A stand-in for the phone, not an emulator: Android's fonts and line breaking differ. Nothing leaves the machine: the
 * page aborts every request but its own (a node's photo address fails, as a stale one does). The browser: run
 * `pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium` once.
 *
 *   node apps/native/e2e/own-profile-320.mjs [--shots <dir>]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'own-profile-320-'));

/** Two "photos" of the same member, one per community: drawn so a glance tells them apart. */
const photo = (fill, letter) => `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${fill}"/>`
    + `<text x="48" y="66" font-size="56" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`,
).toString('base64')}`;
const PHOTO_A = photo('#0f766e', 'A');
const PHOTO_B = photo('#7c3aed', 'B');

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
        const listeners = new Map();
        export const DeviceEventEmitter = {
            addListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return { remove() { listeners.get(name).delete(fn); } }; },
            emit(name, payload) { for (const fn of [...(listeners.get(name) || [])]) fn(payload); },
        };
        export default { ...RNW, Text, TextInput, DeviceEventEmitter };
    `,
    'ThemeContext': `export const useTheme = () => globalThis.__theme; export const useStyles = (make) => make(globalThis.__theme);`,
    'IdentityContext': `export const useIdentity = () => globalThis.__who;`,
    'expo-router': `
        import { useEffect } from 'react';
        export const router = { back() {}, push(to) { globalThis.__pushed = to; }, replace() {}, canGoBack: () => true };
        export const ErrorBoundary = () => null;
        export const usePathname = () => '/';
        export const useLocalSearchParams = () => globalThis.__params || {};
        export const useFocusEffect = (effect) => { useEffect(() => effect() || undefined, [effect]); };
    `,
    'react-native-safe-area-context': `
        import React from 'react';
        import { View } from 'react-native-web';
        export const SafeAreaView = ({ children, style }) => React.createElement(View, { style }, children);
        export const useSafeAreaInsets = () => ({ top: 24, bottom: 0, left: 0, right: 0 });
    `,
    '@expo/vector-icons': `
        import React from 'react';
        import { Text } from 'react-native-web';
        const glyph = { 'help-circle-outline': '?', tune: '⚙', 'account-plus-outline': '+', pencil: '✎', 'check-decagram': '✓' };
        export const MaterialCommunityIcons = ({ name, style, size, color }) => React.createElement(Text, { style: [{ fontSize: size, color: color || '#fff' }, style] }, glyph[name] || '•');
    `,
    'expo-image': `
        import React from 'react';
        import { Image as RNImage } from 'react-native-web';
        export const Image = ({ source, style, onError, accessibilityLabel }) => React.createElement(RNImage, { source, style, resizeMode: 'cover', onError, accessibilityLabel });
    `,
    'expo-constants': `export default { expoConfig: { version: '1.2.83' } };`,
    '@react-native-async-storage/async-storage': `
        const store = globalThis.__store || (globalThis.__store = new Map());
        export default { getItem: async (k) => store.get(k) ?? null, setItem: async (k, v) => { store.set(k, v); }, removeItem: async (k) => { store.delete(k); } };
    `,
    // The phone's copy of each community: the own row of the copy the anchor names, as getDb opens it.
    'db': `
        const anchor = () => (globalThis.__store && globalThis.__store.get('beanpool_anchor_url')) || null;
        export const getMemberProfile = async (pk) => {
            const row = (globalThis.__copies || {})[anchor()];
            return row ? { public_key: pk, joined_at: '2026-03-01T00:00:00.000Z', ...row } : null;
        };
        const none = async () => null;
        const empty = async () => [];
        export const getMemberRatings = async () => ({ average: 0, count: 0, asProvider: 0, asReceiver: 0, ratings: [] });
        export const getMemberPosts = empty, getRatingsGiven = empty, getFriendsLocal = empty;
        export const getBalance = none, isFriendLocal = async () => false, addFriendLocal = none, removeFriendLocal = none;
        export const createConversationApi = none, getTrustProfile = none, vouchMember = none, updateMemberProfile = none;
        export const getUnreadByConversation = async () => ({}), getMarketplaceTransactions = empty, signedGet = none;
    `,
    'NeedsYouIcons': `export const NeedsYouIcons = () => null;`,
    'pillar-sync': `export const getLastSyncTime = async () => Date.now();`,
    'crypto': `export const buildSignedHeaders = async () => ({});`,
    'blocklist': `export const blockUser = async () => {}, unblockUser = async () => {}, isUserBlocked = () => false; export const BLOCKLIST_UPDATED_EVENT = 'blocklist_updated';`,
    'ReviewModal': `export const ReviewModal = () => null;`,
    'ArchetypeQuizModal': `export const ArchetypeQuizModal = () => null;`,
    'canonical-profile': `export const getCanonicalProfile = async () => null;`,
    'ChannelChips': `export const ChannelChips = () => null;`,
    'channels': `export const fetchPublicChannels = async () => [];`,
    'use-node-profile': `export const useNodeProfile = () => ({ profile: 'local', features: { beans: true }, checkedAt: '' });`,
    'members-lookup': `export const cardNeedsFetch = () => false; export const fetchCardByKey = async () => 'fetched';`,
    'use-reader-features': `export const useShowcaseMode = () => 'live';`,
    'reads-own': `export const readsOwn = async () => false;`,
    'LocalCommunityMark': `export const LocalCommunityMark = () => null;`,
};
const STUBBED_FILES = ['ThemeContext', 'IdentityContext', 'db', 'NeedsYouIcons', 'pillar-sync', 'crypto', 'blocklist', 'ReviewModal',
    'ArchetypeQuizModal', 'canonical-profile', 'ChannelChips', 'channels', 'use-node-profile', 'members-lookup', 'use-reader-features',
    'reads-own', 'LocalCommunityMark'];
/** Import specifiers (bare, or a relative path's last part) that resolve to a stub. */
const stubFor = (spec) => {
    if (STUBS[spec] && !spec.startsWith('.')) return spec;
    if (!spec.startsWith('.')) return null;
    const base = path.basename(spec);
    return STUBBED_FILES.includes(base) ? base : null;
};

// ─── The page: each case renders the real header (and My Profile) for one state ────────────────────────────────────────
const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text, ScrollView } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { GlobalHeader } from ${JSON.stringify(path.join(NATIVE, 'components/GlobalHeader'))};
import PublicProfileScreen from ${JSON.stringify(path.join(NATIVE, 'app/public-profile'))};
import { communitySwitched } from ${JSON.stringify(path.join(NATIVE, 'utils/community-switch'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
const ME = 'a1'.repeat(32);
globalThis.__theme = { theme: scheme, colors };
globalThis.__who = { identity: { publicKey: ME, privateKey: 'b2'.repeat(32), callsign: 'PhoneWide' } };
globalThis.__params = { publicKey: ME, callsign: 'PhoneWide' };
globalThis.__store = new Map([['beanpool_anchor_url', 'https://mullum.example']]);
globalThis.__copies = {
    'https://mullum.example': { callsign: 'Marty of Mullum', avatar_url: ${JSON.stringify(PHOTO_A)}, profile_updated_at: '2026-10-28T09:00:00.000Z' },
    'https://bellingen.example': { callsign: 'Marty of Bellingen', avatar_url: q.get('broken') === '1' ? '/api/avatar/' + ME + '?size=thumb&v=2&k=stale' : ${JSON.stringify(PHOTO_B)}, profile_updated_at: '2026-10-29T09:00:00.000Z' },
};
globalThis.__switchTo = (url) => { globalThis.__store.set('beanpool_anchor_url', url); communitySwitched(); };

const tab = q.get('tab') || 'Home';
const Page = () => tab === 'My Profile'
    ? <PublicProfileScreen />
    : (
        <View style={{ flex: 1, backgroundColor: colors.surface.app }}>
            <GlobalHeader />
            <View style={{ padding: 16 }}>
                <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text.heading }}>{tab}</Text>
                <Text style={{ fontSize: 13, color: colors.text.secondary, marginTop: 4 }}>(the tab's own page, not drawn here)</Text>
            </View>
        </View>
    );
createRoot(document.getElementById('root')).render(<View style={{ height: '100vh', backgroundColor: colors.surface.app }}><Page /></View>);
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
    banner: { js: 'globalThis.process = globalThis.process || { env: {}, versions: {} };' },
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
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 360 }, deviceScaleFactor: 2 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    /** The header avatar's picture, as drawn: RNW paints an Image as a background, and keeps the source in an <img>. */
    const headerPicture = () => page.evaluate(() => {
        const btn = document.querySelector('[aria-label="Open profile"]');
        const img = btn && btn.querySelector('img');
        return img ? img.getAttribute('src') : null;
    });
    const profilePicture = () => page.evaluate(() => {
        const imgs = [...document.querySelectorAll('img')];
        return imgs.length ? imgs[imgs.length - 1].getAttribute('src') : null;
    });

    const measure = async (label, expect) => {
        states++;
        const found = await page.evaluate(({ WIDTH }) => {
            const out = [];
            if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
            const texts = [...document.querySelectorAll('div[dir], span')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = el.textContent.trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
            }
            return out;
        }, { WIDTH });
        for (const p of found) problems.push(`${label}: ${p}`);
        for (const p of await expect()) problems.push(`${label}: ${p}`);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) });
        }
        console.log(`${found.length ? '✗' : '✓'} ${label}`);
    };
    const open = async (query) => { await page.goto(`${base}/?${query}`); await page.waitForTimeout(300); };
    const switchToB = async () => { await page.evaluate(() => globalThis.__switchTo('https://bellingen.example')); await page.waitForTimeout(300); };

    const PRESET = /^data:image\/webp/;
    for (const scheme of ['light', 'dark']) {
        for (const tab of ['Home', 'Talk', 'Edit Profile']) {
            await open(`tab=${encodeURIComponent(tab)}&scheme=${scheme}`);
            await measure(`${scheme} ${tab} header on A`, async () => ((await headerPicture()) === PHOTO_A ? [] : ['the header is not A\'s photo']));
            await switchToB();
            await measure(`${scheme} ${tab} header after switch to B`, async () => ((await headerPicture()) === PHOTO_B ? [] : ['the header is not B\'s photo']));
        }
        await open(`tab=Home&scheme=${scheme}&broken=1`);
        await switchToB();
        await page.waitForTimeout(300);
        await measure(`${scheme} header B photo fails to load`, async () => (PRESET.test((await headerPicture()) || '') ? [] : [`the header is not the preset: ${(await headerPicture() || 'none').slice(0, 40)}`]));

        await open(`tab=${encodeURIComponent('My Profile')}&scheme=${scheme}`);
        await page.getByText('Marty of Mullum').first().waitFor();
        await measure(`${scheme} My Profile on A`, async () => {
            const out = [];
            if (await page.getByText('PhoneWide').count()) out.push('the phone-wide name is shown');
            if ((await profilePicture()) !== PHOTO_A) out.push('the picture is not A\'s photo');
            return out;
        });
    }
    for (const e of errors) problems.push(`page error: ${e}`);
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n${states} states at ${WIDTH}dp with ${SCALE}× text, light and dark`);
if (problems.length) {
    console.log(problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
}
console.log('Every state holds: the header and My Profile show the community\'s own photo and name; a photo that fails shows the preset.');
