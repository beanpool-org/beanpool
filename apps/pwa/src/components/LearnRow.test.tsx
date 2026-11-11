/**
 * The row card of Learn (slice K2): the whole card is one tap, a post without a photo is never bare, a photo the web's image
 * allow-list refuses is never drawn, the marks read in the Market's chip family, and "Checked" goes amber after a year.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { KnowledgeRow } from '@beanpool/core';
import { LearnRow, checkedWords } from './LearnRow';

const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const row = (over: Partial<KnowledgeRow> = {}): KnowledgeRow => ({
    id: 'k1', title: 'How recycling works at the tip', line: 'Bring glass, cans and paper sorted into their own boxes.', topic: 'local-services',
    photo: null, checkedAt: '2026-10-20T00:00:00.000Z', helped: 0, pinned: false, outdated: false, ...over,
});

afterEach(() => { cleanup(); });

describe('the row card', () => {
    it('is one button: the whole card opens the page, and it names the page and when it was checked', () => {
        const onOpen = vi.fn();
        render(<LearnRow row={row()} onOpen={onOpen} />);
        const card = screen.getByRole('button');
        expect(card).toBe(screen.getByTestId('learn-row'));
        expect(card.getAttribute('aria-label')).toBe('Local knowledge: How recycling works at the tip, checked Oct 2026');
        fireEvent.click(card);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(screen.getAllByRole('button')).toHaveLength(1);
    });

    it('has no name on it (the writer shows on the page, not the card)', () => {
        render(<LearnRow row={row()} onOpen={vi.fn()} />);
        expect(screen.getByTestId('learn-row').textContent).not.toMatch(/by |Ada/);
    });

    it('with no photo draws the topic\'s tile, and the first line of the body, once', () => {
        render(<LearnRow row={row({ topic: 'emergencies' })} onOpen={vi.fn()} />);
        expect(screen.getByTestId('learn-topic-tile').textContent).toBe('🚨');
        expect(screen.getByTestId('learn-row-topic').textContent).toBe('EMERGENCIES');
        expect(screen.getAllByText('Bring glass, cans and paper sorted into their own boxes.')).toHaveLength(1);
    });

    it('never draws an address the web\'s image allow-list refuses: the tile stands in', () => {
        render(<LearnRow row={row({ photo: 'http://tracker.example/p.png' })} onOpen={vi.fn()} />);
        expect(screen.getByTestId('learn-topic-tile')).toBeInTheDocument();
        expect(document.querySelector('img')).toBeNull();
    });

    it('an unknown topic (a newer node\'s) reads "Local knowledge" with the book glyph, not a blank', () => {
        render(<LearnRow row={row({ topic: 'from-the-future' })} onOpen={vi.fn()} />);
        expect(screen.getByTestId('learn-row-topic').textContent).toBe('LOCAL KNOWLEDGE');
        expect(screen.getByTestId('learn-topic-tile').textContent).toBe('📖');
    });

    it('marks a pinned page and a page that may be out of date, each once, in the chip family', () => {
        render(<LearnRow row={row({ pinned: true, outdated: true })} onOpen={vi.fn()} />);
        expect(screen.getByTestId('learn-row-pinned').textContent).toBe('📌 PINNED');
        expect(screen.getByTestId('learn-row-outdated').textContent).toBe('MAY BE OUT OF DATE');
        expect(screen.getByTestId('learn-row-outdated').className).toContain('bp-chip-warn');
        expect(screen.getByTestId('learn-row-topic').className).toContain('bp-chip-learn');
    });

    it('says "Helped n" from 1 and not before', () => {
        const { rerender } = render(<LearnRow row={row({ helped: 0 })} onOpen={vi.fn()} />);
        expect(screen.queryByTestId('learn-row-helped')).toBeNull();
        rerender(<LearnRow row={row({ helped: 12 })} onOpen={vi.fn()} />);
        expect(within(screen.getByTestId('learn-row')).getByTestId('learn-row-helped').textContent).toBe('Helped 12');
    });

    it('says "Checked over a year ago", in amber, after twelve months, and the month before that', () => {
        expect(checkedWords(new Date(NOW - 366 * DAY).toISOString(), NOW)).toEqual({ text: 'Checked over a year ago', old: true });
        expect(checkedWords('2026-10-20T00:00:00.000Z', NOW)).toEqual({ text: 'Checked Oct 2026', old: false });
        render(<LearnRow row={row({ checkedAt: new Date(Date.now() - 400 * DAY).toISOString() })} onOpen={vi.fn()} />);
        const checked = screen.getByTestId('learn-row-checked');
        expect(checked.textContent).toBe('Checked over a year ago');
        expect(checked.className).toContain('text-bp-ink-warning');
    });
});
