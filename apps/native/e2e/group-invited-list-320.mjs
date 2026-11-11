#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * "Invited, not joined yet" on the phone's group page (components/GroupInvitedList.tsx) at the floor (memory
 * product-audience-small-screens: 320dp wide, the phone's text at 1.3x), in the light and the dark scheme: the app's own
 * component through react-native-web in headless Chromium, as e2e/invite-and-share-320.mjs draws its screens.
 *
 * What is drawn, each as the node would answer it (GET /api/groups/:id/invitations):
 *   convenor      a convenor's view: every pending invitation, who made each ("by you" for their own), long names
 *   sender        a member's own invitations: when, and no one else's name
 *   declined      the member who made an invitation: pending rows, and "Declined" rows dated, with no Withdraw on them
 *   long          230 pending, the page holding 3: the count of the whole and "and 227 more"
 *   nothing       the node says nothing: the section is not on the page at all
 *
 * Each state fails on: the page scrolling sideways; any text past the 320 edge or clipped in its box; a button under
 * 47.5dp tall; text under 4.5:1 contrast with what it is drawn on; a Withdraw button on a declined row; a row missing.
 *
 * A stand-in for the phone, not an emulator: Android's fonts and line breaking differ. Nothing leaves the machine: the
 * page aborts every request but its own.
 *
 *   node apps/native/e2e/group-invited-list-320.mjs [--shots <dir>]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'group-invited-list-320-'));

