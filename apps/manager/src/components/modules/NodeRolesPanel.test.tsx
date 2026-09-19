import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('../../lib/node-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/node-client')>();
    return {
        ...actual,
        fetchNodeRoles: vi.fn(),
        grantNodeRoleApi: vi.fn(),
        revokeNodeRoleApi: vi.fn(),
        getTfaSessionToken: vi.fn(() => undefined),
    };
});

import { fetchNodeRoles, grantNodeRoleApi, revokeNodeRoleApi } from '../../lib/node-client';
import { NodeRolesPanel, grantConsequence, type RolesViewer } from './NodeRolesPanel';
import { PeopleSafetySection } from './PeopleSafetySection';

const fetchRoles = vi.mocked(fetchNodeRoles);
const grant = vi.mocked(grantNodeRoleApi);
const revoke = vi.mocked(revokeNodeRoleApi);

const node: NodeProfile = { id: 'local-node', name: 'Test', url: 'https://node.test', adminPassword: 'pw' };

const ALICE = 'a1'.repeat(32);
const BOB = 'b2'.repeat(32);
const CAROL = 'c3'.repeat(32);
const members = [
    { publicKey: ALICE, callsign: 'alice', status: 'active' },
    { publicKey: BOB, callsign: 'bob', status: 'active' },
    { publicKey: CAROL, callsign: 'carol', status: 'active' },
    { publicKey: 'd4'.repeat(32), callsign: 'Garden Treasury', isTreasury: true },
];

const aliceOwner = { member_pubkey: ALICE, role: 'owner' as const, granted_at: '2026-09-15T10:00:00.000Z', granted_by: 'owner:password', callsign: 'alice' };
const bobAdmin = { member_pubkey: BOB, role: 'admin' as const, granted_at: '2026-09-16T10:00:00.000Z', granted_by: ALICE, callsign: 'bob' };

async function renderPanel(viewer: RolesViewer = { kind: 'password' }, onChanged = vi.fn()) {
    await act(async () => {
        render(<NodeRolesPanel activeNode={node} members={members} viewer={viewer} onChanged={onChanged} />);
    });
    return onChanged;
}

const suggestion = (name: string) =>
    within(screen.getByRole('list', { name: 'Matching members' })).getByRole('button', { name: new RegExp(name) });

async function click(el: HTMLElement) {
    await act(async () => { fireEvent.click(el); });
}

