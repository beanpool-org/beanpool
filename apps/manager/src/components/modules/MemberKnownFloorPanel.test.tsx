import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemberKnownFloorPanel, describeKnownFloorLine, readMemberKnownFloor } from './MemberKnownFloorPanel';

/** Member detail → "Known floor" (community modes slice 4): one confirmed member's line, set, frozen or restored. */

const NODE = 'https://mullum.test';
const KIM = 'k'.repeat(64);
const LINE = { memberPubkey: KIM, confirmation: true, knownFloor: 1000, creditCap: 2000, confirmed: true, exception: null, knownGrant: 1000 };

type Answer = { ok: boolean; status?: number; body: unknown };

function mockNode(read: Answer = { ok: true, body: LINE }, write: Answer = { ok: true, body: { memberPubkey: KIM, confirmed: true, exception: null } }) {
    let current = read;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/api/local/admin/known-floor/exception') && init?.method === 'POST') {
            if (write.ok) {
                const ex = (write.body as { exception?: unknown }).exception ?? null;
                current = { ok: true, body: { ...(read.body as object), exception: ex } };
            }
            return Promise.resolve({ ok: write.ok, status: write.status ?? 200, json: () => Promise.resolve(write.body) });
        }
        if (url.includes(`/api/local/admin/known-floor/member/${KIM}`)) {
            return Promise.resolve({ ok: current.ok, status: current.status ?? 200, json: () => Promise.resolve(current.body) });
        }
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const posts = (f: ReturnType<typeof vi.fn>) => f.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

function renderPanel(onChanged = vi.fn()) {
    render(<MemberKnownFloorPanel nodeUrl={NODE} pubkey={KIM} displayName="Kim" adminPassword="pw" onChanged={onChanged} />);
    return onChanged;
}

