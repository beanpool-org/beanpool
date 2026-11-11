/**
 * "Invited, not joined yet" on the web's group sheet (components/GroupInvitedList.tsx, inside GroupDetailModal) at 320 px
 * with 1.3× text, in a real browser, in the light and the dark scheme: the app's own components and stylesheet
 * (e2e/group-invited-list-harness: Vite's dev server) with /api answered here, as the node would (GET
 * /api/groups/:id/invitations).
 *
 * What is drawn: a convenor's view (every pending invitation, who made each, "by you" for their own, a long name), a member's
 * own invitations, the member who made them seeing "Declined" dated with no button on it, 230 pending with three held, and a
 * node that has no such list (an older one answers 404: no section at all). Fails on: the page scrolling sideways; any of the
 * list's text past the edge or under 4.5:1 against what it is drawn on; a Withdraw button under 44 px tall or on a declined
 * row; a row missing; the section drawn above the roster. Nothing here talks to a node.
 *
 * Run: pnpm --filter @beanpool/pwa exec node e2e/group-invited-list-shots.mjs [out-dir]
 */
/* global console, process, document, window, getComputedStyle */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-group-invited-list');
const ME = 'a'.repeat(64);
const SCALE = 1.3;
const ago = (days) => new Date(Date.now() - days * 86400_000).toISOString();

const roster = [
    { groupId: 'g-1', memberPubkey: ME, callsign: 'Cleo', role: 'convenor', status: 'active', joinedAt: ago(30) },
    { groupId: 'g-1', memberPubkey: 'b'.repeat(64), callsign: 'Gus', role: 'member', status: 'active', joinedAt: ago(20) },
    { groupId: 'g-1', memberPubkey: 'c'.repeat(64), callsign: 'Hal', role: 'member', status: 'active', joinedAt: ago(10) },
];
const STATES = {
    convenor: {
        want: { pending: 3, declined: 0, text: ['INVITED, NOT JOINED YET (3)', 'Invited 2 days ago by you', 'Invited 1 day ago by Wilhelmina Featherstonehaugh'], absent: ['Declined'] },
        body: {
            view: 'convenor', pendingTotal: 3,
            pending: [
                { memberPubkey: '1'.repeat(64), callsign: 'Mia', invitedAt: ago(2), invitedBy: { pubkey: ME, callsign: 'Cleo' } },
                { memberPubkey: '2'.repeat(64), callsign: 'Bartholomew-the-Gardener', invitedAt: ago(1), invitedBy: { pubkey: 'd'.repeat(64), callsign: 'Wilhelmina Featherstonehaugh' } },
                { memberPubkey: '3'.repeat(64), invitedAt: ago(9), invitedBy: { pubkey: ME, callsign: 'Cleo' } },
            ],
            declined: [],
        },
    },
    sender: {
        want: { pending: 2, declined: 0, text: ['Ola', 'Invited 3 days ago'], absent: [' by ', 'Declined'] },
        body: {
            view: 'sender', pendingTotal: 2,
            pending: [{ memberPubkey: '4'.repeat(64), callsign: 'Ola', invitedAt: ago(3) }, { memberPubkey: '5'.repeat(64), callsign: 'Pia', invitedAt: ago(0.2) }],
            declined: [],
        },
    },
    declined: {
        want: { pending: 1, declined: 2, text: ['DECLINED INVITATIONS YOU SENT', 'Nobody else in the group sees these.', 'Declined 4 days ago', 'Declined 19 days ago'] },
        body: {
            view: 'convenor', pendingTotal: 1,
            pending: [{ memberPubkey: '6'.repeat(64), callsign: 'Nat', invitedAt: ago(1), invitedBy: { pubkey: ME, callsign: 'Cleo' } }],
            declined: [{ memberPubkey: '7'.repeat(64), callsign: 'Hal', invitedAt: ago(6), declinedAt: ago(4) }, { memberPubkey: '8'.repeat(64), callsign: 'Ivy', invitedAt: ago(20), declinedAt: ago(19) }],
        },
    },
    long: {
        want: { pending: 3, declined: 0, text: ['INVITED, NOT JOINED YET (230)', 'and 227 more'] },
        body: {
            view: 'convenor', pendingTotal: 230,
            pending: ['Ann', 'Ben', 'Cal'].map((n, i) => ({ memberPubkey: String(i + 1).repeat(64), callsign: n, invitedAt: ago(i + 1), invitedBy: { pubkey: ME, callsign: 'Cleo' } })),
            declined: [],
        },
    },
    // A node from before the list answers 404: the sheet is as it always was.
    older: { want: { pending: 0, declined: 0, text: ['ROSTER (3)'], absent: ['Invited, not joined', 'INVITED', 'Withdraw'] }, status: 404, body: { error: 'Not found' } },
};

