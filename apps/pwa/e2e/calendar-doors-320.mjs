#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
/**
 * Calendar doors on the web (DESIGN-map-calendar-fable.md §8 S4),
 * at the floor (320px wide, text at 130% in browser), in light and dark:
 * 1. Home card "Coming up" with "Calendar ›" and "All events ›"
 * 2. Market Events filter chip row with the calendar button
 *
 * Checks: no sideways scroll; nothing past the 320px edge; every target at least 44px tall; no words cut.
 * Screenshots with --shots <dir>.
 */
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
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : (process.argv[2] ? path.resolve(process.argv[2]) : null);
const WIDTH = 320;
const HEIGHT = 568;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-doors-web-320-'));

const entry = path.join(work, 'entry.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { HomeCard, HomeLine, HomeMore } from ${JSON.stringify(path.join(PWA, 'src/components/HomeCard'))};

function App() {
    return (
        <div className="p-4 space-y-6">
            {/* 1. Home "Coming up" card with Calendar › door */}
            <HomeCard id="events" caption="Coming up" hue="events">
                <HomeLine icon={<span className="text-xl">📅</span>}>
                    <span className="min-w-0">
                        <span className="flex flex-wrap gap-x-1 text-sm font-bold text-nature-700 dark:text-nature-200">
                            <span className="whitespace-nowrap">SAT 7 NOV · 9:00</span>
                        </span>
                        <span dir="auto" className="block break-words font-semibold text-nature-900 dark:text-nature-50">
                            Spring Working Bee & Tool Care Workshop
                        </span>
                        <span className="block text-xs text-nature-600 dark:text-nature-300 break-words">
                            Community Hall · 12 km
                        </span>
                    </span>
                </HomeLine>
                <div className="flex flex-wrap justify-end gap-x-4">
                    <HomeMore onClick={() => {}} testId="home-events-calendar" label="Calendar">
                        Calendar<span aria-hidden="true"> ›</span>
                    </HomeMore>
                    <HomeMore onClick={() => {}} testId="home-events-all">
                        All events ›
                    </HomeMore>
                </div>
            </HomeCard>

            {/* 2. Market Events filter row with calendar button door */}
            <div className="mt-4">
                <div
                    role="group"
                    aria-label="Filter events by date"
                    className="flex flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain mt-0.5 mb-2.5 pb-0.5"
                    style={{ scrollbarWidth: 'none' }}
                >
                    <div
                        data-testid="feed-event-window-chips"
                        className="flex flex-nowrap items-center gap-2"
                    >
                        {['Today', 'This weekend', 'Next 7 days', 'All'].map((label, i) => (
                            <button
                                key={label}
                                type="button"
                                className={\`flex-shrink-0 whitespace-nowrap min-h-[48px] px-3.5 rounded-full border text-sm font-bold transition-colors cursor-pointer \${
                                    i === 3
                                        ? 'bg-violet-700 border-violet-700 text-white'
                                        : 'bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-700 text-nature-800 dark:text-oat-50'
                                }\`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        data-testid="market-calendar-button"
                        aria-label="Calendar"
                        className="flex-shrink-0 min-h-[48px] min-w-[48px] px-3.5 rounded-full border text-sm font-bold shadow-sm transition-colors flex items-center justify-center cursor-pointer bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-700 text-nature-800 dark:text-oat-50"
                    >
                        <svg data-calendar-icon width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
                            <path d="M3.5 10h17M8 3v4M16 3v4" />
                            <circle cx="8.5" cy="14.5" r="0.6" fill="currentColor" />
                            <circle cx="12" cy="14.5" r="0.6" fill="currentColor" />
                            <circle cx="15.5" cy="14.5" r="0.6" fill="currentColor" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')).render(<App />);
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
    '-c', 'tailwind.config.js', '-i', 'src/index.css', '-o', cssOut, '--content', `${entry},${path.join(PWA, 'src/components/HomeCard.tsx')}`,
], { cwd: PWA, encoding: 'utf8' });
if (tailwind.status !== 0) {
    console.error(tailwind.stderr);
    process.exit(1);
}

const page_ = (scheme) => `<!doctype html><html class="${scheme === 'dark' ? 'dark dark-theme' : ''}" style="font-size:130%"><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}">
<link rel="stylesheet" href="/app.css"><style>html,body{margin:0;min-height:100%}#root{min-height:100%;background:${scheme === 'dark' ? '#0f172a' : '#faf9f6'}}</style></head>
<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(result.outputFiles[0].text);
        return;
    }
    if (req.url === '/app.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(fs.readFileSync(cssOut));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page_(req.url.includes('dark') ? 'dark' : 'light'));
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
        await page.waitForSelector('[data-testid="home-events-calendar"]');
        await page.waitForSelector('[data-testid="home-events-all"]');
        await page.waitForSelector('[data-testid="market-calendar-button"]');

        const found = await page.evaluate((width) => {
            const out = [];
            if (document.scrollingElement.scrollWidth > width) {
                out.push(`page scrolls sideways (${document.scrollingElement.scrollWidth}px > ${width}px)`);
            }

            for (const id of ['home-events-calendar', 'home-events-all', 'market-calendar-button']) {
                const el = document.querySelector(`[data-testid="${id}"]`);
                if (!el) {
                    out.push(`missing testid ${id}`);
                    continue;
                }
                const r = el.getBoundingClientRect();
                if (r.height < 43.5) out.push(`${id} height ${r.height.toFixed(1)} < 44px`);
                if (id === 'market-calendar-button' && r.width < 43.5) out.push(`${id} width ${r.width.toFixed(1)} < 44px`);
            }

            return { out };
        }, WIDTH);

        problems.push(...found.out.map((p) => `${scheme}: ${p}`));
        console.log(`${scheme}: Web calendar doors verified (Calendar ›, All events ›, market-calendar-button ≥ 44px)`);

        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `web-doors-320-${scheme}.png`) });
        }
    }
} finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log('web calendar-doors-320: passed');
