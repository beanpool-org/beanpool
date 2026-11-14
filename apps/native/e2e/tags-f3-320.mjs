#!/usr/bin/env node
/* global process, console, document */
/**
 * The phone's Tags field with this community's typed tags (DESIGN-tags-free-entry-fable.md §3, slice F3), at 320dp wide with
 * 1.3× font scale, in light and dark schemes, in react-native-web in headless Chromium. The community's list is fed in (the
 * picker's communityTags): nothing here talks to a node.
 *
 * Checks: the "Tags used here" rows under the library's matches, a merged tag shown as its library tag, nothing past 320dp,
 * every target 44dp or more. Screenshots to $SHOTS_DIR (default scratch/screenshots/).
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
const OUT_DIR = process.env.SHOTS_DIR || path.resolve(ROOT, 'scratch', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tags-f3-320-'));

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
    '../utils/community-tags': `
        export const loadCommunityTags = async () => [];
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
    if (spec.endsWith('utils/community-tags')) return '../utils/community-tags';
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
    const [tags, setTags] = useState(['garden.produce']);
    const [freeTags, setFreeTags] = useState(['2nd hand']);
    const used = [
        { tag: 'handmade', listings: 12 }, { tag: 'hand tools', listings: 3 }, { tag: 'handed down from my grandmother', listings: 1 },
        { tag: 'limones', listings: 0, mergeInto: 'food.fruit.lemon' },
    ];
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
                    communityTags={() => Promise.resolve(used)}
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

        await page.getByRole('button', { name: /\+ Add/i }).click();
        await page.waitForSelector('[data-testid="tag-picker-sheet"]', { timeout: 5000 });
        const searchInput = page.getByPlaceholder(/Search tags/i);
        await searchInput.fill('han');
        await page.getByTestId('tag-picker-used-here').waitFor({ timeout: 3000 });
        await page.waitForTimeout(200);
        const usedShot = path.join(OUT_DIR, `phone-tags-used-here-${scheme}-320.png`);
        await page.screenshot({ path: usedShot, fullPage: false });
        console.log(`Saved: ${usedShot}`);
        await searchInput.fill('lim');
        await page.getByText('#limones').waitFor({ timeout: 3000 });
        await page.waitForTimeout(200);
        const mergedShot = path.join(OUT_DIR, `phone-tags-used-here-merged-${scheme}-320.png`);
        await page.screenshot({ path: mergedShot, fullPage: false });
        console.log(`Saved: ${mergedShot}`);
        await searchInput.fill('han');
        await page.getByTestId('tag-picker-used-here').waitFor({ timeout: 3000 });

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
