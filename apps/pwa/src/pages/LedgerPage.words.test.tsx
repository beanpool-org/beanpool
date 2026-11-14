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
import { TIER_LEVELS, formatHundredths } from '@beanpool/core';
import ruWords from '../../words/ru.json';

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => [BLOCKED]), onBlocklistUpdated: vi.fn(() => () => {}) }));
// Other screens' cards, with words of their own sweeps: the Commons modal (closed here) and the pay-back card (with the
// page's read of the debt it shows: none here).
vi.mock('../components/CommonsInfoModal', () => ({ CommonsInfoModal: () => null }));
vi.mock('../components/RepaymentCard', () => ({ RepaymentCard: () => null, useMyRepayment: () => [null, () => {}] }));
vi.mock('../lib/api', () => ({
    getBalance: vi.fn(),
    // V3: the Ledger asks whether this member is a voucher (null = not one), beside the gift offer.
    getMyVouching: vi.fn(async () => null),
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

/** Bold parts inside the credit card: none since slice R1 (its sentences are core's, whole); kept so a bold part would show here. */
const barBold = () => Array.from(document.querySelectorAll('[data-testid="credit-card"] b')).map((b) => b.textContent ?? '');

const TS = '2026-10-01T10:00:00.000Z';
const line = (id: string, from: string, to: string, memo: string) => ({ id, from, to, amount_c: 300, fee_c: 0, memo, timestamp: TS });
/** What members and the node wrote, shown as written: names and notes on lines. */
const OTHERS = ['Visitor', 'Dana', 'thanks for the eggs', 'for the bread: '];

/** A Newcomer with no credit line, nothing to send. Every figure whole hundredths, as the node's balance answer. */
const NEWCOMER = { balance_c: 0, floor_c: 0, activated: false, commonsBalance_c: 1250, callsign: 'Visitor', tier: { name: 'Newcomer' } };
/** A Resident trading: Beans to send, part of the line unlocked by one live offer, spending paused, ratings. */
const RESIDENT = {
    balance_c: 45000, floor_c: -100000, usableFloor_c: -20000, liveOffers: 1, frozen: true, activated: true, earnedCredit_c: 30000, tierCredit_c: 40000,
    commonsBalance_c: 123450, qualifiedValue: 250000, avgRating: 4.5, reviewCount: 3, trustStats: { uniquePartners: 6 },
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

/**
 * The balance answer is drawn. Not the moment the read is asked, and not the first `ledger-balance`: both come before the
 * answer, and the page draws "+0B" and a locked "🔒 Send Beans (needs 1 completed trade)" until it is in, so a loaded
 * runner could read the words before the answer. First the page itself (until the node says Beans are live it shows
 * "Loading your ledger…", with no Loading card to wait out), then the credit card's Loading shape gone: the answer is in
 * (or the read failed, and the card says so).
 */
async function answerDrawn() {
    await screen.findByTestId('ledger-balance');
    await waitFor(() => expect(screen.queryByTestId('credit-card-reading')).toBeNull());
}

async function open(balance: Record<string, unknown>) {
    vi.mocked(getBalance).mockResolvedValue(balance as any);
    render(<LedgerPage identity={identity} isMember={true} onNavigate={vi.fn()} />);
    await waitFor(() => expect(getTransactions).toHaveBeenCalled());
    await answerDrawn();
}

describe('the Ledger in the pseudo-locale', () => {
    it('a Newcomer: the balance, the no-credit-line card, the Levels tab and each level\'s detail', async () => {
        await showIn('xx');
        await open(NEWCOMER);
        // Slice R1: a newcomer sees the credit card, its left half striped and "no credit line yet" under it.
        expect(screen.getByText(xx('no credit line yet'))).toBeInTheDocument();
        expect(screen.getByTestId('credit-sentence').textContent).toBe(xx('No credit line yet, so there is nothing to spend and nothing to repay.'));
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

    it('a Resident: the credit card (slice R1), the Levels hero and the way to the next level', async () => {
        await showIn('xx');
        await open(RESIDENT);
        expect(screen.getByText(xx('WHAT BUILDS YOUR TRUST'))).toBeInTheDocument();
        // The card's words are core's (credit-standing.ts): holding 450, one live Offer opening 200 of a 1,000 line.
        expect(screen.getByTestId('credit-headline').textContent).toBe(xx('You hold {amount} Beans').replace('{amount}', '450'));
        expect(screen.getByTestId('credit-card')).toBeInTheDocument();
        expect(screen.getByText(xx('{n} trust to go').replace('{n}', formatHundredths(TIER_LEVELS[2].minCredit - RESIDENT.tierCredit_c)))).toBeInTheDocument();
        expect(barBold()).toHaveLength(0);
        expect(bypassing(document.body, { others: [...OTHERS, ...barBold()] })).toEqual([]);
    });

    it('a frozen line: the card, how far down a member in debit is, and the known part frozen under the bar', async () => {
        await showIn('xx');
        await open({ ...NEWCOMER, balance_c: -1225, creditFrozen: true });
        expect(screen.getByText(xx('Your credit line is frozen'))).toBeInTheDocument();
        expect(screen.getByTestId('ledger-frozen-debit').textContent).toBe(
            // Exactly how far down, to the hundredth (no rounding up to the tenth).
            xx('You are {n} Beans in debit. Selling or receiving Beans brings you back up, and once you are above zero you can spend what you hold.').replace('{n}', '12.25'),
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
        expect(screen.getByText(xx('You can only send beans you hold — your balance is {balance}B.').replace('{balance}', '450'))).toBeInTheDocument();
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
        // The export's read fails. The page reads the Credit line tab's offer too (G1, lib/credit-gift.ts), which answers
        // nothing here (no tab), so the refusal is the export's alone, whichever read comes first.
        vi.mocked(request).mockImplementation(async (_method: string, path: string) => {
            if (path === '/api/ledger/export') throw new Error('');
            return undefined as never;
        });
        await showIn('xx');
        await open(NEWCOMER);
        fireEvent.click(screen.getByRole('button', { name: xx('💸 Wallet') }));
        expect(await screen.findByText(xx('No transactions yet. Start trading on the Marketplace!'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('🔒 Send Beans (needs 1 completed trade)') })).toBeDisabled();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('⬇️ Export mine') })); });
        expect(said).toEqual([xx('Export failed')]);
        expect(bypassing(document.body, { others: OTHERS, said })).toEqual([]);
        vi.unstubAllGlobals();
        vi.mocked(request).mockReset();
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
        // The answer first: before it, Send is the locked "🔒 Send Beans (needs 1 completed trade)", which the pattern below
        // matches too, and a click on it opens nothing.
        await answerDrawn();
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
        expect(screen.getByTestId('ledger-balance').textContent).toBe('+450B');
        expect(screen.getByText('Level 2 of 4 · credit line 1,000 Beans')).toBeInTheDocument();
        expect(document.body.textContent).toContain('more trust to');
        // The credit card's words (slice R1), core's: holding 450, one live Offer opening 200 of the 1,000 line.
        expect(screen.getByTestId('credit-sentence').textContent).toBe('You can spend 650: your 450 Beans, then 200 of your 1,000 credit line.');
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
            balance_c: 0, floor_c: -100000, usableFloor_c: -100000, activated: true, knownGrant_c: 100000, tierCredit_c: 0, earnedCredit_c: 0,
            tier: { name: 'Newcomer' }, callsign: 'Visitor',
        });
        const detail = screen.getByTestId('level-detail');
        expect(within(detail).getByText('Your current floor')).toBeInTheDocument();
        // Its own floor as every figure is written: a true minus, thousands grouped.
        expect(within(detail).getByText('−1,000')).toBeInTheDocument();
        expect(screen.queryByText('Floor starts at')).toBeNull();
        expect(screen.queryByText('Floor from this tier')).toBeNull();
        // Their line is open already: no 'your first completed trade … opens your credit line' above it
        expect(within(detail).getByText(/and your credit line is already open\.$/)).toBeInTheDocument();
        expect(within(detail).queryByText(/opens your credit line/)).toBeNull();

        const shelf = screen.getByTestId('levels-shelf');
        const buttons = within(shelf).getAllByRole('button');
        // Click Resident
        fireEvent.click(buttons[1]);
        expect(within(detail).getByText('from 200 trust')).toBeInTheDocument();
        expect(within(detail).queryByText('Floor starts at')).toBeNull();
        expect(within(detail).queryByText('Floor from this tier')).toBeNull();
        expect(within(detail).queryByText(/^[-−]200$/)).toBeNull();

        // Click Steward
        fireEvent.click(buttons[2]);
        expect(within(detail).getByText('from 600 trust')).toBeInTheDocument();
        expect(within(detail).queryByText('Floor starts at')).toBeNull();
        expect(within(detail).queryByText('Floor from this tier')).toBeNull();
        expect(within(detail).queryByText(/^[-−]600$/)).toBeNull();

        // Click Elder
        fireEvent.click(buttons[3]);
        expect(within(detail).getByText('from 1,400 trust')).toBeInTheDocument();
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

describe('the credit card before the balance is in (round 2 of #3134): never a credit fact from an answer that isn\'t there', () => {
    /** Words the card would say from an empty answer: the starter card's, untrue for a member with a line. */
    const EMPTY_ANSWER_WORDS = /no credit line yet|nothing to spend|You are at zero|Your credit line opens with/i;

    it('while the balance is being read: the card\'s shape and "Loading…", no figure, no sentence, no note', async () => {
        vi.mocked(getBalance).mockReturnValue(new Promise(() => {}) as any);
        render(<LedgerPage identity={identity} isMember={true} onNavigate={vi.fn()} />);
        // The card's shape comes first, in the render where the node says Beans are live; the read is asked in the effect
        // after that render. Nothing may be claimed in between either.
        await screen.findByTestId('credit-card-reading');
        expect(screen.queryByTestId('credit-card')).toBeNull();
        expect(document.body.textContent).not.toMatch(EMPTY_ANSWER_WORDS);
        // Then wait for the read itself (never a sleep): a loaded runner can find the card before that effect has run (the
        // red on #3136 and #3135, 14 Nov). The answer never comes, so from here on the card is waiting on a read in flight.
        await waitFor(() => expect(getBalance).toHaveBeenCalled());
        const reading = screen.getByTestId('credit-card-reading');
        expect(reading.getAttribute('aria-busy')).toBe('true');
        expect(reading.textContent).toBe('Loading…');
        expect(screen.queryByTestId('credit-card')).toBeNull();
        expect(screen.queryByTestId('credit-card-unread')).toBeNull();
        expect(document.body.textContent).not.toMatch(EMPTY_ANSWER_WORDS);
    });

    it('a balance that could not be read: the card says so, and Try again reads it again and draws the card', async () => {
        vi.mocked(getBalance).mockRejectedValueOnce(new Error('Member not found')).mockResolvedValue(RESIDENT as any);
        render(<LedgerPage identity={identity} isMember={true} onNavigate={vi.fn()} />);
        const unread = await screen.findByTestId('credit-card-unread');
        expect(within(unread).getByRole('alert').textContent).toBe('Your credit line couldn’t be read just now.');
        expect(screen.queryByTestId('credit-card')).toBeNull();
        expect(document.body.textContent).not.toMatch(EMPTY_ANSWER_WORDS);

        fireEvent.click(within(unread).getByRole('button', { name: 'Try again' }));
        expect(await screen.findByTestId('credit-card')).toBeInTheDocument();
        expect(getBalance).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId('credit-headline').textContent).toBe('You hold 450 Beans');
        expect(screen.queryByTestId('credit-card-unread')).toBeNull();
    });

    it('in the pseudo-locale: the reading and the unread card through t()', async () => {
        await showIn('xx');
        vi.mocked(getBalance).mockRejectedValue(new Error('Member not found'));
        render(<LedgerPage identity={identity} isMember={true} />);
        const unread = await screen.findByTestId('credit-card-unread');
        expect(within(unread).getByRole('alert').textContent).toBe(xx('Your credit line couldn’t be read just now.'));
        expect(within(unread).getByRole('button', { name: xx('Try again') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        cleanup();

        vi.mocked(getBalance).mockReturnValue(new Promise(() => {}) as any);
        render(<LedgerPage identity={identity} isMember={true} />);
        expect((await screen.findByTestId('credit-card-reading')).textContent).toBe(xx('Loading…'));
    });

    it('a guest has no balance here: no credit card at all, and none of its words', async () => {
        render(<LedgerPage identity={identity} isMember={false} />);
        await screen.findByTestId('ledger-balance');
        expect(screen.queryByTestId('credit-card')).toBeNull();
        expect(screen.queryByTestId('credit-card-reading')).toBeNull();
        expect(screen.queryByTestId('credit-card-unread')).toBeNull();
        expect(document.body.textContent).not.toMatch(EMPTY_ANSWER_WORDS);
    });
});
