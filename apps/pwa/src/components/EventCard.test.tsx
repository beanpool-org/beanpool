import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventCard, EventDetail } from './EventCard';
import { MarketplaceCard } from './MarketplaceCard';
import { CARD_INK, LIST_PHOTO, LIST_PHOTO_FILL, chip, listCard } from './market-card-shell';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, rsvpEvent: vi.fn(), removeMarketplacePost: vi.fn(), getMarketplacePosts: vi.fn(async () => []) };
});

const HOUR = 60 * 60 * 1000;
const start = new Date(2030, 8, 28, 9, 0).getTime(); // SAT 28 SEP 2030, local time

const baseEvent: any = {
    id: 'ev-1', type: 'event', category: 'community', title: 'Working bee at the hall — bring gloves, hats and a long-handled shovel',
    description: 'Clearing the back garden', credits: 0, priceType: 'fixed', authorPublicKey: 'host-pk', authorCallsign: 'Hazel',
    createdAt: new Date().toISOString(), active: true, status: 'active', repeatable: false, lat: -28.55, lng: 153.5,
    eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 3 * HOUR).toISOString(),
    eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled', goingCount: 7, interestedCount: 3, myRsvp: 'going',
};
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

/** The floor the design holds to: a 320px-wide card. jsdom does no layout, so the layout contract is the classes. */
function renderAt320(ui: React.ReactElement) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    return render(<div style={{ width: 320 }}>{ui}</div>);
}

describe('an event\'s tags on its page (DESIGN-owner-seeding-tags-fable.md §4.4)', () => {
    it('the chips, in the member\'s language, each opening the tag; an id this library can\'t label shows as nothing', () => {
        const onOpenTag = vi.fn();
        render(<EventDetail post={{ ...baseEvent, tags: ['food.fruit.lemon', 'food.from-a-newer-library'] }} identity={identity} onOpenTag={onOpenTag} />);
        const row = screen.getByTestId('post-detail-tags');
        expect(within(row).getAllByRole('button').map(b => b.textContent)).toEqual(['#Lemon']);
        fireEvent.click(within(row).getByRole('button', { name: 'Filter marketplace by tag Lemon' }));
        expect(onOpenTag).toHaveBeenCalledWith('food.fruit.lemon');
    });

    it('a tag its host typed shows as #word and opens exactly that tag', () => {
        const onOpenFreeTag = vi.fn();
        render(<EventDetail post={{ ...baseEvent, freeTags: ['live music'] }} identity={identity} onOpenTag={vi.fn()} onOpenFreeTag={onOpenFreeTag} />);
        const row = screen.getByTestId('post-detail-tags');
        expect(within(row).getAllByRole('button').map(b => b.textContent)).toEqual(['#live music']);
        fireEvent.click(within(row).getByRole('button', { name: 'Filter marketplace by tag #live music' }));
        expect(onOpenFreeTag).toHaveBeenCalledWith('live music');
    });

    it('no tags, or only ones it can\'t label: no row', () => {
        const { unmount } = render(<EventDetail post={baseEvent} identity={identity} onOpenTag={vi.fn()} />);
        expect(screen.queryByTestId('post-detail-tags')).toBeNull();
        unmount();
        render(<EventDetail post={{ ...baseEvent, tags: ['food.from-a-newer-library'] }} identity={identity} onOpenTag={vi.fn()} />);
        expect(screen.queryByTestId('post-detail-tags')).toBeNull();
    });
});

