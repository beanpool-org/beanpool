/**
 * Photographs the Market grid's event card at every width the design has to hold, and MEASURES the RSVP row
 * rather than just looking at it. Three things are checked in a real Chromium layout, for every button in every
 * shot:
 *
 *   1. the label occupies exactly one line box — anything else is "Intereste / d" (Marty, 2026-09-24);
 *   2. nothing overflows: not the label out of its button, not the row out of its card;
 *   3. when the row does wrap, it wraps *properly* — every button takes a full row of its own, which is the
 *      stacking the design asks for instead of a smaller font or a cut label.
 *
 * On origin/main this run fails: 11 split labels across the four standard cases, including the plain word
 * "Interested" broken after "Intereste" on the 1440px 5-column grid at 130% text.
 *
 * Nothing here touches a BeanPool node: the harness renders the component against the fixtures in
 * event-card-harness.tsx, and every /api and /ws request is aborted at the browser and counted, so a stray
 * fetch fails the run instead of escaping.
 *
 *   node e2e/event-card-shots.mjs      # writes e2e/shots/*.png, exits non-zero on a split or overflowing label
 *   node e2e/event-card-shots.mjs --detail   # the event's page instead (DW1): see detailShots below
 *
 * Run from apps/pwa — Tailwind reads its config from the working directory.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = path.join(PWA_DIR, 'e2e', 'shots');

/**
 * 1440 is where the bug was reported: max-w-7xl + px-6 + xl:grid-cols-5 + gap-3.5 is the narrowest column the
 * grid ever produces (235px, and 261px at 130% text — the rem-based gap grows with the root font). 320 at 130%
 * is the documented floor. The three STRESS cases are past that floor and are the ones that actually exercise
 * the wrap: everything at or inside the floor still fits side by side, so without them the stacking path would
 * ship unphotographed and unmeasured.
 */
const CASES = [
    { name: 'desktop-5col-1440', width: 1440, height: 900, fontScale: 1 },
    { name: 'desktop-5col-1440-130pc', width: 1440, height: 900, fontScale: 1.3 },
    { name: 'tablet-800', width: 800, height: 1000, fontScale: 1 },
    { name: 'phone-320-130pc', width: 320, height: 900, fontScale: 1.3 },
    { name: 'STRESS-phone-320-160pc', width: 320, height: 900, fontScale: 1.6 },
    { name: 'STRESS-phone-320-200pc', width: 320, height: 900, fontScale: 2.0 },
    { name: 'STRESS-narrow-260-130pc', width: 260, height: 900, fontScale: 1.3 },
];

/** Runs in the page: the geometry of every RSVP row and the labels inside it. */
const MEASURE = () => {
    const rows = Array.from(document.querySelectorAll('[data-testid="event-rsvp-row"]'));
    return rows.map((row) => {
        const card = row.closest('[data-testid="event-card"]') || row.parentElement;
        const cardRect = card.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        // The label's own text node, not the button: a range over the button's contents returns a rect for each
        // inline child box as well as each line box, so wrapping the label in a <span> (it is held in the layout
        // while a save is in flight) would otherwise read as a split label. A range over the text node itself is
        // exactly one rect per line box, which is what "Intereste / d" is.
        const labelTextNode = (function deepest(node) {
            for (const child of node.childNodes) {
                if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) return child;
                if (child.nodeType === Node.ELEMENT_NODE) {
                    const found = deepest(child);
                    if (found) return found;
                }
            }
            return null;
        });
        const buttons = Array.from(row.querySelectorAll('button')).map((b) => {
            const r = b.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(labelTextNode(b) || b);
            return {
                label: (b.textContent || '').trim(),
                lines: range.getClientRects().length,
                labelOverflows: b.scrollWidth > b.clientWidth,
                x: Math.round(r.x), y: Math.round(r.y),
                width: Math.round(r.width), height: Math.round(r.height),
            };
        });
        const lanes = [...new Set(buttons.map((b) => b.y))];
        return {
            buttons,
            lanes: lanes.length,
            rowWidth: Math.round(rowRect.width),
            // A wrapped button must own its row: full width, not a half-width orphan.
            badStack: lanes.length > 1 && buttons.some((b) => Math.abs(b.width - Math.round(rowRect.width)) > 1),
            rowOverflowsCard: Math.round(rowRect.right) > Math.round(cardRect.right) + 1,
            rowScrollOverflow: row.scrollWidth > row.clientWidth,
        };
    });
};

