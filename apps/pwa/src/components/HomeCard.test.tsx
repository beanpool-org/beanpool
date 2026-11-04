/**
 * A Home card's "…" (components/HomeCard.tsx): version 1's Hide, and the card frame's (CARD-FRAME §1.3, slice F3)
 * Settings… · Arrange · Remove, named by the card's screen-reader name, never its caption. The moves are in Arrange.
 */
import { useEffect } from 'react';
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

    describe('Arrange in place (DESIGN-home-arrange-in-place-fable.md §2.1, slice A1)', () => {
        const band = { label: 'Coming up', canUp: true, canDown: true, onMove: vi.fn() };

        it('the body goes quiet: dimmed, inert, hidden from a screen reader, taking no tap; the band, and its arrows, stay live', () => {
            render(<HomeCard id="events" title="Coming up" arrange={band} quiet menu={{ onRemove: vi.fn() }}><button type="button">Calendar ›</button></HomeCard>);
            const body = screen.getByTestId('card-body-events');
            expect(body).toHaveAttribute('aria-hidden', 'true');
            expect(body).toHaveAttribute('inert');
            expect(body.style.opacity).toBe('0.55');
            expect(body.style.pointerEvents).toBe('none');
            expect(body).toContainElement(screen.getByText('Calendar ›'));
            // The band is the card's own, with arrows where Tune and "…" were.
            expect(screen.queryByTestId('home-card-menu')).toBeNull();
            expect(screen.getByTestId('home-arrange-up-events')).toBeEnabled();
            expect(screen.getByTestId('card-band-events')).not.toHaveAttribute('inert');
            expect(screen.getByRole('heading', { name: 'Coming up' })).toBeInTheDocument();
        });

        it('a card that is not quiet has no quiet body, and a quiet one is the same box, the same element: no padding or margin of its own', () => {
            const { container, rerender } = render(<HomeCard id="events" title="Coming up"><p>body</p></HomeCard>);
            const section = () => container.querySelector('section')!;
            const band = () => screen.getByTestId('card-band-events');
            const plain = { section: section().className, band: band().className };
            const bodyElement = screen.getByText('body').parentElement;
            expect(screen.queryByTestId('card-body-events')).toBeNull();
            rerender(<HomeCard id="events" title="Coming up" arrange={{ label: 'Coming up', canUp: true, canDown: true }} quiet><p>body</p></HomeCard>);
            // Arrange used to fold the card (pb-2, mb-2): now the card is exactly the box it is on Home, or a card would change its cell.
            expect({ section: section().className, band: band().className }).toEqual(plain);
            const wrapper = screen.getByTestId('card-body-events');
            expect(wrapper).toBe(bodyElement);
            expect(wrapper.className).toBe('');
            expect(wrapper.parentElement).toBe(section());
        });

        // The body is one element for the card's whole life on Home, and quiet only changes its attributes: a body that is a
        // different element in Arrange unmounts everything in it (A1 review, 4 Nov: the Find card's AskedCommunity fetched
        // again and drew a shorter loading box, so cards packed after it could change cell; it scrolled itself again; Ask to
        // join lost what was typed). Measured: mounts 1 → 2 → 3 over Home → Arrange → Done.
        it('the body is mounted once across Home → Arrange → Done: its children are never unmounted and mounted again, and keep what they hold', () => {
            const mounted = vi.fn();
            const unmounted = vi.fn();
            function Probe() {
                useEffect(() => { mounted(); return unmounted; }, []);
                return <input data-testid="typed" aria-label="Typed" defaultValue="" />;
            }
            const arrangeBand = { label: 'Find', canUp: true, canDown: true };
            const card = (inArrange: boolean) => (
                <HomeCard id="find" title="Find" arrange={inArrange ? arrangeBand : undefined} quiet={inArrange}><Probe /><p>after</p></HomeCard>
            );
            const { rerender } = render(card(false));
            const input = screen.getByTestId('typed');
            fireEvent.change(input, { target: { value: 'a reason to join' } });
            const after = screen.getByText('after');
            expect(mounted).toHaveBeenCalledTimes(1);

            rerender(card(true));
            expect(mounted).toHaveBeenCalledTimes(1);
            expect(unmounted).not.toHaveBeenCalled();
            expect(screen.getByTestId('typed')).toBe(input);
            expect(screen.getByText('after')).toBe(after);
            expect(screen.getByTestId('card-body-find')).toHaveAttribute('inert');

            rerender(card(false));
            expect(mounted).toHaveBeenCalledTimes(1);
            expect(unmounted).not.toHaveBeenCalled();
            expect(screen.getByTestId('typed')).toBe(input);
            expect(screen.getByTestId('typed')).toHaveValue('a reason to join');
            expect(screen.getByText('after')).toBe(after);
        });

        it('on Home the one body element carries nothing quiet: not hidden, not inert, not dimmed, no pointer rule, and no test id or flag of Arrange', () => {
            render(<HomeCard id="events" title="Coming up"><button type="button">Calendar ›</button></HomeCard>);
            const wrapper = screen.getByText('Calendar ›').parentElement!;
            expect(wrapper.parentElement).toBe(document.querySelector('[data-testid="home-card-events"]'));
            expect(wrapper).not.toHaveAttribute('aria-hidden');
            expect(wrapper).not.toHaveAttribute('inert');
            expect(wrapper).not.toHaveAttribute('data-quiet');
            expect(wrapper).not.toHaveAttribute('data-testid');
            expect(wrapper.getAttribute('style') ?? '').toBe('');
            expect(wrapper.className).toBe('');
        });

        it('Stays here: no arrows, the word says so, and the body is as quiet as any', () => {
            render(<HomeCard id="community" title="Your community" arrange={{ label: 'Your community', stays: true }} quiet><p>body</p></HomeCard>);
            expect(screen.getByTestId('home-arrange-stays-community')).toHaveTextContent('Stays here');
            expect(screen.queryByTestId('home-arrange-up-community')).toBeNull();
            expect(screen.getByTestId('card-body-community')).toHaveAttribute('inert');
        });

        it('the arrows are 44 px targets that do not grow the 48 px band (-my-1, as the "…" has)', () => {
            render(<HomeCard id="events" title="Coming up" arrange={band}><p>body</p></HomeCard>);
            for (const dir of ['up', 'down']) {
                const arrow = screen.getByTestId(`home-arrange-${dir}-events`);
                expect(arrow.className).toContain('min-h-[44px]');
                expect(arrow.className).toContain('-my-1');
            }
            expect(screen.getByTestId('card-band-events').className).toContain('min-h-[48px]');
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

