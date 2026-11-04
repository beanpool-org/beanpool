/**
 * The event in the Market's compact view is a compact row like a listing's (slice C1, DESIGN-card-style-box-fable.md §2 row
 * "Compact row, event"; DESIGN-market-event-cards-fable.md §2.4; Marty, 4 Nov 2026: "and list view in phone - the events dont
 * change"): the 32 px picture, the title, the when in the viewer's own clock, then 📌 PINNED, the state and the place; the
 * viewer's mark where a listing's price sits, above EVENT. One button, no Going / Interested, no counts.
 *
 * jsdom does no layout, so the row's height is held here by its parts (the listing row's frame, a one-line title and a block
 * of two short lines at most, the when's date and time each whole in it) and measured in Chromium by
 * e2e/market-order-shots.mjs (no taller than a listing's row and one line at 320 px x 1.3, the when whole).
 */
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventCard } from './EventCard';
import { MarketplaceCard } from './MarketplaceCard';
import {
    CARD_INK, COMPACT_END, COMPACT_END_STACK, COMPACT_LEAD_FIRM, COMPACT_LINES, COMPACT_MARK, COMPACT_MARK_GIVES, COMPACT_PICTURE, COMPACT_PIECE, COMPACT_ROW,
    COMPACT_TEXT_FIRM, COMPACT_TITLE, COMPACT_TITLE_GIVES, COMPACT_WORD, chip,
} from './market-card-shell';

import { addDateWords, setLanguage, t } from '@beanpool/core';

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

/** The when's pieces as drawn: a whole piece (COMPACT_PIECE) or the words of a sentence round the time. */
const pieces = () => Array.from(screen.getByTestId('event-when').children).map((c): [string | null, string] => [c.getAttribute('data-piece'), c.textContent ?? '']);

