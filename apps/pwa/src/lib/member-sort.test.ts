/**
 * People → Community on the web: the order of the list (lib/member-sort.ts), the phone's five sorts with the phone's rules
 * (apps/native/app/(tabs)/people.tsx loadMembers), which of them a viewer is offered, and the choice kept as the phone keeps it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MEMBER_SORTS } from '@beanpool/core';
import { forgetKeptMemberSort, keepMemberSort, keptMemberSort, memberSortsFor, orderMembers, type SortableMember } from './member-sort';

const p = (callsign: string, joinedAt: string, extra: Partial<SortableMember> = {}): SortableMember => ({
    publicKey: callsign.toLowerCase().padEnd(64, '0'), callsign, joinedAt, ...extra,
});
const names = (people: SortableMember[]) => people.map((m) => m.callsign);

// Joined oldest first: the order the node answers in.
const ANN = p('ann', '2026-01-01T00:00:00.000Z', { lastActiveAt: '2026-11-10T00:00:00.000Z', earnedCredit: 500 });
const BOB = p('Bob', '2026-02-01T00:00:00.000Z', { lastActiveAt: null, earnedCredit: 0 });
const CY = p('Cy', '2026-03-01T00:00:00.000Z', { lastActiveAt: '2026-11-12T00:00:00.000Z', earnedCredit: 500 });
const DEE = p('dee', '2026-04-01T00:00:00.000Z', { lastActiveAt: '2026-11-12T00:00:00.000Z' });
const NODE_ORDER = [ANN, BOB, CY, DEE];

beforeEach(() => forgetKeptMemberSort());

describe('orderMembers', () => {
    it('Newest: joined most recently first (the node answers oldest first)', () => {
        expect(names(orderMembers(NODE_ORDER, 'newest', new Set()))).toEqual(['dee', 'Cy', 'Bob', 'ann']);
    });

    it('Name: A to Z, upper and lower case together', () => {
        expect(names(orderMembers(NODE_ORDER, 'name', new Set()))).toEqual(['ann', 'Bob', 'Cy', 'dee']);
    });

    it('Friends: this viewer’s friends first, each part newest first', () => {
        expect(names(orderMembers(NODE_ORDER, 'friends', new Set([ANN.publicKey, CY.publicKey])))).toEqual(['Cy', 'ann', 'dee', 'Bob']);
    });

    it('Trusted: the most credit first, a tie newest first, none (or no figure) last', () => {
        expect(names(orderMembers(NODE_ORDER, 'trusted', new Set()))).toEqual(['Cy', 'ann', 'dee', 'Bob']);
    });

    it('Active: the latest day first, a tie newest first, never active last', () => {
        expect(names(orderMembers(NODE_ORDER, 'active', new Set()))).toEqual(['dee', 'Cy', 'ann', 'Bob']);
    });

    it('a date it cannot read sorts as oldest, and the list it was given is left as it was', () => {
        const odd = p('Odd', 'not a date');
        const given = [odd, ...NODE_ORDER];
        expect(names(orderMembers(given, 'newest', new Set()))).toEqual(['dee', 'Cy', 'Bob', 'ann', 'Odd']);
        expect(names(given)).toEqual(['Odd', 'ann', 'Bob', 'Cy', 'dee']);
    });
});

describe('memberSortsFor', () => {
    it('everyone: the phone’s order without Trusted, which orders by a credit figure only an owner’s or admin’s credit view shows', () => {
        expect(memberSortsFor(false)).toEqual(['newest', 'name', 'friends', 'active']);
    });

    it('an owner or admin (their credit view shows that figure): all five, in the phone’s order', () => {
        expect(memberSortsFor(true)).toEqual([...MEMBER_SORTS]);
    });
});

describe('the kept choice', () => {
    it('starts at Newest and keeps the last one picked for the life of the page, never in the browser’s storage', () => {
        expect(keptMemberSort()).toBe('newest');
        keepMemberSort('name');
        expect(keptMemberSort()).toBe('name');
        expect(JSON.stringify({ ...localStorage })).not.toMatch(/name|sort/i);
        expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/name|sort/i);
    });
});
