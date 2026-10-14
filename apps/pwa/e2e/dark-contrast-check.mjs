/**
 * Dark mode on the web, measured (lane dark-pwa, 13 Oct 2026; Marty via Damo: "pages in the dark mode that ... look like this").
 * The web app built exactly as it ships, served by REAL nodes on this machine (e2e/home-node-harness.ts, a local and a global
 * profile), in headless Chromium at 320 px with 1.3x text and reduced motion. On every screen it opens (signed-out lobby,
 * a local member's tabs, sheets and dialogs, the global lobby and a global member) it measures, from computed styles:
 *
 *   - text contrast against the colours actually behind it (every layer up to the first opaque one, gradients at their
 *     worst stop, a background picture by the colour it sits on, the element's and its ancestors' opacity): 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold);
 *     disabled controls are listed apart (WCAG exempts them);
 *   - placeholders (4.5:1) and the edges of text fields (3:1 against the page, unless the field's own fill stands out);
 *   - icons drawn in currentColor (3:1);
 *   - light slabs left on a dark page (an opaque surface brighter than 50% luminance, bigger than 24×24 px; a control drawn
 *     inverted on purpose, `dark:bg-white` or a selected chip/tab up to 140×64 px with 4.5:1 ink, is not one);
 *   - the keyboard focus: each of the first Tab stops must show an outline or ring of 3:1 against what is behind it;
 *   - hover: a control with both a dark fill and a hover fill keeps its words at AA under the pointer.
 *
 * Run:  pnpm --filter @beanpool/pwa dark-contrast-check
 *   DARK_SWEEP=1     every screen, every finding listed, never fails (the survey behind scratch/darkmode/REPORT-web-dark.md)
 *   DARK_THEME=light the same screens in light mode (screenshots for a before/after diff; measures nothing)
 *   DARK_BUILD=<dir> serve the web app built from another checkout's apps/pwa (the light diff against origin/main)
 *   DARK_SHOTS=<dir> where screenshots go (default e2e/screenshots/dark-sweep/<theme>)
 * Without DARK_SWEEP it is the regression check: the screens below must measure clean in dark (no text under AA, no light
 * slab, no field edge or icon under 3:1, every focus stop visible), or it fails.
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, setTimeout, document, window, indexedDB, localStorage, getComputedStyle, Node -- Node, and the page's side of evaluate() */
import { build } from 'vite';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.resolve(PWA_DIR, '../server');
process.chdir(PWA_DIR);

const SWEEP = process.env.DARK_SWEEP === '1';
const THEME = process.env.DARK_THEME === 'light' ? 'light' : 'dark';
const BUILD_FROM = process.env.DARK_BUILD ? path.resolve(process.env.DARK_BUILD) : PWA_DIR;
const SHOTS_DIR = process.env.DARK_SHOTS || path.join(PWA_DIR, 'e2e/screenshots/dark-sweep', THEME);
const VIEW = { width: 320, height: 720 };
const TEXT_SCALE = 1.3;
const FOCUS_STOPS = 12;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function memberIdentity(callsign) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
        callsign,
        createdAt: new Date().toISOString(),
    };
}

// ---------- the node (as home-check.mjs starts it) ----------

async function startNode(root, profile, members) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-dark-${profile}-data-`));
    const child = spawn(process.execPath, ['--import', 'tsx', '../pwa/e2e/home-node-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root, FIXTURE_PROFILE: profile, FIXTURE_MEMBERS: JSON.stringify(members) },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const log = [];
    const waiting = new Map();
    let ready;
    const readyAt = new Promise((resolve, reject) => {
        ready = resolve;
        child.on('exit', (code) => reject(new Error(`the node exited (${code}) before it was ready:\n${log.slice(-30).join('\n')}`)));
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith('FIXTURE_READY ')) ready(JSON.parse(line.slice('FIXTURE_READY '.length)));
        else if (line.startsWith('FIXTURE_ANSWER ')) {
            const a = JSON.parse(line.slice('FIXTURE_ANSWER '.length));
            waiting.get(a.id)?.(a);
            waiting.delete(a.id);
        } else log.push(line);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => log.push(line));
    const { port } = await readyAt;
    let n = 0;
    const ask = (req) => new Promise((resolve, reject) => {
        const id = ++n;
        waiting.set(id, (a) => (a.ok ? resolve(a.result) : reject(new Error(`node: ${a.error}`))));
        child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });
    const stop = async () => {
        child.kill('SIGTERM');
        await wait(300);
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { port, log, ask, stop, origin: `https://localhost:${port}` };
}

