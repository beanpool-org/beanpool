#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Where the sign-in copy is, said where it is made (vault rethink VR0, DESIGN-vault-rethink-fable.md §4.5, §7), at the
 * floor (memory product-audience-small-screens: 320dp wide, the phone's text at 1.3×), in the light and the dark
 * scheme, rendered for real: the app's own KeeperProtectionPanel and WhoCanOpen through react-native-web in headless
 * Chromium, inside a card as welcome's Safety Backup (24dp page, 24dp card) and Settings' Account Protection (20dp, 20dp)
 * draw it. Account Protection's 12 words row is settings.tsx's own heading and line, drawn here from the same t() keys
 * and styles: the Settings screen itself can't be mounted outside the app (utils/__tests__/settings-words-render.test.ts
 * renders it, and holds the order and the words).
 *
 * States, each closed and with "Who can open it" opened: Safety Backup after an invite (no sign-in yet), after the
 * global door with a sign-in (covered), Account Protection with no sign-in and with Google connected, a phone with no
 * 12 words, and a build without a vault (Safety Backup after an invite, as it always read).
 *
 * And "Where your account can be brought back from" (vault rethink VR1, §5.1): components/WaysBackList.tsx inside
 * app/ways-back.tsx's page and card (16dp, 16dp) under its header bar (drawn here from the screen's own styles; the
 * screen itself needs the app around it), in its states: every kind of copy at once, the last copy, two accounts of one
 * sign-in at the vault, a vault that couldn't say, a build without a vault, the words-only line with and without the 12
 * words on the phone, and Remove everything's result lines.
 *
 * And "Your community's admins" (vault rethink VR3, §4.3, §4.5): the copy a community keeps for its admins in the list
 * above (under its community, with since when; alone, the last copy), its line in Remove everything's result, and
 * Account Protection's row (components/CommunityAdminsRow.tsx) offered, turned on just now, on since a date, and kept at a
 * community that no longer offers it.
 *
 * Each state fails on: the page scrolling sideways; any text past the 320 edge or clipped in its box; a button under
 * 44dp tall (the panel's own floor); text under 4.5:1 contrast with what it is drawn on (3:1 from 18.66px bold or 24px).
 * Not counted: an emoji on its own (drawn in its own colours, whatever the text colour says), and Facebook's own button,
 * "Protect with Facebook" in Facebook's blue on white (components/SsoButton.tsx, 4.23:1, the same before VR0 and in a
 * build without a vault): listed at the end as known, so it is seen, not hidden.
 *
 * Nothing leaves the machine: the page aborts every request but its own, and the build's vault is a stub (no network
 * code is bundled). The browser: run `pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium` once.
 *
 *   node apps/native/e2e/ways-back-320.mjs [--shots <dir>]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ways-back-320-'));

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
        export const Platform = { ...RNW.Platform, OS: globalThis.__os || 'android', select: (o) => o[globalThis.__os || 'android'] ?? o.default };
        export default { ...RNW, Text, Platform };
    `,
    'react-native-svg': `
        import React from 'react';
        import { View } from 'react-native-web';
        export default ({ width = 18, height = 18 }) => React.createElement(View, { style: { width, height, borderRadius: 9, backgroundColor: '#888' } });
        export const Path = () => null;
    `,
    // The build's vault: on or off by the page's query, as the three EXPO_PUBLIC_BEANPOOL_VAULT_* values make it.
    'vault-config': `
        export const hasVault = () => !!globalThis.__vault;
        export const signInCopiesAt = (rule) => (rule === 'none' ? 'none' : rule === 'server' ? 'community' : globalThis.__vault ? 'vault' : 'community');
        export const vaultConfig = () => null;
        export const readVaultConfig = () => null;
    `,
    // The move card's surroundings (components/VaultMoveCard.tsx, VR2's reverse): the account, the theme's colours, its
    // focus as a mount, the community, the offer the page asks for, the 12 words, and no sheet. Only it imports these.
    'expo-router': `
        import React from 'react';
        export const useFocusEffect = (cb) => React.useEffect(cb, []);
        export const router = { push() {}, replace() {}, back() {} };
    `,
    'IdentityContext': `export const useIdentity = () => ({ identity: { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'Sam' } });`,
    'ThemeContext': `export const useStyles = (make) => make({ colors: globalThis.__colors, theme: globalThis.__scheme });`,
    'node-post': `export const anchorUrl = async () => 'https://mullumbimby.beanpool.org';`,
    'vault-move': `
        export const vaultMoveOffer = async () => globalThis.__offer ?? null;
        export const finishMove = async () => 'removed';
        export const moveLater = async () => {};
        export const removeInstead = async () => true;
    `,
    'identity': `export const hasMnemonic = () => globalThis.__hasWords !== false;`,
    'SsoEnrolSheet': `export const SsoEnrolSheet = () => null;`,
    // Account Protection's "Your community's admins" row (VR3): the community's rule, its answer about the copy (the
    // page's query), the phone's lock (always yes) and the turn-on, all here; nothing is sealed or sent.
    // This phone turned it on here (the row's marker) whenever the community keeps the copy: the row then asks even where it
    // is no longer offered.
    '@react-native-async-storage/async-storage': `export default { getItem: async () => (globalThis.__copy?.kept || globalThis.__copy?.unopenable ? '1' : null), setItem: async () => {}, removeItem: async () => {} };`,
    'LocalAuth': `export const authenticateUser = async () => true;`,
    'copies-rule': `export const copiesRuleForScreen = async () => (globalThis.__offered ? 'server' : 'vault');`,
    'community-copy': `
        const ON = { kept: true, since: '2026-10-29T04:05:06.000Z', offered: true };
        export const COMMUNITY_COPY_TEXT = {};
        export const offersCommunityCopy = (url, rule) => rule === 'server';
        export const communityCopyStatus = async () => globalThis.__copy;
        export const turnOnCommunityCopy = async () => { globalThis.__copy = ON; return { since: ON.since }; };
        export const removeCommunityCopy = async () => { globalThis.__copy = { kept: false, since: null, offered: true }; };
    `,
};
const STUB_BASENAMES = new Set(['vault-config', 'IdentityContext', 'ThemeContext', 'node-post', 'vault-move', 'identity', 'SsoEnrolSheet', 'LocalAuth', 'copies-rule', 'community-copy']);
const stubFor = (spec) => {
    if (STUBS[spec]) return spec;
    if (!spec.startsWith('.')) return null;
    const name = path.basename(spec);
    return STUB_BASENAMES.has(name) ? name : null;
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { t } from '@beanpool/core';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { KeeperProtectionPanel } from ${JSON.stringify(path.join(NATIVE, 'components/KeeperProtectionPanel'))};
import { protectionFrom } from ${JSON.stringify(path.join(NATIVE, 'utils/protection-state'))};
import { NO_WORDS_VIEW_LINE } from ${JSON.stringify(path.join(NATIVE, 'utils/no-words-copy'))};
import { WaysBackList } from ${JSON.stringify(path.join(NATIVE, 'components/WaysBackList'))};
import { onboardingColors } from ${JSON.stringify(path.join(NATIVE, 'utils/onboarding-colors'))};
import { VaultMoveCard } from ${JSON.stringify(path.join(NATIVE, 'components/VaultMoveCard'))};
import { CopiesRuleCardView } from ${JSON.stringify(path.join(NATIVE, 'components/CopiesRuleCardView'))};
import { CommunityAdminsRow } from ${JSON.stringify(path.join(NATIVE, 'components/CommunityAdminsRow'))};

const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__vault = q.get('vault') !== 'off';
globalThis.__colors = colors;
globalThis.__scheme = scheme;
globalThis.__hasWords = q.get('words') !== 'none';
// Where a copy made here goes, by the community's rule (vault rethink VR2): none, community, or the build's place.
const copiesAt = q.get('copies') || undefined;
// The move card's offer (VR2's reverse, or the forward move as before).
globalThis.__offer = q.get('offer') === 'keep-here'
    ? { kind: 'keep-here', provider: 'google', communityUrl: 'https://mullumbimby.beanpool.org' }
    : q.get('offer') === 'move' ? { kind: 'move', provider: 'google', communityUrl: 'https://mullumbimby.beanpool.org' } : null;
const covered = (sso) => protectionFrom({ enrolled: sso.map(() => 'sso'), generation: 1, skipped: [], available: sso.length, enrolledSso: sso, threshold: 1, isSingleBlob: true });
const hasWords = q.get('words') !== 'none';
// "Your community's admins" (VR3): offered here (the rule "this server"), and whether the community keeps the copy.
globalThis.__offered = q.get('offered') !== 'no';
// A copy it keeps but can't open (#2626): its key gone (copy=cantopen-key), or another key in its place (copy=cantopen-other).
const CANT_OPEN = { 'cantopen-key': 'recovery_seal_key_missing', 'cantopen-other': 'recovery_seal_unopenable' }[q.get('copy') || ''];
globalThis.__copy = q.get('copy') === 'on' ? { kept: true, since: '2026-10-29T04:05:06.000Z', offered: globalThis.__offered }
    : CANT_OPEN ? { kept: false, since: null, offered: globalThis.__offered, unopenable: { since: '2026-10-29T04:05:06.000Z', reason: CANT_OPEN } }
    : { kept: false, since: null, offered: globalThis.__offered };
const protection = q.get('signin') === 'google' ? covered(['google']) : protectionFrom(null);
const noop = () => {};

/** Account Protection's 12 words row, as settings.tsx draws it with a key vault (its heading and line). */
const WordsRow = () => (
    <View style={{ marginTop: 12, marginBottom: 16 }}>
        <Text style={{ color: colors.text.heading, fontSize: 16, fontWeight: 'bold', marginBottom: 8 }}>{t('🔑 Your 12 words')}</Text>
        <Text style={{ color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginBottom: 12 }}>
            <Text>{t('Always work, anywhere.')}</Text>{' '}
            {hasWords ? t('On this phone: keep them private and never share them with anyone.') : NO_WORDS_VIEW_LINE}
        </Text>
        <View style={{ backgroundColor: colors.surface.card, borderColor: colors.border.default, borderWidth: 1, borderRadius: 12, padding: 14, alignItems: 'center' }}>
            <Text style={{ color: colors.text.heading, fontWeight: '600', fontSize: 15 }}>👁️ {t('Show My 12 Recovery Words')}</Text>
        </View>
    </View>
);

/** "Where your account can be brought back from": what utils/ways-back.ts finds, in each state drawn. */
const MULLUM = 'https://mullumbimby.beanpool.org';
const GLOBAL = 'https://global.beanpool.org';
const WAYS = {
    full: {
        vault: { kind: 'listed', copies: [
            { provider: 'google', since: '2026-10-03', lastReleasedAt: Date.UTC(2026, 9, 12, 9) },
            { provider: 'facebook', since: '2026-10-20', lastReleasedAt: null },
        ] },
        communities: [
            { url: MULLUM, name: 'Mullumbimby', status: { providers: ['google', 'apple'], generation: 3, adminsCopy: { since: '2026-10-29T04:05:06.000Z' } } },
            { url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } },
            { url: 'https://bellingen.beanpool.org', name: 'Bellingen', status: null },
        ],
        pending: [{ url: MULLUM, provider: 'apple' }],
    },
    // A copy Mullumbimby keeps for its admins but can't open now (#2626): listed, removable, never a way back.
    cantopen: {
        vault: { kind: 'listed', copies: [] },
        communities: [
            { url: MULLUM, name: 'Mullumbimby', status: { providers: [], generation: 0, adminsCopyUnopenable: { since: '2026-10-29T04:05:06.000Z', reason: 'recovery_seal_key_missing' } } },
            { url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } },
        ],
        pending: [],
    },
    // Only the copy Mullumbimby keeps for its admins (VR3): the last way back this phone knows of.
    adminsonly: {
        vault: { kind: 'listed', copies: [] },
        communities: [
            { url: MULLUM, name: 'Mullumbimby', status: { providers: [], generation: 0, adminsCopy: { since: '2026-10-29T04:05:06.000Z' } } },
            { url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } },
        ],
        pending: [],
    },
    last: { vault: { kind: 'listed', copies: [{ provider: 'google', since: '2026-10-03', lastReleasedAt: null }] }, communities: [{ url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } }], pending: [] },
    paused: { vault: { kind: 'unknown', why: 'paused' }, communities: [{ url: GLOBAL, name: 'Global community', status: { providers: ['google'], generation: 2 } }], pending: [] },
    novault: { vault: { kind: 'no-vault' }, communities: [{ url: MULLUM, name: 'Mullumbimby', status: { providers: ['google'], generation: 1 } }], pending: [] },
    none: { vault: { kind: 'listed', copies: [] }, communities: [{ url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } }], pending: [] },
    // Two Google accounts linked: the vault keeps a copy for each, both listed above the one Remove that takes both.
    twogoogle: {
        vault: { kind: 'listed', copies: [
            { provider: 'google', since: '2026-10-04', lastReleasedAt: Date.UTC(2026, 9, 12, 9) },
            { provider: 'google', since: '2026-10-01', lastReleasedAt: null },
            { provider: 'facebook', since: '2026-10-20', lastReleasedAt: null },
        ] },
        communities: [{ url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } }],
        pending: [],
    },
};
/** Remove everything's result lines, as app/ways-back.tsx words them (a vault that was paused, a community that didn't answer). */
const RESULT = [
    t("Not removed: BeanPool's key vault is paused for a little while. Try again later."),
    t("Not removed yet: {community} didn't answer. The app tries again each time it opens.", { community: 'Mullumbimby' }),
    t("{community} didn't answer, so nothing kept there was removed. Open this screen again later.", { community: 'Bellingen' }),
    t("Not removed: {community} couldn't do it just now. Try again later.", { community: 'Mullumbimby' }),
];

/** app/ways-back.tsx's page: its header bar (from the screen's styles; the icon drawn as an arrow) and its card. */
const WaysPage = () => {
    const { colors: oc, dark } = onboardingColors(scheme);
    const state = q.get('state') || 'full';
    return (
        <View style={{ backgroundColor: oc.surface.page }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: oc.border.default, backgroundColor: dark ? oc.surface.card : oc.text.heading }}>
                <View style={{ width: 48, height: 48, justifyContent: 'center', alignItems: 'center' }}><Text style={{ fontSize: 22, color: oc.text.inverse }}>←</Text></View>
                <Text numberOfLines={1} style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: oc.brand.primary, letterSpacing: 0.5 }}>{t('Ways back')}</Text>
                <View style={{ width: 48 }} />
            </View>
            <View style={{ padding: 16 }}>
                <View style={{ backgroundColor: oc.surface.card, borderRadius: 16, padding: 16, marginBottom: 12 }}>
                    <WaysBackList
                        ways={WAYS[state === 'result' ? 'full' : state]}
                        hasWords={hasWords}
                        writtenDown={q.get('written') === 'yes'}
                        busy={false}
                        result={state === 'result' ? RESULT : []}
                        colors={oc}
                        onWrittenDown={noop} onShowWords={noop} onRemove={noop} onRemoveEverything={noop} onLinkSignIn={noop}
                        noCopiesHere={q.get('here') === 'none'}
                    />
                </View>
            </View>
        </View>
    );
};

const Page = () => {
    const place = q.get('place');
    if (place === 'ways') return <WaysPage />;
    // Settings' menu, where the move card sits (VR2's reverse, "Keep your Google recovery with your community").
    if (place === 'movecard') return (
        <View style={{ backgroundColor: colors.surface.page, padding: 16 }}>
            <VaultMoveCard />
        </View>
    );
    // Home, where the "rule changed" card sits above the other cards (16dp page, as Home's list).
    if (place === 'rulecard') return (
        <View style={{ backgroundColor: colors.surface.page, padding: 16 }}>
            <CopiesRuleCardView to={q.get('to') || 'community'} community="Mullumbimby" canMove={q.get('move') === 'yes'} colors={colors} onMove={noop} onSee={noop} onOk={noop} />
        </View>
    );
    if (place === 'backup') return (
        <View style={{ backgroundColor: colors.surface.page, padding: 24 }}>
            <View style={{ backgroundColor: colors.surface.card, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default }}>
                <KeeperProtectionPanel protection={protection} hasWords={hasWords} copiesAt={copiesAt} communityName="Mullumbimby" onProtectSso={noop} />
            </View>
        </View>
    );
    return (
        <View style={{ backgroundColor: colors.surface.page, padding: 20, paddingTop: 16 }}>
            <View style={{ backgroundColor: colors.surface.card, borderRadius: 16, padding: 20 }}>
                <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading, marginBottom: 16 }}>{t('🛡️ Account Protection')}</Text>
                <Text style={{ fontSize: 14, color: colors.text.secondary, marginBottom: 16, lineHeight: 20 }}>{t('This is how you get back into your account if you lose your phone.')}</Text>
                <WordsRow />
                <KeeperProtectionPanel colors={colors} protection={protection} hasWords={hasWords} waysBack copiesAt={copiesAt} communityName="Mullumbimby" onProtectSso={noop} onDisconnectSso={noop} />
                {place === 'admins' && <CommunityAdminsRow communityName="Mullumbimby" />}
            </View>
        </View>
    );
};
// The page grows with what is drawn (no scroll box of its own), so a full-page shot holds all of it.
createRoot(document.getElementById('root')).render(<View style={{ minHeight: '100vh', backgroundColor: colors.surface.page }}><Page /></View>);
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
                const name = stubFor(args.path);
                if (!name) return undefined;
                return { path: name, namespace: 'stub' };
            });
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'jsx', resolveDir: NATIVE }));
        },
    }],
});
const bundle = result.outputFiles[0].text;
const page0 = (os) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<style>html,body,#root{margin:0;min-height:100%} body{font-family:sans-serif}</style><script>globalThis.__os = ${JSON.stringify(os)};</script></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    const os = new URL(req.url, 'http://x').searchParams.get('os') === 'ios' ? 'ios' : 'android';
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page0(os));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const problems = [];
const knownSeen = [];
let states = 0;
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 640 }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

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
            if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
            const known = [];
            const texts = [...document.querySelectorAll('div[dir], span')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
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
                if (/^[\p{Extended_Pictographic}\uFE0F\s]+$/u.test(el.textContent)) continue;
                const bg = backdrop(el);
                const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
                const ratio = (a + 0.05) / (b + 0.05);
                const size = parseFloat(cs.fontSize);
                const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                if (ratio < (large ? 3 : 4.5)) (what === 'Protect with Facebook' ? known : out).push(`"${what}" has contrast ${ratio.toFixed(2)}:1 (${cs.color} on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}), ${size}px)`);
            }
            for (const k of known) out.push(`KNOWN ${k}`);
            for (const el of document.querySelectorAll('[role="button"]')) {
                const r = el.getBoundingClientRect();
                if (r.width === 0) continue;
                if (r.height < 43.5) out.push(`the button "${el.textContent.trim().slice(0, 40) || el.getAttribute('aria-label')}" is ${Math.round(r.height)}dp tall`);
            }
            return out;
        }, { WIDTH });
        for (const p of found) (p.startsWith('KNOWN ') ? knownSeen : problems).push(`${label}: ${p.replace(/^KNOWN /, '')}`);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true }); }
        const bad = found.filter((p) => !p.startsWith('KNOWN '));
        console.log(`${bad.length ? '✗' : '✓'} ${label}${bad.length ? `: ${bad.length} problem(s)` : ''}`);
    };
    const open = async (q) => { await page.goto(`${base}/?${q}`); await page.waitForTimeout(150); };
    const whoCanOpen = () => page.getByRole('button', { name: 'Who can open it' }).first();
    const OPENERS = /BeanPool's key vault, a small server in Iceland, keeps the copy of your account that your sign-in opens/;

    const CASES = [
        ['place=backup', 'Safety Backup, after an invite, no sign-in yet'],
        ['place=backup&os=ios', 'Safety Backup, after an invite, on an iPhone'],
        ['place=backup&signin=google', 'Safety Backup, joined the global community with Google'],
        ['place=protection', 'Account Protection, no sign-in yet'],
        ['place=protection&signin=google', 'Account Protection, Google connected'],
        ['place=protection&signin=google&words=none', 'Account Protection, Google connected, no 12 words on the phone'],
    ];
    for (const scheme of ['light', 'dark']) {
        for (const [query, label] of CASES) {
            await open(`${query}&scheme=${scheme}`);
            await page.getByText(/BeanPool's key vault, a small server in Iceland, keeps a locked copy of your key/).first().waitFor();
            if (await page.getByText(OPENERS).count()) problems.push(`${scheme} · ${label}: who can open the copy is drawn before the tap`);
            await measure(`${scheme} · ${label}`);
            await whoCanOpen().click();
            await page.getByText(OPENERS).first().waitFor();
            await measure(`${scheme} · ${label} · Who can open it, opened`);
        }
        // A build without a vault: as it always read, none of VR0's row.
        await open(`place=backup&vault=off&scheme=${scheme}`);
        await page.getByText('Sign-In Recovery Providers (1-of-N)').waitFor();
        if (await page.getByText(/key vault|Iceland|A sign-in you link|Who can open it/).count()) problems.push(`${scheme} · a build without a vault: VR0's words drawn`);
        await measure(`${scheme} · Safety Backup, a build without a key vault, after an invite`);

        // "Where your account can be brought back from" (VR1).
        const WAYS_CASES = [
            ['state=full', 'Ways back, every kind of copy'],
            ['state=full&words=none', 'Ways back, every kind of copy, no 12 words on the phone'],
            ['state=last&written=yes', 'Ways back, the last copy, written down ticked'],
            ['state=twogoogle', 'Ways back, two Google accounts at the key vault'],
            ['state=paused', 'Ways back, the key vault paused'],
            ['state=novault', 'Ways back, a build without a key vault'],
            ['state=none', 'Ways back, nothing kept anywhere'],
            ['state=none&words=none', 'Ways back, nothing kept anywhere, no 12 words on the phone'],
            ['state=result', 'Ways back, after Remove everything'],
            ['state=adminsonly', "Ways back, only the copy for your community's admins"],
            ['state=cantopen', "Ways back, a copy for your community's admins its server can't open"],
        ];
        for (const [query, label] of WAYS_CASES) {
            await open(`place=ways&${query}&scheme=${scheme}`);
            await page.getByText('Where your account can be brought back from').first().waitFor();
            if (query.includes('novault') && await page.getByText(/key vault|Iceland/).count()) problems.push(`${scheme} · ${label}: the vault named in a build without one`);
            await measure(`${scheme} · ${label}`);
        }

        // Where members' copies go, by the community's rule (vault rethink VR2, design §5.3): the panel at Safety Backup
        // and Account Protection under "nowhere" and "this server", the move card's reverse in Settings, Home's card for
        // each change, and the ways back screen at a community that keeps none. Under "nowhere" no sign-in is offered.
        const RULE_CASES = [
            ['place=backup&copies=none', 'Safety Backup, a community that keeps no copies', /This community keeps no copies of members' accounts/],
            ['place=backup&copies=none&words=none', 'Safety Backup, a community that keeps no copies, no 12 words on the phone', /This phone has no 12 words: if you lose it/],
            ['place=protection&copies=none', 'Account Protection, a community that keeps no copies', /This community keeps no copies of members' accounts/],
            ['place=backup&copies=community', 'Safety Backup, a community that keeps copies itself', /Sign-In Recovery Providers/],
            ['place=protection&copies=community&signin=google', 'Account Protection, a community that keeps copies itself, Google kept there', /You're covered on Mullumbimby/],
            ['place=movecard&offer=keep-here', 'Settings, the move card, keep your Google copy with your community', /Keep your Google recovery with your community/],
            ['place=rulecard&to=community&move=yes', 'Home, the rule changed, the community keeps copies itself, Move mine', /Mullumbimby keeps members' copies itself now/],
            ['place=rulecard&to=none', 'Home, the rule changed, the community keeps no copies', /Mullumbimby keeps no copies now/],
            ['place=rulecard&to=vault', "Home, the rule changed, the community uses BeanPool's key vault", /uses BeanPool's key vault now/],
            ['place=ways&state=full&here=none', 'Ways back, at a community that keeps no copies', /This community keeps no copies of members' accounts/],
        ];
        for (const [query, label, shows] of RULE_CASES) {
            await open(`${query}&scheme=${scheme}`);
            await page.getByText(shows).first().waitFor();
            if (query.includes('copies=none') && await page.getByText(/Protect with|Connect again/).count()) problems.push(`${scheme} · ${label}: a sign-in is offered`);
            if (query.includes('here=none') && await page.getByText('Link a sign-in').count()) problems.push(`${scheme} · ${label}: Link a sign-in is offered`);
            await measure(`${scheme} · ${label}`);
        }

        // "Your community's admins" (VR3): Account Protection's third row, in each of its states.
        const ADMINS_CASES = [
            ['copy=off', "Account Protection, your community's admins, offered", /Turn on/],
            ['copy=on', "Account Protection, your community's admins, on since a date", /On in Mullumbimby since/],
            ['copy=on&offered=no', "Account Protection, your community's admins, kept where it is no longer offered", /no longer offers this to new members/],
            // A copy its server keeps but can't open (#2626): never On, and what can be done.
            ['copy=cantopen-key', "Account Protection, your community's admins, kept but its server's key is gone", /The people who run it can put that key back/],
            ['copy=cantopen-other', "Account Protection, your community's admins, kept under another key, offered", /Turn it on again to make a copy it can open/],
            ['copy=cantopen-other&offered=no', "Account Protection, your community's admins, kept under another key, no longer offered", /no longer makes new copies/],
        ];
        for (const [query, label, shows] of ADMINS_CASES) {
            await open(`place=admins&${query}&scheme=${scheme}`);
            await page.getByText(shows).first().waitFor();
            await measure(`${scheme} · ${label}`);
        }
        await open(`place=admins&copy=off&scheme=${scheme}`);
        await page.getByRole('button', { name: 'Turn on' }).click();
        await page.getByText(/If you lose this phone, go and see one of your admins/).waitFor();
        await measure(`${scheme} · Account Protection, your community's admins, turned on just now`);
    }
    for (const e of errors) problems.push(`page error: ${e}`);
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n${states} states at ${WIDTH}dp with ${SCALE}× text, light and dark`);
if (knownSeen.length) console.log(`Known, from before VR0 (${knownSeen.length} states): ${knownSeen[0].replace(/^.*?: /, '')}`);
if (problems.length) {
    console.log(problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
}
console.log('Every state holds: no sideways scroll, nothing past the edge or cut, every button 44dp, text at 4.5:1 or better.');
