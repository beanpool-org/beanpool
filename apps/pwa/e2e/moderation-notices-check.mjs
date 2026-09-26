/**
 * MEASURES the moderation notices the web app shows when it opens (SystemAlerts) and "Posting paused"
 * (ModerationPauseCard) in a real Chromium layout at the documented floor, a 320x568 phone with 1.3x text (and a
 * 260px stress case), light and dark: nothing may reach past the viewport sideways, the page may not scroll sideways,
 * the alert must fit the screen with its buttons in view (its words scroll inside it), and the pause card must render.
 * Nothing is marked seen as it is shown: a notice is marked when the member puts it away (Acknowledge, Close all).
 * Each title reads as the node wrote it ("🛡️ ...", no ℹ️ before it) with its icon hidden from a screen reader, and
 * focus is on the alert itself (not Acknowledge) for each notice in turn. And a member typing in a text box when the
 * notices arrive puts none away with a Space, an Enter or the rest of their sentence; Acknowledge is one Tab away.
 * The first notice carries the longest body the node writes (a post title of 80 characters, one unbroken word).
 *
 * Put away on purpose (the press guard): a press in an alert's first second, or within a second of a typed letter, does
 * nothing, so a Tab that lands on Acknowledge while typing "Fresh eggs" puts nothing away, and a double tap puts away
 * one alert, not the next one too. Modal: Tab and Shift+Tab go round the alert's buttons, and when the last one is put
 * away focus is back in the text box. Contrast, for each severity in light and dark: the heading, Acknowledge's words
 * on its colour, Close all's words and the "1 of" count at 4.5:1 or more on the dialog, and Close all's border 3:1.
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

/** An alert's buttons ignore a press for a second after it appears or a letter is typed (SystemAlerts PRESS_GUARD_MS). */
const GUARD_MS = 1000;
const afterTheGuard = (page) => page.waitForTimeout(GUARD_MS + 150);

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

/** Runs in the page: what has focus, as the check names it. */
const FOCUSED = () => {
    const a = document.activeElement;
    if (!a || a === document.body) return null;
    if (a.getAttribute('role') === 'alertdialog') return 'the alert';
    return a.tagName === 'BUTTON' ? a.textContent : a.tagName.toLowerCase();
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
    // Contrast (WCAG): the dialog's own background, and each button's words on what is behind them.
    const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
        const [x, y] = [lum(rgb(a)), lum(rgb(b))];
        return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
    };
    const ack = dialog ? [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Acknowledge') : null;
    const closeAll = dialog ? [...dialog.querySelectorAll('button')].find((b) => /^Close all/.test(b.textContent)) : null;
    const countEl = document.querySelector('[data-testid="system-alert-count"]');
    const ground = dialog ? getComputedStyle(dialog).backgroundColor : null;
    const contrast = !dialog ? null : {
        heading: ratio(getComputedStyle(document.getElementById('system-alert-title')).color, ground),
        acknowledge: ack ? ratio(getComputedStyle(ack).color, getComputedStyle(ack).backgroundColor) : null,
        closeAll: closeAll ? ratio(getComputedStyle(closeAll).color, ground) : null,
        closeAllBorder: closeAll ? ratio(getComputedStyle(closeAll).borderTopColor, ground) : null,
        count: countEl ? ratio(getComputedStyle(countEl).color, ground) : null,
    };
    return {
        contrast,
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
        pauseCards: document.querySelectorAll('[data-testid="moderation-pause-card"]').length,
    };
};

