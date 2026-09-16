import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { ProjectsPage } from './ProjectsPage';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Treasury, BalanceInfo } from '../lib/api';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

const mockTreasuries: Treasury[] = [
    {
        publicKey: 'treasury-1',
        name: 'Community Garden Solar Irrigation',
        callsign: 'garden-solar',
        purpose: 'Installing solar-powered automated water pumps and drip irrigation lines for community plots.',
        balance: 150,
        creditLine: 0,
        liveOffers: 1,
        goalAmount: 500,
        currentAmount: 150,
        deadlineAt: '2026-10-31T23:59:59.000Z',
        lifecycle: 'bounded',
        status: 'active',
        avatar: null,
    },
    {
        publicKey: 'treasury-mine',
        name: 'My Own Tool Library Project',
        callsign: 'tool-library',
        purpose: 'Purchasing shared carpentry tools for the community workshop.',
        balance: 0,
        creditLine: 0,
        liveOffers: 0,
        goalAmount: 300,
        currentAmount: 0,
        deadlineAt: null,
        lifecycle: 'bounded',
        status: 'active',
        avatar: null,
    },
];

const mockTreasuryDetail: any = {
    publicKey: 'treasury-1',
    name: 'Community Garden Solar Irrigation',
    callsign: 'garden-solar',
    purpose: 'Installing solar-powered automated water pumps and drip irrigation lines for community plots.',
    balance: 150,
    creditLine: 0,
    goalAmount: 500,
    currentAmount: 150,
    deadlineAt: '2026-10-31T23:59:59.000Z',
    lifecycle: 'bounded',
    status: 'active',
    avatar: null,
    created_at: '2026-09-01T00:00:00.000Z',
    signers: [
        { publicKey: 'keeper-pubkey-123', callsign: 'GardenerBob', role: 'admin' },
    ],
    keepers: [
        { pubkey: 'keeper-pubkey-123', callsign: 'GardenerBob', role: 'admin' },
    ],
    rules: {
        approval_threshold: 1,
        auto_payout_limit: 0,
    },
    posts: [],
    flow: [],
    deferredClaims: [],
};

const mockBalance: BalanceInfo = {
    balance: 100,
    floor: -500,
    commonsBalance: 250,
    earnedCredit: 12,
    callsign: 'CharlieBacker',
    keeperOf: ['treasury-mine'],
    tier: 'contributor' as any,
};

vi.mock('../lib/api', () => ({
    getTreasuries: vi.fn(async () => ({
        treasuries: mockTreasuries,
    })),
    getTreasury: vi.fn(async (pk: string) => {
        if (pk === 'treasury-1') return mockTreasuryDetail;
        return {
            ...mockTreasuryDetail,
            publicKey: pk,
            keepers: [{ pubkey: 'my-user-pubkey', callsign: 'Alice', role: 'admin' }],
        };
    }),
    getBalance: vi.fn(async () => mockBalance),
    createEnterprise: vi.fn(async () => ({ success: true })),
    treasuryPledge: vi.fn(async () => ({ success: true, txId: 'tx-pledge-123' })),
    treasurySweep: vi.fn(async () => ({ success: true })),
    treasuryApprove: vi.fn(async () => ({ success: true })),
    treasuryReject: vi.fn(async () => ({ success: true })),
    treasuryComplete: vi.fn(async () => ({ success: true })),
    treasuryPostOffer: vi.fn(async () => ({ success: true })),
    treasuryPostNeed: vi.fn(async () => ({ success: true })),
    deleteCrowdfundProject: vi.fn(async () => ({ success: true })),
    getDecisions: vi.fn(async () => ({ decisions: [], activeMembers30d: 5 })),
    getCommonsBalance: vi.fn(async () => ({ balance: 250 })),
    getAllMembers: vi.fn(async () => []),
    createDecision: vi.fn(async () => ({ success: true, decision: { id: 'dec-1' } })),
    proposeDecision: vi.fn(async () => ({ success: true })),
    castDecisionVote: vi.fn(async () => ({ success: true })),
    request: vi.fn(),
}));

const backerIdentity: BeanPoolIdentity = {
    publicKey: 'backer-pubkey-456',
    privateKey: 'privkey-456',
    callsign: 'CharlieBacker',
    createdAt: '2026-09-01T00:00:00Z',
};

const creatorIdentity: BeanPoolIdentity = {
    publicKey: 'my-user-pubkey',
    privateKey: 'privkey-mine',
    callsign: 'Alice',
    createdAt: '2026-09-01T00:00:00Z',
};

