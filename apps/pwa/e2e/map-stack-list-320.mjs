/**
 * The web map's list of a bubble (components/MapStackList.tsx; Marty, 2 Nov) at the documented floor, 320 px with text at
 * 130% in the browser, light and dark, in the app's own Tailwind over a stand-in for the map. Reports anything past the
 * screen's edge, a button under 44 px, or words cut by their own box.
 *
 * Nothing leaves the machine: the page aborts every request but its own. Needs @beanpool/core built, and Chromium for
 * Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 *
 *   node apps/pwa/e2e/map-stack-list-320.mjs [shots-dir]
 */
/* global process, console, document, getComputedStyle */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const PWA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(PWA, '../..');
const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;
const WIDTH = 320;
const HEIGHT = 568;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'map-stack-web-320-'));

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MapStackList } from ${JSON.stringify(path.join(PWA, 'src/components/MapStackList'))};
const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#7fb069"/><circle cx="40" cy="40" r="20" fill="#f4d35e"/></svg>');
const pin = (key, title, type, extra = {}) => ({ key, title, type, when: null, photo: null, emoji: '🥕', eventStartMs: null, createdMs: 0, open() {}, ...extra });
const pins = [
    pin('a', 'Bangalow Hall working bee and a shared lunch for everyone in the valley who wants to help out', 'Event', { when: 'SAT 7 NOV · 9:00–12:00', photo }),
    pin('b', 'Repair café', 'Event', { when: 'SUN 8 NOV · 10:00–12:00 · Lagos time · 7:00 your time', emoji: '📌' }),
    pin('c', 'A dozen duck eggs, collected this morning, from a very small flock', 'Offer', { photo }),
    pin('d', 'A ladder', 'Need', { emoji: '🔧' }),
    pin('e', 'The Bangalow Food Co-operative', 'Enterprise', { emoji: '🌾' }),
    pin('f', 'Lemons', 'Offer'),
];
createRoot(document.getElementById('root')).render(<MapStackList pins={pins} covered={false} onClose={() => {}} />);
`);

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    nodePaths: [path.join(PWA, 'node_modules'), path.join(ROOT, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'globalThis.process = globalThis.process || { env: {} };' },
    logLevel: 'error',
});
const cssOut = path.join(work, 'app.css');
const tailwind = spawnSync(path.join(ROOT, 'node_modules/.bin/tailwindcss'), [
    '-c', 'tailwind.config.js', '-i', 'src/index.css', '-o', cssOut, '--content', `${path.join(PWA, 'src/components/MapStackList.tsx')},${entry}`,
], { cwd: PWA, encoding: 'utf8' });
if (tailwind.status !== 0) { console.error(tailwind.stderr); process.exit(1); }
const page_ = (scheme) => `<!doctype html><html class="${scheme === 'dark' ? 'dark dark-theme' : ''}" style="font-size:130%"><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<link rel="stylesheet" href="/app.css"><style>html,body{margin:0;height:100%}#root{position:relative;height:100%;overflow:hidden;background:${scheme === 'dark' ? '#242f3e' : '#e8eaed'}}</style></head>
<body><div id="root" style="--bottom-nav-offset:64px"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(result.outputFiles[0].text); return; }
    if (req.url === '/app.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(fs.readFileSync(cssOut)); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page_(req.url.includes('dark') ? 'dark' : 'light'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const problems = [];
try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1.5 });
    await context.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    for (const scheme of ['light', 'dark']) {
        await page.goto(`${base}/${scheme}`);
        await page.waitForSelector('[data-testid="map-stack-list"]', { timeout: 15000 });
        const found = await page.evaluate((WIDTH) => {
            const out = [];
            if (document.scrollingElement.scrollWidth > WIDTH) out.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px)`);
            const panel = document.querySelector('[data-testid="map-stack-list"]');
            for (const el of panel.querySelectorAll('button')) {
                const r = el.getBoundingClientRect();
                if (r.height < 44) out.push(`a button is ${r.height}px tall: ${el.textContent}`);
                if (r.right > WIDTH + 0.5) out.push(`a button runs past the edge: ${el.textContent}`);
            }
            for (const el of panel.querySelectorAll('h2, button span span')) {
                if (el.getBoundingClientRect().right > WIDTH + 0.5) out.push(`words past the edge: ${el.textContent}`);
                const s = getComputedStyle(el);
                if (s.webkitLineClamp === 'none' && el.scrollWidth > el.clientWidth + 1) out.push(`words cut: ${el.textContent}`);
            }
            return { out, heading: panel.querySelector('h2').textContent, font: getComputedStyle(panel.querySelector('.line-clamp-2')).fontSize };
        }, WIDTH);
        problems.push(...found.out.map((p) => `${scheme}: ${p}`));
        console.log(`${scheme}: "${found.heading}", row title ${found.font}`);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `map-stack-web-320-${scheme}.png`) });
        }
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('map-stack-web-320: nothing past the edge, every button 44 px, no words cut');
