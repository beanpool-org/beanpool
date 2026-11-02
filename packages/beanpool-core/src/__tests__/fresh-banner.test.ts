import { describe, expect, it } from 'vitest';
import {
    freshBanner,
    freshBannerDay,
    parseFreshBannerDismissal,
    recordFreshBannerDismissal,
    shouldShowFreshBanner,
} from '../fresh-banner.js';

describe('freshBanner helper', () => {
    const today = new Date(2026, 10, 3, 10, 0, 0); // 3 Nov 2026
    const todayDayStr = freshBannerDay(today); // '2026-11-03'
    const laterToday = new Date(2026, 10, 3, 16, 30, 0);
    const tomorrow = new Date(2026, 10, 4, 9, 0, 0); // 4 Nov 2026
    const yesterday = new Date(2026, 10, 2, 18, 0, 0); // 2 Nov 2026

    it('records a dismissal with local day and count', () => {
        const stored = recordFreshBannerDismissal(5, today);
        expect(JSON.parse(stored)).toEqual({ day: todayDayStr, count: 5 });
        expect(parseFreshBannerDismissal(stored)).toEqual({ day: todayDayStr, count: 5 });
    });

    // 1. Same day same count hidden
    it('same day same count hidden', () => {
        const stored = recordFreshBannerDismissal(3, today);
        // Dismissed at 3 listings; when 3 listings remain today, banner is hidden
        expect(shouldShowFreshBanner(stored, 3, laterToday)).toBe(false);
        // Even if count decreased on the same day (e.g. 2), it stays hidden
        expect(shouldShowFreshBanner(stored, 2, laterToday)).toBe(false);
    });

    // 2. Same day more listings shown
    it('same day more listings shown', () => {
        const stored = recordFreshBannerDismissal(3, today);
        // Dismissed at 3 listings; 4 listings posted today brings the banner back
        expect(shouldShowFreshBanner(stored, 4, laterToday)).toBe(true);
        expect(shouldShowFreshBanner(stored, 10, laterToday)).toBe(true);
    });

    // 3. Next day shown
    it('next day shown', () => {
        const stored = recordFreshBannerDismissal(3, today);
        // Dismissal from another day means no dismissal
        expect(shouldShowFreshBanner(stored, 3, tomorrow)).toBe(true);
        expect(shouldShowFreshBanner(stored, 1, tomorrow)).toBe(true);
    });

    // 4. Old plain number shown
    it('old plain number shown', () => {
        // Phone legacy format was storing plain number string, e.g. "3" or number 3
        expect(parseFreshBannerDismissal('3')).toBeNull();
        expect(parseFreshBannerDismissal(3)).toBeNull();
        expect(parseFreshBannerDismissal('0')).toBeNull();
        expect(shouldShowFreshBanner('3', 3, today)).toBe(true);
        expect(shouldShowFreshBanner(3, 3, today)).toBe(true);
    });

    // 5. Bad stored value shown
    it('bad stored value shown', () => {
        const badValues = [
            null,
            undefined,
            '',
            '    ',
            'not-json',
            '{corrupted: json',
            '{}',
            JSON.stringify({ day: 'not-a-day', count: 3 }),
            JSON.stringify({ day: todayDayStr, count: -1 }),
            JSON.stringify({ day: todayDayStr, count: 'NaN' }),
            JSON.stringify({ day: todayDayStr }),
            JSON.stringify([]),
            JSON.stringify(true),
            { day: 123, count: '3' },
            { count: 3 },
        ];
        for (const bad of badValues) {
            expect(shouldShowFreshBanner(bad, 3, today)).toBe(true);
        }
    });

    // Zero listings case
    it('zero fresh listings hidden regardless of stored state', () => {
        expect(shouldShowFreshBanner(null, 0, today)).toBe(false);
        expect(shouldShowFreshBanner(recordFreshBannerDismissal(3, today), 0, today)).toBe(false);
        expect(shouldShowFreshBanner(recordFreshBannerDismissal(3, yesterday), 0, today)).toBe(false);
    });

    // freshBanner namespace
    it('provides identical methods via freshBanner namespace', () => {
        const stored = freshBanner.record(4, today);
        expect(freshBanner.shouldShow(stored, 4, today)).toBe(false);
        expect(freshBanner.shouldShow(stored, 5, today)).toBe(true);
    });
});
