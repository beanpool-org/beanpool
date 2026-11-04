/**
 * The strip of the cards with nothing to show now (DESIGN-home-arrange-in-place-fable.md §2.4, slice A1): a full row of
 * Home's grid in Arrange, one row a card, Settings… where the type has them, Remove on every row, no arrows.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArrangeStrip, type StripRow } from './ArrangeStrip';
import { backToEnglish, bypassing, showIn, xx } from '../words-xx.test-support';

const ROWS: StripRow[] = [
    { id: 'tips', name: 'Tips', note: 'All tips seen', hasSettings: false },
    { id: 'search-k7mq', name: '"eggs" (Offers)', hasSettings: true },
    { id: 'sky', name: 'Sun and moon', note: 'Add a place to see the sky.', hasSettings: true },
];

afterEach(() => backToEnglish());

describe('ArrangeStrip', () => {
    it('is one block headed "Nothing to show now", a row for each card with its name and what it would say', () => {
        render(<ArrangeStrip rows={ROWS} onSettings={vi.fn()} onRemove={vi.fn()} />);
        const strip = screen.getByTestId('home-arrange-strip');
        expect(within(strip).getByRole('heading', { name: 'Nothing to show now' })).toBeInTheDocument();
        expect(within(strip).getAllByRole('listitem').map(li => li.getAttribute('data-testid'))).toEqual([
            'home-arrange-strip-row-tips', 'home-arrange-strip-row-search-k7mq', 'home-arrange-strip-row-sky',
        ]);
        expect(screen.getByTestId('home-arrange-strip-row-tips')).toHaveTextContent('Tips');
        expect(screen.getByTestId('home-arrange-strip-note-tips')).toHaveTextContent('All tips seen');
        // A card with nothing more to say has no note.
        expect(screen.queryByTestId('home-arrange-strip-note-search-k7mq')).toBeNull();
        // The region is named by its heading, so a screen reader jumps to it.
        expect(within(strip).getByRole('region', { name: 'Nothing to show now' })).toBeInTheDocument();
    });

    it('Remove on every row and Settings… only where the type has them, each named in full for a screen reader', () => {
        render(<ArrangeStrip rows={ROWS} onSettings={vi.fn()} onRemove={vi.fn()} />);
        const names = (id: string) => within(screen.getByTestId(`home-arrange-strip-row-${id}`)).getAllByRole('button').map(b => b.getAttribute('aria-label'));
        expect(names('tips')).toEqual(['Remove Tips from Home']);
        expect(names('search-k7mq')).toEqual(['Settings for "eggs" (Offers)', 'Remove "eggs" (Offers) from Home']);
        expect(names('sky')).toEqual(['Settings for Sun and moon', 'Remove Sun and moon from Home']);
        // The words on them are the short ones.
        expect(screen.getByTestId('home-arrange-remove-tips')).toHaveTextContent(/^Remove$/);
        expect(screen.getByTestId('home-arrange-settings-sky')).toHaveTextContent(/^Settings…$/);
    });

    it('no arrows: a card you can\'t see is not moved', () => {
        render(<ArrangeStrip rows={ROWS} onSettings={vi.fn()} onRemove={vi.fn()} />);
        expect(document.querySelector('[data-testid^="home-arrange-up-"], [data-testid^="home-arrange-down-"]')).toBeNull();
    });

    it('every action is a 48 px target', () => {
        render(<ArrangeStrip rows={ROWS} onSettings={vi.fn()} onRemove={vi.fn()} />);
        for (const button of within(screen.getByTestId('home-arrange-strip')).getAllByRole('button')) {
            expect(button.className, button.getAttribute('aria-label') ?? '').toContain('min-h-[48px]');
            expect(button.className).toContain('min-w-[48px]');
        }
    });

    it('Remove and Settings… tell the page which card', () => {
        const onRemove = vi.fn();
        const onSettings = vi.fn();
        render(<ArrangeStrip rows={ROWS} onSettings={onSettings} onRemove={onRemove} />);
        fireEvent.click(screen.getByTestId('home-arrange-remove-search-k7mq'));
        expect(onRemove).toHaveBeenCalledWith('search-k7mq');
        fireEvent.click(screen.getByTestId('home-arrange-settings-sky'));
        expect(onSettings).toHaveBeenCalledWith('sky');
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(onSettings).toHaveBeenCalledTimes(1);
    });

    it('is a packed child: it reports its height, and takes the style the grid gives it', () => {
        const onHeight = vi.fn();
        vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
        const offset = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180);
        try {
            render(<ArrangeStrip rows={ROWS} onSettings={vi.fn()} onRemove={vi.fn()} onHeight={onHeight} style={{ gridColumn: '1 / -1', gridRow: '5 / span 46' }} />);
            expect(onHeight).toHaveBeenCalledWith(180);
            expect(screen.getByTestId('home-arrange-strip').style.gridRow).toBe('5 / span 46');
        } finally {
            offset.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    it('in the pseudo-locale, its heading, its actions and their labels all go through the words layer', async () => {
        await showIn('xx');
        render(<ArrangeStrip rows={[{ id: 'sky', name: 'Sun and moon', hasSettings: true }]} onSettings={vi.fn()} onRemove={vi.fn()} />);
        const strip = screen.getByTestId('home-arrange-strip');
        expect(strip).toHaveTextContent(xx('Nothing to show now'));
        expect(screen.getByTestId('home-arrange-remove-sky')).toHaveTextContent(xx('Remove'));
        expect(screen.getByTestId('home-arrange-settings-sky')).toHaveTextContent(xx('Settings…'));
        // The card's name arrives already said (the page makes it with t()); everything the strip adds is its own and bracketed,
        // aria-labels included.
        expect(bypassing(strip, { others: ['Sun and moon'] })).toEqual([]);
    });
});