// ─── Stubs: what the component imports that reaches the router, the device, the theme or the network ─────────────────
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
        export default { ...RNW, Text };
    `,
    'ThemeContext': `export const useTheme = () => globalThis.__theme; export const useStyles = (make) => make(globalThis.__theme);`,
    // The avatar is a coloured disc with the first letter: its own picture loading is not what is measured here.
    'MemberAvatar': `
        import React from 'react';
        import { View, Text } from 'react-native-web';
        export const MemberAvatar = ({ callsign, size }) => React.createElement(View, { style: { width: size, height: size, borderRadius: size / 2, backgroundColor: '#2f7d4f', alignItems: 'center', justifyContent: 'center' } },
            React.createElement(Text, { style: { color: '#ffffff', fontWeight: '800', fontSize: size / 2 } }, String(callsign || '?').slice(0, 1)));
    `,
    'db': `
        export const fetchGroupInvitations = async () => globalThis.__invitations ?? null;
        export const withdrawGroupInvitationApi = async () => true;
    `,
    'haptics': `export const hapticSuccess = () => {};`,
    'signed-request-lines': `export const signedRequestWords = (m) => m;`,
};
const STUBBED = new Set(['ThemeContext', 'MemberAvatar', 'db', 'haptics', 'signed-request-lines']);
/** Import specifiers (bare, or a relative path's last part) that resolve to a stub, for the component under test alone. */
const stubFor = (spec, importer = '') => {
    if (STUBS[spec]) return spec;
    if (!spec.startsWith('.')) return null;
    const base = path.basename(spec);
    return STUBBED.has(base) && /GroupInvitedList\./.test(path.basename(importer)) ? base : null;
};

// ─── The page: each case renders the real component for one state ──────────────────────────────────────────────────
const ME = 'a'.repeat(64);
const states = {
    convenor: {
        view: 'convenor', pendingTotal: 3,
        pending: [
            { memberPubkey: '1'.repeat(64), callsign: 'Mia', invitedAt: 'DAYS:2', invitedBy: { pubkey: ME, callsign: 'Cleo' } },
            { memberPubkey: '2'.repeat(64), callsign: 'Bartholomew-the-Gardener', invitedAt: 'DAYS:1', invitedBy: { pubkey: 'c'.repeat(64), callsign: 'Wilhelmina Featherstonehaugh' } },
            { memberPubkey: '3'.repeat(64), invitedAt: 'DAYS:9', invitedBy: { pubkey: ME, callsign: 'Cleo' } },
        ],
        declined: [],
    },
    sender: {
        view: 'sender', pendingTotal: 2,
        pending: [
            { memberPubkey: '4'.repeat(64), callsign: 'Ola', invitedAt: 'DAYS:3' },
            { memberPubkey: '5'.repeat(64), callsign: 'Pia', invitedAt: 'DAYS:0' },
        ],
        declined: [],
    },
    declined: {
        view: 'convenor', pendingTotal: 1,
        pending: [{ memberPubkey: '6'.repeat(64), callsign: 'Nat', invitedAt: 'DAYS:1', invitedBy: { pubkey: ME, callsign: 'Cleo' } }],
        declined: [
            { memberPubkey: '7'.repeat(64), callsign: 'Hal', invitedAt: 'DAYS:6', declinedAt: 'DAYS:4' },
            { memberPubkey: '8'.repeat(64), callsign: 'Ivy', invitedAt: 'DAYS:20', declinedAt: 'DAYS:19' },
        ],
    },
    long: {
        view: 'convenor', pendingTotal: 230,
        pending: ['Ann', 'Ben', 'Cal'].map((n, i) => ({ memberPubkey: String(i + 1).repeat(64), callsign: n, invitedAt: `DAYS:${i}`, invitedBy: { pubkey: ME, callsign: 'Cleo' } })),
        declined: [],
    },
    nothing: null,
};

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, ScrollView, Text } from 'react-native';
import { lightColors, darkColors } from ${JSON.stringify(path.join(NATIVE, 'constants/colors'))};
import { GroupInvitedList } from ${JSON.stringify(path.join(NATIVE, 'components/GroupInvitedList'))};

const STATES = ${JSON.stringify(states)};
const q = new URLSearchParams(location.search);
const scheme = q.get('scheme') === 'dark' ? 'dark' : 'light';
const colors = scheme === 'dark' ? darkColors : lightColors;
globalThis.__theme = { theme: scheme, colors };
const raw = STATES[q.get('state') || 'convenor'];
const days = (s) => new Date(Date.now() - Number(String(s).slice(5)) * 86400000).toISOString();
globalThis.__invitations = raw && {
    ...raw,
    pending: raw.pending.map((p) => ({ ...p, invitedAt: days(p.invitedAt) })),
    declined: raw.declined.map((d) => ({ ...d, invitedAt: days(d.invitedAt), declinedAt: days(d.declinedAt) })),
};
createRoot(document.getElementById('root')).render(
    <View style={{ height: '100vh', backgroundColor: colors.surface.app }}>
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.card }} contentContainerStyle={{ padding: 20, paddingBottom: 28 }}>
            <Text style={{ fontSize: 12, fontWeight: '800', color: colors.text.secondary, marginBottom: 10 }}>ROSTER (3)</Text>
            <GroupInvitedList groupId="g-1" myPubkey=${JSON.stringify(ME)} />
            <Text testID="after" style={{ fontSize: 14, color: colors.text.secondary, marginTop: 20 }}>Leave Group</Text>
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
let checked = 0;
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 640 }, deviceScaleFactor: 1 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    /** One state's checks, run in the page. */
    const measure = async (label, expect) => {
        checked++;
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
            const texts = [...document.querySelectorAll('div[dir], span, input, textarea')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
            for (const el of texts) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const what = el.textContent.trim().slice(0, 48);
                if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
                const cs = getComputedStyle(el);
                // A name or a line the row clips with "…" on purpose (numberOfLines: names truncate on this sheet, as on the roster
                // above it) is not a cut; any other clipped text is.
                const clipsOnPurpose = cs.textOverflow === 'ellipsis' || (cs.getPropertyValue('-webkit-line-clamp') || 'none') !== 'none';
                // …but an ordinary name (12 letters or fewer) and an ordinary line ("Invited 19 days ago by Cleo": 32 or fewer) must show whole.
                const clamped = (cs.getPropertyValue('-webkit-line-clamp') || 'none') !== 'none';
                if (clipsOnPurpose && what.length <= (clamped ? 32 : 12) && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) out.push(`"${what}" is shortened with … though it is an ordinary length`);
                if (!clipsOnPurpose && el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible') out.push(`"${what}" is cut on the right (${el.scrollWidth} > ${el.clientWidth})`);
                if (!clipsOnPurpose && el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== 'visible') out.push(`"${what}" is cut at the bottom (${el.scrollHeight} > ${el.clientHeight})`);
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
        const counts = await page.evaluate(() => ({
            pending: document.querySelectorAll('[data-testid="group-invited-row"]').length,
            declined: document.querySelectorAll('[data-testid="group-declined-row"]').length,
            withdraw: document.querySelectorAll('[data-testid="group-invited-withdraw"]').length,
            declinedButtons: document.querySelectorAll('[data-testid="group-declined-row"] [role="button"]').length,
            text: document.body.innerText,
        }));
        const want = expect;
        if (counts.pending !== want.pending) problems.push(`${label}: ${counts.pending} pending rows, wanted ${want.pending}`);
        if (counts.declined !== want.declined) problems.push(`${label}: ${counts.declined} declined rows, wanted ${want.declined}`);
        if (counts.withdraw !== want.pending) problems.push(`${label}: ${counts.withdraw} Withdraw buttons for ${want.pending} pending rows`);
        if (counts.declinedButtons !== 0) problems.push(`${label}: a declined row has a button`);
        for (const needle of want.text ?? []) if (!counts.text.includes(needle)) problems.push(`${label}: the page does not say "${needle}"`);
        for (const needle of want.absent ?? []) if (counts.text.includes(needle)) problems.push(`${label}: the page says "${needle}"`);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `phone-${label.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true });
        }
        console.log(`${found.length ? '✗' : '✓'} ${label}${found.length ? `: ${found.length} problem(s)` : ''}`);
    };
    const open = async (state, scheme) => {
        await page.goto(`${base}/?state=${state}&scheme=${scheme}`);
        await page.locator('[data-testid="after"]').waitFor();
        await page.waitForTimeout(250);
    };

    for (const scheme of ['light', 'dark']) {
        await open('convenor', scheme);
        await measure(`${scheme} · a convenor sees every pending invitation and who made it`, {
            pending: 3, declined: 0,
            text: ['INVITED, NOT JOINED YET (3)', 'Mia', 'Invited 2 days ago by you', 'Invited 1 day ago by Wilhelmina Featherstonehaugh', 'Invited 9 days ago by you'],
            absent: ['Declined'],
        });
        await open('sender', scheme);
        await measure(`${scheme} · a member sees the ones they made`, { pending: 2, declined: 0, text: ['Ola', 'Invited 3 days ago'], absent: [' by ', 'Declined'] });
        await open('declined', scheme);
        await measure(`${scheme} · the sender sees Declined, dated, with no button`, {
            pending: 1, declined: 2,
            text: ['DECLINED INVITATIONS YOU SENT', 'Nobody else in the group sees these.', 'Hal', 'Declined 4 days ago', 'Declined 19 days ago'],
        });
        await open('long', scheme);
        await measure(`${scheme} · 230 pending, three held: the whole count and the rest`, { pending: 3, declined: 0, text: ['INVITED, NOT JOINED YET (230)', 'and 227 more'] });
        await open('nothing', scheme);
        await measure(`${scheme} · the node says nothing: no section`, { pending: 0, declined: 0, text: ['ROSTER (3)', 'Leave Group'], absent: ['INVITED', 'Withdraw'] });
    }
    for (const e of errors) problems.push(`page error: ${e}`);
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n${checked} states at ${WIDTH}dp with ${SCALE}× text, light and dark`);
if (problems.length) {
    console.log(problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
}
console.log('Every state holds: no sideways scroll, nothing past the edge or cut, every button 48dp, text at 4.5:1 or better, Withdraw only on a pending row.');
