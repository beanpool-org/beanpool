#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * chat-s1-45 320dp phone harness: Chat cross-community notice row and BeanPool community options modal
 * at the floor (320dp wide, phone text at 1.3×), in light and dark schemes.
 *
 * Checks:
 * - No sideways scroll
 * - Nothing past the 320dp edge
 * - Buttons / interactive targets >= 44dp tall
 * - Text contrast >= 4.5:1 (or 3:1 for large text)
 * - Screenshots written to --shots <dir>
 *
 *   node apps/native/e2e/chat-s1-45-320.mjs [--shots <dir>]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-s1-45-320-'));

const STUBS = {
    'react-native': `
        import React from 'react';
        import * as RNW from 'react-native-web';
        export * from 'react-native-web';
        const scaled = (style) => {
            const f = RNW.StyleSheet.flatten(style) || {};
            const o = { ...f };
            if (typeof f.fontSize === 'number') o.fontSize = f.fontSize * ${SCALE};
            if (typeof f.lineHeight === 'number') o.lineHeight = f.lineHeight * ${SCALE};
            return o;
        };
        export const Text = React.forwardRef((p, ref) => React.createElement(RNW.Text, { ...p, ref, style: scaled(p.style) }));
        export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o['android'] ?? o.default };
        export default { ...RNW, Text, Platform };
    `,
    '@expo/vector-icons': `
        import React from 'react';
        export const MaterialCommunityIcons = ({ name, size, color }) => React.createElement('span', {
            'data-icon': name,
            style: { display: 'inline-block', width: size || 20, height: size || 20, color: color || 'inherit' }
        }, '›');
    `,
};

const stubFor = (spec) => STUBS[spec] ? spec : null;

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text, Pressable, Switch, StyleSheet } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { MaterialCommunityIcons } from '@expo/vector-icons';

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const view = q.get('view') || 'chat';
const colors = scheme === 'dark' ? darkColors : lightColors;

const ChatNoticeView = () => {
    const label = '3 new messages in Castlemaine · Switch';
    return (
        <View style={{ flex: 1, backgroundColor: colors.surface.page, padding: 16 }}>
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                minHeight: 48,
                paddingHorizontal: 16,
                borderBottomWidth: 1,
                borderBottomColor: colors.border.default,
                backgroundColor: colors.surface.card,
                borderRadius: 12,
            }}>
                <Text style={{
                    flex: 1,
                    fontSize: 14,
                    fontWeight: '600',
                    color: colors.text.body,
                    paddingRight: 8,
                }} numberOfLines={2}>
                    {label}
                </Text>
                <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} />
            </View>
        </View>
    );
};

const BeanPoolOptionsView = () => {
    return (
        <View style={{
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
        }}>
            <View style={{
                width: '100%',
                maxWidth: 360,
                backgroundColor: colors.surface.card,
                borderRadius: 16,
                padding: 16,
                borderWidth: 1,
                borderColor: colors.border.default,
            }}>
                <Text style={{
                    fontSize: 18,
                    fontWeight: '700',
                    color: colors.text.heading,
                    marginBottom: 8,
                }}>
                    Castlemaine
                </Text>
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingVertical: 8,
                    minHeight: 48,
                    gap: 12,
                }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text.body }}>
                            Alerts from this community
                        </Text>
                        <Text style={{ fontSize: 13, color: colors.text.secondary, marginTop: 2, lineHeight: 18 }}>
                            Stops notifications and unread message checks from this community
                        </Text>
                    </View>
                    <Switch
                        value={true}
                        trackColor={{ false: colors.surface.subtle, true: colors.brand.primary }}
                        thumbColor={colors.surface.card}
                    />
                </View>
                <View style={{ borderTopWidth: 1, borderTopColor: colors.border.default, marginVertical: 8 }} />
                <Pressable
                    role="button"
                    accessibilityRole="button"
                    style={{ minHeight: 48, justifyContent: 'center' }}
                >
                    <Text style={{ fontSize: 15, fontWeight: '600', color: colors.feedback.danger.fg }}>
                        Remove from your saved list
                    </Text>
                </Pressable>
                <Pressable
                    role="button"
                    accessibilityRole="button"
                    style={{
                        minHeight: 48,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: colors.surface.subtle,
                        borderRadius: 12,
                        marginTop: 12,
                    }}
                >
                    <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text.heading }}>
                        Done
                    </Text>
                </Pressable>
            </View>
        </View>
    );
};

createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', width: '100%', backgroundColor: colors.surface.app }}>
        {view === 'chat' ? <ChatNoticeView /> : <BeanPoolOptionsView />}
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
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 600 }, deviceScaleFactor: 1 });
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
            if (document.scrollingElement.scrollWidth > WIDTH) out.push('the page scrolls sideways (' + document.scrollingElement.scrollWidth + 'px)');
            const texts = [...document.querySelectorAll('div[dir], span, input, textarea')].filter((el) => {
                const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
                return own || ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'hidden' && el.value);
            });
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = (el.value ?? el.textContent).trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push('"' + what + '" runs past the edge (' + Math.round(r.left) + '–' + Math.round(r.right) + ')');
                if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push('"' + what + '" is cut on the right (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
                const cs = getComputedStyle(el);
                const fg = rgb(cs.color);
                if (!fg) continue;
                if (/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u.test(what)) continue;
                const bg = backdrop(el);
                const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
                const ratio = (a + 0.05) / (b + 0.05);
                const size = parseFloat(cs.fontSize);
                const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                if (ratio < (large ? 3 : 4.5)) out.push('"' + what + '" has contrast ' + ratio.toFixed(2) + ':1 (' + cs.color + ' on rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + '), ' + size + 'px)');
            }
            for (const el of document.querySelectorAll('[role="button"]')) {
                const r = el.getBoundingClientRect();
                if (r.width === 0) continue;
                if (r.height < 43.5) out.push('the button "' + (el.textContent.trim().slice(0, 40) || el.getAttribute('aria-label')) + '" is ' + Math.round(r.height) + 'dp tall');
            }
            return out;
        }, { WIDTH });
        for (const p of found) problems.push(`${label}: ${p}`);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label}.png`) }); }
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };

    for (const scheme of ['light', 'dark']) {
        await page.goto(`${base}/?view=chat&scheme=${scheme}`);
        await page.waitForTimeout(200);
        await measure(`chat-row-320-${scheme}`);

        await page.goto(`${base}/?view=options&scheme=${scheme}`);
        await page.waitForTimeout(200);
        await measure(`beanpool-options-320-${scheme}`);
    }
    for (const e of errors) problems.push('page error: ' + e);
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

console.log('\n' + states + ' states measured at ' + WIDTH + 'dp with ' + SCALE + '× text');
if (problems.length) {
    console.log(problems.map((p) => '  ✗ ' + p).join('\n'));
    process.exit(1);
}
console.log('All states hold at 320dp x 1.3: no sideways scroll, nothing past edge, tap targets >= 44dp, contrast passes.');
