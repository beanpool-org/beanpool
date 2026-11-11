/**
 * The web's private contacts screens (DESIGN-private-contacts-fable.md slice C4) in a real Chromium layout: the Chat list
 * with its Contacts button, the Contacts page, Import, Choose who to bring (after a real file is picked) and the ⓘ, at
 * 320 × 568 with 1.3x text and at 1280 × 800, light and dark. It photographs each (at most 900 px wide) and checks that
 * nothing runs off sideways and that every button is a 44 px target (the Chat header's 36 px, as New DM's, excepted). It
 * prints a table (markdown) and exits non-zero on any failed check.
 *
 * Nothing here touches a BeanPool node: every /api request is answered here, and any other /api or /ws request is aborted.
 *
 *   node e2e/contacts-shots.mjs [shots-dir]
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 */
/* global process, console, document */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PWA_DIR, 'e2e', 'shots');
const VIEWPORTS = [{ w: 320, h: 568, scale: 1.3 }, { w: 1280, h: 800, scale: 1 }];
const FILE = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Sam Jones\r\nTEL:+61 400 111 222\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Dee Walker\r\nTEL:0412 345 678\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Old Work\r\nEND:VCARD\r\n';

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
function answer(url, method) {
    const u = new URL(url);
    if (u.pathname === '/api/contacts/copy') return method === 'GET' ? json(404, { code: 'no_copy' }) : json(200, { seq: 1 });
    if (u.pathname === '/api/community/info') return json(200, { features: { beans: true, contacts: true } });
    if (u.pathname.startsWith('/api/messages/conversations/')) return json(200, { conversations: [], totalUnread: 0 });
    if (u.pathname === '/api/community/members') return json(200, []);
    if (u.pathname === '/api/marketplace/transactions') return json(200, []);
    return null;
}

const MEASURE = () => {
    const small = [...document.querySelectorAll('button, a, summary, input:not([type=checkbox])')]
        // The Chat list's filter chips were there before (40 px on a desktop): this run measures the contacts screens' own.
        .filter((el) => el.getClientRects().length > 0 && !el.closest('[data-testid=conversation-filter-chips]'))
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .filter(({ el, box }) => box.height < 44 && el.tagName !== 'SUMMARY' && !(el.getAttribute('style') ?? '').includes('min-height: 36px'))
        .map(({ el, box }) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(box.height)}px`);
    return { sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth, small };
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
const rows = [];
try {
    for (const theme of ['light', 'dark']) {
        for (const vp of VIEWPORTS) {
            for (const view of ['chat', 'list', 'import', 'review', 'info']) {
                const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: theme });
                await context.route('**/*', (route) => {
                    const req = route.request();
                    if (req.url().includes('/api/')) {
                        const a = answer(req.url(), req.method());
                        return a ? route.fulfill(a) : route.abort();
                    }
                    if (req.url().startsWith('ws')) return route.abort();
                    return route.continue();
                });
                const page = await context.newPage();
                await page.addInitScript(([th, scale]) => {
                    try { localStorage.setItem('beanpool-theme-mode', th); } catch { /* private mode */ }
                    document.addEventListener('DOMContentLoaded', () => {
                        document.documentElement.classList.toggle('dark', th === 'dark');
                        document.documentElement.classList.toggle('dark-theme', th === 'dark');
                        document.documentElement.style.fontSize = `${scale * 100}%`;
                    });
                }, [theme, vp.scale]);
                await page.goto(`${base}/e2e/contacts-harness.html?view=${view === 'review' ? 'import' : view}`, { waitUntil: 'load' });
                const ready = { chat: '[data-testid=contacts-button]', list: 'text=Not on BeanPool yet', import: 'text=Android phone', review: 'text=Android phone', info: '[data-testid=contacts-info]' }[view];
                await page.waitForSelector(ready, { timeout: 30_000 });
                if (view === 'review') {
                    await page.setInputFiles('[data-testid=contacts-file]', { name: 'contacts.vcf', mimeType: 'text/vcard', buffer: Buffer.from(FILE) });
                    await page.waitForSelector('[data-testid=contacts-review]', { timeout: 30_000 });
                }
                await page.waitForTimeout(300);
                const m = await page.evaluate(MEASURE);
                const name = `contacts-${view}-${vp.w}-${theme}`;
                const width = Math.min(vp.w, 900);
                await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), clip: { x: 0, y: 0, width, height: vp.h } });
                if (m.sideways) failures.push(`${name}: runs off sideways`);
                if (m.small.length) failures.push(`${name}: under 44 px: ${m.small.join('; ')}`);
                rows.push(`| ${view} | ${vp.w} × ${vp.scale} | ${theme} | ${m.sideways ? '✗' : '✓'} | ${m.small.length ? m.small.join('; ') : '✓'} | ${name}.png |`);
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log('| screen | viewport | theme | no sideways scroll | 44 px targets | shot |\n|---|---|---|---|---|---|');
console.log(rows.join('\n'));
if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
}
