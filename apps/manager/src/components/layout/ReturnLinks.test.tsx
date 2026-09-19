import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { useState } from 'react';
import { FleetSidebar, type TabId } from './FleetSidebar';
import { PhoneTopBar } from './PhoneNav';
import { ManualProvider } from '../manual/Manual';
import { backLink, profileLink, type CameFrom } from '../../lib/came-from';
import { nextSidebarMode, readSidebarMode, SIDEBAR_MODE_KEY, useSidebarMode, type SidebarMode } from '../../lib/sidebar-mode';

const KEY = 'cd'.repeat(32);
const base = {
    profiles: [{ id: 'local-node', name: 'Local', url: 'https://test.beanpool.org' }],
    activeProfileId: 'local-node',
    onSelectNode: vi.fn(),
    onOpenAddModal: vi.fn(),
    onEditNode: vi.fn(),
    onRemoveNode: vi.fn(),
    activeTab: 'home' as TabId,
    onSelectTab: vi.fn(),
    isFleetMode: false,
    communityName: 'Example',
};
const links = (from: CameFrom, member: string | null = KEY) => ({ back: backLink(from), profile: profileLink(from, member) });

describe('the way back from Settings, in the sidebar, the phone menu and the phone top bar', () => {
    it.each([
        ['app', 'Back to the BeanPool app', 'beanpool://foreground', `beanpool://public-profile?publicKey=${KEY}`],
        ['pwa', 'Back to BeanPool', '/app', `/app#profile=${KEY}`],
        ['unknown', 'Open the BeanPool web app', '/app', `/app#profile=${KEY}`],
    ] as const)('from %s: "%s"', (from, label, href, profileHref) => {
        const { unmount } = render(<FleetSidebar {...base} returnLinks={links(from)} />);
        const nav = screen.getByRole('navigation', { name: 'Leave Settings' });
        expect(within(nav).getByRole('link', { name: label }).getAttribute('href')).toBe(href);
        expect(within(nav).getByRole('link', { name: 'View my profile' }).getAttribute('href')).toBe(profileHref);
        unmount();

        render(<FleetSidebar {...base} variant="drawer" onClose={() => {}} returnLinks={links(from)} />);
        expect(screen.getByRole('link', { name: label }).className).toContain('min-h-[48px]');
        expect(screen.getByRole('link', { name: 'View my profile' }).className).toContain('min-h-[48px]');
    });

    it('hides "View my profile" under password sign-in', () => {
        render(<FleetSidebar {...base} returnLinks={links('pwa', null)} />);
        expect(screen.getByRole('link', { name: 'Back to BeanPool' })).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'View my profile' })).toBeNull();
    });

    it('the phone top bar carries the back link as a 48px target named in full', () => {
        render(<PhoneTopBar communityName="Example" tab="home" menuOpen={false} onOpenMenu={() => {}} back={backLink('app')} />);
        const a = screen.getByRole('link', { name: 'Back to the BeanPool app' });
        expect(a.getAttribute('href')).toBe('beanpool://foreground');
        expect(a.className).toContain('min-h-[48px]');
        expect(a.className).toContain('min-w-[48px]');
    });

    it('never appears in the fleet manager', () => {
        render(<FleetSidebar {...base} isFleetMode activeTab="overview" returnLinks={links('app')} />);
        expect(screen.queryByRole('navigation', { name: 'Leave Settings' })).toBeNull();
    });
});

function Harness({ initial }: { initial?: SidebarMode }) {
    const [mode, setMode] = useState<SidebarMode>(initial ?? 'full');
    return (
        <ManualProvider>
            <FleetSidebar {...base} returnLinks={links('pwa')} mode={mode} onCollapse={() => setMode(nextSidebarMode(mode))} />
            {mode === 'hidden' && <button onClick={() => setMode('full')} aria-label="Show menu" aria-expanded={false}>☰</button>}
        </ManualProvider>
    );
}

describe('the collapsing desktop sidebar (full → icons → hidden)', () => {
    beforeEach(() => {
        try { localStorage.clear(); } catch { /* jsdom */ }
    });

    it('steps full → icon strip → hidden, and ☰ brings it back in full', () => {
        render(<Harness />);
        const collapse = screen.getByRole('button', { name: 'Collapse menu to icons' });
        expect(collapse.getAttribute('aria-expanded')).toBe('true');
        expect(collapse.getAttribute('aria-controls')).toBe('settings-sidebar');
        expect(screen.getByText('Shared Projects & Economy')).toBeTruthy();

        fireEvent.click(collapse);
        const hide = screen.getByRole('button', { name: 'Hide menu' });
        expect(hide.getAttribute('aria-expanded')).toBe('false');
        // Names are gone from view but every icon keeps its accessible name.
        expect(screen.queryByText('Shared Projects & Economy')).toBeNull();
        for (const name of ['Home', 'People & Safety', 'Shared Projects & Economy', 'Bulletin & News', 'Appliance & Data', 'Manual: running your community']) {
            expect(screen.getByRole('button', { name })).toBeTruthy();
        }
        expect(screen.getByRole('link', { name: 'Back to BeanPool' })).toBeTruthy();
        expect(screen.getByRole('link', { name: 'View my profile' })).toBeTruthy();

        fireEvent.click(hide);
        expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Show menu' }));
        expect(screen.getByRole('button', { name: 'Collapse menu to icons' })).toBeTruthy();
    });

    it('names each icon in a tooltip on keyboard focus and on hover; Escape dismisses it', () => {
        render(<Harness initial="icons" />);
        const people = screen.getByRole('button', { name: 'People & Safety' });
        fireEvent.focus(people);
        expect(screen.getByRole('tooltip').textContent).toBe('People & Safety');
        fireEvent.keyDown(people, { key: 'Escape' });
        expect(screen.queryByRole('tooltip')).toBeNull();
        fireEvent.mouseEnter(screen.getByRole('link', { name: 'Back to BeanPool' }));
        expect(screen.getByRole('tooltip').textContent).toBe('Back to BeanPool');
        fireEvent.mouseLeave(screen.getByRole('link', { name: 'Back to BeanPool' }));
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('the icon strip still says a section needs attention, in its name', () => {
        render(<FleetSidebar {...base} mode="icons" onCollapse={() => {}} tabAlertCounts={{ members: { critical: 1, warning: 1 } }} />);
        expect(screen.getByRole('button', { name: 'People & Safety (2 alerts)' })).toBeTruthy();
    });

    it('remembers the choice, defaults to full, and survives storage that throws', () => {
        expect(readSidebarMode({ getItem: () => null })).toBe('full');
        expect(readSidebarMode({ getItem: () => 'icons' })).toBe('icons');
        expect(readSidebarMode({ getItem: () => 'hidden' })).toBe('hidden');
        expect(readSidebarMode({ getItem: () => 'sideways' })).toBe('full');
        expect(readSidebarMode({ getItem: () => { throw new Error('SecurityError'); } })).toBe('full');

        function Probe() {
            const [mode, setMode] = useSidebarMode();
            return <button onClick={() => setMode(nextSidebarMode(mode))}>{mode}</button>;
        }
        const { unmount } = render(<Probe />);
        fireEvent.click(screen.getByRole('button', { name: 'full' }));
        expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('icons');
        unmount();
        render(<Probe />);
        expect(screen.getByRole('button', { name: 'icons' })).toBeTruthy();
    });
});
