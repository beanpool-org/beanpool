#!/usr/bin/env node
/* global process, console, document */
/**
 * Learn's tags on the phone (16 Nov 2026; the node is #3219; components/learn/KnowledgeDetail.tsx, app/learn/new.tsx, the
 * Market's components/TagPicker.tsx free tags alone), at the floor (320dp wide, phone text at 1.3x), in Light, Classic and Dark:
 * the app's own page and form through react-native-web in headless Chromium, the node's answers given here (utils/db stubbed).
 * A stand-in for the phone, not the phone: Android's fonts and line breaking differ. Built on learn-keep-320.mjs.
 *   a page with its tags under Where; "Suggest a fix" holding the page's tags; the Tags sheet open (free tags alone).
 *
 * Checks, per look and state: no sideways scroll; nothing past the 320dp edge; every button at least 44dp tall. Screenshots
 * with --shots <dir>.
 *
 *   node apps/native/e2e/learn-tags-320.mjs [--shots <dir>]
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
const HEIGHT = 900;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-tags-320-'));
const ME = 'me'.padEnd(64, '0');

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
        export const Alert = { alert() {} };
        export const DeviceEventEmitter = { addListener: () => ({ remove() {} }), emit() {} };
        export default { ...RNW, Text, TextInput, Platform, Alert };
    `,
    // The case's facts, from the address: which page, who reads it, and the node's answers.
    case: `
        const q = new URLSearchParams(location.search);
        const ME = '${ME}';
        const at = (d) => new Date(Date.now() - d * 86400000).toISOString();
        const page = (id, o = {}, k = {}) => ({
            id, title: 'How recycling works at the tip', description: 'Bring glass, cans and paper sorted into their own boxes.\\n\\nThe tip is open every day but Monday, 8 to 4.',
            category: 'local-services', photos: [], authorPublicKey: 'ada'.padEnd(64, '0'), authorCallsign: 'Ada', status: 'active', active: true,
            knowledge: { sources: [{ url: 'https://www.council.example/waste/tip', label: 'Council tip page' }], place: 'The tip on Manse Road', lang: null,
                checkedAt: at(20), outdatedAt: null, outdatedNote: null, helped: 2, gathered: false, ...k },
            ...o,
        });
        export const PAGES = {
            tip: page('tip', { freeTags: ['bulk waste', 'tip shop', 'glass and cans', 'kerbside'] }),
            mine: page('mine', { authorPublicKey: ME, authorCallsign: 'You' }),
            old: page('old', { title: 'Bus times to the station' }, { outdatedAt: at(2), outdatedNote: 'The timetable changed in March: check the new one.' }),
        };
        export const C = { screen: q.get('screen') || 'page', page: q.get('page') || 'tip', checks: q.get('checks') === '1' };
    `,
    db: `
        import { PAGES } from 'case';
        export const getKnowledgePost = async (id) => PAGES[id] ?? null;
        export const signedGet = async () => { throw new Error('offline'); };
        export const signedRequestWithMethod = async (method, path, body) => {
            if (path.endsWith('/helped')) return { helped: 3, helpedByMe: true };
            if (path === '/api/knowledge/drafts') return { draft: { id: 'fx', kind: 'fix', fixOf: 'tip' } };
            return {};
        };
        export const reportAbuse = async () => ({});
        export const getMemberRatings = async () => ({ average: null, count: 0 });
    `,
    'expo-router': `
        import { useEffect } from 'react';
        import { C } from 'case';
        const router = { push() {}, back() {}, replace() {}, navigate() {}, canGoBack: () => true };
        export const useRouter = () => router;
        export const useLocalSearchParams = () => (C.screen === 'fix' ? { fix: C.page } : {});
        export const useFocusEffect = (fn) => { useEffect(() => fn(), [fn]); };
        export { router };
    `,
    identity: `export const useIdentity = () => ({ identity: { publicKey: '${ME}', privateKey: 'p' } });`,
    mode: `export const useLearnMode = () => 'live';`,
    writer: `
        import { C } from 'case';
        export const useLearnWriter = () => ({ checks: C.checks, waiting: 0 });
        export const forgetLearnRole = async () => {};
        export const readMyDrafts = async () => null;
    `,
    insets: `export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });`,
    keyboard: `import { ScrollView, View } from 'react-native'; export const KeyboardAwareScrollView = ScrollView;
        export const KeyboardAvoidingView = View; export const KeyboardController = { dismiss: async () => {} };`,
    // The Market's picker, as it is, with what needs a device standing in: its icons, haptics and the keyboard's wait.
    icons: `export const MaterialCommunityIcons = () => null;`,
    haptics: `export const hapticTick = () => {}; export const hapticWarning = () => {};`,
    dismiss: `export const dismissKeyboardWithin = async (fn) => { await fn(); };`,
    communityTags: `export const loadCommunityTags = async () => []; export const loadLibraryTagFor = async () => null;`,
    image: `export const Image = () => null;`,
    author: `
        import React from 'react';
        import { Text, View } from 'react-native';
        export const useMemberRating = () => ({ average: null, count: 0 });
        export const AuthorCard = ({ label, callsign }) => React.createElement(View, { style: { padding: 12, borderWidth: 1, borderColor: '#8884', borderRadius: 12 } },
            React.createElement(Text, { style: { fontSize: 11, color: '#888' } }, label), React.createElement(Text, { style: { fontSize: 16, fontWeight: '700', color: '#888' } }, callsign));
    `,
    none: `export const PhotoCarousel = () => null; export const ReportReasonBox = () => null; export const ChatPhotoViewer = () => null;
        export const askForPostPhoto = () => {}; export const signedRequestWords = (m) => m; export const reportedAlertBody = () => '';`,
    languages: `export const LANGUAGE_NAMES = { en: 'English', es: 'Español' };`,
};
const ROUTES = [
    [/^react-native$/, 'react-native'],
    [/utils\/db$/, 'db'],
    [/^expo-router$/, 'expo-router'],
    [/IdentityContext$/, 'identity'],
    [/use-learn-mode$/, 'mode'],
    [/useLearnWriter$/, 'writer'],
    [/^react-native-safe-area-context$/, 'insets'],
    [/^react-native-keyboard-controller$/, 'keyboard'],
    [/^expo-image$/, 'image'],
    [/components\/AuthorCard$|\.\.\/AuthorCard$/, 'author'],
    [/PhotoCarousel$|ReportReasonBox$|chat\/ChatPhoto$|post-photo$|signed-request-lines$|reportReasons$/, 'none'],
    [/language-choice$/, 'languages'],
    [/^@expo\/vector-icons$/, 'icons'],
    [/utils\/haptics$/, 'haptics'],
    [/utils\/keyboard-dismiss$/, 'dismiss'],
    [/utils\/community-tags$/, 'communityTags'],
    [/^case$/, 'case'],
];

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { COLOUR_SETS } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { KnowledgeDetail } from ${JSON.stringify(path.join(NATIVE, 'components/learn/KnowledgeDetail'))};
import NewKnowledgeScreen from ${JSON.stringify(path.join(NATIVE, 'app/learn/new'))};
import { C, PAGES } from 'case';

const colors = COLOUR_SETS[new URLSearchParams(location.search).get('set') || 'light'];
createRoot(document.getElementById('root')).render(
    <View testID="case-root" style={{ backgroundColor: colors.surface.app, minHeight: ${HEIGHT}, width: ${WIDTH} }}>
        {C.screen === 'fix' ? <NewKnowledgeScreen /> : <KnowledgeDetail page={PAGES[C.page]} />}
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
                if (/ThemeContext$/.test(args.path)) return { path: 'theme', namespace: 'stub' };
                for (const [re, name] of ROUTES) if (re.test(args.path)) return { path: name, namespace: 'stub' };
                return undefined;
            });
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
                if (args.path === 'theme') {
                    return { loader: 'jsx', resolveDir: NATIVE, contents: `
                        import { COLOUR_SETS } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
                        const set = new URLSearchParams(location.search).get('set') || 'light';
                        const theme = { colors: COLOUR_SETS[set], theme: set === 'light' ? 'light' : 'dark' };
                        export const useTheme = () => theme;
                        export const useStyles = (make) => make(theme);
                    ` };
                }
                return { contents: STUBS[args.path], loader: 'jsx', resolveDir: NATIVE };
            });
        },
    }],
});

const bundle = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<script>window.process = window.process || { env: {} }; window.global = window;</script>
<style>html,body,#root{margin:0} body{font-family:sans-serif}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// [state, query, taps, [field, text] typed before the last tap]
const STATES = [
    ['page-tags', 'page=tip', []],
    ['fix-form-tags', 'screen=fix&page=tip', []],
    ['tags-sheet', 'screen=fix&page=tip', ['label:+ Add tag']],
];
// The phone's looks: Light, Classic (the set 'dark') and Dark (the set 'night').
const LOOKS = [['light', 'light'], ['classic', 'dark'], ['dark', 'night']];

const problems = [];
const check = (ok, what) => { if (!ok) { problems.push(what); console.error(`  x ${what}`); } };
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e}`));
    for (const [look, set] of LOOKS) {
        for (const [name, query, taps, typed] of STATES) {
            await page.goto(`${base}/?set=${set}&${query}`);
            await page.getByTestId('case-root').waitFor();
            await page.getByTestId(query.includes('screen=fix') ? 'learn-new' : 'knowledge-page').waitFor();
            await page.waitForTimeout(150);
            if (typed) await page.getByTestId(typed[0]).fill(typed[1]);
            for (const id of taps) {
                await (id.startsWith('label:') ? page.getByLabel(id.slice(6), { exact: true }) : page.getByTestId(id)).click();
                await page.waitForTimeout(300);
            }
            await page.waitForTimeout(150);
            const m = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('[role="button"], [role="link"], button'));
                return {
                    wide: document.documentElement.scrollWidth,
                    buttons: els.map((b) => { const r = b.getBoundingClientRect(); return { text: (b.textContent || '').slice(0, 40), h: r.height, w: r.width, right: r.right }; }),
                };
            });
            check(m.wide <= WIDTH, `${look} ${name}: no sideways scroll (${m.wide} wide)`);
            for (const b of m.buttons) {
                if (b.w === 0) continue;
                check(b.h >= 43.5, `${look} ${name}: "${b.text}" is ${b.h.toFixed(1)}dp tall, under 44`);
                check(b.right <= WIDTH + 0.5, `${look} ${name}: "${b.text}" runs past the edge (${b.right.toFixed(1)})`);
            }
            console.log(`${look} ${name}: done`);
            if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `phone-learn-tags-320-${look}-${name}.png`), fullPage: true });
        }
    }
} finally {
    await browser.close();
    server.close();
}
if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
    process.exit(1);
}
console.log('phone learn-tags-320: passed');
process.exit(0);