/**
 * `--detail`: the event's PAGE (EventDetail, slice DW1 of DESIGN-detail-pages-fable.md), photographed and measured in place of
 * the grid. The harness draws it at `?detail=<case>` inside the Market's own page wrapper. For every shot, in light and dark:
 *
 *   1. nothing scrolls sideways and nothing ends past the screen's edge;
 *   2. no button's words are cut (a button as wide as its words, or wrapping them whole);
 *   3. every button on the page is at least 48 px tall (the tag chips are PostTagChips' own, 44 by design, and left out);
 *   4. every line of words is 4.5:1 against what is behind it (3:1 for large words), disabled controls excepted (WCAG);
 *   5. the RSVP labels as above: one line each, inside their buttons.
 *
 * It prints where Going starts from the top of the screen at 320 px and 130% text, the number the phone's DP1 stops at
 * (500 dp on its 569 dp screen, with its header and status bar), and saves a first-screen shot (320 × 569) beside the
 * full page. At 320 px the run FAILS when the answer's top is past ANSWER_STOP_PX in any case (DESIGN-detail-pages-frame-fable.md
 * §2): Going where there is one, else the answer block (the host's line, a copy's door), from the top of the page as drawn
 * here (the wrapper's padding and the Back line included). Every /api and /ws request is aborted and counted: the page asks the node for the host's ratings, the community's
 * features and the member's reminders, and each answers as an older or unreachable node would, which the page handles.
 */
const DETAIL_CASES = [
    { name: 'phone-320-130pc', width: 320, height: 569, fontScale: 1.3, cases: ['member', 'going', 'host', 'copy', 'no-photo', 'dates', 'dates-open', 'posted-by'] },
    { name: 'tablet-800', width: 800, height: 1000, fontScale: 1, cases: ['member', 'host'] },
    { name: 'desktop-1280', width: 1280, height: 900, fontScale: 1, cases: ['member', 'host'] },
    { name: 'desktop-1440', width: 1440, height: 900, fontScale: 1, cases: ['member', 'going'] },
];

/** The answer's top at 320 px and 130% text may be no lower than this (DESIGN-detail-pages-frame-fable.md §2.1). */
const ANSWER_STOP_PX = 500;

