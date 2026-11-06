/* eslint-disable no-undef */
// (cold-start N3) What are you into?'s sentence "…and we'll tell you when a neighbour asks for it" and Settings →
// Notifications' switch "When a neighbour asks for something I'm into", on the web, in a real browser:
//   node apps/pwa/e2e/asked-push-shots.mjs [--out <dir>]
//
// The real HomePage (e2e/home-pack-harness.tsx) and the real SettingsPage (e2e/settings-recovery-harness.tsx), with the
// community saying `askedPush`; every /api call answered here, nothing leaves the machine. At 320 px wide with text at 1.3x
// and at 1280 px, light and dark: no sideways scroll, the note reads in full inside its card, the switch row is at least
// 44 px tall with its words inside it and the switch on. Shots of the card and of the notification switches.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const OUT_DIR = path.resolve(argAt('--out') ?? path.join(PWA_DIR, 'e2e', 'screenshots', 'asked-push'));
fs.mkdirSync(OUT_DIR, { recursive: true });
setTimeout(() => { console.error('\nStopped after 240 s, not finished.'); process.exit(2); }, 240_000).unref();

const failures = [];
const check = (ok, what) => { if (ok) console.log(`  ok ${what}`); else { failures.push(what); console.error(`  x ${what}`); } };

const NOTE = "Tap a few. What you star comes first here and in the Market, and we'll tell you when a neighbour asks for it.";
const SWITCH = "When a neighbour asks for something I'm into";
const NOW = Date.now();
const H = 3_600_000;
const FEATURES = { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false, askedPush: true, door: 'members', knocks: true };
const answer = () => ({
    generatedAt: new Date(NOW).toISOString(), profile: 'local', features: FEATURES,
    me: { joinedAt: new Date(NOW - 3 * 24 * H).toISOString(), isKeeper: false, probation: null, interests: [], area: null, firstOffer: true, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } },
    layout: { v: 2, cards: ['interests', 'market'].map((t) => ({ id: t, type: t })), dismissed: {}, updatedAt: null },
    cards: {
        market: { items: [{ id: 'p0', type: 'offer', title: 'Pottery lessons', category: 'arts', credits: 10, photoUrl: null }], total14d: 1, more: false },
        community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
    },
});

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();

async function open(harness, { width, dark, textScale }) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    await context.addInitScript(([mode]) => {
        try { localStorage.setItem('beanpool-theme-mode', mode); localStorage.setItem('beanpool-theme-default-light-v1', 'done'); } catch { /* the default theme is still a theme */ }
    }, [dark ? 'dark' : 'light']);
    await context.route('**/api/**', (route) => {
        const url = new URL(route.request().url());
        const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
        if (url.pathname === '/api/home') return json(answer());
        if (url.pathname === '/api/community/info') return json({ profile: 'local', features: FEATURES, memberCount: 81 });
        if (url.pathname === '/api/members/preferences') return json({ notify_chat: 'true', notify_marketplace: 'true', notify_escrow: 'true', notify_knocks: 'false', notify_asked: 'true', eventReminderOffsets: [1440] });
        if (url.pathname === '/api/node-admin/me') return json({ role: null });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
    });
    await context.route('**/socket.io/**', (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (e) => failures.push(`page error: ${e}`));
    await page.goto(`${origin}/e2e/${harness}.html`, { waitUntil: 'load' });
    // The Settings harness has no theme hook of its own: the class the app's useTheme sets.
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    if (textScale !== 1) await page.addStyleTag({ content: `html { font-size: ${textScale * 100}% !important; }` });
    return { context, page };
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200)))));
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

try {
    for (const [width, textScale, size] of [[320, 1.3, '320'], [1280, 1, 'desktop']]) {
        for (const dark of [false, true]) {
            const label = `${size}-${dark ? 'dark' : 'light'}`;

            // Home: What are you into?
            {
                const { context, page } = await open('home-pack-harness', { width, dark, textScale });
                await page.waitForSelector('[data-testid="home-card-interests"]', { timeout: 60_000 });
                await settle(page);
                check(!(await sideways(page)), `${label}: Home does not scroll sideways`);
                const m = await page.evaluate(() => {
                    const card = document.querySelector('[data-testid="home-card-interests"]').getBoundingClientRect();
                    const note = document.querySelector('[data-testid="home-interests-note"]');
                    const n = note.getBoundingClientRect();
                    return { text: note.textContent, inside: n.left >= card.left - 0.5 && n.right <= card.right + 0.5, cut: note.scrollWidth > note.clientWidth + 1, h: Math.round(n.height) };
                });
                check(m.text === NOTE, `${label}: the note reads in full (${m.text})`);
                check(m.inside && !m.cut, `${label}: the note wraps whole inside the card (${m.h} px tall)`);
                await page.getByTestId('home-card-interests').screenshot({ path: path.join(OUT_DIR, `interests-${label}.png`) });
                await context.close();
            }

            // Settings → Notification Preferences.
            {
                const { context, page } = await open('settings-recovery-harness', { width, dark, textScale });
                await page.getByText('Notification Preferences').first().click();
                await page.waitForSelector('[data-testid="settings-notify-asked"]', { timeout: 60_000 });
                await settle(page);
                check(!(await sideways(page)), `${label}: Settings does not scroll sideways`);
                const r = await page.evaluate((name) => {
                    const row = document.querySelector('[data-testid="settings-notify-asked"]');
                    const b = row.getBoundingClientRect();
                    const toggle = row.querySelector('[role="switch"]');
                    const t = toggle.getBoundingClientRect();
                    const words = Array.from(row.querySelectorAll('div')).filter((d) => d.children.length === 0 && d.textContent.trim());
                    return {
                        h: Math.round(b.height), text: row.textContent, checked: toggle.getAttribute('aria-checked'), label: toggle.getAttribute('aria-label') === name,
                        toggleInside: t.right <= b.right + 0.5 && t.left >= b.left - 0.5, cut: words.some((d) => d.scrollWidth > d.clientWidth + 1),
                        wordsInside: words.every((d) => d.getBoundingClientRect().right <= t.left + 0.5),
                    };
                }, SWITCH);
                check(r.h >= 44, `${label}: the switch row is at least 44 px tall (${r.h} px)`);
                check(r.text.includes(SWITCH) && r.text.includes("At most once a day, and only for what you've starred"), `${label}: the row says its name and its line in full`);
                check(r.checked === 'true' && r.label, `${label}: the switch is on, and named by its words for a screen reader`);
                check(r.toggleInside && r.wordsInside && !r.cut, `${label}: the words wrap beside the switch, nothing cut, nothing past the row`);
                const panel = page.locator('[data-testid="settings-notify-asked"]').locator('xpath=..');
                await panel.screenshot({ path: path.join(OUT_DIR, `settings-${label}.png`) });
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
if (failures.length) { console.error(`\n${failures.length} problem(s)`); process.exit(1); }
console.log(`\nShots in ${OUT_DIR}`);
