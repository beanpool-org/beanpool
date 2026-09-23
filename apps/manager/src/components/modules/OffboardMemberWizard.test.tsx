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
        });

        // Blocked by WHO is acting, not by anything transient: the button stays reachable and is
        // announced as unavailable, rather than dropping out of the Tab order with its reason.
        const submitBtn = screen.getByRole('button', { name: /Confirm & Prune Member/ }) as HTMLButtonElement;
        expect(submitBtn.disabled).toBe(false);
        expect(submitBtn).toHaveAttribute('aria-disabled', 'true');
        submitBtn.focus();
        expect(document.activeElement).toBe(submitBtn);

        const reason = document.getElementById(submitBtn.getAttribute('aria-describedby') as string);
        expect(reason?.textContent).toMatch(/You cannot gift a departing member's balance to yourself/);
        expect(reason).toBeVisible();

        // And pressing it does nothing at all.
        const executeSpy = vi.spyOn(nodeClient, 'executeOffboardApi');
        fireEvent.click(submitBtn);
        expect(executeSpy).not.toHaveBeenCalled();
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
        });

        // Gated on who is signed in, so it stays focusable and carries its reason.
        const giftRadio = screen.getByLabelText(/Gift to another community member/) as HTMLInputElement;
        expect(giftRadio.disabled).toBe(false);
        expect(giftRadio).toHaveAttribute('aria-disabled', 'true');
        giftRadio.focus();
        expect(document.activeElement).toBe(giftRadio);

        // The reason renders inside the radio's own <label>, so it is already part of the
        // accessible name. An aria-describedby pointing back at it would have a screen reader
        // read the whole sentence a second time as the description (found reviewing #1077).
        const reason = screen.getByText(/Requires signed key-based admin authentication/);
        expect(reason).toBeVisible();
        expect(giftRadio).not.toHaveAttribute('aria-describedby');
        expect(giftRadio).toHaveAccessibleDescription('');

        const accessibleName = giftRadio.closest('label')?.textContent ?? '';
        expect(accessibleName).toMatch(/Requires signed key-based admin authentication/);
        expect(
            accessibleName.match(/Requires signed key-based admin authentication/g)
        ).toHaveLength(1);
        expect(giftRadio).toHaveAccessibleName(/Requires signed key-based admin authentication/);

        // Choosing it is a no-op: the recipient picker never appears.
        fireEvent.click(giftRadio);
        expect(giftRadio.checked).toBe(false);
        expect(screen.queryByText(/Select Recipient Member/)).toBeNull();
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
        });

        const submitBtn = screen.getByRole('button', { name: /Confirm & Prune Member/ }) as HTMLButtonElement;
        expect(submitBtn.disabled).toBe(false);
        expect(submitBtn).toHaveAttribute('aria-disabled', 'true');
        const reason = document.getElementById(submitBtn.getAttribute('aria-describedby') as string);
        expect(reason?.textContent).toMatch(/Sole Owner Protection/);

        const executeSpy = vi.spyOn(nodeClient, 'executeOffboardApi');
        fireEvent.click(submitBtn);
        expect(executeSpy).not.toHaveBeenCalled();
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

    it('disables gifting and explains when no other active members exist', async () => {
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
            activeMembers: [], // Departing member is only active member
        });

        render(
            <OffboardMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                hasKeyAuth={true}
                onClose={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('+100.00 Beans')).toBeDefined();
            const giftRadio = screen.getByLabelText(/Gift to another community member/) as HTMLInputElement;
            expect(giftRadio).toHaveAttribute('aria-disabled', 'true');
            expect(screen.getByText(/No other active members available to receive a gift/)).toBeDefined();
            expect(screen.queryByLabelText(/Select Recipient Member/)).toBeNull();
            // Same reason, same place: inside the label, so announced once through the name.
            expect(giftRadio).not.toHaveAttribute('aria-describedby');
            expect(giftRadio).toHaveAccessibleDescription('');
            expect(giftRadio).toHaveAccessibleName(/No other active members available to receive a gift/);
        });
    });

    // Busy is transient: it says nothing worth reading and clears by itself, so it keeps the native
    // `disabled` that takes the button out of the Tab order while the request is in flight.
    it('leaves the confirm button natively disabled while it is saving', async () => {
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

        let release: (value: nodeClient.OffboardResponse) => void = () => {};
        vi.spyOn(nodeClient, 'executeOffboardApi').mockImplementation(
            () => new Promise<nodeClient.OffboardResponse>((resolve) => { release = resolve; })
        );

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

        const submitBtn = screen.getByRole('button', { name: /Confirm & Prune Member/ }) as HTMLButtonElement;
        // Nothing blocks it, so nothing is announced as unavailable.
        expect(submitBtn).not.toHaveAttribute('aria-disabled');

        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Offboarding/ })).toBeDisabled();
        });
        expect(screen.getByRole('button', { name: /Offboarding/ })).not.toHaveAttribute('aria-disabled');

        release({
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
