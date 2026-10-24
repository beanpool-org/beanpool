/**
 * A Home card's "…" (components/HomeCard.tsx): version 1's Hide · Move up · Move down, and the card frame's (CARD-FRAME
 * §1.3, slice F3) Settings… · Move up · Move down · Remove, named by the card's screen-reader name, never its caption.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeCard } from './HomeCard';

describe('HomeCard menu', () => {
    it('the card frame: Settings… · Move up · Move down · Remove, labelled by the saved search\'s words; the caption stays fixed words', () => {
        const onRemove = vi.fn();
        const onSettings = vi.fn();
        render(
            <HomeCard id="search-aaaa" title="A saved search"
                menu={{ label: '"eggs"', canMoveUp: true, canMoveDown: false, onRemove, onSettings, onMove: vi.fn() }}>
                <p>body</p>
            </HomeCard>,
        );
        expect(screen.getByRole('heading', { name: 'A saved search' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Card options for "eggs"' }));
        expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['…', 'Settings…', 'Move up', 'Move down', 'Remove']);
        expect(screen.queryByText('Hide')).toBeNull();
        expect(screen.getByRole('button', { name: 'Move down' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Remove "eggs" from Home' }));
        expect(onRemove).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Card options for "eggs"' }));
        fireEvent.click(screen.getByTestId('home-menu-settings'));
        expect(onSettings).toHaveBeenCalled();
    });

    it('version 1: Hide · Move up · Move down, as before', () => {
        const onHide = vi.fn();
        render(<HomeCard id="events" title="Coming up" menu={{ canMoveUp: false, canMoveDown: true, onHide, onMove: vi.fn() }}><p>body</p></HomeCard>);
        fireEvent.click(screen.getByRole('button', { name: 'Card options for Coming up' }));
        expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['…', 'Hide', 'Move up', 'Move down']);
        fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
        expect(onHide).toHaveBeenCalled();
    });

    it('prevents header collapse: heading does not shrink and aside container is flexible and constrained', () => {
        const { container } = render(
            <HomeCard
                id="decide"
                title="Decide"
                titleAside={<span className="text-xs font-normal text-text-secondary min-w-0 break-words text-right">2 Decisions open, the first closes Tue · 2 polls open</span>}
                menu={{ label: 'Decide', canMoveUp: false, canMoveDown: false, onMove: vi.fn() }}
            >
                <p>body</p>
            </HomeCard>,
        );
        const heading = screen.getByRole('heading', { name: 'Decide' });
        // The heading wraps (a community's own name is its title, up to 60 characters) and never shrinks below its longest
        // word; the aside takes only the room left and wraps too. Measured in Chromium at 320 px, 100% and 130% text (#2429).
        expect(heading.className).toContain('break-words');
        expect(heading.className).not.toContain('shrink-0');
        expect(heading.className).not.toContain('min-w-0');
        const asideContainer = container.querySelector('.flex.items-start.justify-between > div:last-child');
        expect(asideContainer?.className).toContain('min-w-0');
        expect(asideContainer?.className).not.toContain('flex-1');
        expect(asideContainer?.className).not.toContain('shrink-0');
    });
});
