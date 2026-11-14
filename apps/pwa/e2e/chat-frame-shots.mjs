/**
 * The Chat tab's top (slice T0, pages/ChatTabPage.tsx; DESIGN-forums-messaging-joint-fable.md §2.1) in a real Chromium
 * layout: the harness (e2e/chat-frame-harness.tsx) draws the real ChatTabPage over the real MessagesPage. At 320 px with
 * 1.3x text and at 1280 px, in Light (at 320 px in all 25 languages and the pseudo-locale, every sentence about 40 % longer)
 * and Dark (English, the pseudo-locale, German, Tamil), with the community's forum on, it photographs Chats and Forum and
 * CHECKS what jsdom can't:
 *   1. nothing of this slice runs off sideways: nothing in the switch or the Forum's page passes the page's edge, and
 *      neither name runs past its tab or takes a second line (the list's own heading row is main's: what of it passes the edge is reported, and
 *      the same page with the forum off is photographed to show it is not the switch's);
 *   2. each tab is a 44 px target or more, inside the page's width, and the page holds one switch;
 *   3. on Chats the switch sits above the list's heading and chips; on Forum the Forum's page is under it and the list hidden;
 *   4. both names read against the page: 4.5:1, or 3:1 where WCAG counts them as large text (18.66 px bold);
 * and with the forum off, that no switch is drawn at all. It prints a table (markdown) and exits non-zero on any failed
 * check. Nothing here touches a BeanPool node.
 *
 *   node e2e/chat-frame-shots.mjs [shots-dir]
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 */
/* global process, console, document, localStorage, window, getComputedStyle */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PWA_DIR, 'e2e', 'shots');
const LOOKS = ['light', 'dark'];
const SIZES = [{ name: '320', w: 320, h: 569, scale: 1.3 }, { name: '1280', w: 1280, h: 800, scale: 1 }];
// At 320 px in Light, every language (a name that wraps fails); Dark's colours are checked in four of them.
const ALL_LANGS = ['en', 'xx', ...fs.readdirSync(path.join(PWA_DIR, '..', '..', 'packages', 'beanpool-core', 'words')).filter((f) => /^[a-z]{2,3}(-[A-Za-z]+)?\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')).sort()];
const DARK_LANGS = ['en', 'xx', 'de', 'ta'];

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;
fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
const rows = [];

/** A context whose node answers the community's info and an empty conversation list, and nothing else. */
async function open(look, size, lang, forum) {
    const context = await browser.newContext({ viewport: { width: size.w, height: size.h } });
    await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.includes('/api/community/info')) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profile: 'local', features: forum ? { beans: true, forum: true } : { beans: true } }) });
        }
        if (url.includes('/api/messages/conversations/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversations: [], totalUnread: 0 }) });
        if (url.includes('/api/') || url.startsWith('ws')) return route.abort();
        return route.continue();
    });
    await context.addInitScript((l) => { try { localStorage.setItem('beanpool-theme-mode', l); } catch { /* none */ } }, look);
    const page = await context.newPage();
    await page.goto(`${base}/e2e/chat-frame-harness.html?lang=${lang}`);
    await page.waitForSelector('[data-ready="1"]', { timeout: 30000 });
    await page.evaluate((scale) => { document.documentElement.style.fontSize = `${scale * 100}%`; }, size.scale);
    return { context, page };
}

/** What the checks read off the page as drawn. */
function measure() {
    const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (s) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const backgroundOf = (el) => {
        for (let e = el; e; e = e.parentElement) {
            const c = parse(getComputedStyle(e).backgroundColor);
            if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) return c.slice(0, 3);
        }
        return [255, 255, 255];
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const lists = Array.from(document.querySelectorAll('[role="tablist"]'));
    const list = lists[0];
    const out = { pageScroll: document.documentElement.scrollWidth > window.innerWidth + 1, switch: !!list, switches: lists.length, tabs: [], wide: [], wideMine: [] };
    // What runs past the page's right edge: the innermost elements, named by test id or tag and their first words.
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= window.innerWidth + 1) continue;
        if (Array.from(el.children).some((c) => c.getBoundingClientRect().right > window.innerWidth + 1)) continue;
        const what = `${el.getAttribute('data-testid') ?? el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.left)}..${Math.round(r.right)}`;
        // This slice's own: inside a switch or the Forum's page. Anything else is the list's own (main's), reported only.
        if (el.closest('[role="tablist"], [data-testid="forum-page"]')) out.wideMine.push(what); else out.wide.push(what);
        if (out.wide.length + out.wideMine.length >= 4) break;
    }
    if (!list) return out;
    for (const tab of Array.from(list.querySelectorAll('[role="tab"]'))) {
        const r = tab.getBoundingClientRect();
        out.tabs.push({
            name: tab.textContent, selected: tab.getAttribute('aria-selected') === 'true', height: r.height, left: r.left, right: r.right,
            overflow: tab.scrollWidth > tab.clientWidth + 1,
            // How many lines the name takes: one, or the switch grows and a long word breaks inside itself.
            lines: (() => { const range = document.createRange(); range.selectNodeContents(tab); return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size; })(),
            contrast: ratio(parse(getComputedStyle(tab).color).slice(0, 3), backgroundOf(tab)),
            // WCAG's large text: 24 px, or 18.66 px bold. It needs 3:1; other text 4.5:1.
            large: parseFloat(getComputedStyle(tab).fontSize) >= 24 || (parseFloat(getComputedStyle(tab).fontSize) >= 18.66 && Number(getComputedStyle(tab).fontWeight) >= 700),
        });
    }
    const top = list.getBoundingClientRect().top;
    const chips = document.querySelector('[data-testid="conversation-filter-chips"]');
    const heading = document.querySelector('h2');
    out.aboveList = !!chips && chips.offsetParent !== null && chips.getBoundingClientRect().top > top && !!heading && heading.getBoundingClientRect().top > top;
    const forum = document.querySelector('[data-testid="forum-page"]');
    out.forumUnder = !!forum && forum.getBoundingClientRect().top >= list.getBoundingClientRect().bottom - 1;
    out.listHidden = !chips || chips.offsetParent === null;
    out.switchHeight = Math.round(list.getBoundingClientRect().height);
    return out;
}

