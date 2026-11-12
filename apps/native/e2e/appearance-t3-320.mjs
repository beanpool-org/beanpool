#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * The look on the phone (colour themes T3): the Appearance list and a chat thread at the floor (memory
 * product-audience-small-screens: 320dp wide, the phone's text at 1.3x) in each of Classic, Light and Dark, and the list again in
 * the pseudo-locale (every sentence accented, padded and bracketed), through react-native-web in headless Chromium, as
 * e2e/chat-s1-45-320.mjs draws its screens.
 *
 * What is drawn is the app's own code, not a copy of it:
 *   - the list: components/AppearanceChoice.tsx, the very component app/(tabs)/settings.tsx renders in its Appearance block,
 *     inside a card with that block's header words, drawn from the library's tree for the set;
 *   - the thread: components/chat/ChatBubble.tsx with makeChatStyles (components/chat/styles.ts), the chat screens' own bubble and
 *     styles, two lines each way.
 * Stood in for, as the app's own tests do: the router, the device, storage, and the theme context (which hands out COLOUR_SETS[set]).
 * The Market is e2e/market-order-320.mjs --sets light,dark,night, which draws the real Market screen.
 *
 * Each state fails on: the page scrolling sideways; text past the 320 edge; a row under 48dp; the chosen row without its tick
 * or its border in the heading's ink at 3:1 against the card; a row's name or line under 4.5:1 on its row; the own bubble's words
 * under 4.5:1 on its fill; a letter outside a bracket in the pseudo-locale (it bypassed t()).
 *
 * A stand-in for the phone, not an emulator: Android's fonts and line breaking differ. Nothing leaves the machine: the page
 * aborts every request but its own.
 *
 *   node apps/native/e2e/appearance-t3-320.mjs --shots <dir>
 *
 * Colour themes T5 (the doodle): after the checks above, Classic and Dark are drawn once more with the app's own
 * components/PatternBackground behind them and the colours the app gives a screen with the wallpaper on (utils/drawn-colours: a
 * see-through page, the tile's ground as the chrome): the chat thread, and three of Home's real cards (components/home/HomeParts).
 * Pictures only (chat-<look>-doodle.png, home-<look>-doodle.png), plus "no page error" and "the wallpaper drawn from the tile of
 * its set": the drawn data URL is compared with the base64 of THAT set's own 1x file (Classic's pattern-dark.webp, Dark's
 * pattern-night.webp), so a look drawing another look's tile (the bug T5 fixed) fails. The tile is the 1x file at its own 890 dp
 * (a phone on a 2x screen draws the @2x).
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-t3-320-'));

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
        export const DeviceEventEmitter = { addListener() { return { remove() {} }; }, emit() {} };
        export default { ...RNW, Text, TextInput, Platform, DeviceEventEmitter };
    `,
    'ThemeContext': `export const useTheme = () => globalThis.__theme; export const useStyles = (make) => make(globalThis.__theme);`,
    'expo-router': `export const router = { back() {}, push() {}, navigate() {}, replace() {}, canGoBack: () => true };`,
    '@expo/vector-icons': `
        import React from 'react';
        import { Text } from 'react-native-web';
        export const MaterialCommunityIcons = ({ name, style, size, color }) => React.createElement(Text, { style: [{ fontSize: size, color: color || '#000' }, style] }, '•');
    `,
    '@react-native-async-storage/async-storage': `
        const store = () => globalThis.__store || (globalThis.__store = new Map());
        export default { getItem: async (k) => store().get(k) ?? null, setItem: async (k, v) => { store().set(k, v); }, removeItem: async (k) => { store().delete(k); } };
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
import { View, Text } from 'react-native';
import { setLanguage, t } from '@beanpool/core';
import { COLOUR_SETS } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { drawnColours } from ${JSON.stringify(path.join(NATIVE, 'utils/drawn-colours'))};
import PatternBackground from ${JSON.stringify(path.join(NATIVE, 'components/PatternBackground'))};
import { HomeCard, HomeRow, HomeLink, homeStyles } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};
import { AppearanceChoice } from ${JSON.stringify(path.join(NATIVE, 'components/AppearanceChoice'))};
import { ChatBubble } from ${JSON.stringify(path.join(NATIVE, 'components/chat/ChatBubble'))};
import { makeChatStyles } from ${JSON.stringify(path.join(NATIVE, 'components/chat/styles'))};

