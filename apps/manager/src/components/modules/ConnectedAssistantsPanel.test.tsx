import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ConnectedAssistantsPanel } from './ConnectedAssistantsPanel';
import type { NodeProfile } from '../../lib/profiles';

const node: NodeProfile = { id: 'local-node', name: 'Mullumbimby Node', url: 'http://localhost:8080' };

const NEW_TOKEN = 'bp_0123456789ab_' + 'c'.repeat(64);
const OWNER_KEY = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' } as const;
const ADMIN_KEY = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' } as const;

const grant = (over: Record<string, unknown> = {}) => ({
    id: '0123456789ab', name: 'Claude on my laptop', member: 'Olive', mine: true, role: 'owner', via: 'token',
    createdAt: Date.UTC(2026, 9, 13), expiresAt: Date.UTC(2026, 10, 12), expired: false, lastUsedAt: null, callsToday: 3, ...over,
});

type Call = { url: string; method: string; body: any };

/** A fake node: the list is `state.grants`; connecting pushes one; disconnecting removes it; the preview answers its tools. */
function fakeNode(state: { grants: any[]; allowed?: boolean; canConnect?: boolean; seesAll?: boolean; makeStatus?: number; makeBody?: unknown }) {
    const calls: Call[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method, body });
        if (url.endsWith('/api/local/admin/agent/grants') && method === 'GET') {
            return new Response(JSON.stringify({
                allowed: state.allowed ?? true, mcpUrl: 'https://mullum.example/mcp', role: 'owner', canConnect: state.canConnect ?? true,
                seesAll: state.seesAll ?? true, defaultDays: 30, maxDays: 90, perMember: 5, grants: state.grants,
            }), { status: 200 });
        }
        if (url.endsWith('/api/local/admin/agent/grants') && method === 'POST') {
            if (state.makeStatus && state.makeStatus !== 201) return new Response(JSON.stringify(state.makeBody ?? { error: 'bad' }), { status: state.makeStatus });
            const g = grant({ name: body.name });
            state.grants = [...state.grants, g];
            return new Response(JSON.stringify({ token: NEW_TOKEN, grant: g }), { status: 201 });
        }
        const revoke = url.match(/agent\/grants\/([^/]+)\/revoke$/);
        if (revoke) {
            state.grants = state.grants.filter((g) => g.id !== revoke[1]);
            return new Response(JSON.stringify({ revoked: revoke[1] }), { status: 200 });
        }
        if (url.endsWith('/api/local/admin/agent/switch')) {
            state.allowed = body.allowed;
            return new Response(JSON.stringify({ allowed: body.allowed }), { status: 200 });
        }
        if (url.endsWith('/api/local/admin/agent/preview')) {
            if (!body.tool) {
                return new Response(JSON.stringify({ tools: [
                    { name: 'node_overview', title: 'This server', description: 'Reads the community.\nNever returns member rows.', write: false, memberText: false },
                    { name: 'reports_list', title: 'Reports', description: 'Reads reports.\nNever returns the reporter.', write: false, memberText: true },
                    { name: 'take_backup', title: 'Take a backup', description: 'Reads nothing.\nNever returns a file.', write: true, memberText: false },
                ] }), { status: 200 });
            }
            return new Response(JSON.stringify({ tool: body.tool, ok: true, rows: 1, result: { community: 'Mullumbimby', members: 42, args: body.args } }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
    });
    return calls;
}

const countIn = (html: string, needle: string) => html.split(needle).length - 1;

