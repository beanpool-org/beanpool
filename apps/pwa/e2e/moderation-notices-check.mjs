/**
 * MEASURES the moderation notices the web app shows when it opens (SystemAlerts) and "Posting paused"
 * (ModerationPauseCard) in a real Chromium layout at the documented floor, a 320x568 phone with 1.3x text (and a
 * 260px stress case), light and dark: nothing may reach past the viewport sideways, the page may not scroll sideways,
 * the alert must fit the screen with its buttons in view (its words scroll inside it), and the pause card must render.
 * Nothing is marked seen as it is shown: a notice is marked when the member puts it away (Acknowledge, Close all).
 * Each title reads as the node wrote it ("🛡️ ...", no ℹ️ before it) with its icon hidden from a screen reader, and
 * focus is on Acknowledge for each notice in turn.
 * The first notice carries the longest body the node writes (a post title of 80 characters, one unbroken word).
 * Photographs each case to e2e/shots/.
 *
 * Nothing here touches a BeanPool node: /api/notices and /api/community/me are answered by the page route with
 * fixtures, and any other /api or /ws request is aborted and counted, so a stray fetch fails the run instead of escaping.
 *
 *   node e2e/moderation-notices-check.mjs     # exits non-zero on any overflow
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory.
 */
/* global process, console, document, getComputedStyle, window */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = path.join(PWA_DIR, 'e2e', 'shots');

const CASES = [
    { name: 'phone-320x568-130pc', width: 320, height: 568, fontScale: 1.3 },
    { name: 'STRESS-narrow-260x520-130pc', width: 260, height: 520, fontScale: 1.3 },
];

const LONG_TITLE = `${'Wonderfullyhandmadesourdoughstarterkitswithjarsandinstructions'.repeat(2).slice(0, 79)}…`;
const NOTICES = [
    {
        id: 'n-hidden', title: '🛡️ Your post is hidden for review', severity: 'info', data: { kind: 'post_hidden', postId: 'p1' },
        body: `Your post "${LONG_TITLE}" is hidden while the community's moderators look at reports about it. It has not been removed, and you can still see it.`,
        createdAt: '2026-09-26T01:00:00.000Z', seenAt: null,
    },
    {
        id: 'n-muted', title: '🛡️ Posting paused', severity: 'info', data: { kind: 'moderation_muted' },
        body: "Three of your posts were removed by the community's moderators in the last 30 days, so you can't post or send messages here until a moderator lifts this. You can still read, edit your profile and leave.",
        createdAt: '2026-09-26T02:00:00.000Z', seenAt: null,
    },
    {
        id: 'n-outcome', title: '🛡️ Your report', severity: 'info', data: { kind: 'report_outcome', outcome: 'removed' },
        body: 'The post you reported was removed. Thank you for letting the moderators know.',
        createdAt: '2026-09-26T03:00:00.000Z', seenAt: null,
    },
];
const STANDING = {
    publicKey: 'harness-member',
    probation: { onProbation: false, exemptBecause: 'off', ageEndsAt: null, keptPosts: 3, keptPostsNeeded: 3,
        limits: { posts: { limit: 3, used: 0, resetsAt: null }, photos: { limit: 5, used: 0, resetsAt: null }, new_dm_recipients: { limit: 10, used: 0, resetsAt: null } } },
    // A pause with an end: the longer of the card's two wordings.
    mute: { muted: true, until: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString() },
};

/** Runs in the page: anything reaching past the viewport sideways, whether the page scrolls sideways, and the alert's buttons. */
const MEASURE = () => {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const out = [];
    for (const el of document.querySelectorAll('#root *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + 0.5 || r.left < -0.5) out.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent || '').slice(0, 40)}" spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`${el.tagName.toLowerCase()} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    }
    const dialog = document.querySelector('[role="alertdialog"]');
    const d = dialog?.getBoundingClientRect();
    const buttons = dialog ? [...dialog.querySelectorAll('button')].map(b => b.textContent) : [];
    const inView = (el) => { const r = el?.getBoundingClientRect(); return !!r && r.top >= -0.5 && r.bottom <= vh + 0.5 && r.left >= -0.5 && r.right <= vw + 0.5; };
    const buttonsInView = !!dialog && [...dialog.querySelectorAll('button')].every(inView);
    const words = dialog?.querySelector('[data-testid="system-alert-text"]');
    return {
        overflow: out,
        pageScrollsSideways: document.documentElement.scrollWidth > vw,
        dialog: !!dialog,
        dialogFits: !!d && d.top >= -0.5 && d.bottom <= vh + 0.5,
        wordsScroll: !!words && (words.scrollHeight <= words.clientHeight + 1 || getComputedStyle(words).overflowY === 'auto'),
        buttonsInView,
        buttons,
        count: document.querySelector('[data-testid="system-alert-count"]')?.textContent ?? null,
        title: document.getElementById('system-alert-title')?.textContent ?? null,
        titleIconHidden: document.querySelector('#system-alert-title > [aria-hidden="true"]')?.textContent ?? null,
        focused: document.activeElement?.tagName === 'BUTTON' ? document.activeElement.textContent : null,
        pauseCards: document.querySelectorAll('[data-testid="moderation-pause-card"]').length,
    };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 } });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
