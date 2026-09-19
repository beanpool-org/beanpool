#!/usr/bin/env node
/**
 * The way back out of Settings, and the collapsing desktop sidebar: `node e2e/backlink.mjs <out-dir>`.
 *
 * For each origin (the phone app's key hand-off with `from=app`, the web app's `#from=pwa`, and neither) at 360 and
 * 1280 wide: checks the back control's label and link, that "View my profile" shows only for a key sign-in, that the
 * fragment has left the address bar, and that the origin survives a reload. Then the three desktop sidebar states
 * at 1280 (full, icon strip with a tooltip, hidden) and that the choice is remembered. Pictures go to <out-dir>,
 * each at most 1500px tall. Every request is answered locally (harness.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openSettings, settle, horizontalOverflow } from './harness.mjs';

const out = process.argv[2];
if (!out) {
    console.error('usage: node e2e/backlink.mjs <out-dir>');
    process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

const MEMBER = 'f'.repeat(64); // what the harness's mocked hand-off exchange signs in as
const ORIGINS = [
    { from: 'app', hash: `#handoff=${'a'.repeat(64)}&from=app`, label: 'Back to the BeanPool app', href: 'beanpool://foreground', profile: `beanpool://public-profile?publicKey=${MEMBER}` },
    { from: 'pwa', hash: '#from=pwa', label: 'Back to BeanPool', href: '/app', profile: null },
    { from: 'unknown', hash: '', label: 'Open the BeanPool web app', href: '/app', profile: null },
];

const failures = [];
function check(cond, what) {
    if (!cond) failures.push(what);
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
}

async function shot(page, name, clip) {
    const file = path.join(out, `${name}.png`);
    const { width, height } = page.viewportSize();
    await page.screenshot({ path: file, animations: 'disabled', clip: clip ?? { x: 0, y: 0, width, height: Math.min(height, 1500) } });
    console.log(file);
}

const { server, origin } = await startServer();
const browser = await launch();
try {
    for (const o of ORIGINS) {
        for (const width of [360, 1280]) {
            const { context, page, errors } = await openSettings(browser, origin, { width, height: width < 600 ? 780 : 900, hash: o.hash });
            const tag = `${o.from}-${width}`;
            check(new URL(page.url()).hash === '', `${tag}: fragment gone from the address bar (${page.url()})`);

            if (width < 1024) {
                const top = page.locator('header').getByRole('link', { name: o.label });
                check(await top.isVisible(), `${tag}: top bar shows "${o.label}"`);
                check((await top.getAttribute('href')) === o.href, `${tag}: top bar link goes to ${o.href}`);
                const box = await top.boundingBox();
                check(box && box.height >= 48 && box.width >= 48, `${tag}: top bar link is at least 48px (${box && `${Math.round(box.width)}×${Math.round(box.height)}`})`);
                const ov = await horizontalOverflow(page);
                check(ov.scrollWidth <= ov.viewport, `${tag}: no sideways scroll (${ov.scrollWidth} ≤ ${ov.viewport}) ${ov.culprits.join(' ')}`);
                await shot(page, `back-${o.from}-360-topbar`);

                await page.getByRole('button', { name: 'Menu' }).click();
                await settle(page);
                const menu = page.getByRole('dialog', { name: 'Settings menu' });
                const back = menu.getByRole('link', { name: o.label });
                check((await back.getAttribute('href')) === o.href, `${tag}: menu has "${o.label}" → ${o.href}`);
                const mb = await back.boundingBox();
                check(mb && mb.height >= 48, `${tag}: menu link is at least 48px tall`);
                const prof = menu.getByRole('link', { name: 'View my profile' });
                check(o.profile ? (await prof.getAttribute('href')) === o.profile : (await prof.count()) === 0,
                    `${tag}: View my profile ${o.profile ? `→ ${o.profile}` : 'hidden under the password'}`);
                await shot(page, `back-${o.from}-360-menu`);
            } else {
                const aside = page.locator('#settings-sidebar');
                const back = aside.getByRole('link', { name: o.label });
                check((await back.getAttribute('href')) === o.href, `${tag}: sidebar has "${o.label}" → ${o.href}`);
                const prof = aside.getByRole('link', { name: 'View my profile' });
                check(o.profile ? (await prof.getAttribute('href')) === o.profile : (await prof.count()) === 0,
                    `${tag}: View my profile ${o.profile ? `→ ${o.profile}` : 'hidden under the password'}`);
                await shot(page, `back-${o.from}-1280`);
            }

            if (o.from !== 'unknown') {
                await page.reload();
                await page.waitForSelector('main', { timeout: 20000 });
                await settle(page);
                check(await page.getByRole('link', { name: o.label }).first().count() > 0, `${tag}: still "${o.label}" after a reload (sessionStorage)`);
            }
            check(errors.length === 0, `${tag}: no page errors ${errors.join(' | ')}`);
            await context.close();
        }
    }

    // The desktop sidebar's two-step collapse, at 1280.
    {
        const { context, page } = await openSettings(browser, origin, { width: 1280, height: 900, hash: '#from=pwa' });
        const mainWidth = () => page.locator('main').evaluate((el) => Math.round(el.getBoundingClientRect().width));
        const full = await mainWidth();
        await shot(page, 'sidebar-full-1280');

        const collapse = page.getByRole('button', { name: 'Collapse menu to icons' });
        check((await collapse.getAttribute('aria-expanded')) === 'true', 'full: collapse button aria-expanded=true');
        await collapse.focus();
        await page.keyboard.press('Enter');
        await settle(page);
        const hide = page.getByRole('button', { name: 'Hide menu' });
        check(await hide.isVisible(), 'icons: the strip shows, with its Hide menu button');
        check((await hide.getAttribute('aria-expanded')) === 'false', 'icons: aria-expanded=false');
        check(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Hide menu', 'icons: keyboard focus followed to the strip\'s button');
        const icons = await mainWidth();
        check(icons > full, `icons: the page widened (${full} → ${icons})`);
        // A name on keyboard focus: tab to People & Safety.
        await page.getByRole('button', { name: 'People & Safety' }).focus();
        await settle(page);
        const tip = page.getByRole('tooltip');
        check(/^People & Safety/.test(await tip.textContent() || ''), `icons: tooltip names the focused icon (${await tip.textContent()})`);
        await shot(page, 'sidebar-icons-1280');
        await page.keyboard.press('Escape');
        check((await tip.count()) === 0, 'icons: Escape dismisses the tooltip');

        await hide.click();
        await settle(page);
        const show = page.getByRole('button', { name: 'Show menu' });
        check(await show.isVisible(), 'hidden: one ☰ at the top-left');
        const sb = await show.boundingBox();
        check(sb && sb.x < 40 && sb.y < 40, `hidden: ☰ is top-left (${sb && `${Math.round(sb.x)},${Math.round(sb.y)}`})`);
        check((await page.locator('#settings-sidebar').count()) === 0, 'hidden: no sidebar');
        check((await page.getByRole('link', { name: 'Back to BeanPool' }).getAttribute('href')) === '/app', 'hidden: the way back is still on screen');
        const hidden = await mainWidth();
        check(hidden >= icons, `hidden: the page widened again (${icons} → ${hidden})`);
        await shot(page, 'sidebar-hidden-1280');

        await page.reload();
        await page.waitForSelector('main', { timeout: 20000 });
        await settle(page);
        check(await page.getByRole('button', { name: 'Show menu' }).isVisible(), 'hidden: remembered across a reload');
        await page.getByRole('button', { name: 'Show menu' }).click();
        await settle(page);
        check(await page.getByRole('button', { name: 'Collapse menu to icons' }).isVisible(), '☰ brings the sidebar back in full');
        await context.close();
    }

    // Below lg the collapse never shows: the phone layout from #957 is unchanged even with "hidden" remembered.
    {
        const { context, page } = await openSettings(browser, origin, { width: 360, height: 780 });
        await page.evaluate(() => localStorage.setItem('bp-settings-sidebar', 'hidden'));
        await page.reload();
        await page.waitForSelector('main', { timeout: 20000 });
        await settle(page);
        check(await page.getByRole('button', { name: 'Menu' }).isVisible(), '360: phone top bar Menu still there with "hidden" remembered');
        check(!(await page.getByRole('button', { name: 'Show menu' }).isVisible()), '360: no desktop ☰ row');
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}

if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('\nall checks passed');
