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
    { tab: 'people', sub: 'funnel' },
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
    directory: /^Members \(/, invites: /^Invites & QR$/, funnel: /^Onboarding Funnel$/, moderation: /^Triage & Moderation/, roles: /^Owners & admins$/,
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
 * `overrides` maps an API path to a function that edits the fixture's reply.
 * `handoffRole` is the role the hand-off link signs in as ('moderator' opens the moderator's Reports screen).
 */
export async function openSettings(browser, origin, { width, height = 800, textScale = 1, screen = { tab: 'home' }, hash = '', signedIn = true, systemFont = false, overrides = {}, handoffRole = 'owner' }) {
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
        // The app's one-time sign-in link: any well-formed token is accepted here, as an owner (or `handoffRole`).
        let { status, json } = url.pathname === '/api/local/admin/auth/exchange'
            ? { status: 200, json: { role: handoffRole, memberPubkey: 'f'.repeat(64), csrfToken: 'fixture-csrf' } }
            : mockResponse(req.method(), url.pathname, url.searchParams, req.postData() || '');
        // A screen that shows only on some nodes (e.g. a primary rather than a standby): `overrides[path]` edits the reply.
        if (overrides[url.pathname]) json = overrides[url.pathname](json);
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
export async function boxOverflow(locator, buttonSelector = 'button', { skipScrollers = false } = {}) {
    return locator.evaluate((box, [sel, skipScrollers]) => {
        const b = box.getBoundingClientRect();
        const outside = [];
        for (const el of box.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            // A control inside a box of its own that scrolls sideways (a wide table, a QR grid) can be scrolled to.
            if (skipScrollers) {
                let scroller = false;
                for (let p = el.parentElement; p && p !== box; p = p.parentElement) {
                    if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) { scroller = true; break; }
                }
                if (scroller) continue;
            }
            if (r.left < b.left - 0.5 || r.right > b.right + 0.5) {
                outside.push(`<${el.tagName.toLowerCase()} aria-label="${el.getAttribute('aria-label') || ''}"> ${Math.round(r.left)}–${Math.round(r.right)} outside ${Math.round(b.left)}–${Math.round(b.right)} "${(el.textContent || '').trim().slice(0, 30)}"`);
            }
        }
        return { clientWidth: box.clientWidth, scrollWidth: box.scrollWidth, outside: outside.slice(0, 8) };
    }, [buttonSelector, skipScrollers]);
}

/**
 * Every modal and wizard single-node Settings can open (each `fixed inset-0` overlay in src/components, except the
 * phone menu and the full-screen manual, which phone-width.mjs checks on their own). `steps` are the buttons to press,
 * in order: `in: 'main'` is the page, `in: 'modal'` the modal already open on top. The fleet manager's own modals
 * (add/edit node, the TOTP prompt, topology history) run only on the Mac manager and are not reachable here.
 */
export const ALL_MODALS = [
    { name: 'member-detail', screen: { tab: 'people', sub: 'directory' }, steps: [{ in: 'main', button: /^Inspect$/ }] },
    { name: 'member-rekey', screen: { tab: 'people', sub: 'directory' }, steps: [{ in: 'main', button: /^Inspect$/ }, { in: 'modal', button: /Re-Key$/ }] },
    { name: 'member-offboard', screen: { tab: 'people', sub: 'directory' }, steps: [{ in: 'main', button: /^Inspect$/ }, { in: 'modal', button: /Offboard$/ }] },
    { name: 'member-prune-branch', screen: { tab: 'people', sub: 'directory' }, steps: [{ in: 'main', button: /^Inspect$/ }, { in: 'modal', button: /Prune Branch$/ }] },
    { name: 'member-tier', screen: { tab: 'people', sub: 'directory' }, steps: [{ in: 'main', title: 'Click to upgrade or edit member standing tier' }] },
    { name: 'create-treasury', screen: { tab: 'people', sub: 'directory' }, steps: [{ in: 'main', button: /Create Treasury/ }] },
    { name: 'treasury-offer', screen: { tab: 'people', sub: 'directory' }, steps: [{ in: 'main', button: /\+ Post Offer/ }] },
    { name: 'invite-print-sheet', screen: { tab: 'people', sub: 'invites' }, steps: [{ in: 'main', button: /^Generate \d+ Pass/ }, { in: 'main', button: /View Printable Sheet/ }] },
    { name: 'invite-qr', screen: { tab: 'people', sub: 'invites' }, steps: [{ in: 'main', button: /^Generate \d+ Pass/ }, { in: 'main', button: /^Enlarge$/ }] },
    { name: 'report-review', screen: { tab: 'people', sub: 'moderation' }, steps: [{ in: 'main', button: /Inspect & Action/ }] },
    { name: 'delete-post', screen: { tab: 'people', sub: 'moderation' }, steps: [{ in: 'main', button: /^Delete post / }] },
    { name: 'create-enterprise', screen: { tab: 'economy', sub: 'enterprises' }, steps: [{ in: 'main', button: /Create Enterprise/ }] },
    { name: 'keepers', screen: { tab: 'economy', sub: 'enterprises' }, steps: [{ in: 'main', button: /^Keepers$/ }] },
    { name: 'seed-offer', screen: { tab: 'economy', sub: 'enterprises' }, steps: [{ in: 'main', button: /^Seed Offer$/ }] },
    { name: 'halt-decision', screen: { tab: 'economy', sub: 'decisions' }, steps: [{ in: 'main', button: /Halt this Decision/ }] },
    { name: 'resolve-dispute', screen: { tab: 'economy', sub: 'disputes' }, steps: [{ in: 'main', button: /Split 50 \/ 50/ }] },
    { name: 'add-pulse-channel', screen: { tab: 'bulletin', sub: 'pulse' }, steps: [{ in: 'main', button: /Add Feed Channel/ }] },
    { name: 'clean-storage', screen: { tab: 'appliance', sub: 'diagnostics' }, steps: [{ in: 'main', button: /Clean Orphaned Media/ }] },
    { name: 'standby-resync', screen: { tab: 'appliance', sub: 'backups' }, steps: [{ in: 'main', button: /Force Full Resync/ }] },
    { name: 'remove-peer', screen: { tab: 'appliance', sub: 'gateway' }, steps: [{ in: 'main', button: /^Remove$/ }] },
    { name: 'reset-tunnel', screen: { tab: 'appliance', sub: 'network' }, steps: [{ in: 'main', button: /Reset Tunnel/ }] },
    { name: 'take-offline', screen: { tab: 'appliance', sub: 'network' }, steps: [{ in: 'main', button: /Take offline/ }] },
    { name: 'generate-replication-token', screen: { tab: 'appliance', sub: 'backups' }, overrides: { '/api/local/admin/backup-status': (json) => ({ ...json, role: 'primary' }) }, steps: [{ in: 'main', button: /Generate \/ rotate token/ }] },
    { name: 'takeover-explain', screen: { tab: 'appliance', sub: 'backups' }, steps: [{ in: 'main', button: /^Take over as the main server$/ }] },
    { name: 'takeover-code', screen: { tab: 'appliance', sub: 'backups' }, steps: [{ in: 'main', button: /^Take over as the main server$/ }, { in: 'modal', button: /I understand, continue/ }] },
    { name: 'takeover-preview', screen: { tab: 'appliance', sub: 'backups' }, steps: [
        { in: 'main', button: /^Take over as the main server$/ }, { in: 'modal', button: /I understand, continue/ },
        { in: 'modal', fill: '#takeover-code', value: 'BPRC-2 0000-0000-0000-0000-0000-0000-0000' }, { in: 'modal', button: /^Open the keys$/ },
    ] },
    { name: 'remove-replication-token', screen: { tab: 'appliance', sub: 'backups' }, overrides: { '/api/local/admin/backup-status': (json) => ({ ...json, role: 'primary' }) }, steps: [{ in: 'main', button: /^Remove Token$/ }] },
    // The recovery code (sealed keys). The code is shown once, so its card `holdsOpen`: the backdrop, Escape and Back
    // must NOT close it (only its ✕ and Done do). phone-width.mjs checks the opposite of the usual for these.
    { name: 'recovery-code-replace', screen: { tab: 'appliance', sub: 'backups' }, overrides: { '/api/local/admin/backup-status': (json) => ({ ...json, role: 'primary' }) }, steps: [{ in: 'main', button: /^Replace it$/ }] },
    { name: 'recovery-code-shown', screen: { tab: 'appliance', sub: 'backups' }, holdsOpen: true, overrides: { '/api/local/admin/backup-status': (json) => ({ ...json, role: 'primary' }) }, steps: [{ in: 'main', button: /^Replace it$/ }, { in: 'modal', button: /^Make a new code$/ }] },
    { name: 'recovery-code-print', screen: { tab: 'appliance', sub: 'backups' }, overrides: { '/api/local/admin/backup-status': (json) => ({ ...json, role: 'primary' }) }, steps: [{ in: 'main', button: /^Replace it$/ }, { in: 'modal', button: /^Make a new code$/ }, { in: 'modal', button: /Print$/ }] },
    { name: 'recovery-code-check', screen: { tab: 'appliance', sub: 'backups' }, overrides: { '/api/local/admin/backup-status': (json) => ({ ...json, role: 'primary' }) }, steps: [{ in: 'main', button: /^Check a code$/ }] },
];

/** The topmost open modal overlay, and its card (the overlay's first child). */
export function topModal(page) {
    const overlay = page.locator('.fixed.inset-0').last();
    return { overlay, card: overlay.locator(':scope > div').first() };
}

/**
 * Wait, up to 10 s, for a step's button or field to be on the page and visible. It may render only once the step
 * before it has finished, which settle() does not wait for: Generate asks the node for each of its 5 passes in turn,
 * and View Printable Sheet and Enlarge appear after the last answer. On a busy runner that took longer than settle's
 * pause, and invite-print-sheet failed on main (8a4266a8). The caller still checks that the target is there.
 */
async function appeared(target) {
    await target.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
}

/**
 * Open a modal from ALL_MODALS on a page already showing its screen. The buttons are pressed with a DOM click, so a
 * button that a broken layout pushed out of sight still opens the next step (the check then reports the layout).
 * Returns the number of overlays open afterwards, or throws naming the step that could not be found.
 */
export async function openModal(page, modal) {
    for (const step of modal.steps) {
        const scope = step.in === 'modal' ? topModal(page).card : page.locator('main');
        if (step.fill) {
            // A field the next button needs (it stays disabled while empty), typed as a person would.
            const field = scope.locator(step.fill).first();
            await appeared(field);
            if (!(await field.count())) throw new Error(`${modal.name}: no field ${step.fill} in ${step.in}`);
            await field.fill(step.value);
            await settle(page);
            continue;
        }
        const target = step.title
            ? scope.locator(`button[title="${step.title}"]`).first()
            : scope.getByRole('button', { name: step.button }).first();
        await appeared(target);
        if (!(await target.count())) throw new Error(`${modal.name}: no button ${step.title || step.button} in ${step.in}`);
        await target.evaluate((el) => el.click());
        await settle(page);
    }
    return page.locator('.fixed.inset-0').count();
}

/**
 * The control that closes the top modal: its ✕ (or a button labelled Close), else its Cancel button for a
 * confirmation that has no ✕.
 */
export async function closeControl(card) {
    const x = card.locator('button:text-is("✕"), button:text-is("×"), button[aria-label^="Close" i]').first();
    if (await x.count()) return x;
    const cancel = card.getByRole('button', { name: /^(Cancel|Close|Keep)\b/ }).first();
    return (await cancel.count()) ? cancel : null;
}

export { UNKNOWN };