// ---------- the browser ----------

async function openContext(browser, origin, identity) {
    const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    await context.addInitScript((mode) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
    }, THEME);
    await context.route((url) => url.hostname !== 'localhost', (route) => route.abort());
    const page = await context.newPage();
    if (identity) {
        await page.goto(`${origin}/app`, { waitUntil: 'load' });
        await page.evaluate((id) => new Promise((resolve, reject) => {
            const open = indexedDB.open('beanpool-identity', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('keys');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const tx = open.result.transaction('keys', 'readwrite');
                tx.objectStore('keys').put(id, 'sovereign-identity');
                tx.oncomplete = () => { open.result.close(); resolve(); };
                tx.onerror = () => reject(tx.error);
            };
        }), identity);
    }
    return { context, page };
}

async function land(page, origin, pathname = '/app') {
    await page.goto(`${origin}${pathname}`, { waitUntil: 'load' });
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; } *, *::before, *::after { caret-color: transparent !important; }` });
    await wait(1_500);
}

/** A click, or (when something drawn over it takes the pointer, as a toast or the install banner can) the same click sent to it. */
async function press(locator) {
    await locator.click({ timeout: 10_000 }).catch(() => locator.dispatchEvent('click', undefined, { timeout: 10_000 }));
}
const tab = (label) => async (page) => {
    await page.getByTestId('mobile-bottom-nav').waitFor({ timeout: 30_000 });
    await press(page.getByTestId('mobile-bottom-nav').getByRole('button', { name: label }).first());
    await wait(1_200);
};
/** The signed-out lobby has its own bottom nav. */
const lobbyTab = (label) => async (page) => {
    await page.getByTestId('lobby-bottom-nav').waitFor({ timeout: 30_000 });
    await press(page.getByTestId('lobby-bottom-nav').getByRole('button', { name: label }).first());
    await wait(1_200);
};
const clickText = (text) => async (page) => {
    await press(page.getByText(text).first());
    await wait(900);
};
const clickRole = (role, name) => async (page) => {
    await press(page.getByRole(role, { name }).first());
    await wait(900);
};
const clickTestId = (id) => async (page) => {
    await press(page.getByTestId(id).first());
    await wait(900);
};
const steps = (...fns) => async (page) => { for (const f of fns) await f(page); };

/**
 * Everything measured on the page as it stands, in the page itself. Colours go through a canvas, so any CSS colour form
 * (rgb, oklch, color()) comes back as sRGB bytes.
 */
function measure(themeIsDark) {
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = 1;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    const cache = new Map();
    const rgba = (c) => {
        if (!c) return { r: 0, g: 0, b: 0, a: 0 };
        if (cache.has(c)) return cache.get(c);
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        const v = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        cache.set(c, v);
        return v;
    };
    const over = (top, under) => ({
        r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1,
    });
    const lum = ({ r, g, b }) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    const pageBase = rgba(getComputedStyle(document.body).backgroundColor).a > 0
        ? over(rgba(getComputedStyle(document.body).backgroundColor), { r: 255, g: 255, b: 255, a: 1 })
        : { r: 255, g: 255, b: 255, a: 1 };

    /** The colours behind `el` (gradient stops give several), and whether a picture is under it. */
    const backdrops = (el) => {
        const layers = [];
        let picture = false;
        let stops = null;
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const cs = getComputedStyle(n);
            const img = cs.backgroundImage;
            if (img && img !== 'none') {
                if (/url\(/.test(img)) picture = true;
                const found = img.match(/(rgba?|oklch|oklab|hsla?|color)\([^()]*(\([^()]*\)[^()]*)*\)|#[0-9a-f]{3,8}\b/gi);
                if (found && !stops) stops = { at: layers.length, colours: found.map(rgba) };
            }
            const bg = rgba(cs.backgroundColor);
            if (bg.a > 0) { layers.push(bg); if (bg.a >= 0.999) break; }
            if (n.tagName === 'IMG' || n.tagName === 'VIDEO' || n.tagName === 'CANVAS') picture = true;
        }
        const composite = (base) => layers.reduceRight((acc, l) => over(l, acc), base);
        let base = pageBase;
        if (layers.length && layers[layers.length - 1].a >= 0.999) base = layers.pop();
        if (stops) {
            const inner = layers.slice(0, stops.at);
            return { colours: stops.colours.map((s) => inner.reduceRight((acc, l) => over(l, acc), over(s, base))), picture };
        }
        return { colours: [composite(base)], picture };
    };
    const opacityOf = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
    const visible = (el) => {
        if (!el.getClientRects().length) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        if (el.closest('[aria-hidden="true"], .sr-only, .leaflet-tile-pane')) return false;
        return opacityOf(el) > 0.05;
    };
    const describe = (el) => {
        const id = el.getAttribute('data-testid');
        const cls = (el.getAttribute('class') || '').split(/\s+/).filter((c) => /^(dark:)?(bg|text|border|placeholder|ring|outline)-/.test(c)).slice(0, 6).join(' ');
        const style = el.getAttribute('style') ? ' style' : '';
        return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''}${cls ? ` .${cls}` : ''}${style}`;
    };
    const disabled = (el) => !!el.closest(':disabled, [aria-disabled="true"]');
    const textOf = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const worst = (fg, el) => {
        const o = opacityOf(el);
        const { colours, picture } = backdrops(el);
        let min = Infinity; let behind = colours[0];
        for (const bgc of colours) {
            const c = ratio(over({ ...fg, a: fg.a * o }, bgc), bgc);
            if (c < min) { min = c; behind = bgc; }
        }
        return { ratio: min, fg: hex(over({ ...fg, a: fg.a * o }, behind)), bg: hex(behind), picture };
    };

    const text = [];
    const placeholders = [];
    const fields = [];
    const icons = [];
    const slabs = [];
    for (const el of document.body.querySelectorAll('*')) {
        if (!visible(el)) continue;
        const cs = getComputedStyle(el);
        const t = textOf(el);
        if (t && /[\p{L}\p{N}]/u.test(t) && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName)) {
            const size = parseFloat(cs.fontSize);
            const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
            const m = worst(rgba(cs.color), el);
            // Over a background picture (the doodle pattern) the text is measured against the colour the picture sits on.
            text.push({ el: describe(el), text: t.slice(0, 60), size, large, need: large ? 3 : 4.5, disabled: disabled(el), ...m });
        }
        if (el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]), textarea, select')) {
            if (el.placeholder && !el.value) {
                const m = worst(rgba(getComputedStyle(el, '::placeholder').color), el);
                placeholders.push({ el: describe(el), text: el.placeholder.slice(0, 50), need: 4.5, disabled: disabled(el), ...m });
            }
            if (el.value && el.tagName !== 'SELECT') {
                const m = worst(rgba(cs.color), el);
                text.push({ el: describe(el), text: `(value) ${String(el.value).slice(0, 40)}`, size: parseFloat(cs.fontSize), large: false, need: 4.5, disabled: disabled(el), ...m });
            }
            const outside = backdrops(el.parentElement).colours[0];
            const fill = backdrops(el).colours[0];
            const edge = Math.max(...['Top', 'Right', 'Bottom', 'Left'].map((s) => (parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none'
                ? ratio(over(rgba(cs[`border${s}Color`]), outside), outside) : 1)));
            const fillStands = ratio(fill, outside);
            const shadow = cs.boxShadow && cs.boxShadow !== 'none';
            fields.push({ el: describe(el), text: (el.placeholder || el.getAttribute('aria-label') || el.name || '').slice(0, 40), edge, fillStands, shadow,
                ratio: Math.max(edge, fillStands), need: 3, disabled: disabled(el), fg: hex(over(rgba(cs.borderTopColor), outside)), bg: hex(outside) });
        }
        // Icons drawn in currentColor (an svg that paints its own colours, or holds an emoji, is a picture).
        if (el.tagName.toLowerCase() === 'svg' && (el.matches('[fill="currentColor"], [stroke="currentColor"]') || el.querySelector('[fill="currentColor"], [stroke="currentColor"]'))) {
            const r = el.getBoundingClientRect();
            if (r.width >= 8 && r.height >= 8 && !el.closest('.leaflet-container')) {
                const paint = cs.fill !== 'none' && rgba(cs.fill).a > 0 ? cs.fill : cs.stroke;
                if (paint && paint !== 'none') {
                    const m = worst(rgba(paint), el);
                    if (!m.picture) icons.push({ el: describe(el.closest('button, a') || el), text: (el.closest('button, a')?.getAttribute('aria-label') || '').slice(0, 40), need: 3, disabled: disabled(el), ...m });
                }
            }
        }
        if (themeIsDark && !['IMG', 'VIDEO', 'CANVAS', 'svg', 'INPUT'].includes(el.tagName) && !el.closest('.leaflet-container')) {
            const bg = rgba(cs.backgroundColor);
            const r = el.getBoundingClientRect();
            // Not a slab: a switch knob (24 px or less), or a control drawn inverted in dark on purpose (`dark:bg-white`, or a
            // selected chip or tab up to 140×64 px whose own ink reads at 4.5:1 on it).
            const control = el.matches('button, a, [role="tab"]') && r.width <= 140 && r.height <= 64
                && ratio(over(rgba(cs.color), bg), bg) >= 4.5;
            const inverted = control || /(^|\s)dark:bg-white(\s|$)/.test(el.getAttribute('class') || '');
            if (bg.a >= 0.9 && r.width >= 20 && r.height >= 20 && lum(bg) > 0.5 && !inverted && (r.width > 24 || r.height > 24)) {
                slabs.push({ el: describe(el), text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50), bg: hex(bg), size: `${Math.round(r.width)}×${Math.round(r.height)}` });
            }
        }
    }
    const low = (list) => list.filter((x) => x.ratio < x.need - 0.005);
    return {
        counted: { text: text.length, placeholders: placeholders.length, fields: fields.length, icons: icons.length },
        text: low(text), placeholders: low(placeholders), fields: low(fields), icons: low(icons), slabs,
    };
}

