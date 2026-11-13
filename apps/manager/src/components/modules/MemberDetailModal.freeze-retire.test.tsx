/**
 * The member panel's Freeze shows the node's state (Marty, 14 Nov 2026: "sort the freeze to frozen button": four presses each
 * froze on the node while the panel showed only a colour flash), and Retire an empty duplicate sits beside Suspend where
 * the node allows it.
 *
 *   1. Freeze: the button is disabled while the node answers; then "🧊 Frozen" and Unfreeze, with a one-line confirmation,
 *      from the freeze the node read back, not from the press. A read-back that says unfrozen shows unfrozen.
 *   2. A refusal shows the node's own words, and the state stays what the node holds.
 *   3. Retire: shown only when the node says this owner may retire this member; a press confirms, retires, reads the
 *      member back and shows "Retired (empty duplicate)" with Bring back; Bring back reads back active.
 *   4. No Retire button for an admin viewer, when the node says the account is not empty, or on the node's own SYSTEM row
 *      or a row under another key spelling (no person's account; not even asked).
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemberDetailModal, type MemberModalItem } from './MemberDetailModal';
import * as nodeClient from '../../lib/node-client';

const PK = 'a'.repeat(64);
const member: MemberModalItem = { publicKey: PK, callsign: 'Dup', status: 'active', joinedAt: '2026-11-01T00:00:00Z' };

describe('MemberDetailModal: Freeze shows the node, Retire an empty duplicate', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(true);
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([]);
        vi.spyOn(nodeClient, 'fetchRekeyStatusApi').mockResolvedValue(null as never);
    });

    it('Freeze: disabled while asked, then the read-back state with one line', async () => {
        vi.spyOn(nodeClient, 'fetchRetireCheck').mockResolvedValue({ allowed: false });
        let answer: (v: boolean | null) => void = () => { };
        const toggle = vi.fn(() => new Promise<boolean | null>((r) => { answer = r; }));
        render(<MemberDetailModal member={member} isFrozen={false} onToggleFreeze={toggle} onClose={vi.fn()} nodeUrl="https://n" />);
        expect(screen.queryByTestId('frozen-state')).toBeNull();
        await userEvent.click(screen.getByText('🛑 Freeze'));
        expect(toggle).toHaveBeenCalledWith(PK, true);
        expect(screen.getByTestId('freeze-button')).toBeDisabled();
        expect(screen.getByTestId('freeze-button').textContent).toBe('Freezing…');
        answer(true);
        await waitFor(() => expect(screen.getByTestId('frozen-state').textContent).toBe('🧊 Frozen'));
        expect(screen.getByTestId('freeze-button')).not.toBeDisabled();
        expect(screen.getByTestId('freeze-button').textContent).toBe('🟢 Unfreeze');
        expect(screen.getByTestId('freeze-note').textContent).toMatch(/^Frozen: Dup can't use credit/);
    });

    it('Freeze: the state is what the node read back, not what was pressed', async () => {
        vi.spyOn(nodeClient, 'fetchRetireCheck').mockResolvedValue({ allowed: false });
        const toggle = vi.fn(async () => false);
        render(<MemberDetailModal member={member} isFrozen={false} onToggleFreeze={toggle} onClose={vi.fn()} nodeUrl="https://n" />);
        await userEvent.click(screen.getByText('🛑 Freeze'));
        await waitFor(() => expect(screen.getByTestId('freeze-note')).toBeInTheDocument());
        expect(screen.queryByTestId('frozen-state')).toBeNull();
        expect(screen.getByTestId('freeze-button').textContent).toBe('🛑 Freeze');
    });

    it("Freeze: a refusal shows the node's words and changes nothing", async () => {
        vi.spyOn(nodeClient, 'fetchRetireCheck').mockResolvedValue({ allowed: false });
        const toggle = vi.fn(async () => { throw new Error("You can't freeze or unfreeze your own account. Another owner or admin can."); });
        render(<MemberDetailModal member={member} isFrozen={true} onToggleFreeze={toggle} onClose={vi.fn()} nodeUrl="https://n" />);
        expect(screen.getByTestId('frozen-state').textContent).toBe('🧊 Frozen');
        await userEvent.click(screen.getByText('🟢 Unfreeze'));
        expect(toggle).toHaveBeenCalledWith(PK, false);
        await waitFor(() => expect(screen.getByTestId('freeze-error').textContent).toBe("You can't freeze or unfreeze your own account. Another owner or admin can."));
        expect(screen.getByTestId('frozen-state')).toBeInTheDocument();
    });

    it('Retire: beside Suspend where the node allows it; retires, reads back, Bring back undoes it', async () => {
        vi.spyOn(nodeClient, 'fetchRetireCheck').mockResolvedValue({ allowed: true });
        const retire = vi.spyOn(nodeClient, 'retireEmptyDuplicate').mockResolvedValue({ success: true });
        const back = vi.spyOn(nodeClient, 'bringBackRetiredMember').mockResolvedValue({ success: true });
        const standing = vi.spyOn(nodeClient, 'fetchMemberStanding')
            .mockResolvedValueOnce({ creditFrozen: false, status: 'disabled', retiredAt: '2026-11-14T00:00:00Z' })
            .mockResolvedValueOnce({ creditFrozen: false, status: 'active', retiredAt: null });
        const changed = vi.fn();
        render(<MemberDetailModal member={member} isFrozen={false} onToggleFreeze={vi.fn()} onClose={vi.fn()} nodeUrl="https://n"
            viewerRole="owner" onSuspensionChanged={changed} />);
        const button = await screen.findByTestId('retire-button');
        expect(screen.getByText('⏸️ Suspend')).toBeInTheDocument();
        await userEvent.click(button);
        expect(screen.getByTestId('retire-confirm').textContent).toMatch(/no vote, nothing deleted/);
        await userEvent.click(screen.getByText('Retire now'));
        await waitFor(() => expect(screen.getByTestId('retired-state').textContent).toBe('🗄️ Retired (empty duplicate)'));
        expect(retire).toHaveBeenCalledWith('https://n', PK, undefined);
        expect(standing).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('retire-note').textContent).toMatch(/^Retired Dup as an empty duplicate\. No vote opened/);
        expect(screen.queryByText('⏸️ Suspended')).toBeNull();
        expect(screen.queryByTestId('bring-back-button')).toBeNull();
        expect(changed).toHaveBeenCalledTimes(1);
        await userEvent.click(screen.getByTestId('bring-back-retired'));
        await waitFor(() => expect(screen.getByTestId('retire-note').textContent).toBe('Brought back: Dup is active again.'));
        expect(back).toHaveBeenCalledWith('https://n', PK, undefined);
        expect(screen.queryByTestId('retired-state')).toBeNull();
    });

    it('Retire: no button for an admin, nor where the node says the account is not empty', async () => {
        const check = vi.spyOn(nodeClient, 'fetchRetireCheck').mockResolvedValue({ allowed: false, error: 'They have sent messages.' });
        const { unmount } = render(<MemberDetailModal member={member} isFrozen={false} onToggleFreeze={vi.fn()} onClose={vi.fn()} nodeUrl="https://n" viewerRole="owner" />);
        await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('retire-button')).toBeNull();
        unmount();
        check.mockClear();
        render(<MemberDetailModal member={member} isFrozen={false} onToggleFreeze={vi.fn()} onClose={vi.fn()} nodeUrl="https://n" viewerRole="admin" />);
        await screen.findByText('⏸️ Suspend');
        expect(check).not.toHaveBeenCalled();
        expect(screen.queryByTestId('retire-button')).toBeNull();
    });

    it("Retire: no button on the node's own SYSTEM row, nor any row under another key spelling, whatever the check says", async () => {
        const check = vi.spyOn(nodeClient, 'fetchRetireCheck').mockResolvedValue({ allowed: true });
        for (const pk of ['SYSTEM', 'A'.repeat(64)]) {
            const { unmount } = render(<MemberDetailModal member={{ ...member, publicKey: pk, callsign: 'System' }} isFrozen={false}
                onToggleFreeze={vi.fn()} onClose={vi.fn()} nodeUrl="https://n" viewerRole="owner" />);
            await screen.findByText('⏸️ Suspend');
            expect(check).not.toHaveBeenCalled();
            expect(screen.queryByTestId('retire-button')).toBeNull();
            unmount();
        }
    });

    it('A retired member opens as Retired (empty duplicate), not as a suspension to lift', async () => {
        vi.spyOn(nodeClient, 'fetchRetireCheck').mockResolvedValue({ allowed: false });
        render(<MemberDetailModal member={{ ...member, status: 'disabled', retiredAt: '2026-11-14T00:00:00Z' }} isFrozen={false}
            onToggleFreeze={vi.fn()} onClose={vi.fn()} nodeUrl="https://n" viewerRole="owner" />);
        expect(screen.getByTestId('retired-state').textContent).toBe('🗄️ Retired (empty duplicate)');
        expect(screen.queryByText('Lift suspension')).toBeNull();
        expect(screen.getByTestId('bring-back-retired')).toBeInTheDocument();
    });
});
