import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RekeyMemberWizard, rekeyTimeLeft, rekeyLink, REKEY_PROPOSALS_POLL_MS } from './RekeyMemberWizard';
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
            // Pasting a key is folded away (#1768): the button that opens it shows, the box doesn't.
            expect(screen.getByRole('button', { name: 'Paste a key instead' })).toBeDefined();
            expect(screen.queryByPlaceholderText(/64 hex characters/)).toBeNull();
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

        // Pasting a key is folded away (#1768): opened first.
        expect(screen.queryByPlaceholderText(/64 hex characters/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Paste a key instead' }));
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
        fireEvent.click(screen.getByRole('button', { name: 'Paste a key instead' }));
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

    it('a failed status read keeps Make a re-key code off, and offers Try again (review 4176252099)', async () => {
        const spy = vi.spyOn(nodeClient, 'fetchRekeyStatusApi')
            .mockRejectedValueOnce(new Error('Network down'))
            .mockResolvedValueOnce({ isInvalidated: false, invalidatedInfo: null, pendingRequest: null, history: [] });
        const issueSpy = vi.spyOn(nodeClient, 'issueRekeyCodeApi');
        render(<RekeyMemberWizard member={mockMember} nodeUrl="http://localhost:3000" onClose={() => {}} />);

        await waitFor(() => expect(screen.getByText(/Couldn’t read this member’s re-key status/)).toBeDefined());
        screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb));
        const make = screen.getByRole('button', { name: /Make a re-key code/ }) as HTMLButtonElement;
        expect(make.disabled).toBe(true);
        fireEvent.click(make);
        expect(issueSpy).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
        await waitFor(() => expect(make.disabled).toBe(false));
        expect(spy).toHaveBeenCalledTimes(2);
        expect(screen.queryByText(/Couldn’t read this member’s re-key status/)).toBeNull();
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

describe('RekeyMemberWizard: the phone asks, the admin binds its number (#1768)', () => {
    const member = { publicKey: 'a'.repeat(64), callsign: 'alice', status: 'suspended' };
    const pending = (code = 'RK-AB12-CD34', expiresInMs = 3600000) => ({
        id: 9, code, old_pubkey: member.publicKey, new_pubkey: null, operator_pubkey: 'b'.repeat(64),
        expires_at: new Date(Date.now() + expiresInMs).toISOString(), status: 'pending', created_at: new Date().toISOString(),
    });
    const phone = 'c'.repeat(64);
    const thief = 'd'.repeat(64);

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("an owner's re-key refused for want of a fresh proof shows the node's own sentence, and binds nothing (#1984 confirmation R1)", async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(),
            proposals: [{ newPubkey: phone, proposedAt: new Date().toISOString() }], wrongNumbers: 0, history: [],
        });
        const askCode = 'Enter a current code from your authenticator app (or a backup code) to re-key an owner or admin';
        vi.spyOn(nodeClient, 'bindRekeyByMatchApi').mockRejectedValue(new nodeClient.RekeyBindError(askCode));
        const onSuccess = vi.fn();
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onSuccess={onSuccess} onClose={() => {}} />);
        const box = await screen.findByLabelText('The number on their phone');
        fireEvent.change(box, { target: { value: '47' } });
        fireEvent.click(screen.getByRole('button', { name: 'Bind their phone' }));
        // The error banner (⚠️ and the sentence) holds the sentence as the node wrote it, with no tries counted onto it.
        const said = await screen.findByText((_, el) => el?.tagName === 'DIV' && el.textContent?.trim() === `⚠️ ${askCode}`);
        expect(said).toBeDefined();
        expect(screen.getByTestId('rekey-type-number').textContent).not.toMatch(/Wrong so far/);
        expect(screen.queryByText('Re-Keying Complete!')).toBeNull();
        expect(onSuccess).not.toHaveBeenCalled();
    });

    it('the QR holds the node\'s own address with ?rekey=<code>', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(), proposals: [], history: [],
        });
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        const qr = await screen.findByTestId('rekey-code-qr');
        expect(qr.getAttribute('data-qr-value')).toBe('https://mullum.example.org/?rekey=RK-AB12-CD34');
        expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
        expect(rekeyLink('https://mullum.example.org/', 'RK-AB12-CD34')).toBe('https://mullum.example.org/?rekey=RK-AB12-CD34');
        expect(screen.getByTestId('rekey-scan-help').textContent).toMatch(/An admin gave me a re-key code/);
        expect(screen.queryByText(/can also scan the code on their replacement phone/)).toBeNull();
        expect(screen.getByText(/Waiting for their phone to ask/)).toBeDefined();
    });

    it('cards never show a phone\'s number and have no bind of their own; the typed number binds (review B2)', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(),
            proposals: [
                { newPubkey: thief, proposedAt: new Date().toISOString() },
                { newPubkey: phone, proposedAt: new Date().toISOString() },
            ],
            wrongNumbers: 0,
            history: [],
        });
        const byMatch = vi.spyOn(nodeClient, 'bindRekeyByMatchApi').mockResolvedValue({ success: true, oldPubkey: member.publicKey, newPubkey: phone, callsign: 'alice' });
        const byKey = vi.spyOn(nodeClient, 'completeRekeyApi');
        const onSuccess = vi.fn();
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onSuccess={onSuccess} onClose={() => {}} />);
        const cards = await screen.findAllByTestId('rekey-proposal');
        expect(cards.length).toBe(2);
        expect(cards[1].textContent).toContain(`${phone.slice(0, 6)}…`);
        expect(cards[1].textContent).not.toMatch(/number/);
        // Each card's only button is Not theirs: nothing binds a card by a press.
        for (const card of cards) {
            const buttons = Array.from(card.querySelectorAll('button')).map((el) => el.textContent);
            expect(buttons).toEqual(['Not theirs']);
        }
        expect(screen.queryByRole('button', { name: 'Bind this phone' })).toBeNull();
        const bind = screen.getByRole('button', { name: 'Bind their phone' }) as HTMLButtonElement;
        expect(bind.disabled).toBe(true);
        const box = screen.getByLabelText('The number on their phone');
        fireEvent.change(box, { target: { value: '4a7' } });
        expect((box as HTMLInputElement).value).toBe('47');
        expect(bind.disabled).toBe(false);
        fireEvent.click(bind);
        await waitFor(() => {
            expect(byMatch).toHaveBeenCalledWith('https://mullum.example.org', member.publicKey, 'RK-AB12-CD34', '47', undefined, undefined);
            expect(screen.getByText('Re-Keying Complete!')).toBeDefined();
            expect(onSuccess).toHaveBeenCalledWith(phone);
        });
        expect(byKey).not.toHaveBeenCalled();
    });

    it('a wrong number says so with the tries left and clears the box', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(),
            proposals: [{ newPubkey: phone, proposedAt: new Date().toISOString() }], wrongNumbers: 0, history: [],
        });
        vi.spyOn(nodeClient, 'bindRekeyByMatchApi').mockRejectedValue(
            new nodeClient.RekeyBindError('No phone waiting on this code shows that number. Check the number on their phone and type it again.', 'wrong_number', 1));
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        const box = await screen.findByLabelText('The number on their phone');
        fireEvent.change(box, { target: { value: '12' } });
        fireEvent.click(screen.getByRole('button', { name: 'Bind their phone' }));
        await screen.findByText(/No phone waiting on this code shows that number.*One more wrong number stops this code/);
        expect((box as HTMLInputElement).value).toBe('');
        expect(screen.getByTestId('rekey-type-number').textContent).toMatch(/Wrong so far: 2 of 3/);
        expect(screen.getByText('Re-Key Member (Lost Phone)')).toBeDefined();
        expect(screen.queryByText('Re-Keying Complete!')).toBeNull();
    });

    it('the third wrong number: the code reads as stopped, the QR and cards go, and a new code is offered', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(),
            proposals: [{ newPubkey: phone, proposedAt: new Date().toISOString() }], wrongNumbers: 2, history: [],
        });
        vi.spyOn(nodeClient, 'bindRekeyByMatchApi').mockRejectedValue(
            new nodeClient.RekeyBindError('Three wrong numbers were typed, so this code has stopped. Make a new code with the member there.', 'code_stopped'));
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        expect((await screen.findByTestId('rekey-type-number')).textContent).toMatch(/Wrong so far: 2 of 3/);
        fireEvent.change(screen.getByLabelText('The number on their phone'), { target: { value: '12' } });
        fireEvent.click(screen.getByRole('button', { name: 'Bind their phone' }));
        await waitFor(() => expect(screen.getByTestId('rekey-code-expired').textContent).toMatch(/this code has stopped/));
        expect(screen.queryByTestId('rekey-code-qr')).toBeNull();
        expect(screen.queryByTestId('rekey-proposals')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Make a new code' }));
        await waitFor(() => expect(screen.getByText(/Operator-Assisted Identity Verification/)).toBeDefined());
    });

    it('says when codes like this one are being guessed at, and when phones are turned away (review N3)', async () => {
        const read = vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(), proposals: [], wrongNumbers: 0,
            codeUnderAttack: { wrongTries: 4, refusing: false }, history: [],
        });
        const { unmount } = render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        expect((await screen.findByTestId('rekey-under-attack')).textContent).toMatch(/tried 4 wrong codes like this one/);
        unmount();
        read.mockResolvedValue({
            isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(), proposals: [], wrongNumbers: 0,
            codeUnderAttack: { wrongTries: 10, refusing: true }, history: [],
        });
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        expect((await screen.findByTestId('rekey-under-attack')).textContent).toMatch(/turned away for the rest of the hour.*make a new code/);
    });

    it('says nothing about guessing when the node reports none', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(), proposals: [], wrongNumbers: 0, history: [],
        });
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        await screen.findByTestId('rekey-code-qr');
        expect(screen.queryByTestId('rekey-under-attack')).toBeNull();
    });

    it('Not theirs declines that phone and its card goes', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(),
            proposals: [{ newPubkey: thief, proposedAt: new Date().toISOString() }],
            history: [],
        });
        const decline = vi.spyOn(nodeClient, 'declineRekeyProposalApi').mockResolvedValue({ success: true, declined: true, declines: 1 });
        const complete = vi.spyOn(nodeClient, 'completeRekeyApi');
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Not theirs' }));
        await waitFor(() => expect(decline).toHaveBeenCalledWith('https://mullum.example.org', member.publicKey, thief, undefined, undefined));
        await waitFor(() => expect(screen.queryAllByTestId('rekey-proposal').length).toBe(0));
        expect(complete).not.toHaveBeenCalled();
    });

    it('reads the phones every few seconds while the code shows', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const read = vi.spyOn(nodeClient, 'fetchRekeyStatusApi')
                .mockResolvedValueOnce({ isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(), proposals: [], history: [] })
                .mockResolvedValue({
                    isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(),
                    proposals: [{ newPubkey: phone, proposedAt: new Date().toISOString() }], history: [],
                });
            render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
            await screen.findByText(/Waiting for their phone to ask/);
            await vi.advanceTimersByTimeAsync(REKEY_PROPOSALS_POLL_MS + 10);
            await waitFor(() => expect(screen.getAllByTestId('rekey-proposal').length).toBe(1));
            expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('an expired code hides the QR and offers Make a new code', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
                isInvalidated: true, invalidatedInfo: null, pendingRequest: pending('RK-AB12-CD34', 60_000), proposals: [], history: [],
            });
            render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
            await screen.findByTestId('rekey-code-qr');
            await vi.advanceTimersByTimeAsync(91_000);
            await waitFor(() => expect(screen.queryByTestId('rekey-code-qr')).toBeNull());
            expect(screen.getByTestId('rekey-code-expired')).toBeDefined();
            expect(screen.queryByTestId('rekey-proposals')).toBeNull();
            fireEvent.click(screen.getByRole('button', { name: 'Make a new code' }));
            await waitFor(() => expect(screen.getByText(/Operator-Assisted Identity Verification/)).toBeDefined());
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('RekeyMemberWizard: one try per number, and a code ended elsewhere (#1783 review C2, C3)', () => {
    const member = { publicKey: 'a'.repeat(64), callsign: 'alice', status: 'suspended' };
    const phone = 'c'.repeat(64);
    const pending = () => ({
        id: 9, code: 'RK-AB12-CD34', old_pubkey: member.publicKey, new_pubkey: null, operator_pubkey: 'b'.repeat(64),
        expires_at: new Date(Date.now() + 3600000).toISOString(), status: 'pending', created_at: new Date().toISOString(),
    });
    const live = { isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(), proposals: [{ newPubkey: phone, proposedAt: new Date().toISOString() }], wrongNumbers: 0, history: [] };
    beforeEach(() => { vi.restoreAllMocks(); });
    afterEach(() => { vi.useRealTimers(); });

    it('Enter twice on a wrong number sends it once, so it spends one try', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue(live as any);
        const answers: Array<(e: Error) => void> = [];
        const bind = vi.spyOn(nodeClient, 'bindRekeyByMatchApi').mockImplementation(() => new Promise((_, reject) => { answers.push(reject); }));
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        const box = await screen.findByLabelText('The number on their phone');
        fireEvent.change(box, { target: { value: '12' } });
        fireEvent.keyDown(box, { key: 'Enter' });
        fireEvent.keyDown(box, { key: 'Enter' });
        expect(bind.mock.calls.map((c) => c[3])).toEqual(['12']);
        await act(async () => { answers[0](new nodeClient.RekeyBindError('No phone waiting on this code shows that number.', 'wrong_number', 2)); });
        expect(screen.getByTestId('rekey-type-number').textContent).toContain('Wrong so far: 1 of 3');
        // The answer is in: the next number goes out.
        fireEvent.change(box, { target: { value: '34' } });
        fireEvent.keyDown(box, { key: 'Enter' });
        expect(bind.mock.calls.map((c) => c[3])).toEqual(['12', '34']);
    });

    it('Enter twice on the right number: one bind, and the done page with no error under it', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue(live as any);
        const settle: Array<(v: any) => void> = [];
        const bind = vi.spyOn(nodeClient, 'bindRekeyByMatchApi').mockImplementation(() => new Promise((ok) => { settle.push(ok); }));
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        const box = await screen.findByLabelText('The number on their phone');
        fireEvent.change(box, { target: { value: '47' } });
        fireEvent.keyDown(box, { key: 'Enter' });
        fireEvent.keyDown(box, { key: 'Enter' });
        await act(async () => { settle[0]({ success: true, oldPubkey: member.publicKey, newPubkey: phone, callsign: 'alice', signInCopiesRemoved: 0 }); });
        expect(bind).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Re-Keying Complete!')).toBeTruthy();
        expect(screen.queryByText(/no re-key code waiting/)).toBeNull();
    });

    it('a code stopped on another dashboard: this one drops the QR and says it is no longer active', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const read = vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({ ...live, wrongNumbers: 2 } as any);
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        await screen.findByLabelText('The number on their phone');
        read.mockResolvedValue({ isInvalidated: true, invalidatedInfo: null, pendingRequest: null, proposals: [], wrongNumbers: 0, history: [] } as any);
        await act(async () => { await vi.advanceTimersByTimeAsync(REKEY_PROPOSALS_POLL_MS * 2 + 50); });
        expect(screen.queryByTestId('rekey-code-qr')).toBeNull();
        expect(screen.queryByText(/Waiting for their phone to ask/)).toBeNull();
        expect(screen.getByTestId('rekey-code-expired').textContent).toContain('no longer active');
        expect(screen.getByRole('button', { name: 'Make a new code' })).toBeTruthy();
    });
});

