import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(async () => ({
            success: true,
            invite: { code: 'INV-ABCD-EFGH', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null },
        })),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getMyInvites: vi.fn(async () => ({ invites: [] })),
        getInviteTree: vi.fn(async () => []),
        getMyVouching: vi.fn(async () => ({
            voucher: true,
            budget: { left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 1000 },
            presets: [25, 50, 75, 100],
            vouchMax: 100,
            budgetMax: 2000,
            vouchedBy: [],
        })),
        getVouchersBlock: vi.fn(async () => ({
            vouchers: [
                {
                    memberPubkey: 'voucher-1',
                    callsign: 'Jane Albury',
                    source: 'role',
                    entryId: null,
                    madeBy: null,
                    madeByCallsign: 'Founder',
                    madeAt: '2026-11-01T00:00:00.000Z',
                    stoppedAt: null,
                    stopReason: null,
                    left: 550,
                    held: 100,
                    heldInvites: 1,
                    vouched: 350,
                    peopleVouched: 4,
                    level: 1000,
                    belowZero: 1,
                    writtenOff: 0,
                    passedOn: { amount: 0, people: 0 },
                    invitesWithVouch: 4,
                    trading: { withOthers: 0, insideOnly: 0 },
                },
            ],
            settings: { default_budget: 1000, max_budget: 2000 },
        })),
    };
});

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({
        memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { invites: true, beans: true },
    })),
}));

vi.mock('qrcode.react', () => ({ QRCodeSVG: vi.fn(() => null) }));

import { InvitePage } from './InvitePage';
import { generateInvite, buildOfflineInviteCode, getMyVouching, getVouchersBlock } from '../lib/api';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };

describe('InvitePage Vouching & Presets (V3, §4 & §11)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });

    it('renders presets from budget when member is a voucher', async () => {
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('invite-vouch')).toBeInTheDocument());

        expect(screen.getByText(/From your budget: 550 of .* left/)).toBeInTheDocument();
        expect(screen.getByText('None')).toBeInTheDocument();
        expect(screen.getByText('25')).toBeInTheDocument();
        expect(screen.getByText('50')).toBeInTheDocument();
        expect(screen.getByText('75')).toBeInTheDocument();
        expect(screen.getByText('100')).toBeInTheDocument();
    });

    it('does not render presets when member is not a voucher', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce({
            voucher: false,
            presets: [25, 50, 75, 100],
            vouchMax: 100,
            budgetMax: 2000,
            vouchedBy: [],
        });

        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByText(/Invite Someone/)).toBeInTheDocument());
        expect(screen.queryByTestId('invite-vouch')).not.toBeInTheDocument();
    });

    it('greys out presets above what budget is left', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce({
            voucher: true,
            budget: { left: 40, held: 0, heldInvites: 0, vouched: 960, peopleVouched: 10, level: 1000 },
            presets: [25, 50, 75, 100],
            vouchMax: 100,
            budgetMax: 2000,
            vouchedBy: [],
        });

        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('invite-vouch')).toBeInTheDocument());

        const btn25 = screen.getByTestId('invite-vouch-25');
        const btn50 = screen.getByTestId('invite-vouch-50');
        expect(btn25).not.toBeDisabled();
        expect(btn50).toBeDisabled();
    });

    it('passes selected vouch amount to generateInvite on generation', async () => {
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('invite-vouch-50')).toBeInTheDocument());

        fireEvent.click(screen.getByTestId('invite-vouch-50'));
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

        await waitFor(() => {
            expect(generateInvite).toHaveBeenCalledWith(
                IDENTITY.publicKey,
                undefined,
                50,
            );
        });
    });

    it('shows refusal sentence from server and generates NO offline ticket when vouch fails', async () => {
        vi.mocked(generateInvite).mockRejectedValueOnce({
            status: 409,
            code: 'not_enough',
            message: 'You have only 20 left in your vouching budget.',
        });

        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('invite-vouch-50')).toBeInTheDocument());

        fireEvent.click(screen.getByTestId('invite-vouch-50'));
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('You have only 20 left in your vouching budget.');
        });
        expect(buildOfflineInviteCode).not.toHaveBeenCalled();
    });

    it('generates offline ticket carrying no vouch when offline and preset is None', async () => {
        vi.mocked(generateInvite).mockRejectedValueOnce(new TypeError('Failed to fetch'));

        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('invite-vouch-none')).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

        await waitFor(() => {
            expect(buildOfflineInviteCode).toHaveBeenCalledWith(
                IDENTITY.publicKey,
                IDENTITY.privateKey,
                undefined,
            );
        });
        expect((await screen.findAllByTitle('BP-offline-ticket')).length).toBeGreaterThan(0);
    });

    it('renders §11 Vouchers block for owners/committee admins', async () => {
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('vouchers-block')).toBeInTheDocument());

        expect(screen.getByText('Vouchers')).toBeInTheDocument();
        expect(screen.getByText(/Jane Albury/)).toBeInTheDocument();
        expect(screen.getByText(/4 vouched/)).toBeInTheDocument();
        expect(screen.getByText(/1 below zero/)).toBeInTheDocument();
        expect(screen.getByTestId('make-voucher-button')).toBeInTheDocument();
    });

    it('does not render Vouchers block when member is not owner/committee admin', async () => {
        vi.mocked(getVouchersBlock).mockRejectedValueOnce(new Error('committee_only'));

        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByText(/Invite Someone/)).toBeInTheDocument());
        expect(screen.queryByTestId('vouchers-block')).not.toBeInTheDocument();
    });
});