describe('EventCard at 320px (docs/events-on-the-map.md §3)', () => {
    beforeEach(() => { vi.mocked(api.rsvpEvent).mockReset(); });
    afterEach(() => { document.documentElement.style.fontSize = ''; });

    it('leads with the chips, then the date and time in the largest text, then title, place and distance, counts', () => {
        renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null }} identity={identity} distanceKm={2.4} />);
        const card = screen.getByTestId('event-card');
        const lines = within(card).getByRole('button', { name: /Open event/ }).querySelectorAll(':scope > span');
        // The chip row is the first line, as it is on the offer cards; the date has the next line to itself.
        expect(lines[0]).toBe(screen.getByTestId('event-chips'));
        expect(lines[0].textContent).toBe('EVENT');
        expect(lines[1].textContent).toBe('SAT 28 SEP ·9:00–12:00');
        expect(screen.getByTestId('event-when').getAttribute('aria-label')).toBe('SAT 28 SEP · 9:00–12:00');
        expect(lines[1].className).toMatch(/flex-wrap/);
        expect(lines[2].textContent).toBe(baseEvent.title);
        expect(lines[3].textContent).toBe('📍 Bindarrabi Hall · 2.4 km');
        expect(lines[4].textContent).toBe('👥 7 going · 3 interested');

        const when = screen.getByTestId('event-when');
        // The time is never cut off: day and time are whole pieces, in the largest text, that wrap onto a
        // second line if they must.
        expect(Array.from(when.children).map(c => [c.textContent, /whitespace-nowrap/.test(c.className), /text-lg/.test(c.className)])).toEqual([
            ['SAT 28 SEP ·', true, true], ['9:00–12:00', true, true],
        ]);
        // Every other row gives way before the card does: nothing may push it past 320px. The title and the place are
        // cut with an ellipsis; the counts wrap inside the card's width instead, so a longer language never cuts them
        // (words sweep W1: "interested" ran past the card in the pseudo-locale at 320 px with 1.3x text).
        for (const line of Array.from(lines).slice(2, 4)) expect((line as HTMLElement).className).toMatch(/truncate/);
        expect(lines[4].className).toMatch(/(^| )block( |$)/);
        expect(lines[4].className).toMatch(/(^| )w-full( |$)/);
        expect(lines[4].className).toMatch(/(^| )break-words( |$)/);
        expect(card.className).toMatch(/min-w-0/);
        expect(card.className).toMatch(/overflow-hidden/);
    });

    it('shows my status on the filled button, with 48px targets that share the row', () => {
        renderAt320(<EventCard post={baseEvent} identity={identity} rsvpOnCard />);
        const going = screen.getByRole('button', { name: 'Going ✓' });
        const interested = screen.getByRole('button', { name: 'Interested' });
        expect(going).toHaveAttribute('aria-pressed', 'true');
        expect(interested).toHaveAttribute('aria-pressed', 'false');
        for (const b of [going, interested]) {
            expect(b.className).toContain('min-h-[48px]');
            // They share the row by *growing* into it, never by shrinking below their own label: `min-w-0`
            // here is what split "Intereste / d" (Marty, 2026-09-24). See the wrapping test below.
            expect(b.className).toContain('grow');
            expect(b.className).not.toContain('min-w-0');
        }
    });

    /**
     * Marty, 2026-09-24: on the 5-column desktop Market grid the button read "Intereste / d". jsdom does no
     * layout, so the contract is the classes: nothing may give the label permission to break inside a word, the
     * button may not shrink below that label, and the row wraps so a button that no longer fits beside its
     * neighbour takes a full-width row instead of being squeezed.
     */
    it.each([
        ['the card', (p: any) => <EventCard post={p} identity={identity} rsvpOnCard />],
        ['the event page', (p: any) => <EventDetail post={p} identity={identity} />],
    ])('never lets a button label break mid-word, and wraps the row instead — %s', (_where, ui) => {
        renderAt320(ui(baseEvent));
        const going = screen.getByRole('button', { name: 'Going ✓' });
        const interested = screen.getByRole('button', { name: 'Interested' });

        for (const b of [going, interested]) {
            // No mid-word break permission of any kind.
            expect(b.className).not.toMatch(/break-words|break-all|anywhere/);
            // The label stays on one line, and the button is at least as wide as that label.
            expect(b.className).toContain('whitespace-nowrap');
            expect(b.className).toContain('min-w-fit');
            expect(b.className).toContain('basis-auto');
            expect(b.className).not.toContain('min-w-0');
        }

        // Too narrow for both side by side => Interested drops to its own full-width row.
        const row = interested.parentElement!;
        expect(row).toBe(going.parentElement);
        expect(row.className).toMatch(/flex-wrap/);
    });

    /**
     * The other half of sizing each button to its own label: the label has to stay in the layout while the save
     * is in flight. A button whose only child became a spinner (or a differently-sized "Saving…") would resize
     * on tap, and a row near its wrap threshold would re-flow under the finger and again when the save landed.
     */
    it('keeps a button at its label width while the RSVP is saving', async () => {
        let settle: (res: any) => void = () => {};
        vi.mocked(api.rsvpEvent).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
        renderAt320(<EventCard post={baseEvent} identity={identity} rsvpOnCard />);
        const [going, interested] = within(screen.getByTestId('event-rsvp-row')).getAllByRole('button');
        fireEvent.click(interested);

        await waitFor(() => expect(interested).toHaveAttribute('aria-busy', 'true'));
        // The label is still there, hidden, holding the width — and the busy indicator is out of the flow on
        // top of it, so neither button moves.
        const label = within(interested).getByText('Interested');
        expect(label.className).toContain('invisible');
        expect(interested.querySelector('.animate-spin')!.closest('span[aria-hidden="true"]')!.className).toContain('absolute');
        expect(going.textContent).toBe('Going ✓');

        settle({ success: true, post: { ...baseEvent, myRsvp: 'interested', goingCount: 6, interestedCount: 4 } });
        await waitFor(() => expect(interested).toHaveAttribute('aria-busy', 'false'));
    });

    it('does not show the host name on the card', () => {
        renderAt320(<EventCard post={baseEvent} identity={identity} />);
        expect(screen.queryByText(/Hazel/)).not.toBeInTheDocument();
    });

    it('one tap RSVPs, and the counts follow the node', async () => {
        vi.mocked(api.rsvpEvent).mockResolvedValueOnce({ success: true, post: { ...baseEvent, myRsvp: 'interested', goingCount: 6, interestedCount: 4 } });
        const onRsvpChange = vi.fn();
        renderAt320(<EventCard post={baseEvent} identity={identity} onRsvpChange={onRsvpChange} rsvpOnCard />);
        fireEvent.click(screen.getByRole('button', { name: 'Interested' }));
        await waitFor(() => expect(api.rsvpEvent).toHaveBeenCalledWith('ev-1', 'interested'));
        expect(await screen.findByText(/6 going · 4 interested/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Interested ✓' })).toHaveAttribute('aria-pressed', 'true');
        expect(onRsvpChange).toHaveBeenCalled();
    });

    it('tapping my current status again is "not going"', async () => {
        vi.mocked(api.rsvpEvent).mockResolvedValueOnce({ success: true, post: { ...baseEvent, myRsvp: null, goingCount: 6 } });
        renderAt320(<EventCard post={baseEvent} identity={identity} rsvpOnCard />);
        fireEvent.click(screen.getByRole('button', { name: 'Going ✓' }));
        await waitFor(() => expect(api.rsvpEvent).toHaveBeenCalledWith('ev-1', null));
        expect(await screen.findByRole('button', { name: 'Going' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('marks UPDATED and CANCELLED in the chip row; a cancelled event cannot be RSVPd', () => {
        const { unmount } = renderAt320(<EventCard post={{ ...baseEvent, eventState: 'updated' }} identity={identity} rsvpOnCard />);
        expect(screen.getByTestId('event-state-badge')).toHaveTextContent('UPDATED');
        // In the chip row above the date, never in the date's own row: nothing can squeeze the time.
        expect(screen.getByTestId('event-state-badge').parentElement).toBe(screen.getByTestId('event-chips'));
        expect(screen.getByTestId('event-state-badge').parentElement).not.toBe(screen.getByTestId('event-when').parentElement);
        unmount();
        renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null, eventState: 'cancelled' }} identity={identity} rsvpOnCard />);
        expect(screen.getByTestId('event-state-badge')).toHaveTextContent('CANCELLED');
        expect(screen.getByRole('button', { name: 'Going' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Interested' })).toBeDisabled();
    });

    it('a cancelled event, the member Going, "Not going" answered with post:null → the card shows not going and the right counts', async () => {
        vi.mocked(api.rsvpEvent).mockResolvedValueOnce({ success: true, post: null });
        const onRsvpChange = vi.fn();
        renderAt320(<EventCard post={{ ...baseEvent, eventState: 'cancelled', myRsvp: 'going', goingCount: 7, interestedCount: 3 }} identity={identity} onRsvpChange={onRsvpChange} rsvpOnCard />);
        const going = screen.getByRole('button', { name: 'Going ✓' });
        expect(going).not.toBeDisabled();
        expect(screen.getByRole('button', { name: 'Interested' })).toBeDisabled();

        fireEvent.click(going);
        await waitFor(() => expect(api.rsvpEvent).toHaveBeenCalledWith('ev-1', null));

        expect(await screen.findByText(/6 going · 3 interested/)).toBeInTheDocument();
        const goingAfter = screen.getByRole('button', { name: 'Going' });
        expect(goingAfter).toHaveAttribute('aria-pressed', 'false');
        expect(goingAfter).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Interested' })).toBeDisabled();
        expect(onRsvpChange).toHaveBeenCalledWith(expect.objectContaining({
            myRsvp: null,
            goingCount: 6,
            interestedCount: 3,
        }));
    });

    it('a viewer with no identity cannot RSVP', () => {
        renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null }} identity={null} rsvpOnCard />);
        expect(screen.getByRole('button', { name: 'Going' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Interested' })).toBeDisabled();
    });

    it('hides decorative emojis from screen readers with aria-hidden="true"', () => {
        const { container } = renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null }} identity={identity} distanceKm={2.4} />);
        const hiddenEmojis = container.querySelectorAll('[aria-hidden="true"]');
        const hiddenTexts = Array.from(hiddenEmojis).map(e => e.textContent?.trim());
        expect(hiddenTexts).toContain('📍');
        expect(hiddenTexts).toContain('👥');
    });
});

/**
 * The Market's event card (Marty, 4 Nov 2026, DESIGN-market-event-cards-fable.md §2.2, §2.3): no Going / Interested on
 * the small card. It is one tap target that opens the event; the viewer's own answer is text on it; counts show once
 * anyone has answered; the pin and the badge are in a chip row above the date, which keeps its whole line.
 */
describe('EventCard without buttons (the Market, Your events)', () => {
    beforeEach(() => { vi.mocked(api.rsvpEvent).mockReset(); });
    afterEach(() => { document.documentElement.style.fontSize = ''; });
    const pinned: any = { ...baseEvent, myRsvp: null, status: 'active', pinnedAt: new Date().toISOString(), pinnedUntil: new Date(Date.now() + 3 * 24 * HOUR).toISOString() };

    it('has no button but the one that opens the event, and no Going / Interested row', () => {
        const onOpen = vi.fn();
        renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null }} identity={identity} onOpen={onOpen} />);
        const card = screen.getByTestId('event-card');
        const buttons = within(card).getAllByRole('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0]).toHaveAccessibleName(/^Open event: /);
        expect(screen.queryByTestId('event-rsvp-row')).toBeNull();
        expect(screen.queryByRole('button', { name: /^Going/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Interested/ })).toBeNull();
        // A tap anywhere on the card opens it, and answers nothing.
        fireEvent.click(within(card).getByText('Bindarrabi Hall', { exact: false }));
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(api.rsvpEvent).not.toHaveBeenCalled();
    });

    it('shows my answer as text inside the card, and says it in the button’s label', () => {
        const { unmount } = renderAt320(<EventCard post={baseEvent} identity={identity} onOpen={() => {}} />);
        const mark = screen.getByTestId('event-my-answer');
        expect(mark).toHaveTextContent('Going ✓');
        expect(mark.closest('button')).toBe(screen.getByRole('button', { name: /^Open event: / }));
        expect(screen.getByRole('button', { name: /^Open event: / })).toHaveAccessibleName(`Open event: ${baseEvent.title}, Going ✓`);
        // Text, not a control, and in the central event ink.
        expect(mark.tagName).toBe('SPAN');
        expect(mark.className).toMatch(/text-bp-tile-event-ink/);
        // My answer stands in the place of the counts.
        expect(screen.queryByTestId('event-counts')).toBeNull();
        unmount();

        renderAt320(<EventCard post={{ ...baseEvent, myRsvp: 'interested' }} identity={identity} onOpen={() => {}} />);
        expect(screen.getByTestId('event-my-answer')).toHaveTextContent('Interested ✓');
    });

    it('with no answer of mine: the counts once anyone has answered, nothing at 0 going · 0 interested', () => {
        const { unmount } = renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null, goingCount: 3, interestedCount: 1 }} identity={identity} />);
        expect(screen.queryByTestId('event-my-answer')).toBeNull();
        expect(screen.getByTestId('event-counts')).toHaveTextContent('3 going · 1 interested');
        unmount();

        // One of the two is enough to say it.
        const { unmount: unmount2 } = renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null, goingCount: 0, interestedCount: 2 }} identity={identity} />);
        expect(screen.getByTestId('event-counts')).toHaveTextContent('0 going · 2 interested');
        unmount2();

        const { container } = renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null, goingCount: 0, interestedCount: 0 }} identity={identity} />);
        expect(screen.queryByTestId('event-counts')).toBeNull();
        expect(container.textContent).not.toMatch(/going|interested/i);
    });

    it('hides zero counts on the map preview card too, where the buttons stay', () => {
        renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null, goingCount: 0, interestedCount: 0 }} identity={identity} rsvpOnCard />);
        expect(screen.queryByTestId('event-counts')).toBeNull();
        expect(screen.getByTestId('event-rsvp-row')).toBeInTheDocument();
        // The buttons are the answer there, so the text mark is not drawn twice.
        expect(screen.queryByTestId('event-my-answer')).toBeNull();
    });

    it('says the host is hosting, and keeps the host’s counts under it', () => {
        const hosted: any = { ...baseEvent, myRsvp: null, eventRsvps: [{ memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' }] };
        renderAt320(<EventCard post={hosted} identity={identity} />);
        expect(screen.getByTestId('event-hosting')).toHaveTextContent("You're hosting this event");
        expect(screen.getByTestId('event-hosting').closest('button')).toBe(screen.getByRole('button', { name: /^Open event: / }));
        // The label stands in for what is inside the button, so a screen reader still hears that this is theirs.
        expect(screen.getByRole('button', { name: /^Open event: / })).toHaveAccessibleName(/, You're hosting this event$/);
        expect(screen.getByTestId('event-counts')).toHaveTextContent('7 going · 3 interested');
        expect(screen.queryByTestId('event-my-answer')).toBeNull();
    });

    it('a member’s copy on the global community has its copy line and no answer or counts', () => {
        const from = { host: 'mullum.example.org', postId: 'home-1', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' };
        renderAt320(<EventCard post={{ ...baseEvent, myRsvp: 'going', shownCopy: true, shownFrom: from } as any} identity={identity} />);
        expect(screen.getByTestId('event-copy-line')).toBeInTheDocument();
        expect(screen.queryByTestId('event-my-answer')).toBeNull();
        expect(screen.queryByTestId('event-counts')).toBeNull();
    });

    it('keeps the date whole and alone on its line: the pin is in the chip row above it', () => {
        renderAt320(<EventCard post={pinned} identity={identity} />);
        const chips = screen.getByTestId('event-chips');
        const pin = screen.getByTestId('event-pinned-chip');
        const when = screen.getByTestId('event-when');
        expect(pin).toHaveTextContent('📌 PINNED');
        expect(chips.contains(pin)).toBe(true);
        // Outside the date, and not in the date's row either.
        expect(when.contains(pin)).toBe(false);
        expect(when.parentElement!.contains(pin)).toBe(false);
        // The date row holds the date's own two pieces, whole.
        expect(Array.from(when.children).map(c => c.textContent)).toEqual(['SAT 28 SEP ·', '9:00–12:00']);
        expect(when.parentElement!.textContent).toBe('SAT 28 SEP ·9:00–12:00');
        // And the row is above the date, in the card’s one button.
        expect(chips.compareDocumentPosition(when) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(chips.closest('button')).toBe(screen.getByRole('button', { name: /^Open event: / }));
    });

    it('the chip row reads EVENT, PINNED, then the state, from the central colour tokens', () => {
        renderAt320(<EventCard post={{ ...pinned, eventState: 'updated' }} identity={identity} />);
        const chips = screen.getByTestId('event-chips');
        expect(Array.from(chips.children).map(c => c.textContent)).toEqual(['EVENT', '📌 PINNED', 'UPDATED']);
        expect(screen.getByTestId('event-type-chip').className).toMatch(/bg-bp-tile-event-tint/);
        expect(screen.getByTestId('event-type-chip').className).toMatch(/text-bp-tile-event-ink/);
        expect(screen.getByTestId('event-pinned-chip').className).toMatch(/bg-bp-chip-accent-tint/);
        expect(screen.getByTestId('event-pinned-chip').className).toMatch(/text-bp-chip-accent-ink/);
        expect(screen.getByTestId('event-state-badge').className).toMatch(/bg-bp-tile-event-tint/);
        for (const chip of Array.from(chips.children)) {
            // Whole pieces that wrap to a new row rather than shrink; no raw colour on any of them.
            expect(chip.className).toMatch(/flex-shrink-0/);
            expect(chip.className).toMatch(/whitespace-nowrap/);
            expect(chip.className).not.toMatch(/(^| )(bg|text|border)-(amber|red|violet)-/);
        }
        expect(chips.className).toMatch(/flex-wrap/);
    });

    it('CANCELLED and ENDED wear the danger chip', () => {
        const { unmount } = renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null, eventState: 'cancelled' }} identity={identity} />);
        expect(screen.getByTestId('event-state-badge')).toHaveTextContent('CANCELLED');
        expect(screen.getByTestId('event-state-badge').className).toMatch(/bg-bp-chip-danger-tint/);
        expect(screen.getByTestId('event-state-badge').className).toMatch(/text-bp-chip-danger-ink/);
        unmount();
        const over = new Date(2020, 0, 1, 9, 0).getTime();
        renderAt320(<EventCard post={{ ...baseEvent, myRsvp: null, eventStartAt: new Date(over).toISOString(), eventEndAt: new Date(over + HOUR).toISOString() }} identity={identity} />);
        expect(screen.getByTestId('event-state-badge')).toHaveTextContent('ENDED');
        expect(screen.getByTestId('event-state-badge').className).toMatch(/bg-bp-chip-danger-tint/);
    });

    it('is the same chip row on the map preview card, where the buttons stay', () => {
        renderAt320(<EventCard post={pinned} identity={identity} rsvpOnCard />);
        expect(Array.from(screen.getByTestId('event-chips').children).map(c => c.textContent)).toEqual(['EVENT', '📌 PINNED']);
        expect(screen.getByTestId('event-when').parentElement!.textContent).toBe('SAT 28 SEP ·9:00–12:00');
        expect(screen.getByTestId('event-rsvp-row')).toBeInTheDocument();
    });

    it('the page keeps its pin and its badge, in a row above the date', () => {
        renderAt320(<EventDetail post={{ ...pinned, eventState: 'updated' }} identity={identity} />);
        const detail = screen.getByTestId('event-detail');
        const chips = within(detail).getByTestId('event-chips');
        // No EVENT chip on the page: it is plainly an event.
        expect(Array.from(chips.children).map(c => c.textContent)).toEqual(['📌 PINNED', 'UPDATED']);
        // The heading is the date alone now: the pin and the badge are no longer words inside it.
        const heading = within(detail).getByRole('heading', { level: 2 });
        expect(heading.textContent).toBe('SAT 28 SEP ·9:00–12:00');
        expect(heading.contains(chips)).toBe(false);
        expect(chips.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('the page has no chip row when there is nothing to put in it', () => {
        renderAt320(<EventDetail post={{ ...baseEvent, myRsvp: null }} identity={identity} />);
        expect(screen.queryByTestId('event-chips')).toBeNull();
    });
});

describe("The event's photo on the card (Damo, 2026-09-23)", () => {
    const withPhoto: any = { ...baseEvent, photos: ['/uploads/working-bee.jpg', '/uploads/second.jpg'] };

    it('shows the first photo, with the title as its alt text', () => {
        renderAt320(<EventCard post={withPhoto} identity={identity} distanceKm={2.4} />);
        const img = within(screen.getByTestId('event-card')).getByRole('img');
        expect(img).toHaveAttribute('src', '/uploads/working-bee.jpg');
        expect(img).toHaveAttribute('alt', baseEvent.title);
    });

    it('shows the event category tile when the event has no photo', () => {
        renderAt320(<EventCard post={baseEvent} identity={identity} distanceKm={2.4} />);
        const card = screen.getByTestId('event-card');
        expect(within(card).queryByRole('img')).toBeNull();
        expect(within(card).getByTestId('category-tile')).toBeInTheDocument();
        expect(within(card).getByTestId('category-tile').textContent).toMatch(/EVENT/i);
    });

    it('treats an empty photo list as no photo and renders event tile', () => {
        renderAt320(<EventCard post={{ ...baseEvent, photos: [] }} identity={identity} />);
        const card = screen.getByTestId('event-card');
        expect(within(card).queryByRole('img')).toBeNull();
        expect(within(card).getByTestId('category-tile')).toBeInTheDocument();
    });

    // Decision 3: the photo lives inside the tap target that opens the event. It must not become a second one —
    // an offer card's photo is part of that card (it opens the listing, 4 Nov), and a second target here would put two answers under one thumb.
    it('is inside the card’s one tap target, not a second one', () => {
        renderAt320(<EventCard post={withPhoto} identity={identity} onOpen={() => {}} />);
        const card = screen.getByTestId('event-card');
        const open = within(card).getByRole('button', { name: /Open event/ });
        const img = within(card).getByRole('img');
        expect(open.contains(img)).toBe(true);
        expect(img.closest('button')).toBe(open);
        expect(within(card).queryByRole('button', { name: /photo/i })).toBeNull();
    });

    // Decision 1: an event should sit among the offers, so the photo takes the same size, crop and rounding the
    // offer card uses in that view — MarketplaceCard's 110px banner in the grid, its 80px square in the list.
    // W2 of the style box (DESIGN-card-style-box-fable.md §1.1; DESIGN-market-event-cards-fable.md §3 W2): in the list the
    // event IS the offer's card: the same frame, and the photo flush under its left corners, the card's full height.
    it('matches the offer card: a banner in the grid; in the list the same box, the photo flush and the card\'s full height', () => {
        const { unmount } = renderAt320(<EventCard post={withPhoto} identity={identity} />);
        const grid = within(screen.getByTestId('event-card')).getByRole('img');
        expect(grid.className).toMatch(/h-\[110px\]/);
        expect(grid.className).toMatch(/w-full/);
        expect(grid.className).toMatch(/object-cover/);
        expect(grid.className).toMatch(/rounded-xl/);
        unmount();

        renderAt320(<EventCard post={withPhoto} identity={identity} viewMode="list" onOpen={() => {}} />);
        const card = screen.getByTestId('event-card');
        // The frame is the box's list card: no padding of its own, so nothing sits between its edge and the photo.
        expect(card.className.startsWith(listCard())).toBe(true);
        expect(card.className).not.toMatch(/(^|\s)p-\d/);
        const open = within(card).getByRole('button', { name: /Open event/ });
        expect(open.className).toMatch(/(^|\s)p-0(\s|$)/);
        // The photo slot is the first thing in the card's one tap target, 80 wide and stretched to the card's height.
        const slot = screen.getByTestId('event-list-photo');
        expect(open.firstElementChild).toBe(slot);
        expect(slot.className).toBe(LIST_PHOTO);
        // The event tile holds the slot until the photo has drawn (card-photo-blank), then the photo covers the slot.
        expect(within(slot).getByTestId('category-tile')).toBeInTheDocument();
        const img = slot.querySelector('img')!;
        fireEvent.load(img);
        expect(within(slot).queryByTestId('category-tile')).toBeNull();
        expect(within(card).getByRole('img')).toBe(img);
        expect(img).toHaveAttribute('alt', baseEvent.title);
        expect(img.className).toBe(`${LIST_PHOTO_FILL} object-cover`);
        // No fixed height anywhere on the card: it takes the height its lines need (Marty, 4 Nov 2026).
        for (const el of [card, open, slot, img]) expect(el.className).not.toMatch(/(^|\s)h-\d/);
    });

    it('in the list, an event card and an offer card are drawn from the same box', () => {
        const { container } = renderAt320(
            <>
                <EventCard post={withPhoto} identity={identity} viewMode="list" />
                <MarketplaceCard post={{ ...baseEvent, type: 'offer', photos: ['/uploads/offer.jpg'] } as any} viewMode="list" />
            </>,
        );
        const event = screen.getByTestId('event-card');
        const offer = screen.getByTestId('listing-list-card');
        expect(event.className.startsWith(listCard())).toBe(true);
        expect(offer.className.startsWith(listCard())).toBe(true);
        expect(screen.getByTestId('event-list-photo').className).toBe(screen.getByTestId('listing-list-photo').className);
        // The type chips are the one chip, in their own colours.
        expect(screen.getByTestId('event-type-chip').className).toBe(chip('event'));
        expect(container.querySelectorAll('[data-testid="event-type-chip"]')).toHaveLength(1);
    });

    // The style box's check (DESIGN-card-style-box-fable.md §4, W2): no raw violet and no nature-950 ground left on a list
    // card; the event violet is core's `tile.event` token, the ground the card token, in light and dark alike.
    it('the list card has no raw violet class and no nature-950 ground, pinned, updated, hosting or going', () => {
        const pinned = { pinnedAt: new Date().toISOString(), pinnedUntil: new Date(Date.now() + 86_400_000).toISOString() };
        const cases: any[] = [
            { ...withPhoto, ...pinned },
            { ...baseEvent, eventState: 'updated', eventRepeat: { freq: 'weekly', interval: 1, byDay: 'SA', time: '09:00', minutes: 180 } },
            { ...baseEvent, eventRsvps: [], myRsvp: null },
            { ...baseEvent, myRsvp: null },
        ];
        for (const post of cases) {
            const { container, unmount } = renderAt320(<EventCard post={post} identity={identity} viewMode="list" />);
            // Each case draws the line it is here for, so the check below reads its classes.
            if (post.eventRepeat) expect(container.querySelector('[data-testid="event-repeat-caption"]')).not.toBeNull();
            if (post.eventState === 'updated') expect(container.querySelector('[data-testid="event-state-badge"]')).not.toBeNull();
            if (post.pinnedAt) expect(container.querySelector('[data-testid="event-pinned-chip"]')).not.toBeNull();
            if (post.eventRsvps) expect(container.querySelector('[data-testid="event-hosting"]')).not.toBeNull();
            const all = Array.from(container.querySelectorAll('[class]')).map(e => e.getAttribute('class')).join(' ');
            expect(all).not.toMatch(/violet-/);
            expect(all).not.toMatch(/nature-950/);
            unmount();
        }
        // The when is in the event token.
        renderAt320(<EventCard post={baseEvent} identity={identity} viewMode="list" />);
        expect(within(screen.getByTestId('event-card')).getByText(/SAT 28 SEP/).className).toContain(CARD_INK.event);
    });

    // Decision 1 again, in the one view where matching the offer card means showing nothing: MarketplaceCard's
    // compact branch is a condensed row with no photo at all, built to double the listings on screen. A thumbnail
    // only the event had would make it the odd card out again, in the view with the least room for it.
    it('shows no photo in the compact view, where the offer cards beside it have none either', () => {
        renderAt320(<EventCard post={withPhoto} identity={identity} viewMode="compact" />);
        const card = screen.getByTestId('event-card');
        expect(within(card).queryByRole('img')).toBeNull();
        // And the lines stay the stack they have always been, not a column beside an empty gap.
        const lines = within(card).getByRole('button', { name: /Open event/ }).querySelectorAll(':scope > span');
        expect(lines[0]).toBe(screen.getByTestId('event-chips'));
        expect(lines[1].textContent).toBe('SAT 28 SEP ·9:00–12:00');
        expect(lines[2].textContent).toBe(baseEvent.title);
    });

    // Decision 4: at 320px with 1.3× text the photo gives way before the card does, and the RSVP row keeps the
    // card's full width under it rather than being squeezed into the column beside the thumbnail.
    it('holds at 320px: the photo cannot push the card wider, and the RSVP row keeps its own row', () => {
        renderAt320(<EventCard post={withPhoto} identity={identity} viewMode="list" rsvpOnCard />);
        const card = screen.getByTestId('event-card');
        expect(card.className).toMatch(/overflow-hidden/);
        // The list photo is the picture hook's (card-photo-blank): the tile holds the slot until the photo has drawn.
        fireEvent.load(card.querySelector('img')!);
        const img = within(card).getByRole('img');
        const going = screen.getByRole('button', { name: 'Going ✓' });
        expect(going.className).toContain('min-h-[48px]');
        // The RSVP buttons are siblings of the row that holds the photo, never inside it.
        expect(img.parentElement?.contains(going)).toBe(false);
    });
});

describe('EventDetail', () => {
    beforeEach(() => {
        vi.mocked(api.rsvpEvent).mockReset();
        vi.mocked(api.removeMarketplacePost).mockReset();
    });

    it('keeps the private note hidden until the viewer taps Going, then shows it', async () => {
        const notGoing = { ...baseEvent, myRsvp: null, goingCount: 6 };
        vi.mocked(api.rsvpEvent).mockResolvedValueOnce({ success: true, post: { ...baseEvent, eventPrivateNote: 'Gate code 1234' } });
        render(<EventDetail post={notGoing} identity={identity} />);
        expect(screen.queryByTestId('event-private-note')).not.toBeInTheDocument();
        expect(screen.queryByText(/Gate code/)).not.toBeInTheDocument();
        expect(screen.getByText(/shows here once you tap Going/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Going' }));
        await waitFor(() => expect(api.rsvpEvent).toHaveBeenCalledWith('ev-1', 'going'));
        expect(await screen.findByTestId('event-private-note')).toHaveTextContent('Gate code 1234');
    });

    it('shows the host line, but not the host panel, to an attendee', () => {
        render(<EventDetail post={{ ...baseEvent, eventPrivateNote: 'Gate code 1234' }} identity={identity} />);
        expect(screen.getByText('Hazel')).toBeInTheDocument();
        expect(screen.getByTestId('event-private-note')).toBeInTheDocument();
        expect(screen.queryByTestId('event-host-panel')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cancel event' })).not.toBeInTheDocument();
    });

    it('EventDetail with photos uses responsive two-column layout on wide screens with full-height photo', () => {
        const withPhoto = { ...baseEvent, photos: ['/uploads/event.jpg'] };
        render(<EventDetail post={withPhoto} identity={identity} />);
        const detail = screen.getByTestId('event-detail');
        const classes = detail.className.split(/\s+/);
        expect(classes).toContain('md:flex');
        expect(classes).toContain('md:flex-row');

        // The event's photo, by its alt (the host's box now carries a face of its own).
        const img = within(detail).getByRole('img', { name: withPhoto.title });
        const photoWrapper = img.parentElement as HTMLElement;
        expect(photoWrapper.className.split(/\s+/)).toContain('md:w-1/2');
    });

    it("gives the host who's going and Cancel event", async () => {
        const hosted = {
            ...baseEvent, myRsvp: null, eventPrivateNote: 'Gate code 1234',
            eventRsvps: [
                { memberPubkey: 'a', memberCallsign: 'Ari', status: 'interested', updatedAt: '' },
                { memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' },
            ],
        };
        vi.mocked(api.removeMarketplacePost).mockResolvedValueOnce({ success: true });
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const onCancelled = vi.fn();
        render(<EventDetail post={hosted} identity={identity} onCancelled={onCancelled} />);
        const panel = screen.getByTestId('event-host-panel');
        const rows = within(panel).getAllByRole('listitem').map(li => li.textContent);
        expect(rows).toEqual(['BoGoing', 'AriInterested']);
        fireEvent.click(within(panel).getByRole('button', { name: 'Cancel event' }));
        await waitFor(() => expect(api.removeMarketplacePost).toHaveBeenCalledWith('ev-1', 'host-pk'));
        expect(onCancelled).toHaveBeenCalled();
        confirm.mockRestore();
    });

    it('offers Show on map for a pinned event', () => {
        const onShowOnMap = vi.fn();
        render(<EventDetail post={baseEvent} identity={identity} onShowOnMap={onShowOnMap} />);
        fireEvent.click(screen.getByRole('button', { name: 'Show on map' }));
        expect(onShowOnMap).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-1' }));
    });
});

describe('Copy to a new date (docs/events-on-the-map.md §3, slice 5)', () => {
    const hosted: any = {
        ...baseEvent, myRsvp: null, eventPrivateNote: 'Gate code 1234',
        eventRsvps: [{ memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' }],
    };

    it('is offered to the host, next to Cancel event', () => {
        const onCopy = vi.fn();
        render(<EventDetail post={hosted} identity={identity} onCopyToNewDate={onCopy} />);
        const panel = screen.getByTestId('event-host-panel');
        fireEvent.click(within(panel).getByTestId('event-copy-to-new-date'));
        expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-1' }));
    });

    it('is offered on an event that has already finished — which is when a host wants it', () => {
        const finished = { ...hosted, eventStartAt: new Date(2020, 0, 1, 9).toISOString(), eventEndAt: new Date(2020, 0, 1, 11).toISOString() };
        render(<EventDetail post={finished} identity={identity} onCopyToNewDate={vi.fn()} />);
        const panel = screen.getByTestId('event-host-panel');
        expect(within(panel).getByTestId('event-copy-to-new-date')).toBeTruthy();
        // Cancel is gone once it is over; Copy is not.
        expect(within(panel).queryByRole('button', { name: 'Cancel event' })).toBeNull();
    });

    it('is not offered to anyone but the host', () => {
        render(<EventDetail post={baseEvent} identity={identity} onCopyToNewDate={vi.fn()} />);
        expect(screen.queryByTestId('event-copy-to-new-date')).toBeNull();
    });

    it('keeps a 48px target and does not overflow at 320px', () => {
        renderAt320(<EventDetail post={hosted} identity={identity} onCopyToNewDate={vi.fn()} />);
        const btn = screen.getByTestId('event-copy-to-new-date');
        expect(btn.className).toMatch(/min-h-\[48px\]/);
    });
});

describe('Events round 2: the host (A1, A3, A4, B4)', () => {
    const hosted: any = {
        ...baseEvent, myRsvp: null, eventPrivateNote: 'Gate code 1234',
        eventRsvps: [{ memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' }],
    };
    beforeEach(() => {
        vi.mocked(api.removeMarketplacePost).mockReset();
        vi.mocked(api.getMarketplacePosts).mockReset();
        vi.mocked(api.getMarketplacePosts).mockResolvedValue([]);
    });

    it('does not show Going / Interested to the host on the card or the page (B4)', () => {
        const { unmount } = render(<EventCard post={hosted} identity={identity} rsvpOnCard />);
        expect(screen.queryByRole('button', { name: 'Going' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Interested' })).toBeNull();
        expect(screen.getByTestId('event-hosting')).toHaveTextContent("You're hosting this event");
        unmount();
        render(<EventDetail post={hosted} identity={identity} />);
        expect(screen.queryByRole('button', { name: 'Going' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Interested' })).toBeNull();
        expect(screen.getByTestId('event-hosting')).toBeInTheDocument();
    });

    it('still shows Going / Interested to everyone else', () => {
        render(<EventCard post={baseEvent} identity={identity} rsvpOnCard />);
        expect(screen.getByRole('button', { name: /Going/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Interested/ })).toBeInTheDocument();
        expect(screen.queryByTestId('event-hosting')).toBeNull();
    });

    it('offers Edit event to the host of an open event, as a 48px target (A1)', () => {
        const onEdit = vi.fn();
        renderAt320(<EventDetail post={hosted} identity={identity} onEdit={onEdit} />);
        const btn = within(screen.getByTestId('event-host-panel')).getByRole('button', { name: 'Edit event' });
        expect(btn.className).toMatch(/min-h-\[48px\]/);
        fireEvent.click(btn);
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-1' }));
    });

    it('does not offer Edit to anyone but the host', () => {
        render(<EventDetail post={baseEvent} identity={identity} onEdit={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Edit event' })).toBeNull();
        expect(screen.queryByTestId('event-edit-blocked')).toBeNull();
    });

    it('says plainly that an ended event cannot be edited, instead of a button that would fail (A3)', () => {
        const ended = { ...hosted, eventStartAt: new Date(2020, 0, 1, 9).toISOString(), eventEndAt: new Date(2020, 0, 1, 11).toISOString() };
        render(<EventDetail post={ended} identity={identity} onEdit={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Edit event' })).toBeNull();
        expect(screen.getByTestId('event-edit-blocked')).toHaveTextContent('This event has ended, so it can no longer be edited.');
    });

    it('says plainly that a cancelled event cannot be edited (A3)', () => {
        const cancelled = { ...hosted, status: 'cancelled', eventState: 'cancelled', active: false };
        render(<EventDetail post={cancelled} identity={identity} onEdit={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Edit event' })).toBeNull();
        expect(screen.getByTestId('event-edit-blocked')).toHaveTextContent('This event was cancelled, so it can no longer be edited.');
    });

    it('after cancelling, the host stays on the event page and sees it CANCELLED (A4)', async () => {
        const nowCancelled = { ...hosted, status: 'cancelled', eventState: 'cancelled', active: false };
        vi.mocked(api.removeMarketplacePost).mockResolvedValueOnce({ success: true });
        vi.mocked(api.getMarketplacePosts).mockResolvedValueOnce([nowCancelled]);
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const onCancelled = vi.fn();
        render(<EventDetail post={hosted} identity={identity} onCancelled={onCancelled} onEdit={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel event' }));
        await waitFor(() => expect(onCancelled).toHaveBeenCalledWith(nowCancelled));
        expect(api.getMarketplacePosts).toHaveBeenCalledWith({ id: 'ev-1', types: 'offer,need,poll,event' });
        expect(screen.getByTestId('event-detail')).toBeInTheDocument();
        expect(screen.getAllByTestId('event-state-badge')[0]).toHaveTextContent('CANCELLED');
        expect(screen.queryByRole('button', { name: 'Cancel event' })).toBeNull();
        expect(screen.getByTestId('event-edit-blocked')).toBeInTheDocument();
        confirm.mockRestore();
    });

    it('marks it CANCELLED on the page even when the re-read fails (offline)', async () => {
        vi.mocked(api.removeMarketplacePost).mockResolvedValueOnce({ success: true });
        vi.mocked(api.getMarketplacePosts).mockRejectedValueOnce(new Error('offline'));
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        render(<EventDetail post={hosted} identity={identity} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel event' }));
        await waitFor(() => expect(screen.getAllByTestId('event-state-badge')[0]).toHaveTextContent('CANCELLED'));
        confirm.mockRestore();
    });
});

describe('Event times on the card and the detail (DESIGN-event-times §4, slice 2)', () => {
    const savedTz = process.env.TZ;
    // A reader in New York, so a Lagos or Sydney event reads differently from their own clock.
    beforeEach(() => { process.env.TZ = 'America/New_York'; });
    afterEach(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; document.documentElement.style.fontSize = ''; });

    // Lagos (UTC+1): Sat 28 Sep 2030 20:50 at the hall is 19:50Z, 15:50 in New York.
    const lagos = {
        ...baseEvent, eventStartAt: '2030-09-28T19:50:00.000Z', eventEndAt: '2030-09-28T21:50:00.000Z',
        eventStartLocal: '2030-09-28T20:50', eventEndLocal: '2030-09-28T22:50', eventTz: 'Africa/Lagos', eventOnline: false,
    };
    // Online, a Sydney host's Fri 18 Oct 2030 20:50 (AEDT): 09:50Z, 5:50 in New York.
    const online = {
        ...baseEvent, lat: undefined, lng: undefined, eventPlaceName: undefined,
        eventStartAt: '2030-10-18T09:50:00.000Z', eventEndAt: '2030-10-18T11:50:00.000Z',
        eventStartLocal: '2030-10-18T20:50', eventEndLocal: '2030-10-18T22:50', eventTz: 'Australia/Sydney', eventOnline: true,
    };

    it('in person somewhere else: the place clock leads, the second time under it, each half whole', () => {
        renderAt320(<EventCard post={lagos} identity={identity} distanceKm={2.4} />);
        const when = screen.getByTestId('event-when');
        expect(Array.from(when.children).map(c => c.textContent)).toEqual(['SAT 28 SEP ·', '20:50–22:50']);
        expect(when.getAttribute('aria-label')).toBe('SAT 28 SEP · 20:50–22:50 · Lagos time · 15:50 your time');
        const note = screen.getByTestId('event-when-note');
        expect(Array.from(note.children).map(c => [c.textContent, /whitespace-nowrap/.test(c.className)])).toEqual([
            ['Lagos time ·', true], ['15:50 your time', true],
        ]);
        expect(note.className).toMatch(/flex-wrap/);
    });

    it('in person where the reader is: no second line', () => {
        const here = { ...lagos, eventStartAt: '2030-09-29T00:50:00.000Z', eventEndAt: '2030-09-29T02:50:00.000Z', eventTz: 'America/New_York' };
        renderAt320(<EventCard post={here} identity={identity} />);
        expect(screen.getByTestId('event-when').getAttribute('aria-label')).toBe('SAT 28 SEP · 20:50–22:50');
        expect(screen.queryByTestId('event-when-note')).not.toBeInTheDocument();
    });

    it("online: the reader's own time, \"your time\", and Online where the place goes", () => {
        renderAt320(<EventCard post={online} identity={identity} distanceKm={3} />);
        expect(screen.getByTestId('event-when').getAttribute('aria-label')).toBe('FRI 18 OCT · 5:50–7:50 your time');
        // "your time" is a whole piece of its own, so the line can wrap before it at 320px in the page's large text.
        expect(Array.from(screen.getByTestId('event-when').children).map(c => [c.textContent, /whitespace-nowrap/.test(c.className)])).toEqual([
            ['FRI 18 OCT ·', true], ['5:50–7:50', true], ['your time', true],
        ]);
        const card = screen.getByTestId('event-card');
        expect(within(card).getByText('Online').textContent).toBe('🌐 Online');
        expect(within(card).queryByText(/km/)).not.toBeInTheDocument();
        expect(screen.queryByTestId('event-when-note')).not.toBeInTheDocument();
    });

    it("the online detail: the host's clock, Join for Going, and the words for anyone else", () => {
        const { unmount } = render(<EventDetail post={{ ...online, eventLink: 'https://meet.example/abc' }} identity={identity} />);
        expect(screen.getByTestId('event-when-host')).toHaveTextContent('20:50 for the host (Sydney time)');
        const join = screen.getByTestId('event-join');
        expect(join.getAttribute('href')).toBe('https://meet.example/abc');
        expect(join.getAttribute('rel')).toBe('noopener noreferrer');
        expect(screen.queryByRole('button', { name: 'Show on map' })).not.toBeInTheDocument();
        unmount();

        render(<EventDetail post={{ ...online, myRsvp: 'interested' }} identity={identity} />);
        expect(screen.queryByTestId('event-join')).not.toBeInTheDocument();
        expect(screen.getByText('The link to join shows here once you tap Going.')).toBeInTheDocument();
    });

    it('never tells someone who is Going to tap Going: with no link yet, it says the host has not added one', () => {
        const { unmount } = render(<EventDetail post={{ ...online, myRsvp: 'going' }} identity={identity} />);
        expect(screen.getByTestId('event-join-hint')).toHaveTextContent('The host has not added a link to join yet.');
        expect(within(screen.getByTestId('event-online')).queryByText(/tap Going/)).not.toBeInTheDocument();
        unmount();
        render(<EventDetail post={{ ...online, myRsvp: null }} identity={identity} />);
        expect(screen.getByTestId('event-join-hint')).toHaveTextContent('The link to join shows here once you tap Going.');
    });

    it('never makes a link of anything but http(s)', () => {
        render(<EventDetail post={{ ...online, eventLink: 'javascript:alert(1)' }} identity={identity} />);
        expect(screen.queryByTestId('event-join')).not.toBeInTheDocument();
    });
});
