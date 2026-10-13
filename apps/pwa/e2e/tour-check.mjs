/* global process, URL, console, document, getComputedStyle, innerHeight, innerWidth, window */
/**
 * Getting started at the floor (scratch/global-node/DESIGN-getting-started-fable.md): the tour's bar on every step
 * (local 9, global 7), the "?" dialog for each tab, and the mobile header's pill with each tab's title, in headless
 * Chromium at 320 x 569 with 130% text, light and dark (the header also at 360, 375, 390, 412 and 430 px, 100% and 130%
 * text). Fails on sideways scroll, a control under 44 px, words over four lines, contrast under 4.5:1, an axe (WCAG 2
 * A/AA) violation, a title whose box meets the real sync chip's or the pill's (or covers the "?"), a title not centred
 * in the room between them, a cut title without its ellipsis, the bar
 * covering a button above it, or the bar covering the tab's own bottom button (the Market's + ADD POST, which step 2
 * names, and the Map's +: their classes and offset are read from the pages themselves). Nothing here talks to a node; every request off this machine is aborted.
 *
 * Run from apps/pwa: node e2e/tour-check.mjs   (TOUR_SHOTS=<dir>: a picture of the header rows at each width and text size)
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
// Each tab's bottom button as its page draws it: the first fixed button riding on --bottom-nav-offset.
const fabOf = (rel) => {
    const m = /className="(fixed bottom-\[calc\(var\(--bottom-nav-offset\)[^"]*)"\s*style=\{\{ bottom: '([^']+)' \}\}/.exec(fs.readFileSync(path.join(PWA, rel), 'utf8'));
    if (!m) throw new Error('no bottom button found in ' + rel);
    return { className: m[1], bottom: m[2] };
};
fs.writeFileSync(path.join(DIR, 'fabs.json'), JSON.stringify({ market: fabOf('src/pages/MarketplacePage.tsx'), map: fabOf('src/pages/MapPage.tsx') }));
execFileSync(path.join(BIN, 'esbuild'), [path.join(PWA, 'e2e', 'tour-harness.tsx'), '--bundle', '--format=esm', '--jsx=automatic', '--outfile=' + path.join(DIR, 'app.js'),
    '--define:process.env.NODE_ENV="production"', '--define:import.meta.env={"DEV":false,"PROD":true,"MODE":"production","BASE_URL":"/"}', '--define:__APP_VERSION__="harness"',
    '--banner:js=globalThis.process = globalThis.process || { env: {} };', '--loader:.png=dataurl', '--log-level=error'], { cwd: PWA, env: { ...process.env, NODE_PATH: path.join(PWA, 'node_modules') } });
execFileSync(path.join(BIN, 'tailwindcss'), ['-c', 'tailwind.config.js', '-i', 'src/index.css', '-o', path.join(DIR, 'app.css'),
    '--content', 'src/components/TourBar.tsx,src/components/HelpDialog.tsx,src/components/HeaderControls.tsx,src/components/SyncChip.tsx,src/components/LobbyHeader.tsx,e2e/tour-harness.tsx,' + path.join(DIR, 'fabs.json')], { cwd: PWA, stdio: 'ignore' });
const AXE = fs.readFileSync(path.join(PWA, '..', '..', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
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
        const f = document.getElementById('fab').getBoundingClientRect();
        out.fab = { bottom: Math.round(f.bottom), barTop: Math.round(r.top), tappable: document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2)?.closest('#fab') != null };
    }
    const dlg = document.querySelector('[data-testid="help-dialog"]');
    if (dlg) {
        out.dialog = { height: Math.round(dlg.getBoundingClientRect().height), text: dlg.querySelector('[data-testid="help-text"]') ? ratio(dlg.querySelector('[data-testid="help-text"]')) : null, rows: [...dlg.querySelectorAll('[data-testid^="help-"]')].filter(e => e.tagName === 'BUTTON' && e.dataset.testid !== 'help-close').map(e => ratio(e)) };
    }
    const lobby = document.querySelector('[data-testid="lobby-header"]');
    if (lobby) {
        const t = lobby.querySelector('[data-testid="lobby-title"]'), tr = t.getBoundingClientRect();
        const bean = lobby.querySelector('[data-testid="lobby-bean"]').getBoundingClientRect(), right = lobby.querySelector('[data-testid="lobby-header-right"]').getBoundingClientRect();
        const help = lobby.querySelector('[data-testid="lobby-help"]').getBoundingClientRect();
        // The words' own width (the h1 fills the room; its text is centred in it).
        const range = document.createRange(); range.selectNodeContents(t); const w = range.getBoundingClientRect();
        out.lobby = { bean: Math.round(bean.right), words: [Math.round(w.left), Math.round(w.right)], right: Math.round(right.left), whole: t.scrollWidth <= t.clientWidth,
            helpTappable: document.elementFromPoint(help.left + help.width / 2, help.top + help.height / 2)?.closest('[data-testid="lobby-help"]') != null, fits: right.right <= innerWidth, title: [Math.round(tr.left), Math.round(tr.right)] };
    }
    // Each header row: the title's box against the real chip's and the pill's, and where its words sit in the room between.
    out.headers = [...document.querySelectorAll('header[data-row]')].map(h => {
        const t = h.querySelector('[data-testid="header-title"]');
        const title = t.getBoundingClientRect(), chip = h.querySelector('[data-testid="sync-chip"]').getBoundingClientRect(), pill = h.querySelector('[data-testid="header-pill"]').getBoundingClientRect();
        const help = h.querySelector('[data-testid="header-help"]').getBoundingClientRect();
        const meets = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        // Cut: the laid-out words are wider than the content box (any overflow at all draws the ellipsis; fractional widths,
        // as clientWidth rounds).
        const cs = getComputedStyle(t), pl = parseFloat(cs.paddingLeft), content = title.width - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth) - pl - parseFloat(cs.paddingRight);
        const range = document.createRange(); range.selectNodeContents(t); const w = range.getBoundingClientRect();
        const cut = w.width > content + 0.01;
        // The words' own middle: the content box's (cut, the words fill it) or the laid-out text's.
        const mid = cut ? title.left + parseFloat(cs.borderLeftWidth) + pl + content / 2 : (w.left + w.right) / 2;
        return { row: h.dataset.row, chip: [Math.round(chip.left), Math.round(chip.right)], title: [Math.round(title.left), Math.round(title.right)], pill: [Math.round(pill.left), Math.round(pill.right)],
            gapToChip: Math.round(title.left - chip.right), gapToPill: Math.round(pill.left - title.right), meets: meets(title, chip) || meets(title, pill),
            offCentre: Math.round((mid - (chip.right + pill.left) / 2) * 10) / 10, cut, ellipsis: cs.textOverflow === 'ellipsis',
            helpTappable: document.elementFromPoint(help.left + help.width / 2, help.top + help.height / 2)?.closest('[data-testid="header-help"]') != null, fits: pill.right <= innerWidth };
    });
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
            rows.push([scheme, (global ? 'global' : 'local') + ' step ' + (i + 1), JSON.stringify({ bar: m.bar, lines: m.lines, c: m.contrast, behind: m.behindTappable, fab: m.fab, axe: v })]);
            if (m.scrollW > 320) problems.push(scheme + ' step ' + i + ': sideways scroll ' + m.scrollW);
            if (m.small.length) problems.push(scheme + ' step ' + i + ': under 44 px: ' + m.small.join(', '));
            if (!m.behindTappable) problems.push(scheme + ' step ' + i + ': the button behind is covered');
            if (!m.fab.tappable || m.fab.bottom > m.fab.barTop) problems.push(scheme + ' step ' + i + ': the tab\'s bottom button is under the bar ' + JSON.stringify(m.fab));
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
    // The mobile header at every phone width, at 100% and 130% text: every title against every chip (tour-harness.tsx).
    await page.goto(origin + '/index.html?view=header' + (dark ? '&dark=1' : ''), { waitUntil: 'load' });
    const scale = await page.addStyleTag({ content: '/* the text size */' });
    for (const text of [100, 130]) {
        await scale.evaluate((el, pc) => { el.textContent = 'html { font-size: ' + pc + '% !important; }'; }, text);
        for (const width of [320, 360, 375, 390, 412, 430]) {
            await page.setViewportSize({ width, height: 2400 }); // every row on screen, so the "?" can be hit-tested
            await page.waitForTimeout(60);
            const m = await page.evaluate(measure);
            const at = scheme + ' header ' + width + ' px ' + text + '%';
            if (process.env.TOUR_SHOTS) { fs.mkdirSync(process.env.TOUR_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.TOUR_SHOTS, 'header-' + scheme + '-' + width + '-' + text + '.png'), clip: { x: 0, y: 0, width, height: 1100 } }); }
            if (m.scrollW > width) problems.push(at + ': sideways ' + m.scrollW);
            for (const r of m.headers) {
                rows.push([at, r.row, JSON.stringify({ chip: r.chip, title: r.title, pill: r.pill, gapToChip: r.gapToChip, gapToPill: r.gapToPill, offCentre: r.offCentre, cut: r.cut })]);
                if (r.meets || r.gapToChip < 0 || r.gapToPill < 0) problems.push(at + ' ' + r.row + ': the title meets the chip or the pill ' + JSON.stringify(r));
                if (!r.helpTappable || !r.fits) problems.push(at + ' ' + r.row + ': the "?" is covered or the pill is off screen ' + JSON.stringify(r));
                if (!r.cut && Math.abs(r.offCentre) > 1.5) problems.push(at + ' ' + r.row + ': the title is ' + r.offCentre + ' px off the middle of the room ' + JSON.stringify(r));
                if (r.cut && !r.ellipsis) problems.push(at + ' ' + r.row + ': the title is cut without an ellipsis ' + JSON.stringify(r));
            }
        }
    }
    await page.setViewportSize({ width: 320, height: 569 });
    for (const title of ['Home', 'Market', 'Map']) {
        const m = await open('view=lobby&title=' + encodeURIComponent(title));
        rows.push([scheme, 'lobby header ' + title, JSON.stringify(m.lobby)]);
        if (!m.lobby.whole || !m.lobby.fits || !m.lobby.helpTappable || m.lobby.words[0] < m.lobby.bean || m.lobby.words[1] > m.lobby.right) problems.push(scheme + ' lobby header ' + title + ' overlaps ' + JSON.stringify(m.lobby));
        if (m.scrollW > 320) problems.push(scheme + ' lobby header ' + title + ': sideways ' + m.scrollW);
    }
    await ctx.close();
}
await browser.close();
server.close();
for (const r of rows) console.log(r.join(' | '));
fs.rmSync(DIR, { recursive: true, force: true });
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'ALL CHECKS PASS');
process.exit(problems.length ? 1 : 0);