describe('ConnectedAssistantsPanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('owners and admins see the card; a moderator does not, and nothing is fetched for them', async () => {
        const calls = fakeNode({ grants: [] });
        const { unmount } = render(<ConnectedAssistantsPanel activeNode={node} viewer={ADMIN_KEY} />);
        expect(await screen.findByText('Connected assistants')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByText('None connected.')).toBeInTheDocument());
        unmount();
        calls.length = 0;
        const view = render(<ConnectedAssistantsPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'm'.repeat(64), role: 'moderator' }} />);
        expect(view.container).toBeEmptyDOMElement();
        expect(calls).toHaveLength(0);
    });

    it('the token appears once in the page, never in web storage, and is gone at Done', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        const calls = fakeNode({ grants: [] });
        const { container } = render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        fireEvent.change(await screen.findByLabelText('Assistant’s name'), { target: { value: 'Claude on my laptop' } });
        fireEvent.change(screen.getByLabelText('For how long'), { target: { value: '7' } });
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        expect(await screen.findByTestId('agent-token-value')).toHaveTextContent(NEW_TOKEN);
        expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/agent/grants'))?.body).toEqual({ name: 'Claude on my laptop', days: 7 });
        expect(countIn(container.innerHTML, NEW_TOKEN)).toBe(1);
        expect(countIn(container.innerHTML, 'c'.repeat(64))).toBe(1);
        expect(screen.getByTestId('agent-mcp-url')).toHaveTextContent('https://mullum.example/mcp');
        // The command line on screen holds a placeholder; Copy command puts the real one on the clipboard.
        expect(screen.getByTestId('agent-command')).not.toHaveTextContent(NEW_TOKEN);
        fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(
            `claude mcp add --transport http beanpool https://mullum.example/mcp --header "Authorization: Bearer ${NEW_TOKEN}"`));
        expect(JSON.stringify({ ...localStorage })).not.toContain('c'.repeat(64));
        expect(JSON.stringify({ ...sessionStorage })).not.toContain('c'.repeat(64));
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(countIn(container.innerHTML, 'c'.repeat(64))).toBe(0);
        // The list, reloaded, names it, never with a secret.
        expect(await screen.findByText('Claude on my laptop')).toBeInTheDocument();
    });

    it('the password session is told to connect with a key; the node\'s refusal is shown in its words', async () => {
        fakeNode({ grants: [grant({ mine: false, member: 'Adam', role: 'admin' })], canConnect: false });
        render(<ConnectedAssistantsPanel activeNode={node} />);
        expect(await screen.findByTestId('agent-needs-key')).toHaveTextContent(/never the password/);
        expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
        expect(screen.getByText(/Adam · admin · by token/)).toBeInTheDocument();
    });

    it('a stale phone session: the node says press Manage again, and no token appears', async () => {
        fakeNode({ grants: [], makeStatus: 403, makeBody: { error: 'Press Manage in the app again', code: 'step_up_required' } });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={ADMIN_KEY} />);
        fireEvent.change(await screen.findByLabelText('Assistant’s name'), { target: { value: 'x' } });
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Not connected: Press Manage in the app again');
        expect(screen.queryByTestId('agent-token-value')).toBeNull();
    });

    it('an owner turns AI assistants off; an admin is told only an owner can', async () => {
        const calls = fakeNode({ grants: [] });
        const { unmount } = render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        fireEvent.click(await screen.findByRole('switch'));
        await waitFor(() => expect(calls.some((c) => c.url.endsWith('/agent/switch') && c.body?.allowed === false)).toBe(true));
        expect(await screen.findByText(/turned off on this server/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
        unmount();
        fakeNode({ grants: [] });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={ADMIN_KEY} />);
        expect(await screen.findByText('Only an owner turns this on or off.')).toBeInTheDocument();
        expect(screen.queryByRole('switch')).toBeNull();
    });

    it('Disconnect asks, then disconnects that assistant', async () => {
        const calls = fakeNode({ grants: [grant()] });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Claude on my laptop' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/agent/grants/0123456789ab/revoke'))).toBe(true));
        expect(await screen.findByText('None connected.')).toBeInTheDocument();
    });

    it('What it sees lists its tools and shows a reading tool\'s answer; a write is never tried', async () => {
        const calls = fakeNode({ grants: [grant()] });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        fireEvent.click(await screen.findByRole('button', { name: 'What Claude on my laptop sees' }));
        const panel = await screen.findByTestId('agent-preview');
        const tools = await within(panel).findAllByTestId('agent-preview-tool');
        expect(tools).toHaveLength(3);
        expect(within(tools[2]).queryByRole('button', { name: 'Show its answer' })).toBeNull();
        fireEvent.click(within(tools[1]).getByRole('checkbox'));
        fireEvent.click(within(tools[1]).getByRole('button', { name: 'Show its answer' }));
        expect(await within(tools[1]).findByTestId('agent-preview-answer')).toHaveTextContent('"community": "Mullumbimby"');
        expect(calls.find((c) => c.body?.tool === 'reports_list')?.body).toEqual({ grant: '0123456789ab', tool: 'reports_list', args: { include_text: true } });
    });
});
