/**
 * The map's date chips (Today / This weekend / Next 7 days), and the rule that an event which has ended
 * or been cancelled never pins.
 *
 * The phone's sync pull is a replica of the posts list, not the list, so it carries ended and cancelled
 * events; the map has to apply the feed rule itself. These tests pin a fixed `now` rather than the clock,
 * so "this weekend" means the same thing on a Tuesday as on a Sunday.
 */

import { describe, it, expect } from 'vitest';
import { EVENT_WINDOWS, eventInWindow, eventWindowRange, type EventWindow } from '../events';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Wednesday 2026-09-16, 10:00 local. */
const WED = new Date(2026, 8, 16, 10, 0, 0, 0).getTime();

function event(startMs: number, extra: Record<string, unknown> = {}) {
    return {
        id: `e-${startMs}`,
        type: 'event',
        status: 'active',
        active: 1,
        lat: -28.54,
        lng: 153.5,
        event_start_at: new Date(startMs).toISOString(),
        event_end_at: new Date(startMs + 2 * HOUR).toISOString(),
        event_state: 'scheduled',
        ...extra,
    };
}

describe('the chips the map offers', () => {
    it('is the web map\'s list: All, Today, This weekend, Next 7 days', () => {
        expect(EVENT_WINDOWS.map(w => w.id)).toEqual(['all', 'today', 'weekend', 'week']);
        expect(EVENT_WINDOWS.map(w => w.label)).toEqual(['All', 'Today', 'This weekend', 'Next 7 days']);
    });
});

describe('eventWindowRange', () => {
    it('runs Today from now to midnight', () => {
        const { from, to } = eventWindowRange('today', WED);
        expect(from).toBe(WED);
        expect(new Date(to).getDate()).toBe(17);
        expect(new Date(to).getHours()).toBe(0);
    });

    it('runs This weekend from Saturday 00:00 to Monday 00:00', () => {
        const { from, to } = eventWindowRange('weekend', WED);
        expect(new Date(from).getDate()).toBe(19); // Sat 19 Sep
        expect(new Date(from).getHours()).toBe(0);
        expect(new Date(to).getDate()).toBe(21);   // Mon 21 Sep
    });

    it('keeps This weekend on the CURRENT weekend when asked on a Sunday', () => {
        const sunday = new Date(2026, 8, 20, 10, 0, 0, 0).getTime();
        const { from, to } = eventWindowRange('weekend', sunday);
        // Saturday has already started, so the span opens at "now" rather than in the past.
        expect(from).toBe(sunday);
        expect(new Date(to).getDate()).toBe(21);
    });

    it('runs Next 7 days from now', () => {
        const { from, to } = eventWindowRange('week', WED);
        expect(from).toBe(WED);
        expect(to).toBe(WED + 7 * DAY);
    });

    it('leaves All open-ended', () => {
        expect(eventWindowRange('all', WED).to).toBe(Number.POSITIVE_INFINITY);
    });
});

describe('which events pin under each chip', () => {
    it('keeps an event later today under Today', () => {
        expect(eventInWindow(event(WED + 5 * HOUR), 'today', WED)).toBe(true);
    });

    it('drops tomorrow\'s event from Today but keeps it under Next 7 days', () => {
        const tomorrow = event(WED + DAY);
        expect(eventInWindow(tomorrow, 'today', WED)).toBe(false);
        expect(eventInWindow(tomorrow, 'week', WED)).toBe(true);
    });

    it('keeps Saturday\'s event under This weekend, and Friday\'s out of it', () => {
        const saturday = event(new Date(2026, 8, 19, 9, 0).getTime());
        const friday = event(new Date(2026, 8, 18, 9, 0).getTime());
        expect(eventInWindow(saturday, 'weekend', WED)).toBe(true);
        expect(eventInWindow(friday, 'weekend', WED)).toBe(false);
    });

    it('drops an event three weeks out from Next 7 days but keeps it under All', () => {
        const far = event(WED + 21 * DAY);
        expect(eventInWindow(far, 'week', WED)).toBe(false);
        expect(eventInWindow(far, 'all', WED)).toBe(true);
    });

    it('keeps an event that is running right now', () => {
        expect(eventInWindow(event(WED - HOUR), 'today', WED)).toBe(true);
    });
});

describe('events that never appear on the map (slice 1 rules)', () => {
    const windows: EventWindow[] = ['all', 'today', 'weekend', 'week'];

    it('never pins an event that has ended', () => {
        const ended = event(WED - 2 * DAY);
        for (const w of windows) expect(eventInWindow(ended, w, WED)).toBe(false);
    });

    it('never pins an event that ended minutes ago', () => {
        const justOver = event(WED - 3 * HOUR); // ends at WED - 1h
        for (const w of windows) expect(eventInWindow(justOver, w, WED)).toBe(false);
    });

    it('never pins a cancelled event, however it is marked', () => {
        const byState = event(WED + 5 * HOUR, { event_state: 'cancelled' });
        const byStatus = event(WED + 5 * HOUR, { status: 'cancelled' });
        for (const w of windows) {
            expect(eventInWindow(byState, w, WED)).toBe(false);
            expect(eventInWindow(byStatus, w, WED)).toBe(false);
        }
    });

    it('never pins a removed or inactive event', () => {
        const inactive = event(WED + 5 * HOUR, { active: 0 });
        const notActive = event(WED + 5 * HOUR, { status: 'completed' });
        for (const w of windows) {
            expect(eventInWindow(inactive, w, WED)).toBe(false);
            expect(eventInWindow(notActive, w, WED)).toBe(false);
        }
    });

    it('never pins a post that is not an event, or one with no start time', () => {
        expect(eventInWindow({ type: 'offer', status: 'active' }, 'all', WED)).toBe(false);
        expect(eventInWindow(event(WED + HOUR, { event_start_at: null }), 'all', WED)).toBe(false);
    });

    it('still pins an UPDATED event — only cancelled and ended are hidden', () => {
        expect(eventInWindow(event(WED + 5 * HOUR, { event_state: 'updated' }), 'today', WED)).toBe(true);
    });
});

describe('a server-shaped row (camelCase) reads the same as a cached one', () => {
    it('accepts eventStartAt / eventEndAt', () => {
        const server = {
            type: 'event', status: 'active', active: 1,
            eventStartAt: new Date(WED + 5 * HOUR).toISOString(),
            eventEndAt: new Date(WED + 7 * HOUR).toISOString(),
            eventState: 'scheduled',
        };
        expect(eventInWindow(server, 'today', WED)).toBe(true);
        expect(eventInWindow(server, 'weekend', WED)).toBe(false);
    });
});