/** Runs in the page: the page's geometry and its words' contrast. */
const MEASURE_DETAIL = () => {
    const vw = document.documentElement.clientWidth;
    const detail = document.querySelector('[data-testid="event-detail"]');
    const parse = (c) => {
        const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
    };
    const lum = ([r, g, b]) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const over = (top, under) => {
        const a = top[3];
        return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    /** The colour behind an element: its own and its ancestors' grounds, composited down to the first opaque one. */
    const behind = (el) => {
        const layers = [];
        for (let n = el; n; n = n.parentElement) {
            const c = parse(getComputedStyle(n).backgroundColor);
            if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
        }
        let colour = [255, 255, 255, 1];
        for (const l of layers.reverse()) colour = l[3] >= 1 ? l : over(l, colour);
        return colour;
    };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

    const pastEdge = [];
    const cut = [];
    const small = [];
    const lowContrast = [];
    for (const el of detail.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > vw + 0.5 || r.left < -0.5) pastEdge.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 40)}" ${Math.round(r.left)}..${Math.round(r.right)} > ${vw}`);
        if (el.tagName === 'BUTTON' || el.tagName === 'A') {
            const label = (el.textContent || '').trim().slice(0, 40);
            if (el.scrollWidth > el.clientWidth + 1) cut.push(`"${label}" ${el.scrollWidth} > ${el.clientWidth}`);
            const inTags = !!el.closest('[data-testid="post-tag-chips"]');
            if (!inTags && r.height < 47.5) small.push(`"${label}" is ${Math.round(r.height)} px tall`);
        }
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        if (own.length === 0) continue;
        const text = own.map((n) => n.textContent).join('').trim();
        // A colour emoji is drawn in its own colours, not the text's.
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        if (el.closest('button:disabled')) continue;
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        if (!fg) continue;
        const bg = behind(el);
        const size = parseFloat(cs.fontSize);
        const bold = Number(cs.fontWeight) >= 700;
        const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
        const got = ratio(fg[3] < 1 ? over(fg, bg) : fg, bg);
        if (got < need) lowContrast.push(`"${text.slice(0, 40)}" ${got.toFixed(2)}:1 (needs ${need})`);
    }
    const going = Array.from(detail.querySelectorAll('button')).find((b) => /^Going/.test((b.textContent || '').trim()));
    const action = detail.querySelector('[data-testid="event-action"]');
    const actionRect = action ? action.getBoundingClientRect() : null;
    return {
        sideways: document.documentElement.scrollWidth > vw,
        pastEdge, cut, small, lowContrast,
        goingTop: going ? Math.round(going.getBoundingClientRect().top + window.scrollY) : null,
        // The answer block's top, for the cases with no Going (the host's line, a copy's door); null when it draws nothing.
        answerTop: actionRect && actionRect.height > 0 ? Math.round(actionRect.top + window.scrollY) : null,
        pageHeight: Math.round(document.documentElement.scrollHeight),
    };
};

async function detailShots(browser, failures, countBlocked) {
    const lines = [];
    for (const theme of ['light', 'dark']) {
        for (const c of DETAIL_CASES) {
            for (const which of c.cases) {
                const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, colorScheme: theme });
                await context.route('**/*', (route) => {
                    const url = route.request().url();
                    if (url.includes('/api/') || url.startsWith('ws')) { countBlocked(); return route.abort(); }
                    return route.continue();
                });
                const page = await context.newPage();
                const pageErrors = [];
                page.on('pageerror', (e) => pageErrors.push(e.message));
                await page.goto(`${base}/e2e/event-card-harness.html?detail=${which}`, { waitUntil: 'networkidle' });
                await page.evaluate(([t, scale]) => {
                    document.documentElement.classList.toggle('dark', t === 'dark');
                    document.documentElement.classList.toggle('dark-theme', t === 'dark');
                    document.documentElement.style.fontSize = `${scale * 100}%`;
                }, [theme, c.fontScale]);
                await page.waitForSelector('[data-testid="event-detail"]');
                // The next dates opened, as a member's tap leaves them: the stop holds with the list open too (§2).
                if (which === 'dates-open') {
                    await page.click('[data-testid="event-next-dates-open"]');
                    await page.waitForSelector('[data-testid="event-next-dates"]');
                }
                await page.evaluate(() => document.fonts.ready);
                await page.waitForTimeout(150);

                const shot = `detail-${which}-${c.name}-${theme}`;
                await page.screenshot({ path: path.join(OUT_DIR, `${shot}.png`), fullPage: true });
                if (c.width === 320) await page.screenshot({ path: path.join(OUT_DIR, `${shot}-first-screen.png`) });

                const m = await page.evaluate(MEASURE_DETAIL);
                const rows = await page.evaluate(MEASURE);
                if (m.sideways) failures.push(`${shot}: the page scrolls sideways`);
                for (const f of m.pastEdge) failures.push(`${shot}: past the edge: ${f}`);
                for (const f of m.cut) failures.push(`${shot}: a button's words are cut: ${f}`);
                for (const f of m.small) failures.push(`${shot}: under the 48 px target: ${f}`);
                for (const f of m.lowContrast) failures.push(`${shot}: under AA: ${f}`);
                for (const r of rows) {
                    for (const b of r.buttons) {
                        if (b.lines !== 1) failures.push(`${shot}: "${b.label}" occupies ${b.lines} line boxes`);
                        if (b.labelOverflows) failures.push(`${shot}: "${b.label}" overflows its button`);
                    }
                }
                if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
                const answer = m.goingTop ?? m.answerTop;
                if (c.width === 320 && answer != null && answer > ANSWER_STOP_PX) {
                    failures.push(`${shot}: the answer starts at ${answer} px, past the ${ANSWER_STOP_PX} px stop`);
                }
                lines.push(`${shot.padEnd(44)} Going at ${m.goingTop ?? '—'} px, the answer at ${m.answerTop ?? '—'} px, page ${m.pageHeight} px tall`);
                await context.close();
            }
        }
    }
    return lines;
}

