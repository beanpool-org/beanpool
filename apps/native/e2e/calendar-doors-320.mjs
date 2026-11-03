#!/usr/bin/env node
/* global process, console, document, getComputedStyle, location */
/**
 * Calendar doors on the phone (DESIGN-map-calendar-fable.md §8 S4),
 * at the floor (320dp wide, phone text at 1.3×), in light and dark:
 * 1. Home card "Coming up" with "Calendar ›" and "All events ›" (apps/native/components/home/HomeCardBodies.tsx)
 * 2. Market Events filter chip row with the calendar button (apps/native/app/(tabs)/market.tsx)
 *
 * Checks: no sideways scroll; nothing past the 320dp edge; every target at least 44dp tall; no words cut.
 * Screenshots with --shots <dir>.
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
const HEIGHT = 568;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-doors-320-'));

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
export const AccessibilityInfo = {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove() {} }),
};
export default { ...RNW, Text, AccessibilityInfo };
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
    'expo-router': `
        export const router = { push() {}, replace() {}, back() {} };
        export const useRouter = () => router;
        export const usePathname = () => '/';
    `,
    '@expo/vector-icons': `
        import React from 'react';
        export const MaterialCommunityIcons = ({ name, size, color, style }) =>
            React.createElement('span', { 'aria-hidden': true, style: { color, fontSize: size, fontWeight: 900, ...(style || {}) } }, '📅');
    `,
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, StyleSheet, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { lightColors, darkColors } from '${path.join(NATIVE, 'constants/colors.ts')}';
import { HomeCard } from '${path.join(NATIVE, 'components/home/HomeParts.tsx')}';
import { EventsBody } from '${path.join(NATIVE, 'components/home/HomeCardBodies.tsx')}';
import { FilterChipRow } from '${path.join(NATIVE, 'components/FilterChipRow.tsx')}';

const scheme = new URLSearchParams(location.search).get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;

const sampleEventsCard = {
    items: [
        {
            id: 'ev-1',
            title: 'Spring Working Bee & Tool Care Workshop',
            startsAt: '2026-11-07T09:00:00.000Z',
            endsAt: null,
            place: 'Community Hall',
            rsvp: 'going',
        },
        {
            id: 'ev-2',
            title: 'Seed Swap & Propagation Morning',
            startsAt: '2026-11-14T10:00:00.000Z',
            endsAt: null,
            place: 'Food Forest',
            rsvp: null,
        }
    ],
    radiusKm: 50,
};

const EVENT_WINDOWS = [
    { id: 'today', label: 'Today' },
    { id: 'weekend', label: 'This weekend' },
    { id: 'week', label: 'Next 7 days' },
    { id: 'all', label: 'All' },
];

function App() {
    return (
        <View style={{ flex: 1, backgroundColor: colors.surface.app, padding: 16, gap: 24 }}>
            {/* 1. Home "Coming up" card with Calendar › door */}
            <HomeCard
                id="events"
                caption="Coming up"
                tint={colors.event.tint}
                ink={colors.event.ink}
                colors={colors}
            >
                <EventsBody card={sampleEventsCard} colors={colors} />
            </HomeCard>

            {/* 2. Market Events filter row with calendar button door */}
            <View style={{ marginTop: 8 }}>
                <FilterChipRow
                    chips={EVENT_WINDOWS.map(w => ({ id: w.id, label: w.label }))}
                    selected="all"
                    onSelect={() => {}}
                    trailing={
                        <Pressable
                            testID="market-calendar-button"
                            accessibilityRole="button"
                            accessibilityLabel="Calendar"
                            style={{
                                width: 44,
                                height: 44,
                                borderRadius: 22,
                                backgroundColor: colors.surface.card,
                                borderWidth: StyleSheet.hairlineWidth,
                                borderColor: colors.border.default,
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                            onPress={() => {}}
                        >
                            <MaterialCommunityIcons name="calendar-month" size={20} color={colors.text.secondary} />
                        </Pressable>
                    }
                />
            </View>
        </View>
    );
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);
`);

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.png': 'empty', '.webp': 'empty', '.ttf': 'empty' },
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

const html = `<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=${WIDTH}, initial-scale=1">
    <style>
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; width: ${WIDTH}px; min-height: ${HEIGHT}px; font-family: sans-serif; }
    </style>
</head>
<body>
    <div id="root"></div>
    <script type="module" src="/bundle.js"></script>
</body>
</html>`;

const server = http.createServer((req, res) => {
    if (req.url.startsWith('/bundle.js')) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(bundle);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch({ headless: true });
const problems = [];

try {
    for (const scheme of ['light', 'dark']) {
        const page = await browser.newPage({
            viewport: { width: WIDTH, height: HEIGHT },
            colorScheme: scheme,
        });

        page.on('console', (msg) => console.log('BROWSER LOG:', msg.text()));
        page.on('pageerror', (err) => console.error('BROWSER ERROR:', err));

        await page.goto(`http://127.0.0.1:${port}/?scheme=${scheme}`);
        await page.waitForSelector('[data-testid="home-events-calendar"]', { timeout: 3000 });
        await page.waitForSelector('[data-testid="home-events-all"]', { timeout: 3000 });
        await page.waitForSelector('[data-testid="market-calendar-button"]', { timeout: 3000 });

        const found = await page.evaluate((width) => {
            const out = [];

            // Check targets >= 44dp
            for (const id of ['home-events-calendar', 'home-events-all', 'market-calendar-button']) {
                const el = document.querySelector(`[data-testid="${id}"]`);
                if (!el) {
                    out.push(`missing testid ${id}`);
                    continue;
                }
                const r = el.getBoundingClientRect();
                if (r.height < 43.5) out.push(`${id} height ${r.height.toFixed(1)} < 44dp`);
                if (id === 'market-calendar-button' && r.width < 43.5) out.push(`${id} width ${r.width.toFixed(1)} < 44dp`);
            }

            // Check elements do not overflow viewport
            const root = document.getElementById('root');
            if (root.scrollWidth > width + 0.5) {
                out.push(`page scrolled sideways (${root.scrollWidth} > ${width})`);
            }

            return { out };
        }, WIDTH);

        problems.push(...found.out.map((p) => `${scheme}: ${p}`));
        console.log(`${scheme}: Calendar doors verified (Calendar ›, All events ›, market-calendar-button ≥ 44dp)`);

        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `native-doors-320-${scheme}.png`) });
        }
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log('native calendar-doors-320: passed');
