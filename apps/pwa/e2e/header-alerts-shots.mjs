/* global process, console, document, getComputedStyle, innerWidth, window, requestAnimationFrame, setTimeout, URL */
/**
 * The bell (it took the needs-you icons' place: DESIGN-web-notifications-fable.md §2.1, Marty 9 Nov 2026) in App's real
 * header row and side bar (e2e/header-alerts-harness.tsx: MobileHeader and
 * SidebarStatus, as App.tsx draws them), in headless Chromium with the tab and the needs changed IN PLACE on one mounted
 * header, as the app runs: 320, 360, 375, 390, 412, 430, 480, 700 and 1280 px wide, 100% and 130% text, light and dark,
 * the chip at its widest ("Offline", "59m ago" under it) and at "Offline" alone, with no needs, one, three and five, along
 * a route of tab changes (Home → Map → Home → Commons, and the deciding review's People, Market, Commons, The Pulse, Chat,
 * Home, Commons).
 *
 * Fails (exit 1) on, at any step: a tab's title cut or met by the bell; the bell's slot not the width the row's rule
 * gives it (the title's words first, then the bell's 44 px; on the map, to 4 px short of the logo; from 768 px none, where
 * the side bar has it and the header row still shows beside it); what is drawn not what fits in the slot as it is now (the
 * bell at 44 px, the small one from 28 px, none under that); the bell or its red count outside its slot; the bell under
 * 44 px tall; the pill off the screen or sideways scroll; in the side bar, the bell's row, the "?" or Settings past its
 * edge, or the bell sharing Settings' row. The node's list is answered here with three notices, so the red count is drawn
 * at every step. Then the sheet, at 320 px and 130% text in both themes: inside the screen, every row at least 44 px tall,
 * no sideways scroll (crops sheet-*.png).
 *
 * Run from apps/pwa: node e2e/header-alerts-shots.mjs   (HEADER_ALERTS_SHOTS_DIR=<dir>: where the crops and results.json
 * go; default e2e/screenshots/header-alerts, gitignored). Nothing here talks to a node: every request off this machine
 * is aborted, and so is every /api request.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.env.HEADER_ALERTS_SHOTS_DIR || path.join(PWA_DIR, 'e2e', 'screenshots', 'header-alerts');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const WIDTHS = (process.env.HEADER_ALERTS_WIDTHS || '320,360,375,390,412,430,480,700,1024,1280').split(',').map(Number);
const TEXT = [100, 130];
const THEMES = ['light', 'dark'];
/** [tab, kinds of need, Settings open]: one mounted header the whole way. */
const ROUTE = [
    ['home', 0], ['home', 3], ['map', 3], ['home', 3], ['projects', 3], ['projects', 0], ['projects', 1],
    ['people', 1], ['marketplace', 1], ['projects', 1], ['pulse', 1], ['messages', 1], ['home', 1], ['projects', 1],
    ['people', 3], ['marketplace', 3], ['projects', 3], ['pulse', 3], ['messages', 3], ['home', 3], ['projects', 3],
    ['map', 5], ['projects', 5], ['ledger', 5], ['home', 5], ['map', 1], ['map', 3, true], ['map', 0], ['projects', 0],
];

/** What the node's list answers here: three notices, so the red count is drawn (GET /api/notices/push?unseen=1). */
const nowS = Math.floor(Date.now() / 1000);
const BELL_LIST = { notices: [
    { id: 'n1', kind: 'chat.message', title: '💬 New Message', body: 'Maya Fernández-Okonkwo sent you a message', data: { screen: 'chat', conversationId: 'c1' }, sentAt: nowS - 120, seenAt: null },
    { id: 'n2', kind: 'market.request', title: '🤝 New request for "Hand-built sourdough starter kit with jar and notes"', body: 'Ben asked for your sourdough starter kit and would like to collect it this weekend', data: { screen: 'post', postId: 'p1' }, sentAt: nowS - 3 * 3600, seenAt: null },
    { id: 'n3', kind: 'community.notice', title: '🛡️ Your report', body: 'The post you reported was reviewed and kept.', data: {}, sentAt: nowS - 2 * 86400, seenAt: null },
] };

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();