/**
 * A fill that changes on hover: `hover:bg-emerald-500` beat `dark:bg-emerald-700` (the dark variant is the weaker selector),
 * white words on 2.5:1. Hover the controls that carry both a dark fill and a hover fill; their words must still read at AA.
 */
async function hoverStops(page) {
    const found = [];
    const seen = [];
    const targets = page.locator('button[class*="hover:bg-"][class*="dark:bg-"], a[class*="hover:bg-"][class*="dark:bg-"]');
    const n = Math.min(await targets.count(), 60); // every such control on the screen (8 missed the event cards' Going/Interested)
    let hovered = 0;
    for (let i = 0; i < n; i++) {
        const el = targets.nth(i);
        if (!(await el.isVisible().catch(() => false)) || await el.isDisabled().catch(() => true)) continue;
        if (!(await el.hover({ timeout: 2_000 }).then(() => true).catch(() => false))) continue;
        await wait(250);
        hovered++;
        const r = await el.evaluate((node) => {
            const cvs = document.createElement('canvas');
            cvs.width = cvs.height = 1;
            const ctx = cvs.getContext('2d', { willReadFrequently: true });
            const rgba = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
            const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
            const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
            const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
            const layers = [];
            for (let e = node; e; e = e.parentElement) { const bg = rgba(getComputedStyle(e).backgroundColor); if (bg.a > 0) { layers.push(bg); if (bg.a >= 0.999) break; } }
            const behind = layers.reduceRight((acc, l) => over(l, acc), { r: 255, g: 255, b: 255, a: 1 });
            const cs = getComputedStyle(node);
            const fg = over(rgba(cs.color), behind);
            const size = parseFloat(cs.fontSize);
            const words = /[\p{L}\p{N}]/u.test(node.innerText || '');
            const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
            return { el: node.tagName.toLowerCase(), text: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40), ratio: ratio(fg, behind), fg: hex(fg), bg: hex(behind),
                need: !words || size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700) ? 3 : 4.5 }; // a glyph alone is an icon: 3:1
        });
        if (r.text) seen.push(`${r.ratio.toFixed(2)}:1 ${r.fg} on ${r.bg} "${r.text}"`);
        if (r.text && r.ratio < r.need - 0.005) found.push(r);
    }
    await page.mouse.move(0, 0);
    return { hovered, found, seen };
}

