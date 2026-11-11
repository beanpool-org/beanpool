import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrandedEscrowsPanel } from './StrandedEscrowsPanel';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';

const node: NodeProfile = {
    id: 'test-node',
    name: 'Test Node',
    url: 'https://test-node.local',
    credential: 'admin-secret-password',
};

// Every figure as the node sends it: whole hundredths of a Bean, in `*_c` fields (server engine/escrow-write-off.ts).
const hole = (tradeId: string, balance_c: number, commonsAfter_c: number): nodeClient.StrandedEscrowItem => ({
    escrowId: `escrow_${tradeId}`,
    balance_c,
    tradeId,
    trade: { status: 'cancelled', amount_c: -balance_c, postId: 'p1', createdAt: '2026-05-14T09:30:00.000Z', completedAt: '2026-09-20T11:06:43.000Z' },
    transactionCount: 1,
    lastTransaction: { memo: 'Escrow refund for removed post', amount_c: -balance_c, timestamp: '2026-09-20T11:06:43.000Z' },
    writeOff: { eligible: true, refusal: null, commonsAfter_c, wouldDeficit: commonsAfter_c < 0 },
});

// The test node on 2026-09-24: holes at -5 and -10, the Commons already at -11.68.
const list: nodeClient.StrandedEscrowsResponse = {
    success: true,
    commonsBalance_c: -1168,
    commonsAfterAll_c: -2668,
    eligibleCount: 2,
    escrows: [
        hole('70003252-aaaa-bbbb-cccc-000000000000', -1000, -2168),
        hole('96656bea-aaaa-bbbb-cccc-000000000000', -500, -1668),
        {
            ...hole('11112222-aaaa-bbbb-cccc-000000000000', 400, 0),
            trade: { status: 'completed', amount_c: 400, postId: 'p2', createdAt: null, completedAt: null },
            writeOff: { eligible: false, refusal: 'This escrow holds 4 Beans that a member paid in', commonsAfter_c: null, wouldDeficit: false },
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
        // A balance below zero with the true minus; a fraction of a Bean as hundredths.
        expect(screen.getByText('−10 Beans')).toBeInTheDocument();
        expect(screen.getByText('−5 Beans')).toBeInTheDocument();
        expect(screen.getByText('−11.68 Beans')).toBeInTheDocument();
        expect(screen.getByText('−26.68 Beans')).toBeInTheDocument();
        // A positive one is listed without the action, with why.
        expect(screen.getByText(/holds 4 Beans that a member paid in/)).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Write off from the Commons' })).toHaveLength(2);
    });

    it('asks for a reason and a deficit confirmation, showing the Commons before and after, then writes off', async () => {
        const writeOff = vi.spyOn(nodeClient, 'writeOffStrandedEscrow').mockResolvedValue({
            success: true, escrowId: list.escrows[1].escrowId, tradeId: list.escrows[1].tradeId, amount_c: 500,
            transactionId: 't1', memo: 'm', commonsBefore_c: -1168, commonsAfter_c: -1668,
        });
        const { onWrittenOff } = renderPanel();
        const buttons = await screen.findAllByRole('button', { name: 'Write off from the Commons' });
        fireEvent.click(buttons[1]); // the -5 one

        const submit = screen.getByRole('button', { name: 'Write off 5 Beans from the Commons' });
        expect(submit).toBeDisabled();
        // The form states the Commons now and after (the summary above also shows the Commons now).
        expect(screen.getByText(/The Commons now:/)).toHaveTextContent('The Commons now: −11.68 Beans · after this write-off: −16.68 Beans');

        fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: REASON } });
        expect(submit).toBeDisabled(); // the deficit is not confirmed yet
        fireEvent.click(screen.getByRole('checkbox', { name: /I confirm the Commons goes to −16.68 Beans/ }));
        expect(submit).toBeEnabled();

        fireEvent.click(submit);
        await waitFor(() => expect(writeOff).toHaveBeenCalledWith(
            node.url, list.escrows[1].escrowId, REASON, true, node.credential, undefined,
        ));
        expect(await screen.findByText('Wrote off 5 Beans from the Commons for trade 96656bea. The Commons now reads −16.68 Beans.')).toBeInTheDocument();
        expect(onWrittenOff).toHaveBeenCalled();
    });

    it('shows the server figures and asks again when the Commons moved since the list was read', async () => {
        vi.spyOn(nodeClient, 'fetchStrandedEscrows').mockResolvedValue({
            ...list,
            commonsBalance_c: 2000,
            escrows: [{ ...list.escrows[1], writeOff: { eligible: true, refusal: null, commonsAfter_c: 1500, wouldDeficit: false } }],
        });
        const writeOff = vi.spyOn(nodeClient, 'writeOffStrandedEscrow').mockRejectedValue(
            new nodeClient.StrandedEscrowWriteOffError('The Commons holds 2 Beans; writing off 5 Beans would leave it at −3', 'deficit_unconfirmed', 200, -300),
        );
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Write off from the Commons' }));
        fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: REASON } });
        const submit = screen.getByRole('button', { name: 'Write off 5 Beans from the Commons' });
        expect(submit).toBeEnabled(); // no deficit on the listed figures
        fireEvent.click(submit);

        expect(await screen.findByText(/would leave it at −3/)).toBeInTheDocument();
        expect(screen.getByText(/The Commons now:/)).toHaveTextContent('The Commons now: 2 Beans · after this write-off: −3 Beans');
        expect(screen.getByRole('checkbox', { name: /I confirm the Commons goes to −3 Beans/ })).not.toBeChecked();
        expect(submit).toBeDisabled();
        expect(writeOff).toHaveBeenCalledTimes(1);
    });

    // Whole hundredths are exact (DESIGN-atomic-beans): a Commons of 4.99 against a -5 hole is short by one hundredth, and
    // the panel says so as it is, −0.01, and still asks for the deficit confirmation, which the server's flag decides.
    it('asks for the deficit confirmation when the Commons falls short by one hundredth', async () => {
        vi.spyOn(nodeClient, 'fetchStrandedEscrows').mockResolvedValue({
            ...list,
            commonsBalance_c: 499,
            commonsAfterAll_c: -1,
            eligibleCount: 1,
            escrows: [{ ...list.escrows[1], writeOff: { eligible: true, refusal: null, commonsAfter_c: -1, wouldDeficit: true } }],
        });
        const writeOff = vi.spyOn(nodeClient, 'writeOffStrandedEscrow').mockResolvedValue({
            success: true, escrowId: list.escrows[1].escrowId, tradeId: list.escrows[1].tradeId, amount_c: 500,
            transactionId: 't1', memo: 'm', commonsBefore_c: 499, commonsAfter_c: -1,
        });
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Write off from the Commons' }));
        fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: REASON } });
        const submit = screen.getByRole('button', { name: 'Write off 5 Beans from the Commons' });
        expect(submit).toBeDisabled(); // the deficit is not confirmed yet
        expect(screen.getByText(/The Commons now:/)).toHaveTextContent('The Commons now: 4.99 Beans · after this write-off: −0.01 Beans');

        fireEvent.click(screen.getByRole('checkbox', { name: /I confirm the Commons goes to −0.01 Beans/ }));
        expect(submit).toBeEnabled();
        fireEvent.click(submit);
        await waitFor(() => expect(writeOff).toHaveBeenCalledWith(
            node.url, list.escrows[1].escrowId, REASON, true, node.credential, undefined,
        ));
    });

    it('offers the confirmation when the server refuses a deficit of one hundredth the list did not show', async () => {
        vi.spyOn(nodeClient, 'fetchStrandedEscrows').mockResolvedValue({
            ...list,
            commonsBalance_c: 2000,
            escrows: [{ ...list.escrows[1], writeOff: { eligible: true, refusal: null, commonsAfter_c: 1500, wouldDeficit: false } }],
        });
        const writeOff = vi.spyOn(nodeClient, 'writeOffStrandedEscrow')
            .mockRejectedValueOnce(new nodeClient.StrandedEscrowWriteOffError(
                'The Commons holds 4.99 Beans; writing off 5 Beans would leave it at −0.01. Confirm to let the Commons go into deficit',
                'deficit_unconfirmed', 499, -1,
            ))
            .mockResolvedValueOnce({
                success: true, escrowId: list.escrows[1].escrowId, tradeId: list.escrows[1].tradeId, amount_c: 500,
                transactionId: 't1', memo: 'm', commonsBefore_c: 499, commonsAfter_c: -1,
            });
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: 'Write off from the Commons' }));
        fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: REASON } });
        const submit = screen.getByRole('button', { name: 'Write off 5 Beans from the Commons' });
        fireEvent.click(submit);

        const confirm = await screen.findByRole('checkbox', { name: /I confirm the Commons goes to −0.01 Beans/ });
        expect(confirm).not.toBeChecked();
        expect(submit).toBeDisabled();
        fireEvent.click(confirm);
        expect(submit).toBeEnabled();
        fireEvent.click(submit);
        await waitFor(() => expect(writeOff).toHaveBeenLastCalledWith(
            node.url, list.escrows[1].escrowId, REASON, true, node.credential, undefined,
        ));
        expect(writeOff).toHaveBeenCalledTimes(2);
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
