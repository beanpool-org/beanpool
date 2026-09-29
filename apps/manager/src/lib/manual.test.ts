/**
 * Divergence checks between the operator manual and Settings:
 *   - Settings bundles exactly the bytes the guide build writes, and there is no website copy (Marty, 2026-09-19);
 *   - every "?" points at a page that exists;
 *   - every screen and sub-tab in Settings has a "?" entry, so a new screen cannot ship without help.
 *
 * Settings bundles the PUBLISHED manual, which the director publishes after merge (packages/beanpool-guide/README.md).
 * So what the manual must contain is checked on its pages (packages/beanpool-guide/operators): a PR that adds a screen
 * with its page, or changes a page with the code it describes, passes before its words are published, and nothing here
 * breaks when they are. Until then a new page's "?" stays hidden (HelpLink renders nothing for a page it lacks).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { FEEDBACK_LIVE, validateGuide, searchGuide } from '@beanpool/core';
import { OPERATOR_MANUAL, SCREEN_HELP, MODERATOR_MANUAL_PAGES, helpPageFor, manualPage, type HelpScreen } from './manual';
import { loadGuide, serializeGuide } from '../../../../packages/beanpool-guide/src/guide.mjs';

const repo = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

/** The manual's pages as they stand, and whether they hold words Settings' published copy does not have yet. */
const OPERATORS = path.join(repo, 'packages/beanpool-guide/operators');
const PAGES = loadGuide(OPERATORS, { aboutSection: null, allowImages: true });
const pageOf = (slug: string) => PAGES.guides.find(g => g.slug === slug) ?? null;
const PENDING = PAGES.hash !== OPERATOR_MANUAL.hash;
const unpublishedOk = (slug: string) => `${slug} is not in Settings' published manual, yet the pages hold nothing waiting to be published`;

