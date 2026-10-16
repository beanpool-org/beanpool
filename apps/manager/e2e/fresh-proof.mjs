#!/usr/bin/env node
/**
 * An owner's fresh proof in the real Settings (owner-delete S4a; opus-2028's at-press measurements made checks). The node
 * API is answered from fixtures.mjs, with the one refusal under test routed on top: nothing here talks to a real node.
 *
 *  1. At the press (opus-2028 B1): Claim, connector add, the re-key wizard and offboard put the box far from the button
 *     pressed. Right after the press, with NO scrolling by this script, the box's top is on screen, the point at the
 *     centre of what shows is inside the box (not under a modal), and focus is in it. 320 @130% and 1280, for the
 *     phone's stale hand-off (the sentence) and the password's code (the field).
 *  2. The second Manage press (opus-2028 B3): a stale refusal, then a NEW `#handoff=` link reaching the open page (as an
 *     Android Custom Tab brought back to the front does). The re-key wizard is still open and still ticked, offboard is
 *     still open, the gateway still holds the owner's edit, and the same press then goes through with what was entered.
 *  3. A spent code is never offered again (opus-2028 B4): after an accepted code, the next box on the same screen opens
 *     empty with Confirm off; Cancel empties it too.
 *  4. Member detail's Grant Admin (opus-2028 B2): the box opens in the member's screen and the code re-sends the grant.
 *  5. "Save Gateway Config" keeps its words inside its button at 320 @130% (opus-2028 N1).
 *
 *   node e2e/fresh-proof.mjs
 *
 * Needs Chromium for Playwright once: `pnpm --filter @beanpool/manager exec playwright install --only-shell chromium`.
 */
/* global console, process, document, window, URL -- Node, plus page.evaluate callbacks run in the browser */
import { startServer, launch, openSettings, selectSubTab, settle, CSP_VIOLATIONS } from './harness.mjs';

const STALE = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to do this', totpRequired: true };
const failures = [];
let checks = 0;

function check(ok, label, detail = '') {
    checks++;
    if (ok) console.log(`  ✓ ${label}`);
    else {
        failures.push(`${label}${detail ? `: ${detail}` : ''}`);
        console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
    }
}

const topOverlay = (page) => page.locator('.fixed.inset-0').last();
/** A person's press: they scroll to the button, then press it. Nothing scrolls after. */
async function press(page, name, scope) {
    const b = (scope || page).getByRole('button', { name }).first();
    await b.waitFor({ state: 'attached', timeout: 10000 });
    await b.scrollIntoViewIfNeeded();
    await b.click();
}
async function inspectFirst(page) {
    await press(page, /^Inspect$/);
    await settle(page);
}
async function rekeyReady(page) {
    await inspectFirst(page);
    await press(page, /Re-Key$/, topOverlay(page));
    await settle(page);
    const modal = topOverlay(page);
    const boxes = modal.locator('input[type="checkbox"]');
    for (let i = 0; i < await boxes.count(); i++) { await boxes.nth(i).scrollIntoViewIfNeeded(); await boxes.nth(i).check(); }
    const again = modal.locator('input[type="text"]').first();
    if (await again.count()) await again.fill('NEW CODE');
}
async function offboardReady(page) {
    await inspectFirst(page);
    await press(page, /Offboard$/, topOverlay(page));
    await settle(page);
}

const FLOWS = [
    { name: 'Claim', screen: { tab: 'appliance', sub: 'network' }, testId: 'address-proof',
        overrides: { '/api/local/admin/public-address/status': () => ({ status: 'none' }) },
        refuses: (p, m) => m === 'POST' && p === '/api/local/admin/public-address/claim',
        press: async (page) => {
            const f = page.locator('form input[type="text"], form input:not([type])').first();
            await f.scrollIntoViewIfNeeded();
            await f.fill('cairns');
            const submit = page.locator('form button[type="submit"]').first();
            await submit.scrollIntoViewIfNeeded();
            await submit.click();
        } },
    { name: 'Connector add', screen: { tab: 'appliance', sub: 'gateway' }, testId: 'connector-proof',
        refuses: (p, m) => m === 'POST' && p === '/api/local/connectors',
        press: async (page) => {
            const f = page.locator('#new-connector-addr');
            await f.scrollIntoViewIfNeeded();
            await f.fill('https://peer.example.org');
            await press(page, /^Add Peer$/);
        } },
    { name: 'Re-key wizard, Make a re-key code', screen: { tab: 'people', sub: 'directory' }, testId: 'rekey-proof',
        refuses: (p, m) => m === 'POST' && /\/rekey\/issue-code$/.test(p),
        press: async (page) => { await rekeyReady(page); await press(page, /Make a re-key code/, topOverlay(page)); } },
    { name: 'Offboard, Confirm & Prune', screen: { tab: 'people', sub: 'directory' }, testId: 'offboard-proof',
        refuses: (p, m) => m === 'POST' && /\/members\/[^/]+\/offboard$/.test(p),
        press: async (page) => { await offboardReady(page); await press(page, /Confirm & Prune Member/, topOverlay(page)); } },
    { name: 'Member detail, Grant Admin', screen: { tab: 'people', sub: 'directory' }, testId: 'member-role-proof',
        refuses: (p, m) => m === 'POST' && p === '/api/local/admin/node-roles',
        press: async (page) => { await inspectFirst(page); await press(page, /Grant Admin$/, topOverlay(page)); } },
];
const SIZES = [{ width: 320, textScale: 1.3, label: '320 @130%' }, { width: 1280, textScale: 1, label: '1280' }];
const KINDS = [{ kind: 'step-up', status: 403, json: STALE }, { kind: 'code', status: 401, json: ASK }];