describe('NodeRolesPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fetchRoles.mockResolvedValue([aliceOwner, bobAdmin]);
        grant.mockResolvedValue({ success: true });
        revoke.mockResolvedValue({ success: true });
    });

    it('lists each role holder with callsign, short key, role and who added them when', async () => {
        await renderPanel();
        expect(fetchRoles).toHaveBeenCalledWith('https://node.test', 'pw', undefined);

        const aliceRow = screen.getByTestId(`role-row-${ALICE}`);
        expect(within(aliceRow).getByText('alice')).toBeInTheDocument();
        expect(within(aliceRow).getByText(/Owner/)).toBeInTheDocument();
        expect(within(aliceRow).getByText(`${ALICE.slice(0, 8)}…${ALICE.slice(-6)}`)).toBeInTheDocument();
        expect(aliceRow.textContent).toMatch(/added by the admin password on/);

        const bobRow = screen.getByTestId(`role-row-${BOB}`);
        expect(within(bobRow).getByText(/Admin/)).toBeInTheDocument();
        // granted_by is a key: shown as that member's callsign
        expect(bobRow.textContent).toMatch(/added by alice on/);
        expect(screen.queryByTestId('no-owner-banner')).not.toBeInTheDocument();
    });

    it('adds a member found by callsign, after a plain-words confirmation', async () => {
        const onChanged = await renderPanel();
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'car' } });
        // Treasuries never show as candidates
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'a' } });
        expect(screen.queryByText('Garden Treasury')).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'car' } });
        await click(suggestion('carol'));

        await click(screen.getByLabelText(/Moderator/));
        await click(screen.getByLabelText(/Admin/));
        await click(screen.getByRole('button', { name: 'Continue' }));
        expect(grant).not.toHaveBeenCalled();
        expect(screen.getByTestId('add-confirm').textContent).toContain(grantConsequence('carol', 'admin'));

        fetchRoles.mockResolvedValueOnce([aliceOwner, bobAdmin, { ...bobAdmin, member_pubkey: CAROL, callsign: 'carol' }]);
        await click(screen.getByRole('button', { name: 'Yes, make carol an admin' }));
        expect(grant).toHaveBeenCalledWith('https://node.test', CAROL, 'admin', 'pw', undefined);
        expect(screen.getByRole('status').textContent).toContain('carol is now an admin.');
        expect(fetchRoles).toHaveBeenCalledTimes(2);
        expect(onChanged).toHaveBeenCalled();
    });

    it('accepts a pasted full public key and leaves checking it to the node', async () => {
        grant.mockRejectedValueOnce(new Error('Member not found'));
        await renderPanel();
        const pasted = 'e5'.repeat(32);
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: `  ${pasted} ` } });
        await click(screen.getByRole('button', { name: /Use this key/ }));
        await click(screen.getByLabelText(/Owner/));
        await click(screen.getByRole('button', { name: 'Continue' }));
        await click(screen.getByRole('button', { name: /Yes, make/ }));
        expect(grant).toHaveBeenCalledWith('https://node.test', pasted, 'owner', 'pw', undefined);
        expect(screen.getByRole('alert').textContent).toContain('Member not found');
    });

    it('says when a new role replaces the one someone already holds', async () => {
        await renderPanel();
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'bob' } });
        await click(suggestion('bob'));
        await click(screen.getByLabelText(/Moderator/));
        await click(screen.getByRole('button', { name: 'Continue' }));
        expect(screen.getByText('This replaces their current role (admin).')).toBeInTheDocument();
    });

    it('asks before removing, then removes', async () => {
        const onChanged = await renderPanel();
        await click(screen.getByRole('button', { name: "Remove bob's admin role" }));
        expect(revoke).not.toHaveBeenCalled();
        expect(screen.getByTestId('remove-confirm').textContent).toMatch(/bob will no longer be an admin of this community\. They lose access to these Settings straight away\./);

        await click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByTestId('remove-confirm')).not.toBeInTheDocument();

        await click(screen.getByRole('button', { name: "Remove bob's admin role" }));
        fetchRoles.mockResolvedValueOnce([aliceOwner]);
        await click(screen.getByRole('button', { name: 'Yes, remove admin' }));
        expect(revoke).toHaveBeenCalledWith('https://node.test', BOB, 'admin', 'pw', undefined);
        expect(screen.getByRole('status').textContent).toContain('bob is no longer an admin.');
        expect(screen.queryByTestId(`role-row-${BOB}`)).not.toBeInTheDocument();
        expect(onChanged).toHaveBeenCalled();
    });

    it("shows the node's refusal in its own words when the last owner is removed", async () => {
        revoke.mockRejectedValueOnce(new Error('Cannot remove the last owner'));
        await renderPanel();
        await click(screen.getByRole('button', { name: "Remove alice's owner role" }));
        await click(screen.getByRole('button', { name: 'Yes, remove owner' }));
        expect(revoke).toHaveBeenCalledWith('https://node.test', ALICE, 'owner', 'pw', undefined);
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toContain('Not done. The node said:');
        expect(alert.textContent).toContain('Cannot remove the last owner');
        // The row is still there: nothing was assumed
        expect(screen.getByTestId(`role-row-${ALICE}`)).toBeInTheDocument();
    });

    it("shows the node's refusal when a non-owner tries to grant, and for a suspended member", async () => {
        grant.mockRejectedValueOnce(new Error('Only an owner may grant the admin role'));
        await renderPanel();
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'carol' } });
        await click(suggestion('carol'));
        await click(screen.getByRole('button', { name: 'Continue' }));
        await click(screen.getByRole('button', { name: /Yes, make carol/ }));
        expect(screen.getByRole('alert').textContent).toContain('Only an owner may grant the admin role');

        grant.mockRejectedValueOnce(new Error('Only active accounts can hold a node role'));
        await click(screen.getByRole('button', { name: 'Continue' }));
        await click(screen.getByRole('button', { name: /Yes, make carol/ }));
        expect(screen.getByRole('alert').textContent).toContain('Only active accounts can hold a node role');
    });

    it('an owner signed in by key gets the controls and sees themself marked', async () => {
        await renderPanel({ kind: 'key', memberPubkey: ALICE, role: 'owner' });
        expect(within(screen.getByTestId(`role-row-${ALICE}`)).getByText('(you)')).toBeInTheDocument();
        expect(screen.getByTestId(`role-row-${BOB}`).textContent).toMatch(/added by you on/);
        expect(screen.getByRole('button', { name: "Remove bob's admin role" })).toBeInTheDocument();
        expect(screen.getByTestId('add-role')).toBeInTheDocument();
        expect(screen.queryByTestId('roles-read-only')).not.toBeInTheDocument();

        await click(screen.getByRole('button', { name: "Remove alice's owner role" }));
        expect(screen.getByTestId('remove-confirm').textContent).toContain('This is you — you will be signed out of these Settings.');
    });

    it('an admin signed in by key sees the list read-only, with no add or remove controls', async () => {
        await renderPanel({ kind: 'key', memberPubkey: BOB, role: 'admin' });
        expect(screen.getByTestId(`role-row-${ALICE}`)).toBeInTheDocument();
        expect(screen.getByTestId('roles-read-only')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
        expect(screen.queryByTestId('add-role')).not.toBeInTheDocument();
    });

    it('with no owner, a key session can make itself the owner in one step', async () => {
        fetchRoles.mockResolvedValue([bobAdmin]);
        await renderPanel({ kind: 'key', memberPubkey: BOB, role: 'admin' });
        const banner = screen.getByTestId('no-owner-banner');
        expect(banner.textContent).toContain('This community has no owner yet — add yourself');

        await click(within(banner).getByRole('button', { name: 'Make me the owner' }));
        expect(screen.getByTestId('add-confirm').textContent).toContain(grantConsequence('You', 'owner', true));
        expect(screen.getByText('This replaces their current role (admin).')).toBeInTheDocument();
        await click(screen.getByRole('button', { name: 'Yes, make me an owner' }));
        expect(grant).toHaveBeenCalledWith('https://node.test', BOB, 'owner', 'pw', undefined);
        expect(screen.getByRole('status').textContent).toContain('You are now an owner.');
    });

    it('with no owner, a password session is sent to search, with Owner chosen', async () => {
        fetchRoles.mockResolvedValue([]);
        await renderPanel();
        expect(screen.getByText('Nobody holds a role yet.')).toBeInTheDocument();
        const banner = screen.getByTestId('no-owner-banner');
        expect(banner.textContent).toContain('Search for your own callsign');
        await click(within(banner).getByRole('button', { name: 'Find myself' }));
        expect(document.activeElement).toBe(screen.getByLabelText(/Search by callsign/));

        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'ali' } });
        await click(suggestion('alice'));
        await click(screen.getByRole('button', { name: 'Continue' }));
        await click(screen.getByRole('button', { name: 'Yes, make alice an owner' }));
        expect(grant).toHaveBeenCalledWith('https://node.test', ALICE, 'owner', 'pw', undefined);
    });

    it("shows the node's answer when the list itself is refused", async () => {
        fetchRoles.mockRejectedValue(new Error('Break-glass mode active: password authentication restricted to key enrolment only'));
        await renderPanel();
        expect(screen.getByRole('alert').textContent).toContain('Break-glass mode active');
        expect(screen.queryByTestId('no-owner-banner')).not.toBeInTheDocument();
        expect(screen.queryByTestId('add-role')).not.toBeInTheDocument();
    });
});

describe('PeopleSafetySection → Owners & admins tab', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fetchRoles.mockResolvedValue([aliceOwner]);
    });

    it('opens the panel from its own sub-tab and passes the viewer through', async () => {
        await act(async () => {
            render(
                <PeopleSafetySection
                    activeNode={node}
                    nodeData={{ members, reports: [] }}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    onFreezeUser={vi.fn()}
                    onPruneUser={vi.fn()}
                    onUpdateTier={vi.fn()}
                    onToggleVoucher={vi.fn()}
                    onToggleOperator={vi.fn()}
                    rolesViewer={{ kind: 'key', memberPubkey: BOB, role: 'admin' }}
                />
            );
        });
        expect(screen.queryByTestId('node-roles-panel')).not.toBeInTheDocument();
        await click(screen.getByRole('button', { name: 'Owners & admins' }));
        expect(screen.getByTestId('node-roles-panel')).toBeInTheDocument();
        expect(screen.getByTestId('roles-read-only')).toBeInTheDocument();
    });
});
