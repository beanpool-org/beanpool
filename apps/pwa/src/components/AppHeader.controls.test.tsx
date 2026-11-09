/**
 * One set of "?", Invite and Settings at every width (Marty, 9 Nov 2026, two screenshots of the web app on a computer):
 * the side bar's bottom-left had the controls beside the profile pill, AND a pill at the top right drew them again.
 * "I don't think we need the duplication - the one bottom left is the better option as it is also near the profile pill.
 * when it reactive resizes to mobile phone size it should go up the top right like the phone app does."
 *
 * The cause: the mobile header is `md:hidden` but carries its own inline `display: flex`, which wins, so the header (and
 * its pill) still drew beside the side bar at 768 px and up. jsdom applies no stylesheet, so a CSS class would prove
 * nothing here; the pill is drawn (or not) from the same media query the side bar's `md:` uses, and these tests set
 * that query's answer the way a browser at each width does.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileHeader, SidebarStatus } from './AppHeader';

vi.mock('./SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status">Synced</div> }));
vi.mock('./NeedsYouIcons', () => ({ NeedsYouIcons: () => null }));

const realMatchMedia = window.matchMedia;

/** A browser window `px` wide: every `(min-width: N px)` query answers for it, and `resize` fires the change events. */
function windowOf(px: number) {
    let width = px;
    const listeners = new Set<() => void>();
    window.matchMedia = ((media: string) => {
        const min = Number(/min-width:\s*(\d+)px/.exec(media)?.[1] ?? 0);
        return {
            get matches() { return width >= min; },
            media,
            onchange: null,
            addEventListener: (_type: string, fn: () => void) => { listeners.add(fn); },
            removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn); },
            addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
    return { resize(next: number) { width = next; act(() => { listeners.forEach(fn => fn()); }); } };
}

/** App's two places for the controls, as App.tsx mounts them: the side bar's footer and the header row. */
function Both({ isGuest = false }: { isGuest?: boolean }) {
    return (
        <>
            <aside>
                <SidebarStatus isGuest={isGuest} identityPubkey="me" activeTab="home" onNavigate={() => {}} settingsSeen={false} setShowSettings={() => {}} />
            </aside>
            <MobileHeader
                activeTab="home" showSettings={false} title="Home" isGuest={isGuest} identityPubkey="me" displayVersion="1.0.0"
                communityStatus={null} onTitleClick={() => {}} settingsSeen={false} setShowSettings={() => {}}
                onOpenProfile={() => {}} onNavigate={() => {}}
            />
        </>
    );
}

const pill = () => screen.queryByTestId('header-pill');
const side = () => within(document.querySelector('aside') as HTMLElement);

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; });

describe('the top-right pill and the side bar\'s controls: exactly one set at every width', () => {
    it.each([768, 1024, 1280, 1920])('at %i px (the side bar shows): no pill at the top right, the side bar\'s controls are the set', (px) => {
        windowOf(px);
        render(<Both />);
        expect(pill()).toBeNull();
        for (const id of ['header-profile', 'header-help', 'header-invite', 'header-settings']) expect(screen.queryByTestId(id)).toBeNull();
        expect(side().getByTestId('sidebar-help')).toBeInTheDocument();
        expect(side().getByTestId('sidebar-invite')).toBeInTheDocument();
        expect(side().getByTestId('sidebar-settings')).toBeInTheDocument();
    });

    it.each([320, 375, 767])('at %i px (no side bar): the pill is the set, profile, "?", Invite and Settings', (px) => {
        windowOf(px);
        render(<Both />);
        const p = within(pill() as HTMLElement);
        expect(p.getByTestId('header-profile')).toBeInTheDocument();
        expect(p.getByTestId('header-help')).toBeInTheDocument();
        expect(p.getByTestId('header-invite')).toBeInTheDocument();
        expect(p.getByTestId('header-settings')).toBeInTheDocument();
    });

    it('a guest (no Invite) has the same rule: the side bar\'s "?" and Settings at 1280, the pill\'s at 375', () => {
        const win = windowOf(1280);
        render(<Both isGuest />);
        expect(pill()).toBeNull();
        expect(side().getByTestId('sidebar-help')).toBeInTheDocument();
        expect(side().getByTestId('sidebar-settings')).toBeInTheDocument();
        expect(side().queryByTestId('sidebar-invite')).toBeNull();

        win.resize(375);
        const p = within(pill() as HTMLElement);
        expect(p.getByTestId('header-help')).toBeInTheDocument();
        expect(p.getByTestId('header-settings')).toBeInTheDocument();
        expect(p.queryByTestId('header-invite')).toBeNull();
    });

    it('resizing across 768 px moves the set: down to a phone it goes up to the top right, up to a computer it leaves it', () => {
        const win = windowOf(1280);
        render(<Both />);
        expect(pill()).toBeNull();

        win.resize(375);
        expect(pill()).toBeInTheDocument();

        win.resize(768);
        expect(pill()).toBeNull();

        win.resize(767);
        expect(pill()).toBeInTheDocument();
    });

    it('where the browser has no media query to ask, the header draws its pill (never none)', () => {
        (window as { matchMedia?: unknown }).matchMedia = undefined;
        render(<Both />);
        expect(pill()).toBeInTheDocument();
    });

    it('the pill still reads the same on a phone: its profile button opens the member\'s own profile', () => {
        windowOf(375);
        const opened = vi.fn();
        render(
            <MobileHeader
                activeTab="home" showSettings={false} title="Home" isGuest={false} identityPubkey="me" displayVersion="1.0.0"
                communityStatus={null} onTitleClick={() => {}} settingsSeen={false} setShowSettings={() => {}}
                onOpenProfile={opened} onNavigate={() => {}}
            />,
        );
        act(() => { screen.getByTestId('header-profile').click(); });
        expect(opened).toHaveBeenCalledWith('me');
    });
});
