/**
 * The web's credit surfaces (DESIGN-credit-list-fable.md test 14, with amendments 1 and 2; credit on the People list C5) in a
 * real Chromium layout: the list (Rob, Jane, a frozen row, Sam after the gift, a −437.13 row), the Give credit sheet, the profile
 * card, the Vouchers chip (running low and asked), Ask for more in its states and the log of looks. At 320 px with 1.3x text in
 * each of the app's three looks (Classic, Light, Dark) and at 1280 × 800 in Light. For each shot it MEASURES: nothing runs off
 * sideways; no credit sentence is cut ("…", text-overflow, a line clamp); every button, link and switch is at least 44 px tall
 * (the Give credit button 48). It writes the pictures (at most 900 px wide) and prints a table. Exits non-zero on a failed check.
 *
 * Nothing here touches a BeanPool node: every /api request is answered below, and any other /api or /ws request is aborted.
 *
 *   node e2e/credit-list-shots.mjs [shots-dir]
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 */
/* global process, console, document, window, getComputedStyle */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PWA_DIR, 'e2e', 'shots');

// The three looks as the stored value spells them (lib/useTheme.ts): dark = Classic, light = Light, night = Dark.
const LOOKS = [{ name: 'classic', stored: 'dark' }, { name: 'light', stored: 'light' }, { name: 'dark', stored: 'night' }];
const VIEWPORTS = [{ w: 320, h: 760, scale: 1.3, looks: LOOKS }, { w: 1280, h: 800, scale: 1, looks: [LOOKS[1]] }];

const K = (c) => c.repeat(64);
const ROB = K('1'), JANE = K('2'), FAY = K('4'), SAM = K('3'), VAL = K('5');
const NOT_KNOWN = { level: 'not_known', more: false, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] };
const LOW = { level: 'low', more: false, reasons: [{ code: 'confirmed', level: 'low', mark: 'admins', values: {} }] };
const GIFT = { owed: 90000, line: 100000, pct: 50, gift: 90000, giftDays: 30 };
const SAM_FULL = { level: 'high', more: false, reasons: [
    { code: 'almost_all_quiet', level: 'high', mark: 'admins', values: { owed: 90000, line: 100000, days: 60, gift: 90000, giftDays: 30 } },
    { code: 'over_half', level: 'medium', mark: 'giver', values: GIFT },
] };
const SAM_VOUCHER = { level: 'high', more: true, reasons: [{ code: 'over_half', level: 'medium', mark: 'giver', values: GIFT }] };
const VAL_RISK = { level: 'medium', more: false, reasons: [{ code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 43713, line: 80000, pct: 50 } }] };

function person(sight, over) {
    const base = {
        status: 'active', own: false, line_c: 0, usable_c: 0, liveOffers: 0, balance_c: 0, owed_c: 0, over_c: 0, paused: false, canGive: true, risk: NOT_KNOWN, ...over,
    };
    if (sight === 'voucher') return base;
    return {
        ...base,
        parts: { known_c: 0, room_c: 0, earned_c: 0, granted_c: 0, cap_c: 200000, ...(over.parts ?? {}) },
        standsBehind: over.standsBehind ?? { confirmedBy: null, vouchedBy: [] },
        frozen: over.frozen ?? { credit: false, known: false },
    };
}
const people = (sight) => [
    person(sight, { memberPubkey: ROB, callsign: 'Rob', liveOffers: 4 }),
    person(sight, {
        memberPubkey: JANE, callsign: 'Jane', line_c: 130000, usable_c: 130000, liveOffers: 1, balance_c: -42000, owed_c: 42000, risk: sight === 'voucher' ? { ...LOW, reasons: [], more: true, level: 'low' } : LOW,
        parts: { known_c: 100000, room_c: 20000, earned_c: 10000 },
        standsBehind: { confirmedBy: { memberPubkey: K('9'), callsign: 'marty', at: '2026-11-01T00:00:00Z' }, vouchedBy: [{ memberPubkey: K('a'), callsign: 'marty', amount_c: 10000 }, { memberPubkey: K('b'), callsign: 'olive', amount_c: 10000 }] },
        ...(sight === 'voucher' ? {} : { voucherBudget: { noLimit: false, left_c: 15000, held_c: 5000, level_c: 100000, setLevel_c: 100000, runningLow: true, nothingLeft: false, askedAt: '2026-11-12T01:00:00.000Z' } }),
    }),
    person(sight, {
        memberPubkey: FAY, callsign: 'Fay', line_c: 100000, usable_c: 0, liveOffers: 0, canGive: false,
        risk: sight === 'voucher' ? { level: 'high', more: true, reasons: [] } : { level: 'high', more: false, reasons: [{ code: 'frozen', level: 'high', mark: 'admins', values: {} }] },
        frozen: { credit: true, known: false },
    }),
    person(sight, { memberPubkey: SAM, callsign: 'Sam', line_c: 100000, usable_c: 100000, liveOffers: 0, risk: sight === 'voucher' ? SAM_VOUCHER : SAM_FULL }),
    person(sight, { memberPubkey: VAL, callsign: 'Val', line_c: 80000, usable_c: 80000, liveOffers: 2, balance_c: -43713, owed_c: 43713, risk: VAL_RISK }),
];
const VOUCHER_ROWS = [
    { memberPubkey: JANE, callsign: 'Jane', left: 15000, held: 5000, heldInvites: 1, vouched: 80000, peopleVouched: 9, level: 100000, belowZero: 2, writtenOff: 0, setLevel_c: 100000, runningLow: true, nothingLeft: false, askedAt: '2026-11-12T01:00:00.000Z', topUpTo_c: 100000, topUpBlocked: null },
    { memberPubkey: K('6'), callsign: 'Olive', left: 90000, held: 0, heldInvites: 0, vouched: 10000, peopleVouched: 1, level: 100000, belowZero: 0, writtenOff: 0, setLevel_c: 100000, runningLow: false, nothingLeft: false, askedAt: null, topUpTo_c: 100000, topUpBlocked: null },
    { memberPubkey: K('7'), callsign: 'Bo', left: 1000, held: 0, heldInvites: 0, vouched: 99000, peopleVouched: 12, level: 100000, belowZero: 3, writtenOff: 5000, setLevel_c: 100000, runningLow: true, nothingLeft: true, askedAt: null, topUpTo_c: null, topUpBlocked: 'frozen' },
    { memberPubkey: K('8'), callsign: 'Marty', noLimit: true, left: 0, held: 0, heldInvites: 0, vouched: 0, peopleVouched: 0, level: 0, belowZero: 0, writtenOff: 0, setLevel_c: null, runningLow: false, nothingLeft: false, askedAt: null, topUpTo_c: null, topUpBlocked: 'no_limit' },
];
const LOOKS_GROUPS = [
    { actorPubkey: K('2'), callsign: 'jane', day: '2026-11-12', sight: 'voucher', people: 30 },
    { actorPubkey: K('8'), callsign: 'marty', day: '2026-11-11', sight: 'owner', people: 1 },
];
const SAM_LOOKS = [
    { actorPubkey: K('2'), actorCallsign: 'jane', subjectPubkey: SAM, subjectCallsign: 'Sam', surface: 'list', sight: 'voucher', day: '2026-11-12', at: '2026-11-12T01:00:00Z' },
    { actorPubkey: K('8'), actorCallsign: 'marty', subjectPubkey: SAM, subjectCallsign: 'Sam', surface: 'card', sight: 'owner', day: '2026-11-11', at: '2026-11-11T01:00:00Z' },
];

