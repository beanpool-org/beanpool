import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DoorSettingPanel, DOOR_PRESETS, doorChangeConsequence, readDoor, readJoinLock, unpauseConsequence } from './DoorSettingPanel';
import { NodeIdentityPanel } from './NodeIdentityPanel';
import { PeopleSafetySection } from './PeopleSafetySection';
import type { NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * People & Safety → Invites & QR → "Who may invite" (the door, community modes slice 1; apps/server config/door.ts):
 * the presets Invite (any member invites) and Known (only admins invite), read from /api/node/config and saved as How
 * this community works' `join` (POST /api/local/admin/community-shape) by an owner. A node older than the door shows nothing; the global node's open door is shown, not offered.
 * Whether new members are paused is read from the shape (GET /api/local/admin/community-shape `join`): saving a door takes
 * them again, so a paused node says so first, and a node that won't say is offered no save (#2415 review r4360287590).
 * Where who can join is locked (the private preview, a shut open door), the lock is said first and nothing is offered, and
 * a save says every member was told only when the node says it told them (#2415 review r4360594247).
 */

const NODE: NodeProfile = { id: 'n1', name: 'Mullum', url: 'https://mullum.test', adminPassword: 'pw' };
const OWNER_KEY: RolesViewer = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
const ADMIN_KEY: RolesViewer = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' };
const PASSWORD: RolesViewer = { kind: 'password' };

type Answer = { ok: boolean; status?: number; body: unknown };

const ADMIN_ROW = { member_pubkey: 'a'.repeat(64), role: 'admin', granted_at: '2026-01-01', granted_by: null };

type Join = 'members' | 'admins' | 'paused' | 'open';

/** The shape's lock on who can join, as the server words it (apps/server config/community-shape.ts LOCK_WORDS). */
const PREVIEW_LOCK = {
    code: 'private_preview',
    why: 'While the private preview is on, only owners and admins invite, and nobody can ask to join.',
    unlock: 'Turn the private preview off on the server (PRIVATE_PREVIEW).',
};

/** How this community works as the node reads it: only `join` matters here. 'fail': the node won't say. */
function shapeAnswer(join: Join | 'fail', lock: unknown = null) {
    return join === 'fail'
        ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'Internal Server Error' }) })
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ kind: 'local', standby: false, settings: { join: { value: join, configured: join, source: 'default', lock } } }) });
}

/** What the route answers when who can join changed: the shape, and that every member was told. */
const CHANGED: Answer = { ok: true, body: { shape: {}, told: 'members' } };

function mockNode(config: Record<string, unknown>, save: Answer = CHANGED, roles: unknown[] | 'fail' = [ADMIN_ROW],
    join: Join | 'fail' = readDoor(config.door) ?? 'members', lock: unknown = null) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/api/local/admin/node-roles')) {
            return roles === 'fail'
                ? Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'no' }) })
                : Promise.resolve({ ok: true, json: () => Promise.resolve({ roles }) });
        }
        if (url.includes('/api/local/admin/community-shape')) {
            if (init?.method !== 'POST') return shapeAnswer(join, lock);
            return Promise.resolve({ ok: save.ok, status: save.status ?? (save.ok ? 200 : 403), json: () => Promise.resolve(save.body) });
        }
        if (url.includes('/api/local/admin/node/config')) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
        }
        if (url.includes('/api/node/config')) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ publishLocation: true, serviceRadius: null, ...config }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

/** The door's saves: How this community works' route, the one place who can join changes (its GET is the read of it). */
const saveCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/api/local/admin/community-shape') && c[1]?.method === 'POST');
/** Node Identity's own save, which never carries the door. */
const configCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/api/local/admin/node/config'));

const radio = (name: RegExp) => screen.getByRole('radio', { name });
const saveButton = () => screen.getByRole('button', { name: /Save who may invite/ });