/** Tab through the first stops; each must draw an outline or ring of 3:1 against what is behind it. */
async function focusStops(page) {
    const found = [];
    await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
    const seen = new Set();
    for (let i = 0; i < FOCUS_STOPS; i++) {
        await page.keyboard.press('Tab');
        await wait(300); // a `transition-all` control eases its ring in from currentColor
        const r = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const cs = getComputedStyle(el);
            const cvs = document.createElement('canvas');
            cvs.width = cvs.height = 1;
            const ctx = cvs.getContext('2d', { willReadFrequently: true });
            const rgba = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
            const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
            const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
            // What the ring is drawn over: every layer behind it composited, translucent strips included.
            const layers = [];
            for (let n = el.parentElement; n; n = n.parentElement) { const bg = rgba(getComputedStyle(n).backgroundColor); if (bg.a > 0) { layers.push(bg); if (bg.a >= 0.999) break; } }
            const behind = layers.reduceRight((acc, l) => ({ r: l.r * l.a + acc.r * (1 - l.a), g: l.g * l.a + acc.g * (1 - l.a), b: l.b * l.a + acc.b * (1 - l.a), a: 1 }), { r: 255, g: 255, b: 255, a: 1 });
            const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? rgba(cs.outlineColor) : null;
            const ringColours = (cs.boxShadow && cs.boxShadow !== 'none') ? (cs.boxShadow.match(/(rgba?|oklch|color)\([^)]*\)/g) || []).map(rgba).filter((c) => c.a > 0.3) : [];
            const best = Math.max(0, outline ? ratio(outline, behind) : 0, ...ringColours.map((c) => ratio(c, behind)));
            const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 40);
            const id = el.getAttribute('data-testid');
            const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
            return { key: `${el.tagName}|${label}|${id}`, el: `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''}`, fg: outline ? hex(outline) : '', bg: hex(behind), text: label, ratio: best, need: 3, how: outline ? 'outline' : ringColours.length ? 'ring' : 'none' };
        });
        if (!r || seen.has(r.key)) continue;
        seen.add(r.key);
        if (r.ratio < 3) found.push(r);
    }
    await page.keyboard.press('Escape').catch(() => {});
    return found;
}

