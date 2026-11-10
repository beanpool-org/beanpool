import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PruneBranchModal } from './PruneBranchModal';
import type { MemberItem } from './MembersModule';
import { BranchPruneRefusedError, type BranchPruneFigures } from '../../lib/node-client';

/**
 * The dialog's figures are the node's, for the whole branch (GET /api/local/admin/branches/:pubkey/prune, `loadFigures`):
 * the console's members hold only the pages read so far (capacity fix 3), so the figures were once made from part of the
 * branch. These tests used to hand the dialog a members list and balances and check the sums it made; they now hand it
 * the node's figures for the same branches and check the same numbers, and that Confirm waits for them.
 */
const figuresOf = (f: BranchPruneFigures) => vi.fn().mockResolvedValue(f);

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

    // The branch above as the node counts it: root + 2 children + 1 grandchild, 150.5 + 50.25 + 200 + 75.25 in surplus.
    // The money figures are whole hundredths of a Bean (server branchPrunePreview): 47600 is 476 Beans.
    const branchFigures: BranchPruneFigures = { members: 4, badDebt_c: 0, surplus_c: 47600, net_c: 47600 };
    void mockDownstreamMembers;

    it("shows the node's figures for the branch, and enforces type-to-confirm", async () => {
        const handleConfirm = vi.fn().mockResolvedValue(undefined);
        const handleClose = vi.fn();
        const loadFigures = figuresOf(branchFigures);

        render(
            <PruneBranchModal
                rootMember={mockRootMember}
                loadFigures={loadFigures}
                onConfirm={handleConfirm}
                onClose={handleClose}
            />
        );

        // Header & destructive banner
        expect(screen.getByText('Prune Invite Branch')).toBeInTheDocument();
        expect(screen.getByText('DESTRUCTIVE PROTOCOL ACTION')).toBeInTheDocument();

        // 4 members in branch: root + 2 children + 1 grandchild, as the node counts them
        expect(await screen.findByText('4')).toBeInTheDocument();
        expect(loadFigures).toHaveBeenCalledWith('pk-root-elder-12345678');
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

    it('renders safely with an empty payload without crashing, and reads nothing for no branch', () => {
        const handleConfirm = vi.fn();
        const handleClose = vi.fn();
        const loadFigures = figuresOf(branchFigures);

        render(
            <PruneBranchModal
                rootMember={null}
                loadFigures={loadFigures}
                onConfirm={handleConfirm}
                onClose={handleClose}
            />
        );

        expect(screen.getByText('Prune Invite Branch')).toBeInTheDocument();
        expect(loadFigures).not.toHaveBeenCalled();
        expect(document.getElementById('prune-members-affected')?.textContent).toBe('—');
        expect(screen.getByText('Net Commons Pool Impact:')).toBeInTheDocument();
        expect(document.getElementById('prune-net-impact')?.textContent).toContain('— 🫘');

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

        const loadFigures = figuresOf(branchFigures);
        render(
            <PruneBranchModal
                rootMember={malformedRoot as any}
                loadFigures={loadFigures}
                onConfirm={handleConfirm}
                onClose={handleClose}
            />
        );

        expect(screen.getByText('Prune Invite Branch')).toBeInTheDocument();
        expect(screen.getByText('Unknown Root')).toBeInTheDocument();
        // No key to ask the node about: nothing read, nothing to confirm.
        expect(loadFigures).not.toHaveBeenCalled();
        expect(screen.getByText('Net Commons Pool Impact:')).toBeInTheDocument();
        expect(document.getElementById('prune-net-impact')?.textContent).toContain('— 🫘');
        expect(screen.getByRole('button', { name: /Prune Entire Branch/i })).toBeDisabled();
    });

    it('dismisses via Escape key and Cancel button', async () => {
        const handleClose = vi.fn();

        render(
            <PruneBranchModal
                rootMember={mockRootMember}
                loadFigures={figuresOf(branchFigures)}
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
                loadFigures={figuresOf(branchFigures)}
                onConfirm={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const input = screen.getByPlaceholderText(/Type "BadRootLeader" to confirm/i);
        const pruneBtn = screen.getByRole('button', { name: /Prune Entire Branch/i });
        await screen.findByText('4');

        // Lowercase should NOT enable the button (case mismatch)
        await userEvent.type(input, 'badrootleader');
        expect(pruneBtn).toBeDisabled();

        // Exact match should enable the button
        await userEvent.clear(input);
        await userEvent.type(input, 'BadRootLeader');
        expect(pruneBtn).toBeEnabled();
    });

    it("separates bad debt write-off from credit confiscation, as the node's figures give them", async () => {
        const root: MemberItem = {
            publicKey: 'pk-debtor-root',
            callsign: 'DebtorRoot',
        };
        // A root owing 250 and a child holding 400, as the node works them out.
        render(
            <PruneBranchModal
                rootMember={root}
                loadFigures={figuresOf({ members: 2, badDebt_c: 25000, surplus_c: 40000, net_c: 15000 })}
                onConfirm={vi.fn()}
                onClose={vi.fn()}
            />
        );

        // Debt written off: 250 beans
        await screen.findByText('2');
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
                loadFigures={figuresOf(branchFigures)}
                onConfirm={handleConfirm}
                onClose={handleClose}
            />
        );

        // Type to confirm and click prune
        await screen.findByText('4');
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

    it("while the node's figures load: says so, shows none, and keeps Confirm off even with the name typed", async () => {
        let resolveFigures: (f: BranchPruneFigures) => void = () => {};
        const loadFigures = vi.fn().mockReturnValue(new Promise<BranchPruneFigures>((resolve) => { resolveFigures = resolve; }));
        const handleConfirm = vi.fn().mockResolvedValue(undefined);
        render(<PruneBranchModal rootMember={mockRootMember} loadFigures={loadFigures} onConfirm={handleConfirm} onClose={vi.fn()} />);

        expect(screen.getByTestId('prune-figures-loading')).toHaveTextContent('Reading the whole branch from the node…');
        expect(screen.getByTestId('prune-branch-figures')).toHaveAttribute('aria-busy', 'true');
        expect(document.getElementById('prune-members-affected')?.textContent).toBe('…');
        expect(document.getElementById('prune-net-impact')?.textContent).toContain('… 🫘');
        await userEvent.type(screen.getByPlaceholderText(/Type "BadRootLeader" to confirm/i), 'BadRootLeader');
        const pruneBtn = screen.getByRole('button', { name: /Prune Entire Branch/i });
        expect(pruneBtn).toBeDisabled();
        await userEvent.click(pruneBtn);
        expect(handleConfirm).not.toHaveBeenCalled();

        // Whole hundredths: 30040 is 300.40 Beans, and a net below zero has the true minus.
        resolveFigures({ members: 1_250, badDebt_c: 30040, surplus_c: 1000, net_c: -29040 });
        await waitFor(() => expect(document.getElementById('prune-members-affected')?.textContent).toBe('1250'));
        expect(screen.queryByTestId('prune-figures-loading')).toBeNull();
        expect(document.getElementById('prune-debt-written-off')?.textContent).toBe('300.40 🫘 bad debt');
        expect(document.getElementById('prune-credit-confiscated')?.textContent).toBe('10 🫘 credit');
        expect(document.getElementById('prune-net-impact')?.textContent).toBe('−290.40 🫘');
        expect(pruneBtn).toBeEnabled();
    });

    it('when the node cannot give the figures: says so, keeps Confirm off, and Try again reads them again', async () => {
        const loadFigures = vi.fn()
            .mockRejectedValueOnce(new Error('Only an owner of this node can remove a whole invite branch'))
            .mockResolvedValueOnce(branchFigures);
        const handleConfirm = vi.fn().mockResolvedValue(undefined);
        render(<PruneBranchModal rootMember={mockRootMember} loadFigures={loadFigures} onConfirm={handleConfirm} onClose={vi.fn()} />);

        const failed = await screen.findByTestId('prune-figures-error');
        expect(failed).toHaveTextContent("Couldn't read this branch from the node, so it can't be pruned until its figures are in: Only an owner of this node can remove a whole invite branch");
        expect(document.getElementById('prune-members-affected')?.textContent).toBe('—');
        await userEvent.type(screen.getByPlaceholderText(/Type "BadRootLeader" to confirm/i), 'BadRootLeader');
        const pruneBtn = screen.getByRole('button', { name: /Prune Entire Branch/i });
        expect(pruneBtn).toBeDisabled();
        await userEvent.click(pruneBtn);
        expect(handleConfirm).not.toHaveBeenCalled();

        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('4')).toBeInTheDocument();
        expect(loadFigures).toHaveBeenCalledTimes(2);
        expect(screen.queryByTestId('prune-figures-error')).toBeNull();
        expect(pruneBtn).toBeEnabled();
    });

    it("when the node refuses the prune: shows the node's words, no figures, no Try again, and keeps Confirm off", async () => {
        const words = "Removing a member is the community's vote here. Pause them instead: that opens the vote, and the community decides.";
        const loadFigures = vi.fn().mockRejectedValue(new BranchPruneRefusedError(words, 'removal_is_the_vote'));
        const handleConfirm = vi.fn().mockResolvedValue(undefined);
        render(<PruneBranchModal rootMember={mockRootMember} loadFigures={loadFigures} onConfirm={handleConfirm} onClose={vi.fn()} />);

        const refused = await screen.findByTestId('prune-figures-refused');
        expect(refused).toHaveTextContent(words);
        expect(refused).not.toHaveTextContent("Couldn't read");
        expect(screen.queryByTestId('prune-figures-error')).toBeNull();
        expect(screen.queryByTestId('prune-figures-loading')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
        expect(document.getElementById('prune-members-affected')?.textContent).toBe('—');
        expect(document.getElementById('prune-net-impact')?.textContent).toContain('— 🫘');
        await userEvent.type(screen.getByPlaceholderText(/Type "BadRootLeader" to confirm/i), 'BadRootLeader');
        const pruneBtn = screen.getByRole('button', { name: /Prune Entire Branch/i });
        expect(pruneBtn).toBeDisabled();
        await userEvent.click(pruneBtn);
        expect(handleConfirm).not.toHaveBeenCalled();
        expect(loadFigures).toHaveBeenCalledTimes(1);
    });
});
