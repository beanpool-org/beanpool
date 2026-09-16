import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AncestryTreePanel } from './AncestryTreePanel';
import type { NodeProfile } from '../../lib/profiles';

describe('AncestryTreePanel Component (Bucket 2 Item 7)', () => {
    const mockNode: NodeProfile = {
        id: 'test-node-id',
        name: 'Test Node',
        url: 'https://test-node.local',
        adminPassword: 'test-admin-secret',
    };

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    const realPayload = {
        members: [
            {
                publicKey: 'pk_alice_genesis_0000000000',
                callsign: 'Alice',
                invitedBy: 'genesis',
                earnedCredit: 1400,
                canVouch: true,
                standing: 'GOOD',
            },
            {
                publicKey: 'pk_bob_level1_000000000000',
                callsign: 'Bob',
                invitedBy: 'pk_alice_genesis_0000000000',
                earnedCredit: 600,
                canVouch: false,
                standing: 'GOOD',
            },
            {
                publicKey: 'pk_charlie_level2_0000000000',
                callsign: 'Charlie',
                invitedBy: 'pk_bob_level1_000000000000',
                earnedCredit: 200,
                canVouch: false,
                standing: 'FROZEN',
            },
        ],
        profiles: [
            { publicKey: 'pk_alice_genesis_0000000000', callsign: 'Alice', status: 'active' },
            { publicKey: 'pk_bob_level1_000000000000', callsign: 'Bob', status: 'active' },
            { publicKey: 'pk_charlie_level2_0000000000', callsign: 'Charlie', status: 'disabled' },
        ],
        health: {
            flags: [
                {
                    type: 'isolated_branch',
                    severity: 'warning',
                    description: 'Suspicious isolated branch',
                    members: ['pk_charlie_level2_0000000000'],
                },
            ],
        },
        reports: [
            {
                id: 'rep-1',
                targetPubkey: 'pk_charlie_level2_0000000000',
                reason: 'Abuse reported',
                status: 'pending',
            },
        ],
        memberStats: {
            pk_alice_genesis_0000000000: { posts: 5, messages: 12, deals: 3, volume: 150, cancelled: 0 },
            pk_bob_level1_000000000000: { posts: 2, messages: 4, deals: 1, volume: 50, cancelled: 0 },
            pk_charlie_level2_0000000000: { posts: 1, messages: 1, deals: 0, volume: 0, cancelled: 1 },
        },
        accounts: [
            { publicKey: 'pk_alice_genesis_0000000000', balance: 100 },
            { publicKey: 'pk_bob_level1_000000000000', balance: 50 },
            { publicKey: 'pk_charlie_level2_0000000000', balance: 25 },
        ],
    };

    it('renders with real payload, supports lineage tree navigation, stats toggle, search/filters, and prune branch safeguard', async () => {
        const handlePruneBranch = vi.fn().mockResolvedValue(undefined);
        const handleRefresh = vi.fn();
        const handleSelectMember = vi.fn();

        render(
            <AncestryTreePanel
                nodeData={realPayload}
                activeNode={mockNode}
                onRefresh={handleRefresh}
                onPruneBranch={handlePruneBranch}
                onSelectMember={handleSelectMember}
            />
        );

        // Header & count
        expect(screen.getByText(/Hierarchical Ancestry Tree & Lineage Audit/i)).toBeInTheDocument();
        expect(screen.getByText(/Showing 3 of 3 members/i)).toBeInTheDocument();

        // Check members in lineage
        expect(screen.getByText(/Alice/)).toBeInTheDocument();
        expect(screen.getByText(/Bob/)).toBeInTheDocument();
        expect(screen.getByText(/Charlie/)).toBeInTheDocument();

        // Check badges
        expect(screen.getByText(/⛰️ Elder/i)).toBeInTheDocument();
        expect(screen.getByText(/🏛️ Steward/i)).toBeInTheDocument();
        expect(screen.getByText(/🏠 Resident/i)).toBeInTheDocument();
        expect(screen.getByText('🤝 Voucher')).toBeInTheDocument();
        expect(screen.getByText(/🚩 1/i)).toBeInTheDocument(); // Charlie report

        // Toggle Stats on Bob
        const statsButtons = screen.getAllByTitle(/Toggle branch activity stats/i);
        expect(statsButtons.length).toBeGreaterThan(0);
        await userEvent.click(statsButtons[1]); // Bob's stats button

        // Verify Branch stats card opened
        expect(screen.getByText(/Branch \(2 members\)/i)).toBeInTheDocument();

        // Test Filter: 🤝 Vouchers
        const voucherFilterBtn = screen.getByRole('button', { name: /🤝 Vouchers/i });
        await userEvent.click(voucherFilterBtn);
        expect(screen.getByText(/Showing 1 of 3 members/i)).toBeInTheDocument();

        // Reset Filter: All
        const allFilterBtn = screen.getByRole('button', { name: 'All' });
        await userEvent.click(allFilterBtn);
        expect(screen.getByText(/Showing 3 of 3 members/i)).toBeInTheDocument();

        // Test Search Filter: "Charlie"
        const searchInput = document.getElementById('member-search') as HTMLInputElement;
        await userEvent.type(searchInput, 'charlie');
        expect(screen.getByText(/Showing 1 of 3 members/i)).toBeInTheDocument();

        // Clear search
        const clearBtn = document.getElementById('member-search-clear')!;
        await userEvent.click(clearBtn);
        expect(screen.getByText(/Showing 3 of 3 members/i)).toBeInTheDocument();

        // Test Prune Branch button on Bob (has Charlie as child)
        const pruneBranchButtons = screen.getAllByText(/Prune Branch/i);
        expect(pruneBranchButtons.length).toBeGreaterThan(0);
        await userEvent.click(pruneBranchButtons[0]);

        // PruneBranchModal opens with type-to-confirm safeguard
        expect(screen.getByText(/Prune Invite Branch/i)).toBeInTheDocument();
        const confirmBtn = document.getElementById('confirm-prune-branch-btn') as HTMLButtonElement;
        expect(confirmBtn).toBeDisabled();

        // Type exact callsign to unlock
        const confirmInput = document.getElementById('prune-branch-confirm-input') as HTMLInputElement;
        await userEvent.type(confirmInput, 'Alice');

        // Once exact match, button is enabled
        await waitFor(() => {
            expect(confirmBtn).not.toBeDisabled();
        });

        // Click confirm
        await userEvent.click(confirmBtn);

        await waitFor(() => {
            expect(handlePruneBranch).toHaveBeenCalledWith('pk_alice_genesis_0000000000');
        });
    });

    it('renders safely with an empty payload', async () => {
        render(
            <AncestryTreePanel
                nodeData={{ members: [] }}
                activeNode={mockNode}
            />
        );

        expect(screen.getByText(/Hierarchical Ancestry Tree & Lineage Audit/i)).toBeInTheDocument();
        expect(screen.getByText(/No members found in directory/i)).toBeInTheDocument();
    });

    it('renders safely with wrong-typed fields and malformed data', async () => {
        const malformedData = {
            members: [
                {
                    publicKey: 12345, // wrong type
                    callsign: null,
                    invitedBy: { nested: 'obj' },
                    earnedCredit: 'thousand',
                    canVouch: 'sure',
                },
                null,
                'invalid-member-entry',
                {
                    publicKey: 'pk_valid_node',
                    callsign: 9999,
                    invitedBy: 'pk_missing_parent',
                },
            ],
            profiles: 'not-an-array',
            health: 'invalid-health',
            reports: { not: 'array' },
            memberStats: 'not-an-object',
            accounts: null,
        };

        render(
            <AncestryTreePanel
                nodeData={malformedData as any}
                activeNode={mockNode}
            />
        );

        expect(screen.getByText(/Hierarchical Ancestry Tree & Lineage Audit/i)).toBeInTheDocument();
        // Component does not crash and renders valid member
        expect(screen.getByText('9999')).toBeInTheDocument();
    });
});
