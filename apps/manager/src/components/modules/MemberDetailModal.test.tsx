import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MemberDetailModal, MemberModalItem, MemberFlag } from './MemberDetailModal';

describe('MemberDetailModal', () => {
    const mockMember: MemberModalItem = {
        publicKey: 'pubkey-12345678901234567890',
        platform: 'ios',
        standing: 'Citizen',
        vouched_by_pubkey: 'genesis-root-key',
        joinedAt: '2026-01-01T00:00:00Z',
        lastActiveAt: '2026-02-01T00:00:00Z'
    };

    it('renders member details, platform badge, and handles close', async () => {
        const handleClose = vi.fn();
        const handleToggleFreeze = vi.fn();

        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                onToggleFreeze={handleToggleFreeze}
                onClose={handleClose}
            />
        );

        expect(screen.getByText('Pubkey Member')).toBeInTheDocument();
        expect(screen.getByText('📱 iOS')).toBeInTheDocument();
        expect(screen.getByText('pubkey-12345678901234567...')).toBeInTheDocument();

        const closeBtn = screen.getByRole('button', { name: '✕' });
        await userEvent.click(closeBtn);
        expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('handles toggle freeze, vouch, and operator callbacks', async () => {
        const handleToggleFreeze = vi.fn();
        const handleToggleVouch = vi.fn();
        const handleToggleOperator = vi.fn();

        render(
            <MemberDetailModal
                member={mockMember}
                isFrozen={false}
                isVoucher={false}
                isOperator={false}
                onToggleFreeze={handleToggleFreeze}
                onToggleVouch={handleToggleVouch}
                onToggleOperator={handleToggleOperator}
                onClose={vi.fn()}
            />
        );

        const promoteBtn = screen.getByRole('button', { name: '🛡️ Promote' });
        await userEvent.click(promoteBtn);
        expect(handleToggleVouch).toHaveBeenCalledWith('pubkey-12345678901234567890', false);

        const operatorBtn = screen.getByRole('button', { name: /Grant Operator/i });
        await userEvent.click(operatorBtn);
        expect(handleToggleOperator).toHaveBeenCalledWith('pubkey-12345678901234567890', false);

        const freezeBtn = screen.getByRole('button', { name: '🛑 Freeze' });
        await userEvent.click(freezeBtn);
        expect(handleToggleFreeze).toHaveBeenCalledWith('pubkey-12345678901234567890');
    });

    it('shows prune confirmation and triggers onPrune', async () => {
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

        const pruneBtn = screen.getByRole('button', { name: '🗑️ Prune Account' });
        await userEvent.click(pruneBtn);

        expect(screen.getByText('⚠️ Confirm Permanent Prune / Delete')).toBeInTheDocument();

        const confirmPruneBtn = screen.getByRole('button', { name: 'Yes, Prune Account' });
        await userEvent.click(confirmPruneBtn);

        expect(handlePrune).toHaveBeenCalledWith('pubkey-12345678901234567890');
    });

    it('displays active security flags when member is flagged', () => {
        const flags: MemberFlag[] = [
            {
                type: 'SUSPICIOUS_ACTIVITY',
                description: 'pubkey-12345678901234567890 flagged for wash trading',
                severity: 'CRITICAL'
            }
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
        expect(screen.getByText('pubkey-12345678901234567890 flagged for wash trading')).toBeInTheDocument();
    });
});
