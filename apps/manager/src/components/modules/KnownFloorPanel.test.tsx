import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnownFloorPanel, hoursWording, readKnownFloorSettings, readShapeKnownFloor } from './KnownFloorPanel';
import type { NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * People & Safety → "The known floor" (community modes slice 4): the dial, the known floor and the cap, saved by an owner
 * under How this community works (POST /api/local/admin/community-shape `knownFloor`, slice S2).
 */

const NODE: NodeProfile = { id: 'n1', name: 'Mullum', url: 'https://mullum.test', adminPassword: 'pw' };
const OWNER_KEY: RolesViewer = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
const ADMIN_KEY: RolesViewer = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' };
const SETTINGS = { confirmation: false, knownFloor: 1000, creditCap: 2000, knownFloorDefault: 1000, creditCapDefault: 2000, creditCapMax: 5000 };

function mockNode(
    read: { ok: boolean; status?: number; body: unknown } = { ok: true, body: SETTINGS },
    config: { ok?: boolean; status?: number; body?: unknown } = { ok: true, body: {} }
) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/api/local/admin/community-shape') && init?.method === 'POST') {
            const kf = JSON.parse(String(init.body)).changes.knownFloor;
            const value = { on: kf.on ?? SETTINGS.confirmation, floor: kf.floor ?? SETTINGS.knownFloor, cap: kf.cap ?? SETTINGS.creditCap, capMax: 5000 };
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ shape: { settings: { knownFloor: { value } } }, told: 'members' }) });
        }
        if (url.includes('/api/local/admin/known-floor')) {
            return Promise.resolve({ ok: read.ok, status: read.status ?? 200, json: () => Promise.resolve(read.body) });
        }
        if (url.includes('/api/node/config')) {
            return Promise.resolve({ ok: config.ok ?? true, status: config.status ?? 200, json: () => Promise.resolve(config.body ?? {}) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('KnownFloorPanel', () => {
    beforeEach(() => { vi.unstubAllGlobals(); });

    it('says the known floor in hours', () => {
        expect(hoursWording(1000)).toBe('1,000 Beans is about 25 hours of work the community is trusting you for.');
        expect(hoursWording(40)).toBe('40 Beans is about 1 hour of work the community is trusting you for.');
        expect(hoursWording(3000)).toBe('3,000 Beans is about 75 hours of work the community is trusting you for.');
    });

    it('reads only a whole answer', () => {
        expect(readKnownFloorSettings(SETTINGS)).toMatchObject({ confirmation: false, knownFloor: 1000, creditCap: 2000 });
        expect(readKnownFloorSettings({ error: 'Not found' })).toBeNull();
        const before = readKnownFloorSettings(SETTINGS)!;
        expect(readShapeKnownFloor({ settings: { knownFloor: { value: { on: true, floor: 1500, cap: 3000, capMax: 5000 } } } }, before))
            .toEqual({ confirmation: true, knownFloor: 1500, creditCap: 3000, creditCapDefault: 2000, creditCapMax: 5000 });
        expect(readShapeKnownFloor({ error: 'Only an owner of this community can change how it works' }, before)).toBeNull();
    });

    it('shows nothing on a node older than the known floor', async () => {
        const f = mockNode({ ok: false, status: 404, body: { error: 'Not found' } });
        const { container } = render(<KnownFloorPanel activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(f).toHaveBeenCalled());
        expect(container.querySelector('[data-testid="known-floor-panel"]')).toBeNull();
    });

    it('an owner turns the dial on and saves the two numbers', async () => {
        const f = mockNode();
        render(<KnownFloorPanel activeNode={NODE} viewer={OWNER_KEY} />);
        expect(await screen.findByTestId('known-floor-hours')).toHaveTextContent('1,000 Beans is about 25 hours');
        fireEvent.click(screen.getByLabelText(/Confirmed members get the known floor/));
        fireEvent.change(screen.getByLabelText(/Known floor \(Beans\)/), { target: { value: '3000' } });
        fireEvent.change(screen.getByLabelText(/Cap: the most anyone may owe/), { target: { value: '5000' } });
        expect(screen.getByTestId('known-floor-hours')).toHaveTextContent('3,000 Beans is about 75 hours');
        fireEvent.click(screen.getByRole('button', { name: 'Save the known floor' }));
        await screen.findByText('Saved.');
        const post = f.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
        expect(String(post![0])).toContain('/api/local/admin/community-shape');
        expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ changes: { knownFloor: { on: true, floor: 3000, cap: 5000 } } });
    });

    it('a community as it starts: the dial on, saying what a confirmation gives, and an owner switches it off', async () => {
        const f = mockNode({ ok: true, body: { ...SETTINGS, confirmation: true } });
        render(<KnownFloorPanel activeNode={NODE} viewer={OWNER_KEY} />);
        const dial = await screen.findByLabelText(/Confirmed members get the known floor/);
        expect(dial).toBeChecked();
        expect(screen.getByTestId('known-floor-panel')).toHaveTextContent('On in every community with Beans unless an owner switches it off.');
        expect(screen.getByTestId('known-floor-panel')).toHaveTextContent(
            'confirm a member on the names list, in the app, and their limit grows by up to 1,000 Beans, your community’s known floor.');
        fireEvent.click(dial);
        fireEvent.click(screen.getByRole('button', { name: 'Save the known floor' }));
        await screen.findByText('Saved.');
        const post = f.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
        expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ changes: { knownFloor: { on: false } } });
    });

    it('refuses a known floor above the cap before sending it', async () => {
        const f = mockNode();
        render(<KnownFloorPanel activeNode={NODE} viewer={OWNER_KEY} />);
        await screen.findByTestId('known-floor-panel');
        fireEvent.change(screen.getByLabelText(/Known floor \(Beans\)/), { target: { value: '2500' } });
        expect(screen.getByRole('alert')).toHaveTextContent("can't be more than the cap");
        expect(screen.getByRole('button', { name: 'Save the known floor' })).toBeDisabled();
        expect(f.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    });

    it('an admin sees the numbers and why they are not theirs to change', async () => {
        const f = mockNode();
        render(<KnownFloorPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        expect(await screen.findByText('Only an owner of this community can change the known floor or the cap.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Save the known floor' }));
        expect(f.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    });

    describe('mixed community note', () => {
        it('shows the note when the door is members (invite door)', async () => {
            mockNode({ ok: true, body: SETTINGS }, { ok: true, body: { door: 'members' } });
            render(<KnownFloorPanel activeNode={NODE} viewer={OWNER_KEY} />);
            expect(await screen.findByTestId('known-floor-mixed-note')).toHaveTextContent(
                'A mixed community: anyone a member invites can join, and members your admins confirm start with a higher limit, unless an owner switches the known floor off.'
            );
        });

        it('hides the note when the door is open (global profile / no beans)', async () => {
            mockNode({ ok: true, body: SETTINGS }, { ok: true, body: { door: 'open' } });
            render(<KnownFloorPanel activeNode={NODE} viewer={OWNER_KEY} />);
            await screen.findByTestId('known-floor-panel');
            expect(screen.queryByTestId('known-floor-mixed-note')).toBeNull();
            expect(screen.queryByText(/mixed community/i)).toBeNull();
        });

        it('hides the note when the door is admins (only admins invite)', async () => {
            mockNode({ ok: true, body: SETTINGS }, { ok: true, body: { door: 'admins' } });
            render(<KnownFloorPanel activeNode={NODE} viewer={OWNER_KEY} />);
            await screen.findByTestId('known-floor-panel');
            expect(screen.queryByTestId('known-floor-mixed-note')).toBeNull();
            expect(screen.queryByText(/mixed community/i)).toBeNull();
        });
    });
});
