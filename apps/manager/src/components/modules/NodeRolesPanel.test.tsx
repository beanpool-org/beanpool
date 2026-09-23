import { render, screen, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { NodeRolesPanel, grantConsequence, matchMembers, type RolesViewer } from './NodeRolesPanel';
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
// Appointed by the OWNER on purpose: an admin may still remove this one (Marty, 2026-09-20).
const carolModerator = { member_pubkey: CAROL, role: 'moderator' as const, granted_at: '2026-09-17T10:00:00.000Z', granted_by: ALICE, callsign: 'carol' };

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

    // Changed 2026-09-20 on the owner's instruction: an admin used to see this list read-only.
    // "they are admins - admins should be able to appoint a much lower ranked account. you
    // shouldn't need the owner to do this." Scope is moderator ONLY, both ways.
    it('an admin signed in by key can manage moderators, and is told so', async () => {
        fetchRoles.mockResolvedValue([aliceOwner, bobAdmin, carolModerator]);
        await renderPanel({ kind: 'key', memberPubkey: BOB, role: 'admin' });
        expect(screen.getByTestId(`role-row-${ALICE}`)).toBeInTheDocument();
        expect(screen.queryByTestId('roles-read-only')).not.toBeInTheDocument();
        const notice = screen.getByTestId('roles-admin-moderators-only');
        expect(notice.textContent).toContain('You can add and remove');
        expect(notice.textContent).toContain('moderators');
        expect(screen.getByTestId('add-role')).toBeInTheDocument();
    });

    it('an admin is offered Moderator only, never Owner or Admin', async () => {
        await renderPanel({ kind: 'key', memberPubkey: BOB, role: 'admin' });
        expect(screen.getByTestId('add-role')).toBeInTheDocument();
        // The role choices only appear once someone is picked.
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'carol' } });
        await click(suggestion('carol'));
        expect(screen.getByLabelText(/Moderator/)).toBeInTheDocument();
        expect(screen.queryByLabelText(/Owner/)).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/Admin/)).not.toBeInTheDocument();
    });

    it('an admin may remove a moderator the OWNER appointed, but not an owner or a fellow admin', async () => {
        fetchRoles.mockResolvedValue([aliceOwner, bobAdmin, carolModerator]);
        await renderPanel({ kind: 'key', memberPubkey: BOB, role: 'admin' });

        // The only Remove button on the page belongs to the moderator row.
        const removeButtons = screen.queryAllByRole('button', { name: /^Remove / });
        expect(removeButtons).toHaveLength(1);
        expect(within(screen.getByTestId(`role-row-${CAROL}`)).getByRole('button', { name: /^Remove / })).toBeInTheDocument();
        expect(within(screen.getByTestId(`role-row-${ALICE}`)).queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
        expect(within(screen.getByTestId(`role-row-${BOB}`)).queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();

        await click(removeButtons[0]);
        await click(screen.getByRole('button', { name: /^Yes, remove/ }));
        expect(revoke).toHaveBeenCalledWith('https://node.test', CAROL, 'moderator', 'pw', undefined);
    });

    it('an admin cannot pick someone who already holds owner or admin', async () => {
        fetchRoles.mockResolvedValue([aliceOwner, bobAdmin, carolModerator]);
        await renderPanel({ kind: 'key', memberPubkey: BOB, role: 'admin' });
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'a' } });
        const list = screen.getByRole('list', { name: 'Matching members' });
        // alice holds owner: offered, but not choosable, and told why. aria-disabled rather than
        // disabled, so a keyboard or screen-reader user can still reach the row and its reason.
        expect(within(list).getByRole('button', { name: /alice/ })).toHaveAttribute('aria-disabled', 'true');
        expect(within(list).getByText(/Only an owner can change an owner's role/)).toBeInTheDocument();
        // bob holds admin. Searched separately: 'a' does not match "bob", so asserting it in the
        // list above only looked like coverage -- the admin branch of the guard was untested.
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'bob' } });
        expect(suggestion('bob')).toHaveAttribute('aria-disabled', 'true');
        // carol is already a moderator, so an admin may still act on her.
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'carol' } });
        expect(suggestion('carol')).not.toHaveAttribute('aria-disabled');
    });

    // The reason beside a blocked row only reaches sighted mouse users while the row is natively
    // `disabled`: that takes it out of the Tab order and out of most screen readers' reading order.
    it('a row an admin may not pick stays in the Tab order, is announced unavailable, and says why', async () => {
        fetchRoles.mockResolvedValue([aliceOwner, bobAdmin, carolModerator]);
        await renderPanel({ kind: 'key', memberPubkey: BOB, role: 'admin' });
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'alice' } });

        const row = suggestion('alice');
        expect(row).not.toBeDisabled();
        expect(row).toHaveAttribute('aria-disabled', 'true');

        row.focus();
        expect(document.activeElement).toBe(row);

        // Its accessible description is the VISIBLE reason, not a title tooltip.
        const describedBy = row.getAttribute('aria-describedby');
        expect(describedBy).toBeTruthy();
        const reason = document.getElementById(describedBy as string);
        expect(reason).not.toBeNull();
        expect(reason?.textContent).toMatch(/Only an owner can change an owner's role/);
        expect(reason).toBeVisible();
    });

    it('a row an admin may not pick does nothing on click, Enter or Space', async () => {
        fetchRoles.mockResolvedValue([aliceOwner, bobAdmin, carolModerator]);
        await renderPanel({ kind: 'key', memberPubkey: BOB, role: 'admin' });
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'alice' } });

        const user = userEvent.setup();
        const row = suggestion('alice');

        // The point of the pair: a keyboard user can REACH it, and it still does nothing.
        // `disabled` would make the second half true by making the first half impossible.
        row.focus();
        expect(document.activeElement).toBe(row);

        await act(async () => { await user.click(row); });
        row.focus();
        await act(async () => { await user.keyboard('{Enter}'); });
        row.focus();
        await act(async () => { await user.keyboard(' '); });

        // Nobody was picked: the search list is still up and the "Adding …" step never opened.
        expect(screen.getByRole('list', { name: 'Matching members' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
        expect(grant).not.toHaveBeenCalled();
    });

    it('a control that is merely busy keeps native disabled', async () => {
        fetchRoles.mockResolvedValue([aliceOwner, carolModerator]);
        let release: (value: { success: boolean }) => void = () => {};
        revoke.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
        await renderPanel();

        await click(within(screen.getByTestId(`role-row-${CAROL}`)).getByRole('button', { name: /^Remove / }));
        const yes = screen.getByRole('button', { name: /^Yes, remove/ });
        await click(yes);

        // Saving says nothing worth reading and clears by itself, so it is left alone.
        expect(yes).toBeDisabled();
        expect(yes).not.toHaveAttribute('aria-disabled');
        await act(async () => { release({ success: true }); });
    });

    it('with no owner, the guard steps aside so an admin can make a fellow admin the first owner', async () => {
        // The node deliberately lets any signed-in admin create the FIRST owner. The suggestion-list
        // guard must not hide that, or bootstrap is only possible on yourself.
        fetchRoles.mockResolvedValue([bobAdmin, { ...bobAdmin, member_pubkey: ALICE, callsign: 'alice' }]);
        await renderPanel({ kind: 'key', memberPubkey: BOB, role: 'admin' });
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'alice' } });
        expect(suggestion('alice')).not.toHaveAttribute('aria-disabled');
        expect(screen.queryByText(/Only an owner can change/)).not.toBeInTheDocument();
    });

    it('an admin appointing a moderator sends role=moderator', async () => {
        await renderPanel({ kind: 'key', memberPubkey: BOB, role: 'admin' });
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'carol' } });
        await click(suggestion('carol'));
        await click(screen.getByRole('button', { name: 'Continue' }));
        await click(screen.getByRole('button', { name: /^Yes, make carol/ }));
        expect(grant).toHaveBeenCalledWith('https://node.test', CAROL, 'moderator', 'pw', undefined);
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

