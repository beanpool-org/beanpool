import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EscrowDisputesPanel } from './EscrowDisputesPanel';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';

const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Test Node',
    url: 'https://test-node.local',
    adminPassword: 'admin-secret-password',
};

const mockDisputes: nodeClient.EscrowDisputeItem[] = [
    {
        id: 'tx_escrow_101',
        postId: 'post_firewood_1',
        buyerPubkey: 'pk_buyer_alice_1234567890',
        sellerPubkey: 'pk_seller_bob_0987654321',
        buyerCallsign: 'alice-mullum',
        buyerName: 'Alice Springs',
        sellerCallsign: 'bob-firewood',
        sellerName: 'Bob Builder',
        credits: 100,
        status: 'pending',
        createdAt: Date.now() - 10 * 86400 * 1000, // 10 days ago
        daysStuck: 10,
        post: {
            id: 'post_firewood_1',
            title: 'Split Ironbark Firewood 1 Trailer',
            description: 'Seasoned ironbark ready to burn. Drop off at farm gate.',
            authorPubkey: 'pk_seller_bob_0987654321',
            authorName: 'Bob Builder',
            authorCallsign: 'bob-firewood',
            priceCredits: 100,
            unitPrice: 100,
            category: 'firewood',
        },
        chatContext: [
            {
                id: 'msg_1',
                senderPubkey: 'pk_buyer_alice_1234567890',
                recipientPubkey: 'pk_seller_bob_0987654321',
                senderCallsign: 'alice-mullum',
                content: 'Hi Bob, did you drop the wood at the front gate?',
                createdAt: Date.now() - 9 * 86400 * 1000,
            },
            {
                id: 'msg_2',
                senderPubkey: 'pk_seller_bob_0987654321',
                recipientPubkey: 'pk_buyer_alice_1234567890',
                senderCallsign: 'bob-firewood',
                content: 'Yes Alice, dropped it yesterday afternoon by the cattle grid.',
                createdAt: Date.now() - 8 * 86400 * 1000,
            },
        ],
        resolution: null,
        resolvedAt: null,
        resolvedBy: null,
    },
    {
        id: 'tx_escrow_102',
        postId: 'post_eggs_2',
        buyerPubkey: 'pk_buyer_charlie',
        sellerPubkey: 'pk_seller_dana',
        buyerCallsign: 'charlie-coop',
        sellerCallsign: 'dana-pastures',
        credits: 25,
        status: 'completed',
        createdAt: Date.now() - 15 * 86400 * 1000,
        daysStuck: 15,
        post: {
            id: 'post_eggs_2',
            title: 'Farm Fresh Pastured Eggs 5 Dozen',
            description: 'Weekly organic pastured eggs',
            authorPubkey: 'pk_seller_dana',
            priceCredits: 25,
            unitPrice: 5,
            category: 'produce',
        },
        chatContext: [],
        resolution: 'refund_to_buyer',
        resolvedAt: Date.now() - 2 * 86400 * 1000,
        resolvedBy: 'owner:password',
    },
];

