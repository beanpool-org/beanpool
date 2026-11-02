import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapCalendar } from './MapCalendar';
import type { MarketplacePost } from '../lib/api';

describe('MapCalendar (DESIGN-map-calendar-fable.md §1, §4, §8 S3)', () => {
    const localEvent: MarketplacePost = {
        id: 'ev-local-1',
        type: 'event',
        category: 'general',
        title: 'Working bee at the hall',
        description: 'Community gardening',
        credits: 0,
        priceType: 'fixed',
        authorCallsign: 'alice',
        authorPublicKey: 'alice-key',
        createdAt: '2026-11-01T00:00:00.000Z',
        eventStartLocal: '2026-11-07T09:00',
        eventEndLocal: '2026-11-07T12:00',
        eventStartAt: '2026-11-07T09:00:00.000Z',
        eventEndAt: '2026-11-07T12:00:00.000Z',
        status: 'active',
        active: true,
        repeatable: false,
    };

    const copyEvent: MarketplacePost = {
        id: 'ev-copy-1',
        type: 'event',
        category: 'general',
        title: 'Repair café',
        description: 'Fixing small appliances',
        credits: 0,
        priceType: 'fixed',
        authorCallsign: 'bob',
        authorPublicKey: 'bob-key',
        createdAt: '2026-11-01T00:00:00.000Z',
        eventStartLocal: '2026-11-07T14:00',
        eventEndLocal: '2026-11-07T16:00',
        eventStartAt: '2026-11-07T14:00:00.000Z',
        eventEndAt: '2026-11-07T16:00:00.000Z',
        status: 'active',
        active: true,
        repeatable: false,
        shownCopy: true,
        shownFrom: { host: 'mullum', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask', postId: 'ev-mullum' },
    };

    const decemberEvent: MarketplacePost = {
        id: 'ev-dec-1',
        type: 'event',
        category: 'general',
        title: 'December market',
        description: 'Christmas gifts and produce',
        credits: 0,
        priceType: 'fixed',
        authorCallsign: 'carol',
        authorPublicKey: 'carol-key',
        createdAt: '2026-11-01T00:00:00.000Z',
        eventStartLocal: '2026-12-06T10:00',
        eventEndLocal: '2026-12-06T14:00',
        eventStartAt: '2026-12-06T10:00:00.000Z',
        eventEndAt: '2026-12-06T14:00:00.000Z',
        status: 'active',
        active: true,
        repeatable: false,
    };

    it('renders calendar title and close button, and calls onClose when clicked', () => {
        const onClose = vi.fn();
        render(<MapCalendar posts={[localEvent]} onClose={onClose} />);
        const heading = screen.getByRole('heading', { level: 1, name: 'Calendar' });
        expect(heading).toBeInTheDocument();

        const header = heading.parentElement!;
        const closeBtn = within(header).getByRole('button', { name: 'Close' });
        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape key press', () => {
        const onClose = vi.fn();
        render(<MapCalendar posts={[localEvent]} onClose={onClose} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('hides when covered is true', () => {
        render(<MapCalendar posts={[localEvent]} covered={true} onClose={vi.fn()} />);
        const calendar = screen.getByTestId('map-calendar');
        expect(calendar).toHaveStyle({ display: 'none' });
    });

    it('has classes for right-third panel on wide screens (>= 768px) and overlay on narrow', () => {
        render(<MapCalendar posts={[localEvent]} covered={false} onClose={vi.fn()} />);
        const calendar = screen.getByTestId('map-calendar');
        const classes = calendar.className;
        expect(classes).toContain('md:w-1/3');
        expect(classes).toContain('md:min-w-[320px]');
        expect(classes).toContain('md:right-0');
    });

    it('displays weekday headers', () => {
        render(<MapCalendar posts={[localEvent]} onClose={vi.fn()} />);
        expect(screen.getAllByRole('columnheader').length).toBe(7);
    });

    it('marks event days with dots, displays day list for active event day with copy line', () => {
        const onOpenPost = vi.fn();
        render(<MapCalendar posts={[localEvent, copyEvent]} onClose={vi.fn()} onOpenPost={onOpenPost} />);

        // Dots on days with events
        const dots = screen.getAllByTestId('event-dot');
        expect(dots.length).toBeGreaterThanOrEqual(1);

        // MapStackList opens with heading "Sat 7 Nov: 2 events"
        const list = screen.getByTestId('map-stack-list');
        expect(within(list).getByRole('heading').textContent).toBe('Sat 7 Nov: 2 events');

        // Rows inside MapStackList
        expect(within(list).getByText('Working bee at the hall')).toBeInTheDocument();
        expect(within(list).getByText('Repair café')).toBeInTheDocument();

        // Copy event type line: "Event · from Mullumbimby"
        expect(within(list).getByText('Event · from Mullumbimby')).toBeInTheDocument();

        // Local event type line: "Event"
        expect(within(list).getByText('Event')).toBeInTheDocument();

        // Clicking a row opens post
        fireEvent.click(within(list).getByRole('button', { name: /Repair café/ }));
        expect(onOpenPost).toHaveBeenCalledWith(copyEvent);
    });

    it('shows "Nothing on <date>" when tapping a day without events', () => {
        render(<MapCalendar posts={[localEvent]} onClose={vi.fn()} />);

        // Find a day button without dots (e.g. 2026-11-10 or 2026-11-11)
        const dayButtons = screen.getAllByTestId('month-day-cell');
        const plainDay = dayButtons.find(btn => btn.getAttribute('data-date')?.endsWith('-10') || btn.getAttribute('data-date')?.endsWith('-11'));
        expect(plainDay).toBeDefined();

        fireEvent.click(plainDay!);
        const list = screen.getByTestId('map-stack-list');
        expect(within(list).getByRole('heading').textContent).toMatch(/Nothing on /);
    });

    it('shows empty month state with next event date jump when month has no events', () => {
        // Only decemberEvent: November has no events
        render(<MapCalendar posts={[decemberEvent]} onClose={vi.fn()} />);

        const emptyState = screen.getByTestId('month-empty-state');
        expect(emptyState).toHaveTextContent(/Nothing on in/);

        // Next event link
        const nextLink = screen.getByTestId('calendar-next-event-link');
        expect(nextLink).toHaveTextContent(/Next: Sun 6 Dec/);

        // Clicking next link jumps to December and selects the day
        fireEvent.click(nextLink);

        const list = screen.getByTestId('map-stack-list');
        expect(within(list).getByRole('heading').textContent).toBe('Sun 6 Dec: 1 event');
        expect(within(list).getByText('December market')).toBeInTheDocument();
    });

    it('shows "No events coming up yet." with "Start one ›" link when no events exist at all', () => {
        const onStartEvent = vi.fn();
        render(<MapCalendar posts={[]} onClose={vi.fn()} onStartEvent={onStartEvent} />);

        const emptyState = screen.getByTestId('month-empty-state');
        expect(emptyState).toHaveTextContent('No events coming up yet.');

        const startLink = screen.getByTestId('calendar-start-one-link');
        expect(startLink).toHaveTextContent('Start one ›');

        fireEvent.click(startLink);
        expect(onStartEvent).toHaveBeenCalledTimes(1);
    });
});
