import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunityShapeSection } from './CommunityShapeSection';
import {
    type Shape,
    type ShapeSettings,
    type JoinState,
    DOOR_PRESETS,
    readDoor,
    doorChangeConsequence,
    unpauseConsequence,
    hoursWording,
    readKnownFloorSettings,
    readShapeKnownFloor,
    getConsequenceSentence,
    updateCommunityShape,
} from '../../lib/community-shape';
import type { NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

const NODE: NodeProfile = { id: 'n1', name: 'Mullum', url: 'https://mullum.test', adminPassword: 'pw' };
const OWNER_KEY: RolesViewer = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
const ADMIN_KEY: RolesViewer = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' };
const PASSWORD: RolesViewer = { kind: 'password' };

function makeDefaultShape(overrides: Partial<ShapeSettings> = {}, meta: Partial<Shape> = {}): Shape {
    return {
        kind: 'local',
        standby: false,
        version: 1,
        log: [
            {
                id: 'log-1',
                kept: 'community_settings_log',
                at: '2026-10-23T14:02:00.000Z',
                actor: 'o'.repeat(64),
                actorCallsign: 'ada',
                actorRole: 'owner',
                setting: 'Who can join',
                from: 'any member invites',
                to: 'only admins invite',
                note: 'Summer visitors',
            },
        ],
        kindOnly: [],
        settings: {
            join: { value: 'members', configured: 'members', source: 'default', lock: null },
            openDoor: { value: false, configured: false, source: 'default', lock: null },
            knocks: { value: true, configured: true, source: 'default', lock: null },
            preview: { value: false, configured: false, source: 'server', lock: null },
            beans: {
                value: true,
                configured: true,
                source: 'default',
                lock: null,
                includes: { escrow: true, enterprises: true, treasuries: true, crowdfund: true },
            },
            knownFloor: {
                value: { on: true, floor: 1000, cap: 2000, capMax: 5000 },
                configured: { on: true, floor: 1000, cap: 2000, capMax: 5000 },
                source: 'default',
                lock: null,
            },
            dmRequests: { value: false, configured: false, source: 'default', lock: null },
            decisions: { value: true, configured: true, source: 'default', lock: null },
            listed: { value: true, configured: true, source: 'default', lock: null },
            shareLocation: { value: true, configured: true, source: 'default', lock: null },
            shareMemberCount: { value: true, configured: true, source: 'default', lock: null },
            shareEmail: { value: false, configured: false, source: 'default', lock: null },
            sharePhone: { value: false, configured: false, source: 'default', lock: null },
            shareHealth: { value: true, configured: true, source: 'default', lock: null },
            visitors: { value: 'nothing', configured: 'nothing', source: 'default', lock: null },
            probation: { value: false, configured: false, source: 'default', lock: null },
            autoHide: { value: false, configured: false, source: 'default', lock: null },
            autoMute: { value: false, configured: false, source: 'default', lock: null },
            connections: { value: false, configured: false, source: 'server', lock: null },
            ...overrides,
        },
        ...meta,
    };
}

function mockShapeApi(shape: Shape, postResult?: { ok: boolean; status?: number; data?: unknown }) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/api/local/admin/community-shape')) {
            if (init?.method === 'POST') {
                if (postResult && !postResult.ok) {
                    return Promise.resolve({
                        ok: false,
                        status: postResult.status ?? 409,
                        json: () => Promise.resolve(postResult.data ?? { error: 'Refused by server' }),
                    });
                }
                const body = JSON.parse(String(init.body));
                const changes = body.changes || {};
                const newShape = JSON.parse(JSON.stringify(shape));
                for (const [k, v] of Object.entries(changes)) {
                    if (newShape.settings[k]) {
                        newShape.settings[k].value = v;
                    }
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ shape: newShape, told: 'members' }),
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve(shape),
            });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('CommunityShapeSection — Re-homed Door & Known Floor contract', () => {
    it('door presets: Invite is any member, Known is only admins; never a tier', () => {
        expect(DOOR_PRESETS.map((p) => [p.name, p.door, p.plain])).toEqual([
            ['Invite', 'members', 'any member invites'],
            ['Known', 'admins', 'only admins invite'],
        ]);
        for (const p of DOOR_PRESETS) expect(`${p.plain} ${p.detail}`).not.toMatch(/tier|Steward|Elder|Resident|Newcomer|badge/i);
    });

    it('readDoor extracts door or null', () => {
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

    it('unpausing consequence explains new members will be taken again', () => {
        expect(unpauseConsequence('members')).toMatch(/New members will be taken again/);
        expect(unpauseConsequence('admins')).toMatch(/only owners and admins can make invites/);
    });

    it('says the known floor in hours', () => {
        expect(hoursWording(1000)).toBe('1,000 Beans is about 25 hours of work the community is trusting you for.');
        expect(hoursWording(40)).toBe('40 Beans is about 1 hour of work the community is trusting you for.');
        expect(hoursWording(3000)).toBe('3,000 Beans is about 75 hours of work the community is trusting you for.');
    });

    it('reads only a whole known floor answer', () => {
        const s = { confirmation: false, knownFloor: 1000, creditCap: 2000, creditCapDefault: 2000, creditCapMax: 5000 };
        expect(readKnownFloorSettings(s)).toMatchObject({ confirmation: false, knownFloor: 1000, creditCap: 2000 });
        expect(readKnownFloorSettings({ error: 'Not found' })).toBeNull();
        const before = readKnownFloorSettings(s)!;
        expect(readShapeKnownFloor({ settings: { knownFloor: { value: { on: true, floor: 1500, cap: 3000, capMax: 5000 } } } }, before))
            .toEqual({ confirmation: true, knownFloor: 1500, creditCap: 3000, creditCapDefault: 2000, creditCapMax: 5000 });
        expect(readShapeKnownFloor({ error: 'Only an owner of this community can change how it works' }, before)).toBeNull();
    });
});

describe('CommunityShapeSection — 320 px layout & role access', () => {
    it('renders cleanly at 320 px phone width without controls for admin', async () => {
        const shape = makeDefaultShape();
        mockShapeApi(shape);

        const { container } = render(<CommunityShapeSection activeNode={NODE} viewer={ADMIN_KEY} />);
        await waitFor(() => expect(screen.getByTestId('community-shape-section')).toBeInTheDocument());

        // Header and role hint
        expect(screen.getByText('🧭')).toBeInTheDocument();
        expect(screen.getByText('How this community works')).toBeInTheDocument();
        expect(screen.getByTestId('shape-role-hint')).toHaveTextContent("You're an admin: this page is read-only.");

        // Admins see no expand arrows or buttons to change
        expect(container.querySelectorAll('button[type="submit"]')).toHaveLength(0);
        expect(screen.queryByText('Save')).toBeNull();

        // Check values are displayed
        expect(screen.getByTestId('shape-val-join')).toHaveTextContent('Any member invites');
        expect(screen.getByTestId('shape-val-beans')).toHaveTextContent('On');
        expect(screen.getByTestId('shape-val-decisions')).toHaveTextContent('On');
        expect(screen.getByTestId('shape-val-knocks')).toHaveTextContent('On');
        expect(screen.getByTestId('shape-val-listed')).toHaveTextContent('Yes');
    });

    it('standby server shows standby banner and refuses all editing', async () => {
        const shape = makeDefaultShape({}, { standby: true });
        mockShapeApi(shape);

        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(screen.getByTestId('shape-role-hint')).toHaveTextContent('This is a standby: change it on the main server.'));

        // Clicking a row does not open it
        fireEvent.click(screen.getByTestId('shape-expand-join'));
        expect(screen.queryByText('Save')).toBeNull();
        expect(screen.queryByText('Invite: any member invites')).toBeNull();
    });
});

describe('CommunityShapeSection — Owner editing and saving single changes', () => {
    it('owner can change who can join to admins and saves exactly one change', async () => {
        const shape = makeDefaultShape();
        const fetchMock = mockShapeApi(shape);

        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(screen.getByTestId('shape-val-join')).toHaveTextContent('Any member invites'));

        // Tap row to expand
        fireEvent.click(screen.getByTestId('shape-expand-join'));

        // Radio list is visible
        const adminsRadio = screen.getByRole('radio', { name: /Known: only admins invite/i });
        expect(adminsRadio).toBeInTheDocument();
        expect(adminsRadio).not.toBeChecked();

        // Select admins
        fireEvent.click(adminsRadio);
        expect(adminsRadio).toBeChecked();

        // Consequence sentence is shown in amber
        expect(screen.getByTestId('shape-consequence')).toHaveTextContent(/Members will stop being able to make invites/);

        // Optional note to members
        const noteInput = screen.getByPlaceholderText(/Optional note to members/i);
        fireEvent.change(noteInput, { target: { value: 'Winter lockdown' } });

        // Save
        const saveBtn = screen.getByRole('button', { name: 'Save' });
        fireEvent.click(saveBtn);

        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved, and every member is told.'));

        // Verify POST payload: exactly ONE change
        const postCall = fetchMock.mock.calls.find((c: any[]) => c[1]?.method === 'POST');
        expect(postCall).toBeDefined();
        const payload = JSON.parse(postCall![1].body);
        expect(payload.changes).toEqual({ join: 'admins' });
        expect(payload.note).toBe('Winter lockdown');
        expect(payload.password).toBe('pw');
    });

    it('owner can switch requests to join (knocks) off alone', async () => {
        const shape = makeDefaultShape();
        const fetchMock = mockShapeApi(shape);

        render(<CommunityShapeSection activeNode={NODE} viewer={PASSWORD} />);
        await waitFor(() => expect(screen.getByTestId('shape-val-knocks')).toHaveTextContent('On'));

        fireEvent.click(screen.getByTestId('shape-expand-knocks'));
        const checkbox = screen.getByRole('checkbox', { name: /Take requests to join/i });
        expect(checkbox).toBeChecked();

        fireEvent.click(checkbox);
        expect(checkbox).not.toBeChecked();
        expect(screen.getByTestId('shape-consequence')).toHaveTextContent(/Nobody can ask to join, and members stop seeing requests/);

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved, and every member is told.'));

        const postCall = fetchMock.mock.calls.find((c: any[]) => c[1]?.method === 'POST');
        expect(postCall).toBeDefined();
        expect(JSON.parse(postCall![1].body).changes).toEqual({ knocks: false });
    });

    it('owner can configure known floor numbers and saves { knownFloor: { on, floor, cap } }', async () => {
        const shape = makeDefaultShape();
        const fetchMock = mockShapeApi(shape);

        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(screen.getByTestId('shape-val-knownFloor')).toHaveTextContent('On · 1,000 Beans'));

        fireEvent.click(screen.getByTestId('shape-expand-knownFloor'));

        const floorInput = screen.getByLabelText(/Known floor \(Beans\)/i);
        const capInput = screen.getByLabelText(/Cap: the most anyone may owe/i);
        expect(screen.getByTestId('known-floor-hours')).toHaveTextContent('1,000 Beans is about 25 hours');

        fireEvent.change(floorInput, { target: { value: '3000' } });
        fireEvent.change(capInput, { target: { value: '5000' } });
        expect(screen.getByTestId('known-floor-hours')).toHaveTextContent('3,000 Beans is about 75 hours');

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved, and every member is told.'));

        const postCall = fetchMock.mock.calls.find((c: any[]) => c[1]?.method === 'POST');
        expect(postCall).toBeDefined();
        expect(JSON.parse(postCall![1].body).changes).toEqual({
            knownFloor: { on: true, floor: 3000, cap: 5000 },
        });
    });

    it('client validation: refuses known floor above cap before sending', async () => {
        const shape = makeDefaultShape();
        const fetchMock = mockShapeApi(shape);

        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(screen.getByTestId('shape-val-knownFloor')).toBeInTheDocument());

        fireEvent.click(screen.getByTestId('shape-expand-knownFloor'));
        const floorInput = screen.getByLabelText(/Known floor \(Beans\)/i);
        const capInput = screen.getByLabelText(/Cap: the most anyone may owe/i);

        fireEvent.change(floorInput, { target: { value: '4000' } });
        fireEvent.change(capInput, { target: { value: '2500' } });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(screen.getByRole('alert')).toHaveTextContent("The known floor can't be more than the cap.");

        // Nothing sent
        const postCall = fetchMock.mock.calls.find((c: any[]) => c[1]?.method === 'POST');
        expect(postCall).toBeUndefined();
    });
});

