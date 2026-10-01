import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DoorSettingPanel, DOOR_PRESETS, doorChangeConsequence, readDoor } from './DoorSettingPanel';
import { NodeIdentityPanel } from './NodeIdentityPanel';
import { PeopleSafetySection } from './PeopleSafetySection';
import type { NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * People & Safety → Invites & QR → "Who may invite" (the door, community modes slice 1; apps/server config/door.ts):
 * the presets Invite (any member invites) and Known (only admins invite), read from /api/node/config and saved alone
 * by an owner. A node older than the door shows nothing; the global node's open door is shown, not offered.
 */

const NODE: NodeProfile = { id: 'n1', name: 'Mullum', url: 'https://mullum.test', adminPassword: 'pw' };
const OWNER_KEY: RolesViewer = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
const ADMIN_KEY: RolesViewer = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' };
const PASSWORD: RolesViewer = { kind: 'password' };

type Answer = { ok: boolean; status?: number; body: unknown };

function mockNode(config: Record<string, unknown>, save: Answer = { ok: true, body: { success: true } }) {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/local/admin/node/config')) {
            return Promise.resolve({ ok: save.ok, status: save.status ?? (save.ok ? 200 : 403), json: () => Promise.resolve(save.body) });
        }
        if (url.includes('/api/node/config')) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ publishLocation: true, serviceRadius: null, ...config }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const saveCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
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
            // The door alone: the node keeps every other setting as it is.
            expect(JSON.parse(calls[0][1].body)).toEqual({ password: 'pw', door: 'admins' });
            expect(calls[0][1].headers['X-Admin-Password']).toBe('pw');
            await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Only admins invite now.'));
            expect(saveButton()).toBeDisabled();
        });
    }

    it('back to Invite from Known', async () => {
        const fetchMock = mockNode({ door: 'admins' });
        await renderPanel(PASSWORD);
        await waitFor(() => expect(radio(/Known: only admins invite/)).toBeChecked());
        await act(async () => { fireEvent.click(radio(/Invite: any member invites/)); });
        await act(async () => { fireEvent.click(saveButton()); });
        expect(JSON.parse(saveCalls(fetchMock)[0][1].body).door).toBe('members');
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Any member invites now.'));
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
        const call = saveCalls(fetchMock)[0];
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
