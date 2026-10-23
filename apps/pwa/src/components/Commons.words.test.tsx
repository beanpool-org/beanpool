/**
 * The Commons' cards and forms in the member's language (words S3, web sweep W2): the Commons information modal (its three
 * tabs), a poll card (open vote and anonymous, open and closed, its errors and its voter list), the Decide section (the
 * open Decisions in each kind, their errors, the history in each ending) and the form that proposes a Decision (every
 * effect, every refusal), each drawn in the pseudo-locale `xx`: every sentence came through t(), the phone's keys where
 * the phone says the same. What members wrote (a Decision's or poll's title and text, its answers, names, a project's
 * name, an admin's reason) is theirs and shown as written. In English nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-w2.test-support';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    votePoll: vi.fn(),
    closePoll: vi.fn(),
    castDecisionVote: vi.fn(),
    createDecision: vi.fn(),
}));

import { castDecisionVote, closePoll, createDecision, votePoll } from '../lib/api';
import { CommonsInfoModal } from './CommonsInfoModal';
import { PollCard } from './PollCard';
import { DecideSection } from './DecideSection';
import { ProposeDecisionModal } from './ProposeDecisionModal';

const ME: any = { publicKey: 'me-pk', privateKey: 'k', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z' };
const DAY = 86_400_000;
/** Icons, not words: ℹ (U+2139) is a letter to Unicode. */
const ICONS = ['ℹ️'];

afterEach(() => { cleanup(); backToEnglish(); vi.restoreAllMocks(); });

// ── The Commons information modal ───────────────────────────────────────────────────────────────────────────────

