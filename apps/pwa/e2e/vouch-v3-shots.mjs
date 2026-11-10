#!/usr/bin/env node
/* global process, console, document, window */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = path.join(PWA_DIR, 'e2e', 'screenshots', 'vouch-v3');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
    logLevel: 'error',
});
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();

const cases = [
    { view: 'invite', theme: 'light', name: 'pwa-invite-320px-light.png' },
    { view: 'invite', theme: 'dark', name: 'pwa-invite-320px-dark.png' },
    { view: 'card', theme: 'light', name: 'pwa-vouchercard-320px-light.png' },
    { view: 'card', theme: 'dark', name: 'pwa-vouchercard-320px-dark.png' },
    { view: 'profile', theme: 'light', name: 'pwa-profile-320px-light.png' },
    { view: 'profile', theme: 'dark', name: 'pwa-profile-320px-dark.png' },
    { view: 'ledger', theme: 'light', name: 'pwa-ledger-320px-light.png' },
    { view: 'ledger', theme: 'dark', name: 'pwa-ledger-320px-dark.png' },
    // #2915 round 4: the Ledger's budget dialog, the "+ Make someone a voucher" notice, and the profile card after an
    // earlier 75 (the 50, 75 and 100 presets greyed by the 100 cap).
    { view: 'budget', theme: 'light', name: 'pwa-budget-modal-320px-light.png' },
    { view: 'budget', theme: 'dark', name: 'pwa-budget-modal-320px-dark.png' },
    { view: 'notice', theme: 'light', name: 'pwa-make-voucher-320px-light.png' },
    { view: 'notice', theme: 'dark', name: 'pwa-make-voucher-320px-dark.png' },
    { view: 'profile', theme: 'light', prior: 75, name: 'pwa-profile-raise-320px-light.png' },
    { view: 'profile', theme: 'dark', prior: 75, name: 'pwa-profile-raise-320px-dark.png' },
    // An owner vouches with no limit (Marty, 9 Nov): 200 and 500 too, "From your budget: No limit", and an owner's card
    // and row read No limit with no Set budget to.
    ...['light', 'dark'].flatMap((theme) => ['invite', 'profile', 'card', 'budget'].map((view) => (
        { view, theme, owner: true, name: `pwa-owner-${view}-320px-${theme}.png` }))),
];

