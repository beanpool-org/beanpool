#!/usr/bin/env node
/* global process, console, document */
/**
 * A short week on the phone (components/StandingDeal.tsx; DESIGN-getting-paid-fable §3.2, slice L2), at the floor (320dp wide,
 * phone text at 1.3×), in Light, Classic and Dark: the app's own StandingPanel and StandingTakeUp through react-native-web in
 * headless Chromium, the steps answered here (a refusal for the case that shows one). A stand-in for the phone, not the phone:
 * Android's fonts and line breaking differ.
 *
 * Checks, per look and case: no sideways scroll; nothing past the 320dp edge; every button at least 44dp tall and the quiet
 * link 48dp; a refused ask keeps its sheet open with the node's words. Screenshots with --shots <dir>: phone-<case>-<look>.
 *
 *   node apps/native/e2e/short-week-320.mjs [--shots <dir>]
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
const HEIGHT = 700;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'short-week-320-'));

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

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView } from 'react-native';
import { COLOUR_SETS } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { StandingPanel, StandingTakeUp } from ${JSON.stringify(path.join(NATIVE, 'components/StandingDeal'))};

const q = new URLSearchParams(location.search);
const colors = COLOUR_SETS[q.get('set') || 'light'];
const PAYER = 'a'.repeat(64);
const PAYEE = 'b'.repeat(64);
const START = '2026-11-11T08:00:00.000Z';
const row = (o = {}) => ({
    id: 'tx-1', postId: 'post-1', postTitle: "Room at Rob's", buyerPublicKey: PAYER, buyerCallsign: 'Kim', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    amount_c: 20000, status: 'completed', createdAt: START, completedAt: START,
    standingId: 'sd-1', periodNo: 1, standingPhase: 'paid', standingBeans_c: 20000, standingUnit: 'week', standingMaxPeriods: null,
    standingNextDueAt: '2026-11-18T08:00:00.000Z', standingStartsAt: START, standingShortSince: null, standingStopped: false,
    standingAsksLeft: 3, standingAsk: null, ...o,
});
const GRACE = { standingPhase: 'short', standingShortSince: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-18T09:00:00.000Z' };
const ASK = { standingAsk: { id: 'chg-1', beans_c: 10000, periodNo: 2, askedAt: '2026-11-14T08:00:00.000Z' }, standingAsksLeft: 2 };
const CASES = {
    'payer-card': { tx: row(), side: PAYER },
    'payer-ask-sheet': { tx: row(), side: PAYER },
    'payer-ask-refused': { tx: row(), side: PAYER, refuse: "You've asked about this week three times, which is the most." },
    'payer-ask-open': { tx: row(ASK), side: PAYER },
    'payee-answer-sheet': { tx: row(ASK), side: PAYEE },
    'payee-lower-sheet': { tx: row(), side: PAYEE },
    'payee-grace-lower': { tx: row(GRACE), side: PAYEE },
    'payer-agreed': { tx: row({ standingDueBeans_c: 10000, standingAsksLeft: 2 }), side: PAYER },
};
const name = q.get('case') || 'payer-card';
const c = CASES[name];
const noop = () => {};

createRoot(document.getElementById('root')).render(
    <View style={{ backgroundColor: colors.surface.app, minHeight: ${HEIGHT} }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
            <View testID="case-root">
                {name === 'take-up'
                    ? <StandingTakeUp unit="week" beans_c={20000} title="Room at Rob's" payeeName="Rob" busy={false} onCancel={noop} onAgree={noop} now={Date.parse(START)} />
                    : <StandingPanel tx={c.tx} actingAs={c.side} busy={false} onStop={noop} onMessage={noop}
                        messageLabel={c.side === PAYER ? 'Message Rob' : 'Message Kim'}
                        onLower={async () => { if (c.refuse) throw new Error(c.refuse); }} />}
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
                return { contents: STUBS[args.path], loader: 'jsx', resolveDir: NATIVE };
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

// [case, what to tap first]
const CASES = [
    ['take-up', []],
    ['payer-card', []],
    ['payer-ask-sheet', ['standing-lower-link']],
    ['payer-ask-refused', ['standing-lower-link', 'standing-sheet-go']],
    ['payer-ask-open', []],
    ['payee-answer-sheet', ['standing-ask-answer']],
    ['payee-lower-sheet', ['standing-lower-link', 'standing-choice-other']],
    ['payee-grace-lower', []],
    ['payer-agreed', []],
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
            for (const id of taps) { await page.getByTestId(id).click(); await page.waitForTimeout(80); }
            if (name === 'payee-lower-sheet') await page.getByTestId('standing-other-amount').fill('250');
            await page.waitForTimeout(200);
            const m = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('[role="button"], button, [data-testid="standing-lower-link"]'));
                const buttons = els.map((b) => {
                    const r = b.getBoundingClientRect();
                    return { text: b.textContent, h: r.height, right: r.right, link: b.getAttribute('data-testid') === 'standing-lower-link' };
                });
                return {
                    wide: document.documentElement.scrollWidth, buttons,
                    refusal: document.querySelector('[data-testid="standing-sheet-refusal"]')?.textContent ?? null,
                    sheet: !!document.querySelector('[data-testid^="standing-sheet-"]'),
                };
            });
            check(m.wide <= WIDTH, `${look} ${name}: no sideways scroll (${m.wide} wide)`);
            for (const b of m.buttons) {
                check(b.h >= (b.link ? 48 : 44) - 0.5, `${look} ${name}: "${b.text}" is ${b.h.toFixed(1)}dp tall`);
                check(b.right <= WIDTH + 0.5, `${look} ${name}: "${b.text}" stays inside 320dp`);
            }
            if (name === 'payer-ask-refused') check(m.sheet && m.refusal === "You've asked about this week three times, which is the most.", `${look} ${name}: the refusal stays on the sheet`);
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