describe('EscrowDisputesPanel Component', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(nodeClient, 'fetchEscrowDisputes').mockResolvedValue({
            disputes: mockDisputes,
            total: 2,
            minDays: 7,
        });
        vi.spyOn(nodeClient, 'resolveEscrowDisputeApi').mockResolvedValue({
            success: true,
            transactionId: 'tx-1',
            resolution: 'release_to_seller',
            authSigner: 'admin-signer-pk',
            transaction: {
                ...mockDisputes[0],
                status: 'completed',
                resolution: 'release_to_seller',
                resolvedAt: Date.now(),
                resolvedBy: 'admin-signer-pk',
            },
        });
    });

    it('renders header, governance warning, and pending disputes', async () => {
        await act(async () => {
            render(<EscrowDisputesPanel activeNode={mockProfile} />);
        });

        expect(screen.getByText(/Escrow Dispute Resolution/i)).toBeInTheDocument();
        expect(screen.getByText(/never a quiet admin button/i)).toBeInTheDocument();
        expect(screen.getByText('Split Ironbark Firewood 1 Trailer')).toBeInTheDocument();
        expect(screen.getByText('100.00 BEAN')).toBeInTheDocument();
        expect(screen.getByText(/10d in escrow/i)).toBeInTheDocument();
        expect(screen.getByText(/alice-mullum/i)).toBeInTheDocument();
        expect(screen.getByText(/bob-firewood/i)).toBeInTheDocument();
    });

    it('toggles chat context visibility', async () => {
        await act(async () => {
            render(<EscrowDisputesPanel activeNode={mockProfile} />);
        });

        // Chat starts collapsed
        expect(screen.queryByText('Hi Bob, did you drop the wood at the front gate?')).not.toBeInTheDocument();

        // Click to view chat
        const viewChatBtn = screen.getByText(/View Chat/i);
        await act(async () => {
            fireEvent.click(viewChatBtn);
        });

        expect(screen.getByText('Hi Bob, did you drop the wood at the front gate?')).toBeInTheDocument();
        expect(screen.getByText('Yes Alice, dropped it yesterday afternoon by the cattle grid.')).toBeInTheDocument();

        // Click to hide chat
        const hideChatBtn = screen.getByText(/Hide Chat/i);
        await act(async () => {
            fireEvent.click(hideChatBtn);
        });
        expect(screen.queryByText('Hi Bob, did you drop the wood at the front gate?')).not.toBeInTheDocument();
    });

    it('opens modal and resolves via Release to Seller', async () => {
        const onRefresh = vi.fn();
        await act(async () => {
            render(<EscrowDisputesPanel activeNode={mockProfile} onRefresh={onRefresh} />);
        });

        // Click Release to Seller
        const releaseBtn = screen.getByRole('button', { name: /Release to Seller/i });
        await act(async () => {
            fireEvent.click(releaseBtn);
        });

        // Verify modal content
        expect(screen.getByText(/Confirm Escrow Resolution/i)).toBeInTheDocument();
        expect(screen.getByText('+98.50 BEAN')).toBeInTheDocument(); // Seller payout
        expect(screen.getByText('+1.50 BEAN')).toBeInTheDocument(); // Commons fee

        // Enter arbitration reason
        const textarea = screen.getByPlaceholderText(/delivery proof/i);
        fireEvent.change(textarea, { target: { value: 'Seller left wood at gate with photo proof' } });

        // Confirm
        const confirmBtn = screen.getByRole('button', { name: /Confirm & Record Resolution/i });
        await act(async () => {
            fireEvent.click(confirmBtn);
        });

        expect(nodeClient.resolveEscrowDisputeApi).toHaveBeenCalledWith(
            'https://test-node.local',
            'tx_escrow_101',
            'release_to_seller',
            'Seller left wood at gate with photo proof',
            'admin-secret-password',
            undefined
        );
    });

    it('opens modal and resolves via Refund to Buyer', async () => {
        await act(async () => {
            render(<EscrowDisputesPanel activeNode={mockProfile} />);
        });

        const refundBtn = screen.getByRole('button', { name: /Refund to Buyer/i });
        await act(async () => {
            fireEvent.click(refundBtn);
        });

        expect(screen.getByText('+100.00 BEAN')).toBeInTheDocument(); // Full buyer refund

        const confirmBtn = screen.getByRole('button', { name: /Confirm & Record Resolution/i });
        await act(async () => {
            fireEvent.click(confirmBtn);
        });

        expect(nodeClient.resolveEscrowDisputeApi).toHaveBeenCalledWith(
            'https://test-node.local',
            'tx_escrow_101',
            'refund_to_buyer',
            undefined,
            'admin-secret-password',
            undefined
        );
    });

    it('opens modal and resolves via Split 50/50', async () => {
        await act(async () => {
            render(<EscrowDisputesPanel activeNode={mockProfile} />);
        });

        const splitBtn = screen.getByRole('button', { name: /Split 50 \/ 50/i });
        await act(async () => {
            fireEvent.click(splitBtn);
        });

        // 50 to buyer, 49.25 to seller (50 - 1.5%), 0.75 to commons
        expect(screen.getByText('+50.00 BEAN')).toBeInTheDocument();
        expect(screen.getByText('+49.25 BEAN')).toBeInTheDocument();
        expect(screen.getByText('+0.75 BEAN')).toBeInTheDocument();

        const confirmBtn = screen.getByRole('button', { name: /Confirm & Record Resolution/i });
        await act(async () => {
            fireEvent.click(confirmBtn);
        });

        expect(nodeClient.resolveEscrowDisputeApi).toHaveBeenCalledWith(
            'https://test-node.local',
            'tx_escrow_101',
            'split',
            undefined,
            'admin-secret-password',
            undefined
        );
    });

    it('filters by status: pending vs resolved vs all', async () => {
        await act(async () => {
            render(<EscrowDisputesPanel activeNode={mockProfile} />);
        });

        // In pending view, dispute 101 is shown, 102 is not
        expect(screen.getByText('Split Ironbark Firewood 1 Trailer')).toBeInTheDocument();
        expect(screen.queryByText('Farm Fresh Pastured Eggs 5 Dozen')).not.toBeInTheDocument();

        // Switch to resolved
        const resolvedTab = screen.getByRole('button', { name: /Resolved History/i });
        await act(async () => {
            fireEvent.click(resolvedTab);
        });

        expect(screen.queryByText('Split Ironbark Firewood 1 Trailer')).not.toBeInTheDocument();
        expect(screen.getByText('Farm Fresh Pastured Eggs 5 Dozen')).toBeInTheDocument();
        expect(screen.getByText(/Public Provenance Stamp/i)).toBeInTheDocument();
        // #945: resolution never shows raw key or owner:password
        expect(screen.getByText(/a community admin/i)).toBeInTheDocument();
        expect(screen.queryByText(/owner:password/i)).not.toBeInTheDocument();

        // Switch to all
        const allTab = screen.getByRole('button', { name: /^All/i });
        await act(async () => {
            fireEvent.click(allTab);
        });

        expect(screen.getByText('Split Ironbark Firewood 1 Trailer')).toBeInTheDocument();
        expect(screen.getByText('Farm Fresh Pastured Eggs 5 Dozen')).toBeInTheDocument();
    });

    it('excludes finished ordinary deals without dispute resolution from resolved history and all', async () => {
        const ordinaryDeal: nodeClient.EscrowDisputeItem = {
            id: 'tx_ordinary_completed',
            postId: 'post_bread',
            buyerPubkey: 'pk_buyer_alice',
            sellerPubkey: 'pk_seller_bob',
            credits: 10,
            status: 'completed',
            createdAt: Date.now() - 20 * 86400 * 1000,
            daysStuck: 20,
            post: {
                id: 'post_bread',
                title: 'Sourdough Loaf',
                description: 'Fresh bread',
                authorPubkey: 'pk_seller_bob',
                priceCredits: 10,
                unitPrice: 10,
                category: 'goods',
            },
            chatContext: [],
            resolution: null,
            resolvedAt: null,
            resolvedBy: null,
        };

        vi.spyOn(nodeClient, 'fetchEscrowDisputes').mockResolvedValue({
            disputes: [...mockDisputes, ordinaryDeal],
            total: 3,
            minDays: 7,
        });

        await act(async () => {
            render(<EscrowDisputesPanel activeNode={mockProfile} />);
        });

        // Switch to resolved
        const resolvedTab = screen.getByRole('button', { name: /Resolved History/i });
        await act(async () => {
            fireEvent.click(resolvedTab);
        });

        expect(screen.getByText('Farm Fresh Pastured Eggs 5 Dozen')).toBeInTheDocument();
        expect(screen.queryByText('Sourdough Loaf')).not.toBeInTheDocument();

        // Switch to all
        const allTab = screen.getByRole('button', { name: /^All/i });
        await act(async () => {
            fireEvent.click(allTab);
        });

        expect(screen.queryByText('Sourdough Loaf')).not.toBeInTheDocument();
    });

    it('renders pagination controls and fetches next page when total > 50', async () => {
        const fetchSpy = vi.spyOn(nodeClient, 'fetchEscrowDisputes').mockResolvedValue({
            disputes: mockDisputes,
            total: 60,
            minDays: 7,
            limit: 50,
            offset: 0,
        });

        await act(async () => {
            render(<EscrowDisputesPanel activeNode={mockProfile} />);
        });

        expect(screen.getByText(/Page 1 of 2/i)).toBeInTheDocument();
        const prevBtn = screen.getByRole('button', { name: /Previous/i });
        const nextBtn = screen.getByRole('button', { name: /Next/i });

        expect(prevBtn).toBeDisabled();
        expect(nextBtn).toBeEnabled();

        await act(async () => {
            fireEvent.click(nextBtn);
        });

        expect(fetchSpy).toHaveBeenCalledWith(
            mockProfile.url,
            7,
            mockProfile.adminPassword,
            undefined,
            expect.objectContaining({ limit: 50, offset: 50 })
        );
    });

    it('renders empty state when no disputes found', async () => {
        vi.spyOn(nodeClient, 'fetchEscrowDisputes').mockResolvedValue({
            disputes: [],
            total: 0,
            minDays: 7,
        });

        await act(async () => {
            render(<EscrowDisputesPanel activeNode={mockProfile} />);
        });

        expect(screen.getByText(/No Stalled Escrows/i)).toBeInTheDocument();
    });
});