/** Where the box is right after the press, with no scrolling: on screen, on top, focused. */
function atPress(testId) {
    const el = document.querySelector(`[data-testid="${testId}-step-up"], [data-testid="${testId}-code"]`);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    const visTop = Math.max(0, r.top), visBot = Math.min(vh, r.bottom);
    let hitInside = false;
    if (visBot > visTop) {
        const hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, (r.left + r.right) / 2)), (visTop + visBot) / 2);
        hitInside = Boolean(hit && el.contains(hit));
    }
    return { found: true, top: Math.round(r.top), bottom: Math.round(r.bottom), vh, hitInside, focusInside: el.contains(document.activeElement) };
}

/** Answer the flow's request with the refusal (the code kind: refuse the first, let the re-send through). */
async function refuse(page, flow, k, sent) {
    await page.route(/\/(api|proxy)\//, async (route) => {
        const req = route.request();
        const p = new URL(req.url()).pathname;
        if (!flow.refuses(p, req.method())) return route.fallback();
        let body = null;
        try { body = JSON.parse(req.postData() || 'null'); } catch { body = null; }
        sent.push({ body, proof: req.headers()['x-fresh-proof'] ?? null });
        if (k.kind === 'code' && sent.length > 1) return route.fallback();
        await route.fulfill({ status: k.status, contentType: 'application/json', body: JSON.stringify(k.json) });
    });
}

/** The phone's Manage hand-off, opened on a screen: a key session (the stale-hand-off refusal is that viewer's). */
async function asPhone(browser, origin, screen) {
    const o = await openSettings(browser, origin, { width: 360, signedIn: false, hash: `#handoff=${'cd'.repeat(16)}`, screen: { tab: screen.tab } });
    await o.page.waitForSelector('main', { timeout: 20000 });
    await settle(o.page);
    await selectSubTab(o.page, screen.sub);
    await settle(o.page);
    return o;
}
/** The second Manage press: a new link reaches the page already open. */
async function manageAgain(page) {
    await page.evaluate(() => { window.location.hash = `#handoff=${'ef'.repeat(16)}`; });
    await page.waitForTimeout(800);
    await settle(page);
}