// ---------- the screens ----------

/** Each: the profile it is on, who is signed in ('member' | null), how to reach it from a fresh landing. `check`: in the regression set. */
const SCREENS = [
    { name: 'local-welcome', profile: 'local', who: null, check: true },
    { name: 'local-welcome-restore', profile: 'local', who: null, go: clickRole('button', /restore|12 words|already have/i) },
    { name: 'global-lobby', profile: 'global', who: null, check: true },
    { name: 'global-lobby-market', profile: 'global', who: null, check: true, go: lobbyTab('Market') },
    { name: 'global-lobby-map', profile: 'global', who: null, check: true, go: lobbyTab('Map') },
    { name: 'member-home', profile: 'local', who: 'member', check: true, ready: (p) => p.getByTestId('home-card-community').waitFor({ timeout: 30_000 }) },
    { name: 'member-home-edit', profile: 'local', who: 'member', go: clickTestId('home-edit-open') },
    { name: 'member-home-add-card', profile: 'local', who: 'member', go: clickTestId('home-add-open') },
    { name: 'member-market', profile: 'local', who: 'member', check: true, go: tab('Market') },
    { name: 'member-market-listing', profile: 'local', who: 'member', go: steps(tab('Market'), clickText('Sourdough loaves')) },
    { name: 'member-market-new', profile: 'local', who: 'member', go: steps(tab('Market'), clickRole('button', /new (post|listing)|^\+|post an offer|create/i)) },
    { name: 'member-map', profile: 'local', who: 'member', go: tab('Map') },
    { name: 'member-map-new-post', profile: 'local', who: 'member', check: true, go: steps(tab('Map'), clickRole('button', /new post/i)) },
    { name: 'member-commons', profile: 'local', who: 'member', check: true, go: tab('Commons') },
    { name: 'member-commons-new-group', profile: 'local', who: 'member', go: steps(tab('Commons'), clickRole('button', /new group|create group|start a group/i)) },
    { name: 'member-chat', profile: 'local', who: 'member', check: true, go: tab('Chat') },
    { name: 'member-chat-dm', profile: 'local', who: 'member', go: steps(tab('Chat'), clickText('Kofi')) },
    { name: 'member-people', profile: 'local', who: 'member', check: true, go: tab('People') },
    { name: 'member-people-profile', profile: 'local', who: 'member', check: true, go: steps(tab('People'), clickRole('tab', /community/i), clickText('Kofi')) },
    { name: 'member-ledger', profile: 'local', who: 'member', check: true, go: tab('Ledger') },
    { name: 'member-settings', profile: 'local', who: 'member', check: true, go: clickRole('button', 'Settings') },
    { name: 'member-settings-account', profile: 'local', who: 'member', go: steps(clickRole('button', 'Settings'), clickText('⚠️ Account Deletion & Sign Out')) },
    { name: 'member-invite', profile: 'local', who: 'member', check: true, go: steps(tab('People'), clickRole('tab', /invites/i)) },
    { name: 'global-member-home', profile: 'global', who: 'member', check: true, ready: (p) => p.getByTestId('home-card-community').waitFor({ timeout: 30_000 }) },
    { name: 'global-member-market', profile: 'global', who: 'member', go: tab('Market') },
    { name: 'global-member-people', profile: 'global', who: 'member', go: tab('People') },
    { name: 'global-member-settings', profile: 'global', who: 'member', go: clickRole('button', 'Settings') },
];

