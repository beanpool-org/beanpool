#!/usr/bin/env node
/* global process, console, document */
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
const SHOTS_DIR = process.env.VOUCH_SHOTS_DIR || path.join(NATIVE, 'e2e', 'screenshots', 'vouch-v3');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-native-320-'));

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
        export const useNavigation = () => ({ addListener: () => () => {}, isFocused: () => true });
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
        export const MaterialCommunityIcons = ({ name, style, size }) => React.createElement(Text, { style: [{ fontSize: size, color: '#999' }, style] }, '•');
    `,
    'expo-status-bar': `export const StatusBar = () => null;`,
    'expo-image': `
        import React from 'react';
        import { Image as RNImage } from 'react-native-web';
        export const Image = ({ source, style }) => React.createElement(RNImage, { source, style, resizeMode: 'cover' });
    `,
    '@react-native-async-storage/async-storage': `
        export default {
            getItem: async (k) => globalThis.__store.get(k) ?? null,
            setItem: async (k, v) => { globalThis.__store.set(k, v); },
            removeItem: async (k) => { globalThis.__store.delete(k); },
        };
    `,
    'vouchers': `
        export const askMyVouching = async () => ({
            voucher: true,
            budget: { left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 1000 },
            presets: [25, 50, 75, 100],
            vouchMax: 100,
            budgetMax: 2000,
            vouchedBy: [{ memberPubkey: 'a'.repeat(64), callsign: 'Jane Albury', amount: 100, at: '2026-11-01' }],
            history: [
                { kind: 'grant', amount: 1000, actor: 'owner', actorCallsign: 'marty', at: '2026-11-01' },
                // #2915 round 4: an earlier 75 for @sam, so the profile card is a raise and 50, 75 and 100 are greyed by the cap.
                { kind: 'hold', amount: -75, actor: 'me', actorCallsign: 'Alice', at: '2026-11-03', for: 'profile', person: { memberPubkey: 's'.repeat(64), callsign: 'sam' } },
            ],
        });
        export const rereadMyVouching = async (anchor, identity, apply) => { const mv = await askMyVouching(); if (mv) apply(mv); };
        export const vouchFromProfile = async () => ({ ok: true, amount: 25, total: 25 });
    `,
    'db': `
        export const getMemberProfile = async () => ({ publicKey: 's'.repeat(64), callsign: 'sam', joinedAt: '2026-10-15T00:00:00.000Z' });
        export const getMemberRatings = async () => ({ average: 5, count: 1, asProvider: { average: 5 }, asReceiver: { average: 5 }, ratings: [] });
        export const getMemberPosts = async () => [];
        export const getBalance = async () => ({
            balance: 150, earnedCredit: 50, allowance: 100, usableAllowance: 100,
            vouchedBy: [{ memberPubkey: 'a'.repeat(64), callsign: 'Jane Albury', amount: 100, at: '2026-11-01T00:00:00.000Z' }]
        });
        export const getRatingsGiven = async () => [];
        export const getFriendsLocal = async () => [];
        export const isFriendLocal = async () => false;
        export const addFriendLocal = async () => {};
        export const removeFriendLocal = async () => {};
        export const getEscrowTotal = async () => 0;
        export const getPledgeHistory = async () => [];
        export const createConversationApi = async () => ({});
        export const getPublicChannels = async () => [];
        export const getChannelPins = async () => [];
        export const submitRating = async () => {};
        export const getDb = async () => ({});
        export const getTrustProfile = async () => null;
        export const updateMemberProfile = async () => {};
        export const pushWaitingArchetype = async () => true;
        export const getTransactions = async () => [];
        export const getAllCommunityMembers = async () => [];
        export const sendTransfer = async () => ({});
        export const signedRequest = async () => ({});
        export const signedGet = async () => ({});
        export const refreshBalanceFromServer = async () => ({});
    `,
    'blocklist': `export const getBlockedUsers = async () => []; export const isUserBlocked = async () => false; export const BLOCKLIST_UPDATED_EVENT = 'bl'; export const blockUser = async () => {}; export const unblockUser = async () => {};`,
    'trust-tier': `export const getTrustProfile = async () => ({ tier: 'trusted', mutualCount: 0, mutualConnections: [], vouchedInBy: null }); export const TIER_WORDS = {};`,
    'members-lookup': `export const cardNeedsFetch = () => false; export const fetchCardByKey = async () => null;`,
    'node-profile': `export const invitesOn = () => true; export const membersByKey = () => true; export const beansOn = () => true; export const getCachedNodeProfile = () => null; export const showcaseMode = () => 'off'; export const decisionsOn = () => false; export const hiddenTabsFor = () => [];`,
    'use-node-profile': `export const useNodeProfile = () => ({ nodeProfile: { profile: 'local', features: { beans: true, invites: true } } });`,
    'use-reader-features': `export const useShowcaseModeOnceKnown = () => false; export const useShowcaseMode = () => 'off';`,
    'door-work': `export const mayInviteHere = () => true; export const onlyAdminsInvite = () => false; export const mayMakeOfflineTicket = () => true;`,
    'peek': `export const fetchPeekCommunityName = async () => 'Castlemaine';`,
    'invite-share-name': `export const shareCommunityName = () => 'Castlemaine';`,
    'InviteAsks': `export const InviteAsks = () => null;`,
    'WantsToJoin': `export const WantsToJoin = () => null;`,
    'MyJoinRequests': `export const MyJoinRequests = () => null;`,
    'MemberAvatar': `import React from 'react'; import { View } from 'react-native-web'; export const MemberAvatar = () => React.createElement(View, { style: { width: 32, height: 32, backgroundColor: '#888', borderRadius: 16 } });`,
    'ChannelChips': `export const ChannelChips = () => null;`,
    'Sentence': `import React from 'react'; import { Text } from 'react-native-web'; export const Sentence = ({ children }) => React.createElement(Text, null, children);`,
};

const STUBBED_FILES = Object.keys(STUBS);
const stubFor = (spec) => {
    if (STUBS[spec] && !spec.startsWith('.')) return spec;
    if (!spec.startsWith('.')) return null;
    const base = path.basename(spec);
    return STUBBED_FILES.includes(base) ? base : null;
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { VouchPresetChoice } from ${JSON.stringify(path.join(NATIVE, 'components/VouchPresetChoice'))};
import PublicProfileScreen from ${JSON.stringify(path.join(NATIVE, 'app/public-profile'))};
import LedgerScreen from ${JSON.stringify(path.join(NATIVE, 'app/(tabs)/ledger'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
const view = q.get('view') || 'presets';

globalThis.__theme = { theme: scheme, colors };
const ME = 'a'.repeat(64);
globalThis.__who = { identity: { publicKey: ME, privateKey: 'b'.repeat(64), callsign: 'Alice' } };
globalThis.__params = { publicKey: 's'.repeat(64), callsign: 'sam' };
globalThis.__store = new Map([
    ['beanpool_anchor_url', 'https://node.example'],
    ['bp_active_account_pubkey', ME],
]);

function App() {
    const [preset, setPreset] = useState<number | null>(Number(q.get('pick')) || 25);

    if (view === 'profile') {
        return <PublicProfileScreen />;
    }
    if (view === 'ledger') {
        return <LedgerScreen />;
    }
    return (
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.page }} contentContainerStyle={{ padding: 16 }}>
            <VouchPresetChoice
                value={preset}
                onChange={setPreset}
                budgetLeft={Number(q.get('left')) || 550}
                budgetTotal={1000}
                noLimit={q.get('owner') === '1'}
                raiseFrom={Number(q.get('raise')) || undefined}
            />
        </ScrollView>
    );
}

createRoot(document.getElementById('root')!).render(
    <View style={{ height: '100vh', backgroundColor: colors.surface.app }}>
        <App />
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
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"', global: 'globalThis' },
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

const cases = [
    { view: 'presets', scheme: 'light', name: 'native-presets-320dp-light.png' },
    { view: 'presets', scheme: 'dark', name: 'native-presets-320dp-dark.png' },
    // An owner (Marty, 9 Nov): 200 and 500 too, "From your budget: No limit".
    { view: 'presets', scheme: 'light', owner: true, name: 'native-owner-presets-320dp-light.png' },
    { view: 'presets', scheme: 'dark', owner: true, name: 'native-owner-presets-320dp-dark.png' },
    // A raise (invites-vouching I6): "Raise to" the totals above what was vouched, no None; a voucher at 25 with 30 left (50 open, 75 and 100 greyed
    // on the difference), and an owner at 100 (200 and 500, nothing greyed).
    { view: 'presets', scheme: 'light', raise: 25, pick: 50, left: 30, name: 'native-raise-voucher-320dp-light.png' },
    { view: 'presets', scheme: 'dark', raise: 25, pick: 50, left: 30, name: 'native-raise-voucher-320dp-dark.png' },
    { view: 'presets', scheme: 'light', owner: true, raise: 100, pick: 200, name: 'native-raise-owner-320dp-light.png' },
    { view: 'presets', scheme: 'dark', owner: true, raise: 100, pick: 200, name: 'native-raise-owner-320dp-dark.png' },
    { view: 'profile', scheme: 'light', name: 'native-profile-320dp-light.png' },
    { view: 'profile', scheme: 'dark', name: 'native-profile-320dp-dark.png' },
    { view: 'ledger', scheme: 'light', name: 'native-ledger-320dp-light.png' },
    { view: 'ledger', scheme: 'dark', name: 'native-ledger-320dp-dark.png' },
];

try {
    for (const c of cases) {
        const context = await browser.newContext({ viewport: { width: WIDTH, height: 640 }, deviceScaleFactor: 2 });
        const page = await context.newPage();
        page.on("pageerror", (e) => console.log(`[${c.view}/${c.scheme}] page error: ${String(e.message).slice(0, 300)}`));
        await page.goto(`${base}/?view=${c.view}&scheme=${c.scheme}${c.owner ? '&owner=1' : ''}${c.raise ? `&raise=${c.raise}&pick=${c.pick}` : ''}${c.left ? `&left=${c.left}` : ''}`);
        await page.waitForTimeout(500);
        // #2915 round 4: the vouch card is below the fold inside the profile's ScrollView.
        if (c.view === "profile") { await page.evaluate(() => document.querySelector("[data-testid=\"profile-vouch\"]")?.scrollIntoView({ block: "start" })); await page.waitForTimeout(300); }

        const shotPath = path.join(SHOTS_DIR, c.name);
        await page.screenshot({ path: shotPath, fullPage: true });
        console.log(`Saved screenshot: ${shotPath}`);
        await context.close();
    }
} finally {
    await browser.close();
    server.close();
}
