import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OffboardMemberWizard } from './OffboardMemberWizard';
import * as nodeClient from '../../lib/node-client';

describe('OffboardMemberWizard', () => {
    const mockMember = {
        publicKey: 'a'.repeat(64),
        callsign: 'dave',
        status: 'active',
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders positive balance options: donation vs gifting', async () => {
        vi.spyOn(nodeClient, 'fetchOffboardPreviewApi').mockResolvedValue({
            member: {
                publicKey: mockMember.publicKey,
                callsign: 'dave',
                status: 'active',
                joinedAt: '2026-01-01',
            },
            balance: 150,
            commonsBalance: 500,
            costToCommunity: 0,
            projectedCommonsBalance: 650,
            pendingEscrowsCount: 0,
            isSoleOwner: false,
            activeMembers: [
                { publicKey: 'b'.repeat(64), callsign: 'bob' },
                { publicKey: 'c'.repeat(64), callsign: 'carol' },
            ],
        });

        render(
            <OffboardMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onClose={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('+150.00 Beans')).toBeDefined();
            expect(screen.getByText('Donate to the Commons Pool')).toBeDefined();
            expect(screen.getByText('Gift to another community member')).toBeDefined();
        });
    });

    it('enforces two-person rule when actor attempts to gift balance to themselves', async () => {
        const adminPk = 'b'.repeat(64);
        vi.spyOn(nodeClient, 'fetchOffboardPreviewApi').mockResolvedValue({
            member: {
                publicKey: mockMember.publicKey,
                callsign: 'dave',
                status: 'active',
                joinedAt: '2026-01-01',
            },
            balance: 200,
            commonsBalance: 500,
            costToCommunity: 0,
            projectedCommonsBalance: 700,
            pendingEscrowsCount: 0,
            isSoleOwner: false,
            activeMembers: [
                { publicKey: adminPk, callsign: 'admin-bob' },
                { publicKey: 'c'.repeat(64), callsign: 'carol' },
            ],
        });

        render(
            <OffboardMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                hasKeyAuth={true}
                currentAdminPubkey={adminPk}
                onClose={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('+200.00 Beans')).toBeDefined();
        });

        const giftRadio = screen.getByLabelText(/Gift to another community member/);
        fireEvent.click(giftRadio);

        await waitFor(() => {
            expect(screen.getByText(/Two-Person Rule Violation/)).toBeDefined();
            const submitBtn = screen.getByRole('button', { name: /Confirm & Prune Member/ });
            expect((submitBtn as HTMLButtonElement).disabled).toBe(true);
        });
    });

    it('disables gifting to member under password-only authentication', async () => {
        vi.spyOn(nodeClient, 'fetchOffboardPreviewApi').mockResolvedValue({
            member: {
                publicKey: mockMember.publicKey,
                callsign: 'dave',
                status: 'active',
                joinedAt: '2026-01-01',
            },
            balance: 100,
            commonsBalance: 500,
            costToCommunity: 0,
            projectedCommonsBalance: 600,
            pendingEscrowsCount: 0,
            isSoleOwner: false,
            activeMembers: [
                { publicKey: 'b'.repeat(64), callsign: 'bob' },
            ],
        });

        render(
            <OffboardMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                hasKeyAuth={false}
                onClose={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('+100.00 Beans')).toBeDefined();
            const giftRadio = screen.getByLabelText(/Gift to another community member/) as HTMLInputElement;
            expect(giftRadio.disabled).toBe(true);
            expect(screen.getByText(/Requires signed key-based admin authentication/)).toBeDefined();
        });
    });

    it('displays cost to community for negative debt write-off', async () => {
        vi.spyOn(nodeClient, 'fetchOffboardPreviewApi').mockResolvedValue({
            member: {
                publicKey: mockMember.publicKey,
                callsign: 'dave',
                status: 'active',
                joinedAt: '2026-01-01',
            },
            balance: -180,
            commonsBalance: 300,
            costToCommunity: 180,
            projectedCommonsBalance: 120,
            pendingEscrowsCount: 0,
            isSoleOwner: false,
            activeMembers: [],
        });

        const executeSpy = vi.spyOn(nodeClient, 'executeOffboardApi').mockResolvedValue({
            success: true,
            memberPubkey: mockMember.publicKey,
            callsign: 'dave',
            resolution: 'write_off_commons',
            balanceSettled: -180,
        });

        const onSuccess = vi.fn();

        render(
            <OffboardMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onSuccess={onSuccess}
                onClose={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('-180.00 Beans')).toBeDefined();
            expect(screen.getByText(/Cost to Community/)).toBeDefined();
            expect(screen.getByText(/300.00 → 120.00 Beans/)).toBeDefined();
        });

        const submitBtn = screen.getByRole('button', { name: /Confirm & Prune Member/ });
        expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(executeSpy).toHaveBeenCalledWith(
                'http://localhost:3000',
                mockMember.publicKey,
                { resolution: 'write_off_commons', giftRecipientPubkey: undefined },
                undefined,
                undefined
            );
            expect(screen.getByText('Member Offboarded')).toBeDefined();
            expect(onSuccess).toHaveBeenCalled();
        });
    });

    it('disables offboarding for sole node owner', async () => {
        vi.spyOn(nodeClient, 'fetchOffboardPreviewApi').mockResolvedValue({
            member: {
                publicKey: mockMember.publicKey,
                callsign: 'dave',
                status: 'active',
                joinedAt: '2026-01-01',
            },
            balance: 0,
            commonsBalance: 500,
            costToCommunity: 0,
            projectedCommonsBalance: 500,
            pendingEscrowsCount: 0,
            isSoleOwner: true,
            activeMembers: [],
        });

        render(
            <OffboardMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onClose={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText(/Sole Owner Protection/)).toBeDefined();
            const submitBtn = screen.getByRole('button', { name: /Confirm & Prune Member/ });
            expect((submitBtn as HTMLButtonElement).disabled).toBe(true);
        });
    });

    it('prevents double-click race condition on confirm button', async () => {
        vi.spyOn(nodeClient, 'fetchOffboardPreviewApi').mockResolvedValue({
            member: {
                publicKey: mockMember.publicKey,
                callsign: 'dave',
                status: 'active',
                joinedAt: '2026-01-01',
            },
            balance: 0,
            commonsBalance: 500,
            costToCommunity: 0,
            projectedCommonsBalance: 500,
            pendingEscrowsCount: 0,
            isSoleOwner: false,
            activeMembers: [],
        });

        let resolveOffboard: (val: any) => void;
        const offboardPromise = new Promise((resolve) => {
            resolveOffboard = resolve;
        });
        const executeSpy = vi.spyOn(nodeClient, 'executeOffboardApi').mockImplementation(() => offboardPromise as any);

        render(
            <OffboardMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onClose={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Confirm & Prune Member/ })).toBeDefined();
        });

        const submitBtn = screen.getByRole('button', { name: /Confirm & Prune Member/ });
        // Rapid double click
        fireEvent.click(submitBtn);
        fireEvent.click(submitBtn);

        expect(executeSpy).toHaveBeenCalledTimes(1);

        resolveOffboard!({
            success: true,
            memberPubkey: mockMember.publicKey,
            callsign: 'dave',
            resolution: 'prune_zero_balance',
            balanceSettled: 0,
        });

        await waitFor(() => {
            expect(screen.getByText('Member Offboarded')).toBeDefined();
        });
    });
});
