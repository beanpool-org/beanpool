import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemberDetailModal, MemberModalItem, MemberFlag } from './MemberDetailModal';
import * as nodeClient from '../../lib/node-client';

describe('MemberDetailModal', () => {
    const mockMember: MemberModalItem = {
        publicKey: 'pubkey-1234567890-abcdef',
        platform: 'ios',
        standing: 'Citizen',
        vouched_by_pubkey: 'root-pubkey-001',
        joinedAt: '2026-01-01T00:00:00Z',
        lastActiveAt: '2026-08-20T12:00:00Z',
    };

    // Removal by vote S3: the modal asks the node whether its community votes, and which removals wait out their grace
    // window. Unless a test says otherwise, it votes and none does.
    beforeEach(() => {
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(true);
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([]);
    });

    it('renders member details and platform badge', () => {
        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByText('pubkey-1234567890-abcdef...')).toBeInTheDocument();
        expect(screen.getByText('📱 iOS')).toBeInTheDocument();
        expect(screen.getByText('78/100')).toBeInTheDocument();
        expect(screen.getByText('No security alerts or flags recorded for this member')).toBeInTheDocument();
    });

    it('calls onClose when close icon is clicked', async () => {
        const handleClose = vi.fn();
        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onClose={handleClose}
            />
        );

        await userEvent.click(screen.getByText('✕'));
        expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('handles freeze/unfreeze toggle', async () => {
        const handleToggleFreeze = vi.fn();
        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                onToggleFreeze={handleToggleFreeze}
                onClose={vi.fn()}
            />
        );

        await userEvent.click(screen.getByText('🛑 Freeze'));
        expect(handleToggleFreeze).toHaveBeenCalledWith('pubkey-1234567890-abcdef');
    });

    it('handles vouch and operator toggles when provided', async () => {
        const handleToggleVouch = vi.fn();
        const handleToggleOperator = vi.fn();
        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                isVoucher={false}
                isOperator={false}
                onToggleFreeze={vi.fn()}
                onToggleVouch={handleToggleVouch}
                onToggleOperator={handleToggleOperator}
                onClose={vi.fn()}
            />
        );

        await userEvent.click(screen.getByText('🛡️ Promote'));
        expect(handleToggleVouch).toHaveBeenCalledWith('pubkey-1234567890-abcdef', false);

        await userEvent.click(screen.getByText('🏛️ Grant Operator'));
        expect(handleToggleOperator).toHaveBeenCalledWith('pubkey-1234567890-abcdef', false);
    });

    it('handles prune confirmation flow', async () => {
        // Prune is there only where the community has no vote (removal by vote S3).
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(false);
        const handlePrune = vi.fn();
        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onPrune={handlePrune}
                onClose={vi.fn()}
                nodeUrl="https://test-node.local"
            />
        );

        await userEvent.click(await screen.findByText('🗑️ Prune Account'));
        expect(screen.getByText('⚠️ Confirm Permanent Prune / Delete')).toBeInTheDocument();

        await userEvent.click(screen.getByText('Yes, Prune Account'));
        expect(handlePrune).toHaveBeenCalledWith('pubkey-1234567890-abcdef');
    });

    it('renders security flags matching the member pubkey', () => {
        const flags: MemberFlag[] = [
            {
                type: 'SUSPICIOUS_ACTIVITY',
                severity: 'HIGH',
                description: 'Flagged node for pubkey-1234567890-abcdef anomaly',
            },
        ];

        render(
            <MemberDetailModal
                member={mockMember}
                flags={flags}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByText('Security Alerts & Flags (1)')).toBeInTheDocument();
        expect(screen.getByText('SUSPICIOUS_ACTIVITY')).toBeInTheDocument();
        expect(screen.getByText('Flagged node for pubkey-1234567890-abcdef anomaly')).toBeInTheDocument();
    });

    it('renders node role badge and handles grant role', async () => {
        const handleGrantRole = vi.fn().mockResolvedValue(undefined);
        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                nodeRole={null}
                onToggleFreeze={vi.fn()}
                onGrantNodeRole={handleGrantRole}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByText('No Node Role')).toBeInTheDocument();
        await userEvent.click(screen.getByText('⚡ Grant Admin'));
        expect(handleGrantRole).toHaveBeenCalledWith('pubkey-1234567890-abcdef', 'admin');
    });

    it('does not call a newly granted owner the only one when another owner exists (ownerCount 1)', async () => {
        const handleGrantRole = vi.fn().mockResolvedValue(undefined);
        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                nodeRole={null}
                ownerCount={1}
                onToggleFreeze={vi.fn()}
                onGrantNodeRole={handleGrantRole}
                onClose={vi.fn()}
            />
        );

        expect(screen.queryByText(/This is the community's only owner/i)).not.toBeInTheDocument();
        await userEvent.click(screen.getByText('👑 Grant Owner'));
        expect(handleGrantRole).toHaveBeenCalledWith('pubkey-1234567890-abcdef', 'owner');
        // ownerCount 1 is someone else: granting makes two owners, so this member is NOT the only one
        await screen.findByText('Revoke owner');
        expect(screen.queryByText(/This is the community's only owner/i)).not.toBeInTheDocument();
    });

    it('names the only owner after a grant when no other owner exists, and not when the stale list holds another', async () => {
        const handleGrantRole = vi.fn().mockResolvedValue(undefined);
        const others = [{ publicKey: 'pubkey-other-owner', callsign: 'A', nodeRole: 'owner' }];
        const { unmount } = render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                nodeRole={null}
                ownerCount={1}
                members={[...others, { ...mockMember, nodeRole: null }] as any}
                onToggleFreeze={vi.fn()}
                onGrantNodeRole={handleGrantRole}
                onClose={vi.fn()}
            />
        );
        await userEvent.click(screen.getByText('👑 Grant Owner'));
        await screen.findByText('Revoke owner');
        expect(screen.queryByText(/This is the community's only owner/i)).not.toBeInTheDocument();
        unmount();

        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                nodeRole={null}
                ownerCount={0}
                onToggleFreeze={vi.fn()}
                onGrantNodeRole={handleGrantRole}
                onClose={vi.fn()}
            />
        );
        await userEvent.click(screen.getByText('👑 Grant Owner'));
        expect(await screen.findByText("This is the community's only owner. Another owner must be added before this one can step down or be removed.")).toBeInTheDocument();
    });

    it('surfaces last-owner guard when revoking the last owner fails', async () => {
        const handleRevokeRole = vi.fn().mockRejectedValue(new Error('Cannot remove the last owner'));
        render(
            <MemberDetailModal
                member={{ ...mockMember, nodeRole: 'owner' }}
                isFrozen={false}
                nodeRole="owner"
                ownerCount={1}
                onToggleFreeze={vi.fn()}
                onRevokeNodeRole={handleRevokeRole}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByText("This is the community's only owner. Another owner must be added before this one can step down or be removed.")).toBeInTheDocument();
        await userEvent.click(screen.getByText('Revoke owner'));
        expect(handleRevokeRole).toHaveBeenCalledWith('pubkey-1234567890-abcdef', 'owner');
        expect(await screen.findByText(/Cannot remove the last owner/)).toBeInTheDocument();
    });

    it('does not show last-owner notice when there are two owners', () => {
        render(
            <MemberDetailModal
                member={{ ...mockMember, nodeRole: 'owner' }}
                isFrozen={false}
                nodeRole="owner"
                ownerCount={2}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.queryByText(/This is the community's only owner/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Last-owner guard active/i)).not.toBeInTheDocument();
    });

    it('does not show last-owner notice when members list contains two owners', () => {
        const owner2 = { ...mockMember, publicKey: 'pubkey-owner-2', nodeRole: 'owner' };
        render(
            <MemberDetailModal
                member={{ ...mockMember, nodeRole: 'owner' }}
                members={[{ ...mockMember, nodeRole: 'owner' }, owner2]}
                isFrozen={false}
                nodeRole="owner"
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.queryByText(/This is the community's only owner/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Last-owner guard active/i)).not.toBeInTheDocument();
    });

    it("hides role action buttons and shows muted line when an admin views an owner's profile", () => {
        render(
            <MemberDetailModal
                member={{ ...mockMember, nodeRole: 'owner' }}
                isFrozen={false}
                nodeRole="owner"
                viewerRole="admin"
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.queryByText('Revoke owner')).not.toBeInTheDocument();
        expect(screen.queryByText(/Grant Owner/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Grant Admin/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Grant Moderator/i)).not.toBeInTheDocument();
        expect(screen.getByText("Only an owner can change this member's role.")).toBeInTheDocument();
    });

    it("shows only Revoke moderator when an admin views a moderator's profile", () => {
        render(
            <MemberDetailModal
                member={{ ...mockMember, nodeRole: 'moderator' }}
                isFrozen={false}
                nodeRole="moderator"
                viewerRole="admin"
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByText('Revoke moderator')).toBeInTheDocument();
        expect(screen.queryByText(/Grant Moderator/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Grant Owner/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Grant Admin/i)).not.toBeInTheDocument();
        expect(screen.queryByText('Assign role:')).not.toBeInTheDocument();
        expect(screen.queryByText("Only an owner can change this member's role.")).not.toBeInTheDocument();
    });

    it("shows Grant Moderator when an admin views a member with no role", () => {
        render(
            <MemberDetailModal
                member={{ ...mockMember, nodeRole: null }}
                isFrozen={false}
                nodeRole={null}
                viewerRole="admin"
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByText('🛡️ Grant Moderator')).toBeInTheDocument();
        expect(screen.getByText('Assign role:')).toBeInTheDocument();
        expect(screen.queryByText(/Grant Owner/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Grant Admin/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Revoke/i)).not.toBeInTheDocument();
    });

    it("shows role buttons when an owner views an owner's profile with multiple owners", () => {
        render(
            <MemberDetailModal
                member={{ ...mockMember, nodeRole: 'owner' }}
                isFrozen={false}
                nodeRole="owner"
                viewerRole="owner"
                ownerCount={2}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByText('Revoke owner')).toBeInTheDocument();
        expect(screen.getByText('⚡ Grant Admin')).toBeInTheDocument();
        expect(screen.getByText('🛡️ Grant Moderator')).toBeInTheDocument();
        expect(screen.queryByText("Only an owner can change this member's role.")).not.toBeInTheDocument();
    });

    it('forwards accounts to PruneBranchModal and surfaces calculated financial impact', async () => {
        const childMember = {
            publicKey: 'child-pubkey-789',
            callsign: 'ChildMember',
            invitedBy: 'pubkey-1234567890-abcdef',
        };
        const mockAccounts = [
            { publicKey: 'pubkey-1234567890-abcdef', balance: -150 },
            { publicKey: 'child-pubkey-789', balance: 350 },
        ];

        render(
            <MemberDetailModal
                member={mockMember}
                members={[mockMember, childMember]}
                accounts={mockAccounts}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onPruneBranch={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const pruneBranchBtn = screen.getByText('🗑️ Prune Branch');
        expect(pruneBranchBtn).toBeInTheDocument();
        await userEvent.click(pruneBranchBtn);

        // Verify PruneBranchModal opened with accounts passed through
        expect(screen.getByText('Prune Invite Branch')).toBeInTheDocument();
        expect(document.getElementById('prune-debt-written-off')?.textContent).toContain('150 🫘 bad debt');
        expect(document.getElementById('prune-credit-confiscated')?.textContent).toContain('350 🫘 credit');
        expect(document.getElementById('prune-net-impact')?.textContent).toContain('+200 🫘');
    });

    it('opens RekeyMemberWizard when Re-Key button is clicked', async () => {
        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const rekeyBtn = screen.getByText('🔑 Re-Key');
        expect(rekeyBtn).toBeInTheDocument();
        await userEvent.click(rekeyBtn);

        expect(screen.getByText('Re-Key Member (Lost Phone)')).toBeInTheDocument();
        expect(screen.getByText(/In-person identity confirmed/)).toBeInTheDocument();
    });

    it('opens OffboardMemberWizard when Offboard button is clicked', async () => {
        // Offboard is there where the community has no vote, or inside a removal it voted for (removal by vote S3).
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(false);
        vi.spyOn(nodeClient, 'fetchOffboardPreviewApi').mockResolvedValue({
            member: {
                publicKey: mockMember.publicKey || 'pubkey-1234567890-abcdef',
                callsign: 'alice',
                status: 'active',
                joinedAt: '2026-01-01',
            },
            balance: 50,
            commonsBalance: 200,
            costToCommunity: 0,
            projectedCommonsBalance: 250,
            pendingEscrowsCount: 0,
            isSoleOwner: false,
            activeMembers: [],
        });

        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
                nodeUrl="https://test-node.local"
            />
        );

        const offboardBtn = await screen.findByText('🚪 Offboard');
        expect(offboardBtn).toBeInTheDocument();
        await userEvent.click(offboardBtn);

        expect(screen.getByText('Offboard Member')).toBeInTheDocument();
    });

    it('emergency suspension needs a reason members will see, then says the community decides', async () => {
        const suspend = vi.spyOn(nodeClient, 'emergencySuspendMember').mockResolvedValue({
            success: true,
            decision: { id: 'dec-1', closesAt: '2026-09-26T00:00:00.000Z' },
        });
        const onChanged = vi.fn();
        render(
            <MemberDetailModal
                member={{ ...mockMember, status: 'active' }}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
                nodeUrl="https://test-node.local"
                adminPassword="pw"
                onSuspensionChanged={onChanged}
            />
        );

        await userEvent.click(screen.getByText('⏸️ Suspend'));
        const confirm = screen.getByRole('button', { name: 'Suspend now' });
        expect(confirm).toBeDisabled();
        await userEvent.type(screen.getByLabelText('Reason (members will see this)'), 'short');
        expect(confirm).toBeDisabled();
        await userEvent.type(screen.getByLabelText('Reason (members will see this)'), ' but now long enough');
        expect(confirm).not.toBeDisabled();
        await userEvent.click(confirm);

        expect(suspend).toHaveBeenCalledWith('https://test-node.local', 'pubkey-1234567890-abcdef', 'short but now long enough', 'pw', undefined);
        expect(await screen.findByText(/Members now vote on keeping it until/)).toBeInTheDocument();
        expect(screen.getByText('Lift suspension')).toBeInTheDocument();
        expect(onChanged).toHaveBeenCalled();
    });

    // Removal by vote S2: the vote a suspension opens is on removing the member (a node before it answers keep_suspension).
    it('emergency suspension on a node whose suspension opens the vote on removing the member says so', async () => {
        vi.spyOn(nodeClient, 'emergencySuspendMember').mockResolvedValue({
            success: true,
            decision: { id: 'dec-3', closesAt: '2026-09-26T00:00:00.000Z', effect: 'remove_member' },
        });
        render(
            <MemberDetailModal
                member={{ ...mockMember, status: 'active' }}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
                nodeUrl="https://test-node.local"
                adminPassword="pw"
            />
        );
        await userEvent.click(screen.getByText('⏸️ Suspend'));
        await userEvent.type(screen.getByLabelText('Reason (members will see this)'), 'threats at the market, twice');
        await userEvent.click(screen.getByRole('button', { name: 'Suspend now' }));
        expect(await screen.findByText(/^Suspended\. Members now vote until .+ on removing them; if the vote doesn't pass, the suspension lifts by itself\.$/))
            .toBeInTheDocument();
        expect(screen.queryByText(/keeping it/)).toBeNull();
    });

    it('on a node with no formal votes (global), the suspension says when it lifts and mentions no vote', async () => {
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(false);
        vi.spyOn(nodeClient, 'emergencySuspendMember').mockResolvedValue({
            success: true,
            decision: { id: 'dec-2', closesAt: '2026-09-26T00:00:00.000Z', params: { noVote: true } },
        });
        render(
            <MemberDetailModal
                member={{ ...mockMember, status: 'active' }}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
                nodeUrl="https://test-node.local"
                adminPassword="pw"
                onSuspensionChanged={vi.fn()}
            />
        );

        await userEvent.click(screen.getByText('⏸️ Suspend'));
        await userEvent.type(screen.getByLabelText('Reason (members will see this)'), 'a reason members can read');
        await userEvent.click(screen.getByRole('button', { name: 'Suspend now' }));

        expect(await screen.findByText(/^Suspended until .+\. It lifts by itself then, or sooner if you lift it\.$/)).toBeInTheDocument();
        expect(screen.queryByText(/vote/i)).toBeNull();
    });

    it('a suspended member can have the suspension lifted', async () => {
        const lift = vi.spyOn(nodeClient, 'liftMemberSuspension').mockResolvedValue({ success: true });
        render(
            <MemberDetailModal
                member={{ ...mockMember, status: 'disabled' }}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
                nodeUrl="https://test-node.local"
                adminPassword="pw"
            />
        );
        await userEvent.click(screen.getByText('Lift suspension'));
        expect(lift).toHaveBeenCalledWith('https://test-node.local', 'pubkey-1234567890-abcdef', 'pw', undefined);
        expect(await screen.findByText(/Suspension lifted/)).toBeInTheDocument();
    });

    // Removal by vote S3 (scratch/fable-design/DESIGN-removal-by-vote-fable.md §2 rows 1, 5 and 7): where the community votes,
    // removing a member is its vote. The modal offers the suspension (the pause that opens the vote) and never Prune;
    // Offboard only inside a removal the community voted for; the owner's Prune Branch until the branch vote.
    describe('where the community votes', () => {
        const KEY = 'a'.repeat(64);
        const active = { ...mockMember, publicKey: KEY, status: 'active' };
        const removalInGrace = (subject: string): nodeClient.AdminDecisionItem => ({
            id: 'dec-grace', authorPubkey: 'SYSTEM', title: 'Remove alice?', description: 'An admin paused alice.', effect: 'remove_member',
            touches: 'member', status: 'execution_pending_grace', subject, subjectName: 'alice', params: { rule: 2 },
            opensAt: '2026-10-01T00:00:00.000Z', closesAt: '2026-10-08T00:00:00.000Z', gracePeriodEndsAt: '2026-10-15T00:00:00.000Z',
            tally: { totalVoters: 5, electorate: 9, quorumRequired: 3, quorumMet: true, yesWeight: 5, noWeight: 0, supportRatio: 1, thresholdRequired: 0.66 },
        });
        const draw = (extra: Partial<React.ComponentProps<typeof MemberDetailModal>> = {}) => render(
            <MemberDetailModal
                member={active}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onClose={vi.fn()}
                nodeUrl="https://test-node.local"
                adminPassword="pw"
                onPrune={vi.fn()}
                {...extra}
            />
        );

        it('offers no Prune and no Offboard, says the community decides, and keeps the suspension', async () => {
            draw();
            expect(await screen.findByTestId('removal-is-the-vote')).toHaveTextContent(/community's vote/);
            expect(screen.queryByText('🗑️ Prune Account')).toBeNull();
            expect(screen.queryByText('🚪 Offboard')).toBeNull();
            expect(screen.getByText('⏸️ Suspend')).toBeInTheDocument();
        });

        // No vote removes an owner or an admin (the server's §3.8 refusal): suspending one only parks them until its vote closes,
        // so the note says what does work instead (review 4397436971).
        it('for an owner or an admin, says no vote removes one and that an owner takes the role away first', async () => {
            // `isSoleOwner: false`: an owner with other owners. The modal counts an owner nobody says is not alone as the only one.
            for (const role of ['owner', 'admin'] as const) {
                const { unmount } = draw({ nodeRole: role, isSoleOwner: false });
                const note = await screen.findByTestId('removal-is-the-vote');
                expect(note).toHaveTextContent(/^Removing a member is the community's vote here, and no vote removes an owner or admin\. An owner can take that role away first; after that, they are a member like any other, and suspending them opens the vote\.$/);
                unmount();
            }
        });

        // The only owner: the server takes the last owner's role away for no one and suspends them for no one (revokeNodeRole,
        // SOLE_OWNER_SUSPEND_REFUSAL), so neither "an owner can take that role away first" nor "suspending them opens the vote"
        // is true until a second owner is added (RV-S3-W).
        it('for the only owner, says the role cannot be taken away and they cannot be suspended until another owner is added', async () => {
            draw({ nodeRole: 'owner', isSoleOwner: true });
            const note = await screen.findByTestId('removal-is-the-vote');
            expect(note).toHaveTextContent(/^Removing a member is the community's vote here, and no vote removes an owner or admin\. This is the community's only owner, so the role cannot be taken away, and they cannot be suspended, until another owner is added\.$/);
            expect(note).not.toHaveTextContent(/take that role away first/);
        });

        // A key held for a re-key code (RV-S3-W, reviews 4398650630 and the deciding pass on 57082022): the code made them 'suspended',
        // not paused. No vote is open and the page offers no Suspend (it shows Suspended). The members list names no role for them
        // (listNodeRoles reads active members only), so the note cannot tell an owner or admin, or the only owner, from a member and
        // says all of it. Each clause is true of the server: cancelRekeyCode refuses a code that has run out (member-wizards.ts) and
        // adminLiftSuspension refuses while the key is held (decisions-engine.ts, its ranOut branch names a new code, cancelled);
        // adminEmergencySuspend refuses the only owner, a waiting owner included (isSoleOwner counts them: SOLE_OWNER_SUSPEND_REFUSAL).
        describe('for someone suspended with no vote open, usually a key held for a re-key code', () => {
            const held = { ...active, status: 'suspended' };
            const HELD_NOTE = "Removing a member is the community's vote here. They are suspended with no vote open, usually because a re-key code holds their key. "
                + "End that first: cancel the code on Re-Key (if it has run out, make a new code and cancel that), and use Lift suspension if they are still suspended or no code holds their key. "
                + "After that, suspending them opens the vote. No vote removes an owner or admin, and the community's only owner cannot be suspended until another owner is added.";

            it('says no vote is open, what ends the suspension first, and that no vote removes an owner or admin', async () => {
                draw({ member: held, nodeRole: null });
                const note = await screen.findByTestId('removal-is-the-vote');
                expect(note.textContent).toBe(HELD_NOTE);
                expect(note).not.toHaveTextContent(/^Removing a member is the community's vote here\. Suspending them opens it\.$/);
                expect(screen.getByText('⏸️ Suspended')).toBeInTheDocument();
                expect(screen.queryByText('⏸️ Suspend')).toBeNull();
            });

            // A code that has run out: cancelRekeyCode refuses it ("make a new code on Re-Key, then cancel it") and adminLiftSuspension
            // refuses while its hold stands. The two ways out the earlier wording offered are both refused, so neither is offered.
            it('for a code that has run out, names the way out the server allows: a new code on Re-Key, cancelled', async () => {
                draw({ member: held, nodeRole: null });
                const note = await screen.findByTestId('removal-is-the-vote');
                expect(note).toHaveTextContent(/cancel the code on Re-Key \(if it has run out, make a new code and cancel that\)/);
                expect(note).not.toHaveTextContent(/usually because a re-key code waits on their key/);
                expect(note).not.toHaveTextContent(/or use Lift suspension if no code waits/);
            });

            // The only owner whose key waits on a re-key code: the page names no role for them, so the clause is in the note itself.
            // Cancelling the code does not make them suspendable (isSoleOwner counts a waiting owner); the server refuses it.
            it('for the only owner, says they cannot be suspended until another owner is added', async () => {
                draw({ member: held, nodeRole: null });
                expect(await screen.findByTestId('removal-is-the-vote')).toHaveTextContent(/No vote removes an owner or admin, and the community's only owner cannot be suspended until another owner is added\.$/);
            });

            it('does not read a role the node never named: the same words with or without one', async () => {
                for (const [role, sole] of [[null, undefined], ['admin', undefined], ['owner', true], ['owner', false]] as const) {
                    const { unmount } = draw({ member: held, nodeRole: role, isSoleOwner: sole });
                    expect((await screen.findByTestId('removal-is-the-vote')).textContent).toBe(HELD_NOTE);
                    unmount();
                }
            });
        });

        it('inside a removal the community voted for, says Offboard settles their Beans and completes it now', async () => {
            vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([removalInGrace(KEY)]);
            draw();
            expect(await screen.findByTestId('removal-is-the-vote')).toHaveTextContent(/^Removing a member is the community's vote here, and it voted to remove them: Offboard settles their Beans and completes the removal now\.$/);
        });

        it("and the suspension's words for them say the vote can't remove them: it lifts when the vote closes", async () => {
            vi.spyOn(nodeClient, 'emergencySuspendMember').mockResolvedValue({
                success: true,
                decision: { id: 'dec-4', closesAt: '2026-09-26T00:00:00.000Z', effect: 'remove_member', params: { serverRole: 'admin' } },
            });
            draw({ nodeRole: 'admin' });
            await screen.findByTestId('removal-is-the-vote');
            expect(screen.getByText(/^Suspend now: members then vote, but no vote removes an owner or admin, so it lifts when the vote closes\.$/)).toBeInTheDocument();
            await userEvent.click(screen.getByText('⏸️ Suspend'));
            expect(screen.getByText(/Members then vote for 7 days, but no vote removes an owner or admin: the suspension lifts when the vote closes, whatever it decides\.$/))
                .toBeInTheDocument();
            await userEvent.type(screen.getByLabelText('Reason (members will see this)'), 'threats at the market, twice');
            await userEvent.click(screen.getByRole('button', { name: 'Suspend now' }));
            expect(await screen.findByText(/^Suspended until .+\. Members vote on removing them, but no vote removes an owner or admin: the suspension lifts when the vote closes, whatever it decides\.$/))
                .toBeInTheDocument();
            expect(screen.queryByText(/if the vote doesn't pass/)).toBeNull();
        });

        // A pause holds an owner's or admin's role aside, so the members list gives a paused one no role (nodeRole null) while the
        // server still counts it: the page of an admin you paused, opened again, must not promise that the open vote removes
        // them (review 4398466214). The role is in the pause's own vote, which the modal already fetches (params.serverRole).
        describe('for an owner or an admin who is paused', () => {
            const pauseOf = (subject: string, serverRole?: 'owner' | 'admin'): nodeClient.AdminDecisionItem => ({
                ...removalInGrace(subject), id: 'dec-pause', status: 'open', gracePeriodEndsAt: null,
                params: { rule: 2, pausedAt: '2026-10-01T00:00:00.000Z', ...(serverRole ? { serverRole } : {}) },
            });
            const paused = { ...active, status: 'disabled' };

            it('says no vote removes one, as it does for a live owner or admin, and never that suspending them opens it', async () => {
                for (const role of ['owner', 'admin'] as const) {
                    vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([pauseOf(KEY, role)]);
                    const { unmount } = draw({ member: paused, nodeRole: null });
                    const note = await screen.findByTestId('removal-is-the-vote');
                    expect(note).toHaveTextContent(/no vote removes an owner or admin/);
                    expect(note).toHaveTextContent(/An owner can take that role away first/);
                    expect(note).not.toHaveTextContent(/Suspending them opens it/);
                    expect(screen.getByText(/Suspended/)).toBeInTheDocument();
                    unmount();
                }
            });

            it("reads the role from this member's own pause, not another member's", async () => {
                vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([pauseOf('someone-else-pubkey', 'admin')]);
                draw({ member: paused, nodeRole: null });
                expect(await screen.findByTestId('removal-is-the-vote')).toHaveTextContent(/^Removing a member is the community's vote here\. Suspending them opens it\.$/);
            });

            it('a paused member who holds no such role keeps the plain note', async () => {
                vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([pauseOf(KEY)]);
                draw({ member: paused, nodeRole: null });
                expect(await screen.findByTestId('removal-is-the-vote')).toHaveTextContent(/^Removing a member is the community's vote here\. Suspending them opens it\.$/);
            });
        });

        it('for a moderator, a member with a job whom a vote can remove, the suspension opens the vote', async () => {
            draw({ nodeRole: 'moderator' });
            expect(await screen.findByTestId('removal-is-the-vote')).toHaveTextContent(/^Removing a member is the community's vote here\. Suspending them opens it\.$/);
            expect(screen.getByText(/^Suspend now: the community then votes on removing them\.$/)).toBeInTheDocument();
        });

        it('offers Offboard inside a removal the community voted for, and still no Prune', async () => {
            vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([removalInGrace(KEY)]);
            draw();
            expect(await screen.findByText('🚪 Offboard')).toBeInTheDocument();
            expect(screen.queryByText('🗑️ Prune Account')).toBeNull();
        });

        it("someone else's removal in its grace window offers no Offboard here", async () => {
            vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([removalInGrace('someone-else-pubkey')]);
            draw();
            await screen.findByTestId('removal-is-the-vote');
            expect(screen.queryByText('🚪 Offboard')).toBeNull();
        });

        it("keeps the owner's Prune Branch until the branch vote", async () => {
            draw({ members: [active, { publicKey: 'b'.repeat(64), invitedBy: KEY }], onPruneBranch: vi.fn() });
            await screen.findByTestId('removal-is-the-vote');
            expect(screen.getByText('🗑️ Prune Branch')).toBeInTheDocument();
        });

        it('a row under another spelling of a key, no member\'s account, keeps Prune to tidy it away', async () => {
            draw({ member: { ...active, publicKey: KEY.toUpperCase() } });
            expect(await screen.findByText('🗑️ Prune Account')).toBeInTheDocument();
            expect(screen.queryByTestId('removal-is-the-vote')).toBeNull();
        });

        it('with votes off, Prune and Offboard are there as before, and no word of a vote', async () => {
            vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(false);
            draw();
            expect(await screen.findByText('🗑️ Prune Account')).toBeInTheDocument();
            expect(screen.getByText('🚪 Offboard')).toBeInTheDocument();
            expect(screen.queryByTestId('removal-is-the-vote')).toBeNull();
        });
    });
});
