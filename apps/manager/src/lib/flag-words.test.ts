import { describe, it, expect } from 'vitest';
import { flagAction, flagHeading, flagMembers, flagOffersFreeze, flagsNeedingLook, flagsStatus, isInformationFlag } from './flag-words';

// The node's HealthFlag types (apps/server/src/state-engine.ts). A type added there needs words here: this list fails first.
const NODE_TYPES = [
    'wash_trading', 'isolated_branch', 'inactive_member', 'invite_spam', 'sybil_funnel', 'sybil_ring', 'aggregate_spike',
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

    it('inactive_member names the look-back the node used, or says "a while" when it did not say', () => {
        expect(flagHeading({ type: 'inactive_member', days: 45 })).toBe('Members with no trades for 45 days');
        expect(flagHeading({ type: 'inactive_member' })).toBe('Members with no trades for a while');
        expect(flagHeading({ type: 'inactive_member', days: 'x' })).toBe('Members with no trades for a while');
    });

    it('an unknown or missing type reads in general words', () => {
        expect(flagHeading({ type: 'brand_new' })).toBe('Something on this server needs a look');
        expect(flagHeading({})).toBe('Something on this server needs a look');
        expect(flagHeading(null)).toBe('Something on this server needs a look');
    });

    it('information is the inactive flag, by type or by severity, whatever an older node sent', () => {
        expect(isInformationFlag({ type: 'inactive_member', severity: 'warning' })).toBe(true);
        expect(isInformationFlag({ type: 'inactive_member', severity: 'info' })).toBe(true);
        expect(isInformationFlag({ type: 'brand_new', severity: 'info' })).toBe(true);
        expect(isInformationFlag({ type: 'wash_trading', severity: 'alert' })).toBe(false);
        expect(isInformationFlag(null)).toBe(false);
    });

    it('only wash trading and the sybil patterns offer Freeze, and never information', () => {
        for (const type of NODE_TYPES) {
            const expected = ['wash_trading', 'sybil_ring', 'sybil_funnel'].includes(type);
            expect(flagOffersFreeze({ type, severity: 'alert' })).toBe(expected);
        }
        expect(flagOffersFreeze({ type: 'wash_trading', severity: 'info' })).toBe(false);
        expect(flagOffersFreeze({ type: 'brand_new', severity: 'critical' })).toBe(false);
        expect(flagOffersFreeze(undefined)).toBe(false);
    });

    it('flagsNeedingLook drops the news and keeps the rest in order', () => {
        const flags = [
            { type: 'inactive_member', severity: 'info' },
            { type: 'wash_trading', severity: 'alert' },
            { type: 'inactive_member', severity: 'warning' },
            { type: 'delinquency', severity: 'warning' },
        ];
        expect(flagsNeedingLook(flags).map((f) => f.type)).toEqual(['wash_trading', 'delinquency']);
        expect(flagsNeedingLook(undefined)).toEqual([]);
    });

    it('flagMembers reads the flag\'s own list: strings only, no repeats', () => {
        expect(flagMembers({ members: ['a', 'b', 'a', '', 7, null] })).toEqual(['a', 'b']);
        expect(flagMembers({ members: 'a' })).toEqual([]);
        expect(flagMembers({})).toEqual([]);
        expect(flagMembers(null)).toEqual([]);
    });

    it('members with no trades never turn a node\'s dot amber or red', () => {
        expect(flagsStatus([{ type: 'inactive_member', severity: 'warning' }], false)).toBe('online');
        expect(flagsStatus([{ type: 'inactive_member', severity: 'info' }], false)).toBe('online');
        expect(flagsStatus([], false)).toBe('online');
        expect(flagsStatus(undefined, false)).toBe('online');
    });

    it('a real flag or a report still does', () => {
        expect(flagsStatus([{ type: 'inactive_member', severity: 'info' }, { type: 'delinquency', severity: 'warning' }], false)).toBe('warning');
        expect(flagsStatus([{ type: 'wash_trading', severity: 'alert' }], false)).toBe('alert');
        expect(flagsStatus([{ type: 'sybil_ring', severity: 'critical' }], false)).toBe('alert');
        expect(flagsStatus([], true)).toBe('alert');
    });
});
