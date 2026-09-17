import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PruneBranchModal } from './PruneBranchModal';
import type { MemberItem } from './MembersModule';

describe('PruneBranchModal Component (Bucket 2 Item 1)', () => {
    const mockRootMember: MemberItem = {
        publicKey: 'pk-root-elder-12345678',
        pubkey: 'pk-root-elder-12345678',
        callsign: 'BadRootLeader',
        name: 'Bad Root Leader',
        balance: 150.5,
        tier: 'Steward',
    };

    const mockDownstreamMembers: MemberItem[] = [
        mockRootMember,
        {
            publicKey: 'pk-child-1-87654321',
            pubkey: 'pk-child-1-87654321',
            callsign: 'ChildOne',
            invitedBy: 'pk-root-elder-12345678',
            balance: 50.25,
        },
        {
            publicKey: 'pk-child-2-99887766',
            pubkey: 'pk-child-2-99887766',
            callsign: 'ChildTwo',
            invitedBy: 'pk-root-elder-12345678',
            balance: 200,
        },
        {
            publicKey: 'pk-grandchild-1-11223344',
            pubkey: 'pk-grandchild-1-11223344',
            callsign: 'GrandChildOne',
            invitedBy: 'pk-child-1-87654321',
            balance: 75.25,
        },
        // Unrelated member not in this branch
        {
            publicKey: 'pk-unrelated-55555555',
            pubkey: 'pk-unrelated-55555555',
            callsign: 'UnrelatedMember',
            invitedBy: 'genesis',
            balance: 999,
        },
    ];

    it('renders with a real payload, calculates members and balances, and enforces type-to-confirm', async () => {
        const handleConfirm = vi.fn().mockResolvedValue(undefined);
        const handleClose = vi.fn();

        render(
            <PruneBranchModal
                rootMember={mockRootMember}
                members={mockDownstreamMembers}
                onConfirm={handleConfirm}
                onClose={handleClose}
            />
        );

        // Header & destructive banner
        expect(screen.getByText('Prune Invite Branch')).toBeInTheDocument();
        expect(screen.getByText('DESTRUCTIVE PROTOCOL ACTION')).toBeInTheDocument();

        // 4 members in branch: root + 2 children + 1 grandchild
        expect(screen.getByText('4')).toBeInTheDocument();
        // Net Commons Pool Impact: 150.5 + 50.25 + 200 + 75.25 = +476 🫘
        expect(screen.getByText('Net Commons Pool Impact:')).toBeInTheDocument();
        expect(document.getElementById('prune-net-impact')?.textContent).toContain('+476 🫘');

        // Root name shown in impact box
        expect(screen.getByText('BadRootLeader')).toBeInTheDocument();

        // Confirm button should initially be disabled
        const pruneBtn = screen.getByRole('button', { name: /Prune Entire Branch/i });
        expect(pruneBtn).toBeDisabled();

        // Typing wrong name keeps button disabled
        const input = screen.getByPlaceholderText(/Type "BadRootLeader" to confirm/i);
        await userEvent.type(input, 'WrongName');
        expect(pruneBtn).toBeDisabled();

        // Clearing and typing exact root name enables button
        await userEvent.clear(input);
        await userEvent.type(input, 'BadRootLeader');
        expect(pruneBtn).toBeEnabled();

        // Submitting triggers onConfirm with root pubkey
        await userEvent.click(pruneBtn);
        expect(handleConfirm).toHaveBeenCalledWith('pk-root-elder-12345678');
        await waitFor(() => {
            expect(handleClose).toHaveBeenCalled();
        });
    });

    it('renders safely with an empty payload without crashing', () => {
        const handleConfirm = vi.fn();
        const handleClose = vi.fn();

        render(
            <PruneBranchModal
                rootMember={null}
                members={[]}
                onConfirm={handleConfirm}
                onClose={handleClose}
            />
        );

        expect(screen.getByText('Prune Invite Branch')).toBeInTheDocument();
        expect(screen.getByText('0')).toBeInTheDocument();
        expect(screen.getByText('Net Commons Pool Impact:')).toBeInTheDocument();
        expect(document.getElementById('prune-net-impact')?.textContent).toContain('0 🫘');

        const pruneBtn = screen.getByRole('button', { name: /Prune Entire Branch/i });
        expect(pruneBtn).toBeDisabled();
    });

    it('renders safely with wrong-typed fields and malformed data', async () => {
        const handleConfirm = vi.fn();
        const handleClose = vi.fn();

        const malformedRoot = {
            publicKey: 12345 as any,
            pubkey: 67890 as any,
            callsign: null as any,
            name: undefined,
            balance: 'invalid-number-string' as any,
        };

        render(
            <PruneBranchModal
                rootMember={malformedRoot as any}
                members={'not-an-array' as any}
                onConfirm={handleConfirm}
                onClose={handleClose}
            />
        );

        expect(screen.getByText('Prune Invite Branch')).toBeInTheDocument();
        expect(screen.getByText('Unknown Root')).toBeInTheDocument();
        expect(screen.getByText('1')).toBeInTheDocument();
        expect(screen.getByText('Net Commons Pool Impact:')).toBeInTheDocument();
        expect(document.getElementById('prune-net-impact')?.textContent).toContain('0 🫘');
    });

    it('dismisses via Escape key and Cancel button', async () => {
        const handleClose = vi.fn();

        render(
            <PruneBranchModal
                rootMember={mockRootMember}
                members={mockDownstreamMembers}
                onConfirm={vi.fn()}
                onClose={handleClose}
            />
        );

        // Cancel button
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(handleClose).toHaveBeenCalledTimes(1);

        // Escape key
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(handleClose).toHaveBeenCalledTimes(2);
    });

    it('enforces exact case sensitivity in type-to-confirm safeguard', async () => {
        render(
            <PruneBranchModal
                rootMember={mockRootMember}
                members={mockDownstreamMembers}
                onConfirm={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const input = screen.getByPlaceholderText(/Type "BadRootLeader" to confirm/i);
        const pruneBtn = screen.getByRole('button', { name: /Prune Entire Branch/i });

        // Lowercase should NOT enable the button (case mismatch)
        await userEvent.type(input, 'badrootleader');
        expect(pruneBtn).toBeDisabled();

        // Exact match should enable the button
        await userEvent.clear(input);
        await userEvent.type(input, 'BadRootLeader');
        expect(pruneBtn).toBeEnabled();
    });

    it('merges accounts balances and separates bad debt write-off from credit confiscation', () => {
        const root: MemberItem = {
            publicKey: 'pk-debtor-root',
            callsign: 'DebtorRoot',
        };
        const child: MemberItem = {
            publicKey: 'pk-credit-child',
            callsign: 'CreditChild',
            invitedBy: 'pk-debtor-root',
        };
        const mockAccounts = [
            { publicKey: 'pk-debtor-root', balance: -250 },
            { publicKey: 'pk-credit-child', balance: 400 },
        ];

        render(
            <PruneBranchModal
                rootMember={root}
                members={[root, child]}
                accounts={mockAccounts}
                onConfirm={vi.fn()}
                onClose={vi.fn()}
            />
        );

        // Debt written off: 250 beans
        const debtEl = document.getElementById('prune-debt-written-off');
        expect(debtEl?.textContent).toBe('250 🫘 bad debt');

        // Surplus credit confiscated: 400 beans
        const creditEl = document.getElementById('prune-credit-confiscated');
        expect(creditEl?.textContent).toBe('400 🫘 credit');

        // Net Commons Pool Impact: +150 🫘
        const netEl = document.getElementById('prune-net-impact');
        expect(netEl?.textContent).toContain('+150 🫘');
    });

    it('guards against dismissal via Escape, backdrop click, or close buttons while pruning is in-flight', async () => {
        const handleClose = vi.fn();
        let resolveConfirm: () => void = () => {};
        const pendingConfirm = new Promise<void>((resolve) => {
            resolveConfirm = resolve;
        });
        const handleConfirm = vi.fn().mockReturnValue(pendingConfirm);

        render(
            <PruneBranchModal
                rootMember={mockRootMember}
                members={mockDownstreamMembers}
                onConfirm={handleConfirm}
                onClose={handleClose}
            />
        );

        // Type to confirm and click prune
        const input = screen.getByPlaceholderText(/Type "BadRootLeader" to confirm/i);
        await userEvent.type(input, 'BadRootLeader');
        const pruneBtn = screen.getByRole('button', { name: /Prune Entire Branch/i });
        await userEvent.click(pruneBtn);

        expect(handleConfirm).toHaveBeenCalled();

        // While pruning is in-flight:
        // 1. Escape key should NOT call onClose
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(handleClose).not.toHaveBeenCalled();

        // 2. Header close button should be disabled
        const closeBtn = screen.getByLabelText(/Close prune branch dialog/i);
        expect(closeBtn).toBeDisabled();
        await userEvent.click(closeBtn);
        expect(handleClose).not.toHaveBeenCalled();

        // 3. Cancel button should be disabled
        const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
        expect(cancelBtn).toBeDisabled();
        await userEvent.click(cancelBtn);
        expect(handleClose).not.toHaveBeenCalled();

        // 4. Backdrop click should NOT call onClose
        const dialog = screen.getByRole('dialog');
        fireEvent.click(dialog);
        expect(handleClose).not.toHaveBeenCalled();

        // Complete the operation
        resolveConfirm();
        await waitFor(() => {
            expect(handleClose).toHaveBeenCalledTimes(1);
        });
    });
});
