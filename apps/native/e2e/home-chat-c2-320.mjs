#!/usr/bin/env node
/* global process, console, document, location, URL, window */
/**
 * (home-chat-c2) Home's "A chat" card and its settings list on the phone (DESIGN-home-chosen-chat-fable.md §2, slice C2):
 * node apps/native/e2e/home-chat-c2-320.mjs --shots <dir>
 *
 * The app's own HomeCard, ChatBody and CardSettingsSheet through react-native-web in headless Chromium (as
 * home-look-s4-320.mjs), at 320dp wide with the phone's text at 1.3× and at a normal phone (412dp, 1×), light and dark.
 * The card's lines are opened by stand-in doors (a DM's words as the phone's own judge would hand them back, a group
 * with no key open in this session); nothing is fetched. Four cards: a DM read on the phone (with a photo and "You"), a
 * locked group with no key open ("open to read"), a gone chat (Remove), and one with no chat picked. Then the list.
 * Checks: no sideways scroll, every text inside the screen's width, each state drawn.
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
const HEIGHT = 1100;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const PHONES = [{ name: '320', width: 320, scale: 1.3 }, { name: 'normal', width: 412, scale: 1 }];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'home-chat-c2-'));
const stubs = (scale) => ({
    'react-native': `
        import React from 'react';
        import * as RNW from 'react-native-web';
        export * from 'react-native-web';
        const scaled = (style) => {
            const f = RNW.StyleSheet.flatten(style) || {};
            const o = { ...f, fontSize: (f.fontSize ?? 14) * ${scale} };
            if (typeof f.lineHeight === 'number') o.lineHeight = f.lineHeight * ${scale};
            return o;
        };
        export const Text = React.forwardRef((p, ref) => React.createElement(RNW.Text, { ...p, ref, style: scaled(p.style) }));
        export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o['android'] ?? o.default };
        export default { ...RNW, Text, Platform };
    `,
    'react-native-safe-area-context': `export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });`,
    'react-native-keyboard-controller': `
        import { ScrollView } from 'react-native-web';
        export const useKeyboardState = () => ({ isVisible: false, height: 0 });
        export const KeyboardAwareScrollView = ScrollView;
    `,
    'expo-router': `export const router = { push: () => {} }; export const useFocusEffect = () => {};`,
    '@expo/vector-icons': `
        import React from 'react';
        const GLYPHS = { 'arrow-up': '↑', 'arrow-down': '↓', 'dots-horizontal': '…' };
        export const MaterialCommunityIcons = ({ name, size, color, style }) => React.createElement('span', { 'aria-hidden': true, style: { color, fontSize: size, fontWeight: 900, ...(style || {}) } }, GLYPHS[name] ?? '');
    `,
});

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { HomeCard } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};
import { ChatBody } from ${JSON.stringify(path.join(NATIVE, 'components/home/ChatBody'))};
import { CardSettingsSheet } from ${JSON.stringify(path.join(NATIVE, 'components/home/CardSettingsSheet'))};

const q = new URLSearchParams(location.search);
const dark = q.get('scheme') === 'dark';
const colors = dark ? darkColors : lightColors;
const noop = () => {};
const ME = 'a'.repeat(64), ANA = 'b'.repeat(64);
const now = Date.parse('2026-11-07T10:00:00Z');
const at = (min) => new Date(now - min * 60000).toISOString();
const sealed = { ciphertext: 'c', nonce: 'x25519-xc20p-v2:n', metadata: null };
const gsealed = { ciphertext: 'c', nonce: 'grp1:n', metadata: JSON.stringify({ epoch: 1 }) };
// The phone's own DM judge, as db.ts hands its views back (here: these words opened); a group with no key open yet.
const WORDS = { d1: 'Who has a ladder I could borrow for the weekend? Mine broke on the gutters.', d2: "Mine's at the shed, come by after 4", d3: 'the fence' };
const deps = {
    judgeDm: async (_c, lines) => new Map(lines.map((l) => [l.id, { text: WORDS[l.id], format: 3, after: null, mark: null }])),
    keyring: async (id) => ({ groupId: id, openedKey: () => undefined, signerSeen: () => undefined, successions: new Map(), seenLocked: async () => true, memo: { has: () => false, add: noop } }),
    // The phone's own DM knowledge (#2947): none of these chats is a DM it knows, so the group card opens as a group.
    knownDm: async () => false,
};
const dm = { id: 'chat-dm01', type: 'chat', settings: { conversationId: 'dm-1', kind: 'dm', name: 'Ana Castellanos-Whitfield' } };
const grp = { id: 'chat-gr01', type: 'chat', settings: { conversationId: 'g-1', kind: 'group', name: 'Brunswick Heads garden crew' } };
const gone = { id: 'chat-go01', type: 'chat', settings: { conversationId: 'g-2', kind: 'group', name: 'Old choir' } };
const pick = { id: 'chat-pk01', type: 'chat', settings: {} };
const CARDS = [
    [dm, { kind: 'dm', name: 'Ana Castellanos-Whitfield', unread: 3, muted: false, lines: [
        { id: 'd1', author: ANA, who: 'Ana', at: at(120), type: 'text', systemType: null, sealed },
        { id: 'd2', author: ME, who: 'Me', at: at(60), type: 'text', systemType: null, sealed },
        { id: 'd3', author: ANA, who: 'Ana', at: at(40), type: 'image', systemType: null, sealed },
    ] }],
    [grp, { kind: 'group', name: 'Brunswick Heads garden crew', unread: 0, muted: true, lines: [
        { id: 'g1', author: ANA, who: 'Ana', at: at(50), type: 'text', systemType: null, sealed: gsealed },
        { id: 'g2', author: 'SYSTEM', who: null, at: at(45), type: 'system', systemType: 'member_joined', text: 'Sam joined the group', metadata: null },
    ] }],
    [gone, { gone: 'left' }],
    [pick, null],
];
const ROWS = [
    { conversationId: 'g-1', kind: 'group', name: 'Brunswick Heads garden crew', emoji: '🌻', at: at(45) },
    { conversationId: 'e-1', kind: 'event', name: 'Working bee at the hall', emoji: '📅', at: at(200) },
    { conversationId: 'dm-1', kind: 'dm', name: 'Ana Castellanos-Whitfield', emoji: '👤', at: at(40) },
    { conversationId: 'dm-2', kind: 'dm', name: 'Sam', emoji: '👤', at: at(3000) },
];

const sheet = q.get('view') === 'sheet';
createRoot(document.getElementById('root')).render(
    sheet ? (
        <CardSettingsSheet visible type="chat" mode="add" colors={colors} onDone={noop} onClose={noop}
            chats={{ rows: ROWS, failed: false, onHome: new Set(['dm-1']) }} />
    ) : (
    <View style={{ minHeight: '100vh', backgroundColor: colors.surface.app }}>
        <ScrollView contentContainerStyle={{ paddingBottom: 40, paddingTop: 8 }}>
            <View testID="shot-list">
                {CARDS.map(([inst, card]) => (
                    <HomeCard key={inst.id} id={inst.id} caption="A chat" colors={colors} hue="rose" testID={'home-card-' + inst.id} onMenu={noop}>
                        <ChatBody inst={inst} card={card} me={ME} colors={colors} deps={deps} now={now} onPick={noop} onRemove={noop} />
                    </HomeCard>
                ))}
            </View>
        </ScrollView>
    </View>
    ),
);
`);

async function bundleFor(scale) {
    const s = stubs(scale);
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        write: false,
        jsx: 'automatic',
        loader: { '.js': 'jsx', '.png': 'empty', '.ttf': 'empty', '.webp': 'empty' },
        resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.mjs', '.json'],
        nodePaths: [path.join(ROOT, 'node_modules'), path.join(NATIVE, 'node_modules')],
        define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"' },
        banner: { js: 'globalThis.process = globalThis.process || { env: {} }; globalThis.global = globalThis;' },
        logLevel: 'error',
        plugins: [{
            name: 'stubs',
            setup(b) {
                b.onResolve({ filter: /.*/ }, (args) => (args.namespace !== 'stub' && s[args.path] ? { path: args.path, namespace: 'stub' } : undefined));
                b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: s[args.path], loader: 'jsx', resolveDir: NATIVE }));
            },
        }],
    });
    return result.outputFiles[0].text;
}
const bundles = Object.fromEntries(await Promise.all(PHONES.map(async (p) => [p.name, await bundleFor(p.scale)])));

