#!/usr/bin/env node
/* global process, console, document, getComputedStyle, localStorage */
/**
 * The Ledger's doors to deals on the phone (deals S6, DESIGN-deals-fable.md §2.2, §5), at the floor (memory
 * product-audience-small-screens: 320dp wide, the phone's text at 1.3×), in the light and the dark scheme: the app's own
 * Ledger (app/(tabs)/ledger.tsx), its Wallet tab, through react-native-web in headless Chromium, as e2e/peek-320.mjs
 * draws its screens.
 *
 * What is drawn: the Wallet with beans held in trust (the IN ESCROW total and a Held in Trust row whose deal the phone
 * has, beside a hold it has no deal for and Beans from a member), and the Wallet with nothing held (no total).
 *
 * Text at 1.3× is Android's font scale: every Text's fontSize and lineHeight times 1.3, layout in dp as is. Each state
 * fails on: the page scrolling sideways; any text past the 320 edge or clipped in its box; the IN ESCROW total or a hold's
 * row under 44dp tall; the held row missing its button role; text under 4.5:1 contrast with what it is drawn on (3:1 from
 * 18.66px bold or 24px).
 *
 * A stand-in for the phone, not an emulator: Android's fonts and line breaking differ. What the Ledger imports that
 * reaches the router, the device, the theme or the node is a stand-in (utils/__tests__/ledger-deal-doors.test.ts holds
 * the taps). Nothing leaves the machine: the page aborts every request but its own. The browser: run
 * `pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium` once.
 *
 *   node apps/native/e2e/ledger-doors-320.mjs [--shots <dir>]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-doors-320-'));

// ─── Stubs: what the Ledger imports that reaches the router, the device, the theme or the node ──────────────────────
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
        export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o.android ?? o.default };
        export default { ...RNW, Text, TextInput, Platform };
    `,
    'ThemeContext': `export const useTheme = () => globalThis.__theme; export const useStyles = (make) => make(globalThis.__theme);`,
    'IdentityContext': `const identity = { publicKey: 'ab'.repeat(32), callsign: 'Ana' }; const value = { identity }; export const useIdentity = () => value;`,
    'expo-router': `
        import { useEffect } from 'react';
        export const router = { back() {}, push(to) { globalThis.__pushed.push(to); }, replace() {}, navigate() {}, canGoBack: () => false };
        export const useFocusEffect = (cb) => useEffect(() => cb(), [cb]);
        export const useNavigation = () => ({ addListener: () => () => {}, isFocused: () => true });
        export const useLocalSearchParams = () => ({});
    `,
    'react-native-keyboard-controller': `
        import React from 'react';
        import { View } from 'react-native-web';
        export const KeyboardAvoidingView = ({ children, style }) => React.createElement(View, { style }, children);
    `,
    '@expo/vector-icons': `
        import React from 'react';
        import { Text } from 'react-native-web';
        const GLYPH = { 'lock-clock': '⏱', 'chevron-right': '›', 'arrow-top-right': '↗', 'arrow-bottom-left': '↙', 'information-outline': 'ⓘ' };
        export const MaterialCommunityIcons = ({ name, size = 14, color }) => React.createElement(Text, { 'data-icon': name, style: { fontSize: size, lineHeight: size + 2, color } }, GLYPH[name] ?? '•');
    `,
    'expo-file-system/legacy': `export const cacheDirectory = 'file:///cache/'; export const EncodingType = { UTF8: 'utf8' }; export const writeAsStringAsync = async () => {};`,
    'expo-sharing': `export const shareAsync = async () => {};`,
    'expo-linear-gradient': `
        import React from 'react';
        import { View } from 'react-native-web';
        export const LinearGradient = ({ children, style }) => React.createElement(View, { style }, children);
    `,
    '@react-native-async-storage/async-storage': `export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };`,
    'haptics': `export const hapticSuccess = () => {}; export const hapticWarning = () => {};`,
    'blocklist': `export const getBlockedUsers = async () => []; export const BLOCKLIST_UPDATED_EVENT = 'blocklist_updated';`,
    'use-reader-features': `export const useShowcaseModeOnceKnown = () => 'live';`,
    'CreditBar': `export const CreditBar = () => null;`,
    'RepaymentCard': `export const RepaymentCard = () => null;`,
    'CommonsInfoModal': `export const CommonsInfoModal = () => null;`,
    'MemberAvatar': `export const MemberAvatar = () => null;`,
    'TrustBadge': `export const TrustBadge = () => null;`,
    'LocalCommunityMark': `export const LocalCommunityMark = () => null; export const LocalCommunitySheet = () => null; export const ExampleHeader = () => null;`,
    // The node's answers, from the page: a Resident with beans held in trust.
    'db': `
        export const getBalance = async () => globalThis.__balance;
        export const getTransactions = async () => globalThis.__rows;
        export const getMemberProfile = async () => ({ avatar_url: null });
        export const getAllCommunityMembers = async () => [];
        export const sendTransfer = async () => ({});
        export const getPledgeHistory = async () => [];
        export const getEscrowTotal = async () => globalThis.__escrow;
        export const signedRequest = async () => ({});
    `,
};
/** Import specifiers (bare, or a relative path's last part) that resolve to a stub. */
const BY_NAME = ['ThemeContext', 'IdentityContext', 'haptics', 'blocklist', 'use-reader-features', 'CreditBar', 'RepaymentCard', 'CommonsInfoModal',
    'MemberAvatar', 'TrustBadge', 'LocalCommunityMark', 'db'];