const q = new URLSearchParams(location.search);
const set = ['light', 'dark', 'night'].includes(q.get('set')) ? q.get('set') : 'dark';
const view = q.get('view') || 'settings';
const choice = q.get('choice') || 'dark';
if (q.get('lang') === 'xx') setLanguage('xx');
const doodle = q.get('doodle') === '1';
const colors = doodle ? drawnColours(set, true) : COLOUR_SETS[set];
globalThis.__theme = { theme: set === 'light' ? 'light' : 'dark', set, colors, patternEnabled: doodle };

const t0 = Date.now();
const clock = (n) => { const d = new Date(t0 - 60000 * (10 - n)); return d.toISOString(); };
const msg = (id, text, mine) => ({ id, senderId: mine ? 'me' : 'ben', text, type: 'text', outgoing: mine, rawTimestamp: clock(id.length), timestamp: ['17:00', '17:04', '17:09', '17:12'][id.length - 1], metadata: {} });
const styles = makeChatStyles(globalThis.__theme);

const Settings = () => (
    <View style={{ flex: 1, backgroundColor: colors.surface.page, padding: 20, justifyContent: 'center' }}>
        <View style={{ backgroundColor: colors.surface.card, borderRadius: 16, padding: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 36, alignItems: 'center', marginRight: 12 }}><Text style={{ fontSize: 22 }}>🌙</Text></View>
                <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text.heading }}>{t('Appearance')}</Text>
                    <Text style={{ fontSize: 12, color: colors.text.secondary }}>{t('How BeanPool looks on this phone')}</Text>
                </View>
            </View>
            <AppearanceChoice value={choice} onChange={() => {}} />
        </View>
    </View>
);

const Thread = () => (
    <View style={{ flex: 1, backgroundColor: doodle ? 'transparent' : colors.surface.app, justifyContent: 'center' }}>
        <View style={styles.listContent}>
            {[['1', 'Are you coming to the working bee on Saturday?', false], ['22', 'Yes, I will bring a spade and some gloves.', true],
              ['333', 'Lovely. We start at nine by the creek gate, and there is tea after.', false], ['4444', 'Thanks Ben, see you there.', true]].map(([id, text, mine]) => (
                <View key={id} style={[styles.messageRowContainer, mine ? styles.messageRowMe : styles.messageRowOther]}>
                    <ChatBubble item={msg(id, text, mine)} isMe={mine} styles={styles} kind="group" authorLabel={mine ? null : 'Ben'} />
                </View>
            ))}
        </View>
    </View>
);

// Three of Home's real cards, as app/(tabs)/index.tsx lists them for a member: Needs you, New in the Market, and the community card.
const hs = homeStyles(colors);
const noop = () => {};
const Home = () => (
    <View style={{ flex: 1, backgroundColor: 'transparent', paddingTop: 12 }}>
        <Text style={{ marginHorizontal: 16, marginBottom: 8, fontSize: 24, fontWeight: '800', color: colors.text.heading }}>Home</Text>
        <HomeCard id="needs" caption="Needs you" colors={colors} hue="amber" accent testID="home-card-needs">
            <HomeRow colors={colors} text="Kofi sent you a message" a11y="Kofi sent you a message" onPress={noop} />
            <HomeRow colors={colors} text="Your event Seed swap has 3 new answers" a11y="Your event Seed swap has 3 new answers" onPress={noop} />
        </HomeCard>
        <HomeCard id="market" caption="New in the Market" colors={colors} hue="orange" testID="home-card-market">
            <HomeRow colors={colors} text="Sourdough" sub="OFFER · 12 Beans" a11y="Sourdough" onPress={noop} left={<View style={[hs.thumb, hs.thumbEmpty]} />} />
            <HomeRow colors={colors} text="Help moving a couch" sub="NEED · labour" a11y="Help moving a couch" onPress={noop} left={<View style={[hs.thumb, hs.thumbEmpty]} />} />
            <HomeLink id="market" text="See all" a11y="See all" onPress={noop} colors={colors} />
        </HomeCard>
        <HomeCard id="community" caption="The community" colors={colors} hue="sage" testID="home-card-community">
            <Text style={hs.note}>81 members, 23 trades this month.</Text>
        </HomeCard>
    </View>
);

