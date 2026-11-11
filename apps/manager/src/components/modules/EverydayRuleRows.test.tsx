import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EverydayRuleRows } from './EverydayRuleRows';
import type { Shape } from '../../lib/community-shape';
import type { NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

const NODE: NodeProfile = { id: 'n1', name: 'Mullum', url: 'https://mullum.test', adminPassword: 'pw' };
const OWNER: RolesViewer = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
const ADMIN: RolesViewer = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' };

const on = (v: boolean) => ({ value: v, configured: v, source: 'default', lock: null });

function shapeOf(over: Record<string, unknown> = {}, meta: Partial<Shape> = {}): Shape {
    return {
        kind: 'local', standby: false, version: 1, kindOnly: [],
        core: { settings: [], lock: { at: '2026-11-03T10:00:00.000Z', by: 'k', byCallsign: 'ada' }, place: { needed: true, set: true } },
        log: [
            { id: '1', kept: 'community_settings_log', at: '2026-11-02T10:00:00.000Z', actor: 'o'.repeat(64), actorCallsign: 'ada', actorRole: 'owner', setting: 'shareEmail', from: 'off', to: 'on', note: null },
            { id: '2', kept: 'community_settings_log', at: '2026-11-02T11:00:00.000Z', actor: 'o'.repeat(64), actorCallsign: 'ada', actorRole: 'owner', setting: 'beans', from: 'on', to: 'off', note: null },
        ],
        settings: {
            join: { value: 'members', configured: 'members', source: 'default', lock: null, door: 'members' },
            openDoor: on(false), knocks: on(true), preview: on(false), beans: on(true),
            knownFloor: { value: { on: true, floor: 1000, cap: 2000, capMax: 5000 }, configured: {}, source: 'default', lock: null },
            dmRequests: on(false), decisions: on(true), listed: on(true),
            shareLocation: on(true), shareMemberCount: on(true), shareEmail: on(false), sharePhone: on(false), shareHealth: on(true),
            visitors: { value: 'nothing', configured: 'nothing', source: 'default', lock: null },
            probation: on(false), autoHide: on(false), autoMute: on(false), connections: on(false),
            ...over,
        } as any,
        ...meta,
    };
}

function mockApi(shape: Shape, post?: { ok: boolean; status: number; body: unknown }) {
    const sent: any[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            sent.push(JSON.parse(String(init.body)));
            const r = post ?? { ok: true, status: 200, body: { shape, told: 'members' } };
            return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body), clone() { return this; } });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(shape) });
    }));
    return sent;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('EverydayRuleRows — the rules that moved to where they are used', () => {
    it('Invites & QR: Pause new members and Requests to join, and nothing of the door', async () => {
        mockApi(shapeOf());
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="taking" title="Taking new members" />);
        expect(await screen.findByTestId('shape-row-pause')).toHaveTextContent('Taking new members');
        expect(screen.getByTestId('shape-val-knocks')).toHaveTextContent('On');
        expect(screen.queryByTestId('shape-row-join')).toBeNull();
    });

    it('pausing asks no fresh proof, even with the core settings locked, and sends join: paused alone', async () => {
        const sent = mockApi(shapeOf());
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="taking" title="Taking new members" />);
        fireEvent.click(await screen.findByTestId('shape-expand-pause'));
        fireEvent.click(screen.getByRole('checkbox', { name: /Pause new members/ }));
        expect(screen.getByTestId('shape-consequence')).toHaveTextContent(/Nobody new will join until you change this/);
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].changes).toEqual({ join: 'paused' });
        expect(sent[0].code).toBeUndefined();
        expect(screen.queryByTestId('fresh-proof-input')).toBeNull();
    });

    it('un-pausing lands on the same door without asking', async () => {
        const sent = mockApi(shapeOf({ join: { value: 'paused', configured: 'paused', source: 'owner', lock: null, door: 'admins' } }));
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="taking" title="Taking new members" />);
        expect(await screen.findByTestId('shape-val-pause')).toHaveTextContent('Paused');
        fireEvent.click(screen.getByTestId('shape-expand-pause'));
        fireEvent.click(screen.getByRole('checkbox', { name: /Pause new members/ }));
        expect(screen.getByTestId('shape-consequence')).toHaveTextContent(/only owners and admins can make invites/);
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].changes).toEqual({ join: 'admins' });
    });

    it('Requests to join switches off alone', async () => {
        const sent = mockApi(shapeOf());
        render(<EverydayRuleRows activeNode={NODE} viewer={{ kind: 'password' }} group="taking" title="Taking new members" />);
        fireEvent.click(await screen.findByTestId('shape-expand-knocks'));
        const box = screen.getByRole('checkbox', { name: /Take requests to join/i });
        expect(box).toBeChecked();
        fireEvent.click(box);
        expect(screen.getByTestId('shape-consequence')).toHaveTextContent(/Nobody can ask to join, and members stop seeing requests/);
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved, and every member is told.'));
        expect(sent[0].changes).toEqual({ knocks: false });
    });

    it('Triage & Moderation: the four rules, each saved alone', async () => {
        const sent = mockApi(shapeOf());
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="rules" title="Rules the server applies" />);
        for (const id of ['dmRequests', 'probation', 'autoHide', 'autoMute']) {
            expect(await screen.findByTestId(`shape-row-${id}`)).toBeInTheDocument();
        }
        expect(screen.getByTestId('shape-val-dmRequests')).toHaveTextContent('Arrives straight away');
        fireEvent.click(screen.getByTestId('shape-expand-autoMute'));
        fireEvent.click(screen.getByRole('checkbox', { name: /Mute members after repeat removals/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].changes).toEqual({ autoMute: true });
    });

    it('Keep members\' locked contact lists: a rule the server applies, switched off alone with what it deletes said first', async () => {
        const sent = mockApi(shapeOf({ contacts: on(true) }));
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="rules" title="Rules the server applies" />);
        expect(await screen.findByTestId('shape-row-contacts')).toHaveTextContent("Keep members' locked contact lists");
        expect(screen.getByTestId('shape-val-contacts')).toHaveTextContent('On');
        fireEvent.click(screen.getByTestId('shape-expand-contacts'));
        fireEvent.click(screen.getByRole('checkbox', { name: /Keep members' locked contact lists/ }));
        expect(screen.getByTestId('shape-consequence')).toHaveTextContent(/deletes the locked copies it keeps now/);
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].changes).toEqual({ contacts: false });
    });

    it('a server from before private contacts sends no contacts setting: no such row', async () => {
        mockApi(shapeOf());
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="rules" title="Rules the server applies" />);
        expect(await screen.findByTestId('shape-row-autoMute')).toBeInTheDocument();
        expect(screen.queryByTestId('shape-row-contacts')).toBeNull();
    });

    it('Node Identity: the directory switches, visitors and the private preview, read-only where the server holds them', async () => {
        mockApi(shapeOf());
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="found" title="Being found" />);
        for (const id of ['listed', 'shareLocation', 'shareMemberCount', 'shareEmail', 'sharePhone', 'shareHealth', 'visitors', 'preview']) {
            expect(await screen.findByTestId(`shape-row-${id}`)).toBeInTheDocument();
        }
        expect(screen.getByTestId('shape-val-listed')).toHaveTextContent('Yes');
        expect(screen.queryByTestId('shape-expand-visitors')?.tagName).toBe('DIV');
        expect(screen.queryByTestId('shape-expand-preview')?.tagName).toBe('DIV');
    });

    it('Node Identity: the person check on busy days is a row where the global kind has it, and switches off alone', async () => {
        const sent = mockApi(shapeOf({ doorCheck: on(true) }, { kind: 'global' }));
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="found" title="Being found" />);
        expect(await screen.findByTestId('shape-row-doorCheck')).toHaveTextContent('A person check on busy days');
        expect(screen.getByTestId('shape-val-doorCheck')).toHaveTextContent('On');
        fireEvent.click(screen.getByTestId('shape-expand-doorCheck'));
        fireEvent.click(screen.getByRole('checkbox', { name: /Ask for a person check on busy days/i }));
        expect(screen.getByTestId('shape-consequence')).toHaveTextContent('A 12-words join will never ask for a Cloudflare check.');
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].changes).toEqual({ doorCheck: false });
    });

    it('a shape with no doorCheck (a local community) draws no such row', async () => {
        mockApi(shapeOf());
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="found" title="Being found" />);
        await screen.findByTestId('shape-row-listed');
        expect(screen.queryByTestId('shape-row-doorCheck')).toBeNull();
    });

    it('Listed opens under held_back, schedule_never and server_env (configured), so an owner can switch it off', async () => {
        for (const code of ['held_back', 'schedule_never', 'server_env'] as const) {
            const sent = mockApi(shapeOf({ listed: { value: false, configured: true, source: 'owner', lock: { code, why: `Locked by ${code}` } } }));
            const { unmount } = render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="found" title="Being found" />);
            expect(await screen.findByTestId('shape-lock-listed')).toHaveTextContent(`Locked by ${code}`);
            fireEvent.click(screen.getByTestId('shape-expand-listed'));
            const box = screen.getByRole('checkbox', { name: /Publish to directory/i }) as HTMLInputElement;
            expect(box.checked).toBe(true);
            expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
            fireEvent.click(box);
            if (code === 'server_env') expect(box).toBeDisabled();
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await waitFor(() => expect(sent).toHaveLength(1));
            expect(sent[0].changes).toEqual({ listed: false });
            unmount();
            vi.unstubAllGlobals();
        }
    });

    it('Listed does not open under a profile lock', async () => {
        mockApi(shapeOf({ listed: { value: false, configured: true, source: 'server', lock: { code: 'profile', why: "Set by this server's kind (global)" } } }, { kind: 'global' }));
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="found" title="Being found" />);
        await screen.findByTestId('shape-lock-listed');
        fireEvent.click(screen.getByTestId('shape-expand-listed'));
        expect(screen.queryByRole('checkbox', { name: /Publish to directory/i })).toBeNull();
    });

    it('each card shows its own Changes lines, not another card\'s', async () => {
        mockApi(shapeOf());
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="found" title="Being found" />);
        const log = await screen.findByTestId('shape-audit-log');
        expect(log).toHaveTextContent('Share email: Off → On');
        expect(log).not.toHaveTextContent('Beans');
    });

    it('an admin reads and has no control; a standby says to change it on the main server', async () => {
        mockApi(shapeOf());
        const { unmount } = render(<EverydayRuleRows activeNode={NODE} viewer={ADMIN} group="taking" title="Taking new members" />);
        expect(await screen.findByTestId('everyday-taking-hint')).toHaveTextContent("You're an admin: this card is read-only.");
        expect(screen.queryByTestId('shape-expand-knocks')?.tagName).toBe('DIV');
        unmount();
        mockApi(shapeOf({}, { standby: true }));
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="taking" title="Taking new members" />);
        expect(await screen.findByTestId('everyday-taking-hint')).toHaveTextContent('This is a standby: change it on the main server.');
    });

    it('an answer that is not a shape is a failed load with Retry, never a crash', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }));
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="rules" title="Rules the server applies" />);
        expect(await screen.findByText('Could not load these rules.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('Connections is one read-only line the server sets', async () => {
        mockApi(shapeOf());
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="connections" title="Connections to other communities" />);
        expect(await screen.findByTestId('shape-row-connections')).toHaveTextContent('Set on the server');
    });
});