describe('NodeRolesPanel search: every match is reachable (found on test, 2026-09-19)', () => {
    // Ten members called Damo-something; the one wanted sorts last. The old list stopped at 8 and never said so.
    const hex = (i: number) => i.toString(16).padStart(2, '0');
    const damos = [
        { publicKey: hex(1).repeat(32), callsign: 'Damo', status: 'active', lastActiveAt: '2026-09-01T00:00:00.000Z' },
        { publicKey: hex(2).repeat(32), callsign: 'Damo B', status: 'active', lastActiveAt: '2026-09-18T00:00:00.000Z' },
        { publicKey: hex(3).repeat(32), callsign: 'Big Damo', status: 'active', lastActiveAt: '2026-09-19T00:00:00.000Z' },
        { publicKey: hex(4).repeat(32), callsign: 'Damon', status: 'active' },
        { publicKey: hex(5).repeat(32), callsign: 'Damo K', status: 'active', lastActiveAt: '2026-08-01T00:00:00.000Z' },
        { publicKey: hex(6).repeat(32), callsign: 'Damo L', status: 'active', lastActiveAt: '2026-07-01T00:00:00.000Z' },
        { publicKey: hex(7).repeat(32), callsign: 'Damo M', status: 'active', lastActiveAt: '2026-06-01T00:00:00.000Z' },
        { publicKey: hex(8).repeat(32), callsign: 'Damo N', status: 'active', lastActiveAt: '2026-05-01T00:00:00.000Z' },
        { publicKey: hex(9).repeat(32), callsign: 'Damo P', status: 'active', lastActiveAt: '2026-04-01T00:00:00.000Z' },
        { publicKey: hex(10).repeat(32), callsign: 'Damo (The IT guy)', status: 'active', lastActiveAt: '2026-01-01T00:00:00.000Z' },
        { publicKey: hex(11).repeat(32), callsign: 'Kate', status: 'active' },
    ];
    const IT_GUY = hex(10).repeat(32);

    beforeEach(() => {
        vi.clearAllMocks();
        fetchRoles.mockResolvedValue([aliceOwner]);
        grant.mockResolvedValue({ success: true });
    });

    async function renderDamos() {
        await act(async () => {
            render(<NodeRolesPanel activeNode={node} members={[...members, ...damos]} viewer={{ kind: 'password' }} />);
        });
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'damo' } });
        return within(screen.getByRole('list', { name: 'Matching members' }));
    }

    it('shows all 10 matches, says how many, and the tenth can be picked', async () => {
        const list = await renderDamos();
        expect(list.getAllByRole('button')).toHaveLength(10);
        expect(screen.getByTestId('match-count').textContent).toBe('10 members match: scroll the list to see them all.');
        // The list scrolls inside itself, never the page sideways
        expect(screen.getByTestId('match-list').className).toMatch(/overflow-y-auto/);
        expect(screen.getByTestId('match-list').className).toMatch(/overflow-x-hidden/);

        await click(list.getByRole('button', { name: /Damo \(The IT guy\)/ }));
        await click(screen.getByLabelText(/Admin/));
        await click(screen.getByRole('button', { name: 'Continue' }));
        await click(screen.getByRole('button', { name: 'Yes, make Damo (The IT guy) an admin' }));
        expect(grant).toHaveBeenCalledWith('https://node.test', IT_GUY, 'admin', 'pw', undefined);
    });

    it('every row shows its short key, so rows with the same name can be told apart', async () => {
        const list = await renderDamos();
        for (const d of damos.slice(0, 10)) {
            expect(list.getByText(`${d.publicKey.slice(0, 8)}…${d.publicKey.slice(-6)}`)).toBeInTheDocument();
        }
    });

    it('also shows the short key next to a role someone already holds', async () => {
        await renderPanel();
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'alice' } });
        const row = suggestion('alice');
        expect(row.textContent).toContain(`${ALICE.slice(0, 8)}…${ALICE.slice(-6)}`);
        expect(row.textContent).toContain('Owner');
    });

    it('ranks starts-with before contains, then most recently active, never-active last', () => {
        const order = matchMembers(damos, 'damo').map((m) => m.callsign);
        expect(order).toEqual([
            'Damo B', 'Damo', 'Damo K', 'Damo L', 'Damo M', 'Damo N', 'Damo P', 'Damo (The IT guy)', 'Damon',
            'Big Damo',
        ]);
    });

    it('is case-insensitive and ignores surrounding spaces', () => {
        expect(matchMembers(damos, '  DAMO ').length).toBe(10);
    });

    it('key search still works, and ranks after name matches', async () => {
        const keyed = [
            { publicKey: 'dada' + 'e'.repeat(60), callsign: 'Zed', status: 'active' },
            { publicKey: 'f'.repeat(64), callsign: 'dadaist', status: 'active' },
        ];
        expect(matchMembers(keyed, 'dadaee').map((m) => m.callsign)).toEqual(['Zed']);
        expect(matchMembers(keyed, 'dada').map((m) => m.callsign)).toEqual(['dadaist']); // under 6 characters: names only
        expect(matchMembers([...keyed, { publicKey: 'a'.repeat(64), callsign: 'dadaee fan' }], 'dadaee').map((m) => m.callsign))
            .toEqual(['dadaee fan', 'Zed']);

        await act(async () => {
            render(<NodeRolesPanel activeNode={node} members={[...members, ...keyed]} viewer={{ kind: 'password' }} />);
        });
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'dadaee' } });
        expect(suggestion('Zed')).toBeInTheDocument();
        expect(screen.getByTestId('match-count').textContent).toBe('1 member matches.');
    });

    it('never offers a treasury or SYSTEM', () => {
        const all = [...members, { publicKey: 'f1'.repeat(32), callsign: 'SYSTEM' }];
        expect(matchMembers(all, 's').map((m) => m.callsign)).toEqual([]);
        expect(matchMembers(all, 'garden')).toEqual([]);
    });

    it('with no match says so plainly', async () => {
        await renderDamos();
        fireEvent.change(screen.getByLabelText(/Search by callsign/), { target: { value: 'zzz' } });
        expect(screen.queryByRole('list', { name: 'Matching members' })).not.toBeInTheDocument();
        expect(screen.getByTestId('no-match').textContent).toBe('No one matches “zzz”. You can paste their full public key instead.');
        expect(screen.queryByTestId('match-count')).not.toBeInTheDocument();
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
        // The admin viewer reaches the panel with its moderator powers, not a read-only list.
        expect(screen.getByTestId('roles-admin-moderators-only')).toBeInTheDocument();
    });
});
