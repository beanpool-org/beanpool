import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AncestryTreePanel } from './AncestryTreePanel';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';

vi.mock('../../lib/node-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/node-client')>();
    return {
        ...actual,
        pruneInviteBranch: vi.fn().mockResolvedValue({ ok: true }),
    };
});

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
        expect(statsButtons[1]).toHaveAttribute('aria-expanded', 'false');
        expect(statsButtons[1]).toHaveAttribute('aria-controls', 'stats-pk_bob_level');
        expect(statsButtons[1]).toHaveAttribute('aria-label', 'Show activity stats for Bob');
        await userEvent.click(statsButtons[1]); // Bob's stats button
        expect(statsButtons[1]).toHaveAttribute('aria-expanded', 'true');
        expect(statsButtons[1]).toHaveAttribute('aria-label', 'Hide activity stats for Bob');

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
        expect(handleRefresh).not.toHaveBeenCalled();
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

    it('handles snake_case invited_by payloads correctly without flattening the tree', async () => {
        const snakeCasePayload = {
            members: [
                {
                    publicKey: 'pk_alice',
                    callsign: 'Alice',
                    invitedBy: 'genesis',
                },
                {
                    publicKey: 'pk_bob',
                    callsign: 'Bob',
                    invited_by: 'pk_alice',
                },
                {
                    publicKey: 'pk_charlie',
                    callsign: 'Charlie',
                    invited_by: 'pk_bob',
                },
            ],
            memberStats: {
                pk_alice: { posts: 1 },
                pk_bob: { posts: 2 },
                pk_charlie: { posts: 3 },
            },
        };

        render(
            <AncestryTreePanel
                nodeData={snakeCasePayload as any}
                activeNode={mockNode}
            />
        );

        // All 3 members render
        expect(screen.getByText(/Alice/)).toBeInTheDocument();
        expect(screen.getByText(/Bob/)).toBeInTheDocument();
        expect(screen.getByText(/Charlie/)).toBeInTheDocument();

        // Alice is a genesis root with children, so Alice has a disclosure button
        const aliceToggle = screen.getByRole('button', { name: /Collapse Alice branch/i });
        expect(aliceToggle).toBeInTheDocument();

        // Bob has Charlie as a child via invited_by, so Bob also has a disclosure button
        const bobToggle = screen.getByRole('button', { name: /Collapse Bob branch/i });
        expect(bobToggle).toBeInTheDocument();
    });

    it('gracefully handles cyclical parent/invite relationships without freezing or stack overflow', async () => {
        const cyclicPayload = {
            members: [
                {
                    publicKey: 'pk_cycle_1',
                    callsign: 'CycleOne',
                    invitedBy: 'pk_cycle_2',
                },
                {
                    publicKey: 'pk_cycle_2',
                    callsign: 'CycleTwo',
                    invitedBy: 'pk_cycle_1',
                },
                {
                    publicKey: 'pk_self_ref',
                    callsign: 'SelfRef',
                    invitedBy: 'pk_self_ref',
                },
            ],
            health: {
                flags: [
                    {
                        type: 'cycle_flag',
                        description: 'Cyclic loop detected',
                        members: ['pk_cycle_1', 'pk_cycle_2'],
                    },
                ],
            },
            memberStats: {
                pk_cycle_1: { posts: 10, volume: 100 },
                pk_cycle_2: { posts: 5, volume: 50 },
                pk_self_ref: { posts: 1, volume: 10 },
            },
        };

        // Renders without RangeError: Maximum call stack size exceeded
        render(
            <AncestryTreePanel
                nodeData={cyclicPayload as any}
                activeNode={mockNode}
            />
        );

        expect(screen.getByText(/Showing 3 of 3 members/i)).toBeInTheDocument();
        expect(screen.getByText(/CycleOne/)).toBeInTheDocument();
        expect(screen.getByText(/CycleTwo/)).toBeInTheDocument();
        expect(screen.getByText(/SelfRef/)).toBeInTheDocument();
    });

    it('supports accessible disclosure toggle button with aria-expanded and separate action controls', async () => {
        render(
            <AncestryTreePanel
                nodeData={realPayload}
                activeNode={mockNode}
                onSelectMember={vi.fn()}
            />
        );

        // Bob has child Charlie, so Bob has an accessible disclosure toggle
        const bobToggle = screen.getByRole('button', { name: /Collapse Bob branch/i });
        expect(bobToggle).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByText(/Charlie/)).toBeInTheDocument();

        // Collapse Bob branch
        await userEvent.click(bobToggle);
        expect(bobToggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText(/Charlie/)).not.toBeInTheDocument();

        // Re-expand Bob branch
        await userEvent.click(bobToggle);
        expect(bobToggle).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByText(/Charlie/)).toBeInTheDocument();

        // Action controls (stats, inspect, prune) are NOT nested within the disclosure button
        const statsBtns = screen.getAllByTitle(/Toggle branch activity stats/i);
        expect(bobToggle).not.toContainElement(statsBtns[0]);

        const inspectBtns = screen.getAllByTitle(/Inspect member profile/i);
        expect(bobToggle).not.toContainElement(inspectBtns[0]);
    });

    it('calls onRefresh when onPruneBranch is omitted and fallback pruneInviteBranch executes', async () => {
        const handleRefresh = vi.fn();

        render(
            <AncestryTreePanel
                nodeData={realPayload}
                activeNode={mockNode}
                onRefresh={handleRefresh}
            />
        );

        // Click Prune Branch on Bob
        const pruneBranchButtons = screen.getAllByText(/Prune Branch/i);
        await userEvent.click(pruneBranchButtons[0]);

        // Type exact callsign to unlock
        const confirmInput = document.getElementById('prune-branch-confirm-input') as HTMLInputElement;
        await userEvent.type(confirmInput, 'Alice');

        const confirmBtn = document.getElementById('confirm-prune-branch-btn') as HTMLButtonElement;
        await waitFor(() => {
            expect(confirmBtn).not.toBeDisabled();
        });

        await userEvent.click(confirmBtn);

        // Fallback pruneInviteBranch was called, followed by onRefresh
        await waitFor(() => {
            expect(nodeClient.pruneInviteBranch).toHaveBeenCalledWith(
                mockNode.url,
                'pk_alice_genesis_0000000000',
                mockNode.adminPassword,
                undefined
            );
        });

        await waitFor(() => {
            expect(handleRefresh).toHaveBeenCalledTimes(1);
        });
    });

    it('allows collapsing and expanding branches when filter or search is active', async () => {
        render(
            <AncestryTreePanel
                nodeData={realPayload}
                activeNode={mockNode}
            />
        );

        // Turn on a filter
        const voucherFilterBtn = screen.getByRole('button', { name: /🤝 Vouchers/i });
        await userEvent.click(voucherFilterBtn);

        // Find disclosure button for Alice (has children)
        const aliceBtn = screen.getByRole('button', { name: /Collapse Alice branch/i });
        expect(aliceBtn).toHaveAttribute('aria-expanded', 'true');

        // Operator collapses branch
        await userEvent.click(aliceBtn);
        expect(aliceBtn).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByRole('button', { name: /Expand Alice branch/i })).toBeInTheDocument();

        // Operator expands branch again
        await userEvent.click(aliceBtn);
        expect(aliceBtn).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('button', { name: /Collapse Alice branch/i })).toBeInTheDocument();
    });

    it('shows the tier the node reports, not one recomputed from the granted column', () => {
        // earnedCredit on the admin feed is the granted lane only; an Elder by trade has 0 there.
        const payload = {
            members: [
                { publicKey: 'pk_dana_000000000000000000', callsign: 'Dana', invitedBy: 'genesis', earnedCredit: 0, tier: 'Elder', standing: 'Elder' },
                { publicKey: 'pk_eli_0000000000000000000', callsign: 'Eli', invitedBy: 'genesis', earnedCredit: 1320, tier: 'Steward', standing: 'Steward' },
            ],
            profiles: [
                { publicKey: 'pk_dana_000000000000000000', callsign: 'Dana', status: 'active' },
                { publicKey: 'pk_eli_0000000000000000000', callsign: 'Eli', status: 'active' },
            ],
        };
        render(<AncestryTreePanel nodeData={payload} activeNode={mockNode} onRefresh={vi.fn()} onPruneBranch={vi.fn()} onSelectMember={vi.fn()} />);
        expect(screen.getByText('⛰️ Elder')).toBeInTheDocument();
        expect(screen.getByText('🏛️ Steward')).toBeInTheDocument();
        expect(screen.queryByText(/Newcomer/)).not.toBeInTheDocument();
    });
});
