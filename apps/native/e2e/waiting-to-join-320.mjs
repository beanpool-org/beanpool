#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Welcome's waiting mode (slice S3, DESIGN-account-without-global-fable.md §2.4 and §4; components/welcome/WaitingToJoin.tsx)
 * at the floor (memory product-audience-small-screens: 320dp wide, the phone's text at 1.3×), in the light and the dark
 * scheme: the app's own component through react-native-web in headless Chromium, as e2e/look-first-320.mjs draws the
 * first screen's doors, in the welcome screen's own style numbers (app/welcome.tsx makeStyles, with the onboarding colours
 * utils/onboarding-colors.ts gives it), under its title and over its Restore.
 *
 * What is drawn: one community waiting; a yes with its Join; several lines at once (waiting, closed with Got it, one that
 * couldn't be reached), with a long community name; nothing asked yet.
 *
 * Text at 1.3× is Android's font scale: every Text's fontSize and lineHeight times 1.3, layout in dp as is. Each state
 * fails on: the page scrolling sideways; any text past the 320 edge or clipped in its box; a button under 48dp tall; text
 * under 4.5:1 contrast with what it is drawn on (3:1 from 18.66px bold or 24px).
 *
 * A stand-in for the phone, not an emulator: Android's fonts and line breaking differ. Nothing leaves the machine: the
 * page aborts every request but its own. The browser: run `pnpm --filter @beanpool/pwa exec playwright install
 * --only-shell chromium` once.
 *
 *   node apps/native/e2e/waiting-to-join-320.mjs [--shots <dir>]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-to-join-320-'));

// ─── Stubs: what the components import that reaches the router, the theme or the account ──────────────────────────
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
    'ThemeContext': `export const useTheme = () => globalThis.__theme; export const useStyles = (make) => make(globalThis.__theme);`,
    'expo-router': `export const router = { back() {}, push() {}, replace() {}, canDismiss: () => false, dismissAll() {} };`,
    'IdentityContext': `export const useIdentity = () => ({ identity: globalThis.__identity, isLoading: false });`,
    'LanguageProvider': `import { t, tn } from '@beanpool/core'; export const useWords = () => ({ t, tn });`,
    '@expo/vector-icons': `export const MaterialCommunityIcons = () => null;`,
    'expo-crypto': `export const getRandomBytes = (n) => new Uint8Array(n);`,
    '@react-native-async-storage/async-storage': `export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };`,
};
/** Import specifiers (bare, or a relative path's last part) that resolve to a stub. */
const stubFor = (spec) => {
    if (STUBS[spec]) return spec;
    if (!spec.startsWith('.')) return null;
    const base = path.basename(spec);
    return ['ThemeContext', 'IdentityContext', 'LanguageProvider'].includes(base) ? base : null;
};

// ─── The page: each case renders the real waiting mode for one state ───────────────────────────────────────────────
const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView, Text, Pressable, StyleSheet } from 'react-native';
import { palette } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { onboardingColors } from ${JSON.stringify(path.join(NATIVE, 'utils/onboarding-colors'))};
import { WaitingToJoin } from ${JSON.stringify(path.join(NATIVE, 'components/welcome/WaitingToJoin'))};
import { waitingLines } from ${JSON.stringify(path.join(NATIVE, 'utils/waiting-to-join'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const { colors, dark } = onboardingColors(scheme);
globalThis.__theme = { theme: scheme, colors };
// The welcome screen's own numbers (app/welcome.tsx makeStyles) for what the waiting mode is drawn with.
const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.page },
    homeContent: { flexGrow: 1, padding: 24, alignItems: 'center' },
    homeMain: { width: '100%', alignItems: 'center' },
    homeDoors: { width: '100%', alignItems: 'center', marginTop: 16 },
    doorLine: { fontSize: 15, color: colors.text.secondary, textAlign: 'center', lineHeight: 21, marginBottom: 8 },
    headerTitle: { fontSize: 24, fontWeight: 'bold', color: colors.text.heading, textAlign: 'center', marginBottom: 8 },
    card: { width: '100%', backgroundColor: colors.surface.card, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default },
    memberBtn: { backgroundColor: palette.blue600, paddingVertical: 18, paddingHorizontal: 12, borderRadius: 14, alignItems: 'center', width: '100%', marginBottom: 12 },
    memberBtnText: { color: colors.text.inverse, fontSize: 18, fontWeight: '700', textAlign: 'center' },
    secondaryBtn: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border.strong, padding: 16, borderRadius: 14, alignItems: 'center', width: '100%' },
    secondaryBtnText: { color: dark ? colors.text.secondary : palette.gray600, fontSize: 16, fontWeight: '600' },
    restoreSecondaryBtn: { marginTop: 20, paddingVertical: 14, paddingHorizontal: 20, borderRadius: 14, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, alignItems: 'center', width: '100%', minHeight: 48, justifyContent: 'center' },
    restoreSecondaryBtnText: { color: dark ? palette.blue400 : palette.blue600, fontSize: 15, fontWeight: '700' },
});
const at = (url, name) => ({ url, name, key: null, sentAt: '2026-10-29T00:00:00.000Z' });
const RIVER = 'https://riverside.example.org';
const LONG = 'https://the-northern-rivers-seed-and-tool-library.example.org';
const c = q.get('case');
const asked = c === 'none' ? [] : c === 'many'
    ? [at(RIVER, 'Riverside'), at(LONG, 'The Northern Rivers Seed and Tool Library Cooperative'), at('https://hill.example.org', null)]
    : [at(RIVER, 'Riverside')];