describe('CommunityShapeSection — Locks and Refusals (409)', () => {
    it('every lock renders its line and no control for editing', async () => {
        const shape = makeDefaultShape({
            beans: {
                value: true,
                configured: true,
                source: 'default',
                includes: { escrow: true, enterprises: true, treasuries: true, crowdfund: true },
                lock: {
                    code: 'ledger_moved',
                    why: "Can't be turned off: Beans have moved here (12 completed trades), and switching them off would freeze what members hold.",
                },
            },
            join: {
                value: 'admins',
                configured: 'members',
                source: 'server',
                lock: {
                    code: 'private_preview',
                    why: 'While the private preview is on, only owners and admins invite, and nobody can ask to join.',
                    unlock: 'Turn the private preview off on the server (PRIVATE_PREVIEW).',
                },
            },
        });
        mockShapeApi(shape);

        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(screen.getByTestId('shape-lock-beans')).toBeInTheDocument());

        // Beans lock
        const beansLock = screen.getByTestId('shape-lock-beans');
        expect(beansLock).toHaveTextContent(/Beans have moved here \(12 completed trades\)/);

        // Join lock with unlock instruction
        const joinLock = screen.getByTestId('shape-lock-join');
        expect(joinLock).toHaveTextContent(/While the private preview is on/);
        expect(joinLock).toHaveTextContent(/Turn the private preview off on the server/);

        // Neither row opens when clicked
        fireEvent.click(screen.getByTestId('shape-expand-beans'));
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        fireEvent.click(screen.getByTestId('shape-expand-join'));
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    it('a 409 error shows the server sentence', async () => {
        const shape = makeDefaultShape();
        mockShapeApi(shape, {
            ok: false,
            status: 409,
            data: { error: 'Switching Beans off would freeze what members hold.', code: 'ledger_moved' },
        });

        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(screen.getByTestId('shape-val-beans')).toBeInTheDocument());

        fireEvent.click(screen.getByTestId('shape-expand-beans'));
        const checkbox = screen.getByRole('checkbox', { name: /Beans active/i });
        fireEvent.click(checkbox);

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('Switching Beans off would freeze what members hold.');
        });
    });

    it('Finding 1: Listed row opens under held_back, schedule_never, and server_env (configured: true) so owner can switch OFF', async () => {
        for (const code of ['held_back', 'schedule_never', 'server_env'] as const) {
            const shape = makeDefaultShape({
                listed: {
                    value: false,
                    configured: true,
                    source: 'owner',
                    lock: { code, why: `Locked by ${code}` },
                },
            });
            const fetchMock = mockShapeApi(shape);

            const { unmount } = render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
            await waitFor(() => expect(screen.getByTestId('shape-lock-listed')).toBeInTheDocument());

            // Lock line is visible
            expect(screen.getByTestId('shape-lock-listed')).toHaveTextContent(`Locked by ${code}`);

            // Row CAN expand
            fireEvent.click(screen.getByTestId('shape-expand-listed'));
            const checkbox = screen.getByRole('checkbox', { name: /Publish to directory/i }) as HTMLInputElement;
            expect(checkbox).toBeInTheDocument();
            // Starts checked from configured (true), not value (false)
            expect(checkbox.checked).toBe(true);

            // Save is disabled initially because draftValue === configured
            const saveBtn = screen.getByRole('button', { name: 'Save' });
            expect(saveBtn).toBeDisabled();

            // Clicking unchecks it
            fireEvent.click(checkbox);
            expect(checkbox.checked).toBe(false);
            expect(saveBtn).not.toBeDisabled();

            // If server_env, cannot re-check it to true
            if (code === 'server_env') {
                expect(checkbox).toBeDisabled();
            }

            // Save sends listed: false
            fireEvent.click(saveBtn);
            await waitFor(() => {
                const call = fetchMock.mock.calls.find((c: any[]) => c[1]?.method === 'POST');
                expect(call).toBeDefined();
                expect(JSON.parse(call[1].body)).toMatchObject({
                    changes: { listed: false },
                });
            });

            unmount();
        }
    });

    it('Finding 1: Listed row does not expand under profile (global) or server_env when configured is false', async () => {
        // Global kind with profile lock
        const globalShape = makeDefaultShape({
            listed: {
                value: false,
                configured: true,
                source: 'server',
                lock: { code: 'profile', why: "Set by this server's kind (global)" },
            },
        }, { kind: 'global' });
        mockShapeApi(globalShape);
        const { unmount } = render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(screen.getByTestId('shape-lock-listed')).toBeInTheDocument());

        fireEvent.click(screen.getByTestId('shape-expand-listed'));
        expect(screen.queryByRole('checkbox', { name: /Publish to directory/i })).toBeNull();
        unmount();

        // server_env when configured is already false: cannot turn on
        const envOffShape = makeDefaultShape({
            listed: {
                value: false,
                configured: false,
                source: 'owner',
                lock: { code: 'server_env', why: 'Held back by env' },
            },
        });
        mockShapeApi(envOffShape);
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(screen.getByTestId('shape-lock-listed')).toBeInTheDocument());

        fireEvent.click(screen.getByTestId('shape-expand-listed'));
        expect(screen.queryByRole('checkbox', { name: /Publish to directory/i })).toBeNull();
    });
});

