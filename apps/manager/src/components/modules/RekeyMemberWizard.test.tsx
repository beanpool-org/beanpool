import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RekeyMemberWizard, rekeyTimeLeft } from './RekeyMemberWizard';
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

        const proceedBtn = screen.getByRole('button', { name: /Make a re-key code/ });
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

        await waitFor(() => expect(screen.getByText(/Nothing changes until you press Make a re-key code/)).toBeDefined());
        const checkboxes = screen.getAllByRole('checkbox');
        expect(checkboxes.length).toBe(3);

        fireEvent.click(checkboxes[0]);
        fireEvent.click(checkboxes[1]);
        const proceedBtn = screen.getByRole('button', { name: /Make a re-key code/ });
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

        await waitFor(() => expect(screen.getByText(/Nothing changes until you press Make a re-key code/)).toBeDefined());
        const checkboxes = screen.getAllByRole('checkbox');
        checkboxes.forEach((cb) => fireEvent.click(cb));

        const proceedBtn = screen.getByRole('button', { name: /Make a re-key code/ });
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
            expect(screen.getByText(/Trades with other villages will need re-linking/)).toBeDefined();
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

        await waitFor(() => expect(screen.getByText(/Nothing changes until you press Make a re-key code/)).toBeDefined());
        const checkboxes = screen.getAllByRole('checkbox');
        checkboxes.forEach((cb) => fireEvent.click(cb));
        fireEvent.click(screen.getByRole('button', { name: /Make a re-key code/ }));

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

    it('does not auto-advance to step 2 if pending request is expired', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true,
            invalidatedInfo: null,
            pendingRequest: {
                id: 1,
                code: 'RK-OLD-CODE',
                old_pubkey: mockMember.publicKey,
                new_pubkey: null,
                operator_pubkey: 'b'.repeat(64),
                expires_at: new Date(Date.now() - 3600000).toISOString(),
                status: 'pending',
                created_at: new Date(Date.now() - 90000000).toISOString(),
            },
            history: [],
        });

        render(
            <RekeyMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onClose={() => {}}
            />
        );

        // Stays on step 1
        await waitFor(() => {
            expect(screen.getByText(/Operator-Assisted Identity Verification/)).toBeDefined();
            expect(screen.queryByText('RK-OLD-CODE')).toBeNull();
        });
    });

    it('allows returning to step 1 via Issue New Code button', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true,
            invalidatedInfo: null,
            pendingRequest: {
                id: 2,
                code: 'RK-ACTIVE-CODE',
                old_pubkey: mockMember.publicKey,
                new_pubkey: null,
                operator_pubkey: 'b'.repeat(64),
                expires_at: new Date(Date.now() + 3600000).toISOString(),
                status: 'pending',
                created_at: new Date().toISOString(),
            },
            history: [],
        });

        render(
            <RekeyMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onClose={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('RK-ACTIVE-CODE')).toBeDefined();
        });

        const issueNewBtn = screen.getByRole('button', { name: /Issue New Code/ });
        fireEvent.click(issueNewBtn);

        await waitFor(() => {
            expect(screen.getByText(/Operator-Assisted Identity Verification/)).toBeDefined();
            expect(screen.queryByText('RK-ACTIVE-CODE')).toBeNull();
        });
    });

    it('asks for Manage again when the node holds the code back, and shows it on the re-read (#1534)', async () => {
        const pending = {
            id: 3,
            old_pubkey: mockMember.publicKey,
            new_pubkey: null,
            operator_pubkey: 'b'.repeat(64),
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            status: 'pending',
            created_at: new Date().toISOString(),
        };
        const spy = vi.spyOn(nodeClient, 'fetchRekeyStatusApi')
            .mockResolvedValueOnce({ isInvalidated: true, invalidatedInfo: null, pendingRequest: { ...pending, codeNeedsStepUp: true }, history: [] })
            .mockResolvedValueOnce({ isInvalidated: true, invalidatedInfo: null, pendingRequest: { ...pending, code: 'RK-AFTER-STEPUP' }, history: [] });

        render(
            <RekeyMemberWizard
                member={mockMember}
                nodeUrl="http://localhost:3000"
                onClose={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByTestId('rekey-code-needs-step-up')).toBeDefined();
            expect(screen.getByText(/Press Manage in the BeanPool app again/)).toBeDefined();
        });
        expect(screen.queryByText('RK-AFTER-STEPUP')).toBeNull();
        fireEvent.change(screen.getByPlaceholderText(/64 hex characters/), { target: { value: 'c'.repeat(64) } });
        expect((screen.getByRole('button', { name: /Complete Re-Keying/ }) as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: /Show the code/ }));
        await waitFor(() => {
            expect(screen.getByText('RK-AFTER-STEPUP')).toBeDefined();
            expect(screen.queryByTestId('rekey-code-needs-step-up')).toBeNull();
        });
        expect(spy).toHaveBeenCalledTimes(2);
        expect((screen.getByRole('button', { name: /Complete Re-Keying/ }) as HTMLButtonElement).disabled).toBe(false);
    });