try {
    for (const look of LOOKS) {
        for (const size of SIZES) {
            for (const lang of look === 'light' ? ALL_LANGS : DARK_LANGS) {
                if (lang !== 'en' && size.name !== '320') continue;
                const name = `${look} ${size.name}${size.scale !== 1 ? ` ×${size.scale}` : ''} ${lang}`;
                const { context, page } = await open(look, size, lang, true);
                const problems = [];
                await page.waitForSelector('[role="tablist"]', { timeout: 15000 }).catch(() => problems.push('no switch where the forum is on'));
                await page.waitForSelector('[data-testid="conversation-filter-chips"]', { timeout: 15000 }).catch(() => problems.push('no list under Chats'));
                await page.waitForTimeout(150);
                const chats = await page.evaluate(measure);
                await page.screenshot({ path: path.join(OUT_DIR, `chat-frame-${look}-${size.name}-${lang}-chats.png`) });
                await page.click('[data-testid="chat-side-forum"]');
                await page.waitForTimeout(150);
                const forum = await page.evaluate(measure);
                await page.screenshot({ path: path.join(OUT_DIR, `chat-frame-${look}-${size.name}-${lang}-forum.png`) });
                for (const [side, m] of [['Chats', chats], ['Forum', forum]]) {
                    if (m.wideMine.length) problems.push(`${side}: runs past the page: ${m.wideMine.join("; ")}`);
                    if (m.switches !== 1) problems.push(`${side}: ${m.switches} switches in the page`);
                    if (m.tabs.length !== 2) { problems.push(`${side}: ${m.tabs.length} tabs`); continue; }
                    for (const tb of m.tabs) {
                        if (tb.height < 44) problems.push(`${side}: "${tb.name}" is ${tb.height} px tall`);
                        if (tb.left < -0.5 || tb.right > size.w + 0.5) problems.push(`${side}: "${tb.name}" leaves the page (${Math.round(tb.left)}..${Math.round(tb.right)})`);
                        if (tb.overflow) problems.push(`${side}: "${tb.name}" runs past its tab`);
                        if (tb.lines > 1) problems.push(`${side}: "${tb.name}" takes ${tb.lines} lines`);
                        const floor = tb.large ? 3 : 4.5;
                        if (tb.contrast < floor) problems.push(`${side}: "${tb.name}" reads ${tb.contrast.toFixed(2)}:1, under ${floor}:1`);
                    }
                }
                if (!chats.aboveList) problems.push('Chats: the switch is not above the heading and chips');
                if (!(forum.forumUnder && forum.listHidden)) problems.push('Forum: the Forum page is not under the switch, or the list still shows');
                if (forum.tabs.find((tb) => tb.selected)?.name !== chats.tabs[1]?.name) problems.push('Forum: the Forum tab is not the one shown');
                for (const p of problems) failures.push(`${name}: ${p}`);
                const contrast = chats.tabs.map((tb) => tb.contrast.toFixed(1)).join(' / ');
                rows.push(`| ${name} | ${chats.tabs.map((tb) => tb.name).join(" · ")} | ${chats.switchHeight} px | ${contrast} | ${problems.length ? "FAIL" : "ok"}${chats.pageScroll ? ` (the list scrolls sideways, as with the forum off: ${chats.wide.join("; ")})` : ""} |`);
                await context.close();
            }
            // The forum off: the list exactly as before, and no switch. Its sideways scroll is reported, not failed: it is
            // the list's own (main), and the same page with the switch must scroll no further (checked above per language).
            for (const lang of size.name === '320' ? ['en', 'xx'] : ['en']) {
                const { context, page } = await open(look, size, lang, false);
                await page.waitForSelector('[data-testid="conversation-filter-chips"]', { timeout: 15000 }).catch(() => failures.push(`${look} ${size.name} ${lang}: no list with the forum off`));
                await page.waitForTimeout(300);
                const off = await page.evaluate(measure);
                await page.screenshot({ path: path.join(OUT_DIR, `chat-frame-${look}-${size.name}-${lang}-forum-off.png`) });
                if (off.switch) failures.push(`${look} ${size.name} ${lang}: a switch with the forum off`);
                rows.push(`| ${look} ${size.name} ${lang}, forum off | (none) | | | ${off.switch ? 'FAIL' : 'ok'}${off.pageScroll ? ` (scrolls sideways: ${off.wide.join('; ')})` : ''} |`);
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}

console.log('| look, width, language | the two names | switch height | contrast (Chats / Forum) | checks |\n|---|---|---|---|---|');
for (const r of rows) console.log(r);
if (failures.length) {
    console.error(`\n${failures.length} failed check(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
}
console.log('\nall checks pass');
