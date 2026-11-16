#!/usr/bin/env node
/* global process, console, document */
/**
 * Learn's recognition on the phone (DESIGN-local-knowledge-fable.md §2.10, §3.7; slice K8), at the floor (320dp wide, the
 * phone's text at 1.3×), in Light, Classic and Dark: the app's own KnowledgeDetail with the real AuthorCard, and its own Ledger
 * (app/(tabs)/ledger.tsx) opened by "🫘 Thank Ada" (the route's sendTo / sendName / sendNote), through react-native-web in
 * headless Chromium, the node's answers given here. The same states as the web's apps/pwa/e2e/learn-thank-320.mjs:
 *   a member on Ada's page ("🗺️ Local guide" on her card, "🫘 Thank Ada", whose tap pushes the Ledger with Ada and the note);
 *   the Ledger for a member who can send (the Beans form, Ada chosen, the note filled, no amount); for one whose first trade is
 *   still to come and one with no Beans to send (today's alert, word for word, and no form).
 *
 * A stand-in for the phone, not the phone: Android's fonts and line breaking differ, and the refusal is Android's own alert,
 * so it is checked by its words, not drawn. Checks, per look and state: no sideways scroll; nothing past the 320dp edge; every
 * button at least 44dp tall; what each state should say or hold is there; the Ledger writes nothing on its own. Nothing leaves
 * the machine: the page aborts every request but its own. Screenshots with --shots <dir>.
 *
 *   node apps/native/e2e/learn-thank-320.mjs [--shots <dir>]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-thank-320-'));
const ME = 'me'.padEnd(64, '0');
const ADA = 'ada'.padEnd(64, '0');
const TITLE = 'How recycling works at the tip';
const NOTE = `Thanks for "${TITLE}"`;
const ALERTS = {
    'first-trade': ['First trade required', 'Direct sends are unlocked after your first completed trade on the Marketplace, and require a positive balance.'],
    'positive-balance': ['Positive balance required', 'You can only send beans you currently hold — direct sends require a positive balance.'],
};

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
        export const DeviceEventEmitter = { addListener: () => ({ remove() {} }), emit() {} };
        export default { ...RNW, Text, TextInput, Platform };
    `,
    // The case, from the address: which screen, which look, and the reader's own figures.
    case: `
        const q = new URLSearchParams(location.search);
        export const C = { screen: q.get('screen') || 'page', reader: q.get('reader') || 'can-send', set: q.get('set') || 'light' };
        const FIGURES = { 'can-send': [12000, 300], 'first-trade': [12000, 0], 'positive-balance': [0, 300] };
        const [balance_c, earnedCredit_c] = FIGURES[C.reader];
        export const BALANCE = {
            balance_c, earnedCredit_c, floor_c: -15300, usableFloor_c: -15300, liveOffers: 1, activated: true, frozen: false, creditFrozen: false,
            knownFrozen: false, knownGrant_c: 0, roomHeld_c: 15000, tier: { name: 'Newcomer', emoji: '🌱' }, tierCredit_c: 300,
            grantedCredit_c: 0, qualifiedValue_c: 1000, avgRating: 5, reviewCount: 0, commons_c: 0, trustStats: { uniquePartners: 1 },
        };
        const at = (d) => new Date(Date.now() - d * 86400000).toISOString();
        export const PAGE = {
            id: 'tip', title: ${JSON.stringify(TITLE)}, description: 'Bring glass, cans and paper sorted into their own boxes.\\n\\nThe tip is open every day but Monday, 8 to 4.',
            category: 'local-services', photos: [], authorPublicKey: '${ADA}', authorCallsign: 'Ada', status: 'active', active: true,
            knowledge: { sources: [{ url: 'https://www.council.example/waste/tip', label: 'Council tip page' }], place: 'The tip on Manse Road', lang: null,
                checkedAt: at(20), outdatedAt: null, outdatedNote: null, helped: 4, gathered: false },
        };
        // The route's params the Ledger is opened with (KnowledgeDetail's push), one object for the screen's life.
        export const OPENER = C.screen === 'ledger' ? { sendTo: '${ADA}', sendName: 'Ada', sendNote: ${JSON.stringify(NOTE)} } : {};
        globalThis.__pushed = []; globalThis.__setParams = []; globalThis.__alerts = []; globalThis.__writes = [];
    `,
    db: `
        import { BALANCE, PAGE } from 'case';
        const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
        // The read by id answers the writer's badge (K8) and this member's tap, as the node does for a signed read.
        export const signedGet = async (path) => {
            if (path.startsWith('/api/marketplace/posts')) return json([{ ...PAGE, knowledge: { ...PAGE.knowledge, helpedByMe: false, writerLocalGuide: true } }]);
            if (path === '/api/credit/gift') return json({ offered: false });
            return json({});
        };
        export const signedRequestWithMethod = async (method, path) => { globalThis.__writes.push(method + ' ' + path); return {}; };
        export const signedRequest = async (path) => { globalThis.__writes.push('POST ' + path); return {}; };
        export const sendTransfer = async () => { globalThis.__writes.push('send'); return {}; };
        export const reportAbuse = async () => ({});
        export const getMemberRatings = async () => ({ average: 4.8, count: 6 });
        export const getBalance = async () => BALANCE;
        export const getTransactions = async () => [];
        export const getMemberProfile = async () => ({ avatar_url: null });
        export const getAllCommunityMembers = async () => [{ publicKey: 'mia-key', callsign: 'Mia' }];
        export const getPledgeHistory = async () => [];
        export const getEscrowTotal = async () => 0;
        export const refreshBalanceFromServer = async () => null;
    `,
    'expo-router': `
        import { useEffect } from 'react';
        import { OPENER } from 'case';
        export const router = {
            push(to) { globalThis.__pushed.push(to); }, back() {}, replace() {}, navigate() {}, canGoBack: () => true,
            setParams(p) { globalThis.__setParams.push(p); },
        };
        export const useRouter = () => router;
        export const useLocalSearchParams = () => OPENER;
        export const useFocusEffect = (fn) => { useEffect(() => fn(), [fn]); };
        export const useNavigation = () => ({ addListener: () => () => {}, isFocused: () => true });
    `,
    alert: `
        export const Alert = { alert(title, message) { globalThis.__alerts.push([title, message]); } };
    `,
    identity: `const value = { identity: { publicKey: '${ME}', privateKey: 'p', callsign: 'Ana' } }; export const useIdentity = () => value;`,
    mode: `export const useLearnMode = () => 'live';`,
    features: `export const useShowcaseModeOnceKnown = () => 'live'; export const useShowcaseMode = () => 'live';`,
    writer: `export const useLearnWriter = () => ({ checks: false, waiting: 0 }); export const forgetLearnRole = async () => {}; export const readMyDrafts = async () => null;`,
    insets: `export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });`,
    keyboard: `
        import React from 'react';
        import { View, ScrollView } from 'react-native-web';
        export const KeyboardAvoidingView = ({ children, style }) => React.createElement(View, { style }, children);
        export const KeyboardAwareScrollView = React.forwardRef((p, ref) => React.createElement(ScrollView, { ...p, ref }));
    `,
    image: `export const Image = () => null;`,
    icons: `
        import React from 'react';
        import { Text } from 'react-native-web';
        const GLYPH = { 'chevron-down': '▾', 'chevron-up': '▴', 'close': '×', 'send': '➤', 'lock-outline': '🔒', 'information-outline': 'ⓘ' };
        export const MaterialCommunityIcons = ({ name, size = 14, color }) => React.createElement(Text, { 'data-icon': name, style: { fontSize: size, lineHeight: size + 2, color } }, GLYPH[name] ?? '•');
        export const Ionicons = MaterialCommunityIcons;
    `,
    files: `export const cacheDirectory = 'file:///cache/'; export const EncodingType = { UTF8: 'utf8' }; export const writeAsStringAsync = async () => {};`,
    sharing: `export const shareAsync = async () => {};`,
    gradient: `
        import React from 'react';
        import { View } from 'react-native-web';
        export const LinearGradient = ({ children, style }) => React.createElement(View, { style }, children);
    `,
    storage: `export default { getItem: async (k) => (k === 'beanpool_anchor_url' ? 'https://riverside.example' : null), setItem: async () => {}, removeItem: async () => {} };`,
    haptics: `export const hapticSuccess = () => {}; export const hapticWarning = () => {};`,
    blocklist: `export const getBlockedUsers = async () => []; export const BLOCKLIST_UPDATED_EVENT = 'blocklist_updated';`,
    avatar: `
        import React from 'react';
        import { View } from 'react-native';
        export const MemberAvatar = ({ size = 40 }) => React.createElement(View, { style: { width: size, height: size, borderRadius: size / 2, backgroundColor: '#c8a26a' } });
    `,
    postsView: `export const isHiddenAuthor = () => false;`,
    none: `
        export const CreditBar = () => null; export const RepaymentCard = () => null; export const CommonsInfoModal = () => null;
        export const TrustBadge = () => null; export const LocalCommunityMark = () => null; export const LocalCommunitySheet = () => null;
        export const ExampleHeader = () => null; export const PhotoCarousel = () => null; export const ReportReasonBox = () => null;
        export const ChatPhotoViewer = () => null; export const reportedAlertBody = () => '';
    `,
    languages: `export const LANGUAGE_NAMES = { en: 'English', es: 'Español' };`,
};
const ROUTES = [
    [/^react-native$/, 'react-native'],
    [/^case$/, 'case'],
    [/^\..*(^|\/)db$/, 'db'],
    [/^expo-router$/, 'expo-router'],
    [/keyboard-alert$/, 'alert'],
    [/IdentityContext$/, 'identity'],
    [/use-learn-mode$/, 'mode'],
    [/use-reader-features$/, 'features'],
    [/useLearnWriter$/, 'writer'],
    [/^react-native-safe-area-context$/, 'insets'],
    [/^react-native-keyboard-controller$/, 'keyboard'],
    [/^expo-image$/, 'image'],
    [/^@expo\/vector-icons$/, 'icons'],
    [/^expo-file-system\/legacy$/, 'files'],
    [/^expo-sharing$/, 'sharing'],
    [/^expo-linear-gradient$/, 'gradient'],
    [/^@react-native-async-storage\/async-storage$/, 'storage'],
    [/(^|\/)haptics$/, 'haptics'],
    [/(^|\/)blocklist$/, 'blocklist'],
    [/(^|\/)MemberAvatar$/, 'avatar'],
    [/(^|\/)posts-view$/, 'postsView'],
    [/(^|\/)(CreditBar|RepaymentCard|CommonsInfoModal|TrustBadge|LocalCommunityMark|PhotoCarousel|ReportReasonBox|reportReasons)$|chat\/ChatPhoto$/, 'none'],
    [/language-choice$/, 'languages'],
];

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { COLOUR_SETS } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { KnowledgeDetail } from ${JSON.stringify(path.join(NATIVE, 'components/learn/KnowledgeDetail'))};
import LedgerScreen from ${JSON.stringify(path.join(NATIVE, 'app/(tabs)/ledger'))};
import { C, PAGE } from 'case';

const colors = COLOUR_SETS[C.set];
createRoot(document.getElementById('root')).render(
    <View testID="case-root" style={{ backgroundColor: colors.surface.app, minHeight: ${HEIGHT}, width: ${WIDTH} }}>
        {C.screen === 'ledger' ? <LedgerScreen /> : <KnowledgeDetail page={PAGE} beansLive />}
    </View>
);
`);

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'empty' },
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

// The phone's looks: Light, Classic (the set 'dark') and Dark (the set 'night').
const LOOKS = [['light', 'light'], ['classic', 'dark'], ['dark', 'night']];
const STATES = [
    { name: 'page-member', query: 'screen=page', ready: 'knowledge-thank' },
    { name: 'ledger-can-send', query: 'screen=ledger&reader=can-send', ready: 'send-confirm', reader: 'can-send' },
    { name: 'ledger-first-trade', query: 'screen=ledger&reader=first-trade', ready: 'ledger-wallet-tab', reader: 'first-trade' },
    { name: 'ledger-positive-balance', query: 'screen=ledger&reader=positive-balance', ready: 'ledger-wallet-tab', reader: 'positive-balance' },
];

const problems = [];
const check = (ok, what) => { if (!ok) { problems.push(what); console.error(`  x ${what}`); } };
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e}`));
    for (const [look, set] of LOOKS) {
        for (const st of STATES) {
            const label = `${look} ${st.name}`;
            await page.goto(`${base}/?set=${set}&${st.query}`);
            await page.getByTestId('case-root').waitFor();
            await page.getByTestId(st.ready).first().waitFor();
            await page.waitForTimeout(400);
            const m = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('[role="button"], [role="link"], button'));
                const byId = (id) => document.querySelector(`[data-testid="${id}"]`);
                const memo = document.querySelector('input[aria-label="Memo"]');
                const amount = document.querySelector('input[aria-label="Amount to send"]');
                // The Send form Thank opens: the box holding the chosen recipient, the note and Confirm (none when Thank is refused).
                let form = byId('send-confirm');
                while (form && !(form.querySelector('input[aria-label="Memo"]') && [...form.querySelectorAll('[role="button"]')].some((b) => b.textContent.includes('Ada')))) form = form.parentElement;
                return {
                    wide: document.documentElement.scrollWidth,
                    buttons: els.map((b) => { const r = b.getBoundingClientRect(); return { text: (b.textContent || '').slice(0, 40), h: r.height, w: r.width, right: r.right, inForm: !!form && form.contains(b) }; }),
                    badge: byId('author-badge')?.textContent ?? null,
                    thank: byId('knowledge-thank')?.textContent ?? null,
                    memo: memo ? memo.value : null,
                    amount: amount ? amount.value : null,
                    locked: !!byId('send-beans-locked'),
                    form: !!byId('send-confirm'),
                    text: document.body.textContent,
                    pushed: globalThis.__pushed, setParams: globalThis.__setParams, alerts: globalThis.__alerts, writes: globalThis.__writes,
                };
            });
            check(m.wide <= WIDTH, `${label}: no sideways scroll (${m.wide} wide)`);
            // 44dp: every button on the Learn page, and every button in the Send form Thank opens. The rest of the Ledger is
            // as main draws it (this slice changes none of it): its buttons under 44dp are listed, not failed.
            const older = [];
            for (const b of m.buttons) {
                if (b.w === 0) continue;
                if (st.name === 'page-member' || b.inForm) check(b.h >= 43.5, `${label}: "${b.text}" is ${b.h.toFixed(1)}dp tall, under 44`);
                else if (b.h < 43.5) older.push(`"${b.text}" ${b.h.toFixed(0)}dp`);
                check(b.right <= WIDTH + 0.5, `${label}: "${b.text}" runs past the edge (${b.right.toFixed(1)})`);
            }
            if (older.length) console.log(`  (${label}: the Ledger's own buttons under 44dp, unchanged by this slice: ${older.join(', ')})`);
            if (st.reader === 'can-send') check(m.buttons.some((b) => b.inForm), `${label}: the Send form wasn't found to measure`);
            check(m.writes.length === 0, `${label}: written without the member sending: ${m.writes.join(', ')}`);
            if (st.name === 'page-member') {
                check(m.badge === '🗺️ Local guide', `${label}: the writer's card says ${JSON.stringify(m.badge)}, not "🗺️ Local guide"`);
                check(m.thank === '🫘 Thank Ada', `${label}: the Thank button says ${JSON.stringify(m.thank)}`);
                if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `phone-learn-thank-320-${look}-${st.name}.png`), fullPage: true });
                await page.getByTestId('knowledge-thank').click();
                const pushed = await page.evaluate(() => globalThis.__pushed);
                const want = [{ pathname: '/(tabs)/ledger', params: { sendTo: ADA, sendName: 'Ada', sendNote: NOTE } }];
                check(JSON.stringify(pushed) === JSON.stringify(want), `${label}: the tap pushed ${JSON.stringify(pushed)}`);
            } else {
                // Taken once: the route's params cleared as they are read.
                check(JSON.stringify(m.setParams) === JSON.stringify([{ sendTo: '', sendName: '', sendNote: '' }]), `${label}: the request was cleared ${JSON.stringify(m.setParams)}`);
                if (st.reader === 'can-send') {
                    check(m.form && !m.locked, `${label}: the Beans form is open (form ${m.form}, locked ${m.locked})`);
                    check(m.memo === NOTE, `${label}: the note holds ${JSON.stringify(m.memo)}`);
                    check(m.amount === '', `${label}: the amount holds ${JSON.stringify(m.amount)}`);
                    check(m.text.includes('Ada'), `${label}: Ada is not chosen`);
                    check(m.alerts.length === 0, `${label}: an alert ${JSON.stringify(m.alerts)}`);
                } else {
                    check(JSON.stringify(m.alerts) === JSON.stringify([ALERTS[st.reader]]), `${label}: the alert was ${JSON.stringify(m.alerts)}`);
                    check(!m.form && m.memo === null, `${label}: a form opened`);
                }
                if (SHOTS) {
                    if (m.form) await page.getByTestId('send-confirm').scrollIntoViewIfNeeded();
                    await page.screenshot({ path: path.join(SHOTS, `phone-learn-thank-320-${look}-${st.name}.png`) });
                }
            }
            console.log(`${label}: done`);
        }
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}
if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
    process.exit(1);
}
console.log('phone learn-thank-320: passed');
process.exit(0);
