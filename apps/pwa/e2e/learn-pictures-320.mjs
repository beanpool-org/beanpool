/* eslint-disable no-undef */
/**
 * Learn's pictures in To check on the web (Damo's ask; Marty, 16 Nov 2026: "Yes, through the upload link only, the checker approves
 * it"), on the REAL page, at the floor (320 px wide, text at 130%), in Light, Classic and Dark:
 * node apps/pwa/e2e/learn-pictures-320.mjs [--shots <dir>]
 *   an assistant's draft with two pictures, each with Remove photo; the same with the first removed (dimmed, "Left out", Keep this
 *   photo); Edit first opening on the one kept.
 *   Slice 2 of DESIGN-learn-web-pictures-fable.md (§6.2): the second picture is from Wikimedia Commons, with its credit (a long
 *   maker's name, to wrap), the day read, Commons' note and Open its page; the first, uploaded, says whose it must be.
 *
 * The real LearnPage with the real stylesheet (e2e/learn-harness.tsx); every /api call is answered here and nothing leaves the
 * machine. Checks, read from the live layout: no sideways scroll; every button at least 44 px tall and inside the screen;
 * nothing is written by just looking or by Keep and Remove. Built on learn-tags-320.mjs.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { TEXT_SCALE_CSS } from './harness.mjs';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const WIDTH = 320;
const HEIGHT = 720;
const SCALE = 1.3;
const LIMIT_S = Number(process.env.LEARN_LIMIT_S || 300);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

const DAY = 86_400_000;
const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
/** A picture as a data URL, as To check receives a draft's: a plain colour with a shape, 4:3 or 3:4. */
const picture = (w, h, fill, mark) => `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${fill}"/>`
    + `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="${mark}"/></svg>`).toString('base64')}`;
const PHOTOS = [picture(640, 480, '#4a7c59', '#f2e8cf'), picture(480, 640, '#386fa4', '#f6bd60')];
const TO_CHECK = {
    drafts: [{ id: 'a1', kind: 'new', title: 'Where the community garden is', topic: 'local-services', from: { pubkey: 'member-damo', name: 'Damo' }, assistant: 'Claude', createdAt: at(1) }],
    total: 1, limit: 50, offset: 0, unchecked: { total: 0, rows: [] },
};
const DRAFT = {
    ...TO_CHECK.drafts[0], body: 'The garden is behind the hall on Station Street. Plots are free; ask at the shed on Saturday mornings.',
    place: 'Behind the hall on Station Street', sources: [{ url: 'https://www.council.example/gardens', label: 'Council gardens page' }], lang: 'en', about: 'place',
    note: null, photos: PHOTOS, needsSourcesTicked: true, post: null, changed: null, pageChanged: null, freeTags: [],
    photoCredits: [null, {
        url: 'https://commons.wikimedia.org/wiki/File:Community_garden_behind_the_hall_in_late_spring_with_raised_beds.jpg',
        file: 'File:Community garden behind the hall in late spring with raised beds.jpg',
        maker: 'Bartholomew Featherstonehaugh-Ramaswamy and the Station Street Photography Collective', licence: 'CC BY-SA 4.0',
        licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', restrictions: ['personality'], readAt: at(1),
    }],
};
const LIVE = { features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, knowledge: true } };

function answer(method, pathname, search) {
    if (pathname === '/api/node-admin/me') return { role: 'admin' };
    if (pathname === '/api/knowledge/front') return { total: 0, pinned: [], topics: [] };
    if (pathname === '/api/knowledge/drafts/mine') return { waiting: [], answered: [] };
    if (pathname === '/api/knowledge/drafts') return TO_CHECK;
    if (pathname === '/api/knowledge/drafts/a1') return { draft: DRAFT };
    return mockResponse(pathname, search, undefined, { communityInfo: LIVE });
}

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/learn-harness.html`;
const browser = await chromium.launch();
const problems = [];

const OPEN = ['[data-testid="learn-check-row"]', '[data-testid="learn-check-photos"]'];
const STATES = [
    { name: 'check-pictures', then: [OPEN], full: true },
    { name: 'check-pictures-one-removed', then: [OPEN, ['[data-testid="learn-check-photo-toggle"]', '[data-testid="learn-check-photo"][data-kept="false"]']], full: true },
    { name: 'edit-first-kept', then: [OPEN, ['[data-testid="learn-check-photo-toggle"]', '[data-kept="false"]'], ['[data-testid="learn-check-tick"]', '[data-testid="learn-check-tick"]:checked'],
        ['[data-testid="learn-check-edit"]', '[data-testid="learn-form"]']], full: true, keptInForm: 1,
        // The photo picker's own ✕ (components/PostPhotoPicker.tsx, the Market's form too) is 31 px tall: older than this change and
        // not touched by it, named in its PR. Every other button here is held to 44 px.
        known: ['"✕" is 31.2 px tall, under 44'] },
];

