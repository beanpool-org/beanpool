/**
 * The Ledger in the member's language (words S3, web sweep W2): the balance, the credit-line cards, the Levels tab (the
 * hero, the shelf, each level's detail, the way to the next, what builds trust), the Wallet (the tiles, the send form and
 * its notes and refusals, the circulation box, the rows) through t()/tn(), with the phone's Ledger keys (S3i) where the
 * English is the same; members' names and notes, and what the node writes, as they came. In English every word is as it
 * was, and a switch to Russian redraws the page in Russian where the words have it.
 *
 * The frozen-line card's sentences are lib/credit-line-card.ts's (the phone's, through t()/tn()). Left English here (listed
 * in the PR): a node's note on a line. A row's date is core's ('{date}, {time}').
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { forgetRecentLookups } from '../lib/members-on-demand';
import { resetReaderFeaturesOnce } from '../lib/features';
import { useLanguage } from '../lib/useLanguage';
import { LedgerPage } from './LedgerPage';
import { getBalance, getMemberCards, getMembers, getTransactions, request, sendTransfer } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-w2.test-support';
import { TIER_LEVELS } from '@beanpool/core';
import ruWords from '../../words/ru.json';

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => [BLOCKED]), onBlocklistUpdated: vi.fn(() => () => {}) }));
// Other screens' cards, with words of their own sweeps: the Commons modal (closed here) and the pay-back card.
vi.mock('../components/CommonsInfoModal', () => ({ CommonsInfoModal: () => null }));
vi.mock('../components/RepaymentCard', () => ({ RepaymentCard: () => null }));
vi.mock('../lib/api', () => ({
    getBalance: vi.fn(),
    getTransactions: vi.fn(async () => []),
    getMembers: vi.fn(async () => []),
    getMemberCards: vi.fn(async () => []),
    sendTransfer: vi.fn(),
    request: vi.fn(),
    getCommunityMe: vi.fn(async () => ({ features: reader.value })),
}));
const reader = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
const info = vi.hoisted(() => ({ value: { profile: 'local', features: {} } as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => info.value), resetCommunityInfoOnce: vi.fn() }));

const BLOCKED = '7'.repeat(64);
const DANA = '1'.repeat(64);
const identity: BeanPoolIdentity = { publicKey: '9'.repeat(64), privateKey: 'p', callsign: 'Visitor', createdAt: '2026-09-17T00:00:00.000Z' };
const RU = ruWords as Record<string, unknown>;

/** The credit bar's bold parts, drawn inside their bracketed sentence (CreditBar.words.test.tsx checks them there). */
const barBold = () => Array.from(document.querySelectorAll('[role="meter"] b')).map((b) => b.textContent ?? '');

const TS = '2026-10-01T10:00:00.000Z';
const line = (id: string, from: string, to: string, memo: string) => ({ id, from, to, amount: 3, taxFee: 0, memo, timestamp: TS });
/** What members and the node wrote, shown as written: names and notes on lines. */
const OTHERS = ['Visitor', 'Dana', 'thanks for the eggs', 'for the bread: '];

/** A Newcomer with no credit line, nothing to send. */
const NEWCOMER = { balance: 0, floor: 0, activated: false, commonsBalance: 12.5, callsign: 'Visitor', tier: { name: 'Newcomer' } };
/** A Resident trading: Beans to send, part of the line unlocked by one live offer, spending paused, ratings. */
const RESIDENT = {
    balance: 450, floor: -1000, usableFloor: -200, liveOffers: 1, frozen: true, activated: true, earnedCredit: 300, tierCredit: 400,
    commonsBalance: 1234.5, qualifiedValue: 2500, avgRating: 4.5, reviewCount: 3, trustStats: { uniquePartners: 6 },
    callsign: 'Visitor', tier: { name: 'Resident' },
};

beforeEach(() => {
    vi.clearAllMocks();
    forgetRecentLookups();
    resetReaderFeaturesOnce();
    reader.value = null;
    info.value = { profile: 'local', features: {} };
    vi.mocked(getTransactions).mockResolvedValue([]);
    vi.mocked(getMembers).mockResolvedValue([{ publicKey: DANA, callsign: 'Dana' }] as any);
});
afterEach(() => { cleanup(); backToEnglish(); });

