#!/usr/bin/env node
/* global process, console, document, getComputedStyle, globalThis, location, window */
/**
 * Voice messages on the phone (slice V3, DESIGN-cross-chat-voice-fable.md §5.3, §5.5) at the floor (memory
 * product-audience-small-screens: 320dp wide, the phone's text at 1.3×), in Classic (the code's `dark`), Light and Dark (the
 * code's `night`), through react-native-web in headless Chromium, as e2e/chat-s1-45-320.mjs draws its screens.
 *
 * What is drawn is the app's own code:
 *   - the shared composer (components/chat/ChatComposer.tsx) with its microphone (components/chat/VoiceRecorder.tsx), driven
 *     with the mouse as a finger: the microphone in Send's place; a short hold ("Hold to record"); holding at 0:42 (slide to
 *     cancel, the lock above); slid up and locked at 1:05 (bin, Stop, Send); stopped at 3:00 (bin, play, Send);
 *   - voice bubbles (components/chat/VoiceBubble.tsx) in the chat's own bubble styles (components/chat/styles.ts), mine and
 *     theirs, one playing at 1.5× (the speed button shown), and the three that can't play: gone after 30 days, refused, and
 *     unavailable (tap to try again).
 * Stood in for: the theme context, expo-audio (a recorder whose clock the page sets, a player that says it plays), storage,
 * the file system, and each bubble's loader (it answers what getDecryptedVoice would). The row around a bubble is the chat's
 * styles, not ChatMessageRow itself.
 *
 * Each state fails on: the page scrolling sideways; text past the 320 edge or cut; text under 4.5:1 (3:1 large); a button
 * under 44dp; a page error. A stand-in for the phone, not an emulator: Android's fonts and line breaking differ. Nothing
 * leaves the machine. The browser: `pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium` once.
 *
 *   node apps/native/e2e/voice-320.mjs [--shots <dir>]
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
/** The sets a member picks from: Classic is the code's `dark`, Dark is `night`. */
const SETS = [['classic', 'dark'], ['light', 'light'], ['dark', 'night']];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-320-'));

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
        export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o['android'] ?? o.default };
        export const useWindowDimensions = () => ({ width: ${WIDTH}, height: 640, scale: 2, fontScale: ${SCALE} });
        export const AccessibilityInfo = { isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() {} }) };
        export const Alert = { alert: (...a) => { (globalThis.__alerts = globalThis.__alerts || []).push(a); } };
        export const Linking = { openSettings: async () => {} };
        export default { ...RNW, Text, TextInput, Platform, useWindowDimensions, AccessibilityInfo, Alert, Linking };
    `,
    'ThemeContext': `export const useTheme = () => globalThis.__theme; export const useStyles = (make) => make(globalThis.__theme);`,
    '@expo/vector-icons': `
        import React from 'react';
        import { Text } from 'react-native-web';
        const glyph = { microphone: '🎙', 'microphone-off': '🔇', send: '➤', play: '▶', pause: 'Ⅱ', 'delete-outline': '🗑', 'stop-circle-outline': '■', 'lock-outline': '🔒', 'chevron-up': '⌃', 'plus-circle-outline': '⊕' };
        export const MaterialCommunityIcons = ({ name, style, size, color }) => React.createElement(Text, { style: [{ fontSize: size, color: color || '#000', lineHeight: size }, style] }, glyph[name] || '•');
    `,
    '@react-native-async-storage/async-storage': `
        const store = () => globalThis.__store || (globalThis.__store = new Map());
        export default { getItem: async (k) => store().get(k) ?? null, setItem: async (k, v) => { store().set(k, v); }, removeItem: async (k) => { store().delete(k); } };
    `,
    'expo-file-system/legacy': `
        export const EncodingType = { Base64: 'base64' };
        export const deleteAsync = async () => {};
        export const readAsStringAsync = async () => 'AAAAFGZ0eXBNNEEgAAAAAE00QSA=';
        export const writeAsStringAsync = async () => {};
        export const getInfoAsync = async () => ({ exists: false });
        export const makeDirectoryAsync = async () => {};
        export const readDirectoryAsync = async () => [];
        export const documentDirectory = 'file:///doc/';
    `,
    'expo-crypto': `export const getRandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n)); export const randomUUID = () => crypto.randomUUID();`,
    'expo-audio': `
        import React from 'react';
        const g = globalThis;
        g.__audio = g.__audio || { recMs: 0, playing: false, pos: 0, dur: 0 };
        export const useAudioRecorder = () => React.useMemo(() => ({
            isRecording: false, uri: null,
            async prepareToRecordAsync() {},
            record() { this.isRecording = true; this.uri = 'file:///rec/voice.m4a'; },
            async stop() { this.isRecording = false; },
        }), []);
        export const useAudioRecorderState = (rec) => {
            const [, tick] = React.useState(0);
            React.useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 100); return () => clearInterval(t); }, []);
            return { canRecord: true, isRecording: !!rec.isRecording, durationMillis: g.__audio.recMs, metering: -14, mediaServicesDidReset: false, url: null };
        };
        export const useAudioPlayer = () => React.useMemo(() => ({ replace() {}, play() {}, pause() {}, async seekTo() {}, setPlaybackRate() {} }), []);
        export const useAudioPlayerStatus = () => ({ playing: g.__audio.playing, currentTime: g.__audio.pos, duration: g.__audio.dur, didJustFinish: false });
        export const setAudioModeAsync = async () => {};
        export const getRecordingPermissionsAsync = async () => ({ granted: true, canAskAgain: true, status: 'granted' });
        export const requestRecordingPermissionsAsync = async () => ({ granted: true, canAskAgain: true, status: 'granted' });
    `,
};
const STUBBED_FILES = ['ThemeContext'];
const stubFor = (spec) => {
    if (STUBS[spec] && !spec.startsWith('.')) return spec;
    if (!spec.startsWith('.')) return null;
    const base = path.basename(spec);
    return STUBBED_FILES.includes(base) ? base : null;
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { COLOUR_SETS } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { brandScheme } from '@beanpool/core';
import { makeChatStyles } from ${JSON.stringify(path.join(NATIVE, 'components/chat/styles'))};
import { ChatComposer } from ${JSON.stringify(path.join(NATIVE, 'components/chat/ChatComposer'))};
import { VoiceBubble } from ${JSON.stringify(path.join(NATIVE, 'components/chat/VoiceBubble'))};
import { VoicePlaybackProvider } from ${JSON.stringify(path.join(NATIVE, 'components/chat/VoicePlayback'))};

const q = new URLSearchParams(location.search);
const set = q.get('set') || 'light';
const colors = COLOUR_SETS[set];
const theme = brandScheme(set) === 'dark' ? 'dark' : 'light';
globalThis.__theme = { theme, colors };
const chat = makeChatStyles({ theme, colors });
const view = q.get('view') || 'composer';

const bars = (seed) => Array.from({ length: 48 }, (_, i) => Math.round(40 + 200 * Math.abs(Math.sin((i + seed) * 0.37))));
const ok = (ms, seed) => async () => ({ kind: 'ok', voice: { uri: 'file:///doc/voice/' + seed + '.m4a', durationMs: ms, bars: bars(seed) } });
const ROWS = [
    { id: 'a', me: false, load: ok(42_000, 1) },
    { id: 'b', me: true, load: ok(178_000, 2) },
    { id: 'c', me: false, load: async () => ({ kind: 'gone' }) },
    { id: 'd', me: true, load: async () => ({ kind: 'refused' }) },
    { id: 'e', me: false, load: async () => ({ kind: 'unavailable' }) },
];

const Bubbles = () => (
    <VoicePlaybackProvider owner="voice-320" voices={ROWS.map((r) => ({ id: r.id, mine: r.me }))}>
        <View style={[chat.listContent, { backgroundColor: colors.surface.page, flex: 1 }]}>
            {ROWS.map((r) => (
                <View key={r.id} style={[chat.messageRowContainer, r.me ? chat.messageRowMe : chat.messageRowOther]}>
                    <View testID={'row-' + r.id} style={[chat.messageBubble, r.me ? chat.messageMe : chat.messageOther]}>
                        <VoiceBubble messageId={r.id} isMe={r.me} load={r.load} />
                    </View>
                </View>
            ))}
        </View>
    </VoicePlaybackProvider>
);

const Composer = () => (
    <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.surface.page }}>
        <ChatComposer styles={chat} onSend={() => {}} onVoice={async () => {}} placeholder="Message..." accessibilityLabel="Message" bottomPadding={12} />
    </View>
);

createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', width: '100%', backgroundColor: colors.surface.app }}>
        {view === 'bubbles' ? <Bubbles /> : <Composer />}
    </View>
);
`);

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.png': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl', '.ttf': 'empty' },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.mjs', '.json'],
    nodePaths: [path.join(ROOT, 'node_modules'), path.join(NATIVE, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {}, versions: {} }; globalThis.global = globalThis;' },
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
const problems = [];
let states = 0;
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 640 }, deviceScaleFactor: 2 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => { console.error('PAGE ERROR:', e); errors.push(String(e)); });

    /** What a state must show: test ids present, and words on the page. */
    const expectIn = async (label, ids, words = []) => {
        for (const id of ids) if (!(await page.locator(`[data-testid="${id}"]`).count())) problems.push(`${label}: ${id} is not shown`);
        const text = await page.evaluate(() => document.body.innerText);
        for (const w of words) if (!text.includes(w)) problems.push(`${label}: "${w}" is not shown`);
    };

    const measure = async (label) => {
        states++;
        const found = await page.evaluate(({ WIDTH }) => {
            const out = [];
            const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
            const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
            const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
            const ratioOf = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
            const backdrop = (el) => {
                const layers = [];
                for (let e = el; e; e = e.parentElement) {
                    const c = rgb(getComputedStyle(e).backgroundColor);
                    if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
                }
                let under = { r: 255, g: 255, b: 255, a: 1 };
                for (const l of layers.reverse()) under = over(l, under);
                return under;
            };
            if (document.scrollingElement.scrollWidth > WIDTH) out.push('the page scrolls sideways (' + document.scrollingElement.scrollWidth + 'px)');
            const texts = [...document.querySelectorAll('div[dir], span, input, textarea')].filter((el) => {
                const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
                return own || ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value);
            });
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = (el.value ?? el.textContent).trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push('"' + what + '" runs past the edge (' + Math.round(r.left) + '–' + Math.round(r.right) + ')');
                if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible' && getComputedStyle(el).textOverflow !== 'ellipsis') out.push('"' + what + '" is cut on the right (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
                const cs = getComputedStyle(el);
                const fg = rgb(cs.color);
                if (!fg) continue;
                // Icons drawn as glyphs here: their colour is checked on the words beside them.
                if (/^[\p{Extended_Pictographic}️‍\s▶Ⅱ➤■⌃⊕•]+$/u.test(what)) continue;
                const bg = backdrop(el);
                const ratio = ratioOf(over(fg, bg), bg);
                const size = parseFloat(cs.fontSize);
                const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                if (ratio < (large ? 3 : 4.5)) out.push('"' + what + '" has contrast ' + ratio.toFixed(2) + ':1 (' + cs.color + ' on rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + '), ' + size + 'px)');
            }
            for (const el of document.querySelectorAll('[role="button"]')) {
                const r = el.getBoundingClientRect();
                if (r.width === 0) continue;
                if (r.height < 43.5 || r.width < 43.5) out.push('the button "' + (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40)) + '" is ' + Math.round(r.width) + '×' + Math.round(r.height) + 'dp');
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push('the button "' + el.getAttribute('aria-label') + '" runs past the edge');
            }
            return out;
        }, { WIDTH });
        for (const p of found) problems.push(`${label}: ${p}`);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label}.png`) }); }
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };

    const mic = () => page.locator('[data-testid="voice-mic"]');
    const setClock = (ms) => page.evaluate((v) => { globalThis.__audio.recMs = v; }, ms);

    for (const [name, set] of SETS) {
        // The composer: the microphone in Send's place.
        await page.goto(`${base}/?view=composer&set=${set}`);
        await page.waitForSelector('[data-testid="voice-mic"]');
        await setClock(0);
        await measure(`voice-mic-320-${name}`);

        // A hold too short: nothing sent, "Hold to record".
        let box = await mic().boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(150);
        await page.mouse.up();
        await page.waitForTimeout(250);
        await expectIn(`voice-hint-320-${name}`, ['voice-hint'], ['Hold to record']);
        await measure(`voice-hint-320-${name}`);

        // Holding at 0:42: the clock, "Slide to cancel", the lock above the microphone.
        await page.goto(`${base}/?view=composer&set=${set}`);
        await page.waitForSelector('[data-testid="voice-mic"]');
        box = await mic().boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(200);
        await setClock(42_000);
        await page.waitForTimeout(300);
        await expectIn(`voice-holding-320-${name}`, ['voice-bar', 'voice-slide', 'voice-clock'], ['0:42', 'Slide to cancel']);
        await measure(`voice-holding-320-${name}`);

        // Slid up: locked; let go and it keeps recording, with bin, Stop and Send.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 6 });
        await page.waitForTimeout(150);
        await page.mouse.up();
        await setClock(65_000);
        await page.waitForTimeout(300);
        await expectIn(`voice-locked-320-${name}`, ['voice-bin', 'voice-stop', 'voice-send'], ['1:05']);
        await measure(`voice-locked-320-${name}`);

        // At 3:00 it stops by itself and waits: bin, play, Send.
        await setClock(180_400);
        await page.waitForTimeout(400);
        await expectIn(`voice-review-320-${name}`, ['voice-bin', 'voice-preview', 'voice-send'], ['3:00']);
        await measure(`voice-review-320-${name}`);

        // The bubbles: one playing at 1.5×, and the three that can't play.
        await page.goto(`${base}/?view=bubbles&set=${set}`);
        await page.waitForSelector('[data-testid="voice-play"]');
        await page.evaluate(() => Object.assign(globalThis.__audio, { playing: true, pos: 12, dur: 42 }));
        await page.locator('[data-testid="voice-play"]').first().click();
        await page.waitForSelector('[data-testid="voice-speed"]');
        await page.locator('[data-testid="voice-speed"]').click();
        await page.waitForTimeout(300);
        await expectIn(`voice-bubbles-320-${name}`, [], ['1.5×']);
        await expectIn(`voice-bubbles-320-${name}`, ['voice-speed', 'voice-gone', 'voice-refused', 'voice-retry'],
            ['0:12', '2:58', 'This voice message is no longer on the server.', "This voice message can't be played.", 'Voice message unavailable. Tap to try again.']);
        await measure(`voice-bubbles-320-${name}`);
        await page.evaluate(() => Object.assign(globalThis.__audio, { playing: false, pos: 0, dur: 0 }));
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
console.log('All states hold at 320dp x 1.3 in Classic, Light and Dark: no sideways scroll, nothing past the edge, buttons 44dp and up, contrast passes.');