const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
function answer(url, state) {
    const u = new URL(url);
    const sight = state.role === 'voucher' ? 'voucher' : 'owner';
    if (u.pathname === '/api/node-admin/me') return state.role === 'voucher' ? json(403, { error: 'Not an admin.' }) : json(200, { role: 'owner', communityName: 'Mullumbimby' });
    if (u.pathname === '/api/vouchers/me') {
        return json(200, state.role === 'voucher'
            ? { voucher: true, presets: [2500, 5000, 7500, 10000], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], budget: { left: 15000, held: 0, heldInvites: 0, vouched: 85000, peopleVouched: 9, level: 100000 }, ask: { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null } }
            : { voucher: true, noLimit: true, presets: [2500, 5000, 7500, 10000, 20000, 50000], vouchMax: 50000, budgetMax: 200000, vouchedBy: [], budget: { left: 0, held: 0, heldInvites: 0, vouched: 0, peopleVouched: 0, level: 0 }, ask: null });
    }
    if (u.pathname === '/api/community/known-rule') return json(200, { knownFloor: 100000, debtLinePct: 50, quietDays: 60, debtLineFrom: null, quietDaysFrom: null, creditSight: true });
    if (u.pathname === '/api/credit/people' && u.searchParams.get('filter') === 'vouchers') return state.role === 'owner' ? json(200, { sight: 'owner', filter: 'vouchers', vouchers: VOUCHER_ROWS, next: null }) : json(403, { error: 'Only an owner or an admin on the credit committee makes vouchers and sets their budgets.', code: 'committee_only' });
    if (u.pathname === '/api/credit/people') return json(200, { sight, told: 'x', people: people(sight), next: null });
    if (u.pathname.startsWith('/api/credit/people/')) {
        const pk = u.pathname.split('/').pop();
        const p = people(sight).find((x) => x.memberPubkey === pk);
        return p ? json(200, { sight, told: 'x', person: p }) : json(404, { error: 'Nobody here by that key.', code: 'not_listed' });
    }
    if (u.pathname === '/api/credit/looks') return json(200, u.searchParams.get('member') ? { looks: SAM_LOOKS } : { groups: LOOKS_GROUPS });
    return null;
}