const fmt = (x) => `${x.ratio.toFixed(2)}:1 < ${x.need} ${x.fg ?? ''} on ${x.bg ?? ''} ${x.el} "${x.text}"${x.disabled ? ' (disabled)' : ''}`;

async function main() {
    const only = process.env.DARK_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
    const screens = SCREENS.filter((s) => (only?.length ? only.includes(s.name) : SWEEP || THEME === 'light' || s.check));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-dark-check-'));
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const results = [];
    const failures = [];
    let browser;
    const nodes = {};
    try {
        await build({ root: BUILD_FROM, configFile: path.join(BUILD_FROM, 'vite.config.ts'), logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
        browser = await chromium.launch();
        const member = memberIdentity('Ana');
        for (const profile of ['local', 'global']) {
            if (!screens.some((s) => s.profile === profile)) continue;
            nodes[profile] = await startNode(root, profile, [{ publicKey: member.publicKey, callsign: 'Ana', joinedDaysAgo: 1 }]);
        }
        console.log(`The web app as built (${BUILD_FROM === PWA_DIR ? 'this checkout' : BUILD_FROM}); Chromium at 320 px, 1.3x text, ${THEME} mode.`);
        for (const s of screens) {
            const node = nodes[s.profile];
            // One member lands ~20 times: the gateway and sign-in limiters start again for each screen, as for a fresh visit.
            await node.ask({ op: 'resetLimits' });
            const { context, page } = await openContext(browser, node.origin, s.who ? member : null);
            const r = { name: s.name, reached: true };
            try {
                await land(page, node.origin);
                if (s.ready) await s.ready(page).catch(() => {});
                if (s.go) await s.go(page);
                await page.evaluate(() => document.fonts?.ready);
                await wait(400);
                await page.screenshot({ path: path.join(SHOTS_DIR, `${s.name}.png`) });
                if (THEME === 'dark') {
                    Object.assign(r, await page.evaluate(measure, THEME === 'dark'));
                    r.focus = await focusStops(page);
                    r.hover = await hoverStops(page);
                }
            } catch (e) {
                r.reached = false;
                r.error = String(e?.message || e).split('\n')[0];
            } finally {
                await context.close();
            }
            results.push(r);
            if (THEME !== 'dark') { console.log(`  ${r.reached ? '📸' : '✗'} ${s.name}${r.error ? ` — ${r.error}` : ''}`); continue; }
            if (!r.reached) { console.log(`  ✗ ${s.name}: not reached — ${r.error}`); if (!SWEEP) failures.push(`${s.name}: not reached`); continue; }
            const bad = [...r.text.filter((x) => !x.disabled), ...r.placeholders.filter((x) => !x.disabled), ...r.fields.filter((x) => !x.disabled), ...r.icons.filter((x) => !x.disabled)];
            const n = bad.length + r.slabs.length + r.focus.length + r.hover.found.length;
            console.log(`  ${n ? '✗' : '✓'} ${s.name}: ${r.counted.text} texts, ${r.counted.placeholders} placeholders, ${r.counted.fields} fields, ${r.counted.icons} icons measured, ${r.hover.hovered} hovered; ${n ? `${n} below` : 'all at AA'}`);
            for (const x of r.text) console.log(`      text ${fmt(x)}`);
            for (const x of r.placeholders) console.log(`      placeholder ${fmt(x)}`);
            for (const x of r.fields) console.log(`      field edge ${fmt(x)}`);
            for (const x of r.icons) console.log(`      icon ${fmt(x)}`);
            for (const x of r.slabs) console.log(`      light slab ${x.bg} ${x.size} ${x.el} "${x.text}"`);
            for (const x of r.hover.found) console.log(`      hover ${fmt(x)}`);
            for (const x of r.focus) console.log(`      focus ${x.how} ${x.ratio.toFixed(2)}:1 ${x.fg} on ${x.bg} ${x.el} "${x.text}"`);
            if (!SWEEP && n) failures.push(`${s.name}: ${n} below`);
        }
    } finally {
        await browser?.close();
        for (const n of Object.values(nodes)) {
            const blocked = n.log.filter((l) => l.startsWith('BLOCKED-'));
            if (blocked.length) failures.push(`a node reached outside this machine: ${blocked.join('; ')}`);
            await n.stop();
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(SHOTS_DIR, 'results.json'), JSON.stringify(results, null, 1));
    console.log(`\nScreenshots and results.json: ${SHOTS_DIR}`);
    if (failures.length) {
        console.error(`\n❌ ${failures.length} screen(s) below AA in dark:\n  ${failures.join('\n  ')}`);
        process.exit(1);
    }
    console.log(SWEEP || THEME === 'light' ? '\nDone.' : '\n⭐️ Every checked screen reads at AA in dark mode at 320 px with 1.3x text.');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
