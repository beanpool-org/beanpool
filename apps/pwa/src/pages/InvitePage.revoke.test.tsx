import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { inviteFolds } from '@beanpool/core';

/**
 * Revoke on the web (invites-vouching slice I2; DESIGN-invites-vouching-review-fable.md §3 ask 3): an open Pending invite and
 * the made card each offer Revoke; the first tap shows the design's words in place (a bound invite's name stays on the names list;
 * the web holds no list key, so "The name"), Revoke and Cancel; confirmed, DELETE /api/invite/:code is asked, and once gone the
 * invite leaves Pending and the card. A refusal shows the node's sentence and keeps it. No Revoke on an offline ticket. The web
 * names list stays parked: no entry line here.
 */
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const STATE = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, revoked: [] as string[], refuse: null as null | { message: string; code?: string } }));
vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(async (_pk: string, note?: string, vouch?: number) => ({
            success: true,
            invite: { code: 'INV-MADE-0001', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null, ...(note ? { intendedFor: note } : {}), ...(vouch ? { vouchAmount: vouch } : {}) },
        })),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getMyInvites: vi.fn(async () => ({ invites: STATE.rows })),
        revokeInvite: vi.fn(async (code: string) => {
            if (STATE.refuse) throw Object.assign(new Error(STATE.refuse.message), { code: STATE.refuse.code, status: 409 });
            STATE.revoked.push(code);
            return { revoked: 1, returned: 0, promiseEnded: false };
        }),
        getInviteTree: vi.fn(async () => []),
        getMyVouching: vi.fn(async () => ({ voucher: true, presets: [25, 50, 75, 100], vouchMax: 100, budgetMax: 2000, vouchedBy: [], budget: { level: 1000, left: 900 } })),
        getVouchersBlock: vi.fn(async () => null),
        getCommunityCard: vi.fn(async () => null),
        request: vi.fn(async () => ({ role: 'member' })),
    };
});
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { invites: true, beans: true } })),
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} /> }));

import { InvitePage } from './InvitePage';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };
const base = (code: string, madeDaysAgo: number) => ({
    code, createdBy: 'me', createdAt: ago(madeDaysAgo), usedBy: null, usedAt: null,
    namesEntryId: null, vouchAmount: null, voucherLevel: null, forKnock: false,
    expiresAt: new Date(Date.parse(ago(madeDaysAgo)) + 30 * DAY).toISOString(),
});

beforeEach(() => {
    localStorage.clear();
    inviteFolds.clear();
    STATE.revoked = [];
    STATE.refuse = null;
    STATE.rows = [
        { ...base('INV-BOUND-0001', 7), namesEntryId: 'entry-1', vouchAmount: 200, voucherLevel: 1000 },
        { ...base('INV-NOTE-0002', 1), intendedFor: 'Kim', vouchAmount: 100 },
    ];
});
afterEach(() => cleanup());

const rows = () => screen.queryAllByTestId('invite-pending-row');
const openPending = async () => fireEvent.click(await screen.findByTestId('invites-pending-fold'));
const openRow = (text: string) => fireEvent.click(rows().find((r) => r.textContent?.includes(text))!);

describe('Revoke on an open Pending invite', () => {
    it('a bound invite: the design’s words in place, then gone from Pending once revoked', async () => {
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        openRow('Name on the phone');
        const sheet = await screen.findByTestId('invite-sheet');
        fireEvent.click(within(sheet).getByTestId('invite-revoke'));
        const ask = within(sheet).getByTestId('invite-revoke-ask');
        expect(ask).toHaveTextContent('Revoke this invite?');
        expect(ask).toHaveTextContent('Whoever has the link can’t use it. The name stays on the names list, not confirmed.');
        fireEvent.click(within(ask).getByTestId('invite-revoke-confirm'));
        await waitFor(() => expect(screen.queryByTestId('invite-sheet')).toBeNull());
        expect(STATE.revoked).toEqual(['INV-BOUND-0001']);
        expect(rows()).toHaveLength(1);
        expect(screen.getByTestId('invites-pending-fold')).toHaveTextContent('Pending (1)');
    });

    it('a plain invite: the plain words; Cancel revokes nothing', async () => {
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        openRow('For: Kim');
        const sheet = await screen.findByTestId('invite-sheet');
        fireEvent.click(within(sheet).getByTestId('invite-revoke'));
        const ask = within(sheet).getByTestId('invite-revoke-ask');
        expect(ask).toHaveTextContent('Whoever has the link can’t use it.');
        expect(ask).not.toHaveTextContent('names list');
        fireEvent.click(within(ask).getByTestId('invite-revoke-cancel'));
        expect(STATE.revoked).toEqual([]);
        expect(within(sheet).getByTestId('invite-revoke')).toBeTruthy();
    });

    it('a refusal shows the node’s sentence and keeps the invite', async () => {
        STATE.refuse = { message: 'Someone joined with this invite already, so there is nothing to revoke.', code: 'invite_used' };
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        openRow('For: Kim');
        const sheet = await screen.findByTestId('invite-sheet');
        fireEvent.click(within(sheet).getByTestId('invite-revoke'));
        fireEvent.click(within(sheet).getByTestId('invite-revoke-confirm'));
        expect(await within(sheet).findByTestId('invite-revoke-refused')).toHaveTextContent('Someone joined with this invite already, so there is nothing to revoke.');
        expect(rows()).toHaveLength(2);
    });

    it('the node’s no_invite (lapsed and pruned) takes it off the list too', async () => {
        STATE.refuse = { message: 'There is no invite of yours with that code that nobody has used.', code: 'no_invite' };
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        openRow('For: Kim');
        const sheet = await screen.findByTestId('invite-sheet');
        fireEvent.click(within(sheet).getByTestId('invite-revoke'));
        fireEvent.click(within(sheet).getByTestId('invite-revoke-confirm'));
        await waitFor(() => expect(screen.queryByTestId('invite-sheet')).toBeNull());
        expect(rows()).toHaveLength(1);
    });

    it('an offline ticket offers no Revoke', async () => {
        localStorage.setItem(`bp_offline_invites_${IDENTITY.publicKey}`, JSON.stringify([{ code: 'BP-offline-ticket-made-here', createdBy: 'me', createdAt: ago(1), usedBy: null, usedAt: null }]));
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        openRow('BP-offline-ticket-made-here');
        const sheet = await screen.findByTestId('invite-sheet');
        expect(within(sheet).queryByTestId('invite-revoke')).toBeNull();
    });
});

describe('Revoke on the made card', () => {
    it('revokes the invite just made, and the card goes', async () => {
        render(<InvitePage identity={IDENTITY} />);
        const generate = await screen.findByRole('button', { name: /Generate/ });
        fireEvent.click(generate);
        const card = await screen.findByTestId('invite-made-card');
        fireEvent.click(within(card).getByTestId('invite-made-revoke'));
        const ask = within(card).getByTestId('invite-made-revoke-ask');
        expect(ask).toHaveTextContent('Whoever has the link can’t use it.');
        fireEvent.click(within(ask).getByTestId('invite-made-revoke-confirm'));
        await waitFor(() => expect(screen.queryByTestId('invite-made-card')).toBeNull());
        expect(STATE.revoked).toEqual(['INV-MADE-0001']);
    });
});
