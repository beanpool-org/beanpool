import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrandedEscrowsPanel } from './StrandedEscrowsPanel';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';

const node: NodeProfile = {
    id: 'test-node',
    name: 'Test Node',
    url: 'https://test-node.local',
    adminPassword: 'admin-secret-password',
};

const hole = (tradeId: string, balance: number, commonsAfter: number): nodeClient.StrandedEscrowItem => ({
    escrowId: `escrow_${tradeId}`,
    balance,
    tradeId,
    trade: { status: 'cancelled', credits: -balance, postId: 'p1', createdAt: '2026-05-14T09:30:00.000Z', completedAt: '2026-09-20T11:06:43.000Z' },
    transactionCount: 1,
    lastTransaction: { memo: 'Escrow refund for removed post', amount: -balance, timestamp: '2026-09-20T11:06:43.000Z' },
    writeOff: { eligible: true, refusal: null, commonsAfter, wouldDeficit: commonsAfter < 0 },
});

// The test node on 2026-09-24: holes at -5 and -10, the Commons already at -11.68.
const list: nodeClient.StrandedEscrowsResponse = {
    success: true,
    commonsBalance: -11.68,
    commonsAfterAll: -26.68,
    eligibleCount: 2,
    escrows: [
        hole('70003252-aaaa-bbbb-cccc-000000000000', -10, -21.68),
        hole('96656bea-aaaa-bbbb-cccc-000000000000', -5, -16.68),
        {
            ...hole('11112222-aaaa-bbbb-cccc-000000000000', 4, 0),
            trade: { status: 'completed', credits: 4, postId: 'p2', createdAt: null, completedAt: null },
            writeOff: { eligible: false, refusal: 'This escrow holds 4 Beans that a member paid in', commonsAfter: null, wouldDeficit: false },
        },
    ],
};

const REASON = 'Refund from an escrow that was never funded';

function renderPanel(props: Partial<React.ComponentProps<typeof StrandedEscrowsPanel>> = {}) {
    const onWrittenOff = vi.fn();
    render(
        <StrandedEscrowsPanel activeNode={node} refreshKey={{ ok: false }} canWriteOff isStandby={false} onWrittenOff={onWrittenOff} {...props} />,
    );
    return { onWrittenOff };
}

describe('StrandedEscrowsPanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(nodeClient, 'fetchStrandedEscrows').mockResolvedValue(list);
    });

    it('lists each stranded escrow with its balance, its trade and the Commons after all', async () => {
        renderPanel();
        expect(await screen.findByText('escrow_70003252…')).toBeInTheDocument();
        expect(screen.getByText('-10 Beans')).toBeInTheDocument();
        expect(screen.getByText('-5 Beans')).toBeInTheDocument();
        expect(screen.getByText('-26.68 Beans')).toBeInTheDocument();
        // A positive one is listed without the action, with why.
        expect(screen.getByText(/holds 4 Beans that a member paid in/)).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Write off from the Commons' })).toHaveLength(2);
    });

    it('asks for a reason and a deficit confirmation, showing the Commons before and after, then writes off', async () => {
        const writeOff = vi.spyOn(nodeClient, 'writeOffStrandedEscrow').mockResolvedValue({
            success: true, escrowId: list.escrows[1].escrowId, tradeId: list.escrows[1].tradeId, amount: 5,
            transactionId: 't1', memo: 'm', commonsBefore: -11.68, commonsAfter: -16.68,
        });
        const { onWrittenOff } = renderPanel();
        const buttons = await screen.findAllByRole('button', { name: 'Write off from the Commons' });
        fireEvent.click(buttons[1]); // the -5 one

        const submit = screen.getByRole('button', { name: 'Write off 5 Beans from the Commons' });
        expect(submit).toBeDisabled();
        // The form states the Commons now and after (the summary above also shows the Commons now).
        expect(screen.getByText(/The Commons now:/)).toHaveTextContent('The Commons now: -11.68 Beans · after this write-off: -16.68 Beans');

        fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: REASON } });
        expect(submit).toBeDisabled(); // the deficit is not confirmed yet
        fireEvent.click(screen.getByRole('checkbox', { name: /I confirm the Commons goes to -16.68 Beans/ }));
        expect(submit).toBeEnabled();

        fireEvent.click(submit);
        await waitFor(() => expect(writeOff).toHaveBeenCalledWith(
            node.url, list.escrows[1].escrowId, REASON, true, node.adminPassword, undefined,
        ));
        expect(await screen.findByText(/Wrote off 5 Beans from the Commons/)).toBeInTheDocument();
        expect(onWrittenOff).toHaveBeenCalled();
    });

    it('shows the server figures and asks again when the Commons moved since the list was read', async () => {
        vi.spyOn(nodeClient, 'fetchStrandedEscrows').mockResolvedValue({
            ...list,
            commonsBalance: 20,
            escrows: [{ ...list.escrows[1], writeOff: { eligible: true, refusal: null, commonsAfter: 15, wouldDeficit: false } }],
        });
        const writeOff = vi.spyOn(nodeClient, 'writeOffStrandedEscrow').mockRejectedValue(
            new nodeClient.StrandedEscrowWriteOffError('The Commons holds 2 Beans; writing off 5 Beans would leave it at -3', 'deficit_unconfirmed', 2, -3),
        );
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Write off from the Commons' }));
        fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: REASON } });
        const submit = screen.getByRole('button', { name: 'Write off 5 Beans from the Commons' });
        expect(submit).toBeEnabled(); // no deficit on the listed figures
        fireEvent.click(submit);

        expect(await screen.findByText(/would leave it at -3/)).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: /I confirm the Commons goes to -3 Beans/ })).not.toBeChecked();
        expect(submit).toBeDisabled();
        expect(writeOff).toHaveBeenCalledTimes(1);
    });

    it('offers no action to a non-owner', async () => {
        renderPanel({ canWriteOff: false });
        expect(await screen.findByText('Only an owner of this node can write one off.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Write off from the Commons' })).toBeNull();
    });

    it('says to use the main server on a standby', async () => {
        renderPanel({ isStandby: true });
        expect(await screen.findByText(/This node is a standby/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Write off from the Commons' })).toBeNull();
    });

    it('renders nothing when nothing is stranded, or when a server answers without a list', async () => {
        const fetchSpy = vi.spyOn(nodeClient, 'fetchStrandedEscrows').mockResolvedValue({ success: true } as nodeClient.StrandedEscrowsResponse);
        const { container } = render(
            <StrandedEscrowsPanel activeNode={node} refreshKey={{ ok: true }} canWriteOff isStandby={false} onWrittenOff={vi.fn()} />,
        );
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });
});
