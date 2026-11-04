/**
 * The event in the Market's compact view is a compact row like a listing's (slice C1, DESIGN-card-style-box-fable.md §2 row
 * "Compact row, event"; DESIGN-market-event-cards-fable.md §2.4; Marty, 4 Nov 2026: "and list view in phone - the events dont
 * change"): the 32 px picture, the title, the when in the viewer's own clock, then 📌 PINNED, the state and the place; the
 * viewer's mark where a listing's price sits, above EVENT. One button, no Going / Interested, no counts.
 *
 * jsdom does no layout, so the row's height is held here by its parts (the listing row's frame, a title and at most two short
 * lines, each one line that ends in "…") and measured in Chromium by e2e/market-order-shots.mjs (no taller than a listing's
 * row and one line at 320 px x 1.3).
 */
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventCard } from './EventCard';
import { MarketplaceCard } from './MarketplaceCard';
import { CARD_INK, COMPACT_END, COMPACT_LINE, COMPACT_PICTURE, COMPACT_ROW, COMPACT_TITLE, COMPACT_WORD, chip } from './market-card-shell';

vi.mock('../lib/api', async () => ({ ...(await vi.importActual<typeof import('../lib/api')>('../lib/api')), rsvpEvent: vi.fn() }));

const HOUR = 3_600_000;
// A Saturday morning a while ahead, in this machine's own clock (no place clock: the reader's and the place's are one).
const start = new Date(2030, 8, 28, 9, 0).getTime();
const event: any = {
    id: 'ev-row', type: 'event', category: 'community', title: 'Working bee at the hall — bring gloves, hats and a long-handled shovel',
    description: 'Clearing the back garden', credits: 0, priceType: 'fixed', authorPublicKey: 'host-pk', authorCallsign: 'Hazel',
    createdAt: new Date().toISOString(), active: true, status: 'active', repeatable: false, lat: -28.55, lng: 153.5,
    eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 3 * HOUR).toISOString(),
    eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled', goingCount: 7, interestedCount: 3, myRsvp: null,
};
const pinnedAt = { pinnedAt: new Date().toISOString(), pinnedUntil: new Date(Date.now() + 3 * 24 * HOUR).toISOString() };
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const has = (el: Element, s: string) => s.split(/\s+/).every(c => classes(el).includes(c));

afterEach(() => { cleanup(); document.documentElement.style.fontSize = ''; });

function renderRow(post: any, opts: { onOpen?: () => void; distanceKm?: number | null } = {}) {
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}><EventCard post={post} identity={identity} viewMode="compact" distanceKm={opts.distanceKm ?? 2.4} onOpen={opts.onOpen ?? vi.fn()} /></div>);
}

