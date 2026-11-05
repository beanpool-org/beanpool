/**
 * The event in the Market's compact view is a compact row like a listing's (slice C1, DESIGN-card-style-box-fable.md §2 row
 * "Compact row, event"; DESIGN-market-event-cards-fable.md §2.4; Marty, 4 Nov 2026: "and list view in phone - the events dont
 * change"): the 32 px picture, the title with EVENT at the row's end, then the when in the viewer's own clock, 📌 PINNED, the
 * state and the place, with the viewer's mark at the row's end beside them. One button, no Going / Interested, no counts.
 *
 * jsdom does no layout, so the row's height is held here by its parts (the listing row's frame, a one-line title and a block
 * of two short lines at most, the when's date and time each whole in it, never narrower than its widest one) and measured in
 * Chromium by e2e/market-order-shots.mjs (no taller than a listing's row and one line at 320 px x 1.3; every piece of the
 * when drawn whole, to the sub-pixel, in en, fr, de, ru, es and pt and every language that says "your time" before the time;
 * EVENT and the mark inside the row).
 */
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventCard } from './EventCard';
import { MarketplaceCard } from './MarketplaceCard';
import {
    CARD_INK, COMPACT_END, COMPACT_EVENT_BODY, COMPACT_EVENT_HEAD, COMPACT_EVENT_MARK, COMPACT_EVENT_TEXT, COMPACT_LEAD, COMPACT_LINES, COMPACT_MARK,
    COMPACT_MARK_GIVES, COMPACT_PICTURE, COMPACT_PIECE, COMPACT_ROW, COMPACT_TITLE, COMPACT_TITLE_GIVES, COMPACT_WORD, chip,
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

/** Every core catalog whose "{time} your time" puts the label before the time (ja "あなたの時間：{time}"), read from the catalogs. */
const CORE_WORDS = path.resolve(__dirname, '../../../../packages/beanpool-core/words');
const LABEL_FIRST = fs.readdirSync(CORE_WORDS).filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length)).filter((lang) => {
    const sentence = JSON.parse(fs.readFileSync(path.join(CORE_WORDS, `${lang}.json`), 'utf8'))['{time} your time'];
    return typeof sentence === 'string' && sentence.split('{time}')[0].trim() !== '';
}).sort();

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
        // The picture and the words are the listing's lead (COMPACT_LEAD). The row's end is EVENT, on the title's line, and the
        // mark, beside the two short lines (COMPACT_EVENT_HEAD, COMPACT_EVENT_BODY).
        expect(screen.getByTestId('compact-picture').parentElement!.className).toBe(COMPACT_LEAD);
        expect(screen.getByTestId('event-type-chip').parentElement).toBe(screen.getByTestId('event-row-head'));
        expect(screen.getByTestId('event-row-head').lastElementChild).toBe(screen.getByTestId('event-type-chip'));
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
        // The words: the title's line (the title, then EVENT) over the two short lines (the when's block, then the mark).
        const text = screen.getByTestId('event-row-head').parentElement!;
        expect(text.className).toBe(COMPACT_EVENT_TEXT);
        expect(Array.from(text.children).map(c => c.getAttribute('data-testid'))).toEqual(['event-row-head', 'event-row-body']);
        expect(screen.getByTestId('event-row-head').className).toBe(COMPACT_EVENT_HEAD);
        expect(Array.from(screen.getByTestId('event-row-head').children).map(c => c.getAttribute('data-testid'))).toEqual(['event-row-title', 'event-type-chip']);
        expect(screen.getByTestId('event-row-body').className).toBe(COMPACT_EVENT_BODY);
        expect(Array.from(screen.getByTestId('event-row-body').children).map(c => c.getAttribute('data-testid'))).toEqual(['event-row-lines', 'event-mark']);
        const lines = screen.getByTestId('event-row-lines');
        expect(has(lines, COMPACT_LINES)).toBe(true);
        expect(classes(lines)).toContain('line-clamp-2');
        // The date and the time are whole pieces; so are PINNED and the state. Only the place can be cut.
        expect(Array.from(screen.getByTestId('event-when').children).map(c => [c.textContent, c.className])).toEqual([
            ['SAT 28 SEP ·', COMPACT_PIECE], ['9:00–12:00', COMPACT_PIECE],
        ]);
        expect(has(screen.getByTestId('event-state-badge'), COMPACT_PIECE)).toBe(true);
        expect(classes(screen.getByTestId('event-row-title'))).toContain('line-clamp-1');
        // The when's block is never narrower than its widest whole piece (min-w-min), so the date and the time are drawn whole
        // and wrap to the second line rather than being cut; the mark takes the room the block leaves (market-card-shell.ts
        // COMPACT_EVENT_HEAD; measured in Chromium).
        expect(classes(lines)).toEqual(expect.arrayContaining(['flex-1', 'min-w-min']));
        expect(classes(lines)).not.toContain('min-w-0');
        // The mark at the row's end beside the two lines, its words on up to two lines, giving way past them; its ✓ whole.
        const mark = screen.getByTestId('event-mark');
        expect(mark.textContent).toBe('Interested ✓');
        expect(has(mark, `${COMPACT_EVENT_MARK} ${COMPACT_MARK}`)).toBe(true);
        expect(Array.from(mark.children).map(c => [c.textContent, c.className])).toEqual([
            ['Interested', COMPACT_MARK_GIVES], [' ✓', 'shrink-0 whitespace-pre'],
        ]);
        expect(mark.previousElementSibling).toBe(lines);
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
    // (core's `{time} your time`), so the time is a whole piece in every language. The third review: where the language puts
    // the label BEFORE the time (ja "あなたの時間：{time}"), the row kept that order, the label's words filled the second line
    // and the time went to the hidden third: no time on the row at all. The time now comes straight after the date in every
    // language and the label follows it, the colon that led into the time gone with the move; the spoken name keeps the whole
    // sentence in the language's own order. The pinned labels, then every catalog that puts the label first, found from them.
    it.each([
        ['ru', ' по вашему времени'],
        ['de', ' deine Zeit'],
        ['ja', ' あなたの時間'],
        ['zh-Hans', ' 你的当地时间'],
        ...LABEL_FIRST.filter(lang => lang !== 'ja' && lang !== 'zh-Hans').map((lang): [string, null] => [lang, null]),
    ])('in %s the time is a whole piece straight after the date and the rest of "{time} your time" follows it', async (lang, label) => {
        await inLanguage(lang, () => {
            const sentence = t('{time} your time', { time: '\u0001' });
            const online = { ...event, eventOnline: true, eventPlaceName: undefined, eventTz: 'Pacific/Noumea', eventStartLocal: '2030-09-28T10:00', eventEndLocal: '2030-09-28T13:00' };
            const zone = { ...event, eventTz: 'Pacific/Noumea', eventStartLocal: '2030-09-28T10:00', eventEndLocal: '2030-09-28T13:00' };
            for (const post of [online, zone]) {
                renderRow(post, { distanceKm: null });
                const got = pieces();
                // The date, the time, then the label's words: nothing between the date and the time to push it off the row.
                expect(got.map(([kind]) => kind)).toEqual(['whole', 'whole', 'words']);
                const time = got[1][1];
                // The time alone, no label in it.
                expect(time).toMatch(/^\d{1,2}[:.]\d\d/);
                expect(time).not.toMatch(/[^\d:.–\s-]/);
                // The label is the sentence's own words, after the time.
                if (label !== null) expect(got[2]).toEqual(['words', label]);
                const words = got[2][1].trim();
                expect(words.length).toBeGreaterThan(0);
                expect(sentence.replace('\u0001', '')).toContain(words);
                // The row's spoken name says the sentence as core words it, in the language's own order.
                expect(screen.getByTestId('event-compact-row').getAttribute('aria-label')).toContain(t('{time} your time', { time }));
                cleanup();
            }
        });
    });

    it('the label-first catalogs are found (ja, zh-Hans, bn and ml today), so the case above runs each one', () => {
        expect(LABEL_FIRST).toEqual(expect.arrayContaining(['bn', 'ja', 'ml', 'zh-Hans']));
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