/** In the page: the header row and the side bar as laid out now. */
const measure = () => {
    const SLOT = 44, CHIP = 28, CLEAR = 4;
    const r = (e) => e.getBoundingClientRect();
    const out = { scrollW: document.documentElement.scrollWidth, problems: [] };
    const header = document.querySelector('header');
    if (header && r(header).width > 0) {
        const middle = header.querySelector('[data-header-middle]');
        const slot = header.querySelector('[data-needs-slot]');
        const span = header.querySelector('[data-testid="header-title"]');
        const logo = header.querySelector('[data-testid="header-logo"]');
        const pill = r(header.querySelector('[data-testid="header-pill"]'));
        const chipEl = header.querySelector('[data-testid="sync-chip"]');
        const buttons = [...slot.querySelectorAll('button')];
        const s = r(slot), m = r(middle);
        const basis = parseFloat(slot.style.flexBasis) || 0;
        const drawn = buttons.map(b => (b.style.width === `${CHIP}px` ? 'small' : 'bell'));
        const h = { basis, drawn, slot: Math.round(s.width * 10) / 10, middle: Math.round(m.width * 10) / 10, dotOnly: chipEl?.dataset.dotOnly === 'true', pillRight: Math.round(pill.right) };
        if (basis !== SLOT) out.problems.push(`slot basis ${basis} px, not the bell's ${SLOT}`);
        let expectSlot;
        if (span) {
            const cs = getComputedStyle(span), pl = parseFloat(cs.paddingLeft), pr = parseFloat(cs.paddingRight);
            const range = document.createRange(); range.selectNodeContents(span);
            const words = range.getBoundingClientRect().width;
            const content = r(span).width - pl - pr;
            const box = r(span.parentElement);
            h.title = span.textContent;
            h.cut = words > content + 0.01;
            h.need = Math.round((words + pl + pr) * 10) / 10;
            expectSlot = Math.max(0, Math.min(SLOT, m.width - (words + pl + pr)));
            if (h.cut && words + pl + pr <= m.width) out.problems.push(`"${h.title}" cut with room for it`);
            else if (h.cut) out.problems.push(`"${h.title}" cut (no room even alone: ${h.need} > ${h.middle})`);
            if (buttons.length && Math.min(...buttons.map(b => r(b).left)) < box.right - 0.5) out.problems.push(`the bell meets "${h.title}"`);
        } else {
            // The logo's right edge: its box, and the bean, the word and the version under its end (which hangs past it).
            const lr = Math.max(r(logo).right, ...[...(logo.firstElementChild?.children ?? [])].map(c => r(c).right));
            h.logoRight = Math.round(lr);
            expectSlot = Math.min(SLOT, Math.max(0, Math.floor(m.right - lr - CLEAR)));
            if (buttons.length && Math.min(...buttons.map(b => r(b).left)) < lr + CLEAR - 0.5) out.problems.push('the bell under the logo');
        }
        // From 768 px the side bar has the bell, and the header (which still shows beside it) none.
        h.wide = getComputedStyle(slot).display === 'none';
        if (h.wide) expectSlot = 0;
        h.expectSlot = Math.round(expectSlot * 10) / 10;
        if (Math.abs(s.width - expectSlot) > 1) out.problems.push(`slot ${h.slot} px, the rule gives ${h.expectSlot}`);
        // What fits in the slot as it is now: the bell, the small bell, or nothing.
        const want = s.width >= SLOT - 0.5 ? 'bell' : s.width >= CHIP ? 'small' : null;
        if ((drawn[0] ?? null) !== want || drawn.length > 1) out.problems.push(`drew ${drawn.join(',') || 'nothing'} in ${h.slot} px (fits ${want ?? 'nothing'})`);
        for (const b of buttons) {
            const br = r(b);
            if (br.left < s.left - 0.5 || br.right > s.right + 0.5) out.problems.push(`the bell outside its slot`);
            if (br.height < 43.5) out.problems.push(`the bell ${br.height} px tall`);
            const count = b.querySelector('[data-testid="bell-count"]');
            if (!count) out.problems.push('no red count with three notices');
            else if (r(count).right > s.right + 0.5 || r(count).left < s.left - 0.5) out.problems.push('the red count outside the slot');
        }
        if (pill.right > innerWidth + 0.5) out.problems.push(`pill off the screen (${h.pillRight})`);
        out.header = h;
    }
    const aside = document.querySelector('aside');
    if (aside && r(aside).width > 0) {
        const a = r(aside);
        const row = aside.querySelector('[data-testid="sidebar-needs-row"]');
        const settings = aside.querySelector('[data-testid="sidebar-settings"]');
        const help = r(aside.querySelector('[data-testid="sidebar-help"]'));
        const chipEl = aside.querySelector('[data-testid="sync-chip"]');
        const words = chipEl ? chipEl.querySelector('[data-chip-words]') : null;
        const buttons = row ? [...row.querySelectorAll('button')] : [];
        const chipCut = chipEl ? (chipEl.scrollWidth > chipEl.clientWidth + 0.5 || (words && (words.scrollWidth > words.clientWidth + 0.5 || r(words).right > r(chipEl).right + 0.5))) : false;
        const sd = {
            drawn: buttons.map(b => b.dataset.testid),
            lines: new Set(buttons.map(b => Math.round(r(b).top))).size,
            settingsRight: Math.round(r(settings).right), helpRight: Math.round(help.right), asideRight: Math.round(a.right),
            chip: chipEl ? Math.round(r(chipEl).width) : 0, chipWordsCut: chipCut,
        };
        if (chipCut) out.problems.push(`side bar: sync chip text is cut or clipped (scrollWidth ${chipEl.scrollWidth} > clientWidth ${chipEl.clientWidth})`);
        const sideBtns = [
            aside.querySelector('[data-testid="sidebar-help"]'),
            aside.querySelector('[data-testid="sidebar-invite"]'),
            aside.querySelector('[data-testid="sidebar-settings"]'),
        ].filter(Boolean);
        for (const b of sideBtns) {
            const br = r(b);
            if (br.width < 43.5 || br.height < 43.5) {
                out.problems.push(`side bar: ${b.dataset.testid} button shrinks below 44 px (${Math.round(br.width)}x${Math.round(br.height)})`);
            }
        }
        if (r(settings).right > a.right + 0.5 || help.right > a.right + 0.5) out.problems.push('side bar: ? or Settings past its edge');
        for (const b of buttons) if (r(b).right > a.right + 0.5 || r(b).left < a.left - 0.5) out.problems.push(`side bar: ${b.dataset.testid} past its edge`);
        if (row && row.contains(settings)) out.problems.push('side bar: the bell shares Settings\' row');
        if (buttons.length !== 1 || buttons[0].dataset.testid !== 'sidebar-bell') out.problems.push(`side bar: ${buttons.length} controls in the bell's row`);
        out.side = sd;
    }
    if (out.scrollW > innerWidth) out.problems.push(`sideways scroll ${out.scrollW}`);
    return out;
};

