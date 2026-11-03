/**
 * A Home card's "…" (components/HomeCard.tsx): version 1's Hide, and the card frame's (CARD-FRAME §1.3, slice F3)
 * Settings… · Arrange · Remove, named by the card's screen-reader name, never its caption. The moves are in Arrange.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardMenu, HomeCard, PackedBlock } from './HomeCard';

describe('HomeCard menu', () => {
    it('the card frame: Settings… · Arrange · Remove, labelled by the saved search\'s words; the caption stays fixed words', () => {
        const onRemove = vi.fn();
        const onSettings = vi.fn();
        render(
            <HomeCard id="search-aaaa" title="A saved search"
                menu={{ label: '"eggs"', onRemove, onSettings, onArrange: vi.fn() }}>
                <p>body</p>
            </HomeCard>,
        );
        expect(screen.getByRole('heading', { name: 'A saved search' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Card options for "eggs"' }));
        expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['…', 'Settings…', 'Arrange', 'Remove']);
        expect(screen.queryByText('Hide')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Remove "eggs" from Home' }));
        expect(onRemove).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Card options for "eggs"' }));
        fireEvent.click(screen.getByTestId('home-menu-settings'));
        expect(onSettings).toHaveBeenCalled();
    });

    it('version 1: Hide, as before', () => {
        const onHide = vi.fn();
        render(<HomeCard id="events" title="Coming up" menu={{ onHide }}><p>body</p></HomeCard>);
        fireEvent.click(screen.getByRole('button', { name: 'Card options for Coming up' }));
        expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['…', 'Hide']);
        fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
        expect(onHide).toHaveBeenCalled();
    });

    it('prevents header collapse: heading does not shrink and aside container is flexible and constrained', () => {
        const { container } = render(
            <HomeCard
                id="decide"
                title="Decide"
                titleAside={<span className="text-xs font-normal text-text-secondary min-w-0 break-words text-right">2 Decisions open, the first closes Tue · 2 polls open</span>}
                menu={{ label: 'Decide' }}
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
        const asideContainer = container.querySelector('.flex.items-center.justify-between > div:last-child');
        expect(asideContainer?.className).toContain('min-w-0');
        expect(asideContainer?.className).not.toContain('flex-1');
        expect(asideContainer?.className).not.toContain('shrink-0');
    });

    it('CardMenu without ink preserves -mt-2 text-text-secondary hover:text-text-primary for the safety card', () => {
        render(<CardMenu title="Your way back in" />);
        const button = screen.getByRole('button', { name: 'Card options for Your way back in' });
        expect(button.className).toContain('-mt-2');
        expect(button.className).toContain('text-text-secondary');
        expect(button.className).toContain('hover:text-text-primary');
        expect(button.style.color).toBe('');
    });

    it('CardMenu with ink takes its colour from the band and none of the safety card\'s classes', () => {
        render(<CardMenu title="New in the Market" ink="var(--bp-card-orange-ink)" />);
        const button = screen.getByRole('button', { name: 'Card options for New in the Market' });
        expect(button.className).not.toContain('-mt-2');
        expect(button.className).toContain('-my-1');
        expect(button.className).toContain('min-h-[44px]');
        expect(button.className).not.toContain('text-text-secondary');
        expect(button.className).not.toContain('hover:text-text-primary');
        expect(button.getAttribute('style')).toContain('var(--bp-card-orange-ink)');
    });
});

describe('HomeCard caption band (S1, scratch/fable-design/DESIGN-home-look-fable.md §2.1, §5)', () => {
    it('the band carries the hue and the "…" the ink', () => {
        const { container } = render(
            <HomeCard
                id="market"
                title="New in the Market"
                hue="orange"
                menu={{ label: 'Market' }}
            >
                <p>body</p>
            </HomeCard>,
        );
        const band = container.querySelector('[data-testid="card-band-market"]') as HTMLElement;
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
        const sageBand = sageCard.querySelector('[data-testid="card-band-needs"]') as HTMLElement;
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
        const amberBand = amberCard.querySelector('[data-testid="card-band-needs"]') as HTMLElement;
        expect(amberBand).toBeInTheDocument();
        expect(amberBand.style.backgroundColor).toBe('var(--bp-card-amber-tint)');
        expect(amberBand.style.color).toBe('var(--bp-card-amber-ink)');
        const amberSection = amberCard.querySelector('section') as HTMLElement;
        expect(amberSection.style.borderColor).toBe('var(--bp-card-amber-ink)');
    });

    it('band and aside container are vertically centred (items-center)', () => {
        const { container } = render(
            <HomeCard id="market" title="New in the Market" hue="orange">
                <p>body</p>
            </HomeCard>,
        );
        const band = container.querySelector('[data-testid="card-band-market"]') as HTMLElement;
        expect(band.className).toContain('items-center');
        expect(band.className).not.toContain('items-start');
        const aside = band.querySelector('div:last-child') as HTMLElement;
        expect(aside.className).toContain('items-center');
        expect(aside.className).not.toContain('items-start');
    });

    describe('reporting a height after mount (PR #2748)', () => {
        let observers: { callback: () => void; disconnected: boolean }[] = [];
        let height = 0;
        let spy: { mockRestore(): void } | null = null;
        let reads = 0;
        beforeEach(() => {
            observers = [];
            height = 240;
            reads = 0;
            vi.stubGlobal('ResizeObserver', class {
                entry: { callback: () => void; disconnected: boolean };
                constructor(callback: () => void) { this.entry = { callback, disconnected: false }; observers.push(this.entry); }
                observe() {}
                disconnect() { this.entry.disconnected = true; }
            });
            spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => { reads += 1; return height; });
        });
        afterEach(() => { spy?.mockRestore(); vi.unstubAllGlobals(); });
        const fire = () => act(() => { observers.filter(o => !o.disconnected).forEach(o => o.callback()); });

        it('a HomeCard tells every later height, and stops when it goes', () => {
            const onHeight = vi.fn();
            const { unmount } = render(<HomeCard id="tips" title="Tips" onHeight={onHeight}><p>body</p></HomeCard>);
            height = 320;
            fire();
            expect(onHeight).toHaveBeenLastCalledWith(320);
            unmount();
            onHeight.mockClear();
            fire();
            expect(onHeight).not.toHaveBeenCalled();
        });

        it('a HomeCard follows the newest onHeight it was given', () => {
            const first = vi.fn();
            const second = vi.fn();
            const { rerender } = render(<HomeCard id="tips" title="Tips" onHeight={first}><p>body</p></HomeCard>);
            rerender(<HomeCard id="tips" title="Tips" onHeight={second}><p>body</p></HomeCard>);
            first.mockClear();
            height = 320;
            fire();
            expect(second).toHaveBeenLastCalledWith(320);
            expect(first).not.toHaveBeenCalled();
        });

        it('with no onHeight it reads no height at all', () => {
            render(<HomeCard id="tips" title="Tips"><p>body</p></HomeCard>);
            fire();
            expect(reads).toBe(0);
        });

        it('a PackedBlock is measured the same way, with its tag, testid, style and class kept', () => {
            const onHeight = vi.fn();
            render(<PackedBlock tag="p" onHeight={onHeight} data-testid="note" className="mb-3" style={{ gridRow: '1 / span 4' }}>A note</PackedBlock>);
            expect(onHeight).toHaveBeenCalledWith(240);
            height = 300;
            fire();
            expect(onHeight).toHaveBeenLastCalledWith(300);
            const note = screen.getByTestId('note');
            expect(note.tagName).toBe('P');
            expect(note.className).toBe('mb-3');
            expect(note.style.gridRow).toBe('1 / span 4');
        });

        it('with no ResizeObserver there is nothing to report, and no error', () => {
            vi.stubGlobal('ResizeObserver', undefined);
            const onHeight = vi.fn();
            render(<PackedBlock onHeight={onHeight}>A block</PackedBlock>);
            expect(onHeight).not.toHaveBeenCalled();
        });
    });

    it('reports its measured height via onHeight callback (DESIGN-home-layout-fable.md §3.1, slice L1)', () => {
        const onHeight = vi.fn();
        vi.stubGlobal('ResizeObserver', class {
            observe() {}
            disconnect() {}
        });
        const offsetSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240);
        try {
            render(
                <HomeCard id="tips" title="Tips" onHeight={onHeight}>
                    <p>body</p>
                </HomeCard>,
            );
            expect(onHeight).toHaveBeenCalledWith(240);
        } finally {
            offsetSpy.mockRestore();
            vi.unstubAllGlobals();
        }
    });
});

