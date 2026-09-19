/**
 * Serves node Settings (single-node /settings) locally with every /api request answered from fixtures.mjs, and
 * opens it in headless Chromium at a chosen width and text size. Nothing here talks to a real node.
 *
 * Used by phone-width.mjs (the automated check) and screenshots.mjs (the PR's pictures).
 */
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockResponse, UNKNOWN } from './fixtures.mjs';

const MANAGER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Tailwind reads its config from the working directory, so the build only works from apps/manager.
process.chdir(MANAGER_DIR);

/**
 * The text font is forced to DejaVu Sans (bundled in e2e/fonts, OFL), which is as wide as Verdana: wider than
 * Android's Roboto and much wider than Apple's system font. Without this the check measured whatever font the
 * machine had, passed on a Mac and failed in CI. A row that fits in DejaVu fits on a phone. Monospace is left alone.
 */
export const HARNESS_FONT = 'BeanpoolHarnessWide';
const FONT_DIR = path.join(MANAGER_DIR, 'e2e', 'fonts');
const FONT_FILES = { 400: 'dejavu-sans-latin-400-normal.woff2', 700: 'dejavu-sans-latin-700-normal.woff2' };
const FONT_CSS = `
${Object.entries(FONT_FILES).map(([weight, file]) => `@font-face { font-family: '${HARNESS_FONT}'; font-weight: ${weight}; font-style: normal; src: url('/__harness/fonts/${file}') format('woff2'); }`).join('\n')}
html, body, body *:not(code):not(pre):not(kbd):not(samp):not(.font-mono) { font-family: '${HARNESS_FONT}' !important; }
`;

/**
 * Every screen in single-node Settings: a section tab, and the sub-tab inside it. `sub` matches the section's own
 * `setSubTab('…')` ids (and SCREEN_HELP in src/lib/manual.ts).
 */
export const SCREENS = [
    { tab: 'home' },
    { tab: 'people', sub: 'directory' },
    { tab: 'people', sub: 'invites' },
    { tab: 'people', sub: 'moderation' },
    { tab: 'people', sub: 'roles' },
    { tab: 'economy', sub: 'enterprises' },
    { tab: 'economy', sub: 'decisions' },
    { tab: 'economy', sub: 'pool' },
    { tab: 'economy', sub: 'disputes' },
    { tab: 'bulletin', sub: 'announcements' },
    { tab: 'bulletin', sub: 'pulse' },
    { tab: 'appliance', sub: 'diagnostics' },
    { tab: 'appliance', sub: 'backups' },
    { tab: 'appliance', sub: 'gateway' },
    { tab: 'appliance', sub: 'network' },
    { tab: 'appliance', sub: 'identity' },
    { tab: 'appliance', sub: 'access' },
];

