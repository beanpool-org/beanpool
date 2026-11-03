#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * The phone's invite screen at the floor (320dp wide, phone text at 1.3×), in light and dark, for someone who can vouch and
 * a plain member: the app's own InviteVouchChoice through react-native-web in headless Chromium, between the heading, the
 * field and the button as app/(tabs)/people.tsx draws them, in its own styles' sizes and colour tokens.
 *
 * Checks: no sideways scroll; nothing past the 320dp edge; text whole; every target at least 44dp tall; text contrast at
 * least 4.5:1 (3:1 for large text); four radios named None, 25, 50 and 100 Beans with None on, and tapping one turns it on
 * alone; a plain member sees no radio; and in Tamil, the longest None, every choice still holds its words. Screenshots with
 * --shots <dir>.
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-vouch-320-'));

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
        // react-native reads accessibilityState; react-native-web drops it, so it is carried here as the web's own name.
        export const Pressable = React.forwardRef(({ accessibilityState, ...p }, ref) => React.createElement(RNW.Pressable, { ...p, ref, 'aria-checked': accessibilityState?.checked }));
        export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o['android'] ?? o.default };
        export default { ...RNW, Text, TextInput, Pressable, Platform };
    `,
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView, Text, TextInput, Pressable } from 'react-native';
import { setLanguage, t } from '@beanpool/core';
import ta from ${JSON.stringify(path.join(ROOT, 'packages/beanpool-core/words/ta.json'))};
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { InviteVouchChoice } from ${JSON.stringify(path.join(NATIVE, 'components/InviteVouchChoice'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;
if (q.get('lang') === 'ta') setLanguage('ta', [ta]);

function Screen() {
    const [level, setLevel] = useState(null);
    return (
        <View style={{ height: '100vh', backgroundColor: colors.surface.page }}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
                <View testID="invite-screen">
                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 }}>{t('📤 Invite Someone')}</Text>
                    <Text style={{ fontSize: 13, color: colors.text.secondary, marginBottom: 20, lineHeight: 18 }}>{t('Invite links are single-use and valid for 30 days. If you are offline, a cryptographic voucher ticket will be generated instead.')}</Text>
                    <TextInput
                        placeholder={t('Who is this invite for? (For your records)')}
                        placeholderTextColor={colors.text.muted}
                        style={{ backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, padding: 16, borderRadius: 12, fontSize: 15, fontWeight: '500', marginBottom: 16, color: colors.text.heading }}
                    />
                    {q.get('who') === 'voucher' && <InviteVouchChoice value={level} onChange={setLevel} colors={colors} />}
                    <Pressable accessibilityRole="button" style={{ backgroundColor: colors.brand.fill, padding: 16, borderRadius: 12, alignItems: 'center', marginBottom: 24 }}>
                        <Text style={{ color: colors.text.inverse, fontSize: 15, fontWeight: 'bold' }}>{t('✨ Generate Ticket')}</Text>
                    </Pressable>
                </View>
            </ScrollView>
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

const radios = () => [...document.querySelectorAll('[role="radio"]')].map((r) => `${r.getAttribute('aria-label')}${r.getAttribute('aria-checked') === 'true' ? ' (on)' : ''}`);

const browser = await chromium.launch();
const problems = [];
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e}`));

    for (const scheme of ['light', 'dark']) {
        for (const who of ['voucher', 'member']) {
            const label = `invite-phone-${who}-${scheme}`;
            await page.goto(`${base}/?scheme=${scheme}&who=${who}`);
            await page.getByTestId('invite-screen').waitFor();
            await page.waitForTimeout(250);
            const measure = () => page.evaluate(({ WIDTH }) => {
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
                    if (ratio < (large ? 3 : 4.5)) out.push(`"${what}" has contrast ${ratio.toFixed(2)}:1 (${cs.color} on rgb(${Math.round(under.r)},${Math.round(under.g)},${Math.round(under.b)}), ${size}px)`);
                }
                for (const el of document.querySelectorAll('[role="button"], [role="radio"]')) {
                    const r = el.getBoundingClientRect();
                    if (el.scrollWidth > el.clientWidth) out.push(`the words of "${el.textContent.trim().slice(0, 40)}" spill out of it (${el.scrollWidth} > ${el.clientWidth})`);
                    if (r.height < 43.5) out.push(`"${el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40)}" is ${Math.round(r.height)}dp tall`);
                }
                return out;
            }, { WIDTH });
            const found = await measure();
            for (const p of found) problems.push(`${label}: ${p}`);
            const shown = await page.evaluate(radios);
            if (who === 'voucher') {
                if (shown.join() !== 'None (on),25 Beans,50 Beans,100 Beans') problems.push(`${label}: choices read ${shown.join(', ')}`);
                if (await page.locator('[role="radiogroup"][aria-label="Vouch for them"]').count() !== 1) problems.push(`${label}: no group named Vouch for them`);
            } else if (shown.length) problems.push(`${label}: a plain member sees the control`);
            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await page.screenshot({ path: path.join(SHOTS, `${label}.png`) });
            }
            if (who === 'voucher') {
                await page.getByTestId('invite-vouch-2').click();
                await page.waitForTimeout(100);
                const after = await page.evaluate(radios);
                if (after.join() !== 'None,25 Beans,50 Beans (on),100 Beans') problems.push(`${label}: after a tap on 50 the choices read ${after.join(', ')}`);
                for (const p of await measure()) problems.push(`${label} (50 on): ${p}`);
                if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${label}-50-on.png`) });
            }
            console.log(`${found.length ? '✗' : '✓'} ${label}: ${shown.join(', ') || 'no control'}`);
        }
        // Tamil, the longest None: the same row has to hold it, wrapping if it must.
        const label = `invite-phone-voucher-ta-${scheme}`;
        await page.goto(`${base}/?scheme=${scheme}&who=voucher&lang=ta`);
        await page.getByTestId('invite-screen').waitFor();
        await page.waitForTimeout(250);
        const fit = await page.evaluate(({ WIDTH }) => {
            const out = [];
            for (const el of document.querySelectorAll('[role="radio"]')) {
                const r = el.getBoundingClientRect();
                if (r.right > WIDTH + 0.5) out.push(`"${el.textContent.trim()}" runs past the edge (${Math.round(r.right)})`);
                if (r.height < 43.5) out.push(`"${el.textContent.trim()}" is ${Math.round(r.height)}dp tall`);
                if (el.scrollWidth > el.clientWidth) out.push(`the words of "${el.textContent.trim()}" spill out of it (${el.scrollWidth} > ${el.clientWidth})`);
            }
            return out;
        }, { WIDTH });
        for (const p of fit) problems.push(`${label}: ${p}`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${label}.png`) });
        console.log(`${fit.length ? '✗' : '✓'} ${label}: ${(await page.evaluate(radios)).join(', ')}`);
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
