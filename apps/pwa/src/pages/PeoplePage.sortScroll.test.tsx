/**
 * People → Community on the web, made consistent with the phone (Marty, 14 Nov 2026): the phone's sort row (Newest by
 * default, kept while the page lives), and a long list drawn 50 at a time, more as the end comes into view or with Show more.
 * Trusted is offered only to an owner or admin, whose credit view shows the figure it orders by (lib/member-sort.ts).
 * The order rules themselves are lib/member-sort.test.ts.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { PeoplePage } from './PeoplePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import * as membersOnDemand from '../lib/members-on-demand';
import * as gate from '../lib/visitor-lobby-gate';
import { forgetKeptMemberSort, keepMemberSort } from '../lib/member-sort';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('./InvitePage', () => ({ InvitePage: () => <div>Invite codes</div> }));

const identity: BeanPoolIdentity = { publicKey: 'me-pubkey', privateKey: 'mock-private-key-hex', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z' };

/** 120 people, P000 joined first and P119 last, as the node answers (oldest first). P007 has the most granted credit. */
const PEOPLE = Array.from({ length: 120 }, (_, i) => ({
    publicKey: `k${String(i).padStart(3, '0')}`.padEnd(64, '0'),
    callsign: `P${String(i).padStart(3, '0')}`,
    joinedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    invitedBy: '',
    inviteCode: '',
    lastActiveAt: i === 3 ? '2026-11-13T00:00:00.000Z' : null,
    earnedCredit: i === 7 ? 1500 : 0,
}));

const rows = () => screen.queryAllByTestId('community-row');
const firstNames = (n: number) => rows().slice(0, n).map((r) => within(r).getAllByRole('button')[1].textContent);
const sortButton = (name: string) => within(screen.getByTestId('member-sort')).queryByRole('button', { name });

function node(role: 'member' | 'owner' | 'voucher', beans = true) {
    vi.spyOn(gate, 'communityInfoOnce').mockResolvedValue({ profile: beans ? 'local' : 'global', features: { beans } } as never);
    vi.spyOn(api, 'request').mockImplementation((async (_method: string, path: string) => {
        if (path === '/api/node-admin/me') {
            if (role === 'owner') return { role: 'owner' };
            throw Object.assign(new Error('Not an admin.'), { status: 403 });
        }
        throw Object.assign(new Error('unexpected'), { status: 404 });
    }) as never);
    vi.spyOn(api, 'getMyVouching').mockResolvedValue(role === 'voucher'
        ? { voucher: true, presets: [2500], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], budget: { left: 15000, held: 0, heldInvites: 0, vouched: 0, peopleVouched: 0, level: 100000 }, ask: { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null } }
        : { voucher: false, presets: [], vouchMax: 10000, budgetMax: 200000, vouchedBy: [] });
}

/** A stand-in IntersectionObserver: each one made is kept, and `see()` tells the newest that its target came into view. */
const observers: { cb: IntersectionObserverCallback; targets: Element[]; gone: boolean }[] = [];
function see() {
    const live = observers.filter((o) => !o.gone && o.targets.length > 0).at(-1);
    if (!live) throw new Error('nothing is observed');
    act(() => live.cb(live.targets.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry), {} as IntersectionObserver));
}
class FakeObserver {
    rec: { cb: IntersectionObserverCallback; targets: Element[]; gone: boolean };
    constructor(cb: IntersectionObserverCallback) { this.rec = { cb, targets: [], gone: false }; observers.push(this.rec); }
    observe(el: Element) { this.rec.targets.push(el); }
    unobserve() {}
    disconnect() { this.rec.gone = true; }
    takeRecords() { return []; }
}