describe('the event\'s compact row (C1)', () => {
    it('is the listing\'s row: the same frame, picture slot, title and end as a listing\'s compact row', () => {
        renderRow(event);
        const row = screen.getByTestId('event-compact-row');
        expect(has(row, COMPACT_ROW)).toBe(true);
        expect(screen.getByTestId('compact-picture').className).toBe(COMPACT_PICTURE);
        expect(screen.getByTestId('event-row-title').className).toBe(`block ${COMPACT_TITLE}`);
        expect(screen.getByTestId('event-type-chip').parentElement!.className).toBe(COMPACT_END);
        // The listing's row, from the same strings.
        render(<MarketplaceCard post={{ ...event, type: 'offer', category: 'tools', photos: [] }} viewMode="compact" />);
        const listing = screen.getByTestId('listing-compact-row');
        expect(has(listing, COMPACT_ROW)).toBe(true);
        expect(listing.querySelector(`[class="${COMPACT_PICTURE}"]`)).not.toBeNull();
        expect(listing.querySelector('h3')!.className).toBe(COMPACT_TITLE);
        expect(listing.querySelector(`[class="${COMPACT_END}"]`)).not.toBeNull();
    });

    it('lays out one row: the title and at most two short lines, each one line that ends in "…"', () => {
        // The fullest row: pinned, updated, a group-only event, a place, and the viewer's answer.
        renderRow({ ...event, ...pinnedAt, eventState: 'updated', myRsvp: 'interested', audienceScope: 'group', targetGroupName: 'Gardeners' });
        const row = screen.getByTestId('event-compact-row');
        // One button, the row; nothing else to press.
        expect(within(row.parentElement!).getAllByRole('button')).toEqual([row]);
        const text = screen.getByTestId('event-row-title').parentElement!;
        expect(Array.from(text.children).map(c => c.getAttribute('data-testid'))).toEqual(['event-row-title', 'event-when', 'event-row-place']);
        for (const line of [screen.getByTestId('event-when'), screen.getByTestId('event-row-place')]) {
            expect(has(line, COMPACT_LINE)).toBe(true);
            expect(classes(line)).toContain('truncate');
        }
        expect(classes(screen.getByTestId('event-row-title'))).toContain('truncate');
        // The mark at the end, two lines at most, above EVENT.
        const mark = screen.getByTestId('event-mark');
        expect(mark.textContent).toBe('Interested ✓');
        expect(classes(mark)).toContain('line-clamp-2');
        expect(mark.nextElementSibling).toBe(screen.getByTestId('event-type-chip'));
    });

    it('line two is the when in the event ink; line three is 📌 PINNED, the state and the place, each in its own ink', () => {
        renderRow({ ...event, ...pinnedAt, eventState: 'updated' });
        const when = screen.getByTestId('event-when');
        expect(when.textContent).toBe('SAT 28 SEP · 9:00–12:00');
        expect(has(when, `font-bold ${CARD_INK.event}`)).toBe(true);
        const place = screen.getByTestId('event-row-place');
        expect(place.textContent).toBe('📌 PINNED · UPDATED · 📍 Bindarrabi Hall · 2.4 km');
        expect(within(place).getByTestId('event-pinned-chip').className).toBe(COMPACT_WORD.pinned);
        expect(within(place).getByTestId('event-state-badge').className).toBe(COMPACT_WORD.event);
        // EVENT is the box's one chip, at the row's end.
        expect(screen.getByTestId('event-type-chip').className).toBe(chip('event'));
        expect(screen.getByTestId('event-type-chip').textContent).toBe('EVENT');
    });

    it('CANCELLED and ENDED are the danger ink in line three; the label says the state', () => {
        renderRow({ ...event, eventState: 'cancelled' });
        expect(screen.getByTestId('event-state-badge').textContent).toBe('CANCELLED');
        expect(screen.getByTestId('event-state-badge').className).toBe(COMPACT_WORD.danger);
        cleanup();
        const past = new Date(2020, 0, 4, 9, 0).getTime();
        renderRow({ ...event, eventStartAt: new Date(past).toISOString(), eventEndAt: new Date(past + 3 * HOUR).toISOString() });
        expect(screen.getByTestId('event-state-badge').textContent).toBe('ENDED');
        expect(screen.getByTestId('event-state-badge').className).toBe(COMPACT_WORD.danger);
        expect(screen.getByTestId('event-compact-row').getAttribute('aria-label')).toMatch(/, ENDED$/);
    });

    it('the when is the viewer\'s own clock, with "your time", where the place\'s differs', () => {
        // The place is 9:00 on its own clock, an hour from the reader's: the row reads the reader's clock and says so.
        const placeClock = '2030-09-28T10:00';
        renderRow({ ...event, eventStartLocal: placeClock, eventEndLocal: '2030-09-28T13:00', eventTz: 'Pacific/Noumea' });
        expect(screen.getByTestId('event-when').textContent).toBe('SAT 28 SEP · 9:00–12:00 your time');
    });

    it('the mark: Going ✓, Interested ✓ or You\'re hosting this event; nothing else (no counts, no buttons)', () => {
        renderRow({ ...event, myRsvp: 'going' });
        expect(screen.getByTestId('event-mark').textContent).toBe('Going ✓');
        expect(screen.getByTestId('event-compact-row').getAttribute('aria-label')).toMatch(/Going ✓/);
        cleanup();
        renderRow({ ...event, eventRsvps: [] });
        expect(screen.getByTestId('event-mark').textContent).toBe("You're hosting this event");
        cleanup();
        renderRow(event);
        expect(screen.queryByTestId('event-mark')).toBeNull();
        // The counts are the page's, and so are Going / Interested.
        expect(screen.queryByText(/going ·/)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Going' })).toBeNull();
        expect(screen.queryByTestId('event-rsvp-row')).toBeNull();
    });

    it('the whole row opens the event', () => {
        const onOpen = vi.fn();
        renderRow(event, { onOpen });
        fireEvent.click(screen.getByRole('button', { name: /^Open event: Working bee/ }));
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('an online event reads Online in line three', () => {
        renderRow({ ...event, eventOnline: true, eventPlaceName: undefined }, { distanceKm: null });
        expect(screen.getByTestId('event-row-place').textContent).toBe('🌐 Online');
    });
});
