import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PruneBranchModal } from './PruneBranchModal';
import { MemberDetailModal } from './MemberDetailModal';
import { OffboardMemberWizard } from './OffboardMemberWizard';
import { MembersModule } from './MembersModule';
import { pruneInviteBranch, pruneNodeUser } from '../../lib/node-client';

/**
 * Owner-delete S4a: removing or suspending an owner asks an owner's fresh proof each time (server ownerRemovalProof;
 * #1984 confirmation N-1): prune, branch prune, emergency suspend and offboard. Each viewer × the refusal → the sentence
 * on the screen where the press was; nothing is re-sent until the button is pressed again, and no request carries a code
 * (the server asks none).
 */
const NODE = 'https://riverbend.example.org';
const owner = 'a'.repeat(64);
const STEP_UP = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };
const PREVIEW = {
    member: { publicKey: owner, callsign: 'anna', status: 'active', joinedAt: '2026-01-01' },
    balance_c: 0, commonsBalance_c: 30000, costToCommunity_c: 0, projectedCommonsBalance_c: 30000, pendingEscrowsCount: 0, isSoleOwner: false,
    activeMembers: [{ publicKey: 'b'.repeat(64), callsign: 'ben' }],
};

type Sent = { url: string; body: Record<string, unknown> };

/** A fake node: the route under test answers from `answers` in turn; anything else is a plain 200. */
function mockNode(route: string, answers: Array<[number, unknown]>, extra: Record<string, unknown> = {}) {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => json }) as Response;
        if (url.endsWith(route)) {
            sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
            const [status, json] = answers[Math.min(sent.length - 1, answers.length - 1)];
            return reply(status, json);
        }
        for (const [suffix, json] of Object.entries(extra)) if (url.endsWith(suffix)) return reply(200, json);
        return reply(200, {});
    }));
    return sent;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe('Prune branch with an owner in it (S4a)', () => {
    const root = { publicKey: owner, callsign: 'anna' };
    // The node's figures for the branch are in before Confirm can be pressed (PruneBranchModal).
    const press = async () => {
        render(<PruneBranchModal rootMember={root} loadFigures={() => Promise.resolve({ members: 1, badDebt_c: 0, surplus_c: 0, net_c: 0 })} onConfirm={(pk, code) => pruneInviteBranch(NODE, pk, 'pw', code).then(() => {})} onClose={() => {}} />);
        fireEvent.change(screen.getByPlaceholderText(/Type "anna" to confirm/i), { target: { value: 'anna' } });
        await waitFor(() => expect(screen.getByRole('button', { name: /Prune Entire Branch/i })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: /Prune Entire Branch/i }));
    };

    it('a stale unlock: the Manage-again sentence (no code field); the next press sends the same prune once more, with no code', async () => {
        const sent = mockNode(`/branches/${owner}/prune`, [[403, STEP_UP], [200, { success: true }]]);
        await press();
        expect(await screen.findByTestId('prune-branch-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(screen.queryByTestId('prune-branch-proof-input')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Prune Entire Branch/i }));
        await waitFor(() => expect(sent).toHaveLength(2));
        expect(sent.map((s) => s.body.code)).toEqual([undefined, undefined]);
        // The refusal is not shown as a failure of its own.
        expect(screen.queryByText(/❌/)).toBeNull();
    });

    it('phone viewer, hand-off stale: the Manage-again sentence; nothing re-sent', async () => {
        const sent = mockNode(`/branches/${owner}/prune`, [[403, STEP_UP]]);
        await press();
        expect(await screen.findByTestId('prune-branch-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(sent).toHaveLength(1);
        expect(screen.queryByText(/❌/)).toBeNull();
    });
});

describe('Member detail: suspend and prune an owner (S4a)', () => {
    const member = { publicKey: owner, callsign: 'anna', status: 'active' };

    it('suspend, computer viewer: the from-your-phone sentence; nothing re-sent, nothing said as suspended', async () => {
        const sent = mockNode(`/users/${owner}/suspend`, [[403, PHONE]]);
        render(<MemberDetailModal member={member} isFrozen={false} onToggleFreeze={vi.fn()} onClose={vi.fn()} nodeUrl={NODE} />);
        fireEvent.click(screen.getByText('⏸️ Suspend'));
        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: 'took the treasury keys' } });
        fireEvent.click(screen.getByRole('button', { name: 'Suspend now' }));
        expect(await screen.findByTestId('suspend-proof-phone')).toHaveTextContent('Do this from your phone');
        expect(sent).toHaveLength(1);
        expect(screen.queryByText(/Suspended\./)).toBeNull();
    });

    it('suspend with a stale unlock: the Manage-again sentence; the next press sends the same reason once more, with no code', async () => {
        const sent = mockNode(`/users/${owner}/suspend`, [[403, STEP_UP], [200, { success: true, decision: { id: 'd1', closesAt: '2026-10-23T00:00:00.000Z' } }]]);
        render(<MemberDetailModal member={member} isFrozen={false} onToggleFreeze={vi.fn()} onClose={vi.fn()} nodeUrl={NODE} credential="pw" />);
        fireEvent.click(screen.getByText('⏸️ Suspend'));
        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: 'took the treasury keys' } });
        fireEvent.click(screen.getByRole('button', { name: 'Suspend now' }));
        expect(await screen.findByTestId('suspend-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(screen.queryByTestId('suspend-proof-input')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Suspend now' }));
        expect(await screen.findByText(/Members now vote on keeping it until/)).toBeInTheDocument();
        expect(sent.map((s) => [s.body.reason, s.body.code])).toEqual([['took the treasury keys', undefined], ['took the treasury keys', undefined]]);
    });

    it('prune account through the members list: the box opens in the member\'s screen, not an alert; the next press sends the prune again, with no code', async () => {
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        // Prune Account is offered where the node's community votes are switched off (removal by vote S3).
        const sent = mockNode(`/users/${owner}/prune`, [[403, STEP_UP], [200, { success: true }]], { '/api/community/info': { features: { decisions: false } } });
        const onRefresh = vi.fn();
        render(
            <MembersModule
                nodeData={{ members: [{ publicKey: owner, name: 'Anna Owner', status: 'active' }], profiles: [{ publicKey: owner, name: 'Anna Owner' }], posts: [], health: { healthScore: 98, flags: [] }, reports: [] } as never}
                nodeDataLoading={false}
                activeNodeUrl={NODE}
                onRefresh={onRefresh}
                onPruneUser={(pk, code) => pruneNodeUser(NODE, pk, 'pw', code).then(() => {})}
            />
        );
        fireEvent.click(await screen.findByText('Anna Owner'));
        fireEvent.click(await screen.findByRole('button', { name: /Prune Account/ }));
        fireEvent.click(screen.getByRole('button', { name: /Yes, Prune Account/ }));
        expect(await screen.findByTestId('prune-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(screen.queryByTestId('prune-proof-input')).toBeNull();
        expect(onRefresh).not.toHaveBeenCalled();
        // The confirmation closed as it was pressed: ask for the prune again, and confirm again.
        fireEvent.click(await screen.findByRole('button', { name: /Prune Account/ }));
        fireEvent.click(screen.getByRole('button', { name: /Yes, Prune Account/ }));
        await waitFor(() => expect(onRefresh).toHaveBeenCalled());
        expect(sent.map((s) => s.body.code)).toEqual([undefined, undefined]);
        expect(alert).not.toHaveBeenCalled();
    });
});

