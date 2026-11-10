/**
 * The Credit line tab beside Beans on Send, on the web (slice G1; lib/credit-gift.ts; the node's engine/credit-gift.ts;
 * DESIGN-invites-and-names-list-amend2-fable.md §6), as the phone's (apps/native utils/__tests__/ledger-credit-gift.test.ts):
 * the tab only when the node offers it (the owner's 0 turns it off); its words carry the node's number; what is sent is
 * the recipient and the amount and nothing else; every refusal is the node's own sentence, shown as it comes; with Beans
 * locked and part of the line to give, Send opens on the tab. The node client is the one lib/api `request`.
 */
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { LedgerPage } from './LedgerPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getBalance, getMembers, request } from '../lib/api';
import { forgetRecentLookups } from '../lib/members-on-demand';

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../components/CommonsInfoModal', () => ({ CommonsInfoModal: () => null }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/api', () => ({
    getBalance: vi.fn(),
    // V3: the Ledger asks whether this member is a voucher (null = not one), beside the gift offer.
    getMyVouching: vi.fn(async () => null),
    getTransactions: vi.fn(async () => []),
    getMembers: vi.fn(async () => []),
    getMemberCards: vi.fn(async () => []),
    sendTransfer: vi.fn(),
    saveHomePreferences: vi.fn(async () => ({ success: true })),
    getCommunityMe: vi.fn(async () => ({ features: null })),
    request: vi.fn(),
}));
vi.mock('../lib/identity', async (orig) => ({
    ...(await orig<typeof import('../lib/identity')>()),
    loadIdentity: vi.fn(async () => ({ publicKey: 'viewer-pubkey', privateKey: 'viewer-private-key', callsign: 'Visitor', createdAt: '2026-09-17T00:00:00.000Z' })),
}));
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ profile: 'local', features: {} })),
    resetCommunityInfoOnce: vi.fn(),
}));
import { resetReaderFeaturesOnce } from '../lib/features';

const identity: BeanPoolIdentity = { publicKey: 'viewer-pubkey', privateKey: 'viewer-private-key', callsign: 'Visitor', createdAt: '2026-09-17T00:00:00.000Z' };
const DANA = 'd'.repeat(64);
/** The node's refusals a gift can meet (engine/credit-gift.ts), each shown exactly as it comes. */
const REFUSALS = [
    'Giving part of your credit line is off in this community.',
    'A credit-line gift is a whole number of Beans, 1 or more.',
    'You can give up to 100 Beans of your credit line at once here.',
    'You can’t give your credit line to yourself.',
    'Only an active member of this community can be given part of a credit line.',
    'An enterprise can’t be given part of a credit line.',
    'Your credit line is frozen, so you can’t give part of it until an admin unfreezes it.',
    'You can give part of your credit line after your first completed trade, as with sending Beans.',
    'You’ve no credit line left to give: only credit line someone gave you can be passed on. Your known floor and the credit you earned stay yours.',
    'You hold 25 Beans of credit line someone gave you, so you can’t give 50.',
    'You’re using part of your credit line, so you can give 8 Beans of it at most now.',
    'You’re using the credit line someone gave you, so none of it is free to give now.',
    '@Dana can’t be given part of a credit line right now.',
    'This gift would take @Dana’s credit line past the most this community allows (2000 Beans), so it can’t be given.',
];

const node = vi.hoisted(() => ({ offer: null as any, refuse: null as string | null, gifts: [] as unknown[] }));

