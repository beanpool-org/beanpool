import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forgetRecentLookups } from '../lib/members-on-demand';

// Each case asks the node afresh: an answer kept from the last case (the search's and near read's recent answers) isn't this one's.
beforeEach(() => forgetRecentLookups());
import React from 'react';
import { LedgerPage } from './LedgerPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getBalance, getMembers, getMemberCards, getTransactions, sendTransfer, saveHomePreferences, getMyVouching } from '../lib/api';
import { addDateWords, formatHundredths, setLanguage } from '@beanpool/core';
import { dateWords as frDates } from '@beanpool/core/words-dates/fr';
import { onSyncActivity } from '../lib/sync';
import { getBlockedUsers } from '../lib/blocklist';

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../components/CommonsInfoModal', () => ({
    CommonsInfoModal: () => null,
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../lib/api', () => ({
    getBalance: vi.fn(),
    getTransactions: vi.fn(async () => []),
    getMembers: vi.fn(async () => []),
    getMemberCards: vi.fn(async () => []),
    sendTransfer: vi.fn(),
    saveHomePreferences: vi.fn(async () => ({ success: true })),
    // The reader's own set (GET /api/community/me): none unless a test says (BeanID's verified member: Beans live).
    getCommunityMe: vi.fn(async () => ({ features: reader.value })),
    getMyVouching: vi.fn(async () => null),
}));
const reader = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('../lib/identity', async (orig) => ({
    ...(await orig<typeof import('../lib/identity')>()),
    loadIdentity: vi.fn(async () => ({ publicKey: 'viewer-pubkey', privateKey: 'viewer-private-key', callsign: 'Visitor', createdAt: '2026-09-17T00:00:00.000Z' })),
}));
import { resetReaderFeaturesOnce } from '../lib/features';
beforeEach(() => { resetReaderFeaturesOnce(); reader.value = null; });

