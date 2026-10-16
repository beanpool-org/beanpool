import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PruneBranchModal } from './PruneBranchModal';
import { MemberDetailModal } from './MemberDetailModal';
import { OffboardMemberWizard } from './OffboardMemberWizard';
import { MembersModule } from './MembersModule';
import { pruneInviteBranch, pruneNodeUser } from '../../lib/node-client';

/**
 * Owner-delete S4a: removing or suspending an owner asks an owner's fresh proof each time (server ownerRemovalProof;
 * #1984 confirmation N-1): prune, branch prune, emergency suspend and offboard. Each viewer × the refusal → the box or
 * the sentence on the screen where the press was; the code travels in the body's `code`; nothing is re-sent without one.
 */
const NODE = 'https://riverbend.example.org';
const owner = 'a'.repeat(64);
const CODE_ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to remove or suspend an owner', totpRequired: true };
const WRONG = { error: 'Invalid 2FA code', totpRequired: true };
const STEP_UP = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const PHONE = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };
const PREVIEW = {
    member: { publicKey: owner, callsign: 'anna', status: 'active', joinedAt: '2026-01-01' },
    balance: 0, commonsBalance: 300, costToCommunity: 0, projectedCommonsBalance: 300, pendingEscrowsCount: 0, isSoleOwner: false,
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

async function enterCode(testId: string, code: string) {
    fireEvent.change(await screen.findByTestId(`${testId}-input`), { target: { value: code } });
    fireEvent.click(screen.getByTestId(`${testId}-confirm`));
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe('Prune branch with an owner in it (S4a)', () => {
    const root = { publicKey: owner, callsign: 'anna' };
    const press = () => {
        render(<PruneBranchModal rootMember={root} members={[root]} onConfirm={(pk, code) => pruneInviteBranch(NODE, pk, 'pw', undefined, code).then(() => {})} onClose={() => {}} />);
        fireEvent.change(screen.getByPlaceholderText(/Type "anna" to confirm/i), { target: { value: 'anna' } });
        fireEvent.click(screen.getByRole('button', { name: /Prune Entire Branch/i }));
    };

    it('password viewer: the box; a wrong code stays; a new code re-sends the same prune once with `code`', async () => {
        const sent = mockNode(`/branches/${owner}/prune`, [[401, CODE_ASK], [401, WRONG], [200, { success: true }]]);
        press();
        await enterCode('prune-branch-proof', '111111');
        await waitFor(() => expect(screen.getByTestId('prune-branch-proof-error')).toHaveTextContent('Invalid 2FA code'));
        expect(screen.getByTestId('prune-branch-proof-confirm')).toBeDisabled();
        await enterCode('prune-branch-proof', '222222');
        await waitFor(() => expect(sent).toHaveLength(3));
        expect(sent.map((s) => s.body.code)).toEqual([undefined, '111111', '222222']);
        // The refusal is not shown as a failure of its own.
        expect(screen.queryByText(/❌/)).toBeNull();
    });

    it('phone viewer, hand-off stale: the Manage-again sentence; nothing re-sent', async () => {
        const sent = mockNode(`/branches/${owner}/prune`, [[403, STEP_UP]]);
        press();
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

    it('suspend, password viewer: the code re-sent once beside the reason', async () => {
        const sent = mockNode(`/users/${owner}/suspend`, [[401, CODE_ASK], [200, { success: true, decision: { id: 'd1', closesAt: '2026-10-23T00:00:00.000Z' } }]]);
        render(<MemberDetailModal member={member} isFrozen={false} onToggleFreeze={vi.fn()} onClose={vi.fn()} nodeUrl={NODE} adminPassword="pw" />);
        fireEvent.click(screen.getByText('⏸️ Suspend'));
        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: 'took the treasury keys' } });
        fireEvent.click(screen.getByRole('button', { name: 'Suspend now' }));
        await enterCode('suspend-proof', '123456');
        expect(await screen.findByText(/Members now vote on keeping it until/)).toBeInTheDocument();
        expect(sent.map((s) => [s.body.reason, s.body.code])).toEqual([['took the treasury keys', undefined], ['took the treasury keys', '123456']]);
    });

    it('prune account through the members list: the box opens in the member\'s screen, not an alert; the code re-sends the prune', async () => {
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        const sent = mockNode(`/users/${owner}/prune`, [[401, CODE_ASK], [200, { success: true }]]);
        const onRefresh = vi.fn();
        render(
            <MembersModule
                nodeData={{ members: [{ publicKey: owner, name: 'Anna Owner', status: 'active' }], profiles: [{ publicKey: owner, name: 'Anna Owner' }], posts: [], health: { healthScore: 98, flags: [] }, reports: [] } as never}
                nodeDataLoading={false}
                onRefresh={onRefresh}
                onPruneUser={(pk, code) => pruneNodeUser(NODE, pk, 'pw', undefined, code).then(() => {})}
            />
        );
        fireEvent.click(await screen.findByText('Anna Owner'));
        fireEvent.click(await screen.findByRole('button', { name: /Prune Account/ }));
        fireEvent.click(screen.getByRole('button', { name: /Yes, Prune Account/ }));
        await enterCode('prune-proof', '654321');
        await waitFor(() => expect(onRefresh).toHaveBeenCalled());
        expect(sent.map((s) => s.body.code)).toEqual([undefined, '654321']);
        expect(alert).not.toHaveBeenCalled();
    });
});

describe('Offboard an owner (S4a)', () => {
    it('password viewer: the box; the code re-sent once with the same resolution', async () => {
        const sent = mockNode(`/members/${owner}/offboard`, [[401, CODE_ASK], [200, { success: true, memberPubkey: owner, callsign: 'anna', resolution: 'prune_zero_balance', balanceSettled: 0 }]],
            { [`/members/${owner}/offboard/preview`]: PREVIEW });
        const onSuccess = vi.fn();
        render(<OffboardMemberWizard member={{ publicKey: owner, callsign: 'anna' }} nodeUrl={NODE} adminPassword="pw" onSuccess={onSuccess} onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: /Confirm & Prune Member/ }));
        await enterCode('offboard-proof', '777777');
        await waitFor(() => expect(onSuccess).toHaveBeenCalled());
        expect(sent.map((s) => [s.body.resolution, s.body.code])).toEqual([['prune_zero_balance', undefined], ['prune_zero_balance', '777777']]);
    });

    it('phone viewer, hand-off stale: the Manage-again sentence; nothing re-sent', async () => {
        const sent = mockNode(`/members/${owner}/offboard`, [[403, STEP_UP]], { [`/members/${owner}/offboard/preview`]: PREVIEW });
        render(<OffboardMemberWizard member={{ publicKey: owner, callsign: 'anna' }} nodeUrl={NODE} onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: /Confirm & Prune Member/ }));
        expect(await screen.findByTestId('offboard-proof-step-up')).toBeInTheDocument();
        expect(sent).toHaveLength(1);
    });
});