describe('Offboard an owner (S4a)', () => {
    it('a stale unlock: the Manage-again sentence (no code field); the next press sends the same resolution once more, with no code', async () => {
        const sent = mockNode(`/members/${owner}/offboard`, [[403, STEP_UP], [200, { success: true, memberPubkey: owner, callsign: 'anna', resolution: 'prune_zero_balance', balanceSettled: 0 }]],
            { [`/members/${owner}/offboard/preview`]: PREVIEW });
        const onSuccess = vi.fn();
        render(<OffboardMemberWizard member={{ publicKey: owner, callsign: 'anna' }} nodeUrl={NODE} credential="pw" onSuccess={onSuccess} onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: /Confirm & Prune Member/ }));
        expect(await screen.findByTestId('offboard-proof-step-up')).toHaveTextContent('Press Manage on your phone again');
        expect(screen.queryByTestId('offboard-proof-input')).toBeNull();
        expect(onSuccess).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /Confirm & Prune Member/ }));
        await waitFor(() => expect(onSuccess).toHaveBeenCalled());
        expect(sent.map((s) => [s.body.resolution, s.body.code])).toEqual([['prune_zero_balance', undefined], ['prune_zero_balance', undefined]]);
    });

    it('phone viewer, hand-off stale: the Manage-again sentence; nothing re-sent', async () => {
        const sent = mockNode(`/members/${owner}/offboard`, [[403, STEP_UP]], { [`/members/${owner}/offboard/preview`]: PREVIEW });
        render(<OffboardMemberWizard member={{ publicKey: owner, callsign: 'anna' }} nodeUrl={NODE} onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: /Confirm & Prune Member/ }));
        expect(await screen.findByTestId('offboard-proof-step-up')).toBeInTheDocument();
        expect(sent).toHaveLength(1);
    });
});
