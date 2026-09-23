import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from '../../App';

/**
 * The phone layout of node Settings: the top bar names the screen, the menu opens as a sheet, and the browser's Back
 * button walks back through screens (closing the menu or manual first) instead of leaving Settings at once.
 * jsdom has no layout, so the `lg:` switch between rail and top bar is not exercised here: the width check
 * (e2e/phone-width.mjs) covers that in a real browser.
 */

/**
 * jsdom runs a history traversal on a later task, so `history.back()` has not happened when it returns and the
 * popstate that moves the app has not fired yet. Waiting a fixed few milliseconds for it is what made this file flake
 * on a loaded runner: the wait ran out before the event arrived, so the assertion read the screen you were still on,
 * and the traversal then landed inside the next test and took that one down too. Wait for the event itself instead.
 */
async function awaitingPop(step: () => void) {
    await act(async () => {
        const landed = new Promise<void>(resolve => {
            window.addEventListener('popstate', () => resolve(), { once: true });
        });
        step();
        await landed;
    });
}

/** The browser's Back button. */
function back() {
    return awaitingPop(() => window.history.back());
}

function topBar() {
    return screen.getByRole('button', { name: 'Menu' }).closest('header') as HTMLElement;
}

describe('Settings on a phone', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem('bp-admin-token', 'mock-password');
        window.history.replaceState(null, '');
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [], members: [{ pubkey: 'a'.repeat(64), name: 'A' }] }),
        })));
    });

    it('names the current screen in the top bar and follows sub-tab changes', async () => {
        await act(async () => { render(<App isFleetMode={false} />); });
        expect(topBar().textContent).toContain('Home');

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /people & safety/i })); });
        expect(topBar().textContent).toContain('People & Safety › Members');

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /owners & admins/i })); });
        expect(topBar().textContent).toContain('People & Safety › Owners & admins');
    });

    it('Back returns to the previous screen and sub-tab', async () => {
        await act(async () => { render(<App isFleetMode={false} />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /shared projects & economy/i })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /escrow disputes/i })); });
        expect(topBar().textContent).toContain('Escrow Disputes');

        await back();
        expect(topBar().textContent).toContain('Shared Projects & Economy › Enterprises');
        expect(screen.getByText(/commons pool, shared enterprises/i)).toBeInTheDocument();

        await back();
        expect(topBar().textContent).toContain('Home');
    });

    it('the menu opens as a sheet, takes you to a sub-tab, and Back does not reopen it', async () => {
        await act(async () => { render(<App isFleetMode={false} />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Menu' })); });
        let menu = screen.getByRole('dialog', { name: 'Settings menu' });

        await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: /appliance & data/i })); });
        await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: 'Diagnostics & Logs' })); });
        expect(screen.queryByRole('dialog', { name: 'Settings menu' })).not.toBeInTheDocument();
        expect(topBar().textContent).toContain('Appliance & Data › Diagnostics & Logs');

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Menu' })); });
        menu = screen.getByRole('dialog', { name: 'Settings menu' });
        // The current section starts open, its screens listed under it.
        expect(within(menu).getByRole('button', { name: /appliance & data/i }).getAttribute('aria-expanded')).toBe('true');
        await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: 'Public Address' })); });
        expect(topBar().textContent).toContain('Appliance & Data › Public Address');

        await back();
        expect(screen.queryByRole('dialog', { name: 'Settings menu' })).not.toBeInTheDocument();
        expect(topBar().textContent).toContain('Appliance & Data › Diagnostics & Logs');
        await back();
        expect(topBar().textContent).toContain('Home');
    });

    it('a section opens in place and the menu stays up; only a screen, or Home, navigates and closes it', async () => {
        await act(async () => { render(<App isFleetMode={false} />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Menu' })); });
        const menu = screen.getByRole('dialog', { name: 'Settings menu' });
        const people = within(menu).getByRole('button', { name: /people & safety/i });
        const economy = within(menu).getByRole('button', { name: /shared projects & economy/i });
        expect(people.getAttribute('aria-expanded')).toBe('false');
        expect(within(menu).getByRole('button', { name: /^\W*Home$/ }).hasAttribute('aria-expanded')).toBe(false);
        expect(within(menu).queryByRole('button', { name: 'Owners & admins' })).toBeNull();

        await act(async () => { fireEvent.click(people); });
        expect(screen.getByRole('dialog', { name: 'Settings menu' })).toBeInTheDocument();
        expect(people.getAttribute('aria-expanded')).toBe('true');
        expect(within(menu).getByRole('button', { name: 'Owners & admins' })).toBeTruthy();
        expect(topBar().textContent).toContain('Home');

        // One section open at a time.
        await act(async () => { fireEvent.click(economy); });
        expect(people.getAttribute('aria-expanded')).toBe('false');
        expect(economy.getAttribute('aria-expanded')).toBe('true');
        expect(within(menu).queryByRole('button', { name: 'Owners & admins' })).toBeNull();
        expect(within(menu).getByRole('button', { name: 'Escrow Disputes' })).toBeTruthy();
        // Tapping it again shuts it.
        await act(async () => { fireEvent.click(economy); });
        expect(economy.getAttribute('aria-expanded')).toBe('false');
        expect(within(menu).queryByRole('button', { name: 'Escrow Disputes' })).toBeNull();
        expect(topBar().textContent).toContain('Home');

        await act(async () => { fireEvent.click(people); });
        await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: 'Owners & admins' })); });
        expect(screen.queryByRole('dialog', { name: 'Settings menu' })).not.toBeInTheDocument();
        expect(topBar().textContent).toContain('People & Safety › Owners & admins');

        // Home has no screens of its own: it navigates and closes at once.
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Menu' })); });
        await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: 'Settings menu' })).getByRole('button', { name: /^\W*Home$/ })); });
        expect(screen.queryByRole('dialog', { name: 'Settings menu' })).not.toBeInTheDocument();
        expect(topBar().textContent).toContain('Home');
        await back();
        expect(topBar().textContent).toContain('People & Safety › Owners & admins');
    });

    it('Back closes the open menu, and ✕ closes it without costing a Back', async () => {
        await act(async () => { render(<App isFleetMode={false} />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /bulletin & news/i })); });

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Menu' })); });
        expect(screen.getByRole('dialog', { name: 'Settings menu' })).toBeInTheDocument();
        await back();
        expect(screen.queryByRole('dialog', { name: 'Settings menu' })).not.toBeInTheDocument();
        expect(topBar().textContent).toContain('Bulletin & News');

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Menu' })); });
        // ✕ drops the menu's own history entry (closeMenuEntry), so this click goes Back too.
        await awaitingPop(() => { fireEvent.click(screen.getByRole('button', { name: 'Close menu' })); });
        expect(screen.queryByRole('dialog', { name: 'Settings menu' })).not.toBeInTheDocument();
        await back();
        expect(topBar().textContent).toContain('Home');
    });

    it('Back closes the manual opened from the menu', async () => {
        await act(async () => { render(<App isFleetMode={false} />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /people & safety/i })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Menu' })); });
        const menu = screen.getByRole('dialog', { name: 'Settings menu' });
        await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: /manual: running your community/i })); });
        expect(screen.getByRole('dialog', { name: 'Operator manual' })).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Settings menu' })).not.toBeInTheDocument();

        await back();
        expect(screen.queryByRole('dialog', { name: 'Operator manual' })).not.toBeInTheDocument();
        expect(topBar().textContent).toContain('People & Safety');
        await back();
        expect(topBar().textContent).toContain('Home');
    });

    it('with the desktop sidebar hidden, Log Out is still one press away', async () => {
        localStorage.setItem('bp-settings-sidebar', 'hidden');
        await act(async () => { render(<App isFleetMode={false} />); });
        const bar = screen.getByRole('button', { name: 'Show menu' }).parentElement as HTMLElement;
        await act(async () => { fireEvent.click(within(bar).getByRole('button', { name: 'Log Out' })); });
        expect(sessionStorage.getItem('bp-admin-token')).toBeNull();
    });
});