/** Runs `body` with a language's real catalogs (this app's words, core's words and core's dates), as the app loads them. */
async function inLanguage(lang: string, body: () => void) {
    const [app, core, dates] = await Promise.all([
        import(`../../words/${lang}.json`), import(`../../../../packages/beanpool-core/words/${lang}.json`), import(`../../../../packages/beanpool-core/src/words-dates/${lang}.ts`),
    ]);
    try {
        addDateWords(lang as any, dates.dateWords);
        setLanguage(lang as any, [app.default, core.default]);
        body();
    } finally {
        setLanguage('en');
    }
}

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
        // The title in the listing title's type and ink, one line ending in "…" (COMPACT_TITLE_GIVES: it asks for no width).
        expect(screen.getByTestId('event-row-title').className).toBe(COMPACT_TITLE_GIVES);
        const type = (s: string) => s.split(/\s+/).filter(c => /^(font-|text-|dark:text-)/.test(c));
        expect(type(COMPACT_TITLE_GIVES)).toEqual(type(COMPACT_TITLE));
        // The end: the mark above EVENT in a column, as wide as its widest piece (COMPACT_END_STACK).
        expect(screen.getByTestId('event-type-chip').parentElement!.className).toBe(COMPACT_END_STACK);
        // The listing's row, from the same strings.
        render(<MarketplaceCard post={{ ...event, type: 'offer', category: 'tools', photos: [] }} viewMode="compact" />);
        const listing = screen.getByTestId('listing-compact-row');
        expect(has(listing, COMPACT_ROW)).toBe(true);
        expect(listing.querySelector(`[class="${COMPACT_PICTURE}"]`)).not.toBeNull();
        expect(listing.querySelector('h3')!.className).toBe(COMPACT_TITLE);
        expect(listing.querySelector(`[class="${COMPACT_END}"]`)).not.toBeNull();
    });

    it('lays out one row: a one-line title and at most two short lines, the when\'s date and time each whole', () => {
        // The fullest row: pinned, updated, a group-only event, a place, and the viewer's answer.
        renderRow({ ...event, ...pinnedAt, eventState: 'updated', myRsvp: 'interested', audienceScope: 'group', targetGroupName: 'Gardeners' });
        const row = screen.getByTestId('event-compact-row');
        // One button, the row; nothing else to press.
        expect(within(row.parentElement!).getAllByRole('button')).toEqual([row]);
        const text = screen.getByTestId('event-row-title').parentElement!;
        expect(Array.from(text.children).map(c => c.getAttribute('data-testid'))).toEqual(['event-row-title', 'event-row-lines']);
        const lines = screen.getByTestId('event-row-lines');
        expect(has(lines, COMPACT_LINES)).toBe(true);
        expect(classes(lines)).toContain('line-clamp-2');
        // The date and the time are whole pieces; so are PINNED and the state. Only the place can be cut.
        expect(Array.from(screen.getByTestId('event-when').children).map(c => [c.textContent, c.className])).toEqual([
            ['SAT 28 SEP ·', COMPACT_PIECE], ['9:00–12:00', COMPACT_PIECE],
        ]);
        expect(has(screen.getByTestId('event-state-badge'), COMPACT_PIECE)).toBe(true);
        expect(classes(screen.getByTestId('event-row-title'))).toContain('line-clamp-1');
        // The lead and the words start at their widest whole piece and can go narrower (min-w-0): the end gives way first,
        // down to its chip, and is never pushed out of the row (market-card-shell.ts COMPACT_LEAD_FIRM; measured in Chromium).
        expect(screen.getByTestId('event-row-title').parentElement!.className).toBe(COMPACT_TEXT_FIRM);
        expect(screen.getByTestId('compact-picture').parentElement!.className).toBe(COMPACT_LEAD_FIRM);
        // The mark at the end, above EVENT, one line: its word gives way, its ✓ stays whole.
        const mark = screen.getByTestId('event-mark');
        expect(mark.textContent).toBe('Interested ✓');
        expect(has(mark, COMPACT_MARK)).toBe(true);
        expect(Array.from(mark.children).map(c => [c.textContent, c.className])).toEqual([
            ['Interested', COMPACT_MARK_GIVES], [' ✓', 'shrink-0 whitespace-pre'],
        ]);
        expect(mark.nextElementSibling).toBe(screen.getByTestId('event-type-chip'));
    });

    it('the when in the event ink, then 📌 PINNED, the state and the place, each in its own ink', () => {
        renderRow({ ...event, ...pinnedAt, eventState: 'updated' });
        const when = screen.getByTestId('event-when');
        expect(when.textContent).toBe('SAT 28 SEP · 9:00–12:00');
        expect(has(when, `font-bold ${CARD_INK.event}`)).toBe(true);
        const lines = screen.getByTestId('event-row-lines');
        expect(lines.textContent).toBe('SAT 28 SEP · 9:00–12:00 · 📌 PINNED · UPDATED · 📍 Bindarrabi Hall · 2.4 km');
        expect(has(lines, `font-medium ${CARD_INK.secondary}`)).toBe(true);
        expect(within(lines).getByTestId('event-pinned-chip').className).toBe(`${COMPACT_PIECE} ${COMPACT_WORD.pinned}`);
        expect(within(lines).getByTestId('event-state-badge').className).toBe(`${COMPACT_PIECE} ${COMPACT_WORD.event}`);
        // EVENT is the box's one chip, at the row's end.
        expect(screen.getByTestId('event-type-chip').className).toBe(chip('event'));
        expect(screen.getByTestId('event-type-chip').textContent).toBe('EVENT');
    });

    it('CANCELLED and ENDED are the danger ink after the when; the label says the state', () => {
        renderRow({ ...event, eventState: 'cancelled' });
        expect(screen.getByTestId('event-state-badge').textContent).toBe('CANCELLED');
        expect(screen.getByTestId('event-state-badge').className).toBe(`${COMPACT_PIECE} ${COMPACT_WORD.danger}`);
        cleanup();
        const past = new Date(2020, 0, 4, 9, 0).getTime();
        renderRow({ ...event, eventStartAt: new Date(past).toISOString(), eventEndAt: new Date(past + 3 * HOUR).toISOString() });
        expect(screen.getByTestId('event-state-badge').textContent).toBe('ENDED');
        expect(screen.getByTestId('event-state-badge').className).toBe(`${COMPACT_PIECE} ${COMPACT_WORD.danger}`);
        expect(screen.getByTestId('event-compact-row').getAttribute('aria-label')).toMatch(/, ENDED$/);
    });

    it('the when is the viewer\'s own clock, with "your time", where the place\'s differs', () => {
        // The place is 9:00 on its own clock, an hour from the reader's: the row reads the reader's clock and says so.
        const placeClock = '2030-09-28T10:00';
        renderRow({ ...event, eventStartLocal: placeClock, eventEndLocal: '2030-09-28T13:00', eventTz: 'Pacific/Noumea' });
        expect(screen.getByTestId('event-when').textContent).toBe('SAT 28 SEP · 9:00–12:00 your time');
        // The time is a whole piece of its own; "your time" is the rest of its sentence, words that wrap and give way.
        expect(pieces()).toEqual([['whole', 'SAT 28 SEP ·'], ['whole', '9:00–12:00'], ['words', ' your time']]);
        expect(screen.getByTestId('event-when').querySelector('[data-piece="words"]')!.className).toBe('');
    });

    // The review of #2904: "your time" was split off with an English suffix test, so in every other language the time and its
    // label were one whole piece, 159–235 px against ~110 of room at 320 x 1.3. It is split through the sentence itself
    // (core's `{time} your time`), so the time is a whole piece in every language and the label sits where the language puts it.
    it.each([
        ['ru', ' по вашему времени', 'after'],
        ['de', ' deine Zeit', 'after'],
        ['ja', 'あなたの時間：', 'before'],
    ])('in %s the time is a whole piece of its own and the rest of "{time} your time" is its words (%s)', async (lang, label, side) => {
        await inLanguage(lang, () => {
            const online = { ...event, eventOnline: true, eventPlaceName: undefined, eventTz: 'Pacific/Noumea', eventStartLocal: '2030-09-28T10:00', eventEndLocal: '2030-09-28T13:00' };
            const zone = { ...event, eventTz: 'Pacific/Noumea', eventStartLocal: '2030-09-28T10:00', eventEndLocal: '2030-09-28T13:00' };
            for (const post of [online, zone]) {
                renderRow(post, { distanceKm: null });
                const got = pieces();
                const time = got.findIndex(([kind, text]) => kind === 'whole' && /^\d{1,2}[:.]\d\d/.test(text));
                expect(time).toBeGreaterThan(0);
                // The time alone, no label in it; the label is the sentence's own words, on the language's side of it.
                expect(got[time][1]).not.toMatch(/[^\d:.–\s-]/);
                expect(got[side === 'after' ? time + 1 : time - 1]).toEqual(['words', label]);
                expect(got.filter(([kind]) => kind === 'words')).toEqual([['words', label]]);
                // The pieces read the sentence as core words it.
                expect(screen.getByTestId('event-when').textContent).toContain(t('{time} your time', { time: got[time][1] }));
                cleanup();
            }
        });
    });

    it('over two days, the start\'s date and its time and the end\'s date and its time are each a whole piece', () => {
        const late = new Date(2030, 8, 28, 22, 0).getTime();
        renderRow({ ...event, eventStartAt: new Date(late).toISOString(), eventEndAt: new Date(late + 4 * HOUR).toISOString() });
        expect(screen.getByTestId('event-when').textContent).toBe('SAT 28 SEP 22:00 – SUN 29 SEP 2:00');
        expect(pieces()).toEqual([['whole', 'SAT 28 SEP'], ['whole', '22:00 –'], ['whole', 'SUN 29 SEP'], ['whole', '2:00']]);
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

    it('an online event reads Online after its when', () => {
        renderRow({ ...event, eventOnline: true, eventPlaceName: undefined }, { distanceKm: null });
        expect(screen.getByTestId('event-row-lines').textContent).toMatch(/ · 🌐 Online$/);
    });
});
