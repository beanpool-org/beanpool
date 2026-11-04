import { describe, it, expect } from 'vitest';
import { flagAction, flagHeading, flagMembers, flagOffersFreeze } from './flag-words';

// The node's HealthFlag types (apps/server/src/state-engine.ts). A type added there needs words here: this list fails first.
const NODE_TYPES = [
    'wash_trading', 'isolated_branch', 'invite_spam', 'sybil_funnel', 'sybil_ring', 'aggregate_spike',
    'cohort_velocity', 'delinquency', 'watchdog_recovery', 'watchdog_down', 'unhandled_rejections',
];

describe('flag words', () => {
    it.each(NODE_TYPES)('%s has a heading and an action that are words, not the type', (type) => {
        const heading = flagHeading({ type });
        const action = flagAction({ type });
        expect(heading).not.toContain(type);
        expect(heading).not.toContain('_');
        expect(heading).not.toBe('Something on this server needs a look');
        expect(action).not.toBe('Read the note below. Dismiss this when you have.');
        expect(heading.length).toBeGreaterThan(8);
        expect(action.length).toBeGreaterThan(20);
    });

    it('the node no longer raises inactive_member (Marty, 4 Nov): an older node that still does reads in general words, never the raw type', () => {
        expect(flagHeading({ type: 'inactive_member', severity: 'warning' })).toBe('Something on this server needs a look');
        expect(flagAction({ type: 'inactive_member' })).toBe('Read the note below. Dismiss this when you have.');
        expect(flagOffersFreeze({ type: 'inactive_member', severity: 'warning' })).toBe(false);
    });

    it('an unknown or missing type reads in general words', () => {
        expect(flagHeading({ type: 'brand_new' })).toBe('Something on this server needs a look');
        expect(flagHeading({})).toBe('Something on this server needs a look');
        expect(flagHeading(null)).toBe('Something on this server needs a look');
    });

    it('only wash trading and the sybil patterns offer Freeze', () => {
        for (const type of NODE_TYPES) {
            const expected = ['wash_trading', 'sybil_ring', 'sybil_funnel'].includes(type);
            expect(flagOffersFreeze({ type, severity: 'alert' })).toBe(expected);
        }
        expect(flagOffersFreeze({ type: 'brand_new', severity: 'critical' })).toBe(false);
        expect(flagOffersFreeze(undefined)).toBe(false);
    });

    it('flagMembers reads the flag\'s own list: strings only, no repeats', () => {
        expect(flagMembers({ members: ['a', 'b', 'a', '', 7, null] })).toEqual(['a', 'b']);
        expect(flagMembers({ members: 'a' })).toEqual([]);
        expect(flagMembers({})).toEqual([]);
        expect(flagMembers(null)).toEqual([]);
    });
});
