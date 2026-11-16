/**
 * Forum links on the web (slice F9; DESIGN-forums-fable.md §10.2 to §10.5, §14 "320 px, 1.3x text, Classic / Light / Dark")
 * in a real Chromium layout: the harness (e2e/forum-links-harness.tsx) draws the real ForumPage on a topic whose chips are a
 * shown group, a placeholder listing, "Posted as a Need ›" and a shown event, the real "Talked about in the forum" block, and
 * (`?sheet=1`) the real Link sheet with something linked and the member's groups, listings and events to pick from. At 320 px
 * with 1.3x text, in Classic, Light and Dark, in English, the pseudo-locale (every sentence about 40 % longer) and German, it
 * photographs each and CHECKS what jsdom can't:
 *   1. nothing of this slice runs past the page's right edge, and the page never scrolls sideways;
 *   2. every chip, every linked topic and every button of the sheet is a 44 px target or more;
 *   3. every chip's words, every linked topic's title and every row of the sheet read 4.5:1 or more against what is under them;
 *   4. no words spill out of their own box, and no row of the sheet is drawn over the one above it.
 * It prints a table (markdown) and exits non-zero on any failed check. Nothing here touches a BeanPool node.
 *
 *   node e2e/forum-links-shots.mjs [shots-dir]
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
// The stored looks: 'dark' is Classic, 'light' Light, 'night' Dark (lib/useTheme.ts THEME_PREFERENCE_OPTIONS).
const LOOKS = [['dark', 'Classic'], ['light', 'Light'], ['night', 'Dark']];
const SIZE = { w: 320, h: 569, scale: 1.3 };
const LANGS = ['en', 'xx', 'de'];

const AT = new Date(Date.now() - 3 * 3600_000).toISOString();
const ME = 'a'.repeat(64);
const SECTIONS = [{ id: 's-1', starter: 'general', name: null, about: null, position: 0, starts: 'members', listed: false, archived: false }];
const shown = (kind, id, title, over = {}) => ({ kind, shown: true, id, title, photo: null, listingType: null, startAt: null, byWriter: false, ...over });
const TOPIC = {
    id: 'ft-1', sectionId: 's-1', title: 'How do we start a seed library in a small town?', writer: { publicKey: ME, name: 'Ana' }, place: null, lang: 'en',
    replyCount: 1, lastActivityAt: AT, createdAt: AT, pinned: false, closed: null, removed: false, hidden: false, follow: null, unread: false, decision: null,
    links: [
        shown('group', 'g-1', 'Riverside community garden working group'),
        { kind: 'listing', shown: false },
        shown('listing', 'n-1', 'Seed library shelves', { listingType: 'need', byWriter: true }),
        shown('event', 'e-1', 'Seed swap at the hall', { startAt: AT }),
    ],
};
const POSTS = [
    { id: 'fp-1', topicId: 'ft-1', number: 1, writer: TOPIC.writer, words: 'We are six families near the river. Who has done this before?', quotes: null, lang: 'en', createdAt: AT, editedAt: null, removed: null, photos: 0, hidden: false, linksOn: true },
];
const ANSWERS = {
    '/api/community/info': { profile: 'local', features: { beans: true, forum: true } },
    '/api/forum': { sections: SECTIONS, public: false, told: true, moderator: false, firstLooksWaiting: null, firstTopicWaits: false, linksOn: true },
    '/api/forum/topics/ft-1': { topic: TOPIC, posts: POSTS, next: null, lastRead: 1 },
    '/api/forum/topics/ft-1/read': { lastRead: 1 },
    '/api/forum/linked': { topics: [{ id: 'ft-1', sectionId: 's-1', title: TOPIC.title, replyCount: 12, lastActivityAt: AT }, { id: 'ft-2', sectionId: 's-1', title: 'Shelving offcuts', replyCount: 1, lastActivityAt: AT }] },
    '/api/your-groups': { items: [{ kind: 'group', id: 'g-1', name: 'Riverside community garden working group', role: 'member' }, { kind: 'group', id: 'g-2', name: 'Tool library', role: 'member' }] },
    '/api/marketplace/posts': [{ id: 'n-1', type: 'need', title: 'Seed library shelves', authorPublicKey: ME }, { id: 'n-2', type: 'offer', title: 'Jam jars, about forty of them', authorPublicKey: ME }],
    '/api/events/mine': [{ postId: 'e-1', title: 'Seed swap at the hall', startAt: AT, endAt: null, placeName: null, rsvp: 'going', photo: null, reminderOffsets: null }],
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;
fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
const rows = [];

async function open(look, lang, sheet) {
    const context = await browser.newContext({ viewport: { width: SIZE.w, height: SIZE.h } });
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/api/')) {
            const answer = ANSWERS[url.pathname];
            return answer === undefined ? route.abort() : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) });
        }
        if (url.protocol.startsWith('ws')) return route.abort();
        return route.continue();
    });
    await context.addInitScript((l) => { try { localStorage.setItem('beanpool-theme-mode', l); } catch { /* none */ } }, look);
    const page = await context.newPage();
    await page.goto(`${base}/e2e/forum-links-harness.html?lang=${lang}${sheet ? '&sheet=1' : ''}`);
    await page.waitForSelector('[data-ready="1"]', { timeout: 30000 });
    await page.evaluate((scale) => { document.documentElement.style.fontSize = `${scale * 100}%`; }, SIZE.scale);
    return { context, page };
}

