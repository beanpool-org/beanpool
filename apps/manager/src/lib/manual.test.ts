/**
 * Divergence checks between the operator manual and Settings:
 *   - Settings bundles exactly the bytes the guide build writes, and there is no website copy (Marty, 2026-09-19);
 *   - every "?" points at a page that exists;
 *   - every screen and sub-tab in Settings has a "?" entry, so a new screen cannot ship without help.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { FEEDBACK_LIVE, validateGuide } from '@beanpool/core';
import { OPERATOR_MANUAL, SCREEN_HELP, helpPageFor, manualPage, type HelpScreen } from './manual';

const repo = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

describe('operator manual in Settings', () => {
    it('is the generated operators.json', () => {
        const generated = read('packages/beanpool-guide/generated/operators.json');
        expect(OPERATOR_MANUAL).toEqual(JSON.parse(generated));
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
        expect(validateGuide(OPERATOR_MANUAL)).not.toBeNull();
        expect(OPERATOR_MANUAL.guides.length).toBeGreaterThanOrEqual(15);
    });

    it('every "?" opens a page that exists', () => {
        for (const [screen, slug] of Object.entries(SCREEN_HELP)) {
            expect(manualPage(slug), `${screen} → ${slug}`).not.toBeNull();
            expect(helpPageFor(screen as HelpScreen)?.slug).toBe(slug);
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
        const text = JSON.stringify(manualPage('feedback'));
        expect(text.includes('Not in this version')).toBe(!FEEDBACK_LIVE);
    });
});
