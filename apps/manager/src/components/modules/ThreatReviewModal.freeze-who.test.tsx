import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ThreatReviewModal, type ThreatItem, type MemberItem } from './ThreatReviewModal';

/**
 * Freeze offers only the members the viewer may freeze (Marty, 14 Nov 2026: a ring flag named him, the owner, and Rob, an
 * admin, and Rob's Freeze would have frozen both). The node refuses the rest (POST /api/local/admin/users/:pubkey/freeze:
 * never your own account, only an owner an owner); the window says so per member before anyone taps, and sends only the
 * others. With nobody left to freeze it offers no Freeze at all.
 */

const OWNER = 'aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900';
const ADMIN = 'bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900aa11';
const MEMBER = 'cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900aa11bb22';

const roster: MemberItem[] = [
    { publicKey: OWNER, callsign: 'Marty', nodeRole: 'owner' },
    { publicKey: ADMIN, callsign: 'Rob', nodeRole: 'admin' },
    { publicKey: MEMBER, callsign: 'Mia' },
];

const ring = (members: string[]): ThreatItem => ({ type: 'sybil_ring', severity: 'critical', description: 'A ring.', members });

function open(threat: ThreatItem, viewer: React.ComponentProps<typeof ThreatReviewModal>['viewer'], onFreezePubkeys = vi.fn().mockResolvedValue(undefined)) {
    render(<ThreatReviewModal threat={threat} members={roster} viewer={viewer} onClose={vi.fn()} onFreezePubkeys={onFreezePubkeys} />);
    return onFreezePubkeys;
}

const freezeButton = () => screen.queryByRole('button', { name: /Freeze Accounts/ });

describe('ThreatReviewModal: Freeze offers only who you may freeze', () => {
    it('an admin sees the owner and himself as "can\'t be frozen by you", and Freeze sends only the member', async () => {
        const onFreeze = open(ring([OWNER, ADMIN, MEMBER]), { kind: 'key', memberPubkey: ADMIN, role: 'admin' });
        expect(screen.getByText("Can't be frozen by you: an owner")).toBeInTheDocument();
        expect(screen.getByText("Can't be frozen by you: this is you")).toBeInTheDocument();
        expect(screen.getAllByText(/Can't be frozen by you/)).toHaveLength(2);
        await act(async () => { fireEvent.click(freezeButton()!); });
        expect(onFreeze).toHaveBeenCalledWith([MEMBER]);
    });

    it('the pair that started it (owner + admin), seen by the admin: nobody to freeze, so no Freeze button', () => {
        open(ring([OWNER, ADMIN]), { kind: 'key', memberPubkey: ADMIN, role: 'admin' });
        expect(screen.getAllByText(/Can't be frozen by you/)).toHaveLength(2);
        expect(freezeButton()).not.toBeInTheDocument();
    });

    it('an owner may freeze an admin and a member, never herself', async () => {
        const onFreeze = open(ring([OWNER, ADMIN, MEMBER]), { kind: 'key', memberPubkey: OWNER, role: 'owner' });
        expect(screen.getByText("Can't be frozen by you: this is you")).toBeInTheDocument();
        expect(screen.queryByText("Can't be frozen by you: an owner")).not.toBeInTheDocument();
        await act(async () => { fireEvent.click(freezeButton()!); });
        expect(onFreeze).toHaveBeenCalledWith([ADMIN, MEMBER]);
    });

    it('after a freeze, only the members it froze show as frozen', async () => {
        open(ring([OWNER, ADMIN, MEMBER]), { kind: 'key', memberPubkey: ADMIN, role: 'admin' });
        await act(async () => { fireEvent.click(freezeButton()!); });
        expect(screen.getAllByText('🛑 FROZEN')).toHaveLength(1);
    });
});