const { server, origin } = await startServer();
const browser = await launch();
try {
    console.log('1. The box at the press, no scrolling (opus-2028 B1)');
    for (const flow of FLOWS) for (const size of SIZES) for (const k of KINDS) {
        const at = `${flow.name}, ${k.kind}, ${size.label}`;
        const { context, page, errors } = await openSettings(browser, origin, { width: size.width, height: 800, textScale: size.textScale, screen: flow.screen, overrides: flow.overrides || {} });
        const sent = [];
        try {
            await refuse(page, flow, k, sent);
            await flow.press(page);
            await page.locator(`[data-testid="${flow.testId}-${k.kind}"]`).waitFor({ state: 'attached', timeout: 8000 });
            await page.waitForTimeout(300);
            const m = await page.evaluate(atPress, flow.testId);
            check(m.found && m.top >= 0 && m.top < m.vh && m.hitInside && m.focusInside, `${at}: on screen at the press, on top, focused`, JSON.stringify(m));
            if (k.kind === 'code') {
                await page.locator(`[data-testid="${flow.testId}-input"]`).fill('123456');
                await page.locator(`[data-testid="${flow.testId}-confirm"]`).click();
                await settle(page);
                const codes = sent.map((s) => s.body?.code ?? s.proof ?? null);
                check(codes.length === 2 && codes[0] === null && codes[1] === '123456', `${at}: the same request re-sent once, with the code`, JSON.stringify(codes));
            }
            check(errors.length === 0, `${at}: no page errors`, errors.join('; '));
        } catch (e) {
            check(false, at, String(e).split('\n')[0]);
        }
        await context.close();
    }

    console.log('2. The second Manage press keeps what was entered (opus-2028 B3)');
    {
        const { context, page } = await asPhone(browser, origin, { tab: 'people', sub: 'directory' });
        let issues = 0;
        await page.route(/\/rekey\/issue-code$/, (route) => (++issues === 1
            ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(STALE) }) : route.fallback()));
        try {
            await rekeyReady(page);
            const ticked = await topOverlay(page).locator('input[type="checkbox"]').count();
            await press(page, /Make a re-key code/, topOverlay(page));
            await page.locator('[data-testid="rekey-proof-step-up"]').waitFor({ state: 'attached', timeout: 8000 });
            const overlays = await page.locator('.fixed.inset-0').count();
            await manageAgain(page);
            const after = await page.evaluate(() => ({
                overlays: document.querySelectorAll('.fixed.inset-0').length,
                checked: [...document.querySelectorAll('.fixed.inset-0 input[type="checkbox"]')].map((c) => c.checked),
                hash: window.location.hash,
            }));
            check(after.overlays === overlays && after.checked.length === ticked && after.checked.every(Boolean),
                're-key: the wizard is still open and still ticked after Manage again', JSON.stringify({ overlays, ticked, after }));
            check(after.hash === '', 're-key: the new link is out of the address bar', after.hash);
            await press(page, /Make a re-key code/, topOverlay(page));
            await settle(page);
            check(issues === 2 && await page.locator('[data-testid="rekey-proof-step-up"]').count() === 0,
                're-key: the same press then goes through', `issue-code requests: ${issues}`);
        } catch (e) {
            check(false, 're-key across two Manage presses', String(e).split('\n')[0]);
        }
        await context.close();
    }
    {
        const { context, page } = await asPhone(browser, origin, { tab: 'people', sub: 'directory' });
        const sent = [];
        await page.route(/\/members\/[^/]+\/offboard$/, (route) => {
            sent.push(route.request().postData());
            return sent.length === 1 ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(STALE) }) : route.fallback();
        });
        try {
            await offboardReady(page);
            await press(page, /Confirm & Prune Member/, topOverlay(page));
            await page.locator('[data-testid="offboard-proof-step-up"]').waitFor({ state: 'attached', timeout: 8000 });
            const overlays = await page.locator('.fixed.inset-0').count();
            await manageAgain(page);
            const now = await page.locator('.fixed.inset-0').count();
            check(now === overlays && await page.getByRole('button', { name: /Confirm & Prune Member/ }).count() === 1,
                'offboard: the wizard is still open after Manage again', `overlays ${overlays} → ${now}`);
            await press(page, /Confirm & Prune Member/, topOverlay(page));
            await settle(page);
            check(sent.length === 2 && sent[1] === sent[0], 'offboard: the same press then sends the same offboard', JSON.stringify(sent));
        } catch (e) {
            check(false, 'offboard across two Manage presses', String(e).split('\n')[0]);
        }
        await context.close();
    }
    {
        const { context, page } = await asPhone(browser, origin, { tab: 'appliance', sub: 'gateway' });
        const bodies = [];
        await page.route(/\/api\/local\/admin\/gateway$/, (route) => {
            if (route.request().method() !== 'POST') return route.fallback();
            const body = route.request().postData();
            bodies.push(body);
            return bodies.length === 1
                ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(STALE) })
                : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, gateway: JSON.parse(body) }) });
        });
        try {
            const field = page.locator('main input[type="number"]').first();
            await field.scrollIntoViewIfNeeded();
            const original = await field.inputValue();
            const edited = String(Number(original || '0') + 7);
            await field.fill(edited);
            await press(page, /Save Gateway Config/);
            await page.locator('[data-testid="gateway-proof-step-up"]').waitFor({ state: 'attached', timeout: 8000 });
            await manageAgain(page);
            const now = await page.locator('main input[type="number"]').first().inputValue();
            check(now === edited, 'gateway: the unsaved edit is still in the form after Manage again', `node had ${original}, typed ${edited}, now ${now}`);
            await press(page, /Save Gateway Config/);
            await settle(page);
            const leaves = (v) => (v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [String(v)]);
            const sentValues = bodies[1] ? leaves(JSON.parse(bodies[1])) : [];
            check(bodies.length === 2 && sentValues.includes(edited) && !sentValues.includes(original), 'gateway: the next Save sends the edit, not the node\'s old value', JSON.stringify(bodies[1] ?? null));
        } catch (e) {
            check(false, 'gateway across two Manage presses', String(e).split('\n')[0]);
        }
        await context.close();
    }

    console.log('3. A spent code is never offered again (opus-2028 B4)');
    {
        const { context, page } = await openSettings(browser, origin, { width: 1280, screen: { tab: 'people', sub: 'roles' } });
        const proofs = [];
        await page.route(/\/api\/local\/admin\/node-roles\/[^/]+\/[^/]+$/, (route) => {
            if (route.request().method() !== 'DELETE') return route.fallback();
            const proof = route.request().headers()['x-fresh-proof'] ?? null;
            proofs.push(proof);
            return proof ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' })
                : route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(ASK) });
        });
        const removeAdmin = async () => {
            await press(page, /Remove .*'s admin role/);
            await press(page, 'Yes, remove admin');
            await page.locator('[data-testid="roles-proof-input"]').waitFor({ state: 'visible', timeout: 8000 });
        };
        try {
            await removeAdmin();
            await page.locator('[data-testid="roles-proof-input"]').fill('654321');
            await page.locator('[data-testid="roles-proof-confirm"]').click();
            await settle(page);
            await removeAdmin();
            const value = await page.locator('[data-testid="roles-proof-input"]').inputValue();
            const enabled = await page.locator('[data-testid="roles-proof-confirm"]').isEnabled();
            check(value === '' && !enabled, 'Owners & admins: the second box opens empty, Confirm off', JSON.stringify({ value, enabled }));
            check(proofs.filter((p) => p === '654321').length === 1, 'Owners & admins: the accepted code was sent once', JSON.stringify(proofs));
        } catch (e) {
            check(false, 'Owners & admins, two removals', String(e).split('\n')[0]);
        }
        await context.close();
    }
    {
        const { context, page } = await openSettings(browser, origin, { width: 1280, screen: { tab: 'appliance', sub: 'gateway' } });
        await page.route(/\/api\/local\/admin\/gateway$/, (route) => (route.request().method() !== 'POST' ? route.fallback()
            : route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(ASK) })));
        try {
            await press(page, /Save Gateway Config/);
            await page.locator('[data-testid="gateway-proof-input"]').fill('111222');
            await page.locator('[data-testid="gateway-proof-cancel"]').click();
            await press(page, /Save Gateway Config/);
            await page.locator('[data-testid="gateway-proof-input"]').waitFor({ state: 'visible', timeout: 8000 });
            const value = await page.locator('[data-testid="gateway-proof-input"]').inputValue();
            check(value === '', 'gateway: after Cancel the box reopens empty', JSON.stringify(value));
        } catch (e) {
            check(false, 'gateway, Cancel then Save', String(e).split('\n')[0]);
        }
        await context.close();
    }

    console.log('4. "Save Gateway Config" inside its button at 320 @130% (opus-2028 N1)');
    {
        const { context, page } = await openSettings(browser, origin, { width: 320, textScale: 1.3, screen: { tab: 'appliance', sub: 'gateway' } });
        try {
            const btn = page.getByRole('button', { name: /Save Gateway Config/ }).first();
            await btn.scrollIntoViewIfNeeded();
            const m = await btn.evaluate((b) => {
                const r = b.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(b);
                const t = range.getBoundingClientRect();
                let card = b.parentElement;
                while (card && !/rounded-2xl/.test(card.className)) card = card.parentElement;
                const c = card ? card.getBoundingClientRect() : r;
                return { button: [Math.round(r.left), Math.round(r.right)], text: [Math.round(t.left), Math.round(t.right)], card: [Math.round(c.left), Math.round(c.right)] };
            });
            check(m.text[0] >= m.button[0] && m.text[1] <= m.button[1] && m.button[1] <= m.card[1], 'the label stays inside its button and the card', JSON.stringify(m));
        } catch (e) {
            check(false, 'Save Gateway Config at 320 @130%', String(e).split('\n')[0]);
        }
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}

check(CSP_VIOLATIONS.length === 0, 'no page broke the node\'s content policy', JSON.stringify(CSP_VIOLATIONS.slice(0, 3)));
console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
    console.log(`\n${failures.length} failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