async function open(balance: Record<string, unknown>) {
    vi.mocked(getBalance).mockResolvedValue(balance as any);
    render(<LedgerPage identity={identity} isMember={true} onNavigate={vi.fn()} />);
    await waitFor(() => expect(getTransactions).toHaveBeenCalled());
    await screen.findByTestId('ledger-balance');
}

describe('the Ledger in the pseudo-locale', () => {
    it('a Newcomer: the balance, the no-credit-line card, the Levels tab and each level\'s detail', async () => {
        await showIn('xx');
        await open(NEWCOMER);
        expect(screen.getByText(xx('No credit line yet'))).toBeInTheDocument();
        expect(screen.getByText(xx('YOUR TRUST LEVEL'))).toBeInTheDocument();
        expect(screen.getByText(xx('Send (needs 1st trade)'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(25);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        // Each level in turn: Reached, the next, one further up (its floor, its perks, the trust still to go).
        const shelf = screen.getByTestId('levels-shelf');
        for (const button of within(shelf).getAllByRole('button')) {
            fireEvent.click(button);
            expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        }
        expect(screen.getByTestId('level-detail').textContent).toContain(xx('Up ahead'));
    });

    it('a Resident: the credit bar with spending paused, the Levels hero and the way to the next level', async () => {
        await showIn('xx');
        await open(RESIDENT);
        expect(screen.getByText(xx('WHAT BUILDS YOUR TRUST'))).toBeInTheDocument();
        expect(screen.getByText(xx('Spending paused — your balance is below what your {n} active offer unlock (−{limit}). Post an Offer or trade back up to lift it. You can still receive and sell.').replace('{n}', '1').replace('{limit}', '200'))).toBeInTheDocument();
        expect(screen.getByText(xx('{n} trust to go').replace('{n}', String(TIER_LEVELS[2].minCredit - RESIDENT.tierCredit)))).toBeInTheDocument();
        expect(barBold()).toHaveLength(2);
        expect(bypassing(document.body, { others: [...OTHERS, ...barBold()] })).toEqual([]);
    });

    it('a frozen line: the card, how far down a member in debit is, and the known part frozen under the bar', async () => {
        await showIn('xx');
        await open({ ...NEWCOMER, balance: -12.25, creditFrozen: true });
        expect(screen.getByText(xx('Your credit line is frozen'))).toBeInTheDocument();
        expect(screen.getByTestId('ledger-frozen-debit').textContent).toBe(
            xx('You are {n} Beans in debit. Selling or receiving Beans brings you back up, and once you are above zero you can spend what you hold.').replace('{n}', '12.3'),
        );
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        cleanup();

        vi.mocked(getTransactions).mockClear();
        await open({ ...RESIDENT, frozen: false, knownFrozen: true });
        expect(await screen.findByText(xx("Your community's admins have frozen the part of your credit line that comes from being a confirmed member; the rest works as before. To ask why, ask one of the admins."))).toBeInTheDocument();
        expect(bypassing(document.body, { others: [...OTHERS, ...barBold()] })).toEqual([]);
    });

    it('the Wallet: tiles, the circulation box, the send form, its picker, a refusal, and the rows', async () => {
        vi.mocked(getTransactions).mockResolvedValue([
            line('t1', DANA, identity.publicKey, 'thanks for the eggs'),
            line('t2', identity.publicKey, DANA, 'for the bread: 0a1b2c3d-1111-2222-3333-444455556666'),
            line('t3', BLOCKED, identity.publicKey, 'meet me behind the shed'),
        ] as any);
        await showIn('xx');
        await open({ ...RESIDENT, frozen: false });
        fireEvent.click(screen.getByRole('button', { name: xx('💸 Wallet') }));
        expect(await screen.findByTestId('ledger-wallet')).toBeInTheDocument();
        expect(screen.getByText(xx('Recent Transactions'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('View Offer') })).toBeInTheDocument();
        expect(screen.getByText(xx('Beans from a member you blocked'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: [...OTHERS, ...barBold()] })).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Send Beans').replace(/[[\]~]/g, '.')) }));
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Select recipient...').replace(/[[\]~.]/g, '.')) }));
        expect(screen.getByPlaceholderText(xx('Search members...'))).toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText(xx('Search members...')), { target: { value: 'zzz' } });
        expect(screen.getByTestId('ledger-picker-note').textContent).toBe(xx('No members found'));
        fireEvent.change(screen.getByPlaceholderText(xx('Search members...')), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: /Dana/ }));
        fireEvent.change(screen.getByPlaceholderText(xx('Amount (B)')), { target: { value: '9999' } });
        expect(screen.getByText(xx('Recipient receives:'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: [...OTHERS, ...barBold(), 'zzz', '9999'] })).toEqual([]);

        // More than they hold: refused in words, before anything is sent.
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('Confirm Transfer') })); });
        expect(screen.getByText(xx('You can only send beans you hold — your balance is {balance}B.').replace('{balance}', '450.00'))).toBeInTheDocument();
        expect(sendTransfer).not.toHaveBeenCalled();
        // A send the node refused with no words of its own.
        fireEvent.change(screen.getByPlaceholderText(xx('Amount (B)')), { target: { value: '5' } });
        vi.mocked(sendTransfer).mockRejectedValueOnce(new Error(''));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('Confirm Transfer') })); });
        expect(await screen.findByText(xx('Transfer failed'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: [...OTHERS, ...barBold(), '5'] })).toEqual([]);
    });

    it('the Wallet with nothing to send yet, no rows, and an export that failed', async () => {
        const said: string[] = [];
        vi.stubGlobal('alert', (m: string) => { said.push(m); });
        vi.mocked(request).mockRejectedValueOnce(new Error(''));
        await showIn('xx');
        await open(NEWCOMER);
        fireEvent.click(screen.getByRole('button', { name: xx('💸 Wallet') }));
        expect(await screen.findByText(xx('No transactions yet. Start trading on the Marketplace!'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('🔒 Send Beans (needs 1 completed trade)') })).toBeDisabled();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('⬇️ Export mine') })); });
        expect(said).toEqual([xx('Export failed')]);
        expect(bypassing(document.body, { others: OTHERS, said })).toEqual([]);
        vi.unstubAllGlobals();
    });

    it('a balance that could not be read, and the worldwide community\'s picker notes', async () => {
        vi.mocked(getBalance).mockRejectedValue(new Error('Member not found'));
        await showIn('xx');
        render(<LedgerPage identity={identity} isMember={true} />);
        expect(await screen.findByText(xx('Failed to load balance'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        cleanup();

        info.value = { profile: 'global', features: { membersOnDemand: true, beans: false } };
        reader.value = { membersOnDemand: true, beans: true };
        vi.mocked(getMemberCards).mockRejectedValue(new TypeError('Failed to fetch'));
        vi.mocked(getBalance).mockResolvedValue({ ...RESIDENT, frozen: false } as any);
        render(<LedgerPage identity={identity} isMember={true} />);
        fireEvent.click(await screen.findByRole('button', { name: xx('💸 Wallet') }));
        fireEvent.click(await screen.findByRole('button', { name: new RegExp(xx('Send Beans').replace(/[[\]~]/g, '.')) }));
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Select recipient...').replace(/[[\]~.]/g, '.')) }));
        await waitFor(() => expect(screen.getByTestId('ledger-picker-note').textContent).toBe(xx('Type at least {n} letters of a name.').replace('{n}', '2')));
        fireEvent.change(screen.getByPlaceholderText(xx('Search members...')), { target: { value: 'da' } });
        await waitFor(() => expect(screen.getByTestId('ledger-picker-note').textContent).toBe(xx("Couldn't search just now. Check your connection and try again.")));
        expect(bypassing(document.body, { others: [...OTHERS, ...barBold(), 'da'] })).toEqual([]);
    });
});

describe('the Ledger in English', () => {
    it('nothing bracketed, and the words as they were', async () => {
        await open(RESIDENT);
        expect(bracketed()).toBe(0);
        expect(screen.getByTestId('ledger-balance').textContent).toBe('+450.0B');
        expect(screen.getByText('Level 2 of 4 · 400 trust')).toBeInTheDocument();
        expect(document.body.textContent).toContain('more trust to');
        expect(screen.getByText('Spending paused — your balance is below what your 1 active offer unlock (−200). Post an Offer or trade back up to lift it. You can still receive and sell.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'View Elder level details' })).toBeInTheDocument();
        expect(screen.getByText('+300 trust')).toBeInTheDocument();
        expect(screen.getByText('3 reviews')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '🛡️ Levels' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '💸 Wallet' }));
        expect(await screen.findByText('Overdraft Floor')).toBeInTheDocument();
        expect(screen.getByText('≈ 11.3 hrs capacity')).toBeInTheDocument();
        expect(screen.getByText('🌱 View Solvency & Tax')).toBeInTheDocument();
        expect(screen.getByText('Recent Transactions')).toBeInTheDocument();
        expect(screen.getByText('No transactions yet. Start trading on the Marketplace!')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '⬇️ Export mine' })).toBeInTheDocument();
    });

    it('a confirmed member (floor -1,000, 0 Trust Points): sees no level promising a floor, and their own line once', async () => {
        await open({
            balance: 0, floor: -1000, usableFloor: -1000, activated: true, knownGrant: 1000, tierCredit: 0, earnedCredit: 0,
            tier: { name: 'Newcomer' }, callsign: 'Visitor',
        });
        const detail = screen.getByTestId('level-detail');
        expect(within(detail).getByText('Your current floor')).toBeInTheDocument();
        expect(within(detail).getByText('-1000')).toBeInTheDocument();
        expect(screen.queryByText('Floor starts at')).toBeNull();
        expect(screen.queryByText('Floor from this tier')).toBeNull();

        const shelf = screen.getByTestId('levels-shelf');
        const buttons = within(shelf).getAllByRole('button');
        // Click Resident
        fireEvent.click(buttons[1]);
        expect(within(detail).getByText('from 200 trust')).toBeInTheDocument();
        expect(within(detail).queryByText('Floor starts at')).toBeNull();
        expect(within(detail).queryByText('Floor from this tier')).toBeNull();
        expect(within(detail).queryByText('-200')).toBeNull();

        // Click Steward
        fireEvent.click(buttons[2]);
        expect(within(detail).getByText('from 600 trust')).toBeInTheDocument();
        expect(within(detail).queryByText('Floor starts at')).toBeNull();
        expect(within(detail).queryByText('Floor from this tier')).toBeNull();
        expect(within(detail).queryByText('-600')).toBeNull();

        // Click Elder
        fireEvent.click(buttons[3]);
        expect(within(detail).getByText('from 1400 trust')).toBeInTheDocument();
        expect(within(detail).queryByText('Floor starts at')).toBeNull();
        expect(within(detail).queryByText('Floor from this tier')).toBeNull();
    });
});

describe('a switch to Russian redraws the Ledger', () => {
    it('in Russian where the words have it, in English where a sentence is not translated yet, and back', async () => {
        const SEND = 'Send Beans';
        expect(typeof RU[SEND]).toBe('string');
        function Root() {
            useLanguage();
            return <LedgerPage identity={identity} isMember={true} />;
        }
        vi.mocked(getBalance).mockResolvedValue(RESIDENT as any);
        render(<Root />);
        expect((await screen.findAllByText(SEND)).length).toBeGreaterThan(0);

        await showIn('ru');
        expect(screen.getAllByText(RU[SEND] as string).length).toBeGreaterThan(0);
        expect(screen.queryByText(SEND)).toBeNull();
        // Not in the web's Russian words yet (the drafting pass adds them): the English, never a blank.
        expect(screen.getByText(typeof RU['YOUR TRUST LEVEL'] === 'string' ? (RU['YOUR TRUST LEVEL'] as string) : 'YOUR TRUST LEVEL')).toBeInTheDocument();
        expect(document.documentElement.lang).toBe('ru');

        await showIn('en');
        expect(screen.getAllByText(SEND).length).toBeGreaterThan(0);
    });
});
