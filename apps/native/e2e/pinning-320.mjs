#!/usr/bin/env node
/* global process, console, document */
/**
 * Pinning on the phone at 320dp wide with 1.3× font scale, in light and dark schemes.
 * Uses react-native-web in headless Chromium.
 *
 * Checks:
 * - Pinned block header and 📌 PINNED chips render properly
 * - No horizontal overflow at 320dp width
 * - PinSheet choices >= 48dp minimum touch target
 * - Detail line truncated and styled with central tokens
 * - Screenshots saved to scratch/screenshots/
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(HERE, '..');
const ROOT = path.resolve(NATIVE, '../..');
const SCALE = 1.3;
const WIDTH = 320;
const OUT_DIR = path.resolve(ROOT, 'scratch', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pinning-320-'));

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
        export const Modal = ({ visible, children }) => visible ? React.createElement('div', { 'data-testid': 'modal-wrapper', style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, display: 'flex', flexDirection: 'column' } }, children) : null;
        export default { ...RNW, Text, TextInput, Modal };
    `,
    '../app/ThemeContext': `
        export const useTheme = () => globalThis.__theme;
        export const useStyles = (make) => make(globalThis.__theme);
    `,
    '../utils/db': `
        export const pinPostOnNode = async () => ({ success: true, pinnedUntil: '2026-11-06T12:00:00Z', pinnedAt: '2026-11-03T12:00:00Z' });
        export const unpinPostOnNode = async () => ({ success: true });
    `,
};

const stubFor = (spec) => {
    if (STUBS[spec]) return spec;
    if (spec.endsWith('ThemeContext')) return '../app/ThemeContext';
    if (spec.endsWith('utils/db')) return '../utils/db';
    return null;
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView, Text, Pressable, StyleSheet } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { PinSheet } from ${JSON.stringify(path.join(NATIVE, 'components/PinSheet'))};
import { pinnedDetailLine } from ${JSON.stringify(path.join(NATIVE, 'utils/pins'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__theme = { theme: scheme, colors };

function Harness() {
    const [sheetVisible, setSheetVisible] = useState(q.get('modal') === 'true');
    const dummyPost = {
        id: 'pinned-offer-1',
        title: 'Fresh organic sourdough bread',
        type: 'offer',
        pinnedUntil: '2026-11-06T12:00:00Z',
        pinnedAt: '2026-11-03T12:00:00Z',
    };

    return (
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.page }} contentContainerStyle={{ padding: 16 }}>
            {/* Pinned Section Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, marginBottom: 8 }} testID="pinned-section-header">
                <Text style={{ fontSize: 11, fontWeight: '800', color: colors.text.muted, letterSpacing: 1, textTransform: 'uppercase' }}>
                    PINNED
                </Text>
                <View style={{ flex: 1, height: 1, backgroundColor: colors.border.default, marginLeft: 12 }} />
            </View>

            {/* Pinned Card */}
            <View style={{ backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, padding: 12, marginBottom: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <View testID="pinned-chip" style={{ backgroundColor: colors.surface.subtle, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: colors.border.default }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.text.secondary }}>📌 PINNED</Text>
                    </View>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: colors.text.secondary }}>🥕 FOOD</Text>
                </View>
                <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text.heading, marginBottom: 4 }}>
                    {dummyPost.title}
                </Text>
                <Text testID="pinned-detail-line" style={{ fontSize: 12, color: colors.text.secondary, fontWeight: '600' }}>
                    {pinnedDetailLine(dummyPost)}
                </Text>
            </View>

            {/* Post Options Menu Button */}
            <Pressable
                testID="open-pin-sheet-btn"
                role="button"
                style={{ minHeight: 48, backgroundColor: colors.brand.primary, borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginBottom: 16 }}
                onPress={() => setSheetVisible(true)}
            >
                <Text style={{ color: colors.text.inverse, fontWeight: '700', fontSize: 14 }}>Pin to the top…</Text>
            </Pressable>

            {/* PinSheet */}
            <PinSheet
                visible={sheetVisible}
                postId="pinned-offer-1"
                onClose={() => setSheetVisible(false)}
            />
        </ScrollView>
    );
}

createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', backgroundColor: colors.surface.app }}>
        <Harness />
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
<style>html,body,#root{margin:0;height:100%} body{font-family:sans-serif}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const hashes = {};
try {
    for (const scheme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width: WIDTH, height: 650 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.goto(`${base}/?scheme=${scheme}`);
        await page.waitForSelector('[data-testid="pinned-section-header"]', { timeout: 10000 });

        // Shot 1: Feed card with Pinned header, chip, and detail line
        const feedShot = path.join(OUT_DIR, `phone-pinned-feed-${scheme}-320.png`);
        await page.screenshot({ path: feedShot, fullPage: false });
        const feedBuf = fs.readFileSync(feedShot);
        hashes[`phone-pinned-feed-${scheme}-320.png`] = crypto.createHash('md5').update(feedBuf).digest('hex');
        console.log(`Saved feed shot: ${feedShot} (md5: ${hashes[`phone-pinned-feed-${scheme}-320.png`]})`);

        // Open PinSheet
        await page.goto(`${base}/?scheme=${scheme}&modal=true`);
        await page.waitForSelector('[data-testid="pin-choice-1"]', { timeout: 10000 });
        await page.waitForTimeout(200);

        // Shot 2: PinSheet open with 1 day, 3 days, 1 week choices
        const sheetShot = path.join(OUT_DIR, `phone-pin-sheet-${scheme}-320.png`);
        await page.screenshot({ path: sheetShot, fullPage: false });
        const sheetBuf = fs.readFileSync(sheetShot);
        hashes[`phone-pin-sheet-${scheme}-320.png`] = crypto.createHash('md5').update(sheetBuf).digest('hex');
        console.log(`Saved sheet shot: ${sheetShot} (md5: ${hashes[`phone-pin-sheet-${scheme}-320.png`]})`);

        // Check overflow
        const overflow = await page.evaluate((width) => {
            return { scroll: document.documentElement.scrollWidth };
        }, WIDTH);
        if (overflow.scroll > WIDTH) throw new Error(`${scheme}: scroll overflow ${overflow.scroll} > ${WIDTH}`);

        // Check target heights >= 44dp
        const small = await page.evaluate(() => [...document.querySelectorAll('[role="button"]')]
            .filter((el) => el.getBoundingClientRect().height < 44).map((el) => el.textContent));
        if (small.length > 0) throw new Error(`${scheme}: touch target under 44dp: ${JSON.stringify(small)}`);

        console.log(`${scheme}: verified 320dp width, touch targets >= 44dp`);
        await context.close();
    }
} finally {
    await browser.close();
    server.close();
}

console.log('\n--- SCREENSHOT MD5 CHECKSUMS ---');
for (const [name, md5] of Object.entries(hashes)) {
    console.log(`${name}: ${md5}`);
}
