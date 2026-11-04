/**
 * A vote a drawn jury decides on the Decide card (removal jury J3; JuryPanel.tsx, core jury-card.ts). The node is
 * stubbed with what GET …/jury and the list serve (decisions-engine juryForReader, tallyForReader): while the vote is
 * open the tally has `turnout` and no split, and the jury read names nobody but the reader's own seat.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { juryDraw, type ServedJury } from '@beanpool/core';
import { DecideSection } from './DecideSection';
import { answerJurySeat, castDecisionVote, getDecisionJury } from '../lib/api';

vi.mock('../lib/api', () => ({
    castDecisionVote: vi.fn(async () => ({ success: true, creditsUsed: 1 })),
    replyToRemovalCase: vi.fn(async () => ({ success: true })),
    reportRemovalCase: vi.fn(async () => ({ success: true })),
    getDecisionJury: vi.fn(async () => null),
    answerJurySeat: vi.fn(async () => ({ success: true, jury: null })),
}));

const key = (i: number) => i.toString(16).padStart(64, '0');
const POOL = Array.from({ length: 30 }, (_, i) => key(i + 1));
const DAVE = key(500);
const ME = key(600);
const DAY = '2026-11-03';
const drawn = juryDraw({ pool: POOL, subject: DAVE, snapshotDate: DAY, size: 12, standsAside: k => k === POOL[2] });
const walk = drawn.order.slice(0, drawn.jury.length + drawn.stoodAside.length);

function served(over: Partial<ServedJury> = {}): ServedJury {
    return {
        decisionId: 'jv', subject: DAVE, snapshotDate: DAY, rosterHash: drawn.rosterHash, poolSize: POOL.length, size: 12, mustVote: 9, minYes: 6,
        pool: [...POOL].sort().map(k => ({ publicKey: k, callsign: `M${POOL.indexOf(k) + 1}` })), you: null, ...over,
    };
}
function closedJury(over: Partial<ServedJury> = {}): ServedJury {
    const voted = drawn.jury.slice(0, 10);
    const entry = (k: string) => ({ publicKey: k, callsign: `M${POOL.indexOf(k) + 1}`, drawnAs: k });
    return served({ voted: voted.map(entry), didNotServe: walk.filter(k => !voted.includes(k)).map(entry), ...over });
}

function juryVote(status: string, over: Record<string, unknown> = {}): any {
    const open = status === 'open';
    return {
        id: 'jv', authorPubkey: 'SYSTEM', title: 'Remove Dave?', description: 'Paused for a fake listing.', touches: 'member', effect: 'remove_member',
        subject: DAVE, params: { rule: 2, memberName: 'Dave', pausedAt: '2026-11-03T02:00:00.000Z', decider: 'jury', jury: { size: 12, mustVote: 9, minYes: 6 } },
        franchise: '1m1v', status, opensAt: '2026-11-03T02:00:00.000Z', closesAt: open ? '2099-11-10T02:00:00.000Z' : '2026-11-10T02:00:00.000Z',
        gracePeriodEndsAt: status === 'execution_pending_grace' ? '2026-11-17T02:00:00.000Z' : null, createdAt: '2026-11-03T02:00:00.000Z',
        executedAt: null, executionError: null, executionReason: null, adminHaltedAt: null, adminHaltReason: null, updatedAt: '2026-11-03T02:00:00.000Z',
        proposer: { kind: 'admin', name: 'Ada' },
        // While open the node sends the count and none of the split (tallyForReader); once closed, the totals.
        tally: open
            ? { decisionId: 'jv', status, totalVoters: 7, electorate: 12, quorumRatio: 0.75, quorumRequired: 9, quorumMet: false, thresholdRequired: 2 / 3, minYes: 6, tooFewToVote: false, decider: 'jury', turnout: { voted: 7, size: 12, mustVote: 9 } }
            : { decisionId: 'jv', status, totalVoters: 10, electorate: 12, quorumRatio: 0.75, quorumRequired: 9, quorumMet: true, yesWeight: 9, noWeight: 1, totalWeight: 10, supportRatio: 0.9, thresholdRequired: 2 / 3, passed: true, minYes: 6, tooFewToVote: false, decider: 'jury', turnout: { voted: 10, size: 12, mustVote: 9 } },
        myVote: null,
        ...over,
    };
}

const renderDecide = (decisions: any[], view: 'open' | 'history' = 'open', me = ME) => render(
    <DecideSection
        decisions={decisions}
        identity={{ publicKey: me, privateKey: 'k', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z' } as any}
        commonsBalance={0}
        onRefresh={async () => {}}
        onOpenPropose={() => {}}
        canPropose
        hasOpenDecision={false}
        activeView={view}
        onChangeView={() => {}}
    />,
);

const voteButtons = () => screen.queryAllByRole('button', { name: /Vote YES|Vote NO|Change to|Voted/ });

beforeEach(() => {
    vi.mocked(getDecisionJury).mockReset();
    vi.mocked(answerJurySeat).mockReset();
    vi.mocked(castDecisionVote).mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('an open jury vote', () => {
    it('a member not drawn sees who decides and the count, no vote button and no NaN', async () => {
        vi.mocked(getDecisionJury).mockResolvedValue(served({ you: null }));
        const { container } = renderDecide([juryVote('open')]);
        await screen.findByTestId('jury-seat-not_on_it');
        expect(screen.getByText('Only the jury votes on this. Anyone can check how it was drawn.')).toBeInTheDocument();
        expect(screen.getByTestId('jury-decides-line').textContent).toBe('A jury of 12 members, drawn at random, decides by 10 Nov.');
        expect(screen.getByText('Turnout: 7 of 12 jurors have voted')).toBeInTheDocument();
        expect(screen.getByText('9 of the jury must vote. Removing Dave takes two-thirds of the votes cast, and at least 6 Yes.')).toBeInTheDocument();
        expect(voteButtons()).toHaveLength(0);
        expect(screen.queryByRole('button', { name: 'Serve' })).toBeNull();
        expect(container.textContent).not.toMatch(/NaN|undefined/);
        // No split while it is open: no Yes/No line and no support bar.
        expect(container.textContent).not.toMatch(/Tally: Yes/);
        expect(screen.queryByRole('progressbar', { name: 'Support progress' })).toBeNull();
    });

    it('shows no vote button before the node says where the reader sits', async () => {
        let answer!: (j: ServedJury) => void;
        vi.mocked(getDecisionJury).mockReturnValue(new Promise(r => { answer = r; }));
        const { container } = renderDecide([juryVote('open')]);
        expect(voteButtons()).toHaveLength(0);
        expect(container.textContent).not.toMatch(/NaN/);
        await act(async () => answer(served({ you: 'seated', answerBy: '2099-11-06T02:00:00.000Z' })));
        await screen.findByTestId('jury-seat-ask');
    });

    it('a juror whose answer is due is asked to serve or step aside, and once they serve gets the vote', async () => {
        vi.mocked(getDecisionJury).mockResolvedValue(served({ you: 'seated', answerBy: '2099-11-06T02:00:00.000Z' }));
        vi.mocked(answerJurySeat).mockResolvedValue({ success: true, jury: served({ you: 'seated', answerBy: null }) });
        renderDecide([juryVote('open')]);
        await screen.findByTestId('jury-seat-ask');
        expect(screen.getByText("You were drawn for this jury. Read the case and Dave's answer, then vote.")).toBeInTheDocument();
        // The time the seat goes as well as the day: it goes at a set minute, 72 hours after the seat.
        expect(screen.getByText(/^Answer by \d{1,2}:\d{2} on \S+ \d{1,2} \S+: serve, or step aside\./)).toBeInTheDocument();
        expect(screen.getByText("Step aside if you know them too well to judge, or can't give it the time. Nobody is told why.")).toBeInTheDocument();
        expect(voteButtons()).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'Serve' }));
        await screen.findByTestId('jury-seat-serving');
        expect(answerJurySeat).toHaveBeenCalledWith('jv', 'serve');
        expect(screen.getByRole('button', { name: /Vote YES/ })).toBeEnabled();
        expect(screen.getByRole('button', { name: /Vote NO/ })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: /Vote YES/ }));
        await waitFor(() => expect(castDecisionVote).toHaveBeenCalledWith('jv', expect.objectContaining({ support: true, voterPubkey: ME })));
    });

    it('stepping aside asks first, then the seat goes and the vote with it', async () => {
        vi.mocked(getDecisionJury).mockResolvedValue(served({ you: 'seated', answerBy: '2099-11-06T02:00:00.000Z' }));
        vi.mocked(answerJurySeat).mockResolvedValue({ success: true, jury: served({ you: null }) });
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        renderDecide([juryVote('open')]);
        await screen.findByTestId('jury-seat-ask');
        fireEvent.click(screen.getByRole('button', { name: 'Step aside' }));
        expect(confirm).toHaveBeenCalledWith('Step aside from this jury? Your seat goes to the next member drawn, and nobody is told why.');
        expect(answerJurySeat).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Step aside' }));
        await screen.findByTestId('jury-seat-not_on_it');
        expect(answerJurySeat).toHaveBeenCalledWith('jv', 'step_aside');
        expect(voteButtons()).toHaveLength(0);
    });

    it('a juror who voted keeps the vote to change, and no Step aside', async () => {
        vi.mocked(getDecisionJury).mockResolvedValue(served({ you: 'seated', answerBy: '2099-11-06T02:00:00.000Z' }));
        renderDecide([juryVote('open', { myVote: { support: true, voteCount: 1, creditsUsed: 1, updatedAt: '2026-11-04T00:00:00.000Z' } })]);
        await screen.findByTestId('jury-seat-voted');
        expect(screen.getByRole('button', { name: /Change to No/ })).toBeEnabled();
        expect(screen.queryByRole('button', { name: 'Step aside' })).toBeNull();
    });

    it('a juror whose seat went to the next member drawn is told so, with no vote', async () => {
        vi.mocked(getDecisionJury).mockResolvedValue(served({ you: 'not_seated' }));
        renderDecide([juryVote('open')]);
        await screen.findByTestId('jury-seat-not_seated');
        expect(screen.getByText("You're no longer on this jury. Your seat went to the next member drawn.")).toBeInTheDocument();
        expect(voteButtons()).toHaveLength(0);
    });

    it('the member it is about reads that the jury sees their answer, and cannot vote', async () => {
        vi.mocked(getDecisionJury).mockResolvedValue(served({ you: null }));
        renderDecide([juryVote('open')], 'open', DAVE);
        await screen.findByTestId('jury-seat-subject');
        expect(screen.getByText('Your answer is shown to the jury.')).toBeInTheDocument();
        expect(screen.getByTestId('own-removal-note')).toBeInTheDocument();
        expect(voteButtons()).toHaveLength(0);
    });

    it('Check the draw: an honest pool checks out; a tampered pool shows the hash sentence', async () => {
        vi.mocked(getDecisionJury).mockResolvedValueOnce(served());
        const first = renderDecide([juryVote('open')]);
        fireEvent.click(await screen.findByRole('button', { name: 'Check the draw' }));
        expect(screen.getByTestId('jury-check-result').textContent).toBe('The draw checks out: the pool is the one this vote recorded. Once it closes, you can check who was drawn.');
        expect(screen.getByText('Drawn from 30 members who could serve on 3 Nov.')).toBeInTheDocument();
        first.unmount();

        const tampered = served();
        tampered.pool = tampered.pool.map((e, i) => (i === 4 ? { ...e, publicKey: key(9999) } : e));
        vi.mocked(getDecisionJury).mockResolvedValueOnce(tampered);
        renderDecide([juryVote('open')]);
        fireEvent.click(await screen.findByRole('button', { name: 'Check the draw' }));
        expect(screen.getByTestId('jury-check-result').textContent).toBe("The list the node served doesn't match its own hash.");
    });
});

describe('a closed jury vote', () => {
    it('says how it ended, names who voted and who did not serve, and checks out over both', async () => {
        vi.mocked(getDecisionJury).mockResolvedValue(closedJury());
        const { container } = renderDecide([juryVote('execution_pending_grace')], 'history');
        expect(await screen.findByTestId('jury-outcome')).toHaveTextContent('The jury voted to remove Dave (9 of 12).');
        expect(screen.getByText('Turnout: 10 of 12 jurors have voted (Met ✅)')).toBeInTheDocument();
        await screen.findByTestId('jury-closed-lists');
        expect(screen.getByTestId('jury-voted').textContent).toMatch(/^Voted: M\d+(, M\d+){9}$/);
        expect(screen.getByTestId('jury-did-not-serve').textContent).toMatch(/^Didn't serve: M\d+/);
        expect(container.textContent).not.toMatch(/stood aside|blocked|reported|silent/i);
        fireEvent.click(screen.getByRole('button', { name: 'Check the draw' }));
        expect(screen.getByTestId('jury-check-result').textContent).toBe('The draw checks out: everyone listed was drawn in order from the pool this vote recorded.');
    });

    it('a dropped name shows the order sentence', async () => {
        const jury = closedJury();
        const firstDrawn = drawn.order[0];
        jury.voted = jury.voted!.filter(e => e.publicKey !== firstDrawn);
        jury.didNotServe = jury.didNotServe!.filter(e => e.publicKey !== firstDrawn);
        vi.mocked(getDecisionJury).mockResolvedValue(jury);
        renderDecide([juryVote('execution_pending_grace')], 'history');
        fireEvent.click(await screen.findByRole('button', { name: 'Check the draw' }));
        expect(screen.getByTestId('jury-check-result').textContent).toBe("The names the node served aren't the first ones the draw picks.");
    });

    it('too few jurors voted: the member is back', async () => {
        vi.mocked(getDecisionJury).mockResolvedValue(closedJury());
        const vote = juryVote('failed');
        vote.tally = { ...vote.tally, totalVoters: 7, quorumMet: false, yesWeight: 6, noWeight: 1, totalWeight: 7, supportRatio: 6 / 7, passed: false, turnout: { voted: 7, size: 12, mustVote: 9 } };
        renderDecide([vote], 'history');
        expect(await screen.findByTestId('jury-outcome')).toHaveTextContent('7 of 12 jurors voted, too few to decide. Dave is back.');
    });
});
