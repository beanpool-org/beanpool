#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * ONE share flow on the phone (share-one-flow): a listing's ONE Share button and the sheet it opens (components/SharePost.tsx,
 * components/ShareSheet.tsx, the real ones, through react-native-web; DP2) at the floor (320dp wide, the phone's text at 1.3x),
 * light and dark, the sheet open, for three people:
 *   - a member where any member may invite: the line, and exactly ONE invite action (Invite and share);
 *   - a member where only admins invite: the line that only admins invite here, no invite action, and ONE more button,
 *     "Ask an admin to invite someone" (none where the node does not take asks);
 *   - an admin where only admins invite: the line, and exactly ONE invite action.
 * Never an "Invite someone" button, beside it or alone. Plus sharing outside on (Share outside and its lines, one invite action).
 *
 * Each state fails on: the page scrolling sideways; text past the edge or cut; a button under 47.5dp; text under 4.5:1; the wrong
 * number of invite actions. A stand-in for the phone, not an emulator. Nothing leaves the machine.
 *
 *   node apps/native/e2e/share-one-flow-320.mjs [--shots <dir>]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'share-one-flow-320-'));

// ─── Stubs: what the screens import that reaches the router, the device, the theme or the network ────────────────────
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
    'IdentityContext': `export const useIdentity = () => ({ identity: null, isLoading: false });`,
    'expo-router': `
        export const router = { back() {}, push() {}, replace() {}, canGoBack: () => false };
        export const ErrorBoundary = () => null;
        export const useLocalSearchParams = () => globalThis.__params || {};
    `,
    'react-native-safe-area-context': `
        import React from 'react';
        import { View } from 'react-native-web';
        export const SafeAreaView = ({ children, style }) => React.createElement(View, { style }, children);
        export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
    `,
    '@expo/vector-icons': `
        import React from 'react';
        import { Text } from 'react-native-web';
        export const MaterialCommunityIcons = ({ style, size }) => React.createElement(Text, { style: [{ fontSize: size, color: '#fff' }, style] }, '←');
    `,
    'expo-status-bar': `export const StatusBar = () => null;`,
    'expo-image': `
        import React from 'react';
        import { Image as RNImage } from 'react-native-web';
        export const Image = ({ source, style }) => React.createElement(RNImage, { source, style, resizeMode: 'cover' });
    `,
    '@react-native-async-storage/async-storage': `export default { getItem: async (k) => (k === 'beanpool_anchor_url' ? 'https://castlemaine.beanpool.org' : null), setItem: async () => {} };`,
    'use-node-profile': `export const useNodeProfile = () => ({ profile: 'local', features: globalThis.__features, checkedAt: '' });`,
    'identity': `export const loadIdentity = async () => ({ publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Robin' });`,
    'nodes': `export const isGuestNode = async () => false;`,
    'node-admin': `export const askNodeRole = async () => ({ role: globalThis.__role ?? null, communityName: 'Castlemaine' }); export const cachedNodeRoleHeard = askNodeRole; export const persistNodeRole = async () => {}; export const readPersistedNodeRole = async () => undefined;`,
    'NodeStatusContext': `export const useNodeStatus = () => ({ recognition: 'member', nodeUrl: 'https://castlemaine.beanpool.org', recheck: async () => 'member' });`,
    'db': `export const askCanVouch = async () => !!globalThis.__canVouch;`,
    'crypto': `export const buildSignedHeaders = async () => ({});`,
    // The ask form is opened by a tap, which these shots never make: the button is what they look at.
    'InviteAsks': `export const AskSheet = () => null;`,
    'peek': `export const makePeekLink = async () => ({ link: 'https://castlemaine.beanpool.org/?post=p&peek=t', expiresAt: '' }); export const peekStopsHere = () => 0;`,
};
/** Import specifiers (bare, or a relative path's last part) that resolve to a stub. */
const stubFor = (spec, importer = '') => {
    if (STUBS[spec]) return spec;
    if (!spec.startsWith('.')) return null;
    const base = path.basename(spec);
    if (['ThemeContext', 'IdentityContext', 'peek', 'use-node-profile', 'NodeStatusContext', 'InviteAsks'].includes(base)) return base;
    // The key, the stored communities, the role and the balance are the button's own reads: stubbed for it alone, so the
    // real modules still serve everything else that imports them.
    return ['identity', 'nodes', 'node-admin', 'db', 'crypto'].includes(base) && /^(invite-and-share|InviteAndShare|use-share-role)\./.test(path.basename(importer)) ? base : null;
};