beforeEach(() => {
    vi.restoreAllMocks();
    forgetKeptMemberSort();
    observers.length = 0;
    vi.spyOn(api, 'getFriends').mockResolvedValue([]);
    vi.spyOn(api as never as { getAddedYou: () => Promise<unknown> }, 'getAddedYou').mockResolvedValue({ addedYou: [], more: 0 });
    vi.spyOn(membersOnDemand, 'getMembersWhole').mockResolvedValue(PEOPLE as never);
    vi.spyOn(membersOnDemand, 'useMembersOnDemand').mockReturnValue(false);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('People → Community: the sort row', () => {
    it('a member: the phone’s sorts but Trusted, in its order, Newest on, joined most recently first', async () => {
        node('member');
        render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByText('P119');
        await waitFor(() => expect(api.getMyVouching).toHaveBeenCalled());
        const pills = within(screen.getByTestId('member-sort')).getAllByRole('button');
        expect(pills.map((b) => b.textContent)).toEqual(['Newest', 'Name', 'Friends', 'Active']);
        expect(sortButton('Newest')).toHaveAttribute('aria-pressed', 'true');
        expect(firstNames(3)).toEqual(['P119', 'P118', 'P117']);
        // Red while the web draws the node's order (oldest first) with no sort row.
    });

    it('a member who had picked Trusted elsewhere is never ordered by it: Newest, and no Trusted pill', async () => {
        keepMemberSort('trusted');
        node('voucher');
        render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByTestId('credit-switch');
        expect(sortButton('Trusted')).toBeNull();
        expect(sortButton('Newest')).toHaveAttribute('aria-pressed', 'true');
        expect(firstNames(1)).toEqual(['P119']);
        // Red when a voucher (whose credit view shows the whole line, never the granted part) is offered Trusted.
    });

    it('an owner: all five; Trusted puts the most granted credit first', async () => {
        node('owner');
        render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByText('P119');
        const trusted = await waitFor(() => { const b = sortButton('Trusted'); expect(b).not.toBeNull(); return b!; });
        expect(within(screen.getByTestId('member-sort')).getAllByRole('button').map((b) => b.textContent))
            .toEqual(['Newest', 'Name', 'Friends', 'Trusted', 'Active']);
        fireEvent.click(trusted);
        expect(trusted).toHaveAttribute('aria-pressed', 'true');
        expect(firstNames(2)).toEqual(['P007', 'P119']);
    });

    it('an owner on a Beans-off node (the global one): no Trusted, as there is no credit view there', async () => {
        node('owner', false);
        render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByText('P119');
        await new Promise((r) => setTimeout(r, 20));
        expect(sortButton('Trusted')).toBeNull();
    });

    it('Name and Active reorder; the choice is kept when People is left and opened again', async () => {
        node('member');
        const first = render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByText('P119');
        fireEvent.click(sortButton('Active')!);
        expect(firstNames(2)).toEqual(['P003', 'P119']);
        fireEvent.click(sortButton('Name')!);
        expect(firstNames(2)).toEqual(['P000', 'P001']);
        first.unmount();
        render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByText('P000');
        expect(sortButton('Name')).toHaveAttribute('aria-pressed', 'true');
        expect(firstNames(1)).toEqual(['P000']);
    });

    it('search filters the whole list, then the sort applies', async () => {
        node('member');
        render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByText('P119');
        // P000 to P009 joined first: under Newest they are past the 50 drawn.
        fireEvent.change(screen.getByPlaceholderText('🔍 Search members...'), { target: { value: 'p00' } });
        expect(rows()).toHaveLength(10);
        expect(firstNames(2)).toEqual(['P009', 'P008']);
        fireEvent.click(sortButton('Name')!);
        expect(firstNames(2)).toEqual(['P000', 'P001']);
    });
});

describe('People → Community: a long list', () => {
    it('draws the first 50; Show more draws 50 more, until all are drawn', async () => {
        node('member');
        render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByText('P119');
        expect(rows()).toHaveLength(50);
        fireEvent.click(screen.getByRole('button', { name: 'Show more people' }));
        expect(rows()).toHaveLength(100);
        fireEvent.click(screen.getByRole('button', { name: 'Show more people' }));
        expect(rows()).toHaveLength(120);
        expect(screen.queryByRole('button', { name: 'Show more people' })).toBeNull();
        // Red while every row is drawn at once.
    });

    it('draws more as the end of the list comes into view', async () => {
        vi.stubGlobal('IntersectionObserver', FakeObserver);
        node('member');
        render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByText('P119');
        expect(rows()).toHaveLength(50);
        see();
        expect(rows()).toHaveLength(100);
        see();
        expect(rows()).toHaveLength(120);
        expect(observers.every((o) => o.gone || o.targets.length === 0)).toBe(true);
    });

    it('goes back to the first 50 when the sort or the search changes', async () => {
        node('member');
        render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByText('P119');
        fireEvent.click(screen.getByRole('button', { name: 'Show more people' }));
        expect(rows()).toHaveLength(100);
        fireEvent.click(sortButton('Name')!);
        expect(rows()).toHaveLength(50);
        fireEvent.click(screen.getByRole('button', { name: 'Show more people' }));
        expect(rows()).toHaveLength(100);
        fireEvent.change(screen.getByPlaceholderText('🔍 Search members...'), { target: { value: 'p' } });
        expect(rows()).toHaveLength(50);
    });
});
