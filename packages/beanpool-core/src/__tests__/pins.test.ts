import { describe, expect, it } from 'vitest';
import { PIN_CHOICES, PINS_MAX, isPinDays, pinLive } from '../pins';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const LATER = '2026-11-05T12:00:00.000Z';
const EARLIER = '2026-11-02T12:00:00.000Z';
const offer = { type: 'offer', active: true, status: 'active', audienceScope: 'public', pinnedUntil: LATER };

describe('a pin', () => {
    it('is three posts, for a week at most', () => {
        expect(PINS_MAX).toBe(3);
        expect([...PIN_CHOICES]).toEqual([1, 3, 7]);
        expect(Math.max(...PIN_CHOICES)).toBe(7);
    });

    it('takes only the three choices, as numbers', () => {
        for (const days of [1, 3, 7]) expect(isPinDays(days)).toBe(true);
        for (const days of [0, 2, 8, 14, -1, 1.5, '1', null, undefined, [1]]) expect(isPinDays(days)).toBe(false);
    });

    it('is live on a public post on the board, before its end', () => {
        expect(pinLive(offer, NOW)).toBe(true);
        expect(pinLive({ ...offer, audienceScope: undefined }, NOW)).toBe(true);
    });

    it('ends by the clock', () => {
        expect(pinLive({ ...offer, pinnedUntil: EARLIER }, NOW)).toBe(false);
        expect(pinLive({ ...offer, pinnedUntil: new Date(NOW).toISOString() }, NOW)).toBe(false);
        expect(pinLive({ ...offer, pinnedUntil: new Date(NOW + 1).toISOString() }, NOW)).toBe(true);
    });

    it('is none on a post with no stamp, or one that is no time', () => {
        expect(pinLive({ ...offer, pinnedUntil: undefined }, NOW)).toBe(false);
        expect(pinLive({ ...offer, pinnedUntil: null }, NOW)).toBe(false);
        expect(pinLive({ ...offer, pinnedUntil: 'soon' }, NOW)).toBe(false);
    });

    it.each(['paused', 'pending', 'completed', 'cancelled'])('ends when the post is %s', (status) => {
        expect(pinLive({ ...offer, status }, NOW)).toBe(false);
    });

    it('ends when the post is off the board another way', () => {
        expect(pinLive({ ...offer, active: false }, NOW)).toBe(false);
        expect(pinLive({ ...offer, hiddenByReportsAt: EARLIER }, NOW)).toBe(false);
        expect(pinLive({ ...offer, removedByModeratorAt: EARLIER }, NOW)).toBe(false);
    });

    it('never stands on a group, direct or linked community post', () => {
        expect(pinLive({ ...offer, audienceScope: 'group' }, NOW)).toBe(false);
        expect(pinLive({ ...offer, audienceScope: 'direct' }, NOW)).toBe(false);
        expect(pinLive({ ...offer, originNode: 'https://other.example' }, NOW)).toBe(false);
    });

    it('ends with its event', () => {
        const event = { ...offer, type: 'event', eventStartAt: LATER, eventEndAt: LATER };
        expect(pinLive(event, NOW)).toBe(true);
        expect(pinLive({ ...event, eventEndAt: EARLIER }, NOW)).toBe(false);
        expect(pinLive({ ...event, eventEndAt: undefined, eventStartAt: EARLIER }, NOW)).toBe(false);
        expect(pinLive({ ...event, eventState: 'cancelled' }, NOW)).toBe(false);
    });

    it('ends with its poll', () => {
        const poll = { ...offer, type: 'poll', pollClosesAt: LATER };
        expect(pinLive(poll, NOW)).toBe(true);
        expect(pinLive({ ...poll, pollClosesAt: EARLIER }, NOW)).toBe(false);
        expect(pinLive({ ...poll, status: 'completed' }, NOW)).toBe(false);
    });
});
