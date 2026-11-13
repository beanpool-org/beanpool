import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MembersModule } from './MembersModule';
import { freezeNodeUser } from '../../lib/node-client';

/**
 * Freeze / Unfreeze on a member's own page, and the list's Unfreeze, through the real freezeNodeUser against a fake node
 * that answers with the node's own bodies (the deciding review of #3121: the page flipped to "🛑 Frozen" first and
 * swallowed the refusal, so an admin freezing an owner, anyone freezing themselves, an owner's stale phone hand-off on an
 * owner, and the Unfreeze twins each showed a freeze that never happened). Now a refusal is said in the node's words and
 * the page keeps what the node holds; a freeze the node made is read back from the node's member rows before it shows.
 */
const NODE = 'https://riverbend.example.org';
const OWNER = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);
const OWNER_ONLY = { error: 'Only an owner can freeze or unfreeze an owner.', code: 'owner_only' };
const OWN_ACCOUNT = { error: "You can't freeze or unfreeze your own account. Another owner or admin can.", code: 'own_account' };
const STEP_UP = {
    error: "Confirm it's you first: this change decides who owns the community or how it is kept safe. Press Manage in the BeanPool app again (it asks for your phone's lock), then make the change there.",
    code: 'step_up_required',
};

type Sent = { url: string; body: Record<string, unknown> };

/**
 * A fake node. The freeze route answers from `freezeAnswers` in turn; the member rows (POST /api/local/admin/data/members,
 * what the page reads back) say `frozenNow()` for the member asked; anything else is a plain 200.
 */
function mockNode(freezeAnswers: Array<[number, unknown]>, frozenNow: () => boolean) {
    const freezes: Sent[] = [];
    const readBacks: Sent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), {
            status, statusText: status === 403 ? 'Forbidden' : 'OK', headers: { 'Content-Type': 'application/json' },
        });
        if (url.endsWith('/freeze')) {
            freezes.push({ url, body });
            const [status, json] = freezeAnswers[Math.min(freezes.length - 1, freezeAnswers.length - 1)];
            return reply(status, json);
        }
        if (url.endsWith('/api/local/admin/data/members')) {
            readBacks.push({ url, body });
            const key = String(body.q ?? '');
            return reply(200, { members: [{ publicKey: key, name: 'Read back', status: 'active', creditFrozen: frozenNow() }], profiles: [], nextCursor: null, total: 1 });
        }
        return reply(200, {});
    }));
    return { freezes, readBacks };
}

function roster(frozen: boolean) {
    return {
        members: [
            { publicKey: OWNER, name: 'Marty Owner', status: 'active', nodeRole: 'owner', creditFrozen: frozen },
            { publicKey: MEMBER, name: 'Mia Member', status: 'active', creditFrozen: false },
        ],
        profiles: [{ publicKey: OWNER, name: 'Marty Owner' }, { publicKey: MEMBER, name: 'Mia Member' }],
        posts: [],
        health: { healthScore: 98, flags: [] },
        reports: [],
    };
}

function renderModule(opts: { frozen?: boolean; onRefresh?: () => void } = {}) {
    return render(
        <MembersModule
            nodeData={roster(opts.frozen ?? false) as never}
            nodeDataLoading={false}
            activeNodeUrl={NODE}
            credential="session"
            onRefresh={opts.onRefresh ?? vi.fn()}
            onFreezeUser={(pk, freeze) => freezeNodeUser(NODE, pk, freeze, 'session').then(() => {})}
        />
    );
}