const DETAIL_ONLY = process.argv.includes('--detail');

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 } });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
let blocked = 0;

let detailLines = [];
try {
    if (DETAIL_ONLY) detailLines = await detailShots(browser, failures, () => { blocked++; });
    for (const theme of (DETAIL_ONLY ? [] : ['light', 'dark'])) {
        for (const c of CASES) {
            const context = await browser.newContext({
                viewport: { width: c.width, height: c.height },
                colorScheme: theme,
            });
            // No node, ever. Anything node-shaped is refused and counted.
            await context.route('**/*', (route) => {
                const url = route.request().url();
                if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));

            await page.goto(`${base}/e2e/event-card-harness.html`, { waitUntil: 'networkidle' });
            await page.evaluate(([t, scale]) => {
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.classList.toggle('dark-theme', t === 'dark');
                document.documentElement.style.fontSize = `${scale * 100}%`;
            }, [theme, c.fontScale]);
            await page.waitForSelector('[data-testid="event-rsvp-row"]');
            await page.evaluate(() => document.fonts.ready);

            const shot = `${c.name}-${theme}.png`;
            // The grid only, not the whole page: the cards are the evidence and a full-page shot of the
            // background pattern is megabytes of nothing.
            await page.locator('.grid').screenshot({ path: path.join(OUT_DIR, shot) });

            const rows = await page.evaluate(MEASURE);
            if (rows.length === 0) failures.push(`${shot}: no RSVP rows rendered`);
            for (const r of rows) {
                for (const b of r.buttons) {
                    if (b.lines !== 1) failures.push(`${shot}: "${b.label}" occupies ${b.lines} line boxes (${b.width}x${b.height})`);
                    if (b.labelOverflows) failures.push(`${shot}: "${b.label}" overflows its button (${b.width}px)`);
                    if (b.height < 48) failures.push(`${shot}: "${b.label}" is ${b.height}px tall, under the 48px target`);
                }
                if (r.badStack) failures.push(`${shot}: wrapped row has a button that is not full width`);
                if (r.rowOverflowsCard) failures.push(`${shot}: the RSVP row overflows its card`);
                if (r.rowScrollOverflow) failures.push(`${shot}: the RSVP row scrolls sideways`);
            }
            if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);

            const stacked = rows.some((r) => r.lanes > 1);
            const widths = rows[0]?.buttons.map((b) => `${b.label}=${b.width}x${b.height}`).join(' ') ?? '';
            console.log(`${shot.padEnd(36)} ${rows.length} rows, ${stacked ? 'STACKED' : 'side by side'}, all labels on one line: ${rows.every((r) => r.buttons.every((b) => b.lines === 1))}`);
            console.log(`${' '.repeat(36)} first card: ${widths}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}

if (DETAIL_ONLY) {
    for (const l of detailLines) console.log(l);
    // The page asks for the host's ratings, the community's features and the reminders: each is refused here, as no node.
    console.log(`\nnode requests blocked: ${blocked} (the page's own reads, each refused: nothing reached a node)`);
} else {
    console.log(`\nnode requests blocked: ${blocked} (0 expected — the harness needs none)`);
}
if (failures.length) {
    console.error(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
}
console.log(DETAIL_ONLY
    ? `\nOK — the event page: nothing past the edge or cut, every button >= 48px, every line at AA, in all ${detailLines.length} shots.`
    : `\nOK — every RSVP label whole and on one line, every target >= 48px, nothing overflowing, in all ${CASES.length * 2} shots.`);
console.log(OUT_DIR);