let blocked = 0;

try {
    for (const theme of ['light', 'dark']) {
        for (const c of CASES) {
            const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, colorScheme: theme });
            const marked = [];
            await context.route('**/*', (route) => {
                const req = route.request();
                const url = req.url();
                if (url.includes('/api/notices/seen')) {
                    marked.push(...(JSON.parse(req.postData() || '{}').ids ?? []));
                    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, marked: 1 }) });
                }
                if (url.includes('/api/notices')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notices: NOTICES }) });
                if (url.includes('/api/community/me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STANDING) });
                if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            await page.goto(`${base}/e2e/moderation-notices-harness.html`, { waitUntil: 'networkidle' });
            await page.evaluate(([t, scale]) => {
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.classList.toggle('dark-theme', t === 'dark');
                document.documentElement.style.fontSize = `${scale * 100}%`;
            }, [theme, c.fontScale]);
            await page.waitForSelector('[role="alertdialog"]');
            await page.waitForSelector('[data-testid="moderation-pause-card"]');
            await page.evaluate(() => document.fonts.ready);

            // The first notice, with the longest body; then the second; then the pause card with the alerts closed.
            // What is marked seen by then: nothing while a notice only shows, then each as the member puts it away.
            const steps = [
                ['first', null, []],
                ['second', 'Acknowledge', ['n-hidden']],
                ['closed', /^Close all/, ['n-hidden', 'n-muted', 'n-outcome']],
            ];
            for (const [step, click, expectMarked] of steps) {
                if (click) await page.getByRole('button', { name: click }).click();
                await page.waitForTimeout(100);
                for (let i = 0; i < 20 && marked.length < expectMarked.length; i++) await page.waitForTimeout(100);
                const shot = `moderation-notices-${c.name}-${theme}-${step}.png`;
                await page.screenshot({ path: path.join(OUT_DIR, shot) });
                const m = await page.evaluate(MEASURE);
                if (m.pauseCards !== 1) failures.push(`${shot}: ${m.pauseCards} pause cards rendered, expected 1`);
                if (m.pageScrollsSideways) failures.push(`${shot}: the page scrolls sideways`);
                for (const o of m.overflow) failures.push(`${shot}: ${o}`);
                if (step === 'closed') {
                    if (m.dialog) failures.push(`${shot}: the alert is still up after Close all`);
                } else {
                    if (!m.dialog) failures.push(`${shot}: no alert`);
                    if (!m.dialogFits) failures.push(`${shot}: the alert reaches past the top or bottom of the screen`);
                    if (!m.wordsScroll) failures.push(`${shot}: the alert's words are taller than they show and do not scroll`);
                    if (!m.buttonsInView) failures.push(`${shot}: a button of the alert is off the screen`);
                    if (!m.buttons.includes('Acknowledge')) failures.push(`${shot}: no Acknowledge button`);
                    const expected = step === 'first' ? '1 of 3' : '1 of 2';
                    if (m.count !== expected) failures.push(`${shot}: count reads ${m.count}, expected ${expected}`);
                    const title = step === 'first' ? NOTICES[0].title : NOTICES[1].title;
                    if (m.title !== title) failures.push(`${shot}: title reads ${JSON.stringify(m.title)}, expected ${JSON.stringify(title)}`);
                    if (m.titleIconHidden !== '🛡️ ') failures.push(`${shot}: the title's icon is not hidden from a screen reader (${JSON.stringify(m.titleIconHidden)})`);
                    if (m.focused !== 'Acknowledge') failures.push(`${shot}: focus is on ${JSON.stringify(m.focused)}, expected Acknowledge`);
                }
                if (JSON.stringify(marked) !== JSON.stringify(expectMarked))
                    failures.push(`${shot}: marked seen ${JSON.stringify(marked)}, expected ${JSON.stringify(expectMarked)}`);
                if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
                console.log(`${shot}: alert ${m.dialog}${m.dialog ? ` (fits ${m.dialogFits}, buttons in view ${m.buttonsInView}, ${m.count}, "${m.title}", focus ${m.focused})` : ''}, ${m.pauseCards} pause card, ${m.overflow.length} overflowing, sideways ${m.pageScrollsSideways}, marked ${JSON.stringify(marked)}`);
            }
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}

if (blocked) console.log(`(${blocked} other /api or /ws requests aborted at the browser)`);
if (failures.length) {
    console.error(`\n✗ ${failures.length} problem(s):\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('\n✓ nothing reaches past the viewport, nothing scrolls sideways, each alert fits, and each notice is marked seen once, when put away');
