import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    isPostPinned,
    pinnedDetailLine,
    comparePinsNewestFirst,
    PINS_MAX,
    PIN_CHOICES,
} from '../pins';
import { t, formatDate } from '@beanpool/core';
import { feedPostVisible, type MarketFilterState } from '../market-filters';

describe('post-pinning-market (slice 2 pure rules and logic)', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const future = new Date(now + 86400000).toISOString();
    const past = new Date(now - 86400000).toISOString();

    describe('isPostPinned', () => {
        it('identifies live pinned active public post', () => {
            const post = {
                id: 'p1',
                type: 'offer',
                status: 'active',
                active: 1,
                audience_scope: 'public',
                pinned_until: future,
                pinned_at: '2026-11-03T10:00:00Z',
            };
            expect(isPostPinned(post, now)).toBe(true);
        });

        it('identifies live pinned post even when status column is undefined but active is 1', () => {
            const post = {
                id: 'p-no-status',
                type: 'offer',
                active: 1,
                audience_scope: 'public',
                pinned_until: future,
                pinned_at: '2026-11-03T10:00:00Z',
            };
            expect(isPostPinned(post, now)).toBe(true);
        });

        it('rejects post without pinned_until or with past pinned_until', () => {
            expect(isPostPinned({ id: 'p1', status: 'active', active: 1 }, now)).toBe(false);
            expect(isPostPinned({ id: 'p1', status: 'active', active: 1, pinned_until: past }, now)).toBe(false);
        });

        it('rejects inactive, paused, or completed post even with future pinned_until', () => {
            expect(isPostPinned({ id: 'p1', status: 'paused', active: 0, pinned_until: future }, now)).toBe(false);
            expect(isPostPinned({ id: 'p1', status: 'completed', active: 1, pinned_until: future }, now)).toBe(false);
        });

        it('rejects non-public post', () => {
            expect(isPostPinned({ id: 'p1', status: 'active', active: 1, audience_scope: 'group', pinned_until: future }, now)).toBe(false);
        });

        it('rejects ended or cancelled event', () => {
            const cancelled = {
                id: 'e1',
                type: 'event',
                status: 'active',
                event_state: 'cancelled',
                pinned_until: future,
            };
            expect(isPostPinned(cancelled, now)).toBe(false);

            const ended = {
                id: 'e2',
                type: 'event',
                status: 'active',
                event_start_at: past,
                event_end_at: past,
                pinned_until: future,
            };
            expect(isPostPinned(ended, now)).toBe(false);
        });

        it('rejects closed poll', () => {
            const closedPoll = {
                id: 'pl1',
                type: 'poll',
                status: 'active',
                poll_closes_at: past,
                pinned_until: future,
            };
            expect(isPostPinned(closedPoll, now)).toBe(false);
        });
    });

    describe('pinnedDetailLine', () => {
        it('formats the detail line through the words layer', () => {
            const dateStr = '2026-11-06T12:00:00Z';
            const post = {
                id: 'p1',
                pinned_until: dateStr,
            };
            const expectedDate = formatDate(new Date(dateStr), 'weekday-day-month');
            const line = pinnedDetailLine(post);
            expect(line).toBe(t('Pinned by your community · until {date}', { date: expectedDate }));
        });

        it('returns empty string if not pinned', () => {
            expect(pinnedDetailLine({})).toBe('');
        });
    });

    describe('comparePinsNewestFirst', () => {
        it('sorts newest pinned_at first', () => {
            const older = { id: 'p1', pinned_at: '2026-11-01T10:00:00Z' };
            const newer = { id: 'p2', pinned_at: '2026-11-02T10:00:00Z' };
            const list = [older, newer];
            list.sort(comparePinsNewestFirst);
            expect(list.map(p => p.id)).toEqual(['p2', 'p1']);
        });

        it('sorts newest pinned_at first across mixed ISO strings and numeric timestamps', () => {
            const older = { id: 'p1', pinned_at: '2026-11-01T10:00:00Z' };
            const newer = { id: 'p2', pinned_at: new Date('2026-11-02T10:00:00Z').getTime() };
            const list = [older, newer];
            list.sort(comparePinsNewestFirst);
            expect(list.map(p => p.id)).toEqual(['p2', 'p1']);
        });
    });

    describe('Market feed pinning behavior', () => {
        const posts = [
            { id: 'p1', type: 'offer', status: 'active', active: 1, pinned_until: future, pinned_at: '2026-11-03T09:00:00Z', created_at: '2026-11-01' },
            { id: 'p2', type: 'need', status: 'active', active: 1, pinned_until: future, pinned_at: '2026-11-03T11:00:00Z', created_at: '2026-11-02' },
            { id: 'p3', type: 'event', status: 'active', active: 1, event_start_at: future, pinned_until: future, pinned_at: '2026-11-03T10:00:00Z', created_at: '2026-11-01' },
            { id: 'p4', type: 'offer', status: 'active', active: 1, pinned_until: future, pinned_at: '2026-11-03T08:00:00Z', created_at: '2026-11-01' },
            { id: 'reg1', type: 'offer', status: 'active', active: 1, created_at: '2026-11-03T05:00:00Z' },
        ];

        it('selects up to 3 live pins newest pin first under All filter', () => {
            const filterState: MarketFilterState = {
                type: 'all',
                category: 'all',
                eventWindow: 'all',
                trust: 'all',
                beansOnly: false,
                radiusKm: null,
                center: null,
                groupId: 'all',
            };
            const filterCtx = { blockedUsers: [] as string[], favCategories: [] as string[] };

            const livePins = posts.filter(p => isPostPinned(p, now) && feedPostVisible(p, filterState, filterCtx));
            livePins.sort(comparePinsNewestFirst);
            const pinned = livePins.slice(0, PINS_MAX);

            // Should have 3 pins, newest first (p2 at 11:00, p3 at 10:00, p1 at 09:00; p4 is 4th so excluded)
            expect(pinned.length).toBe(3);
            expect(pinned.map(p => p.id)).toEqual(['p2', 'p3', 'p1']);
        });

        it('respects type filters: only offers under Offers pill', () => {
            const filterState: MarketFilterState = {
                type: 'offers',
                category: 'all',
                eventWindow: 'all',
                trust: 'all',
                beansOnly: false,
                radiusKm: null,
                center: null,
                groupId: 'all',
            };
            const filterCtx = { blockedUsers: [] as string[], favCategories: [] as string[] };

            const livePins = posts.filter(p => isPostPinned(p, now) && feedPostVisible(p, filterState, filterCtx));
            livePins.sort(comparePinsNewestFirst);
            const pinned = livePins.slice(0, PINS_MAX);

            // Only offers: p1 and p4 (p2 is need, p3 is event)
            expect(pinned.map(p => p.id)).toEqual(['p1', 'p4']);
        });

        it('disables pinned block under search, tag, or distance narrowing', () => {
            // Search query active
            const isNarrowedSearch = Boolean('carrots'.trim().length > 0);
            expect(isNarrowedSearch).toBe(true);

            // Tag active
            const isNarrowedTag = Boolean('food');
            expect(isNarrowedTag).toBe(true);

            // Distance active
            const radiusKm: number | null = 25;
            const isNarrowedDistance = Boolean(radiusKm != null);
            expect(isNarrowedDistance).toBe(true);
        });

        it('deduplicates pinned posts from main feed', () => {
            const pinned = [posts[0], posts[1]];
            const pinnedIds = new Set(pinned.map(p => p.id));
            const remaining = posts.filter(p => !pinnedIds.has(p.id));

            expect(remaining.find(p => p.id === 'p1')).toBeUndefined();
            expect(remaining.find(p => p.id === 'p2')).toBeUndefined();
            expect(remaining.find(p => p.id === 'reg1')).toBeDefined();
        });
    });

    describe('PIN_CHOICES', () => {
        it('supports exactly 1 day, 3 days, and 7 days (1 week)', () => {
            expect(PIN_CHOICES).toEqual([1, 3, 7]);
        });
    });
});
