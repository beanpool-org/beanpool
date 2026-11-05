#!/usr/bin/env node
/* global process, console, document, getComputedStyle, location */
/**
 * A member asks an admin to invite someone, on the phone at the floor (320dp wide, phone text at 1.3×), light and dark, in
 * English and German (long words): the app's own components/InviteAsks.tsx through react-native-web in headless Chromium,
 * in its own styles' sizes and colour tokens, over a fake node.
 *
 * Shots: the member's small button and what they've asked (a waiting ask, a code to pass on, a No with a reason), the
 * sheet, and an admin's ask with Send invite and No (where Needs you lands), and its reason field.
 * Checks: no sideways scroll; nothing past the 320dp edge; text whole; every button at least 44dp tall; text contrast at
 * least 4.5:1 (3:1 for large text).
 *
 *   node e2e/invite-asks-320.mjs --shots <dir>     # exits non-zero on any problem
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
const HEIGHT = 569;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-asks-320-'));

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
        export const Pressable = React.forwardRef(({ accessibilityState, ...p }, ref) => React.createElement(RNW.Pressable, { ...p, ref, 'aria-checked': accessibilityState?.checked }));
        export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o['android'] ?? o.default };
        export default { ...RNW, Text, TextInput, Pressable, Platform };
    `,
    'expo-router': `import { useEffect } from 'react'; export const useFocusEffect = (cb) => useEffect(() => cb(), [cb]);`,
    'expo-clipboard': `export const setStringAsync = async () => {};`,
    'react-native-safe-area-context': `export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });`,
    'react-native-keyboard-controller': `export const useKeyboardState = (pick) => pick({ height: 0, isVisible: false });`,
    '../app/ThemeContext': `
        import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
        const colors = () => (new URLSearchParams(location.search).get('scheme') === 'dark' ? darkColors : lightColors);
        export const useTheme = () => ({ colors: colors() });
        export const useStyles = (make) => make({ colors: colors() });
    `,
    '../utils/invite-asks': `
        const at = '2026-11-03T02:00:00.000Z';
        export const readMyAsks = async () => ({
            waiting: [{ id: 'w1', firstName: 'Saoirse', howKnown: 'She runs the bakery on Jonson Street and helps at the Saturday market', askedAt: at }],
            answers: [
                { id: 'n1', outcome: 'invited', state: 'ready', code: 'INV-K7QD-2MXA', askedAt: at, answeredAt: at },
                { id: 'n2', outcome: 'no', reason: 'We would like to meet them at a market day first', askedAt: at, answeredAt: at },
            ],
        });
        export const readAsksToAnswer = async () => [{ id: 'a1', firstName: 'Saoirse', howKnown: 'She runs the bakery on Jonson Street and helps at the Saturday market', askedAt: at, askerPubkey: 'm'.repeat(64), askerCallsign: 'Mel from the Byron co-op' }];
        const ok = async () => ({ ok: true });
        export const askAnAdmin = ok, takeBackAsk = ok, sendInviteForAsk = ok, sayNoToAsk = ok;
    `,
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { setLanguage, t } from '@beanpool/core';
import de from ${JSON.stringify(path.join(ROOT, 'packages/beanpool-core/words/de.json'))};
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { AskAnAdmin, InviteAsksToAnswer } from ${JSON.stringify(path.join(NATIVE, 'components/InviteAsks'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;
if (q.get('lang') === 'de') setLanguage('de', [de]);
const identity = { publicKey: 'k'.repeat(64), privateKey: 'aa', callsign: 'Mel' };

function Screen() {
    return (
        <View style={{ minHeight: '100vh', backgroundColor: colors.surface.page }}>
            <View style={{ padding: 16 }}>
                <View testID="screen">
                    {q.get('who') === 'admin'
                        ? <InviteAsksToAnswer anchorUrl="https://node.example" identity={identity} />
                        : <>
                            <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 }}>{t('📤 Bring someone here')}</Text>
                            <AskAnAdmin anchorUrl="https://node.example" identity={identity} onShare={() => {}} />
                        </>}
                </View>
            </View>
        </View>
    );
}
createRoot(document.getElementById('root')).render(<Screen />);
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
            b.onResolve({ filter: /.*/ }, (args) => (args.namespace !== 'stub' && STUBS[args.path] ? { path: args.path, namespace: 'stub' } : undefined));
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

const MEASURE = ({ WIDTH }) => {
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
        let under = { r: 255, g: 255, b: 255, a: 1 };
        for (const l of layers.reverse()) under = over(l, under);
        return under;
    };
    if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
    for (const el of document.querySelectorAll('div[dir], span')) {
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const what = el.textContent.trim().slice(0, 48);
        if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`"${what}" is cut on the right (${el.scrollWidth} > ${el.clientWidth})`);
        const cs = getComputedStyle(el);
        const fg = rgb(cs.color);
        if (!fg) continue;
        const under = backdrop(el);
        const [a, b] = [lum(over(fg, under)), lum(under)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) out.push(`"${what}" has contrast ${ratio.toFixed(2)}:1 (${size}px)`);
    }
    for (const el of document.querySelectorAll('[role="button"], [role="radio"], input')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > WIDTH + 0.5) out.push(`"${el.textContent.trim().slice(0, 40)}" runs past the edge (${Math.round(r.right)})`);
        if (el.scrollWidth > el.clientWidth + 1 && el.tagName !== 'INPUT') out.push(`the words of "${el.textContent.trim().slice(0, 40)}" spill out of it`);
        if (r.height < 43.5) out.push(`"${el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40)}" is ${Math.round(r.height)}dp tall`);
    }
    return out;
};

const browser = await chromium.launch();
const problems = [];
const shot = async (page, label) => {
    for (const p of await page.evaluate(MEASURE, { WIDTH })) problems.push(`${label}: ${p}`);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label}.png`), fullPage: true }); }
    console.log(`shot ${label}`);
};
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e}`));
    for (const lang of ['en', 'de']) {
        for (const scheme of ['light', 'dark']) {
            await page.goto(`${base}/?scheme=${scheme}&who=member&lang=${lang}`);
            await page.getByTestId('invite-ask-answer-n2').waitFor();
            await page.waitForTimeout(200);
            await shot(page, `ask-phone-mine-${lang}-${scheme}`);
            await page.getByTestId('invite-ask-open').click();
            await page.getByTestId('invite-ask-sheet').waitFor();
            await page.getByTestId('invite-ask-first-name').fill('Saoirse');
            await page.getByTestId('invite-ask-how-known').fill('She runs the bakery on Jonson Street');
            await page.waitForTimeout(200);
            await shot(page, `ask-phone-sheet-${lang}-${scheme}`);
            await page.goto(`${base}/?scheme=${scheme}&who=admin&lang=${lang}`);
            await page.getByTestId('invite-ask-a1').waitFor();
            await page.waitForTimeout(200);
            await shot(page, `ask-phone-answer-${lang}-${scheme}`);
            await page.getByTestId('invite-ask-no-a1').click();
            await page.getByTestId('invite-ask-reason-a1').fill('We would like to meet them first');
            await shot(page, `ask-phone-no-${lang}-${scheme}`);
        }
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}
if (problems.length) {
    console.log(problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
}
console.log('✓ the ask on the phone at 320dp with 1.3× text, en and de, light and dark: whole, inside the edge, 44dp targets, readable');
