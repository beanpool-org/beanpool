#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Front doors S9 at the floor (memory product-audience-small-screens: 320dp wide, the phone's text at 1.3×), light and
 * dark, rendered for real through react-native-web in headless Chromium: Restore your account's five rows
 * (components/welcome/RestoreMenu.tsx, in welcome's 24dp page and card) and Scan from a browser
 * (components/PairInView.tsx, in app/pair-in.tsx's 16dp page) at each step: start, a camera-app link's Continue, the four
 * digits, whose account it is, and a refusal.
 *
 * Its own small harness, with only these two components' stubs: ways-back-320.mjs, which drew the restore rows, no longer
 * bundles on main (its stubs predate imports that components it draws have since gained).
 *
 * Each state fails on: the page scrolling sideways; text past the 320 edge or clipped; a button under 44dp; text under
 * 4.5:1 contrast with what it is drawn on (3:1 from 18.66px bold or 24px). Emoji alone are not counted. Nothing leaves
 * the machine: every request but the page's own is aborted.
 *
 *   node apps/native/e2e/pair-in-320.mjs [--shots <dir>]
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-in-320-'));

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
        export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o.android ?? o.default };
        export default { ...RNW, Text, Platform };
    `,
    'ThemeContext': `export const useStyles = (make) => make({ colors: globalThis.__colors, theme: globalThis.__scheme });`,
    '@react-native-async-storage/async-storage': `export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };`,
};
const stubFor = (spec) => (STUBS[spec] ? spec : spec.startsWith('.') && path.basename(spec) === 'ThemeContext' ? 'ThemeContext' : null);

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { t } from '@beanpool/core';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { RestoreMenu } from ${JSON.stringify(path.join(NATIVE, 'components/welcome/RestoreMenu'))};
import { PairInView } from ${JSON.stringify(path.join(NATIVE, 'components/PairInView'))};
import { onboardingColors } from ${JSON.stringify(path.join(NATIVE, 'utils/onboarding-colors'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__colors = colors;
globalThis.__scheme = scheme;
document.body.style.background = colors.surface.page;
const noop = () => {};
const QR = { sessionId: 'a1'.repeat(16), browserPubHex: 'b2'.repeat(32), nodeUrl: 'https://mullumbimby.beanpool.org' };
const step = (s) => s === 'ask' ? { kind: 'ask', qr: QR }
    : s === 'digits' ? { kind: 'digits', qr: QR, code: '0427', sending: false }
    : s === 'confirm' ? { kind: 'confirm', qr: QR, account: { publicKey: '', words: [], callsign: 'Samantha-Jane Wolfenden' } }
    : s === 'refused' ? { kind: 'refused', text: t('Another phone has already scanned this code, so nothing was sent. Make a new code in your browser.') }
    : { kind: 'start' };

const Restore = () => {
    const { colors: oc, dark } = onboardingColors(scheme);
    return (
        <View style={{ backgroundColor: oc.surface.page, padding: 24 }}>
            <View style={{ width: '100%', backgroundColor: oc.surface.card, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: oc.border.default }}>
                <Text style={{ fontSize: 20, fontWeight: 'bold', color: oc.text.heading, marginBottom: 8 }}>{t('🔑 Restore your account')}</Text>
                <RestoreMenu colors={oc} dark={dark} logos={<View style={{ width: 48, height: 16 }} />} onSocial={noop} onWords={noop} onCommunity={noop} onRekey={noop} onBrowser={noop} />
            </View>
        </View>
    );
};
const PairIn = () => (
    <View style={{ backgroundColor: colors.surface.page, padding: 16 }}>
        <PairInView step={step(q.get('step'))} canRetry onScan={noop} onContinue={noop} onBring={noop} onAgain={noop} onCancel={noop} />
    </View>
);
createRoot(document.getElementById('root')).render(q.get('place') === 'restore' ? <Restore /> : <PairIn />);
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
    banner: { js: 'globalThis.process = globalThis.process || { env: {} };' },
    logLevel: 'error',
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
                if (args.namespace === 'stub') return undefined;
                const name = stubFor(args.path);
                return name ? { path: name, namespace: 'stub' } : undefined;
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
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 640 }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const measure = async (label) => {
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
            const texts = [...document.querySelectorAll('div[dir], span')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = el.textContent.trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
                if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`"${what}" is cut on the right`);
                if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') out.push(`"${what}" is cut at the bottom`);
                const cs = getComputedStyle(el);
                const fg = rgb(cs.color);
                if (!fg || /^[\p{Extended_Pictographic}️\s]+$/u.test(el.textContent)) continue;
                const bg = backdrop(el);
                const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
                const ratio = (a + 0.05) / (b + 0.05);
                const size = parseFloat(cs.fontSize);
                const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                if (ratio < (large ? 3 : 4.5)) out.push(`"${what}" has contrast ${ratio.toFixed(2)}:1`);
            }
            for (const el of document.querySelectorAll('[role="button"]')) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height < 43.5) out.push(`the button "${el.textContent.trim().slice(0, 40)}" is ${Math.round(r.height)}dp tall`);
            }
            return out;
        }, { WIDTH });
        for (const p of found) problems.push(`${label}: ${p}`);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true }); }
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.join('; ')}` : ''}`);
    };
    for (const scheme of ['light', 'dark']) {
        await page.goto(`${base}/?place=restore&scheme=${scheme}`);
        await page.getByText('Scan from a browser').first().waitFor();
        if ((await page.getByRole('button').count()) !== 5) problems.push(`${scheme} · Restore your account: not five rows`);
        await measure(`${scheme} · Restore your account, five rows`);
        for (const s of ['start', 'ask', 'digits', 'confirm', 'refused']) {
            await page.goto(`${base}/?step=${s}&scheme=${scheme}`);
            await page.getByText('Scan from a browser').first().waitFor();
            await measure(`${scheme} · Scan from a browser, ${s}`);
        }
    }
    for (const e of errors) problems.push(`page error: ${e}`);
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}
console.log(problems.length ? `\n✗ ${problems.length} problem(s)` : '\n✓ every state holds at 320dp with text at 1.3×, light and dark');
process.exit(problems.length ? 1 : 0);