// The node's /api/community/info, read once per page load: a local community (no members on demand) unless a test says.
const info = vi.hoisted(() => ({ value: { profile: 'local', features: {} } as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => info.value),
    resetCommunityInfoOnce: vi.fn(),
}));
import { communityInfoOnce, resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';

const identity: BeanPoolIdentity = {
    publicKey: 'viewer-pubkey',
    privateKey: 'viewer-private-key',
    callsign: 'Visitor',
    createdAt: '2026-09-17T00:00:00.000Z',
};

/**
 * The Ledger's half of Learn's "🫘 Thank {name}" (slice K8; DESIGN-local-knowledge-fable.md §3.7): Send opened by another page
 * with a recipient and a note (`sendStart`, from App.tsx). One table over the reader (can send, first trade required, positive
 * balance required, the recipient being themselves) -> the Beans form with the writer chosen and the note filled / today's words
 * with the writer kept / nothing. Then the form honours both and changes nothing else: each is changeable, what is sent is what
 * the form shows, and Send opened by its own button is as before (LedgerPage.test.tsx's Send tests stay as they are).
 */
const ADA = 'a'.repeat(64);
const DANA = 'd'.repeat(64);
const THANK = { to: ADA, name: 'Ada', note: 'Thanks for "How recycling works at the tip"' };
const FIGURES = {
    'can send': { balance_c: 12000, earnedCredit_c: 300 },
    'first trade required': { balance_c: 12000, earnedCredit_c: 0 },
    'positive balance required': { balance_c: 0, earnedCredit_c: 300 },
} as const;
type Reader = keyof typeof FIGURES;

describe('Send opened by Learn\'s Thank (K8)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getBlockedUsers).mockReturnValue([]);
        // Ada is not in the list the picker holds: her name comes with the request.
        vi.mocked(getMembers).mockResolvedValue([{ publicKey: DANA, callsign: 'Dana' }] as any);
        vi.mocked(sendTransfer).mockResolvedValue({} as any);
    });
    const balance = (reader: Reader) => vi.mocked(getBalance).mockResolvedValue({ ...FIGURES[reader], floor_c: 0, commonsBalance_c: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
    const open = async (start: typeof THANK | null = THANK) => {
        const taken = vi.fn();
        render(<LedgerPage identity={identity} isMember={true} sendStart={start} onSendStartTaken={taken} />);
        await waitFor(() => expect(getBalance).toHaveBeenCalled());
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        return taken;
    };
    const memo = () => screen.queryByPlaceholderText('Memo (optional)') as HTMLInputElement | null;
    const amount = () => screen.queryByPlaceholderText('Amount (B)') as HTMLInputElement | null;
    const locked = () => screen.queryByTestId('send-beans-locked');

    const TABLE: Array<[Reader, 'form' | 'first-trade' | 'positive-balance']> = [
        ['can send', 'form'],
        ['first trade required', 'first-trade'],
        ['positive balance required', 'positive-balance'],
    ];
    it.each(TABLE)('%s -> %s (red when the request is dropped, the gate is skipped, or new words replace today\'s)', async (reader, outcome) => {
        balance(reader);
        const taken = await open();
        // Taken once, after the member's figures were read.
        await waitFor(() => expect(taken).toHaveBeenCalledTimes(1));
        // The form is open on the Wallet with the writer chosen, whatever the outcome: the member sees whom they meant to thank.
        expect(screen.getByRole('button', { name: /Ada/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '✕ Cancel' })).toBeInTheDocument();
        if (outcome === 'form') {
            expect(memo()?.value).toBe(THANK.note);
            expect(amount()?.value).toBe('');
            expect(locked()).toBeNull();
        } else {
            // Today's words, as the form says them to a member who can't send Beans yet; no amount, no note, no Confirm.
            expect(locked()?.textContent).toBe(outcome === 'first-trade'
                ? '🔒 Direct sends unlock after your first completed trade on the Marketplace, and require a positive balance.'
                : '🔒 You can only send beans you currently hold — direct sends require a positive balance.');
            expect(amount()).toBeNull();
            expect(memo()).toBeNull();
            expect(screen.queryByRole('button', { name: 'Confirm Transfer' })).toBeNull();
        }
        expect(sendTransfer).not.toHaveBeenCalled();
    });

    it('the recipient being the member themselves: no form (Learn shows no button for one\'s own page; this is the guard behind it)', async () => {
        balance('can send');
        const taken = await open({ ...THANK, to: 'viewer-pubkey', name: 'Visitor' });
        await waitFor(() => expect(taken).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('button', { name: '✕ Cancel' })).toBeNull();
        expect(memo()).toBeNull();
    });

    it('sends what the form shows: the writer and the note as filled in, the typed amount, through the ordinary send', async () => {
        balance('can send');
        await open();
        await waitFor(() => expect(memo()?.value).toBe(THANK.note));
        fireEvent.change(amount()!, { target: { value: '5' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm Transfer' })); });
        expect(sendTransfer).toHaveBeenCalledWith('viewer-pubkey', ADA, 500, THANK.note);
    });

    it('both are changeable: another note, another recipient from the picker, and that is what is sent', async () => {
        balance('can send');
        await open();
        await waitFor(() => expect(memo()?.value).toBe(THANK.note));
        fireEvent.change(memo()!, { target: { value: 'Ta!' } });
        fireEvent.click(screen.getByRole('button', { name: /Ada/ }));
        fireEvent.click(await screen.findByText('Dana'));
        fireEvent.change(amount()!, { target: { value: '2' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm Transfer' })); });
        expect(sendTransfer).toHaveBeenCalledWith('viewer-pubkey', DANA, 200, 'Ta!');
    });

    it('with no request, the Ledger opens as before: no form, nothing chosen', async () => {
        balance('can send');
        const taken = await open(null);
        expect(taken).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: '✕ Cancel' })).toBeNull();
        expect(memo()).toBeNull();
    });
});

