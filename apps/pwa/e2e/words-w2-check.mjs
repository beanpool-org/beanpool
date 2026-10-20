/**
 * Words sweep W2 at 320 px with 1.3× text (translation slice S3; director amendment 1 item 7): the enterprise page (a
 * keeper's busy week, a project raising Beans, a member asking to join), its card, its votes and its map-pin picker; the
 * Ledger (Levels and the Wallet) and the credit bar; the Commons, its Decisions, proposing one, polls and the Commons
 * guide; People, a group, starting one and the quiet-lead vote. Each opened on its own (e2e/words-w2-harness.tsx) in
 * English and in the pseudo-locale `xx`, where every sentence that came through t() is ~35 % longer, as the longer
 * languages are.
 *
 * The same measure as sweep W1's (e2e/words-w1-check.mjs). For each screen it lists, in each language:
 *   - the page scrolling sideways;
 *   - any element with words in it reaching past either edge of the screen (outside a box that scrolls sideways);
 *   - words clipped by their own box (overflow hidden or clip, and more text than fits; an ellipsis counts).
 * It FAILS on what xx shows and English does not: words a longer language pushes off the screen or cuts. What English
 * shows too (a member's long title cut with an ellipsis, by design) is listed, not failed.
 *
 * Builds the harness with Vite into a temp folder; every /api request is answered here, every other host refused (an
 * /api path with no answer is listed, so a screen drawn without its data is seen). Nothing here talks to a node.
 *
 * Run: node e2e/words-w2-check.mjs [shots-dir]
 *   WORDS_W2_ONLY=ledger,enterprise   only these screens
 *   WORDS_W2_LANGS=en,xx,de           these languages (default en,xx)
 *   DEBUG_W2=1                        when a page scrolls sideways, print every element past the edge and what clips it
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global Buffer, URL, console, process, document, window, localStorage, getComputedStyle, Node, NodeFilter -- Node, and the page's side of evaluate() */
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDENTITY, mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-words-w2');
const only = (env) => (process.env[env] ? process.env[env].split(',').map((x) => x.trim()) : null);
const LANGS = only('WORDS_W2_LANGS') ?? ['en', 'xx'];
/** Each screen, and what to press once it is drawn (a selector's first match), before measuring. */
const SCREENS = [
    { name: 'enterprise' },
    { name: 'enterprise-confirm', screen: 'enterprise', press: ['button:has-text("⚠️")'] },
    { name: 'enterprise-post', screen: 'enterprise', press: ['button:has-text("🏷️")'] },
    { name: 'enterprise-project' },
    { name: 'enterprise-member' },
    { name: 'enterprise-cards' },
    { name: 'enterprise-decisions' },
    { name: 'location-picker' },
    { name: 'ledger' },
    { name: 'ledger-wallet', press: ['button:has-text("💸")'] },
    { name: 'credit-bar' },
    { name: 'commons' },
    { name: 'commons-decide' },
    { name: 'decide' },
    { name: 'commons-info' },
    { name: 'propose' },
    { name: 'polls' },
    { name: 'people' },
    { name: 'people-community' },
    { name: 'group' },
    { name: 'create-group' },
    { name: 'group-succession' },
].filter((s) => !only('WORDS_W2_ONLY') || only('WORDS_W2_ONLY').includes(s.name));

/** Android's font size scales text, not layout: the root to 130 %, and the cards' pixel sizes with it (harness.mjs). */
const TEXT_SCALE_CSS = (scale) => `
html { font-size: ${scale * 100}% !important; }
${[8, 9, 10, 11, 12, 13, 14, 15, 16].map((px) => `.text-\\[${px}px\\] { font-size: ${px * scale}px !important; }`).join('\n')}
`;

