import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
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
        const handlePrune = vi.fn();
        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                onToggleFreeze={vi.fn()}
                onPrune={handlePrune}
                onClose={vi.fn()}
            />
        );

        await userEvent.click(screen.getByText('🗑️ Prune Account'));
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

    it('surfaces last-owner guard when revoking the last owner fails', async () => {
        const handleRevokeRole = vi.fn().mockRejectedValue(new Error('Cannot remove the last owner'));
        render(
            <MemberDetailModal
                member={{ ...mockMember, nodeRole: 'owner' }}
                isFrozen={false}
                nodeRole="owner"
                onToggleFreeze={vi.fn()}
                onRevokeNodeRole={handleRevokeRole}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByText('Last-owner guard active:')).toBeInTheDocument();
        await userEvent.click(screen.getByText('Revoke owner'));
        expect(handleRevokeRole).toHaveBeenCalledWith('pubkey-1234567890-abcdef', 'owner');
        expect(await screen.findByText(/Cannot remove the last owner/)).toBeInTheDocument();
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
            />
        );

        const offboardBtn = screen.getByText('🚪 Offboard');
        expect(offboardBtn).toBeInTheDocument();
        await userEvent.click(offboardBtn);

        expect(screen.getByText('Offboard Member')).toBeInTheDocument();
    });
});
