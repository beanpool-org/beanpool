// The website's words, in light and in dark (beanpool.org follows the visitor's setting: Marty, 15 Oct 2026).
//
// Serves apps/website as it deploys, opens every page (the site's own and the generated guide) in headless Chromium at
// 320 and 1280 px wide, once with prefers-color-scheme: light and once dark, and judges every element that has words
// of its own: its colour (each stop of gradient words), at its opacity, over every background between it and the page,
// down to the page's doodle — its ground and its stroke farthest from the words, under the light page's wash. It fails
// under 4.5:1 (3:1 for large words: 24 px, or 18.66 px bold).
//
// Both themes must pass everywhere. Dark carried nine pinned pairs when this check began (15 Oct 2026); each was fixed
// from dark's own values in style.css's set, light untouched, and the pins are gone (16 Oct 2026).
// A canary (words the colour of the page) must fail in both themes, so a check gone blind fails too.
// Not judged: anything aria-hidden (decoration), and Leaflet's own popup close button.
// No network: the CDN scripts come from node_modules or a stub, map tiles are blank. About a minute.
//
//   node scripts/website-contrast.mjs        (WEBSITE_ROOT=<dir> judges another copy of the site; needs: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(process.env.WEBSITE_ROOT ?? path.join(ROOT, 'apps/website')); // another tree, for a fail-first run
const require = createRequire(path.join(ROOT, 'apps/pwa/package.json'));
const { chromium } = require('playwright');
const LEAFLET = path.dirname(require.resolve('leaflet/dist/leaflet.js'));

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
function serve(root) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
            if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
            if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
            if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
            fs.createReadStream(p).pipe(res);
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// The directory comes from a stub (two communities), so the map has pins and a popup to judge.
const FAKE_SUPABASE = `window.supabase = { createClient: () => ({
  from: () => ({ select: async () => ({ data: [
    { community_name: 'Riverbend Commons', service_radius: { lat: -28.55, lng: 153.5, radiusKm: 40 }, member_count: 42, contact_email: 'hello@example.org', contact_phone: '+61 400 000 000', node_url: 'riverbend.example.org' },
    { community_name: 'Hilltop', service_radius: { lat: 40.7, lng: -74, radiusKm: 15 }, member_count: 7 } ], error: null }) }),
  auth: { signInWithOtp: async () => ({ error: null }) } }) };`;
const BLANK_TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAAQAAf8RTdbFAAAAAElFTkSuQmCC', 'base64');

async function offline(page) {
    await page.route('**/*', (r) => {
        const u = new URL(r.request().url());
        if (u.hostname === '127.0.0.1') return r.continue();
        if (u.hostname === 'unpkg.com' && u.pathname.endsWith('leaflet.js')) return r.fulfill({ path: path.join(LEAFLET, 'leaflet.js'), contentType: 'text/javascript' });
        if (u.hostname === 'unpkg.com' && u.pathname.endsWith('leaflet.css')) return r.fulfill({ path: path.join(LEAFLET, 'leaflet.css'), contentType: 'text/css' });
        if (u.hostname === 'unpkg.com' && u.pathname.includes('/images/')) return r.fulfill({ path: path.join(LEAFLET, 'images', path.basename(u.pathname)) });
        if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('supabase')) return r.fulfill({ body: FAKE_SUPABASE, contentType: 'text/javascript' });
        if (u.hostname.endsWith('tile.openstreetmap.org')) return r.fulfill({ body: BLANK_TILE, contentType: 'image/png' });
        return r.fulfill({ status: 204, body: '' });
    });
}