/** The member's page, opened from the list by name. */
async function openPage(name: string) {
    fireEvent.click(await screen.findByText(name));
    return screen.findByTestId('freeze-button');
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe("a member's page: Freeze and Unfreeze say the node's answer", () => {
    it.each([
        ['an admin freezing an owner', OWNER_ONLY],
        ['an owner or admin freezing their own account', OWN_ACCOUNT],
    ])('%s: the node\'s words, and the page still says not frozen', async (_case, body) => {
        const onRefresh = vi.fn();
        const node = mockNode([[403, body]], () => false);
        renderModule({ onRefresh });
        const button = await openPage('Marty Owner');
        expect(button).toHaveTextContent('🛑 Freeze');
        fireEvent.click(button);
        expect(await screen.findByTestId('freeze-error')).toHaveTextContent(body.error);
        expect(screen.getByTestId('freeze-error')).not.toHaveTextContent(/HTTP 403/);
        expect(screen.getByTestId('freeze-button')).toHaveTextContent('🛑 Freeze');
        expect(screen.getByTestId('freeze-button')).toBeEnabled();
        expect(screen.queryByText('🛑 Frozen')).toBeNull();
        expect(screen.queryByTestId('freeze-note')).toBeNull();
        expect(node.freezes.map((s) => s.body.freeze)).toEqual([true]);
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it("an owner's stale phone hand-off on an owner: the phone's unlock again, and still not frozen", async () => {
        mockNode([[403, STEP_UP]], () => false);
        renderModule();
        fireEvent.click(await openPage('Marty Owner'));
        expect(await screen.findByTestId('freeze-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(screen.queryByTestId('freeze-error')).toBeNull();
        expect(screen.getByTestId('freeze-button')).toHaveTextContent('🛑 Freeze');
        expect(screen.queryByText('🛑 Frozen')).toBeNull();
    });

    it('Unfreeze refused (an admin on a frozen owner): the words, and the page still says frozen', async () => {
        const node = mockNode([[403, OWNER_ONLY]], () => true);
        renderModule({ frozen: true });
        const button = await openPage('Marty Owner');
        expect(button).toHaveTextContent('🟢 Unfreeze');
        fireEvent.click(button);
        expect(await screen.findByTestId('freeze-error')).toHaveTextContent(OWNER_ONLY.error);
        expect(screen.getByTestId('freeze-button')).toHaveTextContent('🟢 Unfreeze');
        expect(screen.getByText('🛑 Frozen')).toBeInTheDocument();
        expect(node.freezes.map((s) => s.body.freeze)).toEqual([false]);
    });

    it('a freeze the node made: read back from its member rows, then Frozen, Unfreeze and one line saying so', async () => {
        const onRefresh = vi.fn();
        // The node holds the freeze once it has answered the press.
        const node = mockNode([[200, { success: true, frozen: true }]], () => node.freezes.length > 0);
        renderModule({ onRefresh });
        fireEvent.click(await openPage('Mia Member'));
        expect(await screen.findByTestId('freeze-note')).toHaveTextContent("Frozen: Mia Member can't use credit until someone unfreezes it.");
        expect(screen.getByTestId('freeze-button')).toHaveTextContent('🟢 Unfreeze');
        expect(screen.getByText('🛑 Frozen')).toBeInTheDocument();
        expect(node.readBacks.map((s) => s.body.q)).toEqual([MEMBER]);
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('the node answered yes but its rows say not frozen: the page says what the rows say, never the press', async () => {
        mockNode([[200, { success: true, frozen: true }]], () => false);
        renderModule();
        fireEvent.click(await openPage('Mia Member'));
        expect(await screen.findByTestId('freeze-note')).toHaveTextContent('Unfrozen: Mia Member can use their credit again.');
        expect(screen.getByTestId('freeze-button')).toHaveTextContent('🛑 Freeze');
        expect(screen.queryByText('🛑 Frozen')).toBeNull();
    });
});

describe("the list's Unfreeze", () => {
    it("refused: the node's words, and the row still offers Unfreeze", async () => {
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        mockNode([[403, OWNER_ONLY]], () => true);
        renderModule({ frozen: true });
        await screen.findByText('Marty Owner');
        // Marty is the list's one frozen member: the one Unfreeze in the list (the page is not open).
        fireEvent.click(screen.getByRole('button', { name: /Unfreeze/ }));
        await waitFor(() => expect(alert).toHaveBeenCalledWith(OWNER_ONLY.error));
        expect(screen.getByRole('button', { name: /Unfreeze/ })).toBeInTheDocument();
        expect(screen.queryByTestId('freeze-button')).toBeNull();
    });
});