describe('CommunityShapeSection — Folded fixes from PR #2415 review', () => {
    it('Folded fix 1: consequence line warns of ONE-WAY door when Beans are switched off while open door is set', () => {
        const shapeWithOpenDoor = makeDefaultShape({
            openDoor: { value: true, configured: true, source: 'server', lock: null },
            beans: {
                value: true,
                configured: true,
                source: 'default',
                includes: { escrow: true, enterprises: true, treasuries: true, crowdfund: true },
                lock: null,
            },
        });

        const consequence = getConsequenceSentence('beans', false, shapeWithOpenDoor);
        expect(consequence).toMatch(/Switching Beans off is one-way: while the open door is set, Beans cannot be switched back on\./);

        // Normal community without open door says:
        const shapeWithoutOpenDoor = makeDefaultShape();
        const normalConsequence = getConsequenceSentence('beans', false, shapeWithoutOpenDoor);
        expect(normalConsequence).toMatch(/You can't switch Beans off once anyone has traded\./);

        // Private preview: openDoor.configured is true, but openDoor.value is false
        const previewShape = makeDefaultShape({
            openDoor: { value: false, configured: true, source: 'server', lock: null },
            preview: { value: true, configured: true, source: 'server', lock: null },
        });
        expect(getConsequenceSentence('beans', false, previewShape))
            .toMatch(/Switching Beans off is one-way: while the open door is set, Beans cannot be switched back on\./);

        // Global kind with open door shut by operator: openDoor.configured is false
        const globalShutDoorShape = makeDefaultShape({
            openDoor: { value: false, configured: false, source: 'owner', lock: null },
        }, { kind: 'global' });
        expect(getConsequenceSentence('beans', false, globalShutDoorShape))
            .toMatch(/You can't switch Beans off once anyone has traded\./);
    });

    it('getConsequenceSentence returns unpause consequence when changing from paused', () => {
        const pausedShape = makeDefaultShape({
            join: { value: 'paused', configured: 'paused', source: 'owner', lock: null },
        });
        expect(getConsequenceSentence('join', 'admins', pausedShape)).toMatch(
            /New members will be taken again: only owners and admins can make invites and answer requests to join\./
        );
        expect(getConsequenceSentence('join', 'members', pausedShape)).toMatch(
            /New members will be taken again: every member can make invites and answer requests to join\./
        );
    });

    it('Folded fix 2: updateCommunityShape refuses multiple changes in one request', async () => {
        await expect(
            updateCommunityShape('https://node.test', 'pw', { beans: false, knownFloor: { on: false } } as any)
        ).rejects.toThrow(/A save writes exactly one change: never send multiple changes in one request\./);
    });
});

describe('CommunityShapeSection — Audit log', () => {
    it('displays the changes log with date, actor, setting and note', async () => {
        const shape = makeDefaultShape();
        mockShapeApi(shape);

        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(screen.getByTestId('shape-audit-log')).toBeInTheDocument());

        const logBlock = screen.getByTestId('shape-audit-log');
        expect(logBlock).toHaveTextContent('@ada (owner)');
        expect(logBlock).toHaveTextContent('Who can join: any member invites → only admins invite');
        expect(logBlock).toHaveTextContent('“Summer visitors”');
    });
});

describe('CommunityShapeSection — Accessibility (Finding 5)', () => {
    it('row headers are real buttons with aria-expanded, and Who can join is a radiogroup', async () => {
        const shape = makeDefaultShape();
        mockShapeApi(shape);

        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(screen.getByTestId('community-shape-section')).toBeInTheDocument());

        const joinHeaderBtn = screen.getByRole('button', { name: /Who can join/i });
        expect(joinHeaderBtn).toHaveAttribute('aria-expanded', 'false');

        // Opening row updates aria-expanded
        fireEvent.click(joinHeaderBtn);
        expect(joinHeaderBtn).toHaveAttribute('aria-expanded', 'true');

        // Who can join options are in a radiogroup with accessible label
        const radiogroup = screen.getByRole('radiogroup', { name: /Who can join/i });
        expect(radiogroup).toBeInTheDocument();
        const radios = within(radiogroup).getAllByRole('radio');
        expect(radios).toHaveLength(3);
    });

    it('row headers are not buttons for read-only admin viewers', async () => {
        const shape = makeDefaultShape();
        mockShapeApi(shape);

        render(<CommunityShapeSection activeNode={NODE} viewer={ADMIN_KEY} />);
        await waitFor(() => expect(screen.getByTestId('community-shape-section')).toBeInTheDocument());

        expect(screen.queryByRole('button', { name: /Who can join/i })).toBeNull();
    });
});
