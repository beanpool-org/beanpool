/**
 * People → Community with Show credit, as the page draws it (DESIGN-credit-list-fable.md test 10, with amendment 1 test 10's
 * additions): a plain member's Community pane has no switch, none of the giver words and makes no request to a credit route;
 * a voucher arriving by the Invites door (or the bell's ask) finds Show credit on and the node's credit list in place of the
 * plain member list. The panel's own checks are components/CreditPeoplePanel.test.tsx.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { PeoplePage } from './PeoplePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import * as membersOnDemand from '../lib/members-on-demand';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('./InvitePage', () => ({ InvitePage: () => <div>Invite codes</div> }));

const identity: BeanPoolIdentity = { publicKey: 'me-pubkey', privateKey: 'mock-private-key-hex', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z' };
const BOB = { publicKey: 'b'.repeat(64), callsign: 'Bob', joinedAt: '2026-10-01T00:00:00.000Z', invitedBy: '', inviteCode: '' };
const calls: string[] = [];

function node(role: 'member' | 'voucher') {
    vi.spyOn(api, 'request').mockImplementation((async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === '/api/node-admin/me') throw Object.assign(new Error('Not an admin.'), { status: 403 });
        if (path.startsWith('/api/credit/people?')) {
            return { sight: 'voucher', told: 'x', next: null, people: [{
                memberPubkey: BOB.publicKey, callsign: 'Bob', status: 'active', own: false, line_c: 0, usable_c: 0, liveOffers: 2, balance_c: 0, owed_c: 0, over_c: 0,
                paused: false, canGive: true, risk: { level: 'not_known', more: false, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] },
            }] };
        }
        throw Object.assign(new Error('unexpected'), { status: 404 });
    }) as never);
    vi.spyOn(api, 'getMyVouching').mockResolvedValue(role === 'voucher'
        ? { voucher: true, presets: [2500, 5000, 7500, 10000], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], budget: { left: 15000, held: 0, heldInvites: 0, vouched: 0, peopleVouched: 0, level: 100000 }, ask: { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null } }
        : { voucher: false, presets: [], vouchMax: 10000, budgetMax: 200000, vouchedBy: [] });
}

beforeEach(() => {
    calls.length = 0;
    vi.restoreAllMocks();
    vi.spyOn(api, 'getFriends').mockResolvedValue([]);
    vi.spyOn(api, 'getMembers').mockResolvedValue([BOB]);
    vi.spyOn(api as never as { getAddedYou: () => Promise<unknown> }, 'getAddedYou').mockResolvedValue({ addedYou: [], more: 0 });
    vi.spyOn(membersOnDemand, 'getMembersWhole').mockResolvedValue([BOB] as never);
    vi.spyOn(membersOnDemand, 'useMembersOnDemand').mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe('People → Community: Show credit', () => {
    it('a plain member: the pane is today’s, with no switch, no giver word and no request to a credit route', async () => {
        node('member');
        const { container } = render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByText('Bob');
        await waitFor(() => expect(calls).toContain('GET /api/node-admin/me'));
        expect(screen.queryByTestId('credit-switch')).toBeNull();
        expect(container.textContent ?? '').not.toMatch(/Credit line|Credit risk|Balance|Show credit/);
        expect(calls.filter((c) => c.includes('/api/credit'))).toEqual([]);
        // Red when the switch is drawn from a local role guess, or credit is asked for before anyone is known to give it.
    });

    it('a voucher sees the switch, off; arriving by a door with a chip switches it on and the credit list replaces the plain list', async () => {
        node('voucher');
        const { rerender } = render(<PeoplePage identity={identity} initialView="community" />);
        const sw = await screen.findByTestId('credit-switch');
        expect((sw as HTMLInputElement).checked).toBe(false);
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(calls.filter((c) => c.includes('/api/credit'))).toEqual([]);
        rerender(<PeoplePage identity={identity} initialView="community" creditStart={{ chip: 'no_credit', nonce: 1 }} />);
        await screen.findByTestId('credit-list');
        expect((screen.getByTestId('credit-switch') as HTMLInputElement).checked).toBe(true);
        expect(screen.getByTestId('credit-chip-no_credit')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByText(/^Joined /)).toBeNull();
        expect(calls.some((c) => c === 'GET /api/credit/people?filter=no_credit')).toBe(true);
    });

    it('credit is off at every visit: Community opened again by hand, after a door switched it on, starts with the switch off', async () => {
        node('voucher');
        render(<PeoplePage identity={identity} initialView="community" creditStart={{ chip: 'no_credit', nonce: 7 }} />);
        await screen.findByTestId('credit-list');
        fireEvent.click(screen.getByRole('tab', { name: /Friends/ }));
        fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
        const sw = await screen.findByTestId('credit-switch');
        expect((sw as HTMLInputElement).checked).toBe(false);
        expect(screen.queryByTestId('credit-list')).toBeNull();
        // Red when the page keeps handing the door's start to a panel that is mounted again.
    });
});
