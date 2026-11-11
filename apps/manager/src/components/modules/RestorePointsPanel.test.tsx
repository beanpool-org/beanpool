import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RestorePointsPanel, type RestorePointInfo } from './RestorePointsPanel';
import type { NodeProfile } from '../../lib/profiles';

// A real automation token's shape (bp_ + 12 hex + _ + 64 hex): only this travels as a Bearer.
const TOKEN = `bp_${'c'.repeat(12)}_${'d'.repeat(64)}`;
const node: NodeProfile = { id: 'home', name: 'Home', url: 'https://home.example.org', automationToken: TOKEN };
const POINTS: RestorePointInfo[] = [
    { name: '2026-10-16T02-30-00.123Z-before-restore', why: 'restore', takenAt: '2026-10-16T02:30:00.123Z', bytes: 3 * 1024 * 1024,
        keptAtLeastUntil: '2026-10-23T02:30:00.123Z', keptAtMostUntil: '2026-11-15T02:30:00.123Z' },
    { name: '2026-10-10T08-00-00.000Z-before-roll-back', why: 'roll-back', takenAt: '2026-10-10T08:00:00.000Z', bytes: 40 * 1024,
        keptAtLeastUntil: '2026-10-17T08:00:00.000Z', keptAtMostUntil: '2026-11-09T08:00:00.000Z' },
];

type Call = { path: string; method: string; headers: Record<string, string>; body: any };
function stubFetch(handler: (path: string, body: any) => { status: number; body: unknown }) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const path = url.replace(/^.*?\/api\//, '/api/');
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
        calls.push({ path, method: init?.method || 'GET', headers: (init?.headers || {}) as Record<string, string>, body });
        const r = handler(path, body);
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    }));
    return calls;
}

describe('RestorePointsPanel', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('lists the server\'s points (when, why, size, kept until), read-only: no delete, nothing removes one', async () => {
        const calls = stubFetch((path) => path === '/api/local/admin/restore-points' ? { status: 200, body: { points: POINTS } } : { status: 404, body: {} });
        render(<RestorePointsPanel activeNode={node} />);
        const rows = await screen.findAllByTestId('restore-point');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('Kept before a restore');
        expect(rows[0].textContent).toContain('3.0 MB');
        expect(rows[0].textContent).toContain(new Date('2026-10-23T02:30:00.123Z').toLocaleDateString());
        expect(rows[0].textContent).toContain(POINTS[0].name);
        expect(rows[1].textContent).toContain('Kept before a roll-back');
        expect(rows[1].textContent).toContain('40 KB');
        expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
        expect(screen.getAllByRole('button', { name: 'Roll back to this point' })).toHaveLength(2);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ path: '/api/local/admin/restore-points', method: 'GET' });
        expect(calls[0].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
        expect(calls[0].headers['X-Admin-Password']).toBeUndefined();
    });

    it('draws nothing for an admin and asks the server nothing (owners only, as the server)', async () => {
        const calls = stubFetch(() => ({ status: 403, body: {} }));
        const { container } = render(<RestorePointsPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' }} />);
        await act(async () => {});
        expect(container.innerHTML).toBe('');
        expect(calls).toHaveLength(0);
    });

    it('says when there are none, and when the list cannot be read', async () => {
        stubFetch(() => ({ status: 200, body: { points: [] } }));
        const view = render(<RestorePointsPanel activeNode={node} />);
        expect(await screen.findByText(/No restore points yet/)).toBeInTheDocument();
        view.unmount();
        stubFetch(() => ({ status: 500, body: { error: 'disk unreadable' } }));
        render(<RestorePointsPanel activeNode={node} />);
        expect(await screen.findByText('The restore points could not be listed: disk unreadable')).toBeInTheDocument();
    });

    it('Roll back opens the fresh-proof step in the page (no confirm()); the point\'s name goes to the server with no code and no password', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm');
        const calls = stubFetch((path, body) => {
            if (path === '/api/local/admin/restore-points') return { status: 200, body: { points: POINTS } };
            if (path === '/api/local/admin/restore-points/roll-back') {
                return { status: 200, body: { success: true, rolledBackTo: body.name,
                    restorePointNote: 'Restore point 2026-10-16T05-00-00.000Z-before-roll-back is kept until at least 2026-10-23.',
                    restartNote: 'The server restarts now; sign in again.' } };
            }
            return { status: 404, body: {} };
        });
        render(<RestorePointsPanel activeNode={node} />);
        fireEvent.click((await screen.findAllByRole('button', { name: 'Roll back to this point' }))[0]);
        const step = screen.getByTestId('roll-back-step');
        expect(step.textContent).toContain('A restore point of the server as it is now is taken first');
        // No authenticator-code field: a node has no second factor to type.
        expect(screen.queryByLabelText(/authenticator|current code/)).toBeNull();
        expect(step.querySelector('input')).toBeNull();
        expect(screen.getByText('From your phone: press Manage again, then roll back within 90 seconds.')).toBeInTheDocument();
        const roll = screen.getByRole('button', { name: 'Roll back' });
        expect(roll).toBeEnabled();
        fireEvent.click(roll);
        expect(await screen.findByText(/Rolled back to the restore point of/)).toBeInTheDocument();
        expect(screen.getByText(/Restore point 2026-10-16T05-00-00.000Z-before-roll-back is kept until at least 2026-10-23\. The server restarts now; sign in again\./)).toBeInTheDocument();
        const post = calls.find((c) => c.path === '/api/local/admin/restore-points/roll-back')!;
        expect(post.method).toBe('POST');
        // The request carries the point's name only: no code, no password.
        expect(post.body).toEqual({ name: POINTS[0].name });
        expect(post.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
        expect(post.headers['X-Admin-Password']).toBeUndefined();
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('an owner key viewer gets the same phone sentence (no code field), and the server\'s refusal in its own words', async () => {
        stubFetch((path) => {
            if (path === '/api/local/admin/restore-points') return { status: 200, body: { points: POINTS } };
            if (path === '/api/local/admin/restore-points/roll-back') return { status: 403, body: { error: 'Press Manage on your phone again, then do this within 90 seconds', code: 'step_up_required' } };
            return { status: 404, body: {} };
        });
        render(<RestorePointsPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' }} />);
        fireEvent.click((await screen.findAllByRole('button', { name: 'Roll back to this point' }))[1]);
        expect(screen.queryByLabelText(/current code/)).toBeNull();
        expect(screen.getByText(/press Manage again, then roll back within 90 seconds/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Press Manage on your phone again, then do this within 90 seconds');
        // Still in the step: nothing was changed, the owner can try again.
        await waitFor(() => expect(screen.getByTestId('roll-back-step')).toBeInTheDocument());
    });
});