const html = (phone) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${PHONES.find((p) => p.name === phone).width}">
<script>window.process = window.process || { env: {} }; window.global = window;</script>
<style>html,body,#root{margin:0;min-height:100%} body{font-family:sans-serif}</style></head>
<body><div id="root"></div><script type="module" src="/app-${phone}.js"></script></body></html>`;
const server = http.createServer((req, res) => {
    const js = /^\/app-(\w+)\.js$/.exec(req.url);
    if (js) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundles[js[1]]); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html(new URL(req.url, 'http://x').searchParams.get('phone')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const problems = [];
try {
    for (const phone of PHONES) {
        const context = await browser.newContext({ viewport: { width: phone.width, height: HEIGHT }, deviceScaleFactor: 1 });
        await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
        const page = await context.newPage();
        page.on('pageerror', (e) => problems.push(`page error: ${e}`));
        for (const view of ['cards', 'sheet']) {
            for (const scheme of ['light', 'dark']) {
                const label = `home-chat-c2-${view}-${phone.name}-${scheme}`;
                await page.goto(`${base}/?phone=${phone.name}&scheme=${scheme}&view=${view}`);
                await page.getByTestId(view === 'sheet' ? 'card-settings-sheet' : 'shot-list').first().waitFor({ timeout: 8000 }).catch((e) => { console.log(problems.join('\n')); throw e; });
                await page.waitForTimeout(400);
                const found = await page.evaluate(({ WIDTH, view }) => {
                    const out = [];
                    if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
                    for (const el of document.querySelectorAll('div[dir], span')) {
                        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${el.textContent.trim().slice(0, 40)}" runs past the edge (${Math.round(r.left)}-${Math.round(r.right)})`);
                    }
                    const has = (id) => !!document.querySelector(`[data-testid="${id}"]`);
                    const need = view === 'sheet'
                        ? ['card-settings-chat-g-1', 'card-settings-chat-dm-1', 'card-settings-done']
                        : ['home-chat-line-chat-dm01-0', 'home-chat-line-chat-gr01-0', 'home-chat-remove-chat-go01', 'home-chat-pick-chat-pk01'];
                    for (const id of need) if (!has(id)) out.push(`${id} not drawn`);
                    const text = document.body.textContent;
                    if (view === 'cards') {
                        for (const s of ['You, 1h ago', '📷 Photo', '3 new', '🔒 Message · open to read', "You're no longer in this chat.", 'Pick a chat', '🔕']) if (!text.includes(s)) out.push(`missing "${s}"`);
                        if (text.includes('the fence') || text.includes('x25519')) out.push('a sealed photo caption or bytes drawn');
                    } else if (!text.includes('On Home')) out.push('missing "On Home"');
                    return out;
                }, { WIDTH: phone.width, view });
                for (const p of found) problems.push(`${label}: ${p}`);
                if (SHOTS) {
                    fs.mkdirSync(SHOTS, { recursive: true });
                    await page.screenshot({ path: path.join(SHOTS, `${label}.png`), fullPage: view === 'cards' });
                }
                console.log(`${found.length ? 'x' : 'ok'} ${label}${found.length ? `; ${found.length} problem(s)` : ''}`);
            }
        }
        await context.close();
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
    console.log(problems.map((p) => `  x ${p}`).join('\n'));
    process.exit(1);
}