try {
    for (const c of cases) {
        const ctx = await browser.newContext({
            viewport: { width: 320, height: 640 },
            colorScheme: c.theme,
            reducedMotion: 'reduce',
        });

        await ctx.route('**/api/**', async (route) => {
            const url = route.request().url();
            if (url.includes('/api/vouchers/me')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        voucher: true,
                        // The budget's figures keep their names and are whole hundredths, as the node sends them (heldInvites and peopleVouched are counts).
                        budget: { left: 55000, held: 10000, heldInvites: 1, vouched: 35000, peopleVouched: 4, level: 100000 },
                        noLimit: !!c.owner,
                        presets: c.owner ? [2500, 5000, 7500, 10000, 20000, 50000] : [2500, 5000, 7500, 10000],
                        vouchMax: c.owner ? 50000 : 10000,
                        budgetMax: 200000,
                        vouchedBy: [{ memberPubkey: 'a'.repeat(64), callsign: 'Jane Albury', amount_c: 10000, at: '2026-11-01' }],
                        history: [
                            { kind: 'grant', amount_c: 100000, actor: 'owner', actorCallsign: 'marty', at: '2026-11-01T00:00:00Z' },
                            { kind: 'hold', amount_c: -10000, actor: 'me', actorCallsign: 'Alice', at: '2026-11-02T00:00:00Z', for: 'invite', outcome: 'held' },
                            ...(c.prior ? [{ kind: 'hold', amount_c: -c.prior * 100, actor: 'me', actorCallsign: 'Alice', at: '2026-11-03T00:00:00Z', for: 'profile', person: { memberPubkey: 's'.repeat(64), callsign: 'sam' } }] : []),
                        ],
                    }),
                });
            }
            if (url.includes('/api/names/vouchers/')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        memberPubkey: 'a'.repeat(64),
                        callsign: 'Jane Albury',
                        madeByCallsign: 'marty',
                        noLimit: !!c.owner,
                        left: 55000,
                        level: 100000,
                        vouched: 35000,
                        peopleVouched: 4,
                        held: 10000,
                        heldInvites: 1,
                        invitesWithVouch: 5,
                        belowZero: 1,
                        writtenOff: 0,
                        trading: { withOthers: 2, insideOnly: 1 },
                        passedOn: { amount_c: 5000, people: 1 },
                        canChange: true,
                        history: [
                            { kind: 'grant', amount_c: 100000, actor: 'owner', actorCallsign: 'marty', at: '2026-11-01T00:00:00Z' },
                        ],
                        people: [
                            { memberPubkey: 'p1', callsign: 'sam', amount_c: 10000, raised: false, byInvite: true, belowZero: true, trading: 'others' },
                        ],
                    }),
                });
            }
            if (url.includes('/api/names/vouchers')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        vouchers: [
                            {
                                memberPubkey: 'a'.repeat(64),
                                callsign: 'Jane Albury',
                                noLimit: !!c.owner,
                                left: 55000,
                                level: 100000,
                                vouched: 35000,
                                peopleVouched: 4,
                                belowZero: 1,
                            },
                        ],
                        settings: { voucherBudget: 100000, memberGift: 10000 },
                    }),
                });
            }
            if (url.includes('/api/members/') || url.includes('/api/profile/')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        publicKey: 's'.repeat(64),
                        callsign: 'sam',
                        bio: 'Community gardener',
                        status: 'active',
                        joinedAt: '2026-10-15T00:00:00.000Z',
                    }),
                });
            }
            if (url.includes('/api/community/info') || url.includes('/api/community/card') || url.includes('/api/community/health')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        name: 'Castlemaine BeanPool',
                        profile: 'local',
                        features: { invites: true, beans: true },
                        memberCount: 42,
                    }),
                });
            }
            if (url.includes('/api/balance')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        balance_c: 15000,
                        earnedCredit_c: 5000,
                        vouchedBy: [
                            { memberPubkey: 'a'.repeat(64), callsign: 'Jane Albury', amount_c: 10000, at: '2026-11-01T00:00:00.000Z' },
                        ],
                    }),
                });
            }
            if (url.includes('/api/transactions')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ transactions: [] }),
                });
            }
            if (url.includes('/api/trust/profile')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        tier: 'trusted',
                        mutualCount: 0,
                        mutualConnections: [],
                        vouchedInBy: { kind: 'member', callsign: 'founder', publicKey: 'f'.repeat(64), tier: 'core' },
                    }),
                });
            }
            if (url.includes('/api/ratings')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ average: 5, count: 1, ratings: [] }),
                });
            }
            if (url.includes('/api/friends') || url.includes('/api/public-channels')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify([]),
                });
            }
            if (url.includes('/api/invite/mine')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ invites: [] }),
                });
            }
            if (url.includes('/api/marketplace/posts')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify([]),
                });
            }
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true }),
            });
        });

        const page = await ctx.newPage();
        await page.goto(`${origin}/e2e/vouch-v3-shots-harness.html?view=${c.view === 'notice' ? 'invite' : c.view}&theme=${c.theme}${c.owner ? '&owner=1' : ''}`, { waitUntil: 'load' });
        await page.waitForFunction(() => document.documentElement.dataset.harnessReady === 'true');
        await page.addStyleTag({
            content: `*, *::before, *::after { transition: none !important; } html { font-size: 130% !important; }`,
        });
        await page.waitForTimeout(500);

        if (c.view === 'notice') await page.click('[data-testid="make-voucher-button"]');
        await page.waitForTimeout(c.view === 'notice' ? 300 : 0);
        // The part each shot is for, scrolled into view inside its own scrolling box (#2915 round 4).
        // An owner's card has no Set budget to: its No limit box is the part; an owner's invite, the presets.
        const focus = c.owner
            ? { invite: '[data-testid="invite-vouch"]', profile: '[data-testid="profile-vouch"]' }[c.view]
            : { card: '[data-testid="voucher-level-500"]', profile: '[data-testid="profile-vouch"]' }[c.view];
        if (focus) {
            await page.waitForSelector(focus, { timeout: 5000 }).catch(() => {});
            await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), focus);
            await page.waitForTimeout(200);
        }
        const shotPath = path.join(SHOTS_DIR, c.name);
        await page.screenshot({ path: shotPath, fullPage: true });
        console.log(`Saved screenshot: ${shotPath}`);
        await ctx.close();
    }
} finally {
    await browser.close();
    await server.close();
}
