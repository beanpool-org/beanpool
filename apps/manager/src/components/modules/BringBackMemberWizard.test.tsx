import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BringBackMemberWizard, BRING_BACK_WORDS, ONLY_IN_PERSON, REKEY_INSTEAD_WORDS, SHARED_DAY_WORDS } from './BringBackMemberWizard';
import { REKEY_PROPOSALS_POLL_MS } from './RekeyMemberWizard';
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

    it('half kept at BeanPool\'s key vault (vault rethink VR4): it says the day first, and after the number never says they are back', async () => {
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
            ...base,
            pendingRequest: { id: 1, code: 'BB-1234-5678', kind: 'bring_back', old_pubkey: member.publicKey, new_pubkey: null, operator_pubkey: 'owner:password', status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            communityCopy: { kept: true, since: null, placement: 'shared' },
        } as nodeClient.RekeyStatusResponse);
        vi.spyOn(nodeClient, 'bindRekeyByMatchApi').mockResolvedValue({ success: true, oldPubkey: member.publicKey, newPubkey: '', callsign: 'alice', broughtBack: true, placement: 'shared' });
        render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onClose={() => {}} />);
        fireEvent.change(await screen.findByTestId('bring-back-number'), { target: { value: '47' } });
        fireEvent.click(screen.getByTestId('bring-back-confirm'));
        const done = await screen.findByTestId('bring-back-done');
        expect(done.textContent).toMatch(/holds the rest for a day, so their other phones can stop it/);
        expect(done.textContent).not.toMatch(/has their account back/);
    });

    it('before the code, a shared copy says what it takes; a whole copy doesn\'t', async () => {
        const read = vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({ ...base, communityCopy: { kept: true, since: null, placement: 'shared' } });
        const { unmount } = render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onClose={() => {}} />);
        expect((await screen.findByTestId('bring-back-shared')).textContent).toBe(SHARED_DAY_WORDS);
        unmount();
        read.mockResolvedValue({ ...base, communityCopy: { kept: true, since: null, placement: 'whole' } });
        render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onClose={() => {}} />);
        await screen.findByTestId('bring-back-can');
        expect(screen.queryByTestId('bring-back-shared')).toBeNull();
    });

    describe('the same brakes as Re-Key: the phones that asked, Not theirs, and codes being guessed at', () => {
        const phoneA = 'c'.repeat(64);
        const phoneB = 'd'.repeat(64);
        const waitingCode = (extra: Partial<nodeClient.RekeyStatusResponse> = {}): nodeClient.RekeyStatusResponse => ({
            ...base,
            pendingRequest: { id: 1, code: 'BB-1234-5678', kind: 'bring_back', old_pubkey: member.publicKey, new_pubkey: null, operator_pubkey: 'b'.repeat(64), status: 'pending', created_at: '', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            communityCopy: { kept: true, since: null },
            ...extra,
        });

        it('each phone that asked has a card with Not theirs, which turns it away; the guessing warning shows beside the code', async () => {
            vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue(waitingCode({
                proposals: [{ newPubkey: phoneA, proposedAt: new Date().toISOString() }, { newPubkey: phoneB, proposedAt: new Date().toISOString() }],
                codeUnderAttack: { wrongTries: 4, refusing: false },
            }));
            const decline = vi.spyOn(nodeClient, 'declineRekeyProposalApi').mockResolvedValue({ success: true, declined: true, declines: 1 });
            render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onClose={() => {}} />);
            expect((await screen.findAllByTestId('bring-back-proposal')).length).toBe(2);
            expect(screen.getByTestId('bring-back-proposals').textContent).toContain('2 phones have asked.');
            expect(screen.getByTestId('bring-back-under-attack').textContent).toContain("Someone has tried 4 wrong codes like this one in the last hour. A phone you don't recognise is someone else's: press Not theirs.");

            fireEvent.click(within(screen.getAllByTestId('bring-back-proposal')[1]).getByRole('button', { name: 'Not theirs' }));
            await waitFor(() => expect(screen.getAllByTestId('bring-back-proposal').length).toBe(1));
            expect(decline).toHaveBeenCalledWith('http://localhost:3000', member.publicKey, phoneB, undefined, undefined);
            expect(screen.getByTestId('bring-back-proposals').textContent).toContain('One phone has asked.');
            expect(screen.getByTestId('bring-back-proposal').textContent).toContain(phoneA.slice(0, 6));
        });

        it('a code being guessed at so hard that phones are turned away: cancel it and make a new one', async () => {
            vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue(waitingCode({ proposals: [], codeUnderAttack: { wrongTries: 10, refusing: true } }));
            render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onClose={() => {}} />);
            expect((await screen.findByTestId('bring-back-under-attack')).textContent).toContain('phones asking with it are turned away for the rest of the hour. Cancel it and make a new code');
        });

        it('no phone has asked yet: the window says so, and no warning shows', async () => {
            vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue(waitingCode({ proposals: [] }));
            render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onClose={() => {}} />);
            expect((await screen.findByTestId('bring-back-proposals')).textContent).toContain('Waiting for their phone to ask…');
            expect(screen.queryByTestId('bring-back-under-attack')).toBeNull();
        });

        it('the phones are read again while the code waits; a code the node no longer holds says so and takes no number', async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            try {
                vi.spyOn(nodeClient, 'fetchRekeyStatusApi')
                    .mockResolvedValueOnce(waitingCode({ proposals: [] }))
                    .mockResolvedValueOnce(waitingCode({ proposals: [{ newPubkey: phoneA, proposedAt: new Date().toISOString() }] }))
                    .mockResolvedValue({ ...base, communityCopy: { kept: true, since: null } });
                render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onClose={() => {}} />);
                expect((await screen.findByTestId('bring-back-proposals')).textContent).toContain('Waiting for their phone to ask…');
                await act(async () => { await vi.advanceTimersByTimeAsync(REKEY_PROPOSALS_POLL_MS); });
                expect(screen.getAllByTestId('bring-back-proposal').length).toBe(1);
                await act(async () => { await vi.advanceTimersByTimeAsync(REKEY_PROPOSALS_POLL_MS); });
                expect(screen.getByTestId('bring-back-code-ended').textContent).toContain('This code is no longer waiting: it was used, cancelled or replaced on another screen.');
                expect(screen.queryByTestId('bring-back-proposals')).toBeNull();
                expect(screen.queryByTestId('bring-back-number')).toBeNull();
            } finally {
                vi.useRealTimers();
            }
        });
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

    it('a copy kept here that this server can\'t open: "no", why, and what can be done; never "they haven\'t turned it on" (#2626)', async () => {
        for (const [reason, said] of [
            ['recovery_seal_key_missing', 'Its recovery-seal key (data/recovery-seal.key) is missing: put it back from your take-over bundle or sealed backup, and Bring back works again.'],
            ['recovery_seal_unopenable', 'It was locked with a recovery-seal key this server doesn’t have. They can turn on “Your community’s admins” again in the app to make a copy it can open.'],
        ] as const) {
            vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue({
                ...base, communityCopy: { kept: false, since: null, unopenable: { since: '2026-10-05T00:00:00.000Z', reason } },
            });
            const { unmount } = render(<BringBackMemberWizard member={member} nodeUrl="http://localhost:3000" onRekeyInstead={() => {}} onClose={() => {}} />);
            await waitFor(() => expect(screen.getByTestId('bring-back-can').textContent).toBe('Can be brought back by this community: no. This server keeps their copy but can’t open it now.'));
            expect(screen.getByTestId('bring-back-cant-open').textContent).toContain(said);
            expect(screen.queryByTestId('bring-back-make-code'), 'no code for a copy this server can\'t open').toBeNull();
            unmount();
        }
    });
});
