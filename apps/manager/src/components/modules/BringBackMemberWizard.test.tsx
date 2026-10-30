import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BringBackMemberWizard, BRING_BACK_WORDS, ONLY_IN_PERSON, REKEY_INSTEAD_WORDS } from './BringBackMemberWizard';
import * as nodeClient from '../../lib/node-client';

/** Bring back beside Re-Key (vault rethink VR3): the admin's window, against a mocked node client. */
describe('BringBackMemberWizard', () => {
    const member = { publicKey: 'a'.repeat(64), callsign: 'alice' };
    const base = { isInvalidated: false, invalidatedInfo: null, pendingRequest: null, history: [] };

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('a member who keeps a copy here: "yes", the two ways side by side, and a code only after the in-person tick', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({ ...base, communityCopy: { kept: true, since: '2026-10-05T00:00:00.000Z' }, bringBacks: [] });
        const issue = vi.spyOn(nodeClient, 'issueBringBackCodeApi').mockResolvedValue({
            success: true, code: 'BB-1234-5678', oldPubkey: member.publicKey, callsign: 'alice', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), operator: 'b'.repeat(64),
        });
        render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onClose={() => {}} />);
        expect(await screen.findByText(BRING_BACK_WORDS)).toBeDefined();
        expect(screen.getByText(REKEY_INSTEAD_WORDS)).toBeDefined();
        expect(screen.getByTestId('bring-back-can').textContent).toMatch(/Can be brought back by this community: yes/);
        const make = screen.getByTestId('bring-back-make-code') as HTMLButtonElement;
        expect(make.disabled).toBe(true);
        fireEvent.click(screen.getByTestId('bring-back-checked'));
        expect(make.disabled).toBe(false);
        fireEvent.click(make);
        expect((await screen.findByTestId('bring-back-code')).textContent).toBe('BB-1234-5678');
        expect(issue).toHaveBeenCalledWith('http://localhost:3000', member.publicKey, undefined, undefined);
        expect(screen.getByTestId('bring-back-in-person').textContent).toBe(ONLY_IN_PERSON);
    });

    it('the number typed brings them back; a node that did not say so is never reported done', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            ...base,
            pendingRequest: { id: 1, code: 'BB-1234-5678', kind: 'bring_back', old_pubkey: member.publicKey, new_pubkey: null, operator_pubkey: 'b'.repeat(64), status: 'pending', created_at: '', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            communityCopy: { kept: true, since: null },
        });
        const bind = vi.spyOn(nodeClient, 'bindRekeyByMatchApi').mockResolvedValueOnce({ success: true, oldPubkey: member.publicKey, newPubkey: '', callsign: 'alice' })
            .mockResolvedValueOnce({ success: true, oldPubkey: member.publicKey, newPubkey: '', callsign: 'alice', broughtBack: true });
        render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onClose={() => {}} />);
        fireEvent.change(await screen.findByTestId('bring-back-number'), { target: { value: '47' } });
        fireEvent.click(screen.getByTestId('bring-back-confirm'));
        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.queryByTestId('bring-back-done')).toBeNull();
        fireEvent.change(screen.getByTestId('bring-back-number'), { target: { value: '47' } });
        fireEvent.click(screen.getByTestId('bring-back-confirm'));
        expect(await screen.findByTestId('bring-back-done')).toBeDefined();
        expect(bind).toHaveBeenLastCalledWith('http://localhost:3000', member.publicKey, 'BB-1234-5678', '47', undefined, undefined);
    });

    it('a member with no copy here: "no", and no code to make', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({ ...base, communityCopy: { kept: false, since: null } });
        const onRekeyInstead = vi.fn();
        render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onRekeyInstead={onRekeyInstead} onClose={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('bring-back-can').textContent).toMatch(/Can be brought back by this community: no/));
        expect(screen.queryByTestId('bring-back-make-code')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Re-key instead' }));
        expect(onRekeyInstead).toHaveBeenCalledTimes(1);
    });
});
