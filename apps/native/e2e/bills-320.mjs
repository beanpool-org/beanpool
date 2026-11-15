#!/usr/bin/env node
/* global process, console, document */
/**
 * Your deals → Bills on the phone (components/Bills.tsx; DESIGN-getting-paid-fable §4.2, §4.3, slice B2), at the floor (320dp
 * wide, phone text at 1.3×), in Light, Classic and Dark: the app's own BillsPanel and payer's sheet through react-native-web in
 * headless Chromium, the node's answers given here (utils/db stubbed; a lost answer for the case that shows one). A stand-in
 * for the phone, not the phone: Android's fonts and line breaking differ. The same cases as the web's e2e/bills-shots.mjs.
 *
 * Checks, per look and case: no sideways scroll; nothing past the 320dp edge; every button at least 44dp tall; the amount is
 * whole; a lost answer keeps the sheet open and says the bill may have been paid. Screenshots with --shots <dir>.
 *
 *   node apps/native/e2e/bills-320.mjs [--shots <dir>]
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
const HEIGHT = 900;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bills-320-'));

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
        export const Alert = { alert() {} };
        export default { ...RNW, Text, TextInput, Platform, Alert };
    `,
};

// The node, answered here: each case's bills and balance; a payment that never answers for the lost case.
const DB_STUB = `
    const q = new URLSearchParams(location.search);
    const ROB = 'a'.repeat(64), KIM = 'b'.repeat(64), ZED = 'c'.repeat(64);
    const UNTIL = new Date(Date.now() + 28 * 86400000).toISOString();
    const bill = (role, o = {}) => ({ id: 'bill-0001', role, billerPublicKey: ROB, billerName: 'Rob', payerPublicKey: KIM, payerName: 'Kim', amount_c: 6000,
        whatFor: 'Power, October', postId: 'post-1', postTitle: "Room at Rob's", standingId: null, state: 'sent', sentAt: '2026-11-12T10:00:00.000Z',
        expiresAt: UNTIL, paidAt: null, ...(role === 'to-pay' ? { known: true, creditOpen: false } : {}), ...o });
    const STRANGER = bill('to-pay', { id: 'bill-0002', billerPublicKey: ZED, billerName: 'Zed', whatFor: 'Bike repair, back wheel and brakes', amount_c: 30000, postId: null, postTitle: null, known: false });
    export const CASES = {
        'to-pay-list': { me: KIM, toPay: [bill('to-pay'), STRANGER], sent: [], balance_c: 8500 },
        'sheet-known': { me: KIM, toPay: [bill('to-pay')], sent: [], balance_c: 8500, open: 'bill-0001' },
        'sheet-confirm': { me: KIM, toPay: [bill('to-pay')], sent: [], balance_c: 8500, open: 'bill-0001' },
        'sheet-stranger': { me: KIM, toPay: [STRANGER], sent: [], balance_c: 1200, open: 'bill-0002' },
        'sheet-lost': { me: KIM, toPay: [bill('to-pay')], sent: [], balance_c: 8500, open: 'bill-0001', lost: true },
        'sent-list': { me: ROB, toPay: [], balance_c: 0, sent: [
            bill('sent'),
            bill('sent', { id: 'bill-0003', payerName: 'Sam', whatFor: 'Water, October', amount_c: 2500, state: 'paid', paidAt: '2026-11-14T09:00:00.000Z' }),
            bill('sent', { id: 'bill-0004', payerName: 'Alexandria-Rose', whatFor: 'Garden tools, borrowed and broken', amount_c: 199999, state: 'expired' }),
        ] },
    };
    const c = CASES[q.get('case') || 'to-pay-list'];
    export const getBills = async () => ({ toPay: c.toPay, sent: c.sent });
    export const getBalance = async () => ({ balance_c: c.balance_c, floor_c: -100000, usableFloor_c: -100000, liveOffers: 1 });
    export const payBill = async () => { if (c.lost) throw new Error('Network request failed'); return { success: true }; };
    export const declineBill = async () => ({ success: true });
    export const withdrawBill = async () => ({ success: true });
    export const reportBill = async () => ({ success: true });
    export const createConversationApi = async () => ({ id: 'conv-1' });
`;
const MORE_STUBS = {
    db: DB_STUB,
    blocklist: 'export const blockUser = async () => true; export const getBlockedUsers = async () => [];',
    'keyboard-alert': 'export const Alert = { alert() {} };',
    haptics: 'export const hapticTick = () => {};',
    'expo-router': 'export const router = { push() {} };',
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView } from 'react-native';
import { COLOUR_SETS } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { BillsPanel } from ${JSON.stringify(path.join(NATIVE, 'components/Bills'))};
import { CASES } from 'db-cases';

const q = new URLSearchParams(location.search);
const colors = COLOUR_SETS[q.get('set') || 'light'];
const c = CASES[q.get('case') || 'to-pay-list'];
const noop = () => {};

createRoot(document.getElementById('root')).render(
    <View style={{ backgroundColor: colors.surface.app, minHeight: ${HEIGHT} }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
            <View testID="case-root">
                <BillsPanel me={c.me} openBillId={c.open ?? null} onMessage={noop} onOpenPost={noop} onPostOffer={noop} />
            </View>
        </ScrollView>
    </View>
);
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
                if (args.namespace === 'stub') return undefined;
                if (STUBS[args.path]) return { path: args.path, namespace: 'stub' };
                if (args.path === 'db-cases' || /utils\/db$/.test(args.path)) return { path: 'db', namespace: 'stub' };
                if (/utils\/blocklist$/.test(args.path)) return { path: 'blocklist', namespace: 'stub' };
                if (/utils\/keyboard-alert$/.test(args.path)) return { path: 'keyboard-alert', namespace: 'stub' };
                if (/utils\/haptics$/.test(args.path)) return { path: 'haptics', namespace: 'stub' };
                if (args.path === 'expo-router') return { path: 'expo-router', namespace: 'stub' };
                if (/ThemeContext$/.test(args.path)) return { path: 'theme', namespace: 'stub' };
                return undefined;
            });
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
                if (args.path === 'theme') {
                    return { loader: 'jsx', resolveDir: NATIVE, contents: `
                        import { COLOUR_SETS } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
                        const set = new URLSearchParams(location.search).get('set') || 'light';
                        export const useTheme = () => ({ colors: COLOUR_SETS[set], theme: set === 'light' ? 'light' : 'dark' });
                    ` };
                }
                return { contents: MORE_STUBS[args.path] ?? STUBS[args.path], loader: 'jsx', resolveDir: NATIVE };
            });
        },
    }],
});

const bundle = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<script>window.process = window.process || { env: {} }; window.global = window;</script>
<style>html,body,#root{margin:0} body{font-family:sans-serif}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// [case, what to tap first]: the web's cases (apps/pwa/e2e/bills-shots.mjs).
const CASES = [
    ['to-pay-list', []],
    ['sheet-known', []],
    ['sheet-confirm', ['bill-pay']],
    ['sheet-stranger', []],
    ['sheet-lost', ['bill-pay', 'bill-confirm-pay']],
    ['sent-list', ['bills-side-sent']],
];
// The phone's looks: Light, Classic (the set 'dark') and Dark (the set 'night').
const LOOKS = [['light', 'light'], ['classic', 'dark'], ['dark', 'night']];

const problems = [];
const check = (ok, what) => { if (!ok) { problems.push(what); console.error(`  x ${what}`); } };
const browser = await chromium.launch();
let shots = 0;
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e}`));
    for (const [look, set] of LOOKS) {
        for (const [name, taps] of CASES) {
            await page.goto(`${base}/?set=${set}&case=${name}`);
            await page.getByTestId('case-root').waitFor();
            await page.getByTestId(name.startsWith('sheet') ? /^bill-sheet-/ : 'bills-panel').first().waitFor();
            for (const id of taps) { await page.getByTestId(id).click(); await page.waitForTimeout(120); }
            await page.waitForTimeout(200);
            const m = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('[role="button"], [role="tab"], [role="link"], button'));
                const buttons = els.map((b) => {
                    const r = b.getBoundingClientRect();
                    return { text: b.textContent, h: r.height, right: r.right };
                });
                const amount = document.querySelector('[data-testid="bill-amount"]');
                return {
                    wide: document.documentElement.scrollWidth, buttons,
                    amountCut: amount ? amount.scrollWidth > amount.clientWidth + 1 : false,
                    refusal: document.querySelector('[data-testid="bill-refusal"]')?.textContent ?? null,
                    sheet: !!document.querySelector('[data-testid^="bill-sheet-"]'),
                };
            });
            check(m.wide <= WIDTH, `${look} ${name}: no sideways scroll (${m.wide} wide)`);
            check(!m.amountCut, `${look} ${name}: the amount is whole`);
            for (const b of m.buttons) {
                check(b.h >= 44 - 0.5, `${look} ${name}: "${b.text}" is ${b.h.toFixed(1)}dp tall`);
                check(b.right <= WIDTH + 0.5, `${look} ${name}: "${b.text}" stays inside 320dp`);
            }
            if (name === 'sheet-lost') check(m.sheet && /may have been paid/.test(m.refusal ?? ''), `${look} ${name}: the lost answer stays on the sheet`);
            if (SHOTS) {
                await page.getByTestId('case-root').screenshot({ path: path.join(SHOTS, `phone-${name}-${look}.png`) });
                shots++;
            }
        }
    }
} finally {
    await browser.close();
    server.close();
}
if (problems.length) { console.error(`\n${problems.length} problem(s)`); process.exit(1); }
console.log(SHOTS ? `\n${shots} shots in ${SHOTS}; all checks pass` : '\nAll checks pass');