// ─── The page: each case renders the real screens for one state ─────────────────────────────────────────────────────
const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView } from 'react-native';
import { setLanguage } from '@beanpool/core';
import ta from ${JSON.stringify(path.join(ROOT, 'packages/beanpool-core/words/ta.json'))};
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { SharePostButtons } from ${JSON.stringify(path.join(NATIVE, 'components/SharePost'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__theme = { theme: scheme, colors };
if (q.get('lang') === 'ta') setLanguage('ta', [ta]);
const who = q.get('who') || 'member';
const onlyAdmins = who === 'admins-only' || who === 'admins-only-no-asks' || who === 'admin';
globalThis.__features = { shareOutside: who === 'outside', knocks: true, invites: true, inviteAsks: who !== 'admins-only-no-asks', door: onlyAdmins ? 'admins' : 'members' };
// vouch=1: someone who can vouch, where the community has it (the tallest invite panel).
if (q.get('vouch') === '1') globalThis.__features.inviteVouch = true;
globalThis.__canVouch = q.get('vouch') === '1';
globalThis.__role = who === 'admin' ? 'admin' : null;
const POST_ID = '3f0c8a8e-1b2c-4d5e-8f90-123456789abc';
createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', backgroundColor: colors.surface.app }}>
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.page }} contentContainerStyle={{ padding: 16 }}>
            <SharePostButtons post={{ id: POST_ID, title: 'Long ladder to lend', status: 'active', audience_scope: 'public' }} />
        </ScrollView>
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
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {} };' },
    logLevel: 'error',
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
                if (args.namespace === 'stub') return undefined;
                const name = stubFor(args.path, args.importer);
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
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    /** One state's checks, run in the page. */
    const measure = async (label, { minButton = 47.5 } = {}) => {
        states++;
        const found = await page.evaluate(({ WIDTH, minButton }) => {
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
            const texts = [...document.querySelectorAll('div[dir], span, input, textarea')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = el.textContent.trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
                if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`"${what}" is cut on the right (${el.scrollWidth} > ${el.clientWidth})`);
                if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') out.push(`"${what}" is cut at the bottom (${el.scrollHeight} > ${el.clientHeight})`);
                const cs = getComputedStyle(el);
                const fg = rgb(cs.color);
                if (!fg) continue;
                if (/^[\\p{Extended_Pictographic}\\uFE0F\\u200D\\s←]+$/u.test(what)) continue;
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
                if (r.height < minButton) out.push(`the button "${el.textContent.trim().slice(0, 40) || el.getAttribute('aria-label')}" is ${Math.round(r.height)}dp tall`);
            }
            return out;
        }, { WIDTH, minButton });
        for (const p of found) problems.push(`${label}: ${p}`);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `phone-${label.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true });
        }
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };
    const open = async (query) => { await page.goto(`${base}/?${query}`); await page.waitForTimeout(250); };

    const countInvites = () => page.evaluate(() => ({
        shareAndInvite: document.querySelectorAll('[data-testid="invite-and-share-button"]').length,
        oldButton: document.querySelectorAll('[data-testid="invite-someone-button"]').length + ([...document.querySelectorAll('[role="button"]')].filter((el) => el.textContent.trim() === 'Invite someone').length),
        asks: document.querySelectorAll('[data-testid="share-ask-admin-button"]').length,
        line: document.querySelector('[data-testid="share-members-note"]')?.textContent ?? null,
        outside: document.querySelector('[data-testid="share-outside-line"]')?.textContent ?? null,
    }));
    const cases = [
        ['open invite, a member', 'member', 1, 'This link opens for members only.', 0],
        ['only admins invite, a member', 'admins-only', 0, 'This link opens for members only, and only admins invite here.', 1],
        ['only admins invite, asks off, a member', 'admins-only-no-asks', 0, 'This link opens for members only, and only admins invite here.', 0],
        ['only admins invite, an admin', 'admin', 1, 'This link opens for members only.', 0],
        ['sharing outside on, a member', 'outside', 1, 'This link opens for members only.', 0],
    ];
    const ONE_NOTE = 'Anyone with the link can read this listing for 7 days, without names or faces, then ask to join. You can stop it any time.';
    for (const scheme of ['light', 'dark']) {
        for (const [name, who, wantInvites, wantLine, wantAsks] of cases) {
            const tag = `${scheme} · ${name}`;
            await open(`scheme=${scheme}&lang=en&who=${who}`);
            // ONE Share button (DP2): nothing but it on the page; its sheet holds the ways and their sentences.
            await page.locator('[data-testid="share-open-button"]').waitFor();
            await page.waitForTimeout(500);
            const before = await countInvites();
            if (before.line || before.outside || before.shareAndInvite || before.asks) problems.push(`${tag}: a way or a sentence shows on the page before Share is tapped`);
            if (who === 'member') await measure(`${scheme} · the page, sheet closed`);
            await page.locator('[data-testid="share-open-button"]').click();
            await page.locator('[data-testid="share-members-button"]').waitFor();
            await page.waitForTimeout(300);
            const c = await countInvites();
            if (c.shareAndInvite !== wantInvites) problems.push(`${tag}: ${c.shareAndInvite} Invite and share button(s), wanted ${wantInvites}`);
            if (c.asks !== wantAsks) problems.push(`${tag}: ${c.asks} Ask an admin button(s), wanted ${wantAsks}`);
            if (c.asks && c.shareAndInvite) problems.push(`${tag}: Invite and share and Ask an admin show together`);
            if (who === 'outside' && c.outside !== ONE_NOTE) problems.push(`${tag}: the Share outside note is ${JSON.stringify(c.outside)}, wanted the one note`);
            if (c.oldButton) problems.push(`${tag}: the old Invite someone button shows`);
            if (c.line !== wantLine) problems.push(`${tag}: the line is ${JSON.stringify(c.line)}, wanted ${JSON.stringify(wantLine)}`);
            await measure(`${tag}, sheet open`);
            if (who === 'outside') {
                // Invite and share opens its panel in the sheet, in place of the other ways.
                await page.locator('[data-testid="invite-and-share-button"]').click();
                await page.locator('[data-testid="invite-and-share-panel"]').waitFor();
                if (await page.locator('[data-testid="share-members-button"]').count()) problems.push(`${tag}: the panel shows beside the other ways`);
                await measure(`${tag}, invite panel`);
                // The shortest phone at the floor (320 × 569, 16:9), in the longest language: the sheet's top stays on the
                // screen and the ways scroll under it, never pushed off the top.
                await page.setViewportSize({ width: WIDTH, height: 569 });
                for (const lang of ['en', 'ta']) {
                    await open(`scheme=${scheme}&lang=${lang}&who=outside&vouch=1`);
                    await page.locator('[data-testid="share-open-button"]').click();
                    await page.locator('[data-testid="invite-and-share-button"]').click();
                    await page.locator('[role="radio"]').first().waitFor();
                    await page.waitForTimeout(400); // the sheet's fade-in, so the shot shows it as a member sees it
                    const top =await page.evaluate(() => document.querySelector('[data-testid="share-sheet"]').getBoundingClientRect().top);
                    if (top < 0) problems.push(`${tag} (${lang}, 569 tall): the sheet's top is ${Math.round(top)}px above the screen`);
                    await measure(`${tag}, invite panel with the vouch, ${lang}, 569 tall`, { minButton: 43.5 });
                }
                await page.setViewportSize({ width: WIDTH, height: 640 });
            }
        }
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