createRoot(document.getElementById('root')).render(
    <View data-view={view} data-set={set} style={{ height: '100vh', width: '100%', backgroundColor: doodle ? 'transparent' : colors.surface.app }}>
        {doodle ? <PatternBackground /> : null}
        {view === 'settings' ? <Settings /> : view === 'home' ? <Home /> : <Thread />}
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

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
let failures = 0;
const check = (ok, what) => {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures++; console.log(`  ✗ ${what}`); }
};

/** In the page: the geometry and colours of the list's rows, or of the thread's bubbles. */
const READ = () => {
    const rgb = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    /** What is behind an element: the first opaque background up its ancestors. */
    const behind = (el) => { for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.a > 0.99) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const out = { sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth, past: [], rows: [], bubbles: [], letters: [] };
    for (const el of document.querySelectorAll('#root *')) {
        const r = el.getBoundingClientRect();
        if (el.children.length === 0 && (el.textContent || '').trim() && r.right > 320.5) out.past.push((el.textContent || '').trim().slice(0, 40));
    }
    for (const radio of document.querySelectorAll('[role="radio"]')) {
        const rect = radio.getBoundingClientRect();
        const spans = Array.from(radio.querySelectorAll('div[dir="auto"], span, div')).filter((e) => e.children.length === 0 && (e.textContent || '').trim());
        const texts = spans.map((e) => ({ text: e.textContent.trim(), ratio: ratio(rgb(getComputedStyle(e).color), behind(e)), right: e.getBoundingClientRect().right }));
        const cs = getComputedStyle(radio);
        const card = behind(radio.parentElement);
        out.rows.push({
            label: radio.getAttribute('aria-label'), checked: (radio.textContent || '').includes('✓') ? 'true' : 'false', ariaChecked: radio.getAttribute('aria-checked'), height: rect.height, width: rect.width,
            border: cs.borderTopColor, borderRatio: ratio(rgb(cs.borderTopColor), card), texts,
            tick: (radio.textContent || '').includes('✓'),
        });
    }
    // The own lines' words: the element whose own text is the message (the time is a Text inside it).
    const mine = Array.from(document.querySelectorAll('#root *')).filter((e) => Array.from(e.childNodes).some((n) => n.nodeType === 3 && /Thanks Ben|bring a spade/.test(n.nodeValue || '')));
    for (const w of mine) out.bubbles.push({ text: w.textContent.slice(0, 30), ratio: ratio(rgb(getComputedStyle(w).color), behind(w)), fill: behind(w) });
    return out;
};