const stubFor = (spec) => {
    if (STUBS[spec]) return spec;
    if (!spec.startsWith('.')) return null;
    const base = path.basename(spec);
    return BY_NAME.includes(base) ? base : null;
};

// ─── The page: the Ledger's Wallet for one state ────────────────────────────────────────────────────────────────────
const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import LedgerScreen from ${JSON.stringify(path.join(NATIVE, 'app/(tabs)/ledger'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__theme = { theme: scheme, colors };
globalThis.__pushed = [];
const LISTING = '123e4567-e89b-12d3-a456-426614174000';
const DAY = Date.UTC(2026, 9, 3, 12);
const base = { projectWallet: false, timestamp: '03/10/2026', at: DAY };
globalThis.__balance = {
    balance: 85, floor: -200, usableFloor: -200, liveOffers: 1, activated: true, frozen: false, creditFrozen: false, knownFrozen: false, knownGrant: 0,
    tier: { name: 'Resident', emoji: '🏠' }, tierCredit: 200, earnedCredit: 150, qualifiedValue: 300, avgRating: 4.5, reviewCount: 3, commons: 12.5,
    trustStats: { uniquePartners: 4 },
};
const held = q.get('held') !== '0';
globalThis.__escrow = held ? 45 : 0;
globalThis.__rows = held ? [
    { ...base, id: 'h1', type: 'debit', amount: 45, peer: 'Held in Trust: Sourdough baking course (to Damo)', peerPubkey: 'escrow_deal-1', memo: 'Held in trust for offer ' + LISTING,
        held: { title: 'Sourdough baking course', counterparty: 'Damo', toCounterparty: true, dealId: 'deal-1', postId: LISTING } },
    { ...base, id: 'h2', type: 'debit', amount: 5, peer: 'Held in Trust', peerPubkey: 'escrow_unknown', memo: '', held: { title: null, counterparty: null, toCounterparty: false } },
    { ...base, id: 'p1', type: 'credit', amount: 40, peer: 'Mia', peerPubkey: 'mia-key', memo: 'Paid for ' + LISTING + ' thanks', held: null },
] : [
    { ...base, id: 'p1', type: 'credit', amount: 40, peer: 'Mia', peerPubkey: 'mia-key', memo: 'Fresh eggs', held: null },
];
createRoot(document.getElementById('root')).render(<View style={{ minHeight: '100vh', backgroundColor: colors.surface.app }}><LedgerScreen /></View>);
`);

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'empty' },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.mjs', '.json'],
    nodePaths: [path.join(ROOT, 'node_modules'), path.join(NATIVE, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {} };' },
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
<style>html,body,#root{margin:0;min-height:100%} body{font-family:sans-serif}</style></head>
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
    page.on('pageerror', (e) => errors.push(String(e)));

    /** One state's checks, run in the page. */
    const measure = async (label, { total, heldRow }) => {
        states++;
        const found = await page.evaluate(({ WIDTH, total, heldRow }) => {
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
                let base = { r: 255, g: 255, b: 255, a: 1 };
                for (const l of layers.reverse()) base = over(l, base);
                return base;
            };
            if (document.scrollingElement.scrollWidth > WIDTH) out.push('the page scrolls sideways (' + document.scrollingElement.scrollWidth + 'px)');
            const texts = [...document.querySelectorAll('div[dir], span, input, textarea')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = el.textContent.trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push('"' + what + '" runs past the edge (' + Math.round(r.left) + '–' + Math.round(r.right) + ')');
                if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push('"' + what + '" is cut on the right (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
                if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') out.push('"' + what + '" is cut at the bottom (' + el.scrollHeight + ' > ' + el.clientHeight + ')');
                const cs = getComputedStyle(el);
                const fg = rgb(cs.color);
                if (!fg) continue;
                if (/^[\p{Extended_Pictographic}️‍\s←↗↙›⏱]+$/u.test(what)) continue;
                const bg = backdrop(el);
                const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
                const ratio = (a + 0.05) / (b + 0.05);
                const size = parseFloat(cs.fontSize);
                const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                if (ratio < (large ? 3 : 4.5)) out.push('"' + what + '" has contrast ' + ratio.toFixed(2) + ':1 (' + cs.color + ' on rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + '), ' + size + 'px)');
            }
            const door = (testId, what, want) => {
                const els = [...document.querySelectorAll('[data-testid="' + testId + '"]')];
                if (want && els.length !== 1) { out.push(what + ': expected one, found ' + els.length); return; }
                if (!want && els.length) { out.push(what + ' is drawn but should not be'); return; }
                for (const el of els) {
                    const r = el.getBoundingClientRect();
                    if (el.getAttribute('role') !== 'button') out.push(what + ' has no button role');
                    if (r.height < 43.5) out.push(what + ' is ' + Math.round(r.height) + 'dp tall');
                }
            };
            // The metrics of the wallet strip start together: each one's icon, value and label sit at the top whatever the neighbours' labels do
            // (a label that wraps to two lines beside one that doesn't must not push the shorter one's content down).
            const metrics = [...document.querySelectorAll('div[dir]')]
                .filter((el) => el.children.length === 0 && /^(COMMONS|CREDIT FLOOR|IN ESCROW)/.test(el.textContent.trim()))
                .map((label) => label.parentElement);
            if (metrics.length < 2) out.push('the wallet strip: expected two or three metrics, found ' + metrics.length);
            for (let i = 0; i < 3; i++) {
                const tops = metrics.filter((m) => m.children[i]).map((m) => m.children[i].getBoundingClientRect().top);
                if (tops.length && Math.max(...tops) - Math.min(...tops) > 1) out.push('the wallet strip metrics do not start together: part ' + (i + 1) + ' of each sits ' + (Math.max(...tops) - Math.min(...tops)).toFixed(1) + 'px apart');
            }
            door('ledger-in-escrow', 'the IN ESCROW total', total);
            door('ledger-held-row', 'a Held in Trust row with a deal', heldRow);
            return out;
        }, { WIDTH, total, heldRow });
        for (const p of found) problems.push(`${label}: ${p}`);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `phone-${label.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true });
        }
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };
    const open = async (query) => { await page.goto(`${base}/?${query}`); await page.waitForTimeout(400); };
    const wallet = async () => {
        await page.locator('[data-testid="ledger-wallet-tab"]').first().click();
        await page.waitForTimeout(300);
    };

    for (const scheme of ['light', 'dark']) {
        await open(`scheme=${scheme}`);
        await page.locator('[data-testid="ledger-wallet-tab"]').first().waitFor();
        await wallet();
        await page.locator('[data-testid="ledger-in-escrow"]').waitFor();
        await measure(`${scheme} · Wallet: beans held in trust`, { total: true, heldRow: true });
        await open(`scheme=${scheme}&held=0`);
        await page.locator('[data-testid="ledger-wallet-tab"]').first().waitFor();
        await wallet();
        await page.getByText('Fresh eggs').waitFor();
        await measure(`${scheme} · Wallet: nothing held`, { total: false, heldRow: false });
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
console.log('Every state holds: no sideways scroll, nothing past the edge or cut, the doors 44dp and buttons, text at 4.5:1 or better.');
