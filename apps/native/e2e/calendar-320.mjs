#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * The phone calendar screen (apps/native/app/calendar.tsx; DESIGN-map-calendar-fable.md §1, §4, §8 S2),
 * at the floor: 320 dp wide with text at 1.3×, light and dark, drawn through react-native-web in headless Chromium.
 * Reports anything past the screen's edge, a button under 44 dp, or a row whose words are cut by their own box.
 *
 *   node apps/native/e2e/calendar-320.mjs --shots <dir>
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
const WIDTH = 320;
const HEIGHT = 568;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-320-'));

const shim = path.join(work, 'rn-shim.js');
fs.writeFileSync(shim, `
import * as RNW from 'react-native-web';
import { createElement, forwardRef } from 'react';
export * from 'react-native-web';
const SCALE = 1.3;
export const Text = forwardRef((props, ref) => {
    const s = RNW.StyleSheet.flatten(props.style) || {};
    const style = { ...s, fontSize: (s.fontSize || 14) * SCALE, ...(s.lineHeight ? { lineHeight: s.lineHeight * SCALE } : {}) };
    return createElement(RNW.Text, { ...props, style, ref });
});
`);

const STUBS = {
    '../app/ThemeContext': `
        import { darkColors, lightColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
        const dark = new URLSearchParams(location.search).get('scheme') === 'dark';
        const value = { theme: dark ? 'dark' : 'light', colors: dark ? darkColors : lightColors };
        export const useTheme = () => value;
        export const useStyles = (make) => make(value);`,
    './ThemeContext': `
        import { darkColors, lightColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
        const dark = new URLSearchParams(location.search).get('scheme') === 'dark';
        const value = { theme: dark ? 'dark' : 'light', colors: dark ? darkColors : lightColors };
        export const useTheme = () => value;
        export const useStyles = (make) => make(value);`,
    'expo-image': `
        import { createElement } from 'react';
        import { Image as RNImage } from 'react-native';
        export const Image = ({ source, style }) => createElement(RNImage, { source, style });`,
    '../utils/photo-refresh': 'export const refreshListingAfterPhotoError = () => {};',
    'expo-router': `
        export const useRouter = () => ({
            back: () => {},
            push: () => {},
            replace: () => {},
            canGoBack: () => true,
        });`,
    'react-native-safe-area-context': `
        export const useSafeAreaInsets = () => ({ top: 12, bottom: 12, left: 0, right: 0 });
        export const SafeAreaView = ({ children, style }) => children;`,
    'expo-modules-core': `
        export const requireNativeModule = () => ({});
        export const requireOptionalNativeModule = () => null;
        export const EventEmitter = function() { return { addListener: () => {}, removeListener: () => {} }; };
        export const NativeModulesProxy = {};
        export const ProxyNativeModule = {};`,
    '@react-native-async-storage/async-storage': `
        export default { getItem: async () => null, setItem: async () => null };`,
    '../utils/db': `
        const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#7fb069"/><circle cx="40" cy="40" r="20" fill="#f4d35e"/></svg>');
        const mockEvents = [
            {
                id: 'ev-1',
                type: 'event',
                status: 'active',
                active: 1,
                title: 'Working bee at the hall',
                category: 'community',
                event_start_local: '2026-11-07T09:00',
                event_end_local: '2026-11-07T12:00',
                event_start_at: '2026-11-07T09:00:00.000Z',
                event_end_at: '2026-11-07T12:00:00.000Z',
                photos: [photo],
            },
            {
                id: 'ev-2',
                type: 'event',
                status: 'active',
                active: 1,
                title: 'Repair café',
                category: 'community',
                event_start_local: '2026-11-07T14:00',
                event_end_local: '2026-11-07T16:00',
                event_start_at: '2026-11-07T14:00:00.000Z',
                event_end_at: '2026-11-07T16:00:00.000Z',
                shown_from: JSON.stringify({ host: 'mullum.example.org', name: 'Mullumbimby', url: 'https://mullum.example.org' }),
                event_repeat: JSON.stringify({ freq: 'weekly', interval: 1, byDay: 'SA' }),
                photos: [photo],
            },
            {
                id: 'ev-3',
                type: 'event',
                status: 'active',
                active: 1,
                title: 'Seed swap',
                category: 'community',
                event_start_local: '2026-11-14T10:00',
                event_end_local: '2026-11-14T12:00',
                event_start_at: '2026-11-14T10:00:00.000Z',
                event_end_at: '2026-11-14T12:00:00.000Z',
            },
        ];
        export const getPosts = async () => mockEvents;`,
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import CalendarScreen from ${JSON.stringify(path.join(NATIVE, 'app/calendar'))};

const dark = new URLSearchParams(location.search).get('scheme') === 'dark';

createRoot(document.getElementById('root')).render(
    <View style={{ width: ${WIDTH}, height: ${HEIGHT}, backgroundColor: dark ? '#111827' : '#faf9f6', overflow: 'hidden' }}>
        <CalendarScreen />
    </View>,
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
    alias: { 'react-native': shim },
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"', global: 'globalThis' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {} };' },
    logLevel: 'error',
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => (STUBS[args.path] && args.namespace !== 'stub' ? { path: args.path, namespace: 'stub' } : undefined));
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js', resolveDir: NATIVE }));
        },
    }],
});
const bundle = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<style>html,body{margin:0;padding:0} body{font-family:sans-serif}</style></head>
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
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1.5 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    for (const scheme of ['light', 'dark']) {
        await page.goto(`${base}/?scheme=${scheme}`);
        await page.waitForSelector('[data-testid="month-grid"]', { timeout: 15000 }).catch((e) => {
            throw new Error(`${e.message}\npage errors: ${errors.join('\n') || 'none'}`);
        });
        // Give time for async posts to load into replica view
        await page.waitForTimeout(300);

        const found = await page.evaluate((WIDTH) => {
            const out = [];
            if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);

            // Check buttons
            for (const el of document.querySelectorAll('[role="button"]')) {
                const r = el.getBoundingClientRect();
                // If button is displayed and visible
                if (r.width > 0 && r.height > 0) {
                    if (r.height < 43.5) out.push(`a button is ${Math.round(r.height * 10) / 10}px tall: ${el.getAttribute('aria-label') || el.textContent}`);
                    if (r.right > WIDTH + 0.5) out.push(`a button runs past the edge: ${el.getAttribute('aria-label') || el.textContent}`);
                }
            }

            // Check text elements
            for (const el of document.querySelectorAll('[dir="auto"]')) {
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                if (r.right > WIDTH + 0.5) out.push(`words past the edge: ${el.textContent}`);
                const cutsOnPurpose = s.webkitLineClamp !== 'none' || s.textOverflow === 'ellipsis';
                if (!cutsOnPurpose && el.scrollWidth > el.clientWidth + 1) out.push(`words cut: ${el.textContent}`);
            }

            const monthHeading = document.querySelector('[data-testid="month-heading"]')?.textContent || '';
            const stackPanel = document.querySelector('[data-testid="map-stack-list"]');
            const stackHeading = stackPanel?.querySelector('[role="heading"]')?.textContent || '';
            const dayButtons = document.querySelectorAll('[data-testid^="month-day-"]').length;
            const stackRows = stackPanel?.querySelectorAll('[role="button"]').length ? stackPanel.querySelectorAll('[role="button"]').length - 1 : 0;

            return { out, monthHeading, stackHeading, dayButtons, stackRows };
        }, WIDTH);

        problems.push(...found.out.map((p) => `${scheme}: ${p}`));
        console.log(`${scheme}: "${found.monthHeading}", "${found.stackHeading}", ${found.dayButtons} days, ${found.stackRows} rows`);

        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `calendar-320-${scheme}.png`) });
        }
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('calendar-320: nothing past the edge, every button 44 dp, no words cut');
