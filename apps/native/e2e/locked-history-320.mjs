#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * The group-history screens at the floor (memory product-audience-small-screens: 320dp wide, the phone's text at 1.3×),
 * in the light and the dark scheme, rendered for real: the app's own components through react-native-web in headless
 * Chromium, not a model of their numbers (scratch/global-node/DESIGN-group-history-after-rekey-fable.md §7, §8 S2/S3).
 *
 * What is drawn: the chat's locked row, a waiting line and the member's own line from before the change
 * (components/LockedHistory.tsx); the sheet behind the row; the old-words screen with 12 eight-letter words typed box by
 * box, done with two groups withheld, nothing handed over, and the owner sentence (app/old-words-unlock.tsx); the
 * confirming member's screen at "Confirm", at "Unlocking 42 of 120…" and at "Handed 3 of 120" (app/confirm-new-phone.tsx); the new phone's code with its "Confirmed by" note (app/new-phone-code.tsx); the
 * old phone's card with its words shown (components/KeyMovedCard.tsx).
 *
 * Text at 1.3× is Android's font scale: every Text and TextInput's fontSize and lineHeight times 1.3, layout in dp as
 * is. Each state fails on: the page scrolling sideways; any text past the 320 edge or clipped in its box; a button
 * under 48dp tall; text under 4.5:1 contrast with what it is drawn on (3:1 from 18.66px bold or 24px).
 *
 * Nothing leaves the machine: modules that reach a node, the phone's storage or its hardware are replaced by stubs that
 * answer as the screens' tests do, and the page aborts every request but its own. The browser: run
 * `pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium` once.
 *
 *   node apps/native/e2e/locked-history-320.mjs [--shots <dir>]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-history-320-'));

// ─── Stubs: what the screens import that reaches a node, storage or the phone's hardware ────────────────────────────
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
    '@expo/vector-icons': `
        import React from 'react';
        import { View } from 'react-native-web';
        export const MaterialCommunityIcons = ({ size = 22, color }) => React.createElement(View, { style: { width: size, height: size, borderRadius: 4, backgroundColor: color, opacity: 0.6 } });
    `,
    'ThemeContext': `export const useTheme = () => globalThis.__theme;`,
    'expo-router': `export const router = { back() {}, push() {}, replace() {} }; export const ErrorBoundary = () => null; export const useIsFocused = () => true;`,
    'react-native-safe-area-context': `export const useSafeAreaInsets = () => ({ top: 24, bottom: 16, left: 0, right: 0 });`,
    'expo-clipboard': `export const getStringAsync = async () => '';`,
    'WordsOnScreen': `export const NoScreenCapture = ({ children }) => children; export const WordsOutsideScreens = ({ children }) => children;`,
    'useYourGroups': `export const yourGroupsStore = { getState: () => ({ items: [] }) };`,
    'db': `
        const s = () => globalThis.__db;
        export const unlockGroupHistoryWithWords = (...a) => s().unlockGroupHistoryWithWords(...a);
        export const lockedHistoryRows = (...a) => s().lockedHistoryRows(...a);
        export const newPhoneCode = (...a) => s().newPhoneCode(...a);
        export const newPhoneConfirmedNotes = (...a) => s().newPhoneConfirmedNotes(...a);
        export const newPhoneHandOvers = (...a) => s().newPhoneHandOvers(...a);
        export const checkScannedNewPhone = (...a) => s().checkScannedNewPhone(...a);
        export const confirmScannedNewPhone = (...a) => s().confirmScannedNewPhone(...a);
    `,
    'expo-camera': `
        import React, { useEffect } from 'react';
        import { View } from 'react-native-web';
        export const useCameraPermissions = () => [{ granted: true, canAskAgain: true }, () => {}];
        export const CameraView = ({ onBarcodeScanned, style }) => {
            useEffect(() => { const t = setTimeout(() => onBarcodeScanned?.({ data: 'code' }), 10); return () => clearTimeout(t); }, [onBarcodeScanned]);
            return React.createElement(View, { style });
        };
    `,
    'react-native-qrcode-svg': `
        import React from 'react';
        import { View } from 'react-native-web';
        export default ({ size = 240 }) => React.createElement(View, { style: { width: size, height: size, backgroundColor: '#000' } });
    `,
    'IdentityContext': `export const useIdentity = () => ({ identity: globalThis.__identity });`,
    'node-post': `export const anchorUrl = async () => 'https://community.example'; export const signedGet = async () => { throw new Error('no node'); }; export const signedPost = signedGet;`,
    'identity': `export const getMnemonic = async (id) => id?.mnemonic ?? null;`,
    'words-behind-lock': `export const readWordsBehindLock = async (id) => id?.mnemonic ?? null;`,
    '@react-native-async-storage/async-storage': `export default { getItem: async () => '1', setItem: async () => {}, removeItem: async () => {} };`,
    'group-chat-keys': `export const groupKeyring = () => { throw new Error('no keyring here'); };`,
    'name-key-memory': `export const keysThisPhoneKnewFor = async () => [];`,
};
/** Import specifiers (bare, or a relative path's last part) that resolve to a stub. */
const stubFor = (spec) => {
    if (STUBS[spec]) return spec;
    if (!spec.startsWith('.')) return null;
    const base = path.basename(spec);
    return ['ThemeContext', 'WordsOnScreen', 'useYourGroups', 'db', 'IdentityContext', 'node-post', 'identity', 'words-behind-lock',
        'group-chat-keys', 'name-key-memory'].includes(base) ? base : null;
};