async function renderPanel(viewer: RolesViewer) {
    await act(async () => {
        render(<DoorSettingPanel activeNode={NODE} viewer={viewer} />);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('the presets', () => {
    it('two, each one door, in plain words: Invite is any member, Known is only admins; never a tier', () => {
        expect(DOOR_PRESETS.map((p) => [p.name, p.door, p.plain])).toEqual([
            ['Invite', 'members', 'any member invites'],
            ['Known', 'admins', 'only admins invite'],
        ]);
        for (const p of DOOR_PRESETS) expect(`${p.plain} ${p.detail}`).not.toMatch(/tier|Steward|Elder|Resident|Newcomer|badge/i);
    });

    it("Known says where the names list is: in the app, on an admin's own phone, with their key, not this password", () => {
        const known = DOOR_PRESETS.find((p) => p.door === 'admins')!;
        expect(known.detail).toMatch(/names list/);
        expect(known.detail).toMatch(/BeanPool app on their own phones, signed in with their key, not with this password/);
    });

    it('a door the node names, else none', () => {
        expect(readDoor('members')).toBe('members');
        expect(readDoor('admins')).toBe('admins');
        expect(readDoor('open')).toBe('open');
        for (const v of [undefined, null, 'everyone', true, 1]) expect(readDoor(v)).toBeNull();
    });

    it('closing the door says what happens to invites already out there', () => {
        const closing = doorChangeConsequence('members', 'admins');
        expect(closing).toMatch(/still work until they expire/);
        expect(closing).toMatch(/paper ticket a member made/);
        expect(doorChangeConsequence('admins', 'members')).toMatch(/Every member will be able to make invites/);
    });
});

describe('Who may invite, for an owner', () => {
    for (const [label, viewer] of [['the password', PASSWORD], ["an owner's key", OWNER_KEY]] as const) {
        it(`${label}: shows the door the node has, and saves Known alone`, async () => {
            const fetchMock = mockNode({ door: 'members', acceptKnocks: true });
            await renderPanel(viewer);
            await waitFor(() => expect(radio(/Invite: any member invites/)).toBeChecked());
            expect(radio(/Known: only admins invite/)).not.toBeChecked();
            expect(saveButton()).toBeDisabled();
            expect(screen.queryByText(/Only an owner of this community/)).toBeNull();

            await act(async () => { fireEvent.click(radio(/Known: only admins invite/)); });
            expect(radio(/Known: only admins invite/)).toBeChecked();
            expect(screen.getByText(doorChangeConsequence('members', 'admins'))).toBeInTheDocument();
            expect(saveButton()).not.toBeDisabled();

            await act(async () => { fireEvent.click(saveButton()); });
            const calls = saveCalls(fetchMock);
            expect(calls).toHaveLength(1);
            expect(calls[0][1].method).toBe('POST');
            // Who can join alone: the node keeps every other setting as it is.
            expect(JSON.parse(calls[0][1].body)).toEqual({ password: 'pw', changes: { join: 'admins' } });
            expect(calls[0][1].headers['X-Admin-Password']).toBe('pw');
            await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Only admins invite now, and every member is told.'));
            expect(saveButton()).toBeDisabled();
        });
    }

    it('back to Invite from Known', async () => {
        const fetchMock = mockNode({ door: 'admins' });
        await renderPanel(PASSWORD);
        await waitFor(() => expect(radio(/Known: only admins invite/)).toBeChecked());
        await act(async () => { fireEvent.click(radio(/Invite: any member invites/)); });
        await act(async () => { fireEvent.click(saveButton()); });
        expect(JSON.parse(saveCalls(fetchMock)[0][1].body).changes.join).toBe('members');
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Any member invites now, and every member is told.'));
    });

    it("a refusal is shown in the node's words, and the door stays as the node has it", async () => {
        mockNode({ door: 'members' }, { ok: false, status: 409, body: { error: 'The node said no.', code: 'door_set_by_profile' } });
        await renderPanel(PASSWORD);
        await waitFor(() => expect(radio(/Invite: any member invites/)).toBeChecked());
        await act(async () => { fireEvent.click(radio(/Known: only admins invite/)); });
        await act(async () => { fireEvent.click(saveButton()); });
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The node said no.'));
        expect(screen.getByText(/\(now\)/).closest('label')).toHaveTextContent(/Invite: any member invites/);
    });
});

describe('Who may invite, while no new members are being taken', () => {
    const PAUSED_NOTE = /no new members are being taken for now/;

    it('says the community is paused, marks no door as now, and saving a door says it takes new members again', async () => {
        const fetchMock = mockNode({ door: 'members' }, undefined, [ADMIN_ROW], 'paused');
        await renderPanel(OWNER_KEY);
        await waitFor(() => expect(screen.getByText(PAUSED_NOTE)).toBeInTheDocument());
        expect(screen.getByTestId('door-paused')).toHaveTextContent(/Saving a choice here takes new members again, and every member is told/);
        // The door row still reads members, but nobody invites while paused: no choice is shown as the one in use.
        expect(radio(/Invite: any member invites/)).not.toBeChecked();
        expect(radio(/Known: only admins invite/)).not.toBeChecked();
        expect(screen.queryByText(/\(now\)/)).toBeNull();
        expect(screen.getByText(/\(before the pause\)/).closest('label')).toHaveTextContent(/Invite: any member invites/);
        expect(saveButton()).toBeDisabled();

        await act(async () => { fireEvent.click(radio(/Known: only admins invite/)); });
        expect(screen.getByText(unpauseConsequence('admins'))).toBeInTheDocument();
        expect(unpauseConsequence('admins')).toMatch(/^New members will be taken again/);
        expect(screen.getByText(doorChangeConsequence('members', 'admins'))).toBeInTheDocument();
        expect(saveButton()).not.toBeDisabled();

        await act(async () => { fireEvent.click(saveButton()); });
        expect(saveCalls(fetchMock)).toHaveLength(1);
        expect(JSON.parse(saveCalls(fetchMock)[0][1].body)).toEqual({ password: 'pw', changes: { join: 'admins' } });
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved. New members are taken again: only admins invite, and every member is told.'));
        expect(screen.queryByText(PAUSED_NOTE)).toBeNull();
        expect(screen.getByText(/\(now\)/).closest('label')).toHaveTextContent(/Known: only admins invite/);
        expect(saveButton()).toBeDisabled();
    });

    it('the door it had before the pause can be saved too, which takes new members again with it', async () => {
        const fetchMock = mockNode({ door: 'members' }, undefined, [ADMIN_ROW], 'paused');
        await renderPanel(PASSWORD);
        await waitFor(() => expect(screen.getByText(PAUSED_NOTE)).toBeInTheDocument());
        await act(async () => { fireEvent.click(radio(/Invite: any member invites/)); });
        expect(screen.getByText(unpauseConsequence('members'))).toBeInTheDocument();
        expect(saveButton()).not.toBeDisabled();
        await act(async () => { fireEvent.click(saveButton()); });
        expect(JSON.parse(saveCalls(fetchMock)[0][1].body).changes).toEqual({ join: 'members' });
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved. New members are taken again: any member invites, and every member is told.'));
    });

    it('a node that will not say whether it is paused: the door is shown, and nothing is saved on a guess', async () => {
        const fetchMock = mockNode({ door: 'members' }, undefined, [ADMIN_ROW], 'fail');
        await renderPanel(OWNER_KEY);
        await waitFor(() => expect(screen.getByText(/Couldn't check whether new members are being taken here/)).toBeInTheDocument());
        await act(async () => { fireEvent.click(radio(/Known: only admins invite/)); });
        expect(saveButton()).toBeDisabled();
        await act(async () => { fireEvent.click(saveButton()); });
        expect(saveCalls(fetchMock)).toHaveLength(0);
    });

    it('taking new members: no pause note', async () => {
        mockNode({ door: 'admins' });
        await renderPanel(OWNER_KEY);
        await waitFor(() => expect(radio(/Known: only admins invite/)).toBeChecked());
        expect(screen.queryByText(PAUSED_NOTE)).toBeNull();
        expect(screen.queryByText(/Couldn't check whether new members are being taken here/)).toBeNull();
    });
});

describe('Who may invite, where the node locks it', () => {
    const NOTHING_CHANGED = 'Nothing changed: the node already had this, so nobody was told.';

    it('the lock in its own words, with what would unlock it', () => {
        expect(readJoinLock(null)).toBeNull();
        expect(readJoinLock(undefined)).toBeNull();
        expect(readJoinLock(PREVIEW_LOCK)).toEqual({ why: PREVIEW_LOCK.why, unlock: PREVIEW_LOCK.unlock });
        // A lock the node names without a reason still refuses: never read as no lock.
        expect(readJoinLock({ code: 'private_preview' })?.why).toMatch(/takes no change to who may invite/);
    });

    it('a private preview with the row at members: the lock is said first, no door is offered, and nothing is sent', async () => {
        // The door as it works is admins under the preview (doorFor); the row still says members.
        const fetchMock = mockNode({ door: 'admins' }, CHANGED, [ADMIN_ROW], 'members', PREVIEW_LOCK);
        await renderPanel(OWNER_KEY);
        await waitFor(() => expect(screen.getByTestId('door-locked')).toHaveTextContent(PREVIEW_LOCK.why));
        expect(screen.getByTestId('door-locked')).toHaveTextContent(PREVIEW_LOCK.unlock);
        const lockLine = screen.getByTestId('door-locked');
        const heading = screen.getByRole('heading', { name: /Who may invite/ });
        expect(heading.compareDocumentPosition(lockLine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(lockLine.compareDocumentPosition(radio(/Invite: any member invites/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // Gated, pointing at the lock's words, as a control that is not the viewer's.
        expect(radio(/Invite: any member invites/)).toHaveAttribute('aria-disabled', 'true');
        expect(radio(/Invite: any member invites/).getAttribute('aria-describedby')).toContain(lockLine.id);
        expect(saveButton()).toHaveAttribute('aria-disabled', 'true');

        await act(async () => { fireEvent.click(radio(/Invite: any member invites/)); });
        expect(radio(/Invite: any member invites/)).not.toBeChecked();
        expect(screen.queryByText(doorChangeConsequence('admins', 'members'))).toBeNull();
        await act(async () => { fireEvent.click(saveButton()); });
        expect(saveCalls(fetchMock)).toHaveLength(0);
        expect(screen.queryByText(/every member is told/)).toBeNull();
    });

    it('paused under the preview: the pause is said, but not that saving takes new members again', async () => {
        const fetchMock = mockNode({ door: 'admins' }, CHANGED, [ADMIN_ROW], 'paused', PREVIEW_LOCK);
        await renderPanel(PASSWORD);
        await waitFor(() => expect(screen.getByTestId('door-locked')).toHaveTextContent(PREVIEW_LOCK.why));
        expect(screen.getByTestId('door-paused')).toHaveTextContent(/no new members are being taken for now/);
        expect(screen.getByTestId('door-paused')).not.toHaveTextContent(/Saving a choice here/);
        await act(async () => { fireEvent.click(radio(/Known: only admins invite/)); });
        await act(async () => { fireEvent.click(saveButton()); });
        expect(saveCalls(fetchMock)).toHaveLength(0);
    });

    it('an admin on a locked node reads both reasons', async () => {
        mockNode({ door: 'admins' }, CHANGED, [ADMIN_ROW], 'members', PREVIEW_LOCK);
        await renderPanel(ADMIN_KEY);
        await waitFor(() => expect(screen.getByTestId('door-locked')).toBeInTheDocument());
        const described = saveButton().getAttribute('aria-describedby') ?? '';
        expect(described.split(' ')).toHaveLength(2);
        expect(described).toContain(screen.getByTestId('door-locked').id);
        expect(described).toContain(screen.getByText('Only an owner of this community can change who may invite.').id);
    });

    it('a 200 that told nobody changed nothing: never "every member is told", and the door stays as the node has it', async () => {
        const fetchMock = mockNode({ door: 'members' }, { ok: true, body: { shape: {}, told: 'nobody' } });
        await renderPanel(OWNER_KEY);
        await waitFor(() => expect(radio(/Invite: any member invites/)).toBeChecked());
        await act(async () => { fireEvent.click(radio(/Known: only admins invite/)); });
        await act(async () => { fireEvent.click(saveButton()); });
        expect(saveCalls(fetchMock)).toHaveLength(1);
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(NOTHING_CHANGED));
        expect(screen.queryByText(/every member is told/)).toBeNull();
        expect(screen.getByText(/\(now\)/).closest('label')).toHaveTextContent(/Invite: any member invites/);
    });

    it('a 200 that does not say who was told claims nobody was', async () => {
        mockNode({ door: 'members' }, { ok: true, body: { success: true } });
        await renderPanel(PASSWORD);
        await waitFor(() => expect(radio(/Invite: any member invites/)).toBeChecked());
        await act(async () => { fireEvent.click(radio(/Known: only admins invite/)); });
        await act(async () => { fireEvent.click(saveButton()); });
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(NOTHING_CHANGED));
        expect(screen.queryByText(/every member is told/)).toBeNull();
    });
});

describe('Who may invite, for an admin', () => {
    it('sees the door and why it is not theirs to change; nothing is sent', async () => {
        const fetchMock = mockNode({ door: 'members' });
        await renderPanel(ADMIN_KEY);
        await waitFor(() => expect(radio(/Invite: any member invites/)).toBeChecked());
        expect(screen.getByText('Only an owner of this community can change who may invite.')).toBeInTheDocument();
        // Gated, not disabled: still reachable, and says why.
        expect(radio(/Known: only admins invite/)).toHaveAttribute('aria-disabled', 'true');
        expect(saveButton()).toHaveAttribute('aria-disabled', 'true');
        await act(async () => { fireEvent.click(radio(/Known: only admins invite/)); });
        expect(radio(/Invite: any member invites/)).toBeChecked();
        await act(async () => { fireEvent.click(saveButton()); });
        expect(saveCalls(fetchMock)).toHaveLength(0);
    });
});

describe('nodes with no door to choose', () => {
    it('the global node: Open, set by its profile, with nothing to choose or save', async () => {
        const fetchMock = mockNode({ door: 'open' });
        await renderPanel(PASSWORD);
        await waitFor(() => expect(screen.getByText(/anyone joins with a sign-in, and nobody makes invites here/)).toBeInTheDocument());
        expect(screen.queryByRole('radio')).toBeNull();
        expect(screen.queryByRole('button', { name: /Save who may invite/ })).toBeNull();
        expect(saveCalls(fetchMock)).toHaveLength(0);
    });

    it('a node older than the door: nothing shown, nothing sent', async () => {
        const fetchMock = mockNode({});
        await renderPanel(PASSWORD);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.queryByText(/Who may invite/)).toBeNull();
        expect(saveCalls(fetchMock)).toHaveLength(0);
    });
});

describe('Node Identity: who answers a request to join follows the door', () => {
    const nodeConfigBody = (fetchMock: ReturnType<typeof vi.fn>) => {
        const call = configCalls(fetchMock)[0];
        return call ? JSON.parse(call[1].body) : undefined;
    };

    it('only admins invite: says only owners and admins answer, and Save Identity never sends the door', async () => {
        const fetchMock = mockNode({ door: 'admins', acceptKnocks: true });
        await act(async () => {
            render(<NodeIdentityPanel activeNode={NODE} diag={null} onRefreshDiag={vi.fn()} />);
        });
        await waitFor(() => expect(document.getElementById('accept-knocks')).toBeInTheDocument());
        await waitFor(() => expect(screen.getByText(/Only owners and admins can answer, since only they invite here/)).toBeInTheDocument());
        expect(screen.queryByText(/Any member can answer by inviting them/)).toBeNull();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save identity/i })); });
        expect(nodeConfigBody(fetchMock)).toBeDefined();
        expect('door' in nodeConfigBody(fetchMock)).toBe(false);
    });

    it('any member invites: as before', async () => {
        mockNode({ door: 'members', acceptKnocks: true });
        await act(async () => {
            render(<NodeIdentityPanel activeNode={NODE} diag={null} onRefreshDiag={vi.fn()} />);
        });
        await waitFor(() => expect(screen.getByText(/Any member can answer by inviting them/)).toBeInTheDocument());
        expect(screen.queryByText(/Only owners and admins can answer/)).toBeNull();
    });
});

describe('People & Safety → Invites & QR', () => {
    it('shows Who may invite above the invite generator, for the viewer Settings has', async () => {
        mockNode({ door: 'members' });
        await act(async () => {
            render(
                <PeopleSafetySection
                    activeNode={NODE}
                    nodeData={{ members: [] }}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    onFreezeUser={vi.fn()}
                    onPruneUser={vi.fn()}
                    onUpdateTier={vi.fn()}
                    onToggleVoucher={vi.fn()}
                    onToggleOperator={vi.fn()}
                    initialSubTab="invites"
                    rolesViewer={ADMIN_KEY}
                />
            );
        });
        const heading = await screen.findByRole('heading', { name: /Who may invite/ });
        const generator = screen.getByText(/Sovereign Node Invite Generator/);
        expect(heading.compareDocumentPosition(generator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByText('Only an owner of this community can change who may invite.')).toBeInTheDocument();
    });
});

describe('Known with nobody to act on it', () => {
    const WARNING = /Nobody here is an owner or admin in the app yet/;

    it('warns beside Known when no owner or admin holds a role, and still saves', async () => {
        const fetchMock = mockNode({ door: 'members' }, { ok: true, body: { success: true } }, [
            { member_pubkey: 'm'.repeat(64), role: 'moderator', granted_at: '2026-01-01', granted_by: null },
        ]);
        await renderPanel(OWNER_KEY);
        expect(await screen.findByText(WARNING)).toBeTruthy();
        expect(screen.getByText(WARNING).textContent).toMatch(/People & Safety/);
        await act(async () => { fireEvent.click(radio(/Known/)); });
        await act(async () => { fireEvent.click(saveButton()); });
        expect(saveCalls(fetchMock)).toHaveLength(1);
        expect(JSON.parse(saveCalls(fetchMock)[0][1].body).changes.join).toBe('admins');
    });

    it('says nothing when an owner or an admin holds a role', async () => {
        mockNode({ door: 'members' }, undefined, [ADMIN_ROW]);
        await renderPanel(OWNER_KEY);
        await waitFor(() => expect(screen.getByRole('radio', { name: /Known/ })).toBeTruthy());
        expect(screen.queryByText(WARNING)).toBeNull();
    });

    it('says nothing when the node would not give the roles', async () => {
        mockNode({ door: 'members' }, undefined, 'fail');
        await renderPanel(OWNER_KEY);
        await waitFor(() => expect(screen.getByRole('radio', { name: /Known/ })).toBeTruthy());
        expect(screen.queryByText(WARNING)).toBeNull();
    });
});