const statuses = c === 'yes'
    ? { [RIVER]: { ok: true, value: { status: 'approved', invite: 'INV-ABCD-EFGH', expiresAt: null } } }
    : c === 'many'
        ? { [RIVER]: { ok: true, value: { status: 'pending' } }, [LONG]: { ok: true, value: { status: 'none' } }, 'https://hill.example.org': { ok: false, kind: 'unreachable', message: "Couldn't reach this community. Check your connection and try again." } }
        : { [RIVER]: { ok: true, value: { status: 'pending' } } };
const noop = () => {};
const Page = () => (
    <ScrollView style={s.container} contentContainerStyle={s.homeContent}>
        <View style={s.homeMain}>
            <Text style={s.headerTitle}>Welcome to BeanPool</Text>
            <WaitingToJoin lines={waitingLines(asked, statuses)} checking={false} joining={null} onCheckAgain={noop} onJoin={noop} onGotIt={noop}
                onAskAnother={noop} onJoinWithInvite={noop} styles={s} accent={colors.text.inverse} />
            <Pressable style={s.restoreSecondaryBtn} accessibilityRole="button" accessibilityLabel="Already a Member? Restore Account">
                <Text style={s.restoreSecondaryBtnText}>🔑 Already a Member? Restore Account →</Text>
            </Pressable>
        </View>
    </ScrollView>
);
createRoot(document.getElementById('root')).render(<View style={{ height: '100vh', backgroundColor: colors.surface.page }}><Page /></View>);
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
                // A stub's own imports (react-native-web, react, core) resolve as usual, from apps/native.
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
const problems = [];
let states = 0;
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 640 }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    /** One state's checks, run in the page. */
    const measure = async (label) => {
        states++;
        const found = await page.evaluate(({ WIDTH }) => {
            const out = [];
            const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
            const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
            const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
            /** What an element is drawn on: its own and its ancestors' backgrounds, composited down to the page. */
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
                // An emoji draws in its own colours, whatever the text colour says: no contrast to measure.
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
                if (r.height < 47.5) out.push(`the button "${el.textContent.trim().slice(0, 40) || el.getAttribute('aria-label')}" is ${Math.round(r.height)}dp tall`);
            }
            return out;
        }, { WIDTH });
        for (const p of found) problems.push(`${label}: ${p}`);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true }); }
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };
    const open = async (query) => { await page.goto(`${base}/?${query}`); await page.waitForTimeout(150); };

    for (const scheme of ['light', 'dark']) {
        await open(`case=one&scheme=${scheme}`);
        await page.getByText('Waiting for Riverside: usually a few days.').waitFor();
        await measure(`${scheme} · waiting for one community`);
        await open(`case=yes&scheme=${scheme}`);
        await page.getByText('Riverside said yes. Join now.').waitFor();
        await measure(`${scheme} · a yes, with Join`);
        await open(`case=many&scheme=${scheme}`);
        await page.getByText('This request is no longer open. You can ask again.').waitFor();
        await measure(`${scheme} · three requests, a long name, one closed, one unreachable`);
        await open(`case=none&scheme=${scheme}`);
        await page.getByText('Your account is on this phone. No community has let it in yet.').waitFor();
        await measure(`${scheme} · nothing asked yet`);
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
console.log('Every state holds: no sideways scroll, nothing past the edge or cut, every button 48dp, text at 4.5:1 or better.');