// ── What the node answers ───────────────────────────────────────────────────────────────────────────────────────
const ME = IDENTITY.publicKey;
const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const KEEPERS = [
    { publicKey: 'lead-alice', callsign: 'Alice', role: 'lead', backing: 0 },
    { publicKey: ME, callsign: 'Bob', role: 'keeper', backing: 20 },
    { publicKey: 'keeper-cara', callsign: 'Cara', role: 'keeper', backing: 0, suspended: true },
];
const INACTIVITY = { leadPubkey: 'lead-alice', leadCallsign: 'Alice', daysInactive: 40, isEligible: true, autoPromoted: false };
const BUSY = {
    publicKey: 'ent-busy', name: 'Bindarrabi Community Eggs', purpose: 'Eggs for the street, from the hens at the hall.', status: 'active', paused: false,
    lifecycle: 'ongoing', balance: -12.5, creditLine: 200, liveOffers: 2, earnedSurplus: 30, workingCapitalCeiling: null,
    deferredClaims: [{ id: 'c1', status: 'pending', amount: 8 }],
    pendingBids: [{ id: 'bid-1', post_title: 'Clean the coop', credits: 10, peer_callsign: 'Dan' }],
    activeDeals: [
        { id: 'deal-1', post_id: 'p1', post_title: 'Egg delivery', credits: 6, action_required: 'fulfill', peer_callsign: 'Eve' },
        { id: 'deal-2', post_id: 'p3', post_title: 'Fix the fence', credits: 15, action_required: 'release', peer_callsign: null, price_type: 'fixed' },
    ],
    keepers: KEEPERS, isLeadOrSoleKeeperOrAdmin: true,
    keeperRequests: [
        { id: 'req-1', enterprisePubkey: 'ent-busy', memberPubkey: 'member-dan', callsign: 'Dan', pledgedBacking: 5, status: 'pending', createdAt: iso(-DAY), canBackPledge: false },
        { id: 'req-2', enterprisePubkey: 'ent-busy', memberPubkey: 'member-fay', callsign: 'Fay', pledgedBacking: 0, status: 'pending', createdAt: iso(-DAY), canBackPledge: true, pendingChange: { appliesAt: iso(2 * DAY + 60_000) } },
    ],
    keeperChanges: [{ id: 'chg-1', enterprisePubkey: 'ent-busy', kind: 'add', memberPubkey: 'member-gus', memberCallsign: 'Gus', requestId: 'req-0', pledgedBacking: 4,
        proposedBy: 'lead-alice', proposedByCallsign: 'Alice', status: 'pending', createdAt: iso(-DAY), appliesAt: iso(2 * DAY + 60_000), resolvedAt: null, resolvedBy: null }],
    leadInactivity: INACTIVITY,
    succession: { inactivity: INACTIVITY, proposals: [{ id: 'prop-1', enterprisePubkey: 'ent-busy', leadPubkey: 'lead-alice', candidatePubkey: 'keeper-cara', candidateCallsign: 'Cara',
        status: 'active', votesCount: 1, noVotesCount: 0, requiredVotes: 2, totalEligible: 2, deadlineAt: iso(13 * DAY + 60_000), votes: [] }] },
    posts: [
        { id: 'p1', type: 'offer', title: 'Dozen eggs', description: 'Free range, collected this morning', credits: 6, price_type: 'hourly', repeatable: true },
        { id: 'p2', type: 'need', title: 'Coop cleaning', credits: 10 },
    ],
    flow: [{ id: 'f1', memo: 'Egg sale', amount: 6, incoming: true, timestamp: iso(-2 * DAY) }, { id: 'f2', memo: '', amount: 2, incoming: false, timestamp: iso(-DAY) }],
    lat: -28.55, lng: 153.5,
};
const ROOF = {
    ...BUSY, publicKey: 'prj-roof', name: 'New Roof', purpose: 'A roof for the hall', lifecycle: 'bounded', balance: 120, goalAmount: 500, currentAmount: 120,
    deadlineAt: iso(5 * DAY), availableToBack: 30, isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [], leadInactivity: null, succession: null,
    pendingBids: [], activeDeals: [], keepers: KEEPERS.slice(0, 2),
};
const LEDGER = {
    enterprise: { publicKey: 'ent-busy', name: 'Bindarrabi Community Eggs', status: 'active', paused: false, balance: -12.5 },
    period: { since: null, until: null },
    summary: { totalIncome: 120, totalSpend: 40, netChange: 78, startingBalance: -90.5, endingBalance: -12.5, transactionCount: 2 },
    entries: [
        { id: 'e1', timestamp: iso(-3 * DAY), direction: 'income', amount: 120, fee: 2, netAmount: 118, counterparty: 'member-dan', counterpartyName: 'Dan', memo: 'Veggie box', runningBalance: 29.5 },
        { id: 'e2', timestamp: iso(-2 * DAY), direction: 'spend', amount: 40, fee: 0, netAmount: 40, counterparty: 'member-eve', counterpartyName: '', memo: '', runningBalance: -12.5 },
    ],
};
const THREAD = {
    conversation: { id: 'ent-busy', type: 'enterprise_thread' }, readOnly: false,
    messages: [
        { id: 'm1', conversationId: 'ent-busy', authorPubkey: 'member-dan', authorCallsign: 'Dan', authorAvatar: null, ciphertext: b64('Hello keepers, the coop door sticks again'), nonce: 'plaintext-v1', type: 'text', timestamp: iso(-DAY) },
        { id: 'm2', conversationId: 'ent-busy', authorPubkey: 'member-eve', authorCallsign: 'Eve', authorAvatar: null, ciphertext: '', nonce: 'plaintext-v1', type: 'removed', metadata: JSON.stringify({ removed: true }), timestamp: iso(-DAY) },
    ],
};
const BALANCE = {
    balance: 450, floor: -1000, usableFloor: -200, liveOffers: 1, frozen: true, activated: true, earnedCredit: 300, tierCredit: 400,
    commonsBalance: 1234.5, qualifiedValue: 2500, avgRating: 4.5, reviewCount: 3, trustStats: { uniquePartners: 6 }, callsign: 'Visitor',
    tier: { name: 'Resident' }, keeperOf: ['ent-busy'],
};
const MEMBERS = [
    { publicKey: 'member-dana', callsign: 'Dana', avatarUrl: 'bundled://leaf', role: 'member', joinedAt: iso(-40 * DAY) },
    { publicKey: 'member-kofi', callsign: 'Kofi Mensah-Abernathy', avatarUrl: 'bundled://leaf', role: 'member', joinedAt: iso(-3 * DAY) },
];
const TXNS = [
    { id: 't1', from: 'member-dana', to: ME, amount: 3, taxFee: 0, memo: 'thanks for the eggs', timestamp: iso(-DAY) },
    { id: 't2', from: ME, to: 'member-dana', amount: 12.5, taxFee: 0, memo: 'for the bread', timestamp: iso(-2 * DAY) },
];
const decision = (id, over = {}) => ({
    id, authorPubkey: 'author', title: `Fix the hall roof (${id})`, description: 'The north side leaks in heavy rain.', touches: 'member', effect: 'grant_voucher',
    subject: 'subject-pk', params: null, franchise: '1m1v', status: 'open', opensAt: iso(-2 * DAY), closesAt: iso(3 * DAY), gracePeriodEndsAt: null,
    createdAt: iso(-2 * DAY), executedAt: null, executionError: null, executionReason: null, adminHaltedAt: null, adminHaltReason: null, updatedAt: iso(-DAY),
    tally: { decisionId: id, status: 'open', totalVoters: 1, electorate: 20, quorumRatio: 0.3, quorumRequired: 6, quorumMet: false, yesWeight: 1, noWeight: 0, totalWeight: 1, supportRatio: 1, thresholdRequired: 0.6, passed: false },
    myVote: null, ...over,
});
const GROUP = {
    id: 'g1', name: 'Garden Crew', slug: 'garden-crew', category: 'working_group', joinPolicy: 'request_to_join', description: 'We grow things together',
    memberCount: 4, createdBy: ME, createdAt: '2026-01-01T00:00:00.000Z', leadPubkey: ME, leadCallsign: 'Marty', viewerRole: 'convenor', viewerStatus: 'active',
};
const ROSTER = [
    { groupId: 'g1', memberPubkey: ME, callsign: 'Marty', role: 'convenor', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
    { groupId: 'g1', memberPubkey: 'pk-damo', callsign: 'Damo', role: 'convenor', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
    { groupId: 'g1', memberPubkey: 'pk-zed', callsign: 'Zed', role: 'member', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
    { groupId: 'g1', memberPubkey: 'pk-obi', callsign: 'Obi', role: 'observer', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
    { groupId: 'g1', memberPubkey: 'pk-pia', callsign: 'Pia', role: 'member', status: 'pending_approval', joinedAt: '2026-01-01T00:00:00.000Z' },
];
const SILENCE = { convenorPubkey: ME, convenorCallsign: 'Marty', lastActiveAt: iso(-45 * DAY), daysInactive: 45, isSilent: true, isEligible: true, electorate: 'convenors' };
const SUCCESSION = {
    silence: SILENCE, canPropose: false,
    proposals: [{ id: 'gp1', groupId: 'g1', convenorPubkey: ME, convenorCallsign: 'Marty', candidatePubkey: 'pk-damo', candidateCallsign: 'Damo', proposerPubkey: 'pk-damo',
        proposerCallsign: 'Damo', status: 'active', closedReason: null, createdAt: iso(-DAY), deadlineAt: iso(5 * DAY + 1_800_000), executedAt: null,
        yesCount: 1, noCount: 0, electorateSize: 3, myVote: null, canVote: true }],
};
/** The keepers' votes (core ScopedDecisionList): one open, one passed. */
const ENTERPRISE_DECISIONS = {
    canPropose: true, rollSize: 3,
    decisions: [
        { id: 'ed1', authorPubkey: 'lead-alice', title: 'Pay Bob for the coop roof', description: 'Two days on the roof in the rain.', effect: 'pay_wage', subject: ME,
            params: { amount: 20 }, status: 'open', opensAt: iso(-DAY), closesAt: iso(2 * DAY), tally: { voted: 1, roll: 3, quorumRequired: 2, thresholdRequired: 0.5 }, myVote: null, canVote: true },
        { id: 'ed2', authorPubkey: 'lead-alice', title: 'Buy a second feeder', description: '', effect: 'spend', subject: null,
            params: { amount: 35, memo: 'Feeder' }, status: 'passed', opensAt: iso(-9 * DAY), closesAt: iso(-2 * DAY), tally: { voted: 3, roll: 3, quorumRequired: 2, thresholdRequired: 0.5, yes: 3, no: 0 }, myVote: { support: true, updatedAt: iso(-5 * DAY) } },
    ],
};

const unanswered = new Set();
function answer(pathname, search) {
    if (pathname === '/api/treasury/ent-busy') return BUSY;
    if (pathname === '/api/treasury/prj-roof') return ROOF;
    if (/^\/api\/treasury\/[^/]+\/thread$/.test(pathname)) return THREAD;
    if (/^\/api\/enterprise\/[^/]+\/ledger$/.test(pathname)) return LEDGER;
    if (/^\/api\/enterprise\/[^/]+\/decisions$/.test(pathname)) return ENTERPRISE_DECISIONS;
    if (pathname.startsWith('/api/ledger/balance')) return BALANCE;
    if (pathname === '/api/ledger/transactions') return TXNS;
    if (pathname === '/api/community/members') return MEMBERS;
    if (pathname === '/api/community/me') return { mute: { muted: false, until: null }, features: null };
    if (pathname === '/api/commons/decisions') return { decisions: [decision('a'), decision('b', { touches: 'pool', effect: 'grant_enterprise', franchise: 'quadratic_trade', params: { amount: 50 } })], myPoolVoting: { hasCompletedTrade: true, voiceCredits: 16 }, canPropose: true };
    if (pathname === '/api/groups') return [GROUP];
    if (pathname === '/api/groups/g1') return GROUP;
    if (pathname === '/api/groups/g1/members') return ROSTER;
    if (pathname === '/api/groups/g1/succession') return SUCCESSION;
    if (pathname === '/api/groups/g1/decisions') return { decisions: [], roll: [], onRoll: true };
    if (pathname.startsWith('/api/friends/')) return [];
    if (pathname === '/api/commons/balance') return { balance: 1234.5 };
    if (pathname === '/api/commons/repayment') return { repayment: null };
    if (pathname === '/api/community/info') return { memberCount: 40, postCount: 4, transactionCount: 9, commonsBalance: 1234.5, profile: 'local', features: {} };
    if (pathname === '/api/members') return { members: MEMBERS, nextCursor: null };
    const fallback = mockResponse(pathname, search);
    if (fallback === undefined) unanswered.add(pathname);
    return fallback;
}

// ── In the page ─────────────────────────────────────────────────────────────────────────────────────────────────
/** What overflows and what is clipped; each with its words, and whether they came through t() (xx's marks). */
function measure(debug) {
    const W = window.innerWidth;
    const out = { scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), width: W, past: [], clipped: [] };
    const scrollsSideways = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true;
        }
        return false;
    };
    const words = (el) => (el.textContent || el.getAttribute('placeholder') || el.value || '').replace(/\s+/g, ' ').trim();
    const label = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${words(el).slice(0, 70)}"`;
    // The same element in English and in xx: its place in the page (the screens draw the same tree in every language).
    const pathOf = (el) => { const parts = []; for (let e = el; e && e !== document.body; e = e.parentElement) parts.unshift(`${e.tagName.toLowerCase()}:${[...(e.parentElement?.children ?? [])].indexOf(e)}`); return parts.join('>'); };
    for (const el of document.body.querySelectorAll('*')) {
        const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        const control = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName);
        if (!ownText && !control) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        if (el.closest('.sr-only')) continue;
        const r = el.getBoundingClientRect();
        const clips = (v) => v === 'hidden' || v === 'clip';
        // Words squeezed to nothing by their neighbours: a box with text, as tall as a line, and no width left.
        if (ownText && r.width < 1 && r.height > 0 && clips(cs.overflowX)) {
            out.clipped.push({ what: `${label(el)} squeezed to ${r.width.toFixed(1)} px wide`, key: pathOf(el), sentence: /[[\]~]/.test(words(el)) });
            continue;
        }
        if (r.width === 0 || r.height === 0) continue;
        // The words themselves, not the box: a word too long to break spills out of its box, and the box's rectangle
        // does not include the spill. A box that clips its own overflow (an ellipsis) shows no spill: its words are
        // measured as clipped below, and only the box itself can reach past the edge.
        let left = r.left;
        let right = r.right;
        if (!clips(cs.overflowX)) {
            for (const n of el.childNodes) {
                if (n.nodeType !== Node.TEXT_NODE || !n.textContent.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(n);
                for (const rr of range.getClientRects()) { left = Math.min(left, rr.left); right = Math.max(right, rr.right); }
            }
        }
        const sentence = /[[\]~]/.test(words(el));
        if ((right > W + 0.5 || left < -0.5) && !scrollsSideways(el)) out.past.push({ what: `${label(el)} spans ${Math.round(left)}–${Math.round(right)} px`, key: pathOf(el), sentence });
        if ((clips(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (clips(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && cs.webkitLineClamp === 'none')) {
            out.clipped.push({ what: `${label(el)} needs ${el.scrollWidth}×${el.scrollHeight} in ${el.clientWidth}×${el.clientHeight}`, key: pathOf(el), sentence });
        }
    }
    if (out.scrollWidth > W) {
        // What widens the page: past the edge with no ancestor that clips or scrolls it.
        const unclipped = (el) => {
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return false;
            return true;
        };
        const wide = [...document.body.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > W + 0.5 && unclipped(el));
        out.widest = wide.filter((el) => !wide.some((o) => o !== el && el.contains(o))).slice(0, 4)
            .map((el) => `${label(el)} (${typeof el.className === 'string' ? el.className.slice(0, 60) : ''}) right ${Math.round(el.getBoundingClientRect().right)} px`);
    }
    out.textLength = document.body.innerText.length;
    if (debug && out.scrollWidth > W) {
        out.debug = { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, items: [] };
        for (const el of document.body.querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (r.right <= W + 0.5) continue;
            let clip = null;
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                const cs = getComputedStyle(p);
                if (cs.overflowX !== 'visible') { clip = `${p.tagName.toLowerCase()}.${String(p.className).slice(0, 40)} ox=${cs.overflowX} right=${Math.round(p.getBoundingClientRect().right)} sw=${p.scrollWidth} cw=${p.clientWidth}`; break; }
            }
            out.debug.items.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)} pos=${getComputedStyle(el).position} clip=${clip}`);
        }
        out.debug.items = out.debug.items.slice(0, 12);
    }
    return out;
}

async function main() {
    const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-words-w2-build-'));
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    let server;
    let browser;
    const failures = [];
    const listed = [];
    try {
        await build({
            configFile: false, root: PWA_DIR, plugins: [react()], define: { __APP_VERSION__: JSON.stringify('harness') }, logLevel: 'warn',
            build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(PWA_DIR, 'e2e', 'words-w2-harness.html') } },
        });
        server = await preview({ configFile: false, root: PWA_DIR, preview: { port: 0, open: false }, build: { outDir }, logLevel: 'warn' });
        const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
        browser = await chromium.launch();
        for (const sc of SCREENS) {
            const english = { past: new Set(), clipped: new Set() };
            for (const lang of LANGS) {
                const run = `${sc.name} ${lang}`;
                const context = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce', colorScheme: 'light' });
                await context.addInitScript(() => {
                    localStorage.setItem('beanpool-theme-default-light-v1', 'done');
                    localStorage.setItem('beanpool-theme-mode', 'light');
                });
                await context.route((url) => url.origin !== origin, (route) => route.abort());
                await context.route(`${origin}/api/**`, (route) => {
                    const url = new URL(route.request().url());
                    const body = answer(url.pathname, url.search);
                    if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
                    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
                });
                await context.route(`${origin}/ws**`, (route) => route.abort());
                const page = await context.newPage();
                const errors = [];
                page.on('pageerror', (e) => errors.push(e.message));
                try {
                    await page.goto(`${origin}/e2e/words-w2-harness.html?screen=${sc.screen ?? sc.name}&lang=${lang}`, { waitUntil: 'load' });
                    await page.addStyleTag({ content: TEXT_SCALE_CSS(1.3) });
                    await page.waitForSelector('html[data-harness-ready="true"]', { timeout: 20_000 });
                    await page.waitForLoadState('networkidle').catch(() => {});
                    await page.waitForTimeout(700);
                    for (const selector of sc.press ?? []) {
                        await page.locator(selector).first().click({ timeout: 10_000 });
                        await page.waitForTimeout(400);
                    }
                    const m = await page.evaluate(measure, !!process.env.DEBUG_W2);
                    if (m.debug) console.log(JSON.stringify(m.debug, null, 1));
                    await page.screenshot({ path: path.join(SHOTS_DIR, `${sc.name}-${lang}.png`), fullPage: false });
                    if (errors.length) failures.push(`${run}: page error: ${errors[0]}`);
                    if (m.textLength < 20) failures.push(`${run}: nothing drawn (${m.textLength} characters)`);
                    const sideways = m.scrollWidth > m.width;
                    if (lang === 'en') {
                        for (const p of m.past) english.past.add(p.key);
                        for (const c of m.clipped) english.clipped.add(c.key);
                        if (sideways) listed.push(`${run}: the page scrolls sideways in English too (${m.scrollWidth}px): ${(m.widest ?? []).join('; ')}`);
                        for (const p of m.past) listed.push(`${run}: past the edge in English: ${p.what}`);
                        for (const c of m.clipped) listed.push(`${run}: clipped in English: ${c.what}`);
                    } else {
                        if (sideways) failures.push(`${run}: the page scrolls sideways (${m.scrollWidth}px in ${m.width}px): ${(m.widest ?? []).join('; ')}`);
                        for (const p of m.past) (english.past.has(p.key) ? listed : failures).push(`${run}: past the edge: ${p.what}`);
                        for (const c of m.clipped) {
                            const inEnglish = english.clipped.has(c.key);
                            (inEnglish ? listed : failures).push(`${run}: clipped${inEnglish ? ' (in English too)' : c.sentence ? '' : ' (not through t(): a member\'s words)'}: ${c.what}`);
                        }
                    }
                    console.log(`${run}: ${m.past.length} past the edge, ${m.clipped.length} clipped${sideways ? ', scrolls sideways' : ''}`);
                } catch (e) {
                    failures.push(`${run}: ${e.message}`);
                    await page.screenshot({ path: path.join(SHOTS_DIR, `${sc.name}-${lang}-error.png`) }).catch(() => {});
                }
                await context.close();
            }
        }
    } finally {
        await browser?.close();
        await new Promise((r) => (server ? server.httpServer.close(r) : r()));
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    for (const l of listed) console.log(`note ${l}`);
    if (unanswered.size) console.log(`note /api paths with no answer (a 404): ${[...unanswered].sort().join(', ')}`);
    console.log(`screenshots: ${SHOTS_DIR}`);
    if (failures.length) {
        for (const f of failures) console.log(`FAIL ${f}`);
        process.exit(1);
    }
    console.log(`words-w2-check: ok — ${SCREENS.length} screens at 320 px, 1.3× text, in ${LANGS.join(', ')}: nothing a longer language pushes off the screen or cuts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