const SETS = [['light', 'Light'], ['dark', 'Classic'], ['night', 'Dark']];
const CHOICE = { light: 'light', dark: 'dark', night: 'night' };
try {
    for (const [set, name] of SETS) {
        for (const lang of ['en', 'xx']) {
            const page = await browser.newPage({ viewport: { width: WIDTH, height: 700 }, deviceScaleFactor: 2 });
            const errors = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            await page.route((u) => u.hostname !== '127.0.0.1', (route) => route.abort());
            await page.goto(`${base}/?view=settings&set=${set}&choice=${CHOICE[set]}&lang=${lang}`);
            await page.waitForTimeout(700);
            const r = await page.evaluate(READ);
            console.log(`\nsettings / ${name}${lang === 'xx' ? ' / pseudo-locale' : ''}`);
            check(errors.length === 0, `no page error${errors[0] ? `: ${errors[0]}` : ''}`);
            check(!r.sideways && r.past.length === 0, `nothing scrolls sideways or runs past the 320 edge${r.past.length ? ` (${r.past.join(' | ')})` : ''}`);
            check(r.rows.length === 4, `four rows (${r.rows.map((x) => x.label).join(', ')})`);
            check(r.rows.every((x) => x.height >= 48), `every row at least 48dp (${r.rows.map((x) => Math.round(x.height)).join(', ')})`);
            const chosen = r.rows.filter((x) => x.checked === 'true');
            check(chosen.length === 1 && chosen[0].tick, `one row chosen, with its tick (${chosen.map((x) => x.label).join(',')})`);
            check(chosen.length === 1 && chosen[0].borderRatio >= 3, `the chosen row's border reads against the card at ${chosen[0]?.borderRatio.toFixed(2)}:1 (3:1 needed)`);
            const worst = Math.min(...r.rows.flatMap((x) => x.texts.map((t) => t.ratio)));
            check(worst >= 4.5, `every row's words read at ${worst.toFixed(2)}:1 or more on their row`);
            if (lang === 'xx') {
                const letters = await page.evaluate(() => Array.from(document.querySelectorAll('#root *')).filter((e) => e.children.length === 0 && /\p{L}/u.test((e.textContent || '').replace(/\[[^\]]*\]/g, ''))).map((e) => e.textContent.trim()));
                check(letters.length === 0, `every word is bracketed: none bypassed t()${letters.length ? ` (${letters.join(' | ')})` : ''}`);
            }
            if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `settings-${name.toLowerCase()}${lang === 'xx' ? '-pseudo' : ''}.png`) });
            await page.close();
        }
        const page = await browser.newPage({ viewport: { width: WIDTH, height: 700 }, deviceScaleFactor: 2 });
        await page.route((u) => u.hostname !== '127.0.0.1', (route) => route.abort());
        await page.goto(`${base}/?view=chat&set=${set}`);
        await page.waitForTimeout(700);
        const r = await page.evaluate(READ);
        console.log(`\nchat / ${name}`);
        check(!r.sideways && r.past.length === 0, 'nothing scrolls sideways or runs past the 320 edge');
        const own = r.bubbles.filter((b) => /Thanks Ben|bring a spade/.test(b.text));
        check(own.length === 2 && own.every((b) => b.ratio >= 4.5), `the own bubble's words read at ${Math.min(...own.map((b) => b.ratio)).toFixed(2)}:1 (4.5 needed), fill ${JSON.stringify(own[0]?.fill)}`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `chat-${name.toLowerCase()}.png`) });
        await page.close();
    }
    // The doodle (T5): the chat thread and Home's cards over each look's own tile, Classic's olive one and Dark's charcoal one.
    for (const [set, name] of SETS.filter(([x]) => x !== 'light')) {
        for (const view of ['chat', 'home']) {
            const page = await browser.newPage({ viewport: { width: WIDTH, height: 700 }, deviceScaleFactor: 2 });
            const errors = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            await page.route((u) => u.hostname !== '127.0.0.1', (route) => route.abort());
            await page.goto(`${base}/?view=${view}&set=${set}&doodle=1`);
            await page.waitForTimeout(900);
            // The wallpaper is a background image of the tile the app picks for the set (react-native-web draws the Image as one).
            const tile = await page.evaluate(() => {
                const el = Array.from(document.querySelectorAll('#root *')).find((e) => /^url\("data:image\/webp/.test(getComputedStyle(e).backgroundImage));
                if (!el) return null;
                const m = /^url\("data:image\/webp;base64,([^"]+)"\)/.exec(getComputedStyle(el).backgroundImage);
                return m ? { data: m[1] } : null;
            });
            console.log(`\n${view} on the doodle / ${name}`);
            check(errors.length === 0, `no page error${errors[0] ? `: ${errors[0]}` : ''}`);
            // The set's own 1x file, as esbuild's dataurl loader embeds it: the base64 of its bytes. Only Classic's and Dark's are drawn here.
            const own = fs.readFileSync(path.join(NATIVE, 'assets/images', set === 'night' ? 'pattern-night.webp' : 'pattern-dark.webp')).toString('base64');
            const other = fs.readFileSync(path.join(NATIVE, 'assets/images', set === 'night' ? 'pattern-dark.webp' : 'pattern-night.webp')).toString('base64');
            check(tile !== null && tile.data === own, `the wallpaper is the tile of its set (${tile?.data.length} base64 characters drawn, ${own.length} in ${set === 'night' ? 'pattern-night' : 'pattern-dark'}.webp)`);
            check(tile !== null && tile.data !== other, `and not the other look's tile (${other.length} characters)`);
            if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${view}-${name.toLowerCase()}-doodle.png`) });
            await page.close();
        }
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
