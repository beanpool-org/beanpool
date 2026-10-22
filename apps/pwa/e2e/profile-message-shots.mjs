import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = path.resolve(process.env.PROFILE_MESSAGE_OUT || path.join(PWA_DIR, 'e2e', 'screenshots', 'profile-message'));
fs.mkdirSync(OUT_DIR, { recursive: true });

const KOFI_PUBKEY = 'kofi-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const BOB_PUBKEY = 'bob-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
});
await server.listen();
const port = server.httpServer.address().port;
const base = `http://localhost:${port}/e2e/profile-message-harness.html`;

const browser = await chromium.launch();

const cases = [
    { id: 'profile-unfriended', view: 'profile', friended: false, blocked: false },
    { id: 'profile-friended', view: 'profile', friended: true, blocked: false },
    { id: 'profile-blocked', view: 'profile', friended: false, blocked: true },
    { id: 'community-list', view: 'community', friended: false, blocked: false },
];

try {
    for (const theme of ['light', 'dark']) {
        for (const c of cases) {
            const context = await browser.newContext({
                viewport: { width: 320, height: 750 },
                colorScheme: theme,
            });
            const page = await context.newPage();
            page.on('console', msg => console.log('PAGE LOG:', msg.text()));
            page.on('pageerror', err => console.log('PAGE ERR:', err));

            await page.route('**/api/**', async (route) => {
                const url = route.request().url();
                if (url.includes('/api/community/members') || url.endsWith('/api/members')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify([
                            { publicKey: KOFI_PUBKEY, callsign: 'Kofi', joinedAt: '2026-03-01T00:00:00.000Z', avatarUrl: null },
                            { publicKey: BOB_PUBKEY, callsign: 'Bob', joinedAt: '2026-01-15T00:00:00.000Z', avatarUrl: null },
                        ]),
                    });
                }
                if (url.includes('/api/community/info')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            memberCount: 2,
                            postCount: 0,
                            transactionCount: 0,
                            commonsBalance: 0,
                            profile: 'local',
                            features: {},
                        }),
                    });
                }
                if (url.includes('/api/friends/added-you')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({ addedYou: [], more: 0 }),
                    });
                }
                if (url.includes('/api/friends')) {
                    if (c.friended) {
                        return route.fulfill({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify([{ publicKey: KOFI_PUBKEY, callsign: 'Kofi', addedAt: '2026-03-01T00:00:00.000Z' }]),
                        });
                    }
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify([]),
                    });
                }
                if (url.includes('/api/profile') || url.includes('/api/members/profile')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            publicKey: KOFI_PUBKEY,
                            callsign: 'Kofi',
                            avatarUrl: null,
                            bio: 'Grows tomatoes and fixes bicycles in the valley.',
                            joinedAt: '2026-03-01T00:00:00.000Z',
                            archetype: null,
                        }),
                    });
                }
                if (url.includes('/api/members/trust')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            tier: { name: 'Resident', emoji: '🌱' },
                            earnedCredit: 50,
                            completionRate: 0.95,
                            stats: { tradeCount: 12, uniquePartners: 8 },
                            risk: { band: 'green', headline: 'Good standing' },
                        }),
                    });
                }
                if (url.includes('/api/members/ratings') || url.includes('/api/ratings')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({ averageRating: 5, totalCount: 4, ratings: [] }),
                    });
                }
                if (url.includes('/api/members')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify([
                            { publicKey: KOFI_PUBKEY, callsign: 'Kofi', joinedAt: '2026-03-01T00:00:00.000Z', avatarUrl: null },
                            { publicKey: BOB_PUBKEY, callsign: 'Bob', joinedAt: '2026-01-15T00:00:00.000Z', avatarUrl: null },
                        ]),
                    });
                }
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify([]),
                });
            });

            await page.addInitScript(({ isBlocked, targetPk, themeMode }) => {
                localStorage.setItem('beanpool-theme-mode', themeMode);
                if (isBlocked) {
                    localStorage.setItem('beanpool_blocked_users', JSON.stringify([targetPk]));
                } else {
                    localStorage.removeItem('beanpool_blocked_users');
                }
            }, { isBlocked: c.blocked, targetPk: KOFI_PUBKEY, themeMode: theme });

            const targetUrl = `${base}?view=${c.view}`;
            await page.goto(targetUrl, { waitUntil: 'networkidle' });

            // Apply 1.3x text scale
            await page.addStyleTag({
                content: `
                    html { font-size: 130% !important; }
                    body { font-size: 1rem !important; }
                `,
            });

            await page.waitForTimeout(500);

            const shotPath = path.join(OUT_DIR, `${c.id}-${theme}.png`);
            await page.screenshot({ path: shotPath, fullPage: false });
            console.log(`Saved screenshot: ${shotPath}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
