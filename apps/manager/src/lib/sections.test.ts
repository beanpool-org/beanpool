import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { SECTION_SUB_TABS, defaultSubTab, subTabLabel, isSettingsSection, useSectionSubTab } from './sections';
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

describe('sections helper functions', () => {
    it('isSettingsSection validates section names', () => {
        expect(isSettingsSection('home')).toBe(true);
        expect(isSettingsSection('people')).toBe(true);
        expect(isSettingsSection('economy')).toBe(true);
        expect(isSettingsSection('bulletin')).toBe(true);
        expect(isSettingsSection('appliance')).toBe(true);
        expect(isSettingsSection('invalid')).toBe(false);
        expect(isSettingsSection('')).toBe(false);
    });

    it('defaultSubTab handles invalid and empty sections', () => {
        expect(defaultSubTab('invalid')).toBeUndefined();
        expect(defaultSubTab('home')).toBeUndefined();
        expect(defaultSubTab('people')).toBe('directory');
    });

    it('subTabLabel handles unknown subtabs and invalid sections', () => {
        expect(subTabLabel('invalid', 'disputes')).toBeUndefined();
        expect(subTabLabel('economy', 'nonexistent')).toBeUndefined();
    });
});

describe('useSectionSubTab', () => {
    it('initializes with the provided initial subtab', () => {
        const { result } = renderHook(() => useSectionSubTab('directory'));
        expect(result.current[0]).toBe('directory');
    });

    it('updates subtab state and triggers onChange callback', () => {
        const onChange = vi.fn();
        const { result } = renderHook(() => useSectionSubTab<string>('directory', onChange));

        act(() => {
            result.current[1]('invites');
        });

        expect(result.current[0]).toBe('invites');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('invites');
    });

    it('syncs internal state when initial prop changes', () => {
        const { result, rerender } = renderHook(({ initial }) => useSectionSubTab<string>(initial), {
            initialProps: { initial: 'directory' },
        });

        expect(result.current[0]).toBe('directory');

        rerender({ initial: 'roles' });

        expect(result.current[0]).toBe('roles');
    });
});