/** What the checks read off the page as drawn: the slice's own parts, by test id. */
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
    const MINE = '[data-testid="forum-topic"], [data-testid="listing-side"], [data-testid="forum-link-sheet"] > div';
    const out = { pageScroll: document.documentElement.scrollWidth > window.innerWidth + 1, wide: [], small: [], faint: [], spill: [], overlap: [], counts: {} };
    // Words that spill out of their own box, and a block drawn over the next one: a row squeezed below its words (the first
    // run of this script, 16 Nov, passed a Link sheet whose rows lay on top of each other).
    for (const el of Array.from(document.querySelectorAll('[data-testid="forum-link-chips"] li, [data-testid="forum-linked-topic"], [data-testid="forum-link-sheet"] > div *'))) {
        if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY === 'visible' && el.clientHeight > 0) {
            out.spill.push(`"${(el.textContent ?? '').trim().slice(0, 24)}" ${el.scrollHeight}>${el.clientHeight}`);
        }
    }
    const sheetBox = document.querySelector('[data-testid="forum-link-sheet"] > div');
    if (sheetBox) {
        const kids = Array.from(sheetBox.children);
        for (let i = 1; i < kids.length; i++) {
            const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
            if (b.top < a.bottom - 0.5) out.overlap.push(`"${(kids[i].textContent ?? '').trim().slice(0, 24)}" starts ${Math.round(a.bottom - b.top)} px inside the row above`);
        }
    }
    for (const el of Array.from(document.querySelectorAll(`${MINE.split(', ').map((s) => `${s} *`).join(', ')}`))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= window.innerWidth + 1) continue;
        if (Array.from(el.children).some((c) => c.getBoundingClientRect().right > window.innerWidth + 1)) continue;
        out.wide.push(`${el.getAttribute('data-testid') ?? el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.left)}..${Math.round(r.right)}`);
        if (out.wide.length >= 4) break;
    }
    const targets = [
        ...document.querySelectorAll('[data-testid="forum-link-chips"] > li > *'),
        ...document.querySelectorAll('[data-testid="forum-linked-topic"]'),
        ...document.querySelectorAll('[data-testid="forum-link-sheet"] button'),
    ];
    out.counts = {
        chips: document.querySelectorAll('[data-testid="forum-link-chips"] > li').length,
        linked: document.querySelectorAll('[data-testid="forum-linked-topic"]').length,
        sheet: document.querySelectorAll('[data-testid="forum-link-sheet"] button').length,
    };
    for (const el of targets) {
        const r = el.getBoundingClientRect();
        const name = (el.textContent ?? '').trim().slice(0, 30);
        if (r.height < 44 - 0.5) out.small.push(`"${name}" ${Math.round(r.height)} px`);
        // Its words against what is under them: each run of text in it, at its own colour.
        for (const t of [el, ...el.querySelectorAll('span')]) {
            if (!Array.from(t.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
            if (t.getAttribute('aria-hidden') === 'true') continue;
            const c = ratio(parse(getComputedStyle(t).color).slice(0, 3), backgroundOf(t));
            if (c < 4.5) out.faint.push(`"${(t.textContent ?? '').trim().slice(0, 24)}" ${c.toFixed(2)}:1`);
        }
    }
    return out;
}

try {
    for (const [look, lookName] of LOOKS) {
        for (const lang of LANGS) {
            for (const sheet of [false, true]) {
                const name = `${lookName} 320 ×${SIZE.scale} ${lang}${sheet ? ', Link sheet' : ''}`;
                const { context, page } = await open(look, lang, sheet);
                const problems = [];
                await page.waitForSelector('[data-testid="forum-link-chips"]', { timeout: 15000 }).catch(() => problems.push('no chips'));
                await page.waitForSelector('[data-testid="forum-linked-listing"]', { timeout: 15000 }).catch(() => problems.push('no "Talked about in the forum"'));
                if (sheet) await page.waitForSelector('[data-testid="forum-link-pick-listing"]', { timeout: 15000 }).catch(() => problems.push('no Link sheet with picks'));
                await page.waitForTimeout(150);
                const m = await page.evaluate(measure);
                await page.screenshot({ path: path.join(OUT_DIR, `forum-links-${look}-${lang}${sheet ? '-sheet' : ''}.png`), fullPage: true });
                if (m.counts.chips !== 4) problems.push(`${m.counts.chips} chips, not 4`);
                if (m.counts.linked !== 2) problems.push(`${m.counts.linked} linked topics, not 2`);
                if (m.pageScroll) problems.push('the page scrolls sideways');
                if (m.wide.length) problems.push(`runs past the page: ${m.wide.join('; ')}`);
                if (m.small.length) problems.push(`under 44 px: ${m.small.join('; ')}`);
                if (m.faint.length) problems.push(`under 4.5:1: ${m.faint.join('; ')}`);
                if (m.spill.length) problems.push(`words spill out of their box: ${m.spill.slice(0, 4).join('; ')}`);
                if (m.overlap.length) problems.push(`rows drawn over each other: ${m.overlap.slice(0, 4).join('; ')}`);
                for (const p of problems) failures.push(`${name}: ${p}`);
                rows.push(`| ${name} | ${m.counts.chips} | ${m.counts.linked} | ${sheet ? m.counts.sheet : ''} | ${problems.length ? 'FAIL' : 'ok'} |`);
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}

console.log('| look, width, language | chips | linked topics | sheet buttons | checks |\n|---|---|---|---|---|');
for (const r of rows) console.log(r);
if (failures.length) {
    console.error(`\n${failures.length} failed check(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
}
console.log('\nall checks pass');