function pages() {
    const top = fs.readdirSync(SITE).filter((f) => f.endsWith('.html'));
    const walk = (dir) => fs.readdirSync(path.join(SITE, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.html') ? [`${dir}/${e.name}`] : []);
    return [...top, ...walk('guide')];
}

/** The doodle tiles' strokes farthest from the page's words: the brightest in dark, the darkest in light. */
async function doodleStrokes(page) {
    return page.evaluate(async () => {
        const lum = (c) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
        const out = {};
        for (const [theme, src] of [['dark', 'assets/pattern-dark.webp'], ['light', 'assets/pattern-light.webp']]) {
            const img = new Image(); img.src = src; await img.decode();
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const g = c.getContext('2d'); g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, c.width, c.height).data;
            let best = null, bestL = theme === 'dark' ? -1 : 2;
            for (let i = 0; i < d.length; i += 4) {
                const L = lum([d[i], d[i + 1], d[i + 2]]);
                if (theme === 'dark' ? L > bestL : L < bestL) { bestL = L; best = [d[i], d[i + 1], d[i + 2]]; }
            }
            out[theme] = best;
        }
        return out;
    });
}

/** Every element with words of its own, judged in the page as it is drawn. */
function judge(strokes) {
    const parse = (s) => { const m = s && s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; };
    const over = (top, bot) => [0, 1, 2].map((i) => top[i] * top[3] + bot[i] * (1 - top[3])).concat(1);
    const lum = (c) => c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const stops = (img) => (img.match(/rgba?\([^)]+\)/g) || []).map(parse);
    const clipsText = (s) => s.webkitBackgroundClip === 'text' || s.backgroundClip === 'text';
    // The page's ground: the doodle's own ground and its farthest stroke, under any plain wash the body lays on it.
    const body = getComputedStyle(document.body);
    let grounds = [parse(body.backgroundColor), [...strokes, 1]];
    const layersOf = (img) => { const out = []; let depth = 0, cur = ''; for (const ch of img) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };
    for (const layer of layersOf(body.backgroundImage).reverse()) {
        if (!/^linear-gradient/.test(layer)) continue;
        const [a, b] = stops(layer);
        if (a && b && a.join() === b.join()) grounds = grounds.map((g) => over(a, g));
    }
    const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || e.getAttribute('aria-hidden') === 'true') return false; } return true; };
    const rows = [];
    for (const el of document.body.querySelectorAll('*')) {
        if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName) || el.closest('svg') || el.closest('.leaflet-popup-close-button')) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const placeholder = el.tagName === 'INPUT' && el.placeholder && !el.value;
        if ((!own && !placeholder) || !shown(el)) continue;
        const s = getComputedStyle(el);
        const size = parseFloat(s.fontSize), weight = Number(s.fontWeight) || 400;
        const min = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
        let inks;
        if (parse(s.webkitTextFillColor)?.[3] === 0) {
            let e = el; while (e && !clipsText(getComputedStyle(e))) e = e.parentElement;
            inks = e ? stops(getComputedStyle(e).backgroundImage) : [parse(s.color)];
        } else inks = [parse(placeholder ? getComputedStyle(el, '::placeholder').color : s.color)];
        let opacity = 1;
        for (let e = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
        // The backgrounds between the words and the page, nearest first; each layer is its candidate colours.
        const layers = [];
        let bases = grounds;
        for (let e = el; e && e !== document.body; e = e.parentElement) {
            const es = getComputedStyle(e);
            if (clipsText(es)) continue;
            if (/gradient/.test(es.backgroundImage)) layers.push(stops(es.backgroundImage).filter(Boolean));
            const bg = parse(es.backgroundColor);
            if (bg && bg[3] === 1) { bases = [bg]; break; }
            if (bg && bg[3] > 0) layers.push([bg]);
        }
        let backs = bases;
        for (let i = layers.length - 1; i >= 0; i--) backs = backs.flatMap((b) => layers[i].map((c) => over(c, b)));
        let worst = Infinity, ink = null, ground = null;
        for (const k of inks) for (const b of backs) {
            const t = over([k[0], k[1], k[2], k[3] * opacity], b);
            const r = ratio(t, b);
            if (r < worst) [worst, ink, ground] = [r, t, b];
        }
        const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
        const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');
        rows.push({ sel, text: (own ? el.textContent : el.placeholder).trim().replace(/\s+/g, ' ').slice(0, 40), ratio: Math.floor(worst * 100) / 100, min, ink: hex(ink), ground: hex(ground) });
    }
    return rows;
}

const browser = await chromium.launch();
const server = await serve(SITE);
const base = `http://127.0.0.1:${server.address().port}`;
const failures = [];
let judged = 0;
try {
    const first = await browser.newPage();
    await offline(first);
    await first.goto(`${base}/index.html`);
    const strokes = await doodleStrokes(first);
    await first.close();
    for (const theme of ['light', 'dark']) {
        let canaryCaught = false;
        for (const pg of pages()) for (const width of [320, 1280]) {
            const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
            const page = await ctx.newPage();
            await offline(page);
            await page.goto(`${base}/${pg}`, { waitUntil: 'load' });
            await page.evaluate(() => document.fonts.ready);
            if (pg === 'index.html') {
                await page.waitForSelector('.leaflet-marker-icon', { timeout: 5000 }).catch(() => {});
                await page.evaluate(() => document.querySelector('.leaflet-marker-icon')?.click());
                // Leaflet fades a popup in over 0.2 s (it ignores reduced motion): judge it at rest, not part way in, and
                // fail if it never opens, so the popup can't drop out of the check unseen.
                const open = await page.waitForFunction(() => { const p = document.querySelector('.leaflet-popup'); return p && getComputedStyle(p).opacity === '1'; }, null, { timeout: 5000 }).then(() => true, () => false);
                if (!open) failures.push({ line: `${theme} ${width}px index.html: the directory map's popup did not open, so it was not judged` });
            }
            if (pg === 'help.html' && width === 320) {
                await page.evaluate(() => { const p = document.createElement('p'); p.textContent = 'contrast canary'; p.style.color = 'var(--pattern-bg)'; document.querySelector('main, .container, body').prepend(p); });
            }
            const rows = await page.evaluate(judge, theme === 'dark' ? strokes.dark : strokes.light);
            judged += rows.length;
            for (const row of rows) {
                if (row.ratio >= row.min) continue;
                if (row.text === 'contrast canary') { canaryCaught = true; continue; }
                failures.push({ pair: `${theme} ${row.ink} on ${row.ground} = ${row.ratio}:1 (needs ${row.min})`, line: `${width}px ${pg}: ${row.sel} "${row.text}"` });
            }
            await ctx.close();
        }
        if (!canaryCaught) failures.push({ line: `${theme}: the canary (words the colour of the page's ground) was not caught: the check has gone blind` });
    }
} finally {
    await browser.close();
    server.close();
}
console.log(`website contrast: ${pages().length} pages x 2 widths x 2 themes, ${judged} elements with words judged`);
if (failures.length) {
    // One line per colour pair, with how often and where it was first seen.
    const pairs = new Map();
    for (const f of failures) { const k = f.pair ?? f.line; if (!pairs.has(k)) pairs.set(k, { first: f.line, n: 0 }); pairs.get(k).n++; }
    console.log(`FAIL: ${failures.length} under the bar, ${pairs.size} colour pairs`);
    for (const [k, v] of pairs) console.log(`  ${k}  x${v.n}  e.g. ${v.first}`);
    process.exit(1);
}
console.log('PASS: every word on the website reads at 4.5:1 or better (3:1 large), in light and in dark');