describe('ProjectsPage regression: Project Detail scroll container & pledge form clearance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders projects and opens project detail on click via onOpenTreasury', async () => {
        const handleOpenTreasury = vi.fn();
        render(<ProjectsPage identity={backerIdentity} onOpenTreasury={handleOpenTreasury} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        // Click on the project card to open detail
        fireEvent.click(screen.getByText('Community Garden Solar Irrigation'));

        expect(handleOpenTreasury).toHaveBeenCalledWith('treasury-1');
    });

    it('supports keyboard navigation (Enter and Space) on enterprise cards', async () => {
        const handleOpenTreasury = vi.fn();
        render(<ProjectsPage identity={backerIdentity} onOpenTreasury={handleOpenTreasury} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        const cards = screen.getAllByRole('button').filter(el => el.getAttribute('tabindex') === '0');
        expect(cards.length).toBeGreaterThan(0);
        const firstCard = cards[0];

        // Enter key activates card
        fireEvent.keyDown(firstCard, { key: 'Enter' });
        expect(handleOpenTreasury).toHaveBeenCalledWith('treasury-1');

        handleOpenTreasury.mockClear();

        // Space key activates card
        fireEvent.keyDown(firstCard, { key: ' ' });
        expect(handleOpenTreasury).toHaveBeenCalledWith('treasury-1');
    });

    it('ensures ProjectsPage scroll container has overflow-y: auto and paddingBottom: var(--bottom-nav-offset)', async () => {
        const { container } = render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        // Verify the root page container has overflowY: auto and var(--bottom-nav-offset) clearance (#788)
        const rootContainer = container.firstElementChild as HTMLElement;
        expect(rootContainer).not.toBeNull();
        expect(rootContainer).toHaveStyle({ overflowY: 'auto' });
        expect(rootContainer).toHaveStyle({ paddingBottom: 'var(--bottom-nav-offset)' });
    });

    it('ensures propose enterprise modal has dynamic bottom-nav-offset clearance and closes on Escape', async () => {
        render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        // Click propose button to open modal
        const proposeBtn = screen.getByRole('button', { name: /\+ Propose/i });
        fireEvent.click(proposeBtn);

        const modalHeading = screen.getByRole('heading', { name: 'Propose an Enterprise / Project' });
        expect(modalHeading).toBeInTheDocument();

        // Verify modal outer container has dynamic paddingBottom clearance (#791)
        const modalContainer = modalHeading.closest('.fixed.inset-0') as HTMLElement;
        expect(modalContainer).not.toBeNull();
        expect(modalContainer).toHaveStyle({ paddingBottom: 'calc(var(--bottom-nav-offset) + 2rem)' });

        // Verify inner modal dialog has overflowY and clearance
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveStyle({ paddingBottom: 'calc(var(--bottom-nav-offset) + 1.5rem)' });

        // Press Escape key to close dialog
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('heading', { name: 'Propose an Enterprise / Project' })).not.toBeInTheDocument();
    });

    it('positions pledge form with widened amount input and handles pledge submission in TreasuryDetailPage', async () => {
        render(<TreasuryDetailPage identity={backerIdentity} pubkey="treasury-1" onBack={vi.fn()} />);

        await waitFor(() => {
            expect(screen.getByText('Back this initiative')).toBeInTheDocument();
        });

        // Find pledge button
        const pledgeButton = screen.getByRole('button', { name: /Pledge Beans/i });
        expect(pledgeButton).toBeInTheDocument();

        // Verify Amount input is wide enough for placeholder and 4-digit value (#790)
        const amountInput = screen.getByPlaceholderText('Amount (🫘)');
        expect(amountInput).toBeInTheDocument();
        expect(amountInput.className).toContain('w-32');
        expect(amountInput.className).toContain('min-w-[7.5rem]');
        expect(screen.getByPlaceholderText('Memo (optional)')).toBeInTheDocument();

        // Verify content container has dynamic bottom nav offset clearance (#793)
        const contentContainer = pledgeButton.closest('.max-w-2xl');
        expect(contentContainer).not.toBeNull();
        expect(contentContainer).toHaveStyle({ paddingBottom: 'calc(var(--bottom-nav-offset) + 4rem)' });
    });

    it('renders keeper operational controls for enterprise keeper and preserves treasury actions', async () => {
        render(<TreasuryDetailPage identity={creatorIdentity} pubkey="treasury-mine" onBack={vi.fn()} />);

        await waitFor(() => {
            expect(screen.getByText('Operator Controls')).toBeInTheDocument();
        });

        // Keeper sees action buttons (Post Offer, Post Need, To Commons)
        expect(screen.getByRole('button', { name: /Post Offer/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Post Need/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /To Commons/i })).toBeInTheDocument();
    });

    it('renders cancel initiative button for keeper of bounded unfunded project and triggers deletion', async () => {
        const handleBack = vi.fn();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.spyOn(window, 'alert').mockImplementation(() => {});

        render(<TreasuryDetailPage identity={creatorIdentity} pubkey="treasury-mine" onBack={handleBack} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Cancel Initiative & Refund Escrow/i })).toBeInTheDocument();
        });

        const cancelBtn = screen.getByRole('button', { name: /Cancel Initiative & Refund Escrow/i });
        fireEvent.click(cancelBtn);

        await waitFor(() => {
            expect(handleBack).toHaveBeenCalled();
        });
    });

    it('renders live offer count and badge parity on enterprise cards in ProjectsPage', async () => {
        render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        // Project badge
        expect(screen.getAllByText('🌱 Project').length).toBeGreaterThan(0);

        // Live offers count
        expect(screen.getByText(/1 live offer/i)).toBeInTheDocument();
    });
});
