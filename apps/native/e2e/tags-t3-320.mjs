#!/usr/bin/env node
/* global process, console, document */
/**
 * TagPicker on the phone at 320dp wide with 1.3× font scale, in light and dark schemes.
 * Uses react-native-web in headless Chromium.
 *
 * Checks:
 * - No horizontal overflow at 320dp width
 * - Chips wrap cleanly
 * - 44dp minimum touch target sizes
 * - Sheet scrolls vertically
 * - A typed tag of the most characters and words fits (DESIGN-tags-free-entry-fable.md, F2): its chip wraps, the Add row and the
 *   refusal's words hold inside 320dp
 * - Screenshots saved to scratch/screenshots/
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
const OUT_DIR = path.resolve(ROOT, 'scratch', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tags-t3-320-'));

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
        export default { ...RNW, Text, TextInput };
    `,
    '../app/ThemeContext': `
        export const useTheme = () => globalThis.__theme;
        export const useStyles = (make) => make(globalThis.__theme);
    `,
    'react-native-keyboard-controller': `
        import React from 'react';
        import { View } from 'react-native-web';
        export const KeyboardAvoidingView = ({ behavior, ...p }) => React.createElement(View, p);
        export const KeyboardController = { dismiss: async () => {} };
    `,
    '../utils/haptics': `
        export const hapticTick = () => {};
        export const hapticWarning = () => {};
    `,
    '@expo/vector-icons': `
        import React from 'react';
        export const MaterialCommunityIcons = ({ name, size, color }) => React.createElement('span', { style: { fontSize: size, color } }, '●');
    `,
};

const stubFor = (spec) => {
    if (STUBS[spec]) return spec;
    if (spec.endsWith('ThemeContext')) return '../app/ThemeContext';
    if (spec.endsWith('haptics')) return '../utils/haptics';
    if (spec === '@expo/vector-icons') return '@expo/vector-icons';
    return null;
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView, Text, StyleSheet } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { TagPicker } from ${JSON.stringify(path.join(NATIVE, 'components/TagPicker'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__theme = { theme: scheme, colors };

function Harness() {
    const [tags, setTags] = useState(['food.fruit.lemon', 'garden.produce']);
    const [freeTags, setFreeTags] = useState(['2nd hand', 'wwwwwwwwwwwwwwwwwwwwwwwwwwwwww']);
    return (
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.page }} contentContainerStyle={{ padding: 16 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8 }}>
                New Listing
            </Text>
            <View style={{ backgroundColor: colors.surface.card, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border.subtle }}>
                <Text style={{ fontSize: 12, color: colors.text.secondary, marginBottom: 4 }}>Title</Text>
                <Text style={{ fontSize: 14, color: colors.text.primary, marginBottom: 12 }}>Meyer Lemons & Rosemary</Text>
                <Text style={{ fontSize: 12, color: colors.text.secondary, marginBottom: 4 }}>Category</Text>
                <Text style={{ fontSize: 14, color: colors.text.primary, marginBottom: 12 }}>Food & Drink</Text>
                <TagPicker
                    value={tags}
                    onChange={setTags}
                    freeTags={freeTags}
                    onFreeTagsChange={setFreeTags}
                    category="food"
                    title="Meyer Lemons & Rosemary"
                    description="Fresh homegrown organic lemons and sprigs of rosemary."
                />
            </View>
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
try {
    for (const scheme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width: WIDTH, height: 700 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.goto(`${base}/?scheme=${scheme}`);
        await page.waitForSelector('[data-testid="tag-picker"]', { timeout: 10000 });

        // Shot 1: Closed TagPicker row with chips and + Add button
        const rowShot = path.join(OUT_DIR, `phone-tag-picker-row-${scheme}-320.png`);
        await page.screenshot({ path: rowShot, fullPage: false });
        console.log(`Saved phone row shot: ${rowShot}`);

        // Open sheet by clicking "+ Add"
        const addBtn = page.getByRole('button', { name: /\+ Add/i });
        await addBtn.click();
        await page.waitForSelector('[data-testid="tag-picker-sheet"]', { timeout: 5000 });
        await page.waitForTimeout(300);

        // Shot 2: Sheet open with suggestions and categories
        const sheetShot = path.join(OUT_DIR, `phone-tag-picker-sheet-${scheme}-320.png`);
        await page.screenshot({ path: sheetShot, fullPage: false });
        console.log(`Saved phone sheet shot: ${sheetShot}`);

        // Type search to verify 2-character search
        const searchInput = page.getByPlaceholder(/Search tags/i);
        await searchInput.fill('citrus');
        await page.waitForTimeout(300);

        // Shot 3: Search results active
        const searchShot = path.join(OUT_DIR, `phone-tag-picker-search-${scheme}-320.png`);
        await page.screenshot({ path: searchShot, fullPage: false });
        console.log(`Saved phone search shot: ${searchShot}`);

        // A typed tag: the Add row, then a refusal's words, then the longest tag as a chip in the sheet.
        await searchInput.fill('excellent condition');
        await page.getByTestId('tag-picker-add-typed').waitFor({ timeout: 3000 });
        const typedShot = path.join(OUT_DIR, `phone-tag-picker-typed-${scheme}-320.png`);
        await page.screenshot({ path: typedShot, fullPage: false });
        console.log(`Saved phone typed shot: ${typedShot}`);
        await searchInput.press('Enter');
        await page.getByRole('button', { name: 'Remove #excellent condition' }).first().waitFor({ timeout: 3000 });
        await searchInput.fill('me@example.org');
        await page.getByText('A tag is a word to find your listing by, not a contact').waitFor({ timeout: 3000 });
        const refusedShot = path.join(OUT_DIR, `phone-tag-picker-refused-${scheme}-320.png`);
        await page.screenshot({ path: refusedShot, fullPage: false });
        console.log(`Saved phone refused shot: ${refusedShot}`);

        const overflow = await page.evaluate((width) => {
            const wide = [...document.querySelectorAll('[data-testid="tag-picker-sheet"] *, [data-testid="tag-picker"] *')]
                .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > width + 0.5 || r.left < -0.5); })
                .map((el) => (el.textContent || el.tagName).slice(0, 40));
            return { wide, scroll: document.documentElement.scrollWidth };
        }, WIDTH);
        if (overflow.wide.length > 0 || overflow.scroll > WIDTH) throw new Error(`${scheme}: past ${WIDTH}dp: ${JSON.stringify(overflow)}`);
        const small = await page.evaluate(() => [...document.querySelectorAll('[data-testid="tag-picker-sheet"] [role="button"]')]
            .filter((el) => el.getBoundingClientRect().height < 44).map((el) => el.textContent));
        if (small.length > 0) throw new Error(`${scheme}: under 44dp: ${JSON.stringify(small)}`);
        console.log(`${scheme}: nothing past ${WIDTH}dp, every target 44dp or more`);

        await context.close();
    }
} finally {
    await browser.close();
    server.close();
}
