/* eslint-disable no-undef */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR_REPO = path.join(PWA_DIR, 'e2e', 'screenshots', 'shop');
const OUT_DIR_SCRATCH = process.env.OUT_DIR_SCRATCH || null;
fs.mkdirSync(OUT_DIR_REPO, { recursive: true });
if (OUT_DIR_SCRATCH) {
    fs.mkdirSync(OUT_DIR_SCRATCH, { recursive: true });
}

const MY_PUBKEY = 'me-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const KOFI_PUBKEY = 'kofi-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

const myShop = {
    id: 'shop-my',
    name: "Dave's Tools & Workshop",
    ownerName: 'Dave',
    ownerPublicKey: MY_PUBKEY,
    category: 'tools',
    blurb: 'Quality secondhand woodworking tools, hand planer repair and blade sharpening.',
    howToDeal: 'Cash, trade or Beans. Local collection in Maldon.',
    counts: { listings: 2 },
    paused: false,
    backOn: null,
    photoUrl: null,
    enterprise: false,
    openedAt: '2026-03-01T00:00:00.000Z',
};

const myListingsMine = [
    {
        id: 'post-1',
        title: 'Cast iron hand planer #4',
        kind: 'good',
        category: 'tools',
        credits: 35,
        priceType: 'fixed',
        shopId: 'shop-my',
        status: 'active',
        photos: [],
    },
    {
        id: 'post-2',
        title: 'Hedge shear sharpening service',
        kind: 'service',
        category: 'tools',
        credits: 15,
        priceType: 'fixed',
        shopId: 'shop-my',
        status: 'active',
        photos: [],
    },
];

const myListingsShopfront = [
    {
        id: 'post-1',
        type: 'offer',
        title: 'Cast iron hand planer #4',
        credits: 35,
        priceType: 'fixed',
        category: 'tools',
        status: 'active',
        lendable: false,
        featuredAt: '2026-03-05T00:00:00.000Z',
        shopId: 'shop-my',
        audienceScope: 'public',
        photo: null,
    },
    {
        id: 'post-2',
        type: 'offer',
        title: 'Hedge shear sharpening service',
        credits: 15,
        priceType: 'fixed',
        category: 'tools',
        status: 'active',
        lendable: false,
        featuredAt: null,
        shopId: 'shop-my',
        audienceScope: 'public',
        photo: null,
    },
];

const kofiShop = {
    id: 'shop-kofi',
    name: "Kofi's Organic Produce",
    ownerName: 'Kofi',
    ownerPublicKey: KOFI_PUBKEY,
    category: 'produce',
    blurb: 'Heritage heirloom tomatoes, garlic, seeds and seasonal orchard fruit.',
    howToDeal: 'Beans preferred. Farmgate pickup on weekends.',
    counts: { listings: 2 },
    paused: false,
    backOn: null,
    photoUrl: null,
    enterprise: false,
    openedAt: '2026-02-15T00:00:00.000Z',
};

const kofiListingsShopfront = [
    {
        id: 'post-3',
        type: 'offer',
        title: 'Heirloom Brandywine Tomato Seedlings',
        credits: 12,
        priceType: 'fixed',
        category: 'produce',
        status: 'active',
        lendable: false,
        featuredAt: '2026-03-10T00:00:00.000Z',
        shopId: 'shop-kofi',
        audienceScope: 'public',
        photo: null,
    },
    {
        id: 'post-4',
        type: 'offer',
        title: 'Fresh Russian Red Garlic (bunch of 5)',
        credits: 8,
        priceType: 'fixed',
        category: 'produce',
        status: 'active',
        lendable: false,
        featuredAt: null,
        shopId: 'shop-kofi',
        audienceScope: 'public',
        photo: null,
    },
];

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
});
await server.listen();
const port = server.httpServer.address().port;
const base = `http://localhost:${port}/e2e/shop-shots-harness.html`;

const browser = await chromium.launch();

const cases = [
    { id: 'your-shop-empty', view: 'empty', isCloseRefusal: false },
    { id: 'your-shop-open', view: 'open', isCloseRefusal: false },
    { id: 'shop-page-owner', view: 'shop-owner', isCloseRefusal: false },
    { id: 'shop-page-visitor', view: 'shop-visitor', isCloseRefusal: false },
    { id: 'close-refusal', view: 'close-refusal', isCloseRefusal: true },
];

const viewports = [
    { name: '320px-130pct', width: 320, height: 900, scale: 1.3 },
    { name: '1280px', width: 1280, height: 900, scale: 1.0 },
];