describe('RekeyMemberWizard: this dashboard\'s own cancel, a code replaced elsewhere, a code run out (#1783 review D2, D3, D4)', () => {
    const member = { publicKey: 'a'.repeat(64), callsign: 'alice', status: 'suspended' };
    const phone = 'c'.repeat(64);
    const pending = (code = 'RK-AB12-CD34', expiresInMs = 3600000) => ({
        id: 9, code, old_pubkey: member.publicKey, new_pubkey: null, operator_pubkey: 'b'.repeat(64),
        expires_at: new Date(Date.now() + expiresInMs).toISOString(), status: 'pending', created_at: new Date().toISOString(),
    });
    const live = (code = 'RK-AB12-CD34', key = phone, expiresInMs = 3600000) => ({
        isInvalidated: true, invalidatedInfo: null, pendingRequest: pending(code, expiresInMs),
        proposals: [{ newPubkey: key, proposedAt: new Date().toISOString() }], wrongNumbers: 0, history: [],
    });
    const none = { isInvalidated: true, invalidatedInfo: null, pendingRequest: null, proposals: [], wrongNumbers: 0, history: [] };
    beforeEach(() => { vi.restoreAllMocks(); });
    afterEach(() => { vi.useRealTimers(); });

    it('Cancel here, with a read answered before the cancel: the next code made here is live, not "no longer active"', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const read = vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({ ...live(), wrongNumbers: 1 } as any);
        let finishCancel: (v: any) => void = () => {};
        vi.spyOn(nodeClient, 'cancelRekeyCodeApi').mockImplementation(() => new Promise((ok) => { finishCancel = ok; }));
        vi.spyOn(nodeClient, 'issueRekeyCodeApi').mockResolvedValue({ success: true, code: 'RK-0E01-0001', oldPubkey: member.publicKey, callsign: 'alice', expiresAt: new Date(Date.now() + 86400000).toISOString(), operator: 'b'.repeat(64) } as any);
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        await screen.findByText('RK-AB12-CD34');
        // The node has cancelled; the cancel's answer is still on its way when the page's read comes back.
        read.mockResolvedValue(none as any);
        fireEvent.click(screen.getByRole('button', { name: /Cancel this code/ }));
        await act(async () => { await vi.advanceTimersByTimeAsync(REKEY_PROPOSALS_POLL_MS + 50); });
        expect(screen.queryByTestId('rekey-code-expired')).toBeNull(); // that read was this cancel, not another screen
        await act(async () => { finishCancel({ success: true, cancelled: true, oldPubkey: member.publicKey, callsign: 'alice', status: 'active' }); });
        await screen.findByTestId('rekey-notice');
        read.mockResolvedValue(live('RK-0E01-0001') as any);
        screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb));
        fireEvent.click(screen.getByRole('button', { name: /Make a re-key code/ }));
        await screen.findByText('RK-0E01-0001');
        expect(screen.queryByTestId('rekey-code-expired')).toBeNull();
        expect(screen.getByTestId('rekey-code-qr').getAttribute('data-qr-value')).toBe('https://mullum.example.org/?rekey=RK-0E01-0001');
        await act(async () => { await vi.advanceTimersByTimeAsync(REKEY_PROPOSALS_POLL_MS + 50); });
        expect(screen.getByLabelText('The number on their phone')).toBeTruthy();
        expect(screen.getByTestId('rekey-type-number').textContent).not.toContain('Wrong so far');
    });

    it('a code replaced on another dashboard: no longer active, its QR gone, and the new code\'s phones never show under it', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const read = vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue(live() as any);
        const bind = vi.spyOn(nodeClient, 'bindRekeyByMatchApi');
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        await screen.findByText('RK-AB12-CD34');
        // Another admin made a new code for alice: this one is cancelled; the node's pending code is RK-9999-0000.
        read.mockResolvedValue({ ...live('RK-9999-0000', 'd'.repeat(64)), wrongNumbers: 2, codeUnderAttack: { wrongTries: 9, refusing: false } } as any);
        await act(async () => { await vi.advanceTimersByTimeAsync(REKEY_PROPOSALS_POLL_MS * 2 + 50); });
        expect(screen.queryByTestId('rekey-code-qr')).toBeNull();
        expect(screen.queryAllByTestId('rekey-proposal')).toHaveLength(0);
        expect(screen.queryByLabelText('The number on their phone')).toBeNull();
        expect(screen.queryByTestId('rekey-under-attack')).toBeNull();
        expect(screen.getByTestId('rekey-code-expired').textContent).toContain('a new code for @alice was made on another screen');
        expect(screen.getByText('RK-AB12-CD34')).toBeTruthy(); // this page never takes up the other screen's code
        expect(bind).not.toHaveBeenCalled();
    });

    it('a code made after Issue New Code starts clean: no guessing warning of the code before it (#1783 check, finding 2)', async () => {
        const read = vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({ ...live(), codeUnderAttack: { wrongTries: 6, refusing: false } } as any);
        vi.spyOn(nodeClient, 'issueRekeyCodeApi').mockResolvedValue({ success: true, code: 'RK-0E01-0001', oldPubkey: member.publicKey, callsign: 'alice', expiresAt: new Date(Date.now() + 86400000).toISOString(), operator: 'b'.repeat(64) } as any);
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        expect((await screen.findByTestId('rekey-under-attack')).textContent).toMatch(/tried 6 wrong codes/);
        fireEvent.click(screen.getByRole('button', { name: /Issue New Code/ }));
        // The node's read of the new code never answers here: only making the code may clear the old code's warning.
        read.mockImplementation(() => new Promise(() => {}));
        screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb));
        fireEvent.click(screen.getByRole('button', { name: /Make a re-key code/ }));
        await screen.findByText('RK-0E01-0001');
        expect(screen.getByTestId('rekey-code-qr')).toBeTruthy();
        expect(screen.queryByTestId('rekey-under-attack')).toBeNull();
    });

    it('a code that ran out while the page was open: says it expired, not that it was stopped or cancelled', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const read = vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue(live('RK-AB12-CD34', phone, 2000) as any);
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        await screen.findByText('RK-AB12-CD34');
        await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
        // The node marks it expired and answers no pending code, before this page's 30-second clock moves.
        read.mockResolvedValue(none as any);
        await act(async () => { await vi.advanceTimersByTimeAsync(REKEY_PROPOSALS_POLL_MS + 50); });
        const notice = screen.getByTestId('rekey-code-expired').textContent ?? '';
        expect(notice).toContain('This code has expired');
        expect(notice).not.toContain('stopped or cancelled');
    });

    it('a code gone well before its time is still called stopped or cancelled elsewhere', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const read = vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue(live() as any);
        render(<RekeyMemberWizard member={member} nodeUrl="https://mullum.example.org" onClose={() => {}} />);
        await screen.findByText('RK-AB12-CD34');
        read.mockResolvedValue(none as any);
        await act(async () => { await vi.advanceTimersByTimeAsync(REKEY_PROPOSALS_POLL_MS + 50); });
        expect(screen.getByTestId('rekey-code-expired').textContent).toContain('stopped or cancelled on another screen');
    });
});