/** Runs in the page: sideways scroll, cut text, and small targets. */
const MEASURE = () => {
    const visible = (el) => el.getClientRects().length > 0;
    const targets = [...document.querySelectorAll('button, a, input[type=checkbox], summary')].filter(visible);
    const small = targets
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        // The switch is a native checkbox inside a 44 px label; the label is the target.
        .filter(({ el, box }) => (el.type === 'checkbox' ? el.closest('label').getBoundingClientRect().height : box.height) < 44)
        .map(({ el, box }) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(box.height)}px`);
    const cut = [...document.querySelectorAll('[data-testid=credit-sentence], [data-testid=credit-balance], [data-testid=credit-risk-reasons], [data-testid=voucher-line]')]
        .filter((el) => /…/.test(el.textContent || '') || ['ellipsis'].includes(getComputedStyle(el).textOverflow) || getComputedStyle(el).webkitLineClamp !== 'none')
        .map((el) => (el.textContent || '').slice(0, 40));
    const give = [...document.querySelectorAll('[data-testid=credit-give]')].map((b) => Math.round(b.getBoundingClientRect().height)).filter((h) => h < 48);
    return { sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth, small, cut, give };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
const rows = [];
const SCREENS = [
    { name: 'list-owner', view: 'list', role: 'owner', ready: '[data-testid=credit-list]' },
    { name: 'list-voucher', view: 'list', role: 'voucher', ready: '[data-testid=credit-list]' },
    { name: 'sheet-rob', view: 'list', role: 'voucher', ready: '[data-testid=credit-list]', act: async (page) => { await page.click('[data-testid=credit-give]'); await page.waitForSelector('[data-testid=give-credit-sheet]'); }, sheet: true },
    { name: 'sheet-jane-owner', view: 'list', role: 'owner', ready: '[data-testid=credit-list]', act: async (page) => { await page.locator('[data-testid=credit-row][data-pubkey="' + JANE + '"] [data-testid=credit-give]').click(); await page.waitForSelector('[data-testid=give-credit-sheet]'); }, sheet: true },
    { name: 'vouchers', view: 'vouchers', role: 'owner', ready: '[data-testid=voucher-row]' },
    { name: 'card-owner', view: 'card', role: 'owner', ready: '[data-testid=credit-looked-at-by]' },
    { name: 'card-voucher', view: 'card', role: 'voucher', ready: '[data-testid=credit-card]' },
    { name: 'ask', view: 'ask', role: 'owner', ready: '[data-testid=ask-for-more]' },
    { name: 'looks', view: 'looks', role: 'owner', ready: '[data-testid=credit-looks-toggle]', act: async (page) => { await page.click('[data-testid=credit-looks-toggle]'); await page.waitForSelector('[data-testid=credit-looks-groups]'); } },
];
try {
    for (const vp of VIEWPORTS) {
        for (const look of vp.looks) {
            for (const s of SCREENS) {
                const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: look.stored === 'light' ? 'light' : 'dark' });
                const state = { role: s.role };
                await context.route('**/*', (route) => {
                    const req = route.request();
                    if (req.url().includes('/api/')) {
                        const a = answer(req.url(), state);
                        return a ? route.fulfill(a) : route.abort();
                    }
                    if (req.url().startsWith('ws')) return route.abort();
                    return route.continue();
                });
                const page = await context.newPage();
                await page.addInitScript(([stored, scale]) => {
                    try { localStorage.setItem('beanpool-theme-mode', stored); } catch { /* private mode */ }
                    document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${scale * 100}%`; });
                }, [look.stored, vp.scale]);
                await page.goto(`${base}/e2e/credit-list-harness.html?view=${s.view}&role=${s.role}`, { waitUntil: 'load' });
                await page.waitForSelector(s.ready, { timeout: 30_000 });
                if (s.act) await s.act(page);
                await page.waitForTimeout(300);
                const m = await page.evaluate(MEASURE);
                const name = `credit-${s.name}-${vp.w}-${look.name}`;
                const width = Math.min(vp.w, 900);
                // A long page is taken in pieces of at most 900 px, so each picture can be looked at whole.
                const total = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, window.innerHeight));
                const pieces = s.sheet ? 1 : Math.ceil(total / 900);
                for (let i = 0; i < pieces; i++) {
                    const y = i * 900;
                    if (s.sheet) await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), clip: { x: 0, y: 0, width, height: Math.min(vp.h, 900) } });
                    else await page.screenshot({ path: path.join(OUT_DIR, pieces === 1 ? `${name}.png` : `${name}-${i + 1}.png`), fullPage: true, clip: { x: 0, y, width, height: Math.min(900, total - y) } });
                }
                if (m.sideways) failures.push(`${name}: runs off sideways`);
                if (m.small.length) failures.push(`${name}: under 44 px: ${m.small.join('; ')}`);
                if (m.cut.length) failures.push(`${name}: a credit sentence is cut: ${m.cut.join('; ')}`);
                if (m.give.length) failures.push(`${name}: Give credit under 48 px: ${m.give.join(', ')}`);
                rows.push(`| ${s.name} | ${vp.w} × ${vp.scale} | ${look.name} | ${m.sideways ? '✗' : '✓'} | ${m.cut.length ? '✗' : '✓'} | ${m.small.length ? m.small.join('; ') : '✓'} | ${pieces === 1 ? `${name}.png` : `${name}-1..${pieces}.png`} |`);
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log('| screen | viewport | look | no sideways scroll | nothing cut | 44 px targets | shot |\n|---|---|---|---|---|---|---|');
console.log(rows.join('\n'));
if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
}
