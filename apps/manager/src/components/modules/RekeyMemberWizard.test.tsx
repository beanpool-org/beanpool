import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RekeyMemberWizard } from './RekeyMemberWizard';
import * as nodeClient from '../../lib/node-client';

describe('RekeyMemberWizard', () => {
    const mockMember = {
        publicKey: 'a'.repeat(64),
        callsign: 'alice',
        status: 'active',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: false,
            invalidatedInfo: null,
            pendingRequest: null,
            history: [],
        });
    });

    it('renders step 1 with verification checklist', async () => {
        render(
            <RekeyMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onClose={() => {}}
            />
        );

        expect(screen.getByText('Re-Key Member (Lost Phone)')).toBeDefined();
        expect(screen.getByText(/In-person identity confirmed/)).toBeDefined();
        expect(screen.getByText(/Device lost or replaced/)).toBeDefined();
        expect(screen.getByText(/Immediate invalidation/)).toBeDefined();

        const proceedBtn = screen.getByRole('button', { name: /Invalidate Old Key & Issue Code/ });
        expect((proceedBtn as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables proceed button only when all checkboxes are checked', async () => {
        render(
            <RekeyMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onClose={() => {}}
            />
        );

        const checkboxes = screen.getAllByRole('checkbox');
        expect(checkboxes.length).toBe(3);

        fireEvent.click(checkboxes[0]);
        fireEvent.click(checkboxes[1]);
        const proceedBtn = screen.getByRole('button', { name: /Invalidate Old Key & Issue Code/ });
        expect((proceedBtn as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(checkboxes[2]);
        expect((proceedBtn as HTMLButtonElement).disabled).toBe(false);
    });

    it('issues code and advances to step 2', async () => {
        const issueSpy = vi.spyOn(nodeClient, 'issueRekeyCodeApi').mockResolvedValue({
            success: true,
            code: 'RK-1234-5678',
            oldPubkey: mockMember.publicKey,
            callsign: 'alice',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            operator: 'b'.repeat(64),
        });

        render(
            <RekeyMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onClose={() => {}}
            />
        );

        const checkboxes = screen.getAllByRole('checkbox');
        checkboxes.forEach((cb) => fireEvent.click(cb));

        const proceedBtn = screen.getByRole('button', { name: /Invalidate Old Key & Issue Code/ });
        fireEvent.click(proceedBtn);

        await waitFor(() => {
            expect(issueSpy).toHaveBeenCalledWith(
                'http://localhost:3000',
                mockMember.publicKey,
                undefined,
                undefined
            );
            expect(screen.getByText('RK-1234-5678')).toBeDefined();
            expect(screen.getByPlaceholderText(/64 hex characters/)).toBeDefined();
        });
    });

    it('completes rekeying when valid new public key is entered', async () => {
        vi.spyOn(nodeClient, 'issueRekeyCodeApi').mockResolvedValue({
            success: true,
            code: 'RK-1234-5678',
            oldPubkey: mockMember.publicKey,
            callsign: 'alice',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            operator: 'b'.repeat(64),
        });

        const newPk = 'c'.repeat(64);
        const completeSpy = vi.spyOn(nodeClient, 'completeRekeyApi').mockResolvedValue({
            success: true,
            oldPubkey: mockMember.publicKey,
            newPubkey: newPk,
            callsign: 'alice',
        });

        const onSuccess = vi.fn();

        render(
            <RekeyMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onSuccess={onSuccess}
                onClose={() => {}}
            />
        );

        const checkboxes = screen.getAllByRole('checkbox');
        checkboxes.forEach((cb) => fireEvent.click(cb));
        fireEvent.click(screen.getByRole('button', { name: /Invalidate Old Key & Issue Code/ }));

        await waitFor(() => {
            expect(screen.getByText('RK-1234-5678')).toBeDefined();
        });

        const input = screen.getByPlaceholderText(/64 hex characters/);
        fireEvent.change(input, { target: { value: newPk } });

        const completeBtn = screen.getByRole('button', { name: /Complete Re-Keying/ });
        fireEvent.click(completeBtn);

        await waitFor(() => {
            expect(completeSpy).toHaveBeenCalledWith(
                'http://localhost:3000',
                mockMember.publicKey,
                'RK-1234-5678',
                newPk,
                undefined,
                undefined
            );
            expect(screen.getByText('Re-Keying Complete!')).toBeDefined();
            expect(onSuccess).toHaveBeenCalledWith(newPk);
        });
    });
});
