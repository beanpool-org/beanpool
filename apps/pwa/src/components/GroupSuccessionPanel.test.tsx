import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GroupSuccessionPanel } from './GroupSuccessionPanel';
import { getGroupSuccession, proposeGroupSuccession, voteGroupSuccession, type GroupMember } from '../lib/api';

/**
 * The quiet-lead vote as it is actually drawn. group-succession.test.ts covers the rules; this covers the wiring
 * of them into the panel — the hiding, the confirm, and the body that reaches the node.
 */

vi.mock('../lib/api', async (orig) => ({
    ...(await orig<any>()),
    getGroupSuccession: vi.fn(),
    proposeGroupSuccession: vi.fn(),
    voteGroupSuccession: vi.fn(),
}));

const LEAD = 'pk-lead';
const CONVENOR = 'pk-damo';
const OTHER = 'pk-pia';

const MEMBERS: GroupMember[] = [
    { groupId: 'g1', memberPubkey: LEAD, callsign: 'Marty', role: 'convenor', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
    { groupId: 'g1', memberPubkey: CONVENOR, callsign: 'Damo', role: 'convenor', status: 'active', joinedAt: '2026-01-02T00:00:00.000Z' },
    { groupId: 'g1', memberPubkey: OTHER, callsign: 'Pia', role: 'convenor', status: 'active', joinedAt: '2026-01-03T00:00:00.000Z' },
];

const silence = (over: Record<string, unknown> = {}) => ({
    convenorPubkey: LEAD, convenorCallsign: 'Marty', lastActiveAt: '2026-08-10T00:00:00.000Z',
    daysInactive: 44.6, isSilent: true, isEligible: true, electorate: 'convenors' as const, ...over,
});

const proposal = (over: Record<string, unknown> = {}) => ({
    id: 'prop-1', groupId: 'g1',
    convenorPubkey: LEAD, convenorCallsign: 'Marty',
    candidatePubkey: CONVENOR, candidateCallsign: 'Damo',
    proposerPubkey: CONVENOR, proposerCallsign: 'Damo',
    status: 'active' as const, closedReason: null,
    createdAt: '2026-09-23T00:00:00.000Z', deadlineAt: '2026-10-07T00:00:00.000Z', executedAt: null,
    yesCount: 1, noCount: 0, electorateSize: 3, myVote: null, canVote: true, ...over,
});

function answer(over: Record<string, unknown> = {}) {
    vi.mocked(getGroupSuccession).mockResolvedValue({
        silence: silence(), proposals: [], canPropose: false, ...over,
    } as any);
}

function panel(props: Record<string, unknown> = {}) {
    return render(
        <GroupSuccessionPanel groupId="g1" members={MEMBERS} myPubkey={OTHER} {...props} />
    );
}

beforeEach(() => {
    vi.mocked(getGroupSuccession).mockReset();
    vi.mocked(proposeGroupSuccession).mockReset();
    vi.mocked(voteGroupSuccession).mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('GroupSuccessionPanel — a healthy group sees nothing', () => {
    it('draws nothing when the lead is not eligible and no vote was ever held', async () => {
        answer({ silence: silence({ isSilent: false, isEligible: false }) });
        const { container } = panel();
        await waitFor(() => expect(getGroupSuccession).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it('draws nothing, and reports nothing, when the node is too old for the route (404)', async () => {
        const missing = Object.assign(new Error('Not found'), { status: 404 });
        vi.mocked(getGroupSuccession).mockRejectedValue(missing);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { container } = panel();
        await waitFor(() => expect(getGroupSuccession).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('GroupSuccessionPanel — proposing', () => {
    it('offers the picker only when the server says canPropose', async () => {
        answer({ canPropose: false });
        panel();
        await waitFor(() => expect(screen.getByText(/hasn't been active for 44 days/)).toBeInTheDocument());
        expect(screen.queryByLabelText('Propose a new lead')).toBeNull();
    });

    it('offers the picker with the electorate, the viewer marked, when canPropose', async () => {
        answer({ canPropose: true });
        panel();
        const select = await screen.findByLabelText('Propose a new lead');
        const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent);
        expect(options).toEqual(['Choose someone…', 'Damo', 'Pia (yourself)']);
    });

    it('sends the chosen candidate and reloads', async () => {
        answer({ canPropose: true });
        vi.mocked(proposeGroupSuccession).mockResolvedValue({ success: true, executed: false } as any);
        panel();
        const select = await screen.findByLabelText('Propose a new lead');
        fireEvent.change(select, { target: { value: CONVENOR } });
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
        await waitFor(() => expect(proposeGroupSuccession).toHaveBeenCalledWith('g1', CONVENOR));
        await waitFor(() => expect(getGroupSuccession).toHaveBeenCalledTimes(2));
    });

    it('shows the server\'s own refusal rather than a guess of its own', async () => {
        answer({ canPropose: true });
        vi.mocked(proposeGroupSuccession).mockRejectedValue(new Error('The candidate must be an active convenor of this group'));
        panel();
        const select = await screen.findByLabelText('Propose a new lead');
        fireEvent.change(select, { target: { value: CONVENOR } });
        fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
        expect(await screen.findByText('The candidate must be an active convenor of this group')).toBeInTheDocument();
    });
});

describe('GroupSuccessionPanel — an open vote', () => {
    it('shows the candidate, the closing date and the totals', async () => {
        answer({ proposals: [proposal({ yesCount: 2, noCount: 1, electorateSize: 5 })] });
        panel();
        expect(await screen.findByText(/Proposed as the new lead/)).toBeInTheDocument();
        expect(screen.getByText('2 yes, 1 no, of 5 who can vote.')).toBeInTheDocument();
        expect(screen.getByText(/Closes 7 Oct 2026/)).toBeInTheDocument();
    });

    it('offers Yes and No to an eligible voter who has not voted', async () => {
        answer({ proposals: [proposal({ canVote: true })] });
        panel();
        expect(await screen.findByRole('button', { name: 'Vote yes to make Damo the lead convenor' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Vote no to making Damo the lead convenor' })).toBeInTheDocument();
    });

    it('offers no buttons to somebody who may not vote — an observer, or the quiet lead', async () => {
        answer({ proposals: [proposal({ canVote: false })] });
        panel();
        await screen.findByText(/Proposed as the new lead/);
        expect(screen.queryByRole('button', { name: /^Vote /  })).toBeNull();
    });

    it('offers no buttons once the viewer has voted, and says so', async () => {
        answer({ proposals: [proposal({ canVote: false, myVote: 'no' })] });
        panel();
        expect(await screen.findByText(/You voted no/)).toBeInTheDocument();
        expect(screen.getByText(/Votes can't be changed/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Vote / })).toBeNull();
    });

    it('sends the choice as the body, and only after the confirm is accepted', async () => {
        answer({ proposals: [proposal()] });
        vi.mocked(voteGroupSuccession).mockResolvedValue({ success: true, executed: false } as any);
        const confirm = vi.fn().mockReturnValue(false);
        vi.stubGlobal('confirm', confirm);

        panel();
        const yes = await screen.findByRole('button', { name: 'Vote yes to make Damo the lead convenor' });

        // Declined: nothing reaches the node at all.
        fireEvent.click(yes);
        await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        expect(confirm.mock.calls[0][0]).toContain("Votes can't be changed.");
        expect(voteGroupSuccession).not.toHaveBeenCalled();

        // Accepted: proposal id and choice, and nothing else.
        confirm.mockReturnValue(true);
        fireEvent.click(yes);
        await waitFor(() => expect(voteGroupSuccession).toHaveBeenCalledWith('g1', 'prop-1', 'yes'));

        fireEvent.click(screen.getByRole('button', { name: 'Vote no to making Damo the lead convenor' }));
        await waitFor(() => expect(voteGroupSuccession).toHaveBeenCalledWith('g1', 'prop-1', 'no'));
    });

    it('tells the screen around it to reload when a vote passes, so the Lead badge moves', async () => {
        answer({ proposals: [proposal()] });
        vi.mocked(voteGroupSuccession).mockResolvedValue({ success: true, executed: true } as any);
        vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
        const onLeadChanged = vi.fn();

        panel({ onLeadChanged });
        fireEvent.click(await screen.findByRole('button', { name: 'Vote yes to make Damo the lead convenor' }));
        await waitFor(() => expect(onLeadChanged).toHaveBeenCalled());
    });

    /** The one fixed sentence that says ballots are secret; it is the only other place the word appears. */
    const SECRECY_NOTE = 'Votes are secret, and nobody sees who voted which way.';

    it('names no voter but the viewer themselves: ballots are secret', async () => {
        // The proposer is Pia, and proposing is a Yes on the record — so naming the proposer would be publishing
        // a ballot. Damo, the candidate, is the only name this may carry.
        answer({
            proposals: [proposal({
                proposerPubkey: OTHER, proposerCallsign: 'Pia',
                yesCount: 2, noCount: 1, electorateSize: 3, canVote: false, myVote: 'yes',
            })],
        });
        const { container } = panel();
        await screen.findByText(/Proposed as the new lead/);
        const text = container.textContent || '';

        expect(text).not.toContain('Pia');
        // Every "… voted" in the panel, once the fixed secrecy note is taken out: the viewer's own, and nothing
        // else. A "Proposed by X, who voted yes" would land here.
        const attributions = (text.replace(SECRECY_NOTE, '').match(/[\w'’]+ voted/g) ?? []);
        expect(attributions).toEqual(['You voted']);
        expect(text).toContain('You voted yes');
        expect(text).toContain('nobody sees who voted which way');
    });
});

describe('GroupSuccessionPanel — a closed vote', () => {
    const closed = (reason: string, status = 'cancelled') =>
        ({ proposals: [proposal({ status, closedReason: reason })], silence: silence({ isSilent: false, isEligible: false }) });

    it.each([
        ['rejected', 'The group voted no, so Marty is still the lead.'],
        ['convenor_returned', 'Marty came back, so the vote closed.'],
        ['candidate_gone', 'Damo is no longer in the group, so the vote closed.'],
        ['no_longer_needed', 'The group has another lead now, so the vote closed.'],
    ])('says one line for %s', async (reason, line) => {
        answer(closed(reason));
        panel();
        expect(await screen.findByText(line)).toBeInTheDocument();
    });

    it('says one line when the vote passed', async () => {
        answer({ proposals: [proposal({ status: 'passed', closedReason: null })], silence: silence({ isSilent: false, isEligible: false }) });
        panel();
        expect(await screen.findByText("Damo is now the group's lead convenor.")).toBeInTheDocument();
    });
});
