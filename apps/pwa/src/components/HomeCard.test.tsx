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

describe('HomeCard caption band (S1, scratch/fable-design/DESIGN-home-look-fable.md §2.1, §5)', () => {
    it('the band carries the hue and the "…" the ink', () => {
        const { container } = render(
            <HomeCard
                id="market"
                title="New in the Market"
                hue="orange"
                menu={{ label: 'Market', canMoveUp: false, canMoveDown: false, onMove: vi.fn() }}
            >
                <p>body</p>
            </HomeCard>,
        );
        const band = container.querySelector('[data-testid="home-card-market-band"]') as HTMLElement;
        expect(band).toBeInTheDocument();
        expect(band.style.backgroundColor).toBe('var(--bp-card-orange-tint)');
        expect(band.style.color).toBe('var(--bp-card-orange-ink)');
        const menuBtn = screen.getByRole('button', { name: 'Card options for Market' });
        expect(menuBtn.style.color).toBe('var(--bp-card-orange-ink)');
    });

    it('Needs you is amber only with an accent item (otherwise sage)', () => {
        const { container: sageCard } = render(
            <HomeCard id="needs" title="Needs you" hue="sage" accent={false}>
                <p>body</p>
            </HomeCard>,
        );
        const sageBand = sageCard.querySelector('[data-testid="home-card-needs-band"]') as HTMLElement;
        expect(sageBand).toBeInTheDocument();
        expect(sageBand.style.backgroundColor).toBe('var(--bp-card-sage-tint)');
        expect(sageBand.style.color).toBe('var(--bp-card-sage-ink)');
        const sageSection = sageCard.querySelector('section') as HTMLElement;
        expect(sageSection.style.borderColor).not.toBe('var(--bp-card-amber-ink)');

        const { container: amberCard } = render(
            <HomeCard id="needs" title="Needs you" hue="amber" accent={true}>
                <p>body</p>
            </HomeCard>,
        );
        const amberBand = amberCard.querySelector('[data-testid="home-card-needs-band"]') as HTMLElement;
        expect(amberBand).toBeInTheDocument();
        expect(amberBand.style.backgroundColor).toBe('var(--bp-card-amber-tint)');
        expect(amberBand.style.color).toBe('var(--bp-card-amber-ink)');
        const amberSection = amberCard.querySelector('section') as HTMLElement;
        expect(amberSection.style.borderColor).toBe('var(--bp-card-amber-ink)');
    });
});