const LEGACY_SUB_TAB_LABELS = {
    directory: /^Members \(/, invites: /^Invites & QR$/, moderation: /^Triage & Moderation/, roles: /^Owners & admins$/,
    enterprises: /^Enterprises \(/, decisions: /^Proposals$/, pool: /^Commons Pool$/, disputes: /Escrow Disputes/,
    announcements: /^Announcements$/, pulse: /^Pulse Channels/,
    diagnostics: /^Diagnostics & Logs$/, backups: /^Backups & Restore$/, gateway: /^Gateway & Peers$/,
    network: /^Public Address$/, identity: /^Node Identity$/, access: /^Access & Security$/,
};

export function screenName(s) {
    return s.sub ? `${s.tab}-${s.sub}` : s.tab;
}

/**
 * Android's "font size" setting scales text, not layout. Chromium on a desktop has no such switch, so this
 * approximates it: the root font size goes to 130% (every rem-based size in Tailwind scales, including some
 * padding, which is harsher than a phone), and the arbitrary pixel sizes the app uses are scaled the same.
 */
const TEXT_SCALE_CSS = (scale) => `
html { font-size: ${scale * 100}% !important; }
${[8, 9, 10, 11, 12, 13, 14, 15, 16].map(px => `.text-\\[${px}px\\] { font-size: ${px * scale}px !important; }`).join('\n')}
`;

/**
 * A production build of Settings (what a node serves), in a temp folder, served by Vite's preview server.
 * Not the dev server: that one runs @beanpool/core from source, which reads `process` and fails in a browser.
 */
export async function startServer() {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-settings-'));
    const config = { root: MANAGER_DIR, configFile: path.join(MANAGER_DIR, 'vite.config.ts'), logLevel: 'error' };
    await build({ ...config, build: { outDir, emptyOutDir: true } });
    const server = await preview({ ...config, build: { outDir }, preview: { port: Number(process.env.SETTINGS_HARNESS_PORT || 0), host: '127.0.0.1', strictPort: false, proxy: {} } });
    const addr = server.httpServer.address();
    return {
        server: { close: async () => { await server.close(); fs.rmSync(outDir, { recursive: true, force: true }); } },
        origin: `http://127.0.0.1:${addr.port}`,
    };
}

export async function launch() {
    return chromium.launch();
}

/**
 * A fresh page on Settings, signed in with a (mocked) admin password, opened on `screen`.
 * `hash` lets a caller open the key sign-in hand-off link instead (e.g. '#handoff=…&section=disputes').
 */
export async function openSettings(browser, origin, { width, height = 800, textScale = 1, screen = { tab: 'home' }, hash = '', signedIn = true, systemFont = false }) {
    const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        isMobile: width < 600,
        hasTouch: width < 600,
        colorScheme: 'dark',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // Nothing leaves this machine: map tiles, avatars and anything else off the local server are refused.
    await context.route((url) => url.hostname !== '127.0.0.1', (route) => route.abort());
    await context.route(/\/__harness\/fonts\//, (route) => {
        const file = path.basename(new URL(route.request().url()).pathname);
        route.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(path.join(FONT_DIR, file)) });
    });
    await page.route(/\/(api|proxy)\//, async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        // The app's one-time sign-in link: any well-formed token is accepted here, as an owner.
        const { status, json } = url.pathname === '/api/local/admin/auth/exchange'
            ? { status: 200, json: { role: 'owner', memberPubkey: 'f'.repeat(64), csrfToken: 'fixture-csrf' } }
            : mockResponse(req.method(), url.pathname, url.searchParams, req.postData() || '');
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    });
    await page.addInitScript(({ tab, signedIn, css }) => {
        try {
            if (signedIn) sessionStorage.setItem('bp-admin-token', 'fixture-password');
            localStorage.setItem('bp_settings_active_tab', tab);
            // Home would otherwise open the first-run wizard on a node with no members.
            localStorage.setItem('bp_cold_start_completed', 'true');
        } catch {}
        if (css) {
            const add = () => {
                const style = document.createElement('style');
                style.setAttribute('data-harness', 'text-scale');
                style.textContent = css;
                document.head.appendChild(style);
            };
            if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
        }
    }, { tab: screen.tab, signedIn, css: (systemFont ? '' : FONT_CSS) + (textScale !== 1 ? TEXT_SCALE_CSS(textScale) : '') });

    await page.goto(`${origin}/settings/${hash}`);
    if (signedIn) {
        await page.waitForSelector('main', { timeout: 20000 });
        if (screen.sub) await selectSubTab(page, screen.sub);
        await settle(page);
    } else {
        await settle(page);
    }
    if (!systemFont) {
        // A missing font file would quietly fall back to the system font and bring back the Mac-only pass.
        const loaded = await page.evaluate(async (family) => {
            await document.fonts.ready;
            return [...document.fonts].some(f => f.family.replace(/["']/g, '') === family && f.status === 'loaded')
                && getComputedStyle(document.body).fontFamily.includes(family);
        }, HARNESS_FONT);
        if (!loaded) throw new Error(`harness font ${HARNESS_FONT} did not load (e2e/fonts)`);
    }
    return { context, page, errors };
}

/** Sub-tab buttons carry data-subtab; on a phone they are in a strip that scrolls inside itself. */
export async function selectSubTab(page, sub) {
    let btn = page.locator(`main [data-subtab="${sub}"]`).first();
    if (!(await btn.count())) {
        // A build from before sub-tabs were tagged (to compare against main): find the button by its label.
        btn = page.locator('main button').filter({ hasText: LEGACY_SUB_TAB_LABELS[sub] }).first();
    }
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
}

export async function settle(page) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    await page.waitForTimeout(400);
}

/** How far the page itself scrolls sideways, and which elements stick out past the right edge. */
export async function horizontalOverflow(page) {
    return page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        const culprits = [];
        if (sw > vw) {
            for (const el of document.querySelectorAll('body *')) {
                const r = el.getBoundingClientRect();
                if (r.right > vw + 0.5 && r.width > 0) {
                    // Skip anything inside a box that clips or scrolls it: it does not widen the page.
                    let clipped = false;
                    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                        const o = getComputedStyle(p).overflowX;
                        if (o !== 'visible') { clipped = true; break; }
                    }
                    if (!clipped) {
                        const cls = typeof el.className === 'string' ? el.className.slice(0, 90) : '';
                        culprits.push(`<${el.tagName.toLowerCase()} class="${cls}"> right=${Math.round(r.right)} text="${(el.textContent || '').trim().slice(0, 40)}"`);
                    }
                }
            }
        }
        return { viewport: vw, scrollWidth: sw, culprits: culprits.slice(0, 8) };
    });
}

/**
 * How far a box (e.g. the phone menu's panel) scrolls sideways inside itself, and whether each of the given buttons
 * inside it sits wholly within the box. The page-level check cannot see this: a panel that clips or scrolls its own
 * overflow never widens the page.
 */
export async function boxOverflow(locator, buttonSelector = 'button') {
    return locator.evaluate((box, sel) => {
        const b = box.getBoundingClientRect();
        const outside = [];
        for (const el of box.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            if (r.left < b.left - 0.5 || r.right > b.right + 0.5) {
                outside.push(`<${el.tagName.toLowerCase()} aria-label="${el.getAttribute('aria-label') || ''}"> ${Math.round(r.left)}–${Math.round(r.right)} outside ${Math.round(b.left)}–${Math.round(b.right)} "${(el.textContent || '').trim().slice(0, 30)}"`);
            }
        }
        return { clientWidth: box.clientWidth, scrollWidth: box.scrollWidth, outside: outside.slice(0, 8) };
    }, buttonSelector);
}

export { UNKNOWN };