it('opening the wizard makes no code: it only reads the status (queue item 22)', async () => {
        const issueSpy = vi.spyOn(nodeClient, 'issueRekeyCodeApi');
        const { unmount } = render(
            <RekeyMemberWizard member={mockMember} nodeUrl="http://localhost:3000" onClose={() => {}} />
        );
        await waitFor(() => expect(screen.getByText(/Nothing changes until you press Make a re-key code/)).toBeDefined());
        unmount();
        expect(nodeClient.fetchRekeyStatusApi).toHaveBeenCalledTimes(1);
        expect(issueSpy).not.toHaveBeenCalled();
    });

    it('keeps Make a re-key code off until the status read has answered', async () => {
        let answer: (v: any) => void = () => {};
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockReturnValue(new Promise((r) => { answer = r; }));
        render(<RekeyMemberWizard member={mockMember} nodeUrl="http://localhost:3000" onClose={() => {}} />);
        screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb));
        const make = screen.getByRole('button', { name: /Make a re-key code/ }) as HTMLButtonElement;
        expect(make.disabled).toBe(true);
        expect(screen.getByText(/Checking this member’s re-key status/)).toBeDefined();
        answer({ isInvalidated: false, invalidatedInfo: null, pendingRequest: null, history: [] });
        await waitFor(() => expect(make.disabled).toBe(false));
    });

    it('a member who already moved opens on "Already moved" and needs the typed words before a new code', async () => {
        const movedAt = '2026-10-04T03:00:00.000Z';
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: false,
            invalidatedInfo: null,
            pendingRequest: null,
            history: [{
                id: 9, old_pubkey: 'f'.repeat(64), new_pubkey: mockMember.publicKey, reenrollment_code: '',
                operator_pubkey: 'b'.repeat(64), performed_at: movedAt, completed_at: movedAt, details: null,
            }],
        });
        const issueSpy = vi.spyOn(nodeClient, 'issueRekeyCodeApi').mockResolvedValue({
            success: true, code: 'RK-AGAIN-0001', oldPubkey: mockMember.publicKey, callsign: 'alice',
            expiresAt: new Date(Date.now() + 86400000).toISOString(), operator: 'b'.repeat(64),
        });
        render(<RekeyMemberWizard member={mockMember} nodeUrl="http://localhost:3000" onClose={() => {}} />);

        await waitFor(() => expect(screen.getByTestId('rekey-already-moved')).toBeDefined());
        expect(screen.getByText(`Already moved to ${'a'.repeat(10)}… on ${new Date(movedAt).toLocaleDateString()}`)).toBeDefined();
        expect(screen.getByText(/This is the key @alice moved to/)).toBeDefined();

        screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb));
        const make = screen.getByRole('button', { name: /Make a re-key code/ }) as HTMLButtonElement;
        expect(make.disabled).toBe(true);
        fireEvent.click(make);
        expect(issueSpy).not.toHaveBeenCalled();

        const typed = screen.getByLabelText(/Type NEW CODE to make a new code/);
        fireEvent.change(typed, { target: { value: 'new cod' } });
        expect(make.disabled).toBe(true);
        fireEvent.change(typed, { target: { value: 'new code' } });
        expect(make.disabled).toBe(false);
        fireEvent.click(make);
        await waitFor(() => expect(screen.getByText('RK-AGAIN-0001')).toBeDefined());
        expect(issueSpy).toHaveBeenCalledTimes(1);
    });

    it('shows a pending code with its time left and cancels it', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true,
            invalidatedInfo: null,
            pendingRequest: {
                id: 4, code: 'RK-WAIT-0001', old_pubkey: mockMember.publicKey, new_pubkey: null, operator_pubkey: 'b'.repeat(64),
                expires_at: new Date(Date.now() + (5 * 60 + 12) * 60000 + 30000).toISOString(), status: 'pending', created_at: new Date().toISOString(),
            },
            history: [],
        });
        const cancelSpy = vi.spyOn(nodeClient, 'cancelRekeyCodeApi').mockResolvedValue({
            success: true, cancelled: true, oldPubkey: mockMember.publicKey, callsign: 'alice', status: 'active',
        });
        const issueSpy = vi.spyOn(nodeClient, 'issueRekeyCodeApi');
        render(<RekeyMemberWizard member={mockMember} nodeUrl="http://localhost:3000" adminPassword="pw" tfaToken="t" onClose={() => {}} />);

        await waitFor(() => expect(screen.getByText('RK-WAIT-0001')).toBeDefined());
        expect(screen.getByText(/5 h 12 min left/)).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: /Cancel this code/ }));

        await waitFor(() => expect(screen.getByTestId('rekey-notice').textContent).toMatch(/Code cancelled\. @alice's key works again; their status is active\./));
        expect(cancelSpy).toHaveBeenCalledWith('http://localhost:3000', mockMember.publicKey, 'pw', 't');
        expect(screen.queryByText('RK-WAIT-0001')).toBeNull();
        expect(screen.getAllByRole('checkbox').every((cb) => !(cb as HTMLInputElement).checked)).toBe(true);
        expect(issueSpy).not.toHaveBeenCalled();
    });

    it('says why a cancel was refused', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true,
            invalidatedInfo: null,
            pendingRequest: {
                id: 5, code: 'RK-WAIT-0002', old_pubkey: mockMember.publicKey, new_pubkey: null, operator_pubkey: 'b'.repeat(64),
                expires_at: new Date(Date.now() + 3600000).toISOString(), status: 'pending', created_at: new Date().toISOString(),
            },
            history: [],
        });
        vi.spyOn(nodeClient, 'cancelRekeyCodeApi').mockRejectedValue(new Error('Only an owner can re-key an owner or admin'));
        render(<RekeyMemberWizard member={mockMember} nodeUrl="http://localhost:3000" onClose={() => {}} />);
        await waitFor(() => expect(screen.getByText('RK-WAIT-0002')).toBeDefined());
        fireEvent.click(screen.getByRole('button', { name: /Cancel this code/ }));
        await waitFor(() => expect(screen.getByText(/Only an owner can re-key an owner or admin/)).toBeDefined());
        expect(screen.getByText('RK-WAIT-0002')).toBeDefined();
    });

    it('words the time left', () => {
        const t0 = Date.parse('2026-10-04T00:00:00.000Z');
        expect(rekeyTimeLeft('2026-10-04T05:12:30.000Z', t0)).toBe('5 h 12 min left');
        expect(rekeyTimeLeft('2026-10-04T00:12:00.000Z', t0)).toBe('12 min left');
        expect(rekeyTimeLeft('2026-10-04T00:00:20.000Z', t0)).toBe('1 min left');
        expect(rekeyTimeLeft('2026-10-03T23:59:00.000Z', t0)).toBe('Expired');
    });
});
