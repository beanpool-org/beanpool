/**
 * The web's event page on the style box (DESIGN-detail-pages-fable.md §2, slice DW1; Marty, 4 Nov 2026: "All Fable's picks"):
 * one column at 320 px with 130% text, the parts in §2.1's order (the chips, the when, the title, the place, the photo, the
 * answer, the quiet row, the boxes, the description, the host, Report), the photo 4:3 and opening whole, the counts only above
 * zero, the event violet from core's roles, and Report, which the web's event page never had.
 *
 * jsdom does no layout, so the 320 px contract is held as EventCard.test.tsx holds it: by the classes, and by the order of the
 * page's parts in the document (what a reader meets from the top). The real layout is photographed and measured by
 * e2e/event-card-shots.mjs --detail.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventDetail } from './EventCard';
import { BOX_LABEL, EVENT_ANSWER, PAGE_BOX, PAGE_BUTTON, chip } from './market-card-shell';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        rsvpEvent: vi.fn(),
        removeMarketplacePost: vi.fn(),
        getMarketplacePosts: vi.fn(async () => []),
        getMyEvents: vi.fn(async () => []),
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberRatings: vi.fn(async () => ({ ratings: [], average: 0, count: 0 })),
        reportAbuse: vi.fn(async () => ({ success: true })),
        myNodeRoleOnce: vi.fn(async () => null),
    };
});

const HOUR = 60 * 60 * 1000;
const start = new Date(2030, 10, 21, 8, 0).getTime(); // SAT 21 NOV 2030, local time

/** The Mullum market, as the design measures it: a two-line title, a place, a photo, a paragraph of description. */
const market: any = {
    id: 'ev-mullum', type: 'event', category: 'community', title: 'Mullumbimby Community Market and Farmers Market',
    description: 'The farmers and community market at Summers Park: local food, plants, crafts and music.', credits: 0,
    priceType: 'fixed', authorPublicKey: 'host-pk', authorCallsign: 'Damo', createdAt: new Date().toISOString(), active: true,
    status: 'active', repeatable: false, lat: -28.55, lng: 153.5, photos: ['/uploads/market.webp', '/uploads/market-2.webp'],
    eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 6 * HOUR).toISOString(),
    eventPlaceName: 'Summers Park, corner of Main Arm Road', eventState: 'scheduled', goingCount: 0, interestedCount: 0, myRsvp: null,
};
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
/** The host reads the guest list (the node sends `eventRsvps` to the host and nobody else). */
const hosted = (extra: any = {}) => ({ ...market, authorPublicKey: 'me-pk', eventRsvps: [], ...extra });

function renderAt320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}>{ui}</div>);
}

/** Is `a` before `b` in the document? */
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Every class on the page and in what it opened (the lightbox and the report form are portals on the body). */
const allClasses = () => Array.from(document.body.querySelectorAll('[class]')).map(el => el.getAttribute('class')).join(' ');

beforeEach(() => { vi.mocked(api.reportAbuse).mockClear(); });
afterEach(() => { document.documentElement.style.fontSize = ''; });

