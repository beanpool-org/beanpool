import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { SECTION_SUB_TABS, defaultSubTab, subTabLabel } from './sections';
import { singleNodeNavItems } from '../components/layout/FleetSidebar';

const SOURCES: Record<string, string> = {
    people: 'src/components/modules/PeopleSafetySection.tsx',
    economy: 'src/components/modules/EconomySection.tsx',
    bulletin: 'src/components/modules/BulletinSection.tsx',
    appliance: 'src/components/modules/ApplianceSection.tsx',
};

describe('the phone menu lists every Settings screen', () => {
    it('has an entry for every section in the sidebar', () => {
        expect(Object.keys(SECTION_SUB_TABS).sort()).toEqual(singleNodeNavItems.map(i => i.id).sort());
    });

    it('lists exactly the sub-tabs each section has, in the same order, opening on the same default', () => {
        for (const [section, file] of Object.entries(SOURCES)) {
            const source = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
            const buttons = [...source.matchAll(/data-subtab="([a-z-]+)"/g)].map(m => m[1]);
            expect(SECTION_SUB_TABS[section as keyof typeof SECTION_SUB_TABS].map(s => s.id), file).toEqual(buttons);
            const def = source.match(/initialSubTab = '([a-z-]+)'/)?.[1];
            expect(defaultSubTab(section), file).toBe(def);
        }
    });

    it('names the screen for the top bar', () => {
        expect(subTabLabel('economy', 'disputes')).toBe('Escrow Disputes');
        expect(subTabLabel('people', undefined)).toBe('Members');
        expect(subTabLabel('home', undefined)).toBeUndefined();
    });
});
