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
            budget: { left: 55000, held: 10000, heldInvites: 1, vouched: 35000, peopleVouched: 4, level: 100000 },
            presets: [2500, 5000, 7500, 10000],
            vouchMax: 10000,
            budgetMax: 200000,
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
                    left: 55000,
                    held: 10000,
                    heldInvites: 1,
                    vouched: 35000,
                    peopleVouched: 4,
                    level: 100000,
                    belowZero: 1,
                    writtenOff: 0,
                    passedOn: { amount_c: 0, people: 0 },
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
        memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { invites: true, beans: true },
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
            presets: [2500, 5000, 7500, 10000],
            vouchMax: 10000,
            budgetMax: 200000,
            vouchedBy: [],
        });

        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByText(/Invite Someone/)).toBeInTheDocument());
        expect(screen.queryByTestId('invite-vouch')).not.toBeInTheDocument();
    });

    it('greys out presets above what budget is left', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce({
            voucher: true,
            budget: { left: 4000, held: 0, heldInvites: 0, vouched: 96000, peopleVouched: 10, level: 100000 },
            presets: [2500, 5000, 7500, 10000],
            vouchMax: 10000,
            budgetMax: 200000,
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
            // The vouch goes as whole hundredths, as the node takes it (core isVouchPreset): 50 Beans.
            expect(generateInvite).toHaveBeenCalledWith(
                IDENTITY.publicKey,
                undefined,
                5000,
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

    it('stops with noOfflineVouch notice and generates NO offline ticket when offline with a vouch selected', async () => {
        vi.mocked(generateInvite).mockRejectedValueOnce(new TypeError('Failed to fetch'));

        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('invite-vouch-50')).toBeInTheDocument());

        fireEvent.click(screen.getByTestId('invite-vouch-50'));
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent(
                'You can’t vouch on an offline ticket. Choose None to make one, or try again when you’re connected.'
            );
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
        // A row says only what matters (invites-vouching I4): who, and what is left. The numbers are on the card.
        const row = screen.getByTestId('voucher-row-Jane Albury');
        expect(row).toHaveTextContent(/^@Jane Albury · 550 left ›$/);
        expect(row.textContent).not.toMatch(/vouched|below zero/);
        expect(screen.getByTestId('make-voucher-button')).toBeInTheDocument();
    });

    it('"+ Make someone a voucher" says one plain sentence, no developer words, and closes on Escape (#2915 round 4)', async () => {
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('make-voucher-button')).toBeInTheDocument());

        const row = screen.getByTestId('make-voucher-button');
        row.focus();
        fireEvent.click(row);
        const dialog = screen.getByRole('dialog', { name: '+ Make someone a voucher' });
        expect(dialog).toHaveTextContent('Make vouchers on the names list in the phone app.');
        // Never a repo folder, a slice code or a promise of screens to come.
        expect(dialog.textContent).not.toMatch(/apps\/|manager|\bS\d\b|coming soon/i);
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: '+ Make someone a voucher' }));

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: '+ Make someone a voucher' })).toBeNull();
        expect(document.activeElement).toBe(row);
    });

    it('does not render Vouchers block when member is not owner/committee admin', async () => {
        vi.mocked(getVouchersBlock).mockRejectedValueOnce(new Error('committee_only'));

        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByText(/Invite Someone/)).toBeInTheDocument());
        expect(screen.queryByTestId('vouchers-block')).not.toBeInTheDocument();
    });
});