try {
    for (const theme of ['light', 'dark']) {
        for (const vp of viewports) {
            for (const c of cases) {
                const context = await browser.newContext({
                    viewport: { width: vp.width, height: vp.height },
                    colorScheme: theme,
                });
                const page = await context.newPage();

                page.on('console', msg => console.log('PAGE LOG:', msg.text()));
                page.on('pageerror', err => console.log('PAGE ERR:', err));

                await page.route('**/api/**', async (route) => {
                    const url = route.request().url();
                    const method = route.request().method();
                    console.log('MOCK ROUTE:', method, url);

                    if (url.includes('/api/shops/mine/close')) {
                        return route.fulfill({
                            status: 409,
                            contentType: 'application/json',
                            body: JSON.stringify({
                                code: 'shop_deals_open',
                                message: 'You have 1 open deal on an item in this shop. Complete or cancel it first.',
                            }),
                        });
                    }

                    if (url.includes('/api/shops/mine')) {
                        if (c.view === 'empty') {
                            return route.fulfill({
                                status: 200,
                                contentType: 'application/json',
                                body: JSON.stringify({ shop: null, listings: [] }),
                            });
                        }
                        return route.fulfill({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify({ shop: myShop, listings: myListingsMine }),
                        });
                    }

                    if (url.includes('/api/marketplace/posts')) {
                        if (url.includes('shop=shop-kofi')) {
                            return route.fulfill({
                                status: 200,
                                contentType: 'application/json',
                                body: JSON.stringify(kofiListingsShopfront),
                            });
                        }
                        return route.fulfill({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify(myListingsShopfront),
                        });
                    }

                    if (url.includes('/api/shops/shop-kofi')) {
                        return route.fulfill({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify(kofiShop),
                        });
                    }

                    if (url.includes('/api/shops/shop-my')) {
                        return route.fulfill({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify(myShop),
                        });
                    }

                    if (url.includes('/api/deals/mine')) {
                        return route.fulfill({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify({ deals: [] }),
                        });
                    }

                    if (url.includes('/api/members/profile')) {
                        const isKofi = url.includes(KOFI_PUBKEY);
                        return route.fulfill({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify({
                                publicKey: isKofi ? KOFI_PUBKEY : MY_PUBKEY,
                                callsign: isKofi ? 'Kofi' : 'Dave',
                                avatarUrl: null,
                                bio: isKofi ? 'Grows heritage vegetables.' : 'Woodworker and tool restorer.',
                                joinedAt: '2026-01-01T00:00:00.000Z',
                            }),
                        });
                    }

                    if (url.includes('/api/members/trust')) {
                        return route.fulfill({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify({
                                tier: { name: 'Pioneer', emoji: '🌟' },
                                earnedCredit: 120,
                                completionRate: 1,
                                stats: { tradeCount: 24, uniquePartners: 15 },
                                risk: { band: 'green', headline: 'Good standing' },
                            }),
                        });
                    }

                    if (url.includes('/api/members/ratings') || url.includes('/api/ratings')) {
                        return route.fulfill({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify({ averageRating: 5, totalCount: 8, ratings: [] }),
                        });
                    }

                    if (url.includes('/api/community/info')) {
                        return route.fulfill({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify({
                                memberCount: 15,
                                postCount: 25,
                                transactionCount: 40,
                                commonsBalance: 500,
                                profile: 'local',
                                features: {},
                            }),
                        });
                    }

                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify([]),
                    });
                });

                await page.addInitScript(({ themeMode }) => {
                    localStorage.setItem('beanpool-theme-mode', themeMode);
                }, { themeMode: theme });

                const targetUrl = `${base}?view=${c.view}`;
                await page.goto(targetUrl, { waitUntil: 'networkidle' });

                if (vp.scale !== 1.0) {
                    await page.addStyleTag({
                        content: `
                            html { font-size: ${Math.round(vp.scale * 100)}% !important; }
                            body { font-size: 1rem !important; }
                        `,
                    });
                }

                await page.waitForTimeout(400);

                if (c.isCloseRefusal) {
                    const closeBtn = page.locator('[data-testid="shop-close"]');
                    await closeBtn.scrollIntoViewIfNeeded();
                    await closeBtn.click();
                    await page.waitForSelector('[data-testid="shop-close-sheet"]', { state: 'visible' });
                    await page.waitForTimeout(200);

                    const confirmBtn = page.locator('[data-testid="shop-close-go"]');
                    await confirmBtn.click();
                    await page.waitForSelector('[data-testid="shop-close-deals"]', { state: 'visible' });
                    await page.waitForTimeout(300);
                }

                const filename = `${c.id}-${vp.name}-${theme}.png`;
                const shotPathRepo = path.join(OUT_DIR_REPO, filename);
                // <= 900 px crop
                await page.screenshot({ path: shotPathRepo, clip: { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, 900) } });
                if (OUT_DIR_SCRATCH) {
                    const shotPathScratch = path.join(OUT_DIR_SCRATCH, filename);
                    fs.copyFileSync(shotPathRepo, shotPathScratch);
                }
                console.log(`Saved screenshot: ${filename}`);

                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
