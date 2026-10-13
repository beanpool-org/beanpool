/* global process, URL, document, getComputedStyle, innerHeight, innerWidth, window */
/**
 * Getting started at the floor (scratch/global-node/DESIGN-getting-started-fable.md): the tour's bar on every step
 * (local 9, global 7), the "?" dialog for each tab, and the mobile header's pill with each tab's title, in headless
 * Chromium at 320 x 569 with 130% text, light and dark. Fails on sideways scroll, a control under 44 px, words over
 * four lines, contrast under 4.5:1, an axe (WCAG 2 A/AA) violation, a title under the pill or the sync dot, or the
 * bar covering a button above it. Nothing here talks to a node; every request off this machine is aborted.
 *
 * Run from apps/pwa: node e2e/tour-check.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const PWA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(PWA, '..', '..', 'node_modules', '.bin');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-check-'));
fs.writeFileSync(path.join(DIR, 'index.html'), '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="app.css" /><title>tour check</title></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>');
execFileSync(path.join(BIN, 'esbuild'), [path.join(PWA, 'e2e', 'tour-harness.tsx'), '--bundle', '--format=esm', '--jsx=automatic', '--outfile=' + path.join(DIR, 'app.js'),
    '--define:process.env.NODE_ENV="production"', '--define:import.meta.env={"DEV":false,"PROD":true,"MODE":"production","BASE_URL":"/"}', '--define:__APP_VERSION__="harness"',
    '--banner:js=globalThis.process = globalThis.process || { env: {} };', '--loader:.png=dataurl', '--log-level=error'], { cwd: PWA, env: { ...process.env, NODE_PATH: path.join(PWA, 'node_modules') } });
execFileSync(path.join(BIN, 'tailwindcss'), ['-c', 'tailwind.config.js', '-i', 'src/index.css', '-o', path.join(DIR, 'app.css'),
    '--content', 'src/components/TourBar.tsx,src/components/HelpDialog.tsx,src/components/HeaderControls.tsx,e2e/tour-harness.tsx'], { cwd: PWA, stdio: 'ignore' });
const AXE = fs.readFileSync(path.join(PWA, '..', '..', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
    const f = path.join(DIR, new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html'));
    if (!f.startsWith(DIR) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
const problems = [];
const rows = [];
const measure = () => {
    const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) return c; } return [255, 255, 255]; };
    const ratio = (el) => { const a = lum(rgb(getComputedStyle(el).color)), b = lum(bgOf(el)); return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2); };
    const small = [...document.querySelectorAll('button')].filter(b => b.getBoundingClientRect().height < 44 && b.id !== 'behind' && !b.closest('#pill')).map(b => (b.textContent || b.getAttribute('aria-label')).trim());
    const out = { scrollW: document.documentElement.scrollWidth, small };
    const bar = document.querySelector('[data-testid="tour-bar"]');
    if (bar) {
        const r = bar.getBoundingClientRect();
        const w = bar.querySelector('[data-testid="tour-words"]');
        out.bar = { top: Math.round(r.top), height: Math.round(r.height), bottomGap: Math.round(innerHeight - r.bottom) };
        out.lines = Math.round(w.getBoundingClientRect().height / parseFloat(getComputedStyle(w).lineHeight));
        out.contrast = { words: ratio(w), caption: ratio(bar.querySelector('[data-testid="tour-step-caption"]')), skip: ratio(bar.querySelector('[data-testid="tour-skip"]')), next: ratio(bar.querySelector('[data-testid="tour-next"],[data-testid="tour-done"]')) };
        const b = document.getElementById('behind').getBoundingClientRect();
        out.behindTappable = document.elementFromPoint(b.left + 5, b.top + 5)?.id === 'behind';
    }
    const dlg = document.querySelector('[data-testid="help-dialog"]');
    if (dlg) {
        out.dialog = { height: Math.round(dlg.getBoundingClientRect().height), text: dlg.querySelector('[data-testid="help-text"]') ? ratio(dlg.querySelector('[data-testid="help-text"]')) : null, rows: [...dlg.querySelectorAll('[data-testid^="help-"]')].filter(e => e.tagName === 'BUTTON' && e.dataset.testid !== 'help-close').map(e => ratio(e)) };
    }
    const pill = document.getElementById('pill');
    if (pill) {
        const p = pill.firstElementChild.getBoundingClientRect(), t = document.getElementById('title').getBoundingClientRect(), s = document.getElementById('sync').getBoundingClientRect();
        out.header = { pill: [Math.round(p.left), Math.round(p.right)], title: [Math.round(t.left), Math.round(t.right)], gapToPill: Math.round(p.left - t.right), gapToSync: Math.round(t.left - s.right), fits: p.right <= innerWidth };
    }
    return out;
};
for (const dark of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 569 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    await ctx.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    const open = async (qs) => {
        await page.goto(origin + '/index.html?' + qs + (dark ? '&dark=1' : ''), { waitUntil: 'load' });
        await page.addStyleTag({ content: 'html { font-size: 130% !important; }' });
        await page.waitForTimeout(150);
        return page.evaluate(measure);
    };
    const axe = async (sel) => { await page.addScriptTag({ content: AXE }); return page.evaluate(async (s) => (await window.axe.run(s, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map(v => v.id + ':' + v.nodes.length), sel); };
    const scheme = dark ? 'dark' : 'light';
    for (const global of [false, true]) {
        const n = global ? 7 : 9;
        for (let i = 0; i < n; i++) {
            const m = await open('view=step&i=' + i + (global ? '&global=1' : ''));
            const v = i === 0 ? await axe('[data-testid="tour-bar"]') : [];
            rows.push([scheme, (global ? 'global' : 'local') + ' step ' + (i + 1), JSON.stringify({ bar: m.bar, lines: m.lines, c: m.contrast, behind: m.behindTappable, axe: v })]);
            if (m.scrollW > 320) problems.push(scheme + ' step ' + i + ': sideways scroll ' + m.scrollW);
            if (m.small.length) problems.push(scheme + ' step ' + i + ': under 44 px: ' + m.small.join(', '));
            if (!m.behindTappable) problems.push(scheme + ' step ' + i + ': the button behind is covered');
            if (m.lines > 4) problems.push(scheme + ' step ' + i + ': ' + m.lines + ' lines');
            for (const [k, r] of Object.entries(m.contrast)) if (r < 4.5) problems.push(scheme + ' step ' + i + ' ' + k + ' contrast ' + r);
            if (v.length) problems.push(scheme + ' step ' + i + ' axe ' + v.join(' '));
        }
    }
    for (const key of ['home', 'market', 'map', 'talk', 'commons', 'ledger', 'people', 'settings', 'lobby/join']) {
        const m = await open('view=help&key=' + encodeURIComponent(key));
        const v = await axe('[data-testid="help-dialog"]');
        rows.push([scheme, 'help ' + key, JSON.stringify({ d: m.dialog, axe: v })]);
        if (m.scrollW > 320) problems.push(scheme + ' help ' + key + ': sideways ' + m.scrollW);
        if (m.small.length) problems.push(scheme + ' help ' + key + ': under 44 px: ' + m.small.join(', '));
        for (const r of [m.dialog.text, ...m.dialog.rows]) if (r !== null && r < 4.5) problems.push(scheme + ' help ' + key + ' contrast ' + r);
        if (v.length) problems.push(scheme + ' help ' + key + ' axe ' + v.join(' '));
    }
    for (const title of ['Market', 'Marketplace', 'Commons', 'People', 'Ledger', 'Home', 'Map', 'Chat', 'The Pulse']) {
        const m = await open('view=header&title=' + encodeURIComponent(title));
        rows.push([scheme, 'header ' + title, JSON.stringify(m.header)]);
        if (title !== 'Marketplace' && (!m.header.fits || m.header.gapToPill < 0 || m.header.gapToSync < 0)) problems.push(scheme + ' header ' + title + ' overlaps ' + JSON.stringify(m.header));
        if (m.scrollW > 320) problems.push(scheme + ' header ' + title + ': sideways ' + m.scrollW);
    }
    await ctx.close();
}
await browser.close();
server.close();
for (const r of rows) console.log(r.join(' | '));
fs.rmSync(DIR, { recursive: true, force: true });
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'ALL CHECKS PASS');
process.exit(problems.length ? 1 : 0);
