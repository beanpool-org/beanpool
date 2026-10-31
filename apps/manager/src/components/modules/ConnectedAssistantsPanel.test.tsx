import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ConnectedAssistantsPanel } from './ConnectedAssistantsPanel';
import type { NodeProfile } from '../../lib/profiles';
import { answerInPageConfirm } from '../common/__tests__/in-page-confirm-helpers';

const node: NodeProfile = { id: 'local-node', name: 'Mullumbimby Node', url: 'http://localhost:8080' };

const NEW_TOKEN = 'bp_0123456789ab_' + 'c'.repeat(64);
const OWNER_KEY = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' } as const;
const ADMIN_KEY = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' } as const;
/** The owners' setting, first "Assistant posts a day": owners' and admins' own content limits too (Marty, 31 Oct). */
const LIMIT = 'Owner and admin limit — posts and other content a day';

const grant = (over: Record<string, unknown> = {}) => ({
    id: '0123456789ab', name: 'Claude on my laptop', member: 'Olive', mine: true, role: 'owner', via: 'token',
    createdAt: Date.UTC(2026, 9, 13), expiresAt: Date.UTC(2026, 10, 12), expired: false, lastUsedAt: null, callsToday: 3, ...over,
});

type Call = { url: string; method: string; body: any };

/** A fake node: the list is `state.grants`; connecting pushes one; disconnecting removes it; the preview answers its tools. */
function fakeNode(state: { grants: any[]; disconnected?: Array<{ id: string; madePosts: number }>; removeProof?: 'phone'; allowed?: boolean; role?: 'owner' | 'admin'; canConnect?: boolean; seesAll?: boolean; makeStatus?: number; makeBody?: unknown; previewStatus?: number; previewBody?: unknown; previewTools?: unknown[]; postsPerDay?: number; perDayProof?: 'phone' | 'code' }) {
    const calls: Call[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method, body });
        if (url.endsWith('/api/local/admin/agent/grants') && method === 'GET') {
            return new Response(JSON.stringify({
                allowed: state.allowed ?? true, mcpUrl: 'https://mullum.example/mcp', role: state.role ?? 'owner', canConnect: state.canConnect ?? true, canConnectOAuth: true,
                seesAll: state.seesAll ?? true, defaultDays: 30, maxDays: 90, perMember: 5, grants: state.grants,
                postsPerDay: state.postsPerDay ?? 100, postsPerDayDefault: 100, postsPerDayMin: 1, postsPerDayMax: 1000,
                disconnected: state.disconnected ?? [],
            }), { status: 200 });
        }
        const removeMade = url.match(/agent\/grants\/([^/]+)\/remove-made$/);
        if (removeMade) {
            if (state.removeProof === 'phone') {
                return new Response(JSON.stringify({ error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true }), { status: 403 });
            }
            const id = removeMade[1];
            const n = state.grants.find((g) => g.id === id)?.madePosts ?? state.disconnected?.find((d) => d.id === id)?.madePosts ?? 0;
            state.grants = state.grants.map((g) => (g.id === id ? { ...g, madePosts: 0 } : g));
            state.disconnected = (state.disconnected ?? []).filter((d) => d.id !== id);
            return new Response(JSON.stringify({ grant: id, removed: Array.from({ length: n }, (_, i) => `p${i}`), kept: [] }), { status: 200 });
        }
        if (url.endsWith('/api/local/admin/agent/grants') && method === 'POST') {
            if (state.makeStatus && state.makeStatus !== 201) return new Response(JSON.stringify(state.makeBody ?? { error: 'bad' }), { status: state.makeStatus });
            const g = grant({ name: body.name, canPost: body.canPost === true, postsToday: 0 });
            state.grants = [...state.grants, g];
            return new Response(JSON.stringify({ token: NEW_TOKEN, grant: g }), { status: 201 });
        }
        const revoke = url.match(/agent\/grants\/([^/]+)\/revoke$/);
        if (revoke) {
            state.grants = state.grants.filter((g) => g.id !== revoke[1]);
            return new Response(JSON.stringify({ revoked: revoke[1] }), { status: 200 });
        }
        if (url.endsWith('/api/local/admin/agent/posts-per-day')) {
            // The owner's fresh proof (server requireFreshProof): a computer's key session is sent to the phone; the
            // password asks a current code (here 123456).
            if (state.perDayProof === 'phone') {
                return new Response(JSON.stringify({ error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true }), { status: 403 });
            }
            if (state.perDayProof === 'code' && body.code !== '123456') {
                return new Response(JSON.stringify({ error: body.code ? 'That code is not right.' : 'A current code is needed to change how many posts an assistant may make a day', totpRequired: true }), { status: 401 });
            }
            state.postsPerDay = body.perDay;
            return new Response(JSON.stringify({ postsPerDay: body.perDay }), { status: 200 });
        }
        if (url.endsWith('/api/local/admin/agent/switch')) {
            state.allowed = body.allowed;
            return new Response(JSON.stringify({ allowed: body.allowed }), { status: 200 });
        }
        if (url.endsWith('/api/local/admin/agent/preview')) {
            if (!body.tool) {
                if (state.previewTools) return new Response(JSON.stringify({ tools: state.previewTools }), { status: 200 });
                return new Response(JSON.stringify({ tools: [
                    { name: 'node_overview', title: 'This server', description: 'Reads the community.\nNever returns member rows.', write: false, memberText: false },
                    { name: 'reports_list', title: 'Reports', description: 'Reads reports.\nNever returns the reporter.', write: false, memberText: true },
                    { name: 'take_backup', title: 'Take a backup', description: 'Reads nothing.\nNever returns a file.', write: true, memberText: false },
                ] }), { status: 200 });
            }
            if (state.previewStatus) return new Response(JSON.stringify(state.previewBody ?? { error: 'refused' }), { status: state.previewStatus });
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
        // An admin's assistant neither takes a backup nor posts, so an admin is told neither (MCP-OWNER-POSTS).
        expect(screen.getByTestId('connected-assistants-card')).not.toHaveTextContent(/take a backup|post Offers/);
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
        // Before an owner connects one, the card says it can post as them at once, with no approval, if they tick it (MCP-OWNER-POSTS).
        expect(await screen.findByTestId('connected-assistants-card')).toHaveTextContent(
            'take a backup, and, if you tick “May post for me” when you connect it, post Offers, Needs and events for you at once, with no approval.');
        fireEvent.change(await screen.findByLabelText('Assistant’s name'), { target: { value: 'Claude on my laptop' } });
        fireEvent.change(screen.getByLabelText('For how long'), { target: { value: '7' } });
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        expect(await screen.findByTestId('agent-token-value')).toHaveTextContent(NEW_TOKEN);
        // Not ticked "May post for me" (off by default): it reads only, and the warning says only that.
        expect(screen.getByTestId('agent-token-shown')).toHaveTextContent('whoever holds it reads what your assistant reads.');
        expect(screen.getByTestId('agent-token-shown')).not.toHaveTextContent('can post as you');
        expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/agent/grants'))?.body).toEqual({ name: 'Claude on my laptop', days: 7, canPost: false });
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

    it('"May post for me" is ticked or not at connect, each row says which, and an owner sets the posts a day (MCP-OWNER-POSTS)', async () => {
        const calls = fakeNode({ grants: [grant({ id: 'aaaaaaaaaaaa', name: 'Reader', canPost: false, postsToday: 0 })] });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        expect(await screen.findByTestId('agent-grant-posts')).toHaveTextContent('Reads only: not ticked to post');
        fireEvent.change(screen.getByLabelText('Assistant’s name'), { target: { value: 'Seeder' } });
        const tick = screen.getByRole('checkbox', { name: /May post for me/ });
        expect(tick).not.toBeChecked();
        // The token form says what an assistant left unticked still does.
        expect(screen.getByText(/Leave it off and it never posts: it still reads, takes a backup when asked, and suggests moderation steps for you to approve\./)).toBeInTheDocument();
        fireEvent.click(tick);
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        expect(await screen.findByTestId('agent-token-shown')).toHaveTextContent('whoever holds it reads what your assistant reads, and can post as you.');
        expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/agent/grants'))?.body).toEqual({ name: 'Seeder', days: 30, canPost: true });
        await waitFor(() => expect(screen.getAllByTestId('agent-grant-posts').map((p) => p.textContent)).toEqual(
            ['Reads only: not ticked to post', 'May post for me · 0 posts today']));
        expect(screen.getByTestId('agent-posts-per-day')).toHaveTextContent(`${LIMIT}: 100.`);
        fireEvent.change(screen.getByLabelText(LIMIT), { target: { value: '1001' } });
        fireEvent.click(within(screen.getByTestId('agent-posts-per-day')).getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('A whole number from 1 to 1,000.')).toBeInTheDocument();
        expect(calls.some((c) => c.url.endsWith('/agent/posts-per-day'))).toBe(false);
        fireEvent.change(screen.getByLabelText(LIMIT), { target: { value: '1000' } });
        fireEvent.click(within(screen.getByTestId('agent-posts-per-day')).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(calls.find((c) => c.url.endsWith('/agent/posts-per-day'))?.body).toEqual({ perDay: 1000 }));
        expect(await screen.findByText(`${LIMIT}: 1,000. Each owner and admin may put up this many posts, and start this many groups and enterprises, in any 24 hours, and have this many upcoming events, open polls and running enterprises at once. Members keep their own limits (100 posts a day, 5 upcoming events, 1 open poll). Each owner’s assistant ticked “May post for me” may make this many posts in a day (UTC) too, counted apart from the owner’s own; its photos count in the owner’s own photos for the day. Changing it asks for a fresh proof.`)).toBeInTheDocument();
    });

    it('the "Owner and admin limit" asks a fresh proof: a computer\'s key session is sent to the phone, and nothing changes', async () => {
        const calls = fakeNode({ grants: [], perDayProof: 'phone' });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        fireEvent.change(await screen.findByLabelText(LIMIT), { target: { value: '1000' } });
        fireEvent.click(within(screen.getByTestId('agent-posts-per-day')).getByRole('button', { name: 'Save' }));
        expect(await screen.findByTestId('agent-posts-per-day-proof-phone')).toHaveTextContent('Do this from your phone: open BeanPool, press Manage, then make this change there.');
        expect(calls.filter((c) => c.url.endsWith('/agent/posts-per-day')).map((c) => c.body)).toEqual([{ perDay: 1000 }]);
        expect(screen.getByTestId('agent-posts-per-day')).toHaveTextContent(`${LIMIT}: 100.`);
        expect(screen.queryByText(/^Saved:/)).toBeNull();
    });

    it('the "Owner and admin limit" with the password asks a current code, and sends it with the change', async () => {
        const calls = fakeNode({ grants: [], perDayProof: 'code' });
        render(<ConnectedAssistantsPanel activeNode={node} />);
        fireEvent.change(await screen.findByLabelText(LIMIT), { target: { value: '500' } });
        fireEvent.click(within(screen.getByTestId('agent-posts-per-day')).getByRole('button', { name: 'Save' }));
        fireEvent.change(await screen.findByTestId('agent-posts-per-day-proof-input'), { target: { value: '123456' } });
        fireEvent.click(screen.getByTestId('agent-posts-per-day-proof-confirm'));
        expect(await screen.findByText('Saved: 500 a day, from the next post.')).toBeInTheDocument();
        expect(calls.filter((c) => c.url.endsWith('/agent/posts-per-day')).map((c) => c.body)).toEqual([{ perDay: 500 }, { perDay: 500, code: '123456' }]);
        expect(screen.queryByTestId('agent-posts-per-day-proof-code')).toBeNull();
        expect(await screen.findByTestId('agent-posts-per-day')).toHaveTextContent(`${LIMIT}: 500.`);
    });

    it('an admin sees the owner and admin limit but cannot change it', async () => {
        fakeNode({ grants: [], role: 'admin', canConnect: false, seesAll: false });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={ADMIN_KEY} />);
        expect(await screen.findByTestId('agent-posts-per-day')).toHaveTextContent('Only an owner changes this.');
        expect(screen.queryByLabelText(LIMIT)).toBeNull();
    });

    it('the password session is told to connect with a key; the node\'s refusal is shown in its words', async () => {
        fakeNode({ grants: [grant({ mine: false, member: 'Adam', role: 'admin' })], canConnect: false });
        render(<ConnectedAssistantsPanel activeNode={node} />);
        expect(await screen.findByTestId('agent-needs-key')).toHaveTextContent(/never the password/);
        expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
        expect(screen.getByText(/Adam · admin · by token/)).toBeInTheDocument();
    });

    it('an admin connects from their assistant with the phone\'s approval (S2): the address and the steps, no token form', async () => {
        const calls = fakeNode({
            grants: [grant({ mine: true, member: 'Adam', role: 'admin' }), grant({ id: 'oa0123456789', name: 'Claude', mine: true, member: 'Adam', role: 'admin', via: 'oauth', sendsTo: 'claude.ai', expiresAt: null })],
            role: 'admin', canConnect: false, seesAll: false,
        });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={ADMIN_KEY} />);
        const steps = await screen.findByTestId('agent-connect-oauth');
        expect(steps).toHaveTextContent('https://mullum.example/mcp');
        expect(steps).toHaveTextContent(/Settings → Connectors → Add custom connector → paste it/);
        expect(steps).toHaveTextContent(/Approve on your phone.*type the two digits/);
        expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument();
        expect(screen.getByTestId('agent-admin-oauth')).toHaveTextContent(/Only an owner makes a token/);
        expect(screen.queryByTestId('agent-admin-soon')).toBeNull();
        // The OAuth assistant's own name is never shown without the host its answers go to.
        expect(screen.getByTestId('agent-grant-sends-to')).toHaveTextContent('Sends what it reads to claude.ai');
        expect(screen.getByText(/approved on the phone/)).toBeInTheDocument();
        expect(screen.queryByTestId('agent-needs-key')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
        expect(screen.queryByLabelText('Assistant’s name')).toBeNull();
        // What theirs will read, and their own (made when they were an owner) to see and disconnect.
        expect(screen.getByRole('button', { name: 'What would my assistant see?' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Disconnect Claude on my laptop' })).toBeInTheDocument();
        expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/local/admin/agent/grants'))).toBe(false);
    });

    it('a stale phone session: the node says press Manage again, and no token appears', async () => {
        fakeNode({ grants: [], makeStatus: 403, makeBody: { error: 'Press Manage in the app again', code: 'step_up_required' } });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        fireEvent.change(await screen.findByLabelText('Assistant’s name'), { target: { value: 'x' } });
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Not connected: Press Manage in the app again');
        expect(screen.queryByTestId('agent-token-value')).toBeNull();
    });

    it('a ticked "May post for me" from a computer: the fresh-proof box opens by the form, and no token appears', async () => {
        fakeNode({ grants: [], makeStatus: 403, makeBody: { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true } });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        fireEvent.change(await screen.findByLabelText('Assistant’s name'), { target: { value: 'x' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /May post for me/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        expect(await screen.findByTestId('agent-make-proof-phone')).toHaveTextContent('Do this from your phone: open BeanPool, press Manage, then make this change there.');
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

    it('"Remove its posts" (slice S2): a row says what it made; the owner confirms, and its posts are removed', async () => {
        const calls = fakeNode({ grants: [grant({ canPost: true, postsToday: 2, madePosts: 12 })] });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        expect(await screen.findByTestId('agent-grant-made')).toHaveTextContent('Made: 12 posts still up');
        fireEvent.click(screen.getByRole('button', { name: 'Remove its posts: "Claude on my laptop"' }));
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Remove the 12 posts "Claude on my laptop" made?');
        await answerInPageConfirm('Remove its posts');
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/agent/grants/0123456789ab/remove-made'))).toBe(true));
        expect(await screen.findByText('Removed 12 posts.')).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByTestId('agent-grant-made')).toBeNull());
    });

    it('"Remove its posts" works for a disconnected assistant, and from a computer it is sent to the phone', async () => {
        const calls = fakeNode({ grants: [], disconnected: [{ id: 'goneeeeeeeee', madePosts: 3 }], removeProof: 'phone' });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        const row = await screen.findByTestId('agent-disconnected-row');
        expect(row).toHaveTextContent('A disconnected assistant');
        expect(row).toHaveTextContent('Made: 3 posts still up');
        fireEvent.click(within(row).getByRole('button', { name: 'Remove its posts: a disconnected assistant' }));
        await answerInPageConfirm('Remove its posts');
        expect(await screen.findByTestId('agent-remove-proof-phone')).toHaveTextContent('Do this from your phone');
        expect(calls.filter((c) => c.url.endsWith('/agent/grants/goneeeeeeeee/remove-made'))).toHaveLength(1);
        expect(screen.getByTestId('agent-disconnected-row')).toBeInTheDocument();
    });

    it('an admin sees no "Remove its posts" and no disconnected list', async () => {
        fakeNode({ grants: [grant({ mine: true, role: 'admin', madePosts: 4 })], role: 'admin', seesAll: false, disconnected: [{ id: 'goneeeeeeeee', madePosts: 3 }] });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={ADMIN_KEY} />);
        await screen.findByTestId('agent-grant-row');
        expect(screen.queryByTestId('agent-remove-made')).toBeNull();
        expect(screen.queryByTestId('agent-disconnected-list')).toBeNull();
    });

    it('Disconnect asks, then disconnects that assistant', async () => {
        const calls = fakeNode({ grants: [grant()] });
        const confirmSpy = vi.spyOn(window, 'confirm');
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Claude on my laptop' }));
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('Disconnect "Claude on my laptop"?');
        await answerInPageConfirm('Disconnect');
        expect(confirmSpy).not.toHaveBeenCalled();
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/agent/grants/0123456789ab/revoke'))).toBe(true));
        expect(await screen.findByText('None connected.')).toBeInTheDocument();
    });

    it('What it sees lists its tools and shows a reading tool\'s answer; a write is never tried', async () => {
        const calls = fakeNode({ grants: [grant()] });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        // Its accessible name holds the words on it (WCAG 2.5.3): "What it sees", then "Hide".
        fireEvent.click(await screen.findByRole('button', { name: 'What it sees: Claude on my laptop' }));
        expect(screen.getByRole('button', { name: 'Hide what it sees: Claude on my laptop' })).toHaveTextContent('Hide');
        const panel = await screen.findByTestId('agent-preview');
        const tools = await within(panel).findAllByTestId('agent-preview-tool');
        expect(tools).toHaveLength(3);
        expect(within(tools[2]).queryByRole('button', { name: 'Show its answer' })).toBeNull();
        fireEvent.click(within(tools[1]).getByRole('checkbox'));
        fireEvent.click(within(tools[1]).getByRole('button', { name: 'Show its answer' }));
        expect(await within(tools[1]).findByTestId('agent-preview-answer')).toHaveTextContent('"community": "Mullumbimby"');
        expect(calls.find((c) => c.body?.tool === 'reports_list')?.body).toEqual({ grant: '0123456789ab', tool: 'reports_list', args: { include_text: true } });
    });

    it('an owner\'s assistant lists its posting tools (MCP-OWNER-POSTS) as writes, each named and never tried', async () => {
        const creates = ['create_offer', 'create_need', 'create_event', 'create_enterprise_listing'];
        fakeNode({ grants: [grant()], previewTools: [
            { name: 'my_enterprises', title: 'Enterprises you may post as', description: 'Reads the enterprises.\nNever returns a key.', write: false, memberText: true },
            ...creates.map((name) => ({ name, title: `Post (${name})`, description: 'Reads nothing: it posts.\nNever returns another member\'s data.', write: true, memberText: false })),
        ] });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={OWNER_KEY} />);
        fireEvent.click(await screen.findByRole('button', { name: 'What it sees: Claude on my laptop' }));
        const tools = await within(await screen.findByTestId('agent-preview')).findAllByTestId('agent-preview-tool');
        expect(tools).toHaveLength(5);
        for (const [i, name] of creates.entries()) {
            expect(tools[i + 1]).toHaveTextContent(name);
            expect(tools[i + 1]).toHaveTextContent('It changes something, so it is not tried here.');
            expect(within(tools[i + 1]).queryByRole('button', { name: 'Show its answer' })).toBeNull();
        }
        expect(within(tools[0]).getByRole('button', { name: 'Show its answer' })).toBeTruthy();
    });

    it('with assistants off, an admin\'s preview says it is turned off, never "It would be told" (#1865 finding 2)', async () => {
        fakeNode({ grants: [], role: 'admin', canConnect: false, seesAll: false, allowed: false, previewStatus: 409, previewBody: { error: 'AI assistants are turned off on this server: an owner turns them on here first' } });
        render(<ConnectedAssistantsPanel activeNode={node} viewer={ADMIN_KEY} />);
        fireEvent.click(await screen.findByRole('button', { name: 'What would my assistant see?' }));
        fireEvent.click((await screen.findAllByRole('button', { name: 'Show its answer' }))[0]);
        const answer = await screen.findByTestId('agent-preview-answer');
        expect(answer).toHaveTextContent(/^Turned off: an assistant is told nothing/);
        expect(answer).not.toHaveTextContent(/It would be told/);
        expect(screen.queryByTestId('agent-connect-oauth')).toBeNull();
    });
});
