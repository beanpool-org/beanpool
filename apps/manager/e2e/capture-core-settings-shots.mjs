/**
 * Core settings C2: the page, the walkthrough, Unlock to change, the Home item and the moved cards, at 320 px and 1.3× text,
 * light and dark, against the mock harness. Writes PNGs to OUT (default: the folder named by CORE_SHOTS_OUT, else ./core-shots).
 *   cd apps/manager && CORE_SHOTS_OUT=/some/folder node e2e/capture-core-settings-shots.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openSettings, settle } from './harness.mjs';

const OUT = path.resolve(process.env.CORE_SHOTS_OUT || 'core-shots');
fs.mkdirSync(OUT, { recursive: true });

const CORE = ['join', 'wordsDoor', 'beans', 'knownFloor', 'decisions', 'shareOutside', 'recoveryCopies'];
const LOCK = { at: '2026-11-03T10:00:00.000Z', by: 'f'.repeat(64), byCallsign: 'ada' };

/** The mock shape with the core fields: unlocked or locked, the place set or not. Beans keep the fixture's own server lock. */
const withCore = ({ locked, placeSet = true }) => (json) => ({
    ...json,
    core: { settings: CORE, lock: locked ? LOCK : null, place: { needed: true, set: placeSet } },
    settings: {
        ...json.settings,
        join: { ...json.settings.join, door: 'members' },
        shareOutside: { value: true, configured: true, source: 'default', lock: null },
        recoveryCopies: { value: 'vault', configured: 'vault', source: 'default', lock: null },
        beans: { ...json.settings.beans, lock: null },
    },
});

const { server, origin } = await startServer();
const browser = await launch();

async function shot(theme, name, opts, act, target) {
    const { context, page } = await openSettings(browser, origin, { width: 320, height: 800, textScale: 1.3, colorScheme: theme, ...opts });
    if (theme === 'light') await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await settle(page);
    if (act) await act(page);
    await settle(page);
    const file = path.join(OUT, `${name}-${theme}.png`);
    if (target) await target(page).screenshot({ path: file });
    else await page.screenshot({ path: file }); // the first screen, as a person sees it
    console.log(`Saved ${file}`);
    await context.close();
}

const shapeOverride = (o) => ({ '/api/local/admin/community-shape': withCore(o) });

try {
    for (const theme of ['dark', 'light']) {
        await shot(theme, '01-unconfirmed-page', { screen: { tab: 'shape' }, overrides: shapeOverride({ locked: false }) },
            (p) => p.waitForSelector('[data-testid="core-unconfirmed-banner"]'));

        await shot(theme, '02-walk-beans-step', { screen: { tab: 'shape' }, overrides: shapeOverride({ locked: false }) },
            async (p) => {
                await p.getByTestId('core-walk-start').click();
                await p.getByTestId('walk-next').click();
                await p.getByTestId('walk-next').click();
            }, (p) => p.getByTestId('core-walkthrough'));

        await shot(theme, '03-walk-place-step', { screen: { tab: 'shape' }, overrides: shapeOverride({ locked: false, placeSet: false }) },
            async (p) => {
                await p.getByTestId('core-walk-start').click();
                await p.getByTestId('walk-next').click();
            }, (p) => p.getByTestId('core-walkthrough'));

        await shot(theme, '04-walk-review', { screen: { tab: 'shape' }, overrides: shapeOverride({ locked: false }) },
            async (p) => {
                await p.getByTestId('core-walk-start').click();
                for (let i = 0; i < 12 && (await p.getByTestId('core-walkthrough').getAttribute('data-step')) !== 'review'; i++) {
                    await p.getByTestId('walk-next').click();
                }
            }, (p) => p.getByTestId('core-walkthrough'));

        await shot(theme, '05-locked-page', { screen: { tab: 'shape' }, overrides: shapeOverride({ locked: true }) },
            (p) => p.waitForSelector('[data-testid="shape-unlock-beans"]'));

        await shot(theme, '06-unlock-beans-typed-word', { screen: { tab: 'shape' }, overrides: shapeOverride({ locked: true }) },
            async (p) => {
                await p.getByTestId('shape-unlock-beans').click();
                await p.getByRole('checkbox', { name: /Beans active/ }).click();
            }, (p) => p.getByTestId('shape-row-beans'));

        await shot(theme, '07-home-action-item', { screen: { tab: 'home' }, overrides: shapeOverride({ locked: false }) },
            (p) => p.waitForSelector('[data-testid="home-community-shape-card"]'), (p) => p.getByTestId('home-action-required'));

        await shot(theme, '08-invites-taking-new-members', { screen: { tab: 'people', sub: 'invites' } },
            (p) => p.waitForSelector('[data-testid="everyday-taking"] [data-testid="shape-row-pause"]'), (p) => p.getByTestId('everyday-taking'));

        await shot(theme, '09-triage-rules', { screen: { tab: 'people', sub: 'moderation' } },
            (p) => p.waitForSelector('[data-testid="everyday-rules"] [data-testid="shape-row-probation"]'), (p) => p.getByTestId('everyday-rules'));

        await shot(theme, '10-identity-being-found', { screen: { tab: 'appliance', sub: 'identity' } },
            (p) => p.waitForSelector('[data-testid="everyday-found"] [data-testid="shape-row-shareEmail"]'), (p) => p.getByTestId('everyday-found'));

        // Round fix1: the person check on busy days is back under Being found (global kind only)...
        await shot(theme, '11-identity-person-check-global', { screen: { tab: 'appliance', sub: 'identity' },
            overrides: { '/api/local/admin/community-shape': (json) => ({ ...json, kind: 'global', settings: { ...json.settings, doorCheck: { value: true, configured: true, source: 'default', lock: null } } }) } },
            (p) => p.waitForSelector('[data-testid="everyday-found"] [data-testid="shape-row-doorCheck"]'), (p) => p.getByTestId('shape-row-doorCheck'));

        // ...and a community with Beans off who chooses On is offered the known floor, not told "Set by this server".
        await shot(theme, '12-walk-floor-after-beans-on', { screen: { tab: 'shape' }, overrides: { '/api/local/admin/community-shape': (json) => {
            const c = withCore({ locked: false })(json);
            return { ...c, settings: { ...c.settings,
                beans: { ...c.settings.beans, value: false, configured: false, lock: null },
                knownFloor: { ...c.settings.knownFloor, value: { on: false, floor: 100000, cap: 200000, capMax: 500000 }, lock: { code: 'beans_off', why: 'Beans are off, so there is no floor.' } } } };
        } } },
            async (p) => {
                await p.getByTestId('core-walk-start').click();
                await p.getByTestId('walk-next').click();
                await p.getByTestId('walk-next').click();
                await p.getByRole('radio', { name: /^On/ }).first().click();
                await p.getByTestId('walk-next').click();
            }, (p) => p.getByTestId('core-walkthrough'));
    }
} finally {
    await browser.close();
    server.close?.();
}