describe('the Commons information modal in the pseudo-locale', () => {
    it('each tab: every word came through t()', async () => {
        await showIn('xx');
        render(<CommonsInfoModal isOpen onClose={() => {}} commonsBalance={123.45} />);
        expect(screen.getByRole('heading', { name: xx('Community Commons') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Close information modal') })).toBeInTheDocument();
        expect(screen.getByRole('tablist', { name: xx('Commons information tabs') })).toBeInTheDocument();
        expect(screen.getByText('123.45 🫘')).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(15);
        expect(bypassing()).toEqual([]);

        fireEvent.click(screen.getByRole('tab', { name: new RegExp(xx('Circulation Fees').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByText(xx('Example'))).toBeInTheDocument();
        expect(bypassing()).toEqual([]);

        fireEvent.click(screen.getByRole('tab', { name: new RegExp(xx('Voting').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByText(xx('Cost = Votes²'))).toBeInTheDocument();
        expect(screen.getByText(xx('{n} votes').replace('{n}', '10'))).toBeInTheDocument();
        expect(bypassing()).toEqual([]);
    });
});

describe('the Commons information modal in English', () => {
    it('reads as it always has', () => {
        render(<CommonsInfoModal isOpen onClose={() => {}} commonsBalance={123.45} />);
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('tab', { name: '🌊 How It Works' })).toBeInTheDocument();
        expect(screen.getByText(/Bad Debt Payouts:/).parentElement!.textContent).toBe('Bad Debt Payouts: If an inactive account is pruned with a negative balance, the Commons Pool pays off their outstanding debt to maintain zero-sum equilibrium.');
        fireEvent.click(screen.getByRole('tab', { name: '📊 Circulation Fees' }));
        expect(screen.getByText('Example').nextElementSibling!.textContent).toBe('A balance of 600 🫘 pays:200 × 0% = 0.0 + 300 × 1.0% = 3.0 + 100 × 1.5% = 1.5 = 4.5 🫘/month');
        expect(screen.getByText('1.5%')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: '🗳️ Voting' }));
        expect(screen.getByText('1 vote')).toBeInTheDocument();
        expect(screen.getByText('1 credits')).toBeInTheDocument();
        expect(screen.getByText('100 credits')).toBeInTheDocument();
        expect(screen.getByText(/Voice credits come from your/).textContent).toBe('Voice credits come from your completed trades — the beans you have traded with other members, counted up to a cap per trading partner. You get the full amount again on every Decision about community money; they are never used up. Voting on community money opens after your first completed trade. The more you trade and contribute, the more voice you earn in shaping community projects.');
    });
});

// ── A poll ──────────────────────────────────────────────────────────────────────────────────────────────────────

const poll = (over: Record<string, unknown> = {}): any => ({
    id: 'poll-1', type: 'poll', category: 'community', title: 'Where should the tool shed go?', description: 'North gate or south barn.',
    authorPublicKey: ME.publicKey, authorCallsign: 'Alice', createdAt: new Date().toISOString(), status: 'active', active: true,
    credits: 0, priceType: 'fixed', repeatable: false,
    pollOptions: [{ id: 'o1', text: 'North Gate', votes: 3, percentage: 60 }, { id: 'o2', text: 'South Barn', votes: 2, percentage: 40 }],
    pollClosesAt: new Date(Date.now() + 6.5 * DAY).toISOString(), totalVotes: 5, userVotedOptionId: 'o1', pollOpenVote: true,
    pollVotes: [
        { voterPubkey: 'v1', voterCallsign: 'Bob', optionId: 'o1', createdAt: new Date().toISOString() },
        { voterPubkey: 'v2', voterCallsign: 'Charlie', optionId: 'o2', createdAt: new Date().toISOString() },
    ],
    ...over,
});
/** What members wrote on the poll: its question, context, answers, and the names (the author's initial too). */
const POLL_OTHERS = ['Where should the tool shed go?', 'North gate or south barn.', 'North Gate', 'South Barn', 'Alice', 'Bob', 'Charlie', 'A', ...ICONS];

describe('a poll card in the pseudo-locale', () => {
    it('an open vote, mine and open: badge, time left, close, voters, notes, turnout', async () => {
        const said: string[] = [];
        vi.spyOn(window, 'confirm').mockImplementation((m) => { said.push(String(m)); return true; });
        vi.mocked(closePoll).mockRejectedValueOnce(new Error(''));
        await showIn('xx');
        render(<PollCard post={poll()} identity={ME} />);
        expect(screen.getByText(xx('POLL'))).toBeInTheDocument();
        expect(screen.getByText(xx('Closes in {n}d').replace('{n}', '6'))).toBeInTheDocument();
        expect(screen.getByText(xx('(You)'))).toBeInTheDocument();
        expect(screen.getByRole('progressbar', { name: xx('{option}: {pct}% of votes').replace('{option}', 'North Gate').replace('{pct}', '60') })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: xx('Show Voters ({n}) ▼').replace('{n}', '2') }));
        expect(screen.getByText(xx('Open vote'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(8);
        expect(bypassing(document.body, { others: POLL_OTHERS })).toEqual([]);

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('Close poll') })); });
        expect(screen.getByText(xx('Failed to close poll.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: POLL_OTHERS, said })).toEqual([]);
    });

    it('anonymous and closed, with where its votes came from; informal; and a vote with no identity', async () => {
        await showIn('xx');
        render(<PollCard post={poll({ pollOpenVote: false, pollVotes: [], status: 'completed', pollNewOrWordsVotes: 2, userVotedOptionId: null })} identity={ME} informal />);
        expect(screen.getByText(xx('Closed'))).toBeInTheDocument();
        expect(screen.getByText(xx('Anonymous: everyone sees only the totals'))).toBeInTheDocument();
        expect(screen.getByText(xx('An informal poll; it decides nothing'))).toBeInTheDocument();
        expect(screen.getByTestId('poll-vote-origins')).toBeInTheDocument();
        expect(bypassing(document.body, { others: POLL_OTHERS })).toEqual([]);
        cleanup();

        render(<PollCard post={poll({ authorPublicKey: 'someone', pollClosesAt: new Date(Date.now() + 2.5 * 3_600_000).toISOString(), userVotedOptionId: null })} identity={null} />);
        expect(screen.getByText(xx('Closes in {n}h').replace('{n}', '2'))).toBeInTheDocument();
        fireEvent.click(screen.getByText('South Barn').closest('button')!);
        expect(screen.getByText(xx('Please connect your member identity to vote.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: POLL_OTHERS })).toEqual([]);
    });

    it('a vote the node refuses without a reason, and voting in progress', async () => {
        let answer!: (v: unknown) => void;
        vi.mocked(votePoll).mockReturnValueOnce(new Promise((r) => { answer = r; }) as never);
        await showIn('xx');
        render(<PollCard post={poll({ authorPublicKey: 'someone', userVotedOptionId: null })} identity={ME} />);
        fireEvent.click(screen.getByText('South Barn').closest('button')!);
        expect(screen.getByText(xx('Voting...'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: POLL_OTHERS })).toEqual([]);
        await act(async () => { answer(Promise.reject(new Error(''))); });
        expect(await screen.findByText(xx('Could not record your vote.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: POLL_OTHERS })).toEqual([]);
    });
});

describe('a poll card in English', () => {
    it('reads as it always has', () => {
        render(<PollCard post={poll()} identity={ME} />);
        expect(bracketed()).toBe(0);
        expect(screen.getByText('POLL').textContent).toBe('🗳️ POLL');
        expect(screen.getByText('Closes in 6d')).toBeInTheDocument();
        expect(screen.getByText(/5 votes cast/).textContent).toBe('📊 5 votes cast');
        expect(screen.getByRole('button', { name: 'Show Voters (2) ▼' })).toBeInTheDocument();
        expect(screen.getByText(/Re-voting overwrites choice/).textContent).toBe('ℹ️ Open vote · Re-voting overwrites choice');
        expect(screen.getByText('60%')).toBeInTheDocument();
        cleanup();
        render(<PollCard post={poll({ totalVotes: 1, pollOpenVote: false, pollVotes: [] })} identity={ME} />);
        expect(screen.getByText(/1 vote cast/).textContent).toBe('📊 1 vote cast');
        expect(screen.getByText(/Re-voting overwrites choice/).textContent).toBe('ℹ️ Anonymous vote · Re-voting overwrites choice');
    });
});

// ── The Decide section ──────────────────────────────────────────────────────────────────────────────────────────

const decision = (id: string, over: Record<string, any> = {}): any => ({
    id, authorPubkey: 'author', title: `Decision ${id}`, description: `Why ${id}`, touches: 'member', effect: 'grant_voucher',
    subject: 'subject-pk', params: null, franchise: '1m1v', status: 'open', opensAt: '2026-09-18T00:00:00.000Z',
    closesAt: new Date(Date.now() + 3 * DAY).toISOString(), gracePeriodEndsAt: null, createdAt: '2026-09-18T00:00:00.000Z',
    executedAt: null, executionError: null, executionReason: null, adminHaltedAt: null, adminHaltReason: null, updatedAt: '2026-09-18T00:00:00.000Z',
    tally: {
        decisionId: id, status: 'open', totalVoters: 1, electorate: 20, quorumRatio: 0.3, quorumRequired: 6, quorumMet: false,
        yesWeight: 1, noWeight: 0, totalWeight: 1, supportRatio: 1, thresholdRequired: 0.6, passed: false,
    },
    myVote: null,
    ...over,
});

function drawDecide(decisions: any[], o: { canPropose?: boolean; hasOpen?: boolean; view?: 'open' | 'history'; identity?: any; poolVoting?: any } = {}) {
    return render(
        <DecideSection
            decisions={decisions}
            myPoolVoting={o.poolVoting ?? null}
            identity={o.identity === undefined ? ME : o.identity}
            commonsBalance={300}
            onRefresh={async () => {}}
            onOpenPropose={() => {}}
            canPropose={o.canPropose ?? true}
            hasOpenDecision={o.hasOpen ?? false}
            activeView={o.view ?? 'open'}
            onChangeView={() => {}}
        />,
    );
}

const OPEN_DECISIONS = [
    decision('a', { myVote: { support: true, voteCount: 1, creditsUsed: 0, updatedAt: '' } }),
    decision('b', { touches: 'pool', effect: 'grant_enterprise', franchise: 'quadratic_trade', params: { amount: 50 }, closesAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        myVote: { support: false, voteCount: 3, creditsUsed: 9, updatedAt: '' }, tally: { ...decision('b').tally, quorumMet: true, electorate: 4 } }),
    decision('c', { effect: 'keep_suspension', params: { memberName: 'Dave', suspendedAt: '2026-09-19T10:00:00.000Z' }, closesAt: new Date(Date.now() + 5 * 3_600_000).toISOString() }),
    decision('d', { effect: 'remove_member', params: { memberName: 'Eve', debt: 12.5, commonsPool: 300 } }),
    decision('e', { effect: 'remove_member', params: { memberName: 'Eve', commonsPool: 300 } }),
    decision('f', { effect: 'remove_member', params: { memberName: 'Eve', balance: 4, commonsPool: 300 }, closesAt: new Date(Date.now() - 1000).toISOString() }),
];
const DECIDE_OTHERS = ['Dave', 'Eve', 'Spam in the market', 'The node had no funds', ...ICONS, ...'abcdefghij'.split('').flatMap((id) => [`Decision ${id}`, `Why ${id}`])];

describe('the Decide section in the pseudo-locale', () => {
    beforeEach(() => vi.mocked(castDecisionVote).mockReset());

    it('open Decisions of each kind: tags, turnout, tally, votes, the debt lines, the ballot note', async () => {
        await showIn('xx');
        drawDecide(OPEN_DECISIONS, { poolVoting: { voiceCredits: 16, hasCompletedTrade: true } });
        expect(screen.getByRole('tablist', { name: xx('Decisions view') })).toBeInTheDocument();
        expect(screen.getByText(xx('You voted Yes'))).toBeInTheDocument();
        expect(screen.getByText(xx('You voted No ({n} votes)').replace('{n}', '3'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: new RegExp(xx('Change to Yes').replace(/[[\]~]/g, '.')) })).toBeInTheDocument();
        expect(screen.getByText(xx('{n}m left').replace('{n}', '29'))).toBeInTheDocument();
        expect(screen.getAllByTestId('removal-debt-write-off-line')).toHaveLength(3);
        expect(screen.getByText(xx('Closing now'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(60);
        expect(bypassing(document.body, { others: DECIDE_OTHERS })).toEqual([]);
    });

    it('who may propose, the empty list, a money vote someone with no trade cannot cast, and each refusal', async () => {
        await showIn('xx');
        drawDecide([], { canPropose: false });
        expect(screen.getByText(xx('You can propose once you have completed a trade.'))).toBeInTheDocument();
        expect(screen.getByText(xx('No open decisions right now'))).toBeInTheDocument();
        expect(bypassing()).toEqual([]);
        cleanup();

        drawDecide([], { hasOpen: true });
        expect(screen.getByText(xx('You already have an open decision (limit 1 open per author).'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: ICONS })).toEqual([]);
        cleanup();

        drawDecide([decision('b', { touches: 'pool', effect: 'grant_enterprise', franchise: 'quadratic_trade' })], { poolVoting: { voiceCredits: 0, hasCompletedTrade: false } });
        expect(screen.getByTestId('pool-vote-blocker').textContent).toBe(xx('Voting on community money opens after your first completed trade.'));
        expect(bypassing(document.body, { others: DECIDE_OTHERS })).toEqual([]);
        cleanup();

        // The node's refusal that the card also says before: in the member's language. Any other refusal is the node's.
        vi.mocked(castDecisionVote).mockResolvedValueOnce({ success: false, error: 'Voting on community money opens after your first completed trade.' } as never);
        drawDecide([decision('a')]);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Vote YES').replace(/[[\]~]/g, '.')) })); });
        expect(screen.getByText(xx('Voting on community money opens after your first completed trade.'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Dismiss error') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: DECIDE_OTHERS })).toEqual([]);
        vi.mocked(castDecisionVote).mockResolvedValueOnce({ success: false } as never);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Vote NO').replace(/[[\]~]/g, '.')) })); });
        expect(screen.getByText(xx('Failed to record vote'))).toBeInTheDocument();
        vi.mocked(castDecisionVote).mockRejectedValueOnce(new Error(''));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Vote NO').replace(/[[\]~]/g, '.')) })); });
        expect(screen.getByText(xx('Failed to cast vote'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: DECIDE_OTHERS })).toEqual([]);
        cleanup();

        drawDecide([decision('a')], { identity: null });
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Vote YES').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByText(xx('You must be logged in to vote.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: DECIDE_OTHERS })).toEqual([]);
    });

    it('the history: each ending, its provenance, and the filters', async () => {
        const past = (id: string, status: string, over: Record<string, any> = {}) => decision(id, { status, ...over });
        await showIn('xx');
        drawDecide([
            past('a', 'executed'),
            past('b', 'admin_halted', { adminHaltReason: 'Spam in the market' }),
            past('c', 'execution_pending_grace', { gracePeriodEndsAt: '2026-10-01T00:00:00.000Z', effect: 'remove_member' }),
            past('d', 'execution_void'),
            past('e', 'failed', { tally: { ...decision('e').tally, quorumMet: true } }),
            past('f', 'failed'),
            past('g', 'unresolved', { touches: 'pool' }),
            past('h', 'passed', { effect: 'forgive_debt' }),
            past('i', 'execution_void', { executionReason: 'The node had no funds' }),
        ], { view: 'history' });
        expect(screen.getByText(xx('Authorised by: Community Vote ({ref})').replace('{ref}', 'system:decision:a'))).toBeInTheDocument();
        expect(screen.getByText(xx('Expired unresolved: Quorum not reached'))).toBeInTheDocument();
        expect(screen.getAllByText(xx('Authorisation & Provenance'))).toHaveLength(9);
        expect(bracketed()).toBeGreaterThan(50);
        expect(bypassing(document.body, { others: DECIDE_OTHERS })).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: xx('Void').toLocaleUpperCase() }));
        expect(screen.getByText(/Spam in the market/)).toBeInTheDocument();
        expect(screen.queryByText(/Decision a$/)).toBeNull();
        expect(bypassing(document.body, { others: DECIDE_OTHERS })).toEqual([]);
        cleanup();
        drawDecide([], { view: 'history' });
        expect(screen.getByText(xx('No history records found'))).toBeInTheDocument();
        expect(bypassing()).toEqual([]);
    });
});

describe('the Decide section in English', () => {
    it('reads as it always has', () => {
        drawDecide(OPEN_DECISIONS, { poolVoting: { voiceCredits: 16, hasCompletedTrade: true } });
        expect(bracketed()).toBe(0);
        const cards = screen.getAllByText(/^Touches: /);
        expect(cards.map((c) => c.textContent)).toEqual(['Touches: member', 'Touches: pool', 'Touches: member', 'Touches: member', 'Touches: member', 'Touches: member']);
        expect(screen.getByText('Grant Voucher')).toBeInTheDocument();
        expect(screen.getByText('Keep Suspension?')).toBeInTheDocument();
        expect(screen.getAllByText('1 Member 1 Vote').length).toBe(5);
        expect(screen.getByText('Quadratic on Trade')).toBeInTheDocument();
        expect(screen.getByText('29m left')).toBeInTheDocument();
        expect(screen.getByText('4h left')).toBeInTheDocument();
        expect(screen.getAllByText('3 days left').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Tally: Yes 1 (100%) · No 0').length).toBe(6);
        expect(screen.getAllByText('Threshold required: 60%').length).toBe(6);
        expect(screen.getByText('Quorum Met ✅')).toBeInTheDocument();
        expect(screen.getAllByText('Pending Quorum').length).toBe(5);
        expect(screen.getByText('30% of 4 members active in the last 30 days (at least 3)')).toBeInTheDocument();
        expect(screen.getByText(/Vote Count:/).textContent).toBe('Vote Count: 3 (Cost: 9 credits)');
        expect(screen.getByText('You have 16 voice credits: up to 4 votes on this Decision.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Change to Yes/ })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Voted No/ })[0]).toBeDisabled();
        expect(screen.getByRole('button', { name: /Voted Yes/ })).toBeDisabled();
        const debt = screen.getAllByTestId('removal-debt-write-off-line').map((l) => l.textContent);
        expect(debt).toEqual([
            "Eve's balance is −12.5 beans. Removing them charges that 12.5 to the Commons pool, which currently holds 300.",
            "Balances are private: only the members who can vote in this see Eve's balance and any debt. The Commons pool holds 300 beans.",
            'Eve has no debt. Removing them charges nothing to the Commons pool, which currently holds 300.',
        ]);
        expect(screen.getAllByTestId('secret-ballot-note')[0].textContent).toBe('🔒 Secret ballot: members see the totals, never who voted how.');
    });

    it('the history reads as it always has', () => {
        drawDecide([
            decision('a', { status: 'executed' }),
            // Midday UTC: 1 Oct wherever the test runs.
            decision('b', { status: 'execution_pending_grace', gracePeriodEndsAt: '2026-10-01T12:00:00.000Z' }),
            decision('c', { status: 'failed' }),
        ], { view: 'history' });
        expect(screen.getAllByRole('tab').map((b) => b.textContent)).toEqual(['🗳️ Open Decisions', '📜 Decisions History']);
        expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['ALL', 'EXECUTED', 'FAILED', 'VOID']);
        expect(screen.getByText('executed')).toBeInTheDocument();
        expect(screen.getByText('execution pending grace')).toBeInTheDocument();
        expect(screen.getAllByText('Turnout: 1 of 6 votes needed (Unmet ❌)').length).toBe(3);
        expect(screen.getAllByText('Yes: 1 (100%) · No: 0').length).toBe(3);
        expect(screen.getByText('Provenance: system:decision:a · Executed successfully')).toBeInTheDocument();
        // The date through core's formatDate, never the browser's own locale.
        expect(screen.getByText('In 7-day Grace Window: Scheduled for removal on 1 Oct 2026')).toBeInTheDocument();
        expect(screen.getByText('Not executed: Quorum not reached')).toBeInTheDocument();
    });
});

// ── Proposing a Decision ────────────────────────────────────────────────────────────────────────────────────────

const GROUPS = [
    { publicKey: 'e'.repeat(64), name: 'Egg flock', lifecycle: 'ongoing' },
    { publicKey: 'f'.repeat(64), name: 'New hall roof', lifecycle: 'bounded' },
];
const PROPOSE_OTHERS = ['Egg flock', 'New hall roof'];

function drawPropose() {
    return render(<ProposeDecisionModal isOpen onClose={() => {}} onCreated={() => {}} identity={ME} commonsBalance={321.6} treasuries={GROUPS} members={[{ publicKey: 'm'.repeat(64), callsign: 'Mia' }]} />);
}
const radio = (english: string) => screen.getAllByRole('radio').find((r) => r.textContent?.includes(xx(english)))!;
const submit = async () => { await act(async () => { fireEvent.submit(screen.getByRole('dialog').querySelector('form')!); }); };

describe('proposing a Decision in the pseudo-locale', () => {
    beforeEach(() => vi.mocked(createDecision).mockReset());

    it('the form, each effect, and every refusal in the member\'s language', async () => {
        await showIn('xx');
        drawPropose();
        expect(screen.getByRole('heading', { name: new RegExp(xx('Propose a Community Decision').replace(/[[\]~]/g, '.')) })).toBeInTheDocument();
        expect(screen.getByRole('radiogroup', { name: xx('Specific Action or Effect') })).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(20);
        expect(bypassing()).toEqual([]);

        await submit();
        expect(screen.getByText(xx('Please enter a clear title for this decision.'))).toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText(xx('e.g. Grant 200 beans to the Tool Library')), { target: { value: 'Mia away' } });
        await submit();
        expect(screen.getByText(xx('Please provide a description and rationale.'))).toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText(xx('Explain why this decision is needed, the plan, and who will oversee it.')), { target: { value: 'Moved' } });
        await submit();
        expect(screen.getByText(xx('Please enter a valid member callsign or 64-character public key.'))).toBeInTheDocument();
        expect(bypassing()).toEqual([]);

        fireEvent.click(radio('Remove Member'));
        fireEvent.change(screen.getByPlaceholderText(xx('Enter member callsign or pubkey...')), { target: { value: 'Mia' } });
        expect(screen.getByTestId('removal-debt-write-off-line').textContent).toContain('Mia');
        expect(bypassing(document.body, { others: ['Mia'] })).toEqual([]);

        fireEvent.click(radio('Remove a lead keeper or project leader'));
        expect(screen.getByText(xx('The lead keeper or leader to remove: callsign or public key'))).toBeInTheDocument();
        await submit();
        expect(screen.getByText(xx('Please pick the project or enterprise, or enter its public key.'))).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'New hall roof' }));
        expect(screen.getByText(xx('The leader to remove: callsign or public key'))).toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText(xx("Enter the leader's callsign or pubkey...")), { target: { value: '' } });
        await submit();
        // The member check comes first, as it always has.
        expect(screen.getByText(xx('Please enter a valid member callsign or 64-character public key.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: PROPOSE_OTHERS })).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Commons Pool').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByPlaceholderText(xx('e.g. {amount}').replace('{amount}', '250'))).toBeInTheDocument();
        await submit();
        expect(screen.getByText(xx('Please enter a valid positive grant amount in Beans.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: PROPOSE_OTHERS })).toEqual([]);
        fireEvent.click(radio('Hardship Grant'));
        expect(screen.getByText(xx('Hardship Amount (Beans)'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: PROPOSE_OTHERS })).toEqual([]);
        fireEvent.click(radio("Pay off a project's or enterprise's debt"));
        fireEvent.change(screen.getByPlaceholderText(xx('Or enter its public key...')), { target: { value: '' } });
        await submit();
        expect(screen.getByText(xx('Please pick the project or enterprise, or enter its public key.'))).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Egg flock' }));
        vi.mocked(createDecision).mockResolvedValueOnce({ success: false } as never);
        await submit();
        expect(screen.getByText(xx('Failed to propose decision'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: PROPOSE_OTHERS })).toEqual([]);
    });
});

describe('proposing a Decision in English', () => {
    it('reads as it always has, and the node still records the name as written', async () => {
        vi.mocked(createDecision).mockReset();
        vi.mocked(createDecision).mockResolvedValueOnce({ success: true } as never);
        drawPropose();
        expect(bracketed()).toBe(0);
        expect(within(screen.getByRole('dialog')).getAllByRole('button').slice(1, 3).map((b) => b.textContent)).toEqual(['👤Member', '🏛️Commons Pool']);
        fireEvent.click(screen.getAllByRole('radio').find((r) => r.textContent?.includes('Remove Member'))!);
        expect(screen.getByTestId('removal-debt-write-off-line').textContent).toBe("Balances are private: you can't see Member's. When this vote opens, the community records their balance and any debt, and shows them to everyone who can vote in it. If they are removed, a debt is charged to the Commons pool, which holds 322 beans now.");
        expect(screen.getByText(/No bond required\./).parentElement!.textContent).toBe('No bond required. Open to members who have completed a trade, and to node admins. Open for 7 days, executing automatically on pass.');
        fireEvent.change(screen.getByPlaceholderText('e.g. Grant 200 beans to the Tool Library'), { target: { value: 'Mia away' } });
        fireEvent.change(screen.getByPlaceholderText(/Explain why this decision is needed/), { target: { value: 'Moved' } });
        fireEvent.change(screen.getByPlaceholderText('Enter member callsign or pubkey...'), { target: { value: 'Mia' } });
        await submit();
        expect(vi.mocked(createDecision).mock.calls[0][0]).toMatchObject({ effect: 'remove_member', params: { memberName: 'Mia', commonsPool: 322 } });
    });
});
