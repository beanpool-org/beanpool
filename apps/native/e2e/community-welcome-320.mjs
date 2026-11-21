#!/usr/bin/env node
/* global process, console, document, location */
/**
 * (S7, scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.1 item 2, §4.2, §4.5) The community's own welcome under
 * BeanPool's tile, at 320dp wide with the phone's text at 1.3×, light and dark: node apps/native/e2e/community-welcome-320.mjs --shots <dir>
 *
 * Views: `written` (the tile, then the welcome with the owners' words, the inviter's line and the count), `none` (no words:
 * the inviter's line and the count), `owner` (an owner's prompt), `long` (280 characters, one of them a single long word),
 * `rtl` (Arabic words in an English app), `again` (the community card's line, opened).
 *
 * The app's own WelcomeTile, CommunityWelcomeCard and CommunityBody through react-native-web in headless Chromium (as
 * welcome-tile-320.mjs). Checks: no sideways scroll, text inside 320dp, the × and the links at least 48dp. The pixels of the
 * real phone are the emulator walk's.
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'community-welcome-'));

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
        export const Platform = { ...RNW.Platform, OS: 'android', select: (o) => o['android'] ?? o.default };
        export default { ...RNW, Text, Platform };
    `,
    'react-native-safe-area-context': `
        export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
    `,
    '@expo/vector-icons': `
        import React from 'react';
        const GLYPHS = { 'swap-horizontal': '⇄', 'scale-balance': '⚖', 'circle-outline': '◯', 'account-group-outline': '☺', 'map-marker-radius-outline': '⌖', 'dots-horizontal': '…' };
        export const MaterialCommunityIcons = ({ name, size, color }) => React.createElement('span', { 'aria-hidden': true, style: { color, fontSize: size, fontWeight: 900, lineHeight: size + 'px' } }, GLYPHS[name] || '•');
    `,
    'expo-router': `export const router = { push() {}, navigate() {} };`,
    // The owner's prompt opens Settings through Manage (phone unlock, the node): nothing of it is drawn here.
    '../useManageNode': `export const useManageNode = () => ({ busy: false, start() {}, dialog: null });`,
    '../../utils/node-admin': `export const cachedNodeRole = async () => ({ role: null, communityName: null });`,
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView } from 'react-native';
import { welcomeTileLines, t, communityWelcomeAgainLine, communityWelcomeWords } from '@beanpool/core';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { HomeCard } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeParts'))};
import { WelcomeTile } from ${JSON.stringify(path.join(NATIVE, 'components/home/WelcomeTile'))};
import { CommunityWelcomeCard, CommunityWelcomeAgain } from ${JSON.stringify(path.join(NATIVE, 'components/home/CommunityWelcomeCard'))};
import { CommunityBody } from ${JSON.stringify(path.join(NATIVE, 'components/home/HomeCardBodies'))};

const q = new URLSearchParams(location.search);
const colors = q.get('scheme') === 'dark' ? darkColors : lightColors;
const view = q.get('view');
const noop = () => {};
const NOW = Date.now();
const WORDS = {
    written: "G'day and welcome. Market day is Saturday at the hall.\\nPost what you grow, make or can lend.",
    // The longest a welcome may be (280 characters), holding one word of 114 letters that no line can hold whole.
    long: ('Welcome! Our swap is at Riverside hall. ' + 'Neighbourhoodgardenswapandrepaircafeeverysaturdaymorning'.repeat(2) + ' Bring jars, seeds and tools to lend. Ask Asha or Sam if you are stuck; we answer within the day. Kids welcome, dogs on leads please. See you there!').slice(0, 279).trimEnd() + '!',
    rtl: 'أهلاً وسهلاً بكم. سوق المقايضة يوم السبت في قاعة الحي.\\nانشروا ما تزرعون أو تصنعون أو تعيرون.',
};
const ASHA = { key: 'aa'.repeat(32), name: 'Asha' };
const answer = (welcome, invitedBy = ASHA, days = 2) => ({
    profile: 'local',
    me: { joinedAt: new Date(NOW - days * 86400000).toISOString(), invitedBy },
    cards: { community: { name: 'Riverside', members: 84, tradesThisMonth: 23, ...(welcome === undefined ? {} : { welcome }) } },
});
const welcome = (a, role = null) => (
    <CommunityWelcomeCard answer={a} role={role} dismissedAt={null} now={NOW} nodeUrl={null} identity={null} colors={colors}
        onPutAway={noop} onSayHello={noop} onInvite={noop} />
);
const tile = <WelcomeTile shape="full" place="You're in Riverside." lines={welcomeTileLines({ profile: 'local', beans: true })} tourLabel={t('Show me around')} colors={colors} onTour={noop} onGotIt={noop} />;
const again = () => {
    const a = answer(WORDS.written, ASHA, 45);
    return (
        <HomeCard id="community" caption="RIVERSIDE" colors={colors} hue="sage" testID="home-card-community">
            <CommunityBody card={a.cards.community} profile="local" invitesOn colors={colors}
                welcomeAgain={<CommunityWelcomeAgain line={communityWelcomeAgainLine(a)} words={communityWelcomeWords(a)} colors={colors} />} />
        </HomeCard>
    );
};
const body = view === 'none' ? <>{tile}{welcome(answer(null))}</>
    : view === 'owner' ? welcome(answer(null, null), 'owner')
    : view === 'long' ? welcome(answer(WORDS.long))
    : view === 'rtl' ? welcome(answer(WORDS.rtl))
    : view === 'again' ? again()
    : <>{tile}{welcome(answer(WORDS.written))}</>;
createRoot(document.getElementById('root')).render(
    <View style={{ minHeight: '100vh', backgroundColor: colors.surface.page }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 12 }}>
            <View testID="shot-list">{body}</View>
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
    loader: { '.js': 'jsx', '.png': 'empty', '.ttf': 'empty', '.webp': 'empty', '.jpg': 'empty', '.gif': 'empty', '.svg': 'empty', '.otf': 'empty' },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.mjs', '.json'],
    nodePaths: [path.join(ROOT, 'node_modules'), path.join(NATIVE, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', 'process.env.EXPO_OS': '"web"' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {} }; globalThis.global = globalThis;' },
    logLevel: 'error',
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => (args.namespace !== 'stub' && STUBS[args.path] ? { path: args.path, namespace: 'stub' } : undefined));
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
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e}`));
    for (const view of ['written', 'none', 'owner', 'long', 'rtl', 'again']) {
        for (const scheme of ['light', 'dark']) {
            const label = `community-welcome-${view}-${scheme}`;
            await page.goto(`${base}/?scheme=${scheme}&view=${view}`);
            await page.getByTestId('shot-list').first().waitFor({ timeout: 8000 }).catch((e) => { console.log(problems.join('\n')); throw e; });
            if (view === 'again') await page.getByTestId('home-community-welcome-again').click();
            await page.waitForTimeout(300);
            const found = await page.evaluate(({ WIDTH, view }) => {
                const out = [];
                if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
                for (const el of document.querySelectorAll('div[dir], span')) {
                    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${el.textContent.trim().slice(0, 40)}" runs past the edge (${Math.round(r.left)}-${Math.round(r.right)})`);
                }
                for (const id of ['home-welcome-community-x', 'home-welcome-community-hello', 'home-welcome-community-write', 'home-community-welcome-again']) {
                    const b = document.querySelector(`[data-testid="${id}"]`);
                    if (b && b.getBoundingClientRect().height < 47.5) out.push(`${id} is ${Math.round(b.getBoundingClientRect().height)}dp tall`);
                }
                const words = document.querySelector('[data-testid="home-welcome-community-words"], [data-testid="home-community-welcome-words"]');
                if (['written', 'long', 'rtl', 'again'].includes(view) && !words) out.push("the owners' words are not drawn");
                if (words && words.scrollWidth > words.clientWidth + 1) out.push("the owners' words overflow their box");
                return out;
            }, { WIDTH, view });
            for (const p of found) problems.push(`${label}: ${p}`);
            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await page.screenshot({ path: path.join(SHOTS, `${label}.png`), fullPage: true });
            }
            console.log(`${found.length ? 'x' : 'ok'} ${label}${found.length ? `; ${found.length} problem(s)` : ''}`);
        }
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