describe('the event page at 320 px, 130% text: the parts in the design\'s order', () => {
    it('the chips, the when, the title, the place, the photo, Going, Share, the description, Hosted by, Report', () => {
        renderAt320(<EventDetail post={market} identity={identity} onShowOnMap={() => {}} onOpenProfile={() => {}} />);
        const chips = screen.getByTestId('event-chips');
        const when = screen.getByRole('heading', { level: 2 });
        const title = screen.getByRole('heading', { level: 3 });
        const place = screen.getByTestId('event-place');
        const photo = screen.getByTestId('event-photo-open');
        const going = screen.getByRole('button', { name: 'Going' });
        const share = screen.getByTestId('event-share');
        const description = screen.getByTestId('event-description');
        const host = screen.getByTestId('event-host-open');
        const report = screen.getByTestId('event-report');
        const order = [chips, when, title, place, photo, going, share, description, host, report];
        for (let i = 1; i < order.length; i++) expect(before(order[i - 1], order[i]), `part ${i} after part ${i - 1}`).toBe(true);
        // The place moved up to the loud lines, with Show on map as a link-like button on its row.
        expect(within(place).getByRole('button', { name: 'Show on map' })).toBeInTheDocument();
        expect(title.textContent).toBe(market.title);
    });

    it('Going is the first button after the title block: nothing to press between the title and the answer but the place\'s link and the photo', () => {
        renderAt320(<EventDetail post={market} identity={identity} onShowOnMap={() => {}} />);
        const head = screen.getByTestId('event-head');
        const buttons = screen.getAllByRole('button').filter(b => !head.contains(b));
        expect(buttons.map(b => b.getAttribute('data-testid') ?? b.textContent).slice(0, 3)).toEqual(['event-photo-open', 'Going', 'Interested']);
    });

    it('the loud lines are the page\'s type, in core\'s event ink: when 18/900, title 20/800; no outer card', () => {
        renderAt320(<EventDetail post={market} identity={identity} />);
        const whenPiece = screen.getByRole('heading', { level: 2 }).querySelector('.whitespace-nowrap') as HTMLElement;
        expect(whenPiece.className.split(/\s+/)).toEqual(expect.arrayContaining(['text-lg', 'font-black', 'text-bp-ink-event']));
        expect(screen.getByRole('heading', { level: 3 }).className.split(/\s+/)).toEqual(expect.arrayContaining(['text-xl', 'font-extrabold']));
        const detail = screen.getByTestId('event-detail');
        // The column is the page: no border, ground or corners of its own.
        expect(detail.className).not.toMatch(/(^| )(border|rounded|bg-|shadow)/);
        expect(within(detail).getByTestId('event-chips').firstElementChild!.className).toBe(chip('event'));
    });

    it('a cancelled event\'s when is struck through, under the CANCELLED chip', () => {
        renderAt320(<EventDetail post={{ ...market, eventState: 'cancelled' }} identity={identity} />);
        expect(screen.getByTestId('event-state-badge').textContent).toBe('CANCELLED');
        const whenPiece = screen.getByRole('heading', { level: 2 }).querySelector('.whitespace-nowrap') as HTMLElement;
        expect(whenPiece.className.split(/\s+/)).toContain('line-through');
    });
});

describe('the counts only above zero (Marty\'s pick 5)', () => {
    it('nothing at 0 going and 0 interested', () => {
        renderAt320(<EventDetail post={market} identity={identity} />);
        expect(screen.queryByTestId('event-counts')).toBeNull();
        expect(screen.getByTestId('event-detail').textContent).not.toMatch(/0 going/);
    });

    it('"3 going · 1 interested" under the answer once someone has answered', () => {
        renderAt320(<EventDetail post={{ ...market, goingCount: 3, interestedCount: 1 }} identity={identity} />);
        const counts = screen.getByTestId('event-counts');
        expect(counts.textContent).toBe('👥 3 going · 1 interested');
        expect(screen.getByTestId('event-action').contains(counts)).toBe(true);
        expect(before(screen.getByRole('button', { name: 'Interested' }), counts)).toBe(true);
    });
});