describe('MemberKnownFloorPanel', () => {
    beforeEach(() => { vi.unstubAllGlobals(); });

    it('reads only a whole answer, and never a balance', () => {
        expect(readMemberKnownFloor(LINE)).toEqual({ confirmation: true, knownFloor: 1000, creditCap: 2000, confirmed: true, exception: null, knownGrant: 1000 });
        expect(readMemberKnownFloor({ error: 'Not found' })).toBeNull();
        expect(readMemberKnownFloor({ ...LINE, balance: -400 })).not.toHaveProperty('balance');
    });

    it('describes each state of the line', () => {
        expect(describeKnownFloorLine(null, 1000)).toBe('Community default (1,000 Beans)');
        expect(describeKnownFloorLine({ amount: 300, frozen: false }, 1000)).toBe('Lowered to 300 Beans');
        expect(describeKnownFloorLine({ amount: 1800, frozen: false }, 1000)).toBe('Raised to 1,800 Beans');
        expect(describeKnownFloorLine({ amount: null, frozen: true }, 1000)).toBe('Frozen');
    });

    it('shows the community default for a confirmed member, and reads only their line', async () => {
        const f = mockNode();
        renderPanel();
        expect(await screen.findByTestId('member-known-floor-line')).toHaveTextContent('Community default (1,000 Beans)');
        expect(String(f.mock.calls[0][0])).toMatch(new RegExp(`mullum\\.test/api/local/admin/known-floor/member/${KIM}$`));
        expect(screen.queryByText(/balance/i)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Restore the default' })).toBeNull();
    });

    it('shows a lowered line and a frozen line', async () => {
        mockNode({ ok: true, body: { ...LINE, exception: { amount: 300, frozen: false }, knownGrant: 300 } });
        renderPanel();
        expect(await screen.findByTestId('member-known-floor-line')).toHaveTextContent('Lowered to 300 Beans');
        expect(screen.getByRole('button', { name: 'Restore the default' })).toBeInTheDocument();
    });

    it('shows a frozen line with no Freeze button', async () => {
        mockNode({ ok: true, body: { ...LINE, exception: { amount: null, frozen: true }, knownGrant: 0 } });
        renderPanel();
        expect(await screen.findByTestId('member-known-floor-line')).toHaveTextContent('Frozen');
        expect(screen.queryByRole('button', { name: 'Freeze' })).toBeNull();
    });

    it('shows nothing on a node older than the known floor, or with the dial off', async () => {
        const f = mockNode({ ok: false, status: 404, body: {} });
        const { unmount } = render(<MemberKnownFloorPanel nodeUrl={NODE} pubkey={KIM} displayName="Kim" />);
        await waitFor(() => expect(f).toHaveBeenCalled());
        expect(screen.queryByTestId('member-known-floor')).toBeNull();
        unmount();
        const g = mockNode({ ok: true, body: { ...LINE, confirmation: false, knownGrant: 0 } });
        render(<MemberKnownFloorPanel nodeUrl={NODE} pubkey={KIM} displayName="Kim" />);
        await waitFor(() => expect(g).toHaveBeenCalled());
        expect(screen.queryByTestId('member-known-floor')).toBeNull();
    });

    it('says an unconfirmed member has no known floor, with no controls', async () => {
        mockNode({ ok: true, body: { ...LINE, confirmed: false, knownGrant: 0 } });
        renderPanel();
        expect(await screen.findByText(/Not confirmed on the names list yet, so Kim has no known floor/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Freeze' })).toBeNull();
    });

    it('lowers after a confirmation, sending whole Beans', async () => {
        const f = mockNode(undefined, { ok: true, body: { memberPubkey: KIM, confirmed: true, exception: { memberPubkey: KIM, amount: 300, frozen: false } } });
        const onChanged = renderPanel();
        fireEvent.change(await screen.findByLabelText(/New known floor/), { target: { value: '300' } });
        fireEvent.click(screen.getByRole('button', { name: 'Set' }));
        expect(posts(f)).toHaveLength(0);
        expect(screen.getByText("Set Kim's known floor to 300 Beans?")).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Yes, set it' }));
        await waitFor(() => expect(posts(f)).toHaveLength(1));
        expect(posts(f)[0].url).toMatch(/mullum\.test\/api\/local\/admin\/known-floor\/exception$/);
        expect(posts(f)[0].body).toEqual({ password: 'pw', memberPubkey: KIM, amount: 300 });
        expect(await screen.findByTestId('member-known-floor-line')).toHaveTextContent('Lowered to 300 Beans');
        expect(onChanged).toHaveBeenCalledWith(KIM, { amount: 300, frozen: false });
    });

    it('cancelling a confirmation sends nothing', async () => {
        const f = mockNode();
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Freeze' }));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(posts(f)).toHaveLength(0);
        expect(screen.getByRole('button', { name: 'Freeze' })).toBeInTheDocument();
    });

    it('freezes after a confirmation', async () => {
        const f = mockNode(undefined, { ok: true, body: { memberPubkey: KIM, confirmed: true, exception: { memberPubkey: KIM, amount: null, frozen: true } } });
        const onChanged = renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Freeze' }));
        expect(screen.getByText(/Freeze Kim's known floor\?/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Yes, freeze it' }));
        await waitFor(() => expect(posts(f)).toHaveLength(1));
        expect(posts(f)[0].body).toEqual({ password: 'pw', memberPubkey: KIM, frozen: true });
        expect(await screen.findByTestId('member-known-floor-line')).toHaveTextContent('Frozen');
        expect(onChanged).toHaveBeenCalledWith(KIM, { amount: null, frozen: true });
    });

    it('restores the community default after a confirmation', async () => {
        const f = mockNode({ ok: true, body: { ...LINE, exception: { amount: 300, frozen: false }, knownGrant: 300 } },
            { ok: true, body: { memberPubkey: KIM, confirmed: true, exception: null } });
        const onChanged = renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Restore the default' }));
        expect(screen.getByText('Restore Kim to the community default (1,000 Beans)?')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Yes, restore it' }));
        await waitFor(() => expect(posts(f)).toHaveLength(1));
        expect(posts(f)[0].body).toEqual({ password: 'pw', memberPubkey: KIM, clear: true });
        expect(await screen.findByTestId('member-known-floor-line')).toHaveTextContent('Community default (1,000 Beans)');
        expect(onChanged).toHaveBeenCalledWith(KIM, null);
    });

    it("shows the node's refusal in its own words", async () => {
        mockNode(undefined, { ok: false, status: 403, body: { error: "Sign in with your own key to change a member's known floor.", code: 'key_session_only' } });
        const onChanged = renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Freeze' }));
        fireEvent.click(screen.getByRole('button', { name: 'Yes, freeze it' }));
        expect(await screen.findByRole('alert')).toHaveTextContent("Sign in with your own key to change a member's known floor.");
        expect(onChanged).not.toHaveBeenCalled();
        expect(screen.getByTestId('member-known-floor-line')).toHaveTextContent('Community default (1,000 Beans)');
    });

    it('refuses an amount that is not whole Beans or is above the cap before asking', async () => {
        mockNode();
        renderPanel();
        const input = await screen.findByLabelText(/New known floor/);
        fireEvent.change(input, { target: { value: '12.50' } });
        expect(screen.getByRole('alert')).toHaveTextContent('A whole number of Beans, 0 or more.');
        expect(screen.getByRole('button', { name: 'Set' })).toBeDisabled();
        fireEvent.change(input, { target: { value: '2500' } });
        expect(screen.getByRole('alert')).toHaveTextContent('No more than the cap (2,000 Beans).');
        expect(screen.getByRole('button', { name: 'Set' })).toBeDisabled();
        fireEvent.change(input, { target: { value: '1800' } });
        fireEvent.click(screen.getByRole('button', { name: 'Set' }));
        expect(screen.getByText(/every admin sees the raise in the log/)).toBeInTheDocument();
    });
});