beforeEach(() => {
    vi.clearAllMocks();
    forgetRecentLookups();
    resetReaderFeaturesOnce();
    node.offer = { offered: true, max: 10000, room: 10000, canGive: 10000, why: null };
    node.refuse = null;
    node.gifts = [];
    vi.mocked(getBalance).mockResolvedValue({ balance_c: 10000, earnedCredit_c: 200, floor_c: 0, commonsBalance_c: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
    vi.mocked(getMembers).mockResolvedValue([{ publicKey: DANA, callsign: 'Dana' }] as any);
    vi.mocked(request).mockImplementation(async (method: string, path: string, body?: unknown) => {
        if (path !== '/api/credit/gift') throw Object.assign(new Error('not found'), { status: 404 });
        if (method === 'GET') {
            if (!node.offer) throw Object.assign(new Error('not found'), { status: 404 });
            return node.offer;
        }
        node.gifts.push(body);
        if (node.refuse) throw new Error(node.refuse);
        return { amount_c: (body as any).amount_c, room: 5000, canGive: 5000 };
    });
});

async function openWallet() {
    render(<LedgerPage identity={identity} isMember={true} />);
    await waitFor(() => expect(getMembers).toHaveBeenCalled());
    await waitFor(() => expect(request).toHaveBeenCalledWith('GET', '/api/credit/gift'));
    fireEvent.click(await screen.findByRole('button', { name: /Wallet/ }));
}
async function openCreditTab() {
    await openWallet();
    fireEvent.click(await screen.findByRole('button', { name: /Send Beans/ }));
    fireEvent.click(await screen.findByTestId('send-kind-credit'));
}
async function pickDana() {
    fireEvent.click(screen.getByRole('button', { name: /Select recipient/ }));
    fireEvent.click(await screen.findByText('Dana'));
}
const give = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Give credit line' })); }); };

describe('the Credit line tab beside Beans on Send (G1), on the web', () => {
    it('no tab when the node does not offer it: the owner set 0, no credit line someone gave them, or a node from before G1', async () => {
        for (const offer of [{ offered: false, max: 0, room: 6000, canGive: 0, why: 'Giving part of your credit line is off in this community.' }, { offered: false, max: 10000, room: 0, canGive: 0, why: null }, null]) {
            node.offer = offer;
            const { unmount } = render(<LedgerPage identity={identity} isMember={true} />);
            await waitFor(() => expect(request).toHaveBeenCalledWith('GET', '/api/credit/gift'));
            fireEvent.click(await screen.findByRole('button', { name: /Wallet/ }));
            fireEvent.click(await screen.findByRole('button', { name: /Send Beans/ }));
            expect(screen.queryByTestId('send-kind-tabs')).toBeNull();
            expect(screen.queryByText('Credit line')).toBeNull();
            expect(screen.getByPlaceholderText('Amount (B)')).toBeInTheDocument();
            unmount();
            vi.mocked(request).mockClear();
        }
    });

    it('the tab gives what is typed to whom is picked, and nothing else; the words carry the node\'s number', async () => {
        await openCreditTab();
        expect(screen.getByTestId('send-kind-beans')).toHaveTextContent('Beans');
        expect(screen.getByTestId('credit-gift-words')).toHaveTextContent('Give part of your credit line. You can give up to 100: the part someone gave you that you aren’t using. It’s theirs for good.');
        await pickDana();
        expect(screen.getByTestId('credit-gift-words')).toHaveTextContent('Give @Dana part of your credit line. You can give up to 100: the part someone gave you that you aren’t using. It’s theirs for good.');
        expect(screen.queryByPlaceholderText('Memo (optional)')).toBeNull();
        fireEvent.change(screen.getByLabelText('Credit line to give'), { target: { value: '50' } });
        await give();
        expect(node.gifts).toEqual([{ memberPubkey: DANA, amount_c: 5000 }]); // 50 typed, whole hundredths sent
        expect(await screen.findByTestId('credit-gift-note')).toHaveTextContent('✓ Given!');
    });

    it('every refusal is the node\'s own sentence, shown as it comes', async () => {
        await openCreditTab();
        await pickDana();
        for (const sentence of REFUSALS) {
            node.refuse = sentence;
            fireEvent.change(screen.getByLabelText('Credit line to give'), { target: { value: '50' } });
            await give();
            expect(await screen.findByTestId('credit-gift-note')).toHaveTextContent(sentence);
        }
        expect(node.gifts.length).toBe(REFUSALS.length);
    });

    it('nothing to give now: the node\'s why, and Give stays off', async () => {
        node.offer = { offered: true, max: 10000, room: 1700, canGive: 0, why: 'You’re using the credit line someone gave you, so none of it is free to give now.' };
        await openCreditTab();
        await pickDana();
        expect(screen.getByTestId('credit-gift-words')).toHaveTextContent('You’re using the credit line someone gave you, so none of it is free to give now.');
        fireEvent.change(screen.getByLabelText('Credit line to give'), { target: { value: '5' } });
        expect(screen.getByRole('button', { name: 'Give credit line' })).toBeDisabled();
        expect(node.gifts).toEqual([]);
    });

    it('Beans locked (nothing held) but part of the line to give: Send opens on the Credit line tab, the Beans tab says why', async () => {
        vi.mocked(getBalance).mockResolvedValue({ balance_c: 0, earnedCredit_c: 200, floor_c: 0, commonsBalance_c: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
        await openWallet();
        expect(screen.queryByRole('button', { name: /^💸 Send Beans$/ })).toBeNull();
        fireEvent.click(await screen.findByRole('button', { name: 'Give part of your credit line' }));
        expect(screen.getByTestId('credit-gift-words')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('send-kind-beans'));
        expect(screen.getByTestId('send-beans-locked')).toHaveTextContent('You can only send beans you currently hold — direct sends require a positive balance.');
        expect(screen.queryByRole('button', { name: 'Confirm Transfer' })).toBeNull();
    });

    it('Beans locked, and all of it given: the node\'s sentence for that, and Cancel closes the form (round 2)', async () => {
        vi.mocked(getBalance).mockResolvedValue({ balance_c: 0, earnedCredit_c: 200, floor_c: 0, commonsBalance_c: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
        node.offer = { offered: true, max: 10000, room: 2500, canGive: 2500, why: null };
        await openWallet();
        fireEvent.click(await screen.findByRole('button', { name: 'Give part of your credit line' }));
        await pickDana();
        fireEvent.change(screen.getByLabelText('Credit line to give'), { target: { value: '25' } });
        const allGiven = 'You’ve no credit line left to give: only credit line someone gave you can be passed on. Your known floor and the credit you earned stay yours.';
        node.offer = { offered: false, max: 10000, room: 0, canGive: 0, why: allGiven };
        await give();
        expect(node.gifts).toEqual([{ memberPubkey: DANA, amount_c: 2500 }]);
        expect(await screen.findByTestId('credit-gift-note')).toHaveTextContent('✓ Given!');
        await waitFor(() => expect(screen.getByTestId('credit-gift-words')).toHaveTextContent(allGiven));
        expect(document.body.textContent).not.toContain('nobody has given you any');
        // Nothing left to send or give, the form still open: its button is Cancel, never the lock, and it closes the form.
        const cancel = screen.getByRole('button', { name: '✕ Cancel' });
        expect(cancel).not.toBeDisabled();
        expect(screen.queryByRole('button', { name: /Send Beans \(needs positive balance\)/ })).toBeNull();
        fireEvent.click(cancel);
        expect(screen.queryByTestId('credit-gift-words')).toBeNull();
        expect(screen.getByRole('button', { name: /Send Beans \(needs positive balance\)/ })).toBeDisabled();
    });

    it('a gift closes the form on its own after "✓ Given!" is read, as on the phone', async () => {
        await openCreditTab();
        await pickDana();
        fireEvent.change(screen.getByLabelText('Credit line to give'), { target: { value: '10' } });
        await give();
        expect(await screen.findByTestId('credit-gift-note')).toHaveTextContent('✓ Given!');
        await waitFor(() => expect(screen.queryByTestId('credit-gift-words')).toBeNull(), { timeout: 3000 });
        expect(screen.getByRole('button', { name: /Send Beans/ })).not.toBeDisabled();
    });

    it('Beans locked and nothing to give: Send stays locked as before', async () => {
        vi.mocked(getBalance).mockResolvedValue({ balance_c: 0, earnedCredit_c: 200, floor_c: 0, commonsBalance_c: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
        node.offer = { offered: true, max: 10000, room: 5000, canGive: 0, why: 'You’re using the credit line someone gave you, so none of it is free to give now.' };
        await openWallet();
        expect(await screen.findByRole('button', { name: /Send Beans \(needs positive balance\)/ })).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Give part of your credit line' })).toBeNull();
    });

    it('at 320px with 1.3x text the two tabs share the row and each wraps its words, never cut short', async () => {
        await openCreditTab();
        expect(screen.getByTestId('send-kind-tabs')).toHaveClass('flex');
        for (const id of ['send-kind-beans', 'send-kind-credit']) {
            expect(screen.getByTestId(id)).toHaveClass('flex-1', 'min-w-0', 'min-h-[44px]', 'break-words');
            expect(screen.getByTestId(id).className).not.toMatch(/truncate|whitespace-nowrap/);
        }
        expect(screen.getByTestId('credit-gift-words')).toHaveClass('break-words');
    });
});
