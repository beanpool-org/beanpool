import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MemberDetailModal, MemberModalItem, MemberFlag } from './MemberDetailModal';

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
});