describe('the answer and the quiet row, from core\'s roles', () => {
    it('the chosen answer on the event fill with white words, the other in the event ink\'s outline, at the page\'s 15/700 and 48 tall', () => {
        renderAt320(<EventDetail post={{ ...market, myRsvp: 'going', goingCount: 1 }} identity={identity} />);
        const going = screen.getByRole('button', { name: 'Going ✓' });
        const interested = screen.getByRole('button', { name: 'Interested' });
        for (const c of EVENT_ANSWER.chosen.split(' ')) expect(going.className.split(/\s+/), c).toContain(c);
        for (const c of EVENT_ANSWER.open.split(' ')) expect(interested.className.split(/\s+/), c).toContain(c);
        for (const b of [going, interested]) {
            expect(b.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-[48px]', 'text-[0.9375rem]', 'font-bold', 'whitespace-nowrap']));
        }
    });

    it('the quiet row: the chat first for someone Going, then Share, then Add to calendar, each the neutral outline', () => {
        renderAt320(<EventDetail post={{ ...market, myRsvp: 'going', goingCount: 1 }} identity={identity} onOpenChat={() => {}} />);
        const row = screen.getByTestId('event-quiet-row');
        const items = within(row).getAllByRole('button');
        expect(items.map(b => b.getAttribute('data-testid'))).toEqual(['event-open-chat', 'event-share', 'event-add-to-calendar']);
        for (const b of items) for (const c of PAGE_BUTTON.quiet.split(' ')) expect(b.className.split(/\s+/), `${b.textContent}: ${c}`).toContain(c);
        // The chat takes the row's first line whole; Share and the calendar are as wide as their words and wrap whole.
        expect(items[0].className.split(/\s+/)).toContain('basis-full');
        expect(items[1].className.split(/\s+/)).toEqual(expect.arrayContaining(['grow', 'basis-auto']));
        // Under the answer, and before the description.
        expect(before(screen.getByTestId('event-action'), row)).toBe(true);
        expect(before(row, screen.getByTestId('event-description'))).toBe(true);
    });

    it('a member who has not answered sees no chat in the row: Share and Add to calendar only', () => {
        renderAt320(<EventDetail post={market} identity={identity} onOpenChat={() => {}} />);
        expect(within(screen.getByTestId('event-quiet-row')).getAllByRole('button').map(b => b.getAttribute('data-testid')))
            .toEqual(['event-share', 'event-add-to-calendar']);
    });

    it('the host reads "You\'re hosting this event" in the event ink where Going would be', () => {
        renderAt320(<EventDetail post={hosted()} identity={identity} />);
        const line = screen.getByTestId('event-hosting');
        expect(screen.getByTestId('event-action').contains(line)).toBe(true);
        expect(line.className.split(/\s+/)).toContain('text-bp-ink-event');
        expect(screen.queryByRole('button', { name: 'Going' })).toBeNull();
    });
});

describe('the boxes are the style box\'s page box, with the label in small capitals', () => {
    it('the note for people who are going', () => {
        renderAt320(<EventDetail post={{ ...market, myRsvp: 'going', eventPrivateNote: 'Gate code 1234' }} identity={identity} />);
        const note = screen.getByTestId('event-private-note');
        expect(note.className).toBe(PAGE_BOX);
        expect(within(note).getByText('Note for people who are going').className).toBe(BOX_LABEL.event);
    });

    it('the host\'s guest list, with Edit event on the event fill and Copy to a new date in the event ink', () => {
        renderAt320(<EventDetail post={hosted()} identity={identity} onEdit={() => {}} onCopyToNewDate={() => {}} />);
        const panel = screen.getByTestId('event-host-panel');
        expect(panel.className.split(/\s+/)).toEqual(expect.arrayContaining(PAGE_BOX.split(' ')));
        expect(within(panel).getByText("Who's going").className.split(/\s+/)).toEqual(expect.arrayContaining(BOX_LABEL.muted.split(' ')));
        expect(screen.getByTestId('event-edit').className).toBe(PAGE_BUTTON.eventFill);
        expect(screen.getByTestId('event-copy-to-new-date').className).toBe(PAGE_BUTTON.eventOutline);
    });

    it('the host box is the page box, and opens the host\'s profile', async () => {
        const onOpenProfile = vi.fn();
        renderAt320(<EventDetail post={market} identity={identity} onOpenProfile={onOpenProfile} />);
        const box = screen.getByTestId('event-host-open').parentElement!;
        expect(box.className).toBe(PAGE_BOX);
        expect(within(box).getByText('Hosted by')).toBeInTheDocument();
        await userEvent.click(screen.getByTestId('event-host-open'));
        expect(onOpenProfile).toHaveBeenCalledWith('host-pk');
    });
});

describe('the photo: 4:3, and a click shows it whole (Marty\'s pick 2)', () => {
    it('the frame is 4:3 under the shell\'s corners, covering, and is a button named for the photo', () => {
        renderAt320(<EventDetail post={market} identity={identity} />);
        const open = screen.getByRole('button', { name: `View enlarged photo 1 of 2: ${market.title}` });
        expect(open.className.split(/\s+/)).toEqual(expect.arrayContaining(['w-full', 'aspect-[4/3]', 'rounded-[14px]', 'overflow-hidden']));
        const img = within(open).getByRole('img', { name: market.title }) as HTMLImageElement;
        expect(img.getAttribute('src')).toBe('/uploads/market.webp');
        expect(img.className.split(/\s+/)).toContain('object-cover');
    });

    it('opens the photo viewer on the first photo, with every photo the event has, and closes it', async () => {
        renderAt320(<EventDetail post={market} identity={identity} />);
        expect(screen.queryByRole('dialog')).toBeNull();
        await userEvent.click(screen.getByTestId('event-photo-open'));
        const viewer = await screen.findByRole('dialog', { name: `Photo viewer: ${market.title}` });
        expect(within(viewer).getByRole('button', { name: 'Go to photo 2 of 2' })).toBeInTheDocument();
        await userEvent.click(within(viewer).getByRole('button', { name: 'Close photo viewer' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('with no photo, the event\'s tile, 3:1, inside the column, and nothing to open', () => {
        renderAt320(<EventDetail post={{ ...market, photos: [] }} identity={identity} />);
        expect(screen.getByTestId('event-tile-banner').className.split(/\s+/)).toEqual(expect.arrayContaining(['w-full', 'aspect-[3/1]']));
        expect(screen.queryByTestId('event-photo-open')).toBeNull();
        // One column at every width: the grid's columns are for a photo.
        expect(screen.getByTestId('event-detail').className).not.toMatch(/md:grid/);
    });
});

describe('🚩 Report, at the foot (the web\'s event page had none)', () => {
    it('is there for a member who is not the host, last on the page, and opens the report form for this event', async () => {
        renderAt320(<EventDetail post={market} identity={identity} />);
        const report = screen.getByTestId('event-report');
        expect(report.textContent).toBe('🚩 Report');
        expect(report.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-[48px]', 'text-[0.8125rem]', 'font-bold', 'text-bp-ink-danger']));
        // Nothing to press after it.
        const buttons = within(screen.getByTestId('event-detail')).getAllByRole('button');
        expect(buttons.at(-1)).toBe(report);
        await userEvent.click(report);
        const form = await screen.findByRole('dialog');
        expect(form.textContent).toContain(`Report ${market.title}`);
    });

    it('sends the report about this event and its host', async () => {
        renderAt320(<EventDetail post={market} identity={identity} />);
        await userEvent.click(screen.getByTestId('event-report'));
        const form = await screen.findByRole('dialog');
        await userEvent.click(within(form).getAllByRole('button', { pressed: false })[0]);
        await userEvent.click(within(form).getByRole('button', { name: 'Submit Report' }));
        await waitFor(() => expect(api.reportAbuse).toHaveBeenCalledTimes(1));
        const [reporter, target, , postId] = vi.mocked(api.reportAbuse).mock.calls[0];
        expect([reporter, target, postId]).toEqual(['me-pk', 'host-pk', 'ev-mullum']);
    });

    it('is not there for the host, or for someone not signed in', () => {
        const { unmount } = renderAt320(<EventDetail post={hosted()} identity={identity} />);
        expect(screen.queryByTestId('event-report')).toBeNull();
        unmount();
        renderAt320(<EventDetail post={market} identity={null} />);
        expect(screen.queryByTestId('event-report')).toBeNull();
    });
});

describe('no raw violet anywhere on the page: the event violet is core\'s roles, light and dark', () => {
    it.each([
        ['a member with no answer', market, {}],
        ['a member Going, with the note and the chat', { ...market, myRsvp: 'going', goingCount: 3, eventPrivateNote: 'Gate code 1234' }, { onOpenChat: () => {} }],
        ['the host, letting people in', hosted({ eventHostLetsIn: true, eventRsvps: [
            { memberPubkey: 'a', memberCallsign: 'Ari', status: 'going', updatedAt: '', letInAt: '2030-11-01T00:00:00Z' },
            { memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' },
            { memberPubkey: 'c', memberCallsign: 'Cy', status: 'going', updatedAt: '' },
        ] }), { onEdit: () => {}, onCopyToNewDate: () => {}, onOpenChat: () => {} }],
        ['an online event, Going', { ...market, eventOnline: true, eventPlaceName: undefined, eventLink: 'https://meet.example.org/x', myRsvp: 'going' }, {}],
    ])('%s', async (_, post, extra) => {
        renderAt320(<EventDetail post={post} identity={identity} onShowOnMap={() => {}} {...extra} />);
        await userEvent.click(screen.getByTestId('event-photo-open'));
        await screen.findByRole('dialog');
        expect(allClasses()).not.toMatch(/violet-|purple-/);
    });
});
