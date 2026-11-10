#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Vouchers on the phone (slice V2, DESIGN-invites-and-names-list-amend2-fable.md §5, Marty's §10 and §11) at the floor
 * (memory product-audience-small-screens: 320dp wide, the phone's text at 1.3×), in the light and the dark scheme, through
 * react-native-web in headless Chromium. What is drawn is the app's own code:
 * - components/VoucherCard.tsx from a card shaped as the node sends it (left 550, held 100, level 650): Their budget with
 *   Set budget to (quick levels and stepper), then See who they brought in, then Budget history (with the node's own actors);
 * - components/VouchersBlock.tsx, the block People → Invites renders for owners and committee admins, on People's padding;
 * - app/names-list.tsx, the whole screen, its list opened with a real key (only the opening and the node's answers are
 *   stand-ins, below): the voucher first with its tag, Make a voucher, the Vouchers filter with a role voucher's row (Add
 *   their name), the Make a voucher sheet (amount chips and stepper), and Community health's Vouchers section.
 *
 * Each state fails on: the page scrolling sideways; any text past the 320 edge or clipped in its box; a button under 44dp
 * tall; text under 4.5:1 contrast with what it is drawn on (3:1 from 18.66px bold or 24px).
 *
 * A stand-in for the phone, not an emulator: Android's fonts and line breaking differ, and iOS's safe area isn't drawn.
 * Nothing leaves the machine: the page aborts every request but its own.
 *
 *   node apps/native/e2e/vouchers-320.mjs [--shots <dir>]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchers-320-'));
const REAL = (rel) => JSON.stringify(path.join(NATIVE, rel));

// ─── Stand-ins: what the screens import that reaches the router, the device, the theme or the node ──────────────────
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
        export const Alert = { alert: () => {} };
        export default { ...RNW, Text, TextInput, Platform, Alert };
    `,
    'expo-router': `
        import React from 'react';
        export const router = { back() {}, push() {}, replace() {}, navigate() {}, canGoBack: () => false, canDismiss: () => false };
        export const useRouter = () => router;
        export const useFocusEffect = (cb) => { React.useEffect(() => cb(), [cb]); };
        export const useLocalSearchParams = () => ({});
        export const ErrorBoundary = () => null;
    `,
    'ThemeContext': `
        export const useTheme = () => globalThis.__theme;
        export const useStyles = (make) => make(globalThis.__theme);
    `,
    'IdentityContext': `
        const value = { identity: { publicKey: 'a'.repeat(64), privateKey: 'f'.repeat(64), callsign: 'Sally' }, setIdentity() {} };
        export const useIdentity = () => value;
    `,
    '@expo/vector-icons': `
        import React from 'react';
        import { Text } from 'react-native-web';
        export const MaterialCommunityIcons = ({ style, size, name, color }) => React.createElement(Text, { style: [{ fontSize: size || 18, color: color || '#242824' }, style] }, name === 'arrow-left' ? '←' : '•');
    `,
    'expo-crypto': `
        export const getRandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
        export const randomUUID = () => crypto.randomUUID();
    `,
    '@react-native-async-storage/async-storage': `
        export default { getItem: async (k) => (k === 'beanpool_anchor_url' ? 'https://mullum.example' : null), setItem: async () => {}, removeItem: async () => {} };
    `,
    'expo-secure-store': `
        export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;
        export const getItemAsync = async () => null;
        export const setItemAsync = async () => {};
        export const deleteItemAsync = async () => {};
    `,
    'react-native-safe-area-context': `
        import React from 'react';
        import { View } from 'react-native-web';
        export const SafeAreaView = ({ style, children }) => React.createElement(View, { style }, children);
        export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
    `,
    'react-native-keyboard-controller': `
        import React from 'react';
        import { View, ScrollView } from 'react-native-web';
        export const KeyboardAvoidingView = ({ children, style }) => React.createElement(View, { style }, children);
        export const KeyboardAwareScrollView = React.forwardRef((p, ref) => React.createElement(ScrollView, { ...p, ref }));
        export const KeyboardStickyView = ({ children, style }) => React.createElement(View, { style }, children);
    `,
    'expo-camera': `export const CameraView = () => null; export const useCameraPermissions = () => [{ granted: false, canAskAgain: true }, async () => ({ granted: false })];`,
    'react-native-qrcode-svg': `export default () => null;`,
    'expo-status-bar': `export const StatusBar = () => null;`,
    'expo-clipboard': `export const getStringAsync = async () => ''; export const setStringAsync = async () => {};`,
    'expo-local-authentication': `
        export const SecurityLevel = { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 };
        export const hasHardwareAsync = async () => false; export const isEnrolledAsync = async () => false;
        export const getEnrolledLevelAsync = async () => 0; export const authenticateAsync = async () => ({ success: false });
    `,
    'node-post': `
        export const anchorUrl = async () => 'https://mullum.example';
        export const getCachedAnchorUrl = () => 'https://mullum.example';
        export const setCachedAnchorUrl = () => {};
        export const signedGet = async () => new Response('{}', { status: 404 });
        export const signedPost = async () => new Response('{}', { status: 404 });
        export const signedDelete = async () => new Response('{}', { status: 404 });
    `,
    'db': `export const getAllCommunityMembers = async () => []; export const createDecision = async () => ({}); export const getDb = async () => null;`,
    'member-statements': `export const makeOfflineTicket = async () => 'ticket';`,
    'names-invite': `
        export const inviteThisPerson = async () => ({ ok: false, message: '' });
        export const invitesForEntry = () => [];
        export const boundInviteLine = () => '';
        export const inviteLink = () => '';
    `,
    // The names list's own module, as it is, but its opening (keys, pin, sealed history) and the node's answers: a list of
    // four sealed with a real key here, and the vouchers block the node gives an owner (on the credit committee by role).
    'names-list': `
        import { newNamesListKey, sealNamesEntry } from '@beanpool/core';
        export * from ${REAL('utils/names-list.ts')};
        const ME = 'a'.repeat(64), WREN = 'b'.repeat(64), ZARA = 'd'.repeat(64), BEA = 'e'.repeat(64);
        const KID = '9'.repeat(64);
        const KEY = newNamesListKey();
        const ID = { zara: '1'.repeat(32), ann: '2'.repeat(32), mary: '3'.repeat(32), tom: '5'.repeat(32) };
        const entry = (id, name, note) => ({ id, keyId: KID, ciphertext: sealNamesEntry(KEY, id, KID, { name, note }), createdBy: ME, createdAt: '2026-11-01T00:00:00.000Z', updatedBy: null, updatedAt: '' });
        const conf = (id, entryId, memberPubkey, callsign, status = 'confirmed') => ({ id, entryId, memberPubkey, callsign, status, confirmedBy: WREN, confirmedAt: '2026-11-03T09:00:00Z',
            needsSecond: status === 'awaiting_second', secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null });
        const OPENED = {
            state: {
                admins: [{ pubkey: ME, callsign: 'Sally', role: 'owner', keyIds: [KID], holdsCurrent: true }, { pubkey: WREN, callsign: 'Wren', role: 'admin', keyIds: [KID], holdsCurrent: true }],
                callsigns: {}, settings: { twoAdminsToConfirm: false, namesShownToMembers: false },
                counts: { entries: 4, confirmed: 2, awaitingSecond: 1, byKey: {}, locked: 0 },
                me: { pubkey: ME, role: 'owner', owner: true },
            },
            plan: { kind: 'ready' },
            pin: { me: ME, trusted: [WREN], chain: [{ id: KID, n: 1 }], abandoned: [], communityId: 'mullum' },
            ring: { [KID]: KEY }, generations: new Map(),
            list: {
                current: null,
                entries: [entry(ID.zara, 'Zara Quinn', 'Runs the seed library'), entry(ID.ann, 'Ann Awaiting', ''), entry(ID.mary, 'Mary Smith', 'From the seed swap'), entry(ID.tom, 'Tom Unconfirmed', '')],
                confirmations: [conf('c1', ID.zara, ZARA, 'zara'), conf('c2', ID.ann, '7'.repeat(64), 'ann', 'awaiting_second'), conf('c3', ID.mary, BEA, 'Bea')],
            },
            notices: [], made: null, sentTo: [], toCheck: [],
        };
        const row = (over) => ({ memberPubkey: ZARA, callsign: 'zara', source: 'entry', entryId: ID.zara, madeBy: ME, madeByCallsign: 'Sally', madeAt: '2026-11-05T10:00:00Z',
            stoppedAt: null, stopReason: null, left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 650, belowZero: 1, writtenOff: 25,
            passedOn: { amount: 50, people: 1, belowZero: 25 }, invitesWithVouch: 5, trading: { withOthers: 2, insideOnly: 1 }, ...over });
        export const VOUCHER_BLOCK = {
            vouchers: [
                row({}),
                row({ memberPubkey: WREN, callsign: 'Wren', source: 'role', entryId: null, madeBy: 'migration:vouchers', madeByCallsign: null, left: 1500, held: 0, level: 1500,
                    vouched: 0, peopleVouched: 0, belowZero: 0, writtenOff: 0, passedOn: { amount: 0, people: 0, belowZero: 0 }, invitesWithVouch: 0 }),
            ],
            settings: { voucherBudget: 1000, memberGift: 100, presets: [25, 50, 75, 100], vouchMax: 100, vouchesPerPerson: 3, budgetMax: 2000 },
        };
        export const openNamesList = async () => ({ ok: true, value: OPENED });
        export const fetchNamesLog = async () => ({ ok: true, value: { log: [] } });
        export const readBoundInvites = async () => ({ ok: true, value: { invites: [] } });
        export const unkeptRemovalsOf = () => [];
        export const fetchHealthSummary = async () => ({ ok: false, status: 404, code: null, message: 'not here' });
        export const fetchHealthExceptions = async () => ({ ok: true, value: { settings: { debtLinePct: 50, quietDays: 30 }, exceptions: [], departed: [] } });
        export const fetchHealthLog = async () => ({ ok: true, value: { log: [] } });
        export const fetchVouchers = async () => ({ ok: true, value: VOUCHER_BLOCK });
        export const fetchVoucherCard = async () => ({ ok: true, value: { ...row({}), history: [], people: [], canChange: true } });
    `,
    'names-debts': `
        export * from ${REAL('utils/names-debts.ts')};
        export const fetchNamesDebts = async () => ({ ok: true, value: [] });
    `,
};
/** Relative imports, by their last part, that resolve to a stand-in (never a stand-in's own import of the real file). */
const BY_NAME = ['ThemeContext', 'IdentityContext', 'node-post', 'db', 'member-statements', 'names-invite', 'names-list', 'names-debts'];
const stubFor = (spec) => {
    if (STUBS[spec]) return spec;
    if (spec.endsWith('ThemeContext') || spec.endsWith('ThemeContext.tsx')) return 'ThemeContext';
    if (!spec.startsWith('.')) return null;
    const base = path.basename(spec);
    return BY_NAME.includes(base) ? base : null;
};

// ─── The page: one state of the card, the block or the names list ───────────────────────────────────────────────────
const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { lightColors, darkColors } from ${REAL('constants/colors')};
import { VoucherCard } from ${REAL('components/VoucherCard')};
import { VouchersBlock } from ${REAL('components/VouchersBlock')};
import NamesListScreen from ${REAL('app/names-list')};
import { VOUCHER_BLOCK } from 'names-list';

/** As engine/vouchers.ts budgetOf() reads it: 1,000 given, 350 vouched to 4 people, 100 held on one invite. */
const NODE_CARD = {
    memberPubkey: 'd'.repeat(64), callsign: 'zara', source: 'entry', entryId: '1'.repeat(32), madeBy: 'a'.repeat(64), madeByCallsign: 'Sally',
    madeAt: '2026-11-05T10:00:00Z', stoppedAt: null, stopReason: null,
    left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 650, belowZero: 1, writtenOff: 25,
    passedOn: { amount: 50, people: 1, belowZero: 25 }, invitesWithVouch: 5, trading: { withOthers: 2, insideOnly: 1 }, canChange: true,
    history: [
        { kind: 'grant', amount: 1000, actor: 'a'.repeat(64), actorCallsign: 'Sally', at: '2026-11-05T10:00:00Z' },
        { kind: 'hold', amount: -100, actor: 'd'.repeat(64), actorCallsign: 'zara', at: '2026-11-05T11:00:00Z', for: 'invite', outcome: 'vouched', person: { memberPubkey: 'c'.repeat(64), callsign: 'sam' } },
        { kind: 'return', amount: 75, actor: 'node', actorCallsign: null, at: '2026-11-06T09:00:00Z', for: 'invite', why: 'expired' },
        { kind: 'grant', amount: 1000, actor: 'migration:vouchers', actorCallsign: null, at: '2026-11-01T10:00:00Z' },
        { kind: 'top_up', amount: 500, actor: 'f'.repeat(64), actorCallsign: null, at: '2026-11-03T10:00:00Z' },
    ],
    people: [
        { memberPubkey: 'c'.repeat(64), callsign: 'sam', joinedAt: '2026-11-02T12:00:00Z', amount: 100, raised: false, byInvite: true, belowZero: true, left: false, writtenOff: 0, vouchesForMe: false, trading: 'others' },
        { memberPubkey: '8'.repeat(64), callsign: 'bob', joinedAt: '2026-11-03T12:00:00Z', amount: 75, raised: false, byInvite: true, belowZero: false, left: false, writtenOff: 0, vouchesForMe: false, trading: 'inside' },
    ],
};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
const viewMode = q.get('view') || 'card';
globalThis.__theme = { theme: scheme, colors, isDark: scheme === 'dark' };
const identity = { publicKey: 'a'.repeat(64), privateKey: 'f'.repeat(64), callsign: 'Sally', createdAt: '2026-11-01' };

function RootApp() {
    // A flex root the height of the page, as a phone's screen is, so the screen's own background reaches the bottom.
    if (viewMode === 'names') return <View style={{ flex: 1, minHeight: '100vh' }}><NamesListScreen /></View>;
    if (viewMode === 'block') {
        // People → Invites draws the block first in its list, on the list's padding (16).
        return (
            <View style={{ flex: 1, minHeight: '100vh', backgroundColor: colors.surface.app, padding: 16 }}>
                <VouchersBlock vouchers={VOUCHER_BLOCK.vouchers} onOpen={() => {}} onMakeVoucher={() => {}} />
            </View>
        );
    }
    return (
        <View style={{ flex: 1, backgroundColor: colors.surface.page, minHeight: '100vh' }}>
            <VoucherCard anchorUrl="https://mullum.example" identity={identity} memberPubkey={NODE_CARD.memberPubkey} initialCard={NODE_CARD} onClose={() => {}} />
        </View>
    );
}

createRoot(document.getElementById('root')).render(<RootApp />);
`);

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.png': 'empty', '.ttf': 'empty' },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.mjs', '.json'],
    nodePaths: [path.join(ROOT, 'node_modules'), path.join(NATIVE, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {} }; globalThis.global = globalThis;' },
    logLevel: 'error',
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
                if (args.namespace === 'stub' && !STUBS[args.path]) return undefined;
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
<script>window.process = window.process || { env: {} }; window.global = window;</script>
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
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 750 }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => { console.error('PAGE ERROR:', e); errors.push(String(e)); });

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
                let base = { r: 255, g: 255, b: 255, a: 1 };
                for (const l of layers.reverse()) base = over(l, base);
                return base;
            };
            if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
            // Not a checkbox: react-native-web draws a Switch (the owners' setting on the names list) with an
            // `appearance: none` checkbox laid over its track, whose value ("on") is never drawn as words.
            const texts = [...document.querySelectorAll('div[dir], span, input:not([type="checkbox"]), textarea')].filter((el) => {
                const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
                return own || ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value);
            });
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = (el.value ?? el.textContent).trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
                if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`"${what}" is cut on the right (${el.scrollWidth} > ${el.clientWidth})`);
                if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible' && el.tagName !== 'TEXTAREA') out.push(`"${what}" is cut at the bottom (${el.scrollHeight} > ${el.clientHeight})`);
                const cs = getComputedStyle(el);
                const fg = rgb(cs.color);
                if (!fg) continue;
                if (/^[\p{Extended_Pictographic}️‍\s]+$/u.test(what)) continue;
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
                if (r.height < 43.5) out.push(`the button "${el.textContent.trim().slice(0, 40) || el.getAttribute('aria-label')}" is ${Math.round(r.height)}dp tall`);
            }
            return out;
        }, { WIDTH });
        for (const p of found) problems.push(`${label}: ${p}`);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true }); }
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };

    const open = async (query) => { await page.goto(`${base}/?${query}`); await page.waitForTimeout(300); };
    const press = async (name) => { await page.getByRole('button', { name, exact: true }).first().click(); await page.waitForTimeout(250); };

    for (const scheme of ['light', 'dark']) {
        // 1. The card: Their budget, Passed on with its below-zero part, Set budget to (from 700: the nearest level to 650)
        await open(`view=card&scheme=${scheme}`);
        await page.getByText('Set budget to: 700').waitFor();
        await measure(`vouchers-card-${scheme}`);

        // 2. See who they brought in
        await press('See who they brought in ›');
        await page.getByText('People vouched for').waitFor();
        await measure(`vouchers-card-people-${scheme}`);

        // 3. Budget history (a member, the node, BeanPool's start, someone who has left)
        await press('Budget history ›');
        await page.getByTestId('budget-history-section').waitFor();
        await measure(`vouchers-card-history-${scheme}`);

        // 4. People → Invites: the Vouchers block People renders (components/VouchersBlock.tsx)
        await open(`view=block&scheme=${scheme}`);
        await page.getByText('@zara · 550 left ›').waitFor();
        await measure(`vouchers-invites-block-${scheme}`);

        // 5. The names list: the voucher first with its tag, Make a voucher on Mary Smith's entry, the filter chips
        await open(`view=names&scheme=${scheme}`);
        await page.getByText('Zara Quinn').waitFor();
        await page.getByRole('button', { name: 'Make a voucher', exact: true }).first().waitFor();
        await measure(`vouchers-names-list-${scheme}`);

        // 6. The Vouchers filter: Zara's entry, and Wren's role voucher row with Add their name
        await press('Vouchers');
        await page.getByText('Add their name').waitFor();
        await measure(`vouchers-names-filter-${scheme}`);

        // 7. Make a voucher: the sheet with the amount chips and the stepper, prefilled from the community's setting
        await press('All');
        await press('Make a voucher');
        await page.getByText('Make @Bea a voucher?').waitFor();
        await measure(`vouchers-make-sheet-${scheme}`);

        // 8. Community health: its Vouchers section
        await press('Cancel');
        await press('Community health');
        await page.getByText('VOUCHERS', { exact: true }).waitFor();
        await measure(`vouchers-health-${scheme}`);
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
console.log('Every state holds: no sideways scroll, nothing past the edge or cut, buttons accessible, text contrast passes.');