/** Failures for contrast under WCAG AA: 4.5:1 for words, 3:1 for Close all's border. */
const contrastFailures = (shot, c) => {
    const out = [];
    if (!c) return out;
    for (const k of ['heading', 'acknowledge', 'closeAll', 'count']) {
        if (c[k] !== null && c[k] < 4.5) out.push(`${shot}: ${k} is ${c[k]}:1 on its background, under 4.5:1`);
    }
    if (c.closeAllBorder !== null && c.closeAllBorder < 3) out.push(`${shot}: Close all's border is ${c.closeAllBorder}:1 on the dialog, under 3:1`);
    return out;
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
                if (click) {
                    // Read first: a press in the alert's first second does nothing.
                    await afterTheGuard(page);
                    await page.getByRole('button', { name: click }).click();
                }
                await page.waitForTimeout(100);
                for (let i = 0; i < 20 && marked.length < expectMarked.length; i++) await page.waitForTimeout(100);
                const shot = `moderation-notices-${c.name}-${theme}-${step}.png`;
                await page.screenshot({ path: path.join(OUT_DIR, shot) });
                const m = { ...(await page.evaluate(MEASURE)), focused: await page.evaluate(FOCUSED) };
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
                    if (m.focused !== 'the alert') failures.push(`${shot}: focus is on ${JSON.stringify(m.focused)}, expected the alert`);
                }
                if (JSON.stringify(marked) !== JSON.stringify(expectMarked))
                    failures.push(`${shot}: marked seen ${JSON.stringify(marked)}, expected ${JSON.stringify(expectMarked)}`);
                failures.push(...contrastFailures(shot, m.contrast));
                if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
                console.log(`${shot}: alert ${m.dialog}${m.dialog ? ` (fits ${m.dialogFits}, buttons in view ${m.buttonsInView}, ${m.count}, "${m.title}", focus ${m.focused}, contrast ${JSON.stringify(m.contrast)})` : ''}, ${m.pauseCards} pause card, ${m.overflow.length} overflowing, sideways ${m.pageScrollsSideways}, marked ${JSON.stringify(marked)}`);
            }
            await context.close();
        }
    }

    // Each severity's colours, light and dark, at the documented floor: the heading, Acknowledge's words on its colour,
    // Close all's words and border, and the count, measured on the dialog as drawn.
    for (const theme of ['light', 'dark']) {
        for (const severity of ['info', 'warning', 'critical']) {
            const context = await browser.newContext({ viewport: { width: 320, height: 568 }, colorScheme: theme });
            const notices = NOTICES.map((n) => ({ ...n, severity }));
            await context.route('**/*', (route) => {
                const url = route.request().url();
                if (url.includes('/api/notices/seen')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, marked: 1 }) });
                if (url.includes('/api/notices')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notices }) });
                if (url.includes('/api/community/me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STANDING) });
                if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            await page.goto(`${base}/e2e/moderation-notices-harness.html`, { waitUntil: 'networkidle' });
            await page.evaluate((t) => {
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.classList.toggle('dark-theme', t === 'dark');
                document.documentElement.style.fontSize = '130%';
            }, theme);
            await page.waitForSelector('[role="alertdialog"]');
            await page.evaluate(() => document.fonts.ready);
            const shot = `moderation-notices-severity-${severity}-${theme}.png`;
            await page.screenshot({ path: path.join(OUT_DIR, shot) });
            const m = await page.evaluate(MEASURE);
            if (!m.contrast) failures.push(`${shot}: no alert`);
            failures.push(...contrastFailures(shot, m.contrast));
            if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
            console.log(`${shot}: contrast ${JSON.stringify(m.contrast)}`);
            await context.close();
        }
    }

    // A double tap: the first tap puts the first alert away, and the second lands on the next alert's Acknowledge in its
    // first second, and puts nothing away. Close all, pressed at once, waits its second too.
    {
        const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
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
        await page.waitForSelector('[role="alertdialog"]');
        const tapTap = 'moderation-notices-double-tap';
        const shown = () => page.evaluate(() => ({
            title: document.getElementById('system-alert-title')?.textContent ?? null,
            count: document.querySelector('[data-testid="system-alert-count"]')?.textContent ?? null,
        }));

        await page.getByRole('button', { name: 'Acknowledge' }).click();
        await page.waitForTimeout(300);
        const early = await shown();
        console.log(`${tapTap} a tap in the first second: alert "${early.title}" (${early.count}), marked ${JSON.stringify(marked)}`);
        if (marked.length || early.title !== NOTICES[0].title) failures.push(`${tapTap}: a tap in the first second put "${NOTICES[0].title}" away (marked ${JSON.stringify(marked)}, showing "${early.title}")`);

        await afterTheGuard(page);
        await page.getByRole('button', { name: 'Acknowledge' }).click();
        await page.getByRole('button', { name: 'Acknowledge' }).click();
        await page.getByRole('button', { name: /^Close all/ }).click();
        await page.waitForTimeout(300);
        const after = await shown();
        console.log(`${tapTap} a double tap, then Close all at once: alert "${after.title}" (${after.count}), marked ${JSON.stringify(marked)}`);
        if (JSON.stringify(marked) !== JSON.stringify(['n-hidden'])) failures.push(`${tapTap}: marked ${JSON.stringify(marked)}, expected only ["n-hidden"]`);
        if (after.title !== NOTICES[1].title || after.count !== '1 of 2') failures.push(`${tapTap}: shows "${after.title}" (${after.count}), expected "${NOTICES[1].title}" (1 of 2)`);

        await afterTheGuard(page);
        await page.getByRole('button', { name: /^Close all/ }).click();
        for (let i = 0; i < 20 && marked.length < 3; i++) await page.waitForTimeout(100);
        const closed = await shown();
        console.log(`${tapTap} Close all a second later: alert "${closed.title}", marked ${JSON.stringify(marked)}`);
        if (closed.title !== null || JSON.stringify(marked) !== JSON.stringify(['n-hidden', 'n-muted', 'n-outcome'])) failures.push(`${tapTap}: after Close all, shows "${closed.title}" and marked ${JSON.stringify(marked)}`);
        if (pageErrors.length) failures.push(`${tapTap}: page errors ${JSON.stringify(pageErrors)}`);
        await context.close();
    }

    // A member typing in a text box when the notices arrive (the open's read answers late): they keep typing, and a
    // Space, an Enter (which sends in the event chat) or the rest of the sentence puts nothing away.
    {
        const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
        const marked = [];
        let release;
        const released = new Promise((r) => { release = r; });
        await context.route('**/*', async (route) => {
            const req = route.request();
            const url = req.url();
            if (url.includes('/api/notices/seen')) {
                marked.push(...(JSON.parse(req.postData() || '{}').ids ?? []));
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, marked: 1 }) });
            }
            if (url.includes('/api/notices')) {
                await released;
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notices: NOTICES }) });
            }
            if (url.includes('/api/community/me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STANDING) });
            if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
            return route.continue();
        });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        await page.goto(`${base}/e2e/moderation-notices-harness.html`, { waitUntil: 'load' });
        await page.waitForSelector('[data-testid="moderation-pause-card"]');
        // Outside the React root, so the harness renders as it always does.
        await page.evaluate(() => {
            const box = document.createElement('textarea');
            box.setAttribute('aria-label', 'Message');
            document.body.appendChild(box);
        });
        const box = page.getByRole('textbox', { name: 'Message' });
        await box.click();
        await page.keyboard.type('hello', { delay: 50 });
        release();
        await page.waitForSelector('[role="alertdialog"]');
        const typing = 'moderation-notices-typing';
        const at = async (step) => {
            await page.waitForTimeout(300);
            const m = await page.evaluate(() => ({
                title: document.getElementById('system-alert-title')?.textContent ?? null,
                count: document.querySelector('[data-testid="system-alert-count"]')?.textContent ?? null,
            }));
            const focused = await page.evaluate(FOCUSED);
            console.log(`${typing} ${step}: alert "${m.title}" (${m.count}), focus ${focused}, marked ${JSON.stringify(marked)}`);
            return { ...m, focused };
        };

        const first = await at('arrived');
        if (first.focused !== 'the alert') failures.push(`${typing}: focus is on ${JSON.stringify(first.focused)} when the alert arrives, expected the alert`);
        await page.keyboard.press('Space');
        await page.keyboard.press('Enter');
        await page.keyboard.type(' see you soon', { delay: 120 });
        const typed = await at('typed on');
        if (marked.length) failures.push(`${typing}: typing on marked ${JSON.stringify(marked)} seen, expected nothing`);
        if (typed.title !== NOTICES[0].title || typed.count !== '1 of 3') failures.push(`${typing}: after typing on the alert shows "${typed.title}" (${typed.count}), expected "${NOTICES[0].title}" (1 of 3)`);

        await page.keyboard.press('Tab');
        const tabbed = await at('Tab');
        if (tabbed.focused !== 'Acknowledge') failures.push(`${typing}: one Tab reaches ${JSON.stringify(tabbed.focused)}, expected Acknowledge`);

        // The member meant that Tab for their next box, and types on: "Fresh eggs", Space and all, on Acknowledge.
        await page.keyboard.type('Fresh eggs', { delay: 50 });
        const eggs = await at('Fresh eggs on Acknowledge');
        if (marked.length) failures.push(`${typing}: "Fresh eggs" on Acknowledge marked ${JSON.stringify(marked)} seen, expected nothing`);
        if (eggs.title !== NOTICES[0].title || eggs.count !== '1 of 3') failures.push(`${typing}: after "Fresh eggs" the alert shows "${eggs.title}" (${eggs.count}), expected "${NOTICES[0].title}" (1 of 3)`);

        // Tab and Shift+Tab go round the alert's two buttons, never out to the text box behind it.
        const round = [];
        for (const shift of [false, false, true, true]) {
            await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
            round.push(await page.evaluate(FOCUSED));
        }
        console.log(`${typing} Tab, Tab, Shift+Tab, Shift+Tab: focus ${JSON.stringify(round)}`);
        if (JSON.stringify(round) !== JSON.stringify(['Close all 3', 'Acknowledge', 'Close all 3', 'Acknowledge']))
            failures.push(`${typing}: Tab and Shift+Tab went ${JSON.stringify(round)}, expected round the alert's buttons`);

        // A second after the last letter, on purpose: Enter on Acknowledge puts the first away, once.
        await afterTheGuard(page);
        await page.keyboard.press('Enter');
        const next = await at('Enter on Acknowledge');
        if (JSON.stringify(marked) !== JSON.stringify(['n-hidden'])) failures.push(`${typing}: Enter on Acknowledge marked ${JSON.stringify(marked)}, expected ["n-hidden"]`);
        if (next.title !== NOTICES[1].title || next.focused !== 'the alert') failures.push(`${typing}: after Acknowledge the alert shows "${next.title}" with focus on ${JSON.stringify(next.focused)}, expected "${NOTICES[1].title}" with focus on the alert`);

        // Close all puts the rest away, and focus is back in the text box, where the member was.
        await afterTheGuard(page);
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Enter');
        const back = await at('Close all');
        if (JSON.stringify(marked) !== JSON.stringify(['n-hidden', 'n-muted', 'n-outcome'])) failures.push(`${typing}: Close all marked ${JSON.stringify(marked)}, expected all three`);
        if (back.title !== null) failures.push(`${typing}: the alert "${back.title}" is still up after Close all`);
        if (back.focused !== 'textarea') failures.push(`${typing}: after the last alert focus is on ${JSON.stringify(back.focused)}, expected the text box`);
        await page.keyboard.type(' again', { delay: 20 });
        const typedBack = await page.evaluate(() => document.querySelector('textarea')?.value ?? null);
        console.log(`${typing} typed on: the text box reads ${JSON.stringify(typedBack)}`);
        if (typedBack !== 'hello again') failures.push(`${typing}: the text box reads ${JSON.stringify(typedBack)}, expected "hello again"`);
        await page.screenshot({ path: path.join(OUT_DIR, `${typing}-closed.png`) });
        if (pageErrors.length) failures.push(`${typing}: page errors ${JSON.stringify(pageErrors)}`);
        await context.close();
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
console.log('\n✓ nothing reaches past the viewport, nothing scrolls sideways, each alert fits and passes AA contrast in every severity and theme, each notice is marked seen once, when put away on purpose, never by typing on or a double tap, Tab stays in the alert, and focus goes back');
