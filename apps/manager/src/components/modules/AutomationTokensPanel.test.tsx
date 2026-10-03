import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AutomationTokensPanel } from './AutomationTokensPanel';
import type { NodeProfile } from '../../lib/profiles';

const node: NodeProfile = {
    id: 'local-node',
    name: 'Mullumbimby Node',
    url: 'http://localhost:8080',
    adminPassword: 'test-password',
};

const NEW_TOKEN = 'bp_abc123_SECRETSECRETSECRETSECRET';

const row = {
    id: 'abc123',
    name: 'Nightly backups',
    scope: 'backups' as const,
    createdBy: 'owner:password',
    createdAt: Date.UTC(2026, 8, 20),
    expiresAt: null,
    lastUsedAt: Date.UTC(2026, 9, 1),
    lastUsedRoute: 'GET /api/local/admin/snapshots',
};

type Call = { url: string; init?: RequestInit };

/** A fake node: the list is whatever `state.tokens` holds; making pushes a row; revoking removes it. */
function fakeNode(state: { tokens: unknown[]; makeStatus?: number; makeBody?: unknown }) {
    const calls: Call[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const method = init?.method ?? 'GET';
        if (url.endsWith('/api/local/admin/automation-tokens') && method === 'GET') {
            return new Response(JSON.stringify({ tokens: state.tokens, scopes: ['read', 'backups', 'admin'] }), { status: 200 });
        }
        if (url.endsWith('/api/local/admin/automation-tokens') && method === 'POST') {
            if (state.makeStatus && state.makeStatus !== 201) {
                return new Response(JSON.stringify(state.makeBody ?? { error: 'bad' }), { status: state.makeStatus });
            }
            state.tokens = [...state.tokens, row];
            return new Response(JSON.stringify({ token: NEW_TOKEN, record: row }), { status: 201 });
        }
        const revoke = url.match(/automation-tokens\/([^/]+)\/revoke$/);
        if (revoke) {
            state.tokens = state.tokens.filter((t: any) => t.id !== revoke[1]);
            return new Response(JSON.stringify({ revoked: revoke[1] }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
    });
    return calls;
}

describe('AutomationTokensPanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('an owner (key or password) sees the card; an admin and a moderator do not, and nothing is fetched for them', async () => {
        const calls = fakeNode({ tokens: [] });
        const { unmount } = render(<AutomationTokensPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' }} />);
        expect(await screen.findByText('Automation tokens')).toBeInTheDocument();
        expect(screen.getByText(/never makes\s+owner-only changes/i)).toBeInTheDocument();
        unmount();

        const second = render(<AutomationTokensPanel activeNode={node} />);
        expect(await screen.findByText('Automation tokens')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByText('No tokens yet.')).toBeInTheDocument());
        second.unmount();

        calls.length = 0;
        for (const role of ['admin', 'moderator'] as const) {
            const view = render(<AutomationTokensPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role }} />);
            expect(view.container).toBeEmptyDOMElement();
            expect(screen.queryByText('Automation tokens')).not.toBeInTheDocument();
            view.unmount();
        }
        expect(calls).toEqual([]);
    });

    it('makes a token: sent with name, scope and an expiry; shown once with Copy; Done hides it', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const calls = fakeNode({ tokens: [] });
        render(<AutomationTokensPanel activeNode={node} />);
        await screen.findByText('No tokens yet.');

        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly backups' } });
        fireEvent.change(screen.getByLabelText('What it can do'), { target: { value: 'backups' } });
        fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '30' } });
        const before = Date.now();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Make token' })); });

        const post = calls.find((c) => c.init?.method === 'POST');
        expect(post).toBeTruthy();
        const sent = JSON.parse(String(post!.init!.body));
        expect(sent.name).toBe('Nightly backups');
        expect(sent.scope).toBe('backups');
        expect(sent.expiresAt).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
        expect(sent.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000);
        expect((post!.init!.headers as Record<string, string>)['X-Admin-Password']).toBe('test-password');

        expect(screen.getByTestId('automation-token-value')).toHaveTextContent(NEW_TOKEN);
        expect(screen.getByText('Copy it now: it is not shown again.')).toBeInTheDocument();

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
        expect(writeText).toHaveBeenCalledWith(NEW_TOKEN);

        // The list carries the new row, but never the secret.
        expect(screen.getAllByTestId('automation-token-row')).toHaveLength(1);

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
        expect(screen.queryByTestId('automation-token-value')).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain('SECRETSECRET');
        expect(document.body.textContent).not.toContain(NEW_TOKEN);
        expect(screen.getByRole('button', { name: 'Make token' })).toBeInTheDocument();
    });

    it('a name is required, and no expiry is sent for "never"', async () => {
        const calls = fakeNode({ tokens: [] });
        render(<AutomationTokensPanel activeNode={node} />);
        await screen.findByText('No tokens yet.');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Make token' })); });
        expect(screen.getByRole('alert')).toHaveTextContent(/Give the token a name/);
        expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);

        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dash' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Make token' })); });
        const sent = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body));
        expect(sent).toEqual({ name: 'Dash', scope: 'read' });
    });

    it('shows the node\'s own words when it refuses (step_up_required) and shows no token', async () => {
        fakeNode({ tokens: [], makeStatus: 403, makeBody: { error: 'Press Manage on your phone again to do this', code: 'step_up_required' } });
        render(<AutomationTokensPanel activeNode={node} />);
        await screen.findByText('No tokens yet.');
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dash' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Make token' })); });
        expect(screen.getByRole('alert')).toHaveTextContent('Press Manage on your phone again to do this');
        expect(screen.queryByTestId('automation-token-value')).not.toBeInTheDocument();
    });

    it('the list shows name, scope, made, last used with its route, and expiry, and never a secret', async () => {
        fakeNode({ tokens: [row, { ...row, id: 'def456', name: 'Fleet manager', scope: 'read', lastUsedAt: null, lastUsedRoute: null, expiresAt: Date.UTC(2027, 0, 5) }] });
        render(<AutomationTokensPanel activeNode={node} />);
        const rows = await screen.findAllByTestId('automation-token-row');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveTextContent('Nightly backups');
        expect(rows[0]).toHaveTextContent('Backups');
        expect(rows[0]).toHaveTextContent('GET /api/local/admin/snapshots');
        expect(rows[0]).toHaveTextContent('Expires: never');
        expect(rows[1]).toHaveTextContent('Fleet manager');
        expect(rows[1]).toHaveTextContent('Last used: never');
        expect(rows[1]).not.toHaveTextContent('Expires: never');
        expect(document.body.textContent).not.toMatch(/bp_/);
        // Every control is full width and wraps: no fixed widths.
        expect(screen.getByLabelText('Name').className).toContain('w-full');
    });

    it('Revoke asks first, then calls the revoke route and refreshes the list', async () => {
        const calls = fakeNode({ tokens: [row] });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        render(<AutomationTokensPanel activeNode={node} />);
        const revoke = await screen.findByRole('button', { name: 'Revoke Nightly backups' });

        await act(async () => { fireEvent.click(revoke); });
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);

        await act(async () => { fireEvent.click(revoke); });
        const post = calls.find((c) => c.url.endsWith('/api/local/admin/automation-tokens/abc123/revoke'));
        expect(post).toBeTruthy();
        expect(post!.init!.method).toBe('POST');
        await waitFor(() => expect(screen.getByText('No tokens yet.')).toBeInTheDocument());
    });
});