// ─── The page: each case renders the real components for one state ───────────────────────────────────────────────────
const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView } from 'react-native-web';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { LockedHistoryRow, LockedHistorySheet, SealedNoticeLine } from ${JSON.stringify(path.join(NATIVE, 'components/LockedHistory'))};
import { KeyMovedCard } from ${JSON.stringify(path.join(NATIVE, 'components/KeyMovedCard'))};
import OldWordsUnlockScreen from ${JSON.stringify(path.join(NATIVE, 'app/old-words-unlock'))};
import ConfirmNewPhoneScreen from ${JSON.stringify(path.join(NATIVE, 'app/confirm-new-phone'))};
import NewPhoneCodeScreen from ${JSON.stringify(path.join(NATIVE, 'app/new-phone-code'))};
import { lockedHistoryRowText, LOCKED_OWN_LINE_TEXT } from ${JSON.stringify(path.join(NATIVE, 'utils/group-history-unlock'))};
import { GROUP_LINE_WAITING_KEY_TEXT } from ${JSON.stringify(path.join(NATIVE, 'utils/group-line-display'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__theme = { theme: scheme, colors };
const NAME = 'Bartholomew';
const WORDS = ['abstract', 'accident', 'acoustic', 'activity', 'aircraft', 'alphabet', 'although', 'aluminum', 'ambition', 'anything', 'approval', 'attitude'];
globalThis.__identity = { publicKey: 'a'.repeat(64), mnemonic: WORDS };
const GROUPS = [{ id: 'g1', name: 'Mullumbimby Community Gardeners' }, { id: 'g2', name: 'Repair Café Convenors' }, { id: 'g3', name: 'Neighbourhood Watch' }];
globalThis.__db = {
    unlockGroupHistoryWithWords: async () => ({ outcome: q.get('words') === 'owner' ? 'owner' : 'done', unlocked: q.get('words') === 'done' ? { g3: 4 } : {}, refused: 0,
        withheld: q.get('words') === 'owner' ? [] : GROUPS.slice(0, 2) }),
    lockedHistoryRows: async () => ({ g1: 1234, g2: 56 }),
    newPhoneCode: async () => JSON.stringify(['beanpool-new-phone/1', 'b'.repeat(64), 'c'.repeat(64), NAME]),
    newPhoneHandOvers: async () => new Set(),
    newPhoneConfirmedNotes: async () => [{ name: NAME, at: Date.UTC(2026, 9, 13) }, { name: 'Dovetail-Anneliese', at: Date.UTC(2026, 9, 12) }],
    checkScannedNewPhone: async () => ({ ok: true, name: NAME, oldKey: 'c'.repeat(64), newKey: 'b'.repeat(64), groups: GROUPS }),
    confirmScannedNewPhone: (check, onProgress) => {
        if (q.get('hand') === 'partial') return Promise.resolve({ handed: { g1: 3 }, total: 3, already: 0, planned: 120, stopped: false });
        if (q.get('hand') === 'said') return Promise.resolve({ handed: {}, total: 0, already: 0, listedHeld: 4, planned: 0, stopped: false });
        setTimeout(() => onProgress?.(42, 120), 10);
        return new Promise(() => {});
    },
};
const c = q.get('case');
const Page = () => {
    if (c === 'chat') return (
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.app }}>
            <SealedNoticeLine name={null} text={GROUP_LINE_WAITING_KEY_TEXT} details={null} />
            <LockedHistoryRow text={lockedHistoryRowText(1234)} onPress={() => {}} />
            <SealedNoticeLine name={NAME} text={LOCKED_OWN_LINE_TEXT} details={null} />
        </ScrollView>
    );
    if (c === 'sheet') return <View style={{ flex: 1, backgroundColor: colors.surface.app }}><LockedHistorySheet open bottomInset={16} onClose={() => {}} onWords={() => {}} onAsk={() => {}} /></View>;
    if (c === 'words') return <OldWordsUnlockScreen />;
    if (c === 'confirm') return <ConfirmNewPhoneScreen />;
    if (c === 'code') return <NewPhoneCodeScreen />;
    if (c === 'moved') return <ScrollView style={{ flex: 1, backgroundColor: colors.surface.page }} contentContainerStyle={{ padding: 16 }}><KeyMovedCard colors={colors} /></ScrollView>;
    return null;
};
createRoot(document.getElementById('root')).render(<View style={{ height: '100vh', backgroundColor: colors.surface.app }}><Page /></View>);
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
                // A stub's own imports (react-native-web, react) resolve as usual, from apps/native.
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
    const open = async (q) => { await page.goto(`${base}/?${q}`); await page.waitForTimeout(150); };
    const button = (name) => page.getByRole('button', { name, exact: false }).first();

    for (const scheme of ['light', 'dark']) {
        await open(`case=chat&scheme=${scheme}`);
        await measure(`${scheme} · the chat's locked row, a waiting line and her own line`);
        await open(`case=sheet&scheme=${scheme}`);
        await measure(`${scheme} · the sheet behind the row`);

        for (const words of ['done', 'nothing', 'owner']) {
            await open(`case=words&scheme=${scheme}&words=${words}`);
            const boxes = page.getByLabel(/Recovery word \d+/);
            const n = await boxes.count();
            if (n !== 12) problems.push(`${scheme} · old words: ${n} word boxes, not 12`);
            const WORDS = ['abstract', 'accident', 'acoustic', 'activity', 'aircraft', 'alphabet', 'although', 'aluminum', 'ambition', 'anything', 'approval', 'attitude'];
            for (let i = 0; i < n; i++) await boxes.nth(i).fill(WORDS[i]);
            await measure(`${scheme} · old words, 12 eight-letter words typed box by box`);
            await button('Unlock earlier messages').click();
            await page.getByText(words === 'owner' ? /Tell an owner/ : words === 'nothing' ? /Nothing was handed over for/ : /Done\. Your earlier messages/).first().waitFor();
            await measure(`${scheme} · old words, ${words === 'owner' ? 'the owner sentence' : words === 'nothing' ? 'nothing handed over for two groups' : 'done with two groups withheld'}`);
        }

        await open(`case=confirm&scheme=${scheme}`);
        await page.getByText(/You're confirming this is/).waitFor();
        await measure(`${scheme} · confirming a member's new phone, before Confirm`);
        await button('Confirm').click();
        await page.getByText('Unlocking 42 of 120…').waitFor();
        await measure(`${scheme} · confirming: Unlocking 42 of 120…`);
        await open(`case=confirm&scheme=${scheme}&hand=partial`);
        await page.getByText(/You're confirming this is/).waitFor();
        await button('Confirm').click();
        await page.getByText(/Handed 3 of 120\. The community refused the rest/).waitFor();
        await measure(`${scheme} · confirming: Handed 3 of 120, the rest refused`);
        await open(`case=confirm&scheme=${scheme}&hand=said`);
        await page.getByText(/You're confirming this is/).waitFor();
        await button('Confirm').click();
        await page.getByText(/Nothing handed: the community says/).waitFor();
        await measure(`${scheme} · confirming: the community says the new phone already holds them`);

        await open(`case=code&scheme=${scheme}`);
        await page.getByText(/Confirmed by Bartholomew/).waitFor();
        await measure(`${scheme} · the new phone's code with its Confirmed by notes`);

        await open(`case=moved&scheme=${scheme}`);
        await page.getByText('This account moved to a new phone').waitFor();
        await measure(`${scheme} · the old phone's card`);
        await button('Show my old 12 words').click();
        await page.getByText('12. attitude').waitFor();
        await measure(`${scheme} · the old phone's card with its words shown`);
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