describe('operator manual in Settings', () => {
    it('is the generated operators.json', () => {
        const generated = read('packages/beanpool-guide/generated/operators.json');
        expect(OPERATOR_MANUAL).toEqual(JSON.parse(generated));
    });

    it('its bytes are a fresh build of the published text, under the published version', () => {
        const generated = read('packages/beanpool-guide/generated/operators.json');
        expect(serializeGuide(JSON.parse(generated))).toBe(generated);
        // Until the director publishes, the pages hold newer text than Settings' copy, and only its own bytes are checked.
        if (!PENDING) {
            expect(serializeGuide(loadGuide(OPERATORS, { aboutSection: null, allowImages: true, version: OPERATOR_MANUAL.version }))).toBe(generated);
        }
    });

    it('is not published on the website', () => {
        // The guard for Marty's decision of 2026-09-19: the manual ships in node Settings only, and the website copy
        // waits until the security weak spots it describes are fixed (PUBLISH_OPERATORS_WEBSITE in
        // packages/beanpool-guide/scripts/build.mjs). Remove this only together with that switch.
        expect(fs.existsSync(path.join(repo, 'apps/website/guide/operators')),
            'apps/website/guide/operators/ must not exist: the operator manual is not published on beanpool.org until its security weak spots are fixed (Marty, 2026-09-19)')
            .toBe(false);
    });

    it('passes the same validation the apps apply to the members\' guide', () => {
        expect(validateGuide(OPERATOR_MANUAL, { allowImages: true })).not.toBeNull();
        expect(validateGuide(OPERATOR_MANUAL)).toBeNull();
        expect(OPERATOR_MANUAL.guides.length).toBeGreaterThanOrEqual(15);
    });

    it("a moderator's manual pages all exist, and include the page Reports' \"?\" opens", () => {
        for (const slug of MODERATOR_MANUAL_PAGES) {
            expect(pageOf(slug), slug).not.toBeNull();
            if (!manualPage(slug)) expect(PENDING, unpublishedOk(slug)).toBe(true);
        }
        expect(MODERATOR_MANUAL_PAGES).toContain(SCREEN_HELP['people/moderation']);
    });

    it('every "?" opens a page that exists', () => {
        for (const [screen, slug] of Object.entries(SCREEN_HELP)) {
            expect(pageOf(slug), `${screen} → ${slug}`).not.toBeNull();
            if (manualPage(slug)) expect(helpPageFor(screen as HelpScreen)?.slug).toBe(slug);
            else expect(PENDING, unpublishedOk(slug)).toBe(true);
        }
    });

    it('every sub-tab of every Settings section has a "?" entry', () => {
        const sections: Record<string, string> = {
            people: 'src/components/modules/PeopleSafetySection.tsx',
            economy: 'src/components/modules/EconomySection.tsx',
            bulletin: 'src/components/modules/BulletinSection.tsx',
            appliance: 'src/components/modules/ApplianceSection.tsx',
        };
        for (const [section, file] of Object.entries(sections)) {
            const source = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
            const subTabs = [...new Set([...source.matchAll(/setSubTab\('([a-z-]+)'\)/g)].map(m => m[1]))];
            expect(subTabs.length, `${file} has sub-tabs`).toBeGreaterThan(1);
            for (const sub of subTabs) {
                expect(Object.keys(SCREEN_HELP), `${section}/${sub} needs an entry in SCREEN_HELP`).toContain(`${section}/${sub}`);
            }
            expect(source, `${file} shows the "?"`).toContain(`<HelpLink screen={\`${section}/\${subTab}\`} />`);
        }
    });

    it('every top-level Settings tab is covered', () => {
        const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/layout/FleetSidebar.tsx'), 'utf8');
        const block = sidebar.slice(sidebar.indexOf('singleNodeNavItems'), sidebar.indexOf('multiServerItems'));
        const tabs = [...block.matchAll(/id: '([a-z]+)'/g)].map(m => m[1]);
        expect(tabs).toContain('home');
        for (const tab of tabs) {
            const covered = Object.keys(SCREEN_HELP).some(k => k === tab || k.startsWith(`${tab}/`));
            expect(covered, `tab ${tab} has help`).toBe(true);
        }
    });

    it('the feedback page matches whether "Suggest a change" is live', () => {
        const text = JSON.stringify(pageOf('feedback'));
        expect(text.includes('Not in this version')).toBe(!FEEDBACK_LIVE);
    });

    it('search on the pages: "backup" finds the backups page', () => {
        // Pinned here, on the pages, since Manual.test.tsx's search test now searches a sample page's own title.
        const manual = validateGuide({ ...PAGES, version: 1 }, { allowImages: true })!;
        expect(manual).not.toBeNull();
        expect(searchGuide(manual, 'backup').map(r => r.page.slug)).toContain('backups-and-replicas');
    });

    it('the pages have what Manual.test.tsx renders: a picture, bold text and a linked card', () => {
        // Manual.test.tsx takes its samples from the published copy; these are the ones it used to name.
        const access = pageOf('access-and-security')!;
        expect(access.blocks).toContainEqual(expect.objectContaining({ type: 'img', alt: 'The Access and Security screen in Settings', src: 'images/appliance-access.webp' }));
        expect(JSON.stringify(access.blocks)).toContain('**');
        const map = pageOf('settings-map')!;
        expect(map.title).toBe('Settings map');
        expect(map.blocks).toContainEqual(expect.objectContaining({ type: 'img', alt: 'The Home screen in Settings', href: 'the-settings-screens' }));
        expect(pageOf('the-settings-screens')?.title).toBe('Finding your way around Settings');
    });

    it('the disputes page says an operator cannot rule on a deal they are part of', () => {
        // Pinned here, on the page, since Manual.test.tsx's "?" test now reads its sample text from the published copy.
        expect(JSON.stringify(pageOf('disputes'))).toContain('You cannot rule on a deal you are part of');
    });
});
