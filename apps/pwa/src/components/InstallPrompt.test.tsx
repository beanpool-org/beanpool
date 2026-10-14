import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { InstallPrompt } from './InstallPrompt';
import { useCoversScreen } from '../lib/screen-cover';

/** A screen that fills the phone (Start a community, a report form) while it is drawn. */
function Cover() {
    useCoversScreen();
    return null;
}
const banner = () => screen.queryByRole('region', { name: 'App installation prompt' });

describe('InstallPrompt', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders after delay when not installed and not dismissed', () => {
        render(<InstallPrompt />);
        expect(screen.queryByRole('region', { name: 'App installation prompt' })).toBeNull();

        act(() => {
            vi.advanceTimersByTime(2000);
        });

        const prompt = screen.getByRole('region', { name: 'App installation prompt' });
        expect(prompt).toBeInTheDocument();

        const closeBtn = screen.getByRole('button', { name: 'Dismiss install prompt' });
        expect(closeBtn.style.minWidth).toBe('44px');
        expect(closeBtn.style.minHeight).toBe('44px');

        const howBtn = screen.getByRole('button', { name: 'How?' });
        expect(howBtn.style.minWidth).toBe('44px');
        expect(howBtn.style.minHeight).toBe('44px');

        const neverBtn = screen.getByRole('button', { name: /Don’t show this again|Don't show this again/ });
        expect(neverBtn.style.minHeight).toBe('44px');
    });

    it('toggles steps visibility when How? button is clicked', () => {
        render(<InstallPrompt />);
        act(() => {
            vi.advanceTimersByTime(2000);
        });

        const howBtn = screen.getByRole('button', { name: 'How?' });
        expect(screen.queryByText(/iPhone \/ iPad:|Android:|Desktop:/)).toBeNull();

        fireEvent.click(howBtn);
        expect(screen.getByText(/iPhone \/ iPad:|Android:|Desktop:/)).toBeInTheDocument();

        fireEvent.click(howBtn);
        expect(screen.queryByText(/iPhone \/ iPad:|Android:|Desktop:/)).toBeNull();
    });

    it('dismisses when close button is clicked', () => {
        render(<InstallPrompt />);
        act(() => {
            vi.advanceTimersByTime(2000);
        });

        const closeBtn = screen.getByRole('button', { name: 'Dismiss install prompt' });
        fireEvent.click(closeBtn);

        expect(screen.queryByRole('region', { name: 'App installation prompt' })).toBeNull();
        expect(localStorage.getItem('beanpool-install-dismissed')).toBeTruthy();
    });

    it('dismisses forever when "Don\'t show this again" is clicked', () => {
        render(<InstallPrompt />);
        act(() => {
            vi.advanceTimersByTime(2000);
        });

        const neverBtn = screen.getByRole('button', { name: /Don’t show this again|Don't show this again/ });
        fireEvent.click(neverBtn);

        expect(screen.queryByRole('region', { name: 'App installation prompt' })).toBeNull();
        expect(localStorage.getItem('beanpool-install-dismissed-forever')).toBe('1');
    });

    // Rehearsal 14 Oct, B1: at 320 px the banner took the taps meant for the tour's Next and Skip, and sat over Start a
    // community and the report form.
    it('stays down while App holds it back (the tour), and comes up 2 s after that ends', () => {
        const { rerender } = render(<InstallPrompt hidden />);
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(banner()).toBeNull();

        rerender(<InstallPrompt hidden={false} />);
        act(() => { vi.advanceTimersByTime(1_900); });
        expect(banner()).toBeNull();
        act(() => { vi.advanceTimersByTime(100); });
        expect(banner()).toBeInTheDocument();

        // The tour taken again: down at once.
        rerender(<InstallPrompt hidden />);
        expect(banner()).toBeNull();
    });

    it('stays down while a screen that fills the phone is open, and comes back once it closes', () => {
        const { rerender } = render(<><InstallPrompt /><Cover /></>);
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(banner()).toBeNull();

        rerender(<><InstallPrompt /></>);
        act(() => { vi.advanceTimersByTime(2_000); });
        expect(banner()).toBeInTheDocument();

        rerender(<><InstallPrompt /><Cover /></>);
        expect(banner()).toBeNull();
    });

    it('a banner put away is not brought back by a screen closing', () => {
        const { rerender } = render(<><InstallPrompt /></>);
        act(() => { vi.advanceTimersByTime(2_000); });
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss install prompt' }));
        rerender(<><InstallPrompt /><Cover /></>);
        rerender(<><InstallPrompt /></>);
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(banner()).toBeNull();
    });

    it("its words are the brand's white ink on its navy, never the page's ink (1.01:1 in light)", () => {
        render(<InstallPrompt />);
        act(() => { vi.advanceTimersByTime(2_000); });
        fireEvent.click(screen.getByRole('button', { name: 'How?' }));
        const region = banner()!;
        expect(screen.getByText('Install BeanPool').style.color).toBe('var(--bp-commit-on)');
        expect(screen.getByRole('button', { name: 'Hide steps' }).style.color).toBe('var(--bp-commit-on)');
        // At 320 px with 130 % text a squeezed button let 'Hide steps' run out past its fill.
        expect(screen.getByRole('button', { name: 'Hide steps' }).style.whiteSpace).not.toBe('nowrap');
        expect(screen.getByText(/^(iPhone \/ iPad|Android|Desktop):$/).style.color).toBe('var(--bp-commit-on)');
        const pageInk = Array.from(region.querySelectorAll<HTMLElement>('*')).filter(el => el.style.color.includes('--text-primary'));
        expect(pageInk).toEqual([]);
    });
});
