import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from '../../App';

/**
 * The phone layout of node Settings: the top bar names the screen, the menu opens as a sheet, and the browser's Back
 * button walks back through screens (closing the menu or manual first) instead of leaving Settings at once.
 * jsdom has no layout, so the `lg:` switch between rail and top bar is not exercised here: the width check
 * (e2e/phone-width.mjs) covers that in a real browser.
 */

async function back() {
    await act(async () => {
        window.history.back();
        await new Promise(r => setTimeout(r, 30));
    });
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
        expect(screen.queryByRole('dialog', { name: 'Settings menu' })).not.toBeInTheDocument();
        expect(topBar().textContent).toContain('Appliance & Data › Diagnostics & Logs');

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Menu' })); });
        menu = screen.getByRole('dialog', { name: 'Settings menu' });
        // The current section's screens are listed under it.
        await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: 'Public Address' })); });
        expect(topBar().textContent).toContain('Appliance & Data › Public Address');

        await back();
        expect(screen.queryByRole('dialog', { name: 'Settings menu' })).not.toBeInTheDocument();
        expect(topBar().textContent).toContain('Appliance & Data › Diagnostics & Logs');
        await back();
        expect(topBar().textContent).toContain('Home');
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
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close menu' })); });
        await act(async () => { await new Promise(r => setTimeout(r, 30)); });
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
});
