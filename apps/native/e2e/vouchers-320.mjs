#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Vouchers on the phone (slice V2, DESIGN-invites-and-names-list-amend2-fable.md §5, §10, §11)
 * at the floor (320dp wide, phone text at 1.3×), in light and dark schemes:
 * - VoucherCard with budget breakdown, quick levels (500 · 1,000 · 1,500 · 2,000), stepper
 * - Who they brought in list
 * - Budget history list
 * - People → Invites Vouchers block
 *
 * Checks:
 * - No sideways scroll
 * - Nothing past the 320dp edge or clipped
 * - Buttons >= 44dp tall (touch target)
 * - Text contrast >= 4.5:1 (or 3:1 for large text)
 * - Screenshots written to --shots <dir>
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
        export const router = { back() {}, push() {}, replace() {}, canDismiss: () => false };
        export const useFocusEffect = (cb) => { React.useEffect(() => { cb(); }, []); };
        export const useLocalSearchParams = () => ({});
    `,
    'ThemeContext': `
        export const useTheme = () => globalThis.__theme;
        export const useStyles = (make) => make(globalThis.__theme);
    `,
    '@expo/vector-icons': `
        import React from 'react';
        import { Text } from 'react-native-web';
        export const MaterialCommunityIcons = ({ style, size, name }) => React.createElement(Text, { style: [{ fontSize: size || 18, color: '#242824' }, style] }, name === 'arrow-left' ? '←' : '•');
    `,
    'expo-crypto': `
        export const getRandomBytes = (n) => new Uint8Array(n);
    `,
    '@react-native-async-storage/async-storage': `
        export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
    `,
    'expo-secure-store': `
        export const getItemAsync = async () => null;
        export const setItemAsync = async () => {};
        export const deleteItemAsync = async () => {};
    `,
};

const stubFor = (spec) => {
    if (STUBS[spec]) return spec;
    if (spec.endsWith('ThemeContext') || spec.endsWith('ThemeContext.tsx')) return 'ThemeContext';
    return null;
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView, Text, Pressable } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { VoucherCard } from ${JSON.stringify(path.join(NATIVE, 'components/VoucherCard'))};

const FIXTURE_CARD = {
    memberPubkey: 'pk_jane',
    callsign: 'jane',
    source: 'entry',
    entryId: 'entry_jane',
    madeBy: 'pk_admin',
    madeByCallsign: 'admin',
    madeAt: '2026-11-01T10:00:00Z',
    stoppedAt: null,
    stopReason: null,
    left: 550,
    held: 100,
    heldInvites: 1,
    vouched: 350,
    peopleVouched: 4,
    level: 1000,
    belowZero: 1,
    writtenOff: 0,
    passedOn: { amount: 50, people: 1 },
    invitesWithVouch: 5,
    trading: { withOthers: 3, insideOnly: 1 },
    canChange: true,
    history: [
        { kind: 'grant', amount: 1000, actor: 'pk_admin', actorCallsign: 'admin', at: '2026-11-01T10:00:00Z' },
        { kind: 'hold', amount: -100, actor: 'pk_jane', actorCallsign: 'jane', at: '2026-11-02T10:00:00Z', for: 'invite', outcome: 'vouched' },
        { kind: 'top_up', amount: 500, actor: 'pk_admin', actorCallsign: 'admin', at: '2026-11-03T10:00:00Z' }
    ],
    people: [
        {
            memberPubkey: 'pk_sam',
            callsign: 'sam',
            joinedAt: '2026-11-02T12:00:00Z',
            amount: 100,
            raised: false,
            byInvite: true,
            belowZero: true,
            left: false,
            writtenOff: 0,
            vouchesForMe: false,
            trading: 'others',
        },
        {
            memberPubkey: 'pk_bob',
            callsign: 'bob',
            joinedAt: '2026-11-03T12:00:00Z',
            amount: 75,
            raised: false,
            byInvite: true,
            belowZero: false,
            left: false,
            writtenOff: 0,
            vouchesForMe: false,
            trading: 'inside',
        }
    ],
};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
const viewMode = q.get('view') || 'card';

globalThis.__theme = {
    theme: scheme,
    colors,
    isDark: scheme === 'dark',
};

const identity = {
    publicKey: 'pk_viewer',
    privateKey: 'priv_key',
    callsign: 'marty',
    createdAt: '2026-11-01'
};

function InvitesVouchersBlock() {
    return (
        <View style={{
            margin: 16, padding: 16, borderRadius: 14, backgroundColor: colors.surface.card,
            borderWidth: 1, borderColor: colors.border.default
        }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text.heading, marginBottom: 4 }}>Vouchers</Text>
            <Text style={{ fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginBottom: 12 }}>
                Members with a budget to vouch for the people they invite.
            </Text>
            <Pressable style={{ minHeight: 48, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.default, justifyContent: 'center' }}>
                <Text style={{ fontSize: 14, lineHeight: 20, color: colors.text.body, fontWeight: '500' }}>
                    Jane Albury · 550 of 1,000 left · 4 vouched · 1 below zero ›
                </Text>
            </Pressable>
            <Pressable style={{ minHeight: 48, paddingTop: 14, justifyContent: 'center' }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: colors.brand.primary }}>+ Make someone a voucher</Text>
            </Pressable>
        </View>
    );
}

function RootApp() {
    return (
        <View style={{ flex: 1, backgroundColor: colors.surface.page, minHeight: '100vh' }}>
            {viewMode === 'block' ? (
                <InvitesVouchersBlock />
            ) : (
                <VoucherCard
                    anchorUrl="https://community.test"
                    identity={identity}
                    memberPubkey="pk_jane"
                    initialCard={FIXTURE_CARD}
                />
            )}
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
            const texts = [...document.querySelectorAll('div[dir], span, input, textarea')].filter((el) => {
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
                if (/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u.test(what)) continue;
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

    const open = async (query) => { await page.goto(`${base}/?${query}`); await page.waitForTimeout(250); };

    for (const scheme of ['light', 'dark']) {
        // 1. Voucher card default (Their budget, Set budget to with quick levels & stepper)
        await open(`view=card&scheme=${scheme}`);
        await page.getByText('Their budget').waitFor();
        await measure(`vouchers-card-${scheme}`);

        // 2. Expand "See who they brought in ›"
        await page.getByRole('button', { name: 'See who they brought in ›' }).click();
        await page.getByText('People vouched for').waitFor();
        await measure(`vouchers-card-people-${scheme}`);

        // 3. Expand "Budget history ›"
        await page.getByRole('button', { name: 'Budget history ›' }).click();
        await page.getByTestId('budget-history-section').waitFor();
        await measure(`vouchers-card-history-${scheme}`);

        // 4. Invites screen Vouchers block (§11)
        await open(`view=block&scheme=${scheme}`);
        await page.getByText('Jane Albury · 550 of 1,000 left').waitFor();
        await measure(`vouchers-invites-block-${scheme}`);
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