try {
    for (const [scheme, stored] of [['light', 'light'], ['classic', 'dark'], ['dark', 'night']]) {
        for (const st of STATES) {
            const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: scheme === 'light' ? 'light' : 'dark', reducedMotion: 'reduce' });
            await context.addInitScript(([mode]) => { try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* still a theme */ } }, [stored]);
            const asked = [];
            await context.route('**/api/**', async (route) => {
                const url = new URL(route.request().url());
                const method = route.request().method();
                asked.push(`${method} ${url.pathname}${url.search}`);
                const body = answer(method, url.pathname, url.search);
                if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
            });
            await context.route('**/socket.io/**', (route) => route.abort());
            await context.route('**/ws**', (route) => route.abort());
            const tab = await context.newPage();
            tab.setDefaultTimeout(30_000);
            const errors = [];
            tab.on('pageerror', (e) => errors.push(String(e)));
            await tab.goto(`${base}#check`, { waitUntil: 'load' });
            await tab.addStyleTag({ content: TEXT_SCALE_CSS(SCALE) });
            await tab.waitForSelector('[data-testid="learn-check-list"]', { timeout: 60_000 });
            for (const [tap, shows] of st.then ?? []) { await tab.click(tap); await tab.waitForSelector(shows); }
            await tab.evaluate(() => document.fonts?.ready).catch(() => {});
            await tab.waitForTimeout(300);

            const found = await tab.evaluate(([width]) => {
                const out = [];
                if (document.documentElement.scrollWidth > width) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${width}px)`);
                const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
                for (const el of document.querySelectorAll('button, a[href], input')) {
                    if (!visible(el)) continue;
                    const r = el.getBoundingClientRect();
                    const name = (el.getAttribute('data-testid') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 40);
                    if (el.getAttribute('type') !== 'checkbox' && r.height < 43.5) out.push(`"${name}" is ${r.height.toFixed(1)} px tall, under 44`);
                    if (r.right > width + 0.5) out.push(`"${name}" runs past the ${width}px edge (right ${r.right.toFixed(1)})`);
                    if (el.tagName !== 'INPUT' && el.scrollWidth > el.clientWidth + 1) out.push(`"${name}" is cut (${el.scrollWidth}px of ${el.clientWidth}px)`);
                }
                return out;
            }, [WIDTH]);
            if (st.name === 'check-pictures') {
                const lines = await tab.evaluate(() => ({
                    credit: document.querySelectorAll('[data-testid="learn-check-credit"]').length,
                    note: document.querySelectorAll('[data-testid="learn-check-credit-note"]').length,
                    page: document.querySelectorAll('[data-testid="learn-check-credit-page"]').length,
                    uploaded: document.querySelectorAll('[data-testid="learn-check-uploaded"]').length,
                }));
                if (lines.credit !== 1 || lines.note !== 1 || lines.page !== 1 || lines.uploaded !== 1) found.push(`the picture lines are not one each: ${JSON.stringify(lines)}`);
            }
            if (st.keptInForm !== undefined) {
                const inForm = await tab.locator('[data-testid="learn-form"] img[alt^="photo"]').count();
                if (inForm !== st.keptInForm) found.push(`Edit first holds ${inForm} picture(s), not the ${st.keptInForm} kept`);
            }
            const real = found.filter((p) => !(st.known ?? []).includes(p));
            problems.push(...real.map((p) => `${scheme} ${st.name}: ${p}`));
            if (errors.length) problems.push(`${scheme} ${st.name}: page errors: ${errors.join(' | ')}`);
            const writes = asked.filter((a) => !a.startsWith('GET '));
            if (writes.length) problems.push(`${scheme} ${st.name}: a write by looking: ${writes.join(', ')}`);
            console.log(`${scheme} ${st.name}: ${real.length === 0 ? 'ok' : `${real.length} problem(s)`}`);

            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await tab.screenshot({ path: path.join(SHOTS, `web-learn-pictures-320-${scheme}-${st.name}.png`), fullPage: !!st.full });
            }
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}

if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log('web learn-pictures-320: passed');
process.exit(0);
