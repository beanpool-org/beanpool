#!/usr/bin/env node
/**
 * Capture screenshots of the real built manager for the Addresses screen across all states:
 * at 320 px (130% text) and 1280 px (desktop), in both dark and light modes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openSettings, selectSubTab, settle } from './harness.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(SCRIPT_DIR, 'screenshots/addresses');
fs.mkdirSync(OUT_DIR, { recursive: true });

const STATES = [
    {
        name: 'fine',
        reach: {
            answers: 'own',
            dns: { outcome: 'answers', a: ['104.21.93.179'], aaaa: [], cname: ['edge.cloudflare.example.org'] },
            step: 'fine',
            minutes: null,
            nextStep: 'Answers as this server. Nothing to do.',
            checkedAt: '2026-11-02T05:02:00.000Z',
            ownAt: '2026-11-02T05:02:00.000Z',
        },
    },
    {
        name: 'new-name',
        reach: {
            answers: 'silence',
            dns: { outcome: 'no-such-name', a: [], aaaa: [], cname: [] },
            step: 'new-name',
            minutes: 12,
            nextStep: "Made 12 minutes ago. Some networks remember 'no such name' for up to 30 minutes. Try mobile data, or wait.",
            checkedAt: '2026-11-02T05:02:00.000Z',
            ownAt: null,
        },
    },
    {
        name: 'awaiting-approval',
        reach: {
            answers: 'silence',
            dns: { outcome: 'no-such-name', a: [], aaaa: [], cname: [] },
            step: 'awaiting-approval',
            minutes: null,
            nextStep: 'Awaiting approval by the BeanPool project. It moves over by itself once approved.',
            checkedAt: '2026-11-02T05:02:00.000Z',
            ownAt: null,
        },
    },
    {
        name: 'stopped',
        reach: {
            answers: 'silence',
            dns: { outcome: 'no-such-name', a: [], aaaa: [], cname: [] },
            step: 'stopped',
            minutes: null,
            nextStep: 'Stopped by the address service. Ask the BeanPool project.',
            checkedAt: '2026-11-02T05:02:00.000Z',
            ownAt: null,
        },
    },
    {
        name: 'certificate',
        reach: {
            answers: 'tls',
            dns: { outcome: 'answers', a: ['203.0.113.5'], aaaa: [], cname: [] },
            step: 'certificate',
            minutes: null,
            nextStep: 'Answers, but not with a certificate phones trust. Check that port 80 is open and this address points at this server.',
            checkedAt: '2026-11-02T05:02:00.000Z',
            ownAt: null,
        },
    },
    {
        name: 'no-dns-own',
        reach: {
            answers: 'silence',
            dns: { outcome: 'no-such-name', a: [], aaaa: [], cname: [] },
            step: 'no-dns-own',
            minutes: null,
            nextStep: "No DNS answer for this name. Add or fix its A record where you run your domain's DNS.",
            checkedAt: '2026-11-02T05:02:00.000Z',
            ownAt: null,
        },
    },
    {
        name: 'another-server',
        reach: {
            answers: 'other',
            dns: { outcome: 'answers', a: ['203.0.113.8'], aaaa: [], cname: [] },
            step: 'another-server',
            minutes: null,
            nextStep: "Another server answers here, with a key that isn't this server's. Check where this address points.",
            checkedAt: '2026-11-02T05:02:00.000Z',
            ownAt: null,
        },
    },
    {
        name: 'no-longer-ours',
        former: true,
        reach: {
            answers: 'silence',
            dns: { outcome: 'no-such-name', a: [], aaaa: [], cname: [] },
            step: 'no-longer-ours',
            minutes: null,
            nextStep: "No longer this community's address. Nothing to do.",
            checkedAt: '2026-11-02T05:02:00.000Z',
            ownAt: null,
        },
    },
];

console.log('Building and launching Settings preview server…');
const { server, origin } = await startServer();
const browser = await launch();

try {
    for (const state of STATES) {
        console.log(`\nCapturing state: ${state.name}…`);
        const address = state.name === 'no-dns-own'
            ? 'byron.example.org'
            : state.name === 'no-longer-ours'
            ? 'old-byron.beanpool.org'
            : `${state.name}.beanpool.org`;

        const reportOverride = (orig) => ({
            ...orig,
            primaryAddress: state.former ? 'byron.beanpool.org' : address,
            named: true,
            addresses: [
                {
                    address,
                    source: state.former ? 'registrar' : (state.name === 'no-dns-own' ? 'owner' : 'public-address'),
                    ...(state.former ? { former: true } : {}),
                    today: state.name === 'fine' ? 14 : (state.former ? 2 : 0),
                    busiestDay: state.name === 'fine' ? 28 : (state.former ? 4 : 0),
                    reach: state.reach,
                },
                ...(state.former ? [{
                    address: 'byron.beanpool.org',
                    source: 'public-address',
                    today: 14,
                    busiestDay: 28,
                    reach: STATES[0].reach,
                }] : []),
            ],
        });

        // Configs: 320px/130% dark & light, 1280px dark & light
        const configs = [
            { width: 320, height: 780, textScale: 1.3, colorScheme: 'dark', label: '320px-130-dark' },
            { width: 320, height: 780, textScale: 1.3, colorScheme: 'light', label: '320px-130-light' },
            { width: 1280, height: 900, textScale: 1.0, colorScheme: 'dark', label: 'desktop-dark' },
            { width: 1280, height: 900, textScale: 1.0, colorScheme: 'light', label: 'desktop-light' },
        ];

        for (const cfg of configs) {
            const { context, page } = await openSettings(browser, origin, {
                width: cfg.width,
                height: cfg.height,
                textScale: cfg.textScale,
                screen: { tab: 'appliance', sub: 'network' },
                colorScheme: cfg.colorScheme,
                overrides: {
                    '/api/local/admin/app-addresses': reportOverride,
                },
            });

            if (cfg.colorScheme === 'light') {
                await page.evaluate(() => {
                    document.documentElement.classList.remove('dark');
                    document.body.classList.remove('dark');
                });
            }

            await page.waitForSelector('[data-testid="addresses-panel"]', { timeout: 10000 });
            await settle(page);
            await page.waitForTimeout(200);

            // On mobile 320px, scroll the address row into view so each state's address and next step are clearly visible
            if (cfg.width === 320) {
                await page.locator('[data-testid^="address-row-"]').first().evaluate((el) => {
                    el.scrollIntoView({ block: 'center' });
                });
                await page.waitForTimeout(100);
            }

            const filename = `addresses-${state.name}-${cfg.label}.png`;
            const filePath = path.join(OUT_DIR, filename);
            await page.screenshot({ path: filePath, fullPage: false });
            console.log(`  ✓ ${filename}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log('\nAll screenshots captured successfully.');
