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
        // Total balance: 150.5 + 50.25 + 200 + 75.25 = 476 beans
        expect(screen.getByText(/476 beans/i)).toBeInTheDocument();

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
        expect(screen.getByText(/0 beans/i)).toBeInTheDocument();

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
        expect(screen.getByText(/0 beans/i)).toBeInTheDocument();
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
});