const results = [];
let failures = 0;
for (const width of WIDTHS) {
    const isDesktop = width >= 768;
    const chips = isDesktop ? ['online-time', 'offline-time', 'syncing', 'plain'] : ['ago', 'plain'];
    const langs = isDesktop ? ['en', 'de', 'ru', 'ml'] : ['en'];
    const route = isDesktop ? [['home', 0], ['home', 3], ['home', 3, true], ['people', 1]] : ROUTE;

    for (const text of TEXT) {
        for (const theme of THEMES) {
            for (const chip of chips) {
                for (const lang of langs) {
                    const ctx = await browser.newContext({ viewport: { width, height: 560 }, colorScheme: theme, reducedMotion: 'reduce' });
                    await ctx.route('**/*', (route) => {
                        const u = new URL(route.request().url());
                        if (u.hostname === 'localhost' && u.pathname === '/api/notices/push') return route.fulfill({ json: BELL_LIST });
                        return u.hostname === 'localhost' && !u.pathname.startsWith('/api/') ? route.continue() : route.abort();
                    });
                    const page = await ctx.newPage();
                    const langParam = lang && lang !== 'en' ? `&lang=${lang}` : '';
                    await page.goto(`${origin}/e2e/header-alerts-harness.html?chip=${chip}${theme === 'dark' ? '&dark=1' : ''}${langParam}`, { waitUntil: 'load' });
                    await page.waitForFunction(() => !!window.harness);
                    // Settled layouts only: the sync chip eases into a new size over 0.3 s (its own inline transition), and a
                    // measure in the middle of that is of neither the old row nor the new one.
                    await page.addStyleTag({ content: `*, *::before, *::after { transition: none !important; }${text !== 100 ? ` html { font-size: ${text}% !important; }` : ''}` });
                    await page.evaluate(() => document.fonts.ready);
                    for (let i = 0; i < route.length; i++) {
                        const [tab, needs, settings = false] = route[i];
                        await page.evaluate((s) => window.harness.set(s), { tab, needs, settings });
                        await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 30)))));
                        const m = await page.evaluate(measure);
                        const key = `${width}-${text}-${theme}-${chip}${lang !== 'en' ? `-${lang}` : ''}-${String(i).padStart(2, '0')}-${tab}${settings ? '+settings' : ''}-${needs}`;
                        results.push({ key, width, text, theme, chip, lang, step: i, tab, needs, settings, ...m });
                        if (m.problems.length) { failures++; console.log('FAIL', key, m.problems.join('; ')); }
                        // Crops of what was measured, at most 900 px wide: the header row (its right-hand 900 px on a wide
                        // screen), and on a wide screen the side bar's footer.
                        if (m.header) {
                            const hb = await page.locator('header').boundingBox();
                            await page.screenshot({ path: path.join(SHOTS_DIR, `header-${key}.png`), clip: { x: Math.max(0, width - 900), y: 0, width: Math.min(width, 900), height: Math.ceil(hb.y + hb.height + 6) } });
                        }
                        if (m.side) {
                            const fb = await page.locator('aside > div').last().boundingBox();
                            await page.screenshot({ path: path.join(SHOTS_DIR, `sidebar-${key}.png`), clip: { x: 0, y: Math.max(0, Math.floor(fb.y - 8)), width: Math.ceil(fb.width + 8), height: Math.ceil(fb.height + 16) } });
                        }
                    }
                    await ctx.close();
                }
            }
        }
    }
}
// The sheet, at the floor: 320 px and 130% text, both themes, with three needs and three notices.
for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: theme, reducedMotion: 'reduce' });
    await ctx.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.hostname === 'localhost' && u.pathname === '/api/notices/push') return route.fulfill({ json: BELL_LIST });
        return u.hostname === 'localhost' && !u.pathname.startsWith('/api/') ? route.continue() : route.abort();
    });
    const page = await ctx.newPage();
    await page.goto(`${origin}/e2e/header-alerts-harness.html?chip=plain${theme === 'dark' ? '&dark=1' : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.harness);
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    await page.evaluate(() => window.harness.set({ tab: 'home', needs: 3 }));
    // Opened at 100% (at 130% the row beside "Home" has no room for the bell at 320 px), then the text grows to 130%.
    await page.waitForSelector('[data-testid="header-bell"] [data-testid="bell-count"]');
    await page.evaluate(() => document.querySelector('[data-testid="header-bell"]').click());
    await page.waitForSelector('[data-testid="needs-sheet"]');
    await page.addStyleTag({ content: 'html { font-size: 130% !important; }' });
    await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 50)))));
    const m = await page.evaluate(() => {
        const problems = [];
        const sheet = document.querySelector('[data-testid="needs-sheet"]').getBoundingClientRect();
        if (sheet.left < -0.5 || sheet.right > innerWidth + 0.5) problems.push(`sheet ${Math.round(sheet.left)}–${Math.round(sheet.right)} past the screen`);
        for (const b of document.querySelectorAll('[data-testid="needs-sheet"] button')) {
            const br = b.getBoundingClientRect();
            if (br.height < 43.5) problems.push(`${b.getAttribute('aria-label') || b.textContent.slice(0, 20)} ${Math.round(br.height)} px tall`);
            if (br.right > sheet.right + 0.5) problems.push('a row past the sheet');
        }
        if (document.querySelectorAll('[data-testid="bell-notice"]').length !== 3) problems.push('not three notices');
        if (document.documentElement.scrollWidth > innerWidth) problems.push(`sideways scroll ${document.documentElement.scrollWidth}`);
        return { problems };
    });
    const key = `sheet-320-130-${theme}`;
    results.push({ key, width: 320, text: 130, theme, ...m });
    if (m.problems.length) { failures++; console.log('FAIL', key, m.problems.join('; ')); }
    await page.screenshot({ path: path.join(SHOTS_DIR, `${key}.png`), clip: { x: 0, y: 0, width: 320, height: 640 } });
    await ctx.close();
}
fs.writeFileSync(path.join(SHOTS_DIR, 'results.json'), JSON.stringify(results, null, 1));
await browser.close();
await server.close();
console.log(`${results.length} steps measured, ${failures} with a problem. Crops and results.json in ${SHOTS_DIR}`);
process.exit(failures ? 1 : 0);