/** In the page: what the list draws and where it sits, with the checks that need the browser. */
function measure(want) {
    const WIDTH = window.innerWidth;
    const out = [];
    const parse = (css) => (css.match(/[\d.]+/g) || []).map(Number);
    const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const backdrop = (el) => {
        let node = el;
        while (node) {
            const c = parse(getComputedStyle(node).backgroundColor);
            if (c.length === 3 || (c.length === 4 && c[3] > 0.99)) return c.slice(0, 3);
            node = node.parentElement;
        }
        return [255, 255, 255];
    };
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (scrollWidth > WIDTH) out.push(`the page scrolls sideways (${scrollWidth}px in ${WIDTH}px)`);
    const list = document.querySelector('[data-testid="group-invited-list"]');
    const pending = document.querySelectorAll('[data-testid="group-invited-row"]').length;
    const declined = document.querySelectorAll('[data-testid="group-declined-row"]').length;
    if (pending !== want.pending) out.push(`${pending} pending rows, wanted ${want.pending}`);
    if (declined !== want.declined) out.push(`${declined} declined rows, wanted ${want.declined}`);
    const buttons = [...document.querySelectorAll('[data-testid="group-invited-withdraw"]')];
    if (buttons.length !== want.pending) out.push(`${buttons.length} Withdraw buttons for ${want.pending} pending rows`);
    if (document.querySelector('[data-testid="group-declined-row"] button')) out.push('a declined row has a button');
    for (const b of buttons) {
        const r = b.getBoundingClientRect();
        if (r.height < 44) out.push(`a Withdraw button is ${Math.round(r.height)} px tall, under 44`);
        if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`a Withdraw button runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
    }
    const bodyText = document.body.innerText;
    for (const needle of want.text ?? []) if (!bodyText.includes(needle)) out.push(`the page does not say "${needle}"`);
    for (const needle of want.absent ?? []) if (bodyText.includes(needle)) out.push(`the page says "${needle}"`);
    if (list) {
        const roster = [...document.querySelectorAll('h3')].find((h) => /^Roster \(/.test(h.textContent.trim()));
        if (!roster) out.push('no roster heading');
        else if (!(roster.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)) out.push('the section is not under the roster');
        const texts = [...list.querySelectorAll('div, h3, p, button')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
        for (const el of texts) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            const what = el.textContent.trim().slice(0, 48);
            if (r.right > WIDTH + 0.5 || r.left < -0.5) out.push(`"${what}" runs past the edge (${Math.round(r.left)}–${Math.round(r.right)})`);
            const cs = getComputedStyle(el);
            const ink = parse(cs.color);
            const bg = backdrop(el);
            const hi = Math.max(lum(ink.slice(0, 3)), lum(bg));
            const lo = Math.min(lum(ink.slice(0, 3)), lum(bg));
            const ratio = (hi + 0.05) / (lo + 0.05);
            if (ratio < 4.5) out.push(`"${what}" is ${ratio.toFixed(2)}:1 against what is behind it, under 4.5 (${cs.color})`);
        }
        list.scrollIntoView({ block: 'center' });
    }
    return out;
}

const server = await createServer({ root: PWA_DIR, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch();
const failures = [];
let checked = 0;
fs.mkdirSync(SHOTS_DIR, { recursive: true });
try {
    for (const theme of ['light', 'dark']) for (const [name, state] of Object.entries(STATES)) {
        const run = `${name} ${theme}`;
        const context = await browser.newContext({ viewport: { width: 320, height: 640 }, reducedMotion: 'reduce', colorScheme: theme });
        await context.addInitScript(([scale, mode]) => {
            localStorage.setItem('beanpool-theme-mode', mode);
            const dress = () => { if (mode === 'dark') { document.documentElement.classList.add('dark', 'dark-theme'); document.documentElement.style.colorScheme = 'dark'; } };
            dress();
            document.addEventListener('DOMContentLoaded', () => {
                dress();
                const s = document.createElement('style');
                s.textContent = `html { font-size: ${scale * 100}% !important; }`;
                document.head.appendChild(s);
            });
        }, [SCALE, theme]);
        await context.route((url) => url.origin !== origin, (route) => route.abort());
        await context.route(`${origin}/api/**`, (route) => {
            const p = new URL(route.request().url()).pathname;
            const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
            if (p === '/api/groups/g-1/invitations') return reply(state.status ?? 200, state.body);
            if (p === '/api/groups/g-1/members') return reply(200, roster);
            if (p === '/api/groups/g-1') return reply(200, { id: 'g-1', name: 'Secret Garden Club', slug: 'secret-garden-club', category: 'social', joinPolicy: 'invite_only', description: 'Seeds, swaps and slow Sundays.', memberCount: 3, createdBy: ME, createdAt: ago(40), leadPubkey: ME, viewerRole: 'convenor', viewerStatus: 'active', closedAt: null });
            if (p === '/api/community/me') return reply(200, { mute: { muted: false, until: null } });
            return reply(404, { error: 'Not Found' });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        try {
            await page.goto(`${origin}/e2e/group-invited-list-harness.html`, { waitUntil: 'load' });
            await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
            await page.waitForFunction(() => [...document.querySelectorAll('h3')].some((h) => /^Roster \(/.test(h.textContent.trim())), null, { timeout: 20_000 });
            if (name !== 'older') await page.waitForSelector('[data-testid="group-invited-list"]', { timeout: 20_000 });
            else await page.waitForTimeout(600);
            if (theme === 'dark') await page.evaluate(() => { document.documentElement.classList.add('dark', 'dark-theme'); document.documentElement.style.colorScheme = 'dark'; });
            await page.waitForTimeout(400);
            if (theme === 'dark' && !(await page.evaluate(() => document.documentElement.classList.contains('dark-theme')))) { failures.push(`${run}: the page did not stay dark`); continue; }
            const found = await page.evaluate(measure, state.want);
            await page.waitForTimeout(200);
            await page.screenshot({ path: path.join(SHOTS_DIR, `web-${name}-${theme}.png`) });
            checked++;
            for (const f of found) failures.push(`${run}: ${f}`);
            console.log(`${found.length ? '✗' : '✓'} ${run}${found.length ? `: ${found.length} problem(s)` : ''}`);
        } catch (e) {
            failures.push(`${run}: ${e.message.split('\n')[0]}${errors.length ? ` (page: ${errors.slice(0, 2).join(' | ').slice(0, 300)})` : ''}`);
            await page.screenshot({ path: path.join(SHOTS_DIR, `web-${name}-${theme}-error.png`) }).catch(() => {});
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log(`screenshots: ${SHOTS_DIR}`);
if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
    process.exit(1);
}
console.log(`group-invited-list-shots: ok — ${checked} states at 320 px with 1.3× text, light and dark.`);
