/**
 * A group in the member's language (words S3, web sweep W2): the group sheet (its pills, the lead convenor's line, the
 * framing, Convenor Tools, join requests, the roster and its controls, the buttons at the foot and every confirm and
 * error it says), the Create a Group form, and the quiet-lead vote's own words, through t() with the phone's keys
 * where it says the same (S3h). A group's name and purpose and its members' names are what members wrote: shown as
 * written.
 *
 * The quiet-lead vote's lines are lib/group-succession.ts's (who has been quiet, who votes, the tally, the closing date,
 * the outcome and the vote's confirm): the phone's utils/group-succession.ts, through t()/tn() with the same keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
    getGroup, getGroupMembers, getGroupSuccession, getCommunityMe, createGroup, proposeGroupSuccession,
    type Group, type GroupMember,
} from '../lib/api';
import { buildSuccessionView, voteConfirmText } from '../lib/group-succession';
import { GroupDetailModal } from './GroupDetailModal';
import { CreateGroupModal } from './CreateGroupModal';
import { GroupSuccessionPanel } from './GroupSuccessionPanel';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-w2.test-support';

vi.mock('../lib/api', async (orig) => ({
    ...(await orig<typeof import('../lib/api')>()),
    getGroupDecisions: vi.fn(async () => null),
    getGroup: vi.fn(),
    getGroupMembers: vi.fn(),
    getCommunityMe: vi.fn(),
    joinGroup: vi.fn(),
    removeGroupMember: vi.fn(),
    approveGroupMember: vi.fn(),
    setGroupMemberRole: vi.fn(),
    handOverGroupLead: vi.fn(),
    updateGroup: vi.fn(),
    createGroup: vi.fn(),
    getGroupSuccession: vi.fn(),
    proposeGroupSuccession: vi.fn(),
    voteGroupSuccession: vi.fn(),
}));

const ME = 'pk-me';
const DAMO = 'pk-damo';
const ZED = 'pk-zed';
const OBI = 'pk-obi';
const PIA = 'pk-pia';
const member = (memberPubkey: string, callsign: string, role: GroupMember['role'], status: GroupMember['status'] = 'active'): GroupMember =>
    ({ groupId: 'g1', memberPubkey, callsign, role, status, joinedAt: '2026-01-01T00:00:00.000Z' });
const ROSTER: GroupMember[] = [
    member(ME, 'Marty', 'convenor'), member(DAMO, 'Damo', 'convenor'), member(ZED, 'Zed', 'member'),
    member(OBI, 'Obi', 'observer'), member(PIA, 'Pia', 'member', 'pending_approval'),
];
const GROUP: Group = {
    id: 'g1', name: 'Garden Crew', slug: 'garden-crew', category: 'working_group', joinPolicy: 'request_to_join',
    description: 'We grow things together', memberCount: 4, createdBy: ME, createdAt: '2026-01-01T00:00:00.000Z',
    leadPubkey: ME, leadCallsign: 'Marty',
};
/**
 * What members wrote: the group's name and purpose, their names (and an avatar's initial). And the ℹ️ beside the
 * framing line, which is no word but a letter to Unicode (U+2139 INFORMATION SOURCE is Ll).
 */
const OTHERS = ['Garden Crew', 'We grow things together', 'Marty', 'Damo', 'Zed', 'Obi', 'Pia', 'M', 'D', 'Z', 'O', 'P', 'ℹ️'];
const HEALTHY = { silence: { convenorPubkey: ME, convenorCallsign: 'Marty', lastActiveAt: null, daysInactive: 0, isSilent: false, isEligible: false, electorate: 'convenors' }, proposals: [], canPropose: false };

let said: string[] = [];
beforeEach(() => {
    vi.clearAllMocks();
    said = [];
    vi.stubGlobal('confirm', (m: string) => { said.push(m); return false; });
    vi.mocked(getGroup).mockResolvedValue({ ...GROUP, viewerRole: 'convenor', viewerStatus: 'active' } as Group);
    vi.mocked(getGroupMembers).mockResolvedValue(ROSTER);
    vi.mocked(getCommunityMe).mockResolvedValue({ mute: { muted: false, until: null } } as any);
    vi.mocked(getGroupSuccession).mockResolvedValue(HEALTHY as any);
});
afterEach(() => { cleanup(); backToEnglish(); vi.unstubAllGlobals(); });

describe('the group sheet in the pseudo-locale', () => {
    it("the lead convenor's sheet: pills, lead line, framing, Convenor Tools, requests, roster and its controls", async () => {
        await showIn('xx');
        render(<GroupDetailModal group={GROUP} isOpen onClose={() => {}} myPubkey={ME} onPostToGroup={() => {}} />);
        await screen.findByText('Zed');
        await screen.findByTestId('group-invite-people');
        expect(screen.getByText(xx('working group'))).toBeInTheDocument();
        expect(screen.getByText(xx('Pending Join Requests ({n})').replace('{n}', '1'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Make {name} the lead convenor').replace('{name}', 'Damo') }).textContent).toBe(xx('Make lead'));
        expect(screen.getByRole('combobox', { name: xx('Role for {name}').replace('{name}', 'Zed') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Remove {name} from group').replace('{name}', 'Zed') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Approve join request from {name}').replace('{name}', 'Pia') })).toBeInTheDocument();
        expect(screen.getByText(xx('Lead'))).toBeInTheDocument();
        expect(screen.getByText(xx('Roster ({n})').replace('{n}', '4'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(20);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        // What it says: the hand-over and remove confirms, and a lead who tries to leave.
        fireEvent.click(screen.getByRole('button', { name: xx('Make {name} the lead convenor').replace('{name}', 'Damo') }));
        fireEvent.click(screen.getByRole('button', { name: xx('Remove {name} from group').replace('{name}', 'Zed') }));
        fireEvent.click(screen.getByRole('button', { name: xx('Leave Group') }));
        expect(said).toHaveLength(2);
        expect(await screen.findByText(xx('You are the lead convenor of {group}. Hand the lead to someone else first, then you can leave.').replace('{group}', 'Garden Crew'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS, said })).toEqual([]);
    });

    it('a visitor: the roster refused, and each way in (ask, invite only, closed, waiting)', async () => {
        vi.mocked(getGroup).mockResolvedValue({ ...GROUP, leadCallsign: null, leadPubkey: null, viewerStatus: 'none', viewerRole: null } as unknown as Group);
        vi.mocked(getGroupMembers).mockRejectedValue(Object.assign(new Error('Join the group to see who is here'), { code: 'join_to_see' }));
        await showIn('xx');
        const visitor = { ...GROUP, leadCallsign: null, leadPubkey: null } as unknown as Group;
        render(<GroupDetailModal group={visitor} isOpen onClose={() => {}} myPubkey="pk-visitor" />);
        expect(await screen.findByText(xx('Join the group to see who is here'))).toBeInTheDocument();
        expect(screen.getByText(xx('{n} members').replace('{n}', '4'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Request to Join') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        cleanup();

        for (const [over, words] of [
            [{ joinPolicy: 'invite_only' }, 'Invite Only'],
            [{ viewerStatus: 'pending_approval' }, 'Request Pending Approval'],
        ] as const) {
            vi.mocked(getGroup).mockResolvedValue({ ...visitor, viewerStatus: 'none', ...over } as unknown as Group);
            render(<GroupDetailModal group={{ ...visitor, ...over } as Group} isOpen onClose={() => {}} myPubkey="pk-visitor" />);
            expect(await screen.findByText(xx(words))).toBeInTheDocument();
            expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
            cleanup();
        }

        const closed = { ...visitor, closedAt: '2026-10-10T00:00:00Z' } as unknown as Group;
        vi.mocked(getGroup).mockResolvedValue({ ...closed, viewerStatus: 'none' } as unknown as Group);
        render(<GroupDetailModal group={closed} isOpen onClose={() => {}} myPubkey="pk-visitor" />);
        expect(await screen.findByTestId('group-closed-note')).toBeInTheDocument();
        expect(screen.getByTestId('group-closed-pill')).toHaveTextContent(xx('Closed'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });
});

describe('Create a Group in the pseudo-locale', () => {
    it('the form, its choices, the bridge, a name too short and creating', async () => {
        await showIn('xx');
        render(<CreateGroupModal isOpen onClose={() => {}} onCreated={() => {}} onStartWithBeans={() => {}} />);
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(xx('Create a Group'));
        expect(screen.getByText(xx('Working Group'))).toBeInTheDocument();
        expect(screen.getByText(xx('Request to Join'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('🌱 Start a project') })).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(15);
        const others = ['ℹ️'];
        expect(bypassing(document.body, { others })).toEqual([]);

        fireEvent.change(screen.getByPlaceholderText(xx('e.g. Bindarrabi Garden Crew, Solar Guild')), { target: { value: 'A' } });
        fireEvent.click(screen.getByRole('button', { name: xx('Create Group (You become Convenor)') }));
        expect(await screen.findByText(xx('Group name must be at least 2 characters long.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others })).toEqual([]);

        vi.mocked(createGroup).mockReturnValue(new Promise(() => {}));
        fireEvent.change(screen.getByPlaceholderText(xx('e.g. Bindarrabi Garden Crew, Solar Guild')), { target: { value: 'Bees' } });
        fireEvent.click(screen.getByRole('button', { name: xx('Create Group (You become Convenor)') }));
        expect(await screen.findByRole('button', { name: xx('Creating...') })).toBeInTheDocument();
        expect(bypassing(document.body, { others })).toEqual([]);
    });
});

describe('the quiet-lead vote in the pseudo-locale', () => {
    const silence = { convenorPubkey: ME, convenorCallsign: 'Marty', lastActiveAt: '2026-08-10T00:00:00.000Z', daysInactive: 44.6, isSilent: true, isEligible: true, electorate: 'convenors' as const };
    const proposal = (over: Record<string, unknown> = {}) => ({
        id: 'p1', groupId: 'g1', convenorPubkey: ME, convenorCallsign: 'Marty', candidatePubkey: DAMO, candidateCallsign: 'Damo',
        proposerPubkey: DAMO, proposerCallsign: 'Damo', status: 'active', closedReason: null, createdAt: '2026-09-23T00:00:00.000Z',
        // Half an hour past 5 days, so the panel and libLines (a moment apart) both read the same days left.
        deadlineAt: new Date(Date.now() + 5 * 86_400_000 + 1_800_000).toISOString(), executedAt: null, yesCount: 1, noCount: 0, electorateSize: 3,
        myVote: null, canVote: true, ...over,
    });
    /** What lib/group-succession.ts writes for this answer, as the panel draws it now: each line came through t(). */
    const libLines = (data: unknown) => {
        const v = buildSuccessionView(data as any, ROSTER);
        return [v.silenceLine, v.whoVotesLine, v.tallyLine, v.closingLine, v.outcomeLine].filter((l): l is string => !!l);
    };
    const panel = () => render(<GroupSuccessionPanel groupId="g1" members={ROSTER} myPubkey={DAMO} />);

    it('a vote running: who is proposed, Yes and No, and the vote once cast', async () => {
        const data = { silence, proposals: [proposal()], canPropose: false };
        vi.mocked(getGroupSuccession).mockResolvedValue(data as any);
        await showIn('xx');
        panel();
        expect(await screen.findByText(xx('It passes if more than half of those who answer say yes. Votes are secret, and nobody sees who voted which way.'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Vote yes to make {name} the lead convenor').replace('{name}', 'Damo') }).textContent).toBe(xx('Yes'));
        fireEvent.click(screen.getByRole('button', { name: xx('Vote no to making {name} the lead convenor').replace('{name}', 'Damo') }));
        expect(said).toEqual([voteConfirmText('no', 'Damo')]);
        expect(bypassing(document.body, { others: OTHERS, said })).toEqual([]);
        // The module's lines are drawn, each in xx's form (the bypass check above reads them as drawn).
        const lines = libLines(data);
        expect(lines.length).toBeGreaterThanOrEqual(3);
        for (const line of lines) {
            expect(line.startsWith('[')).toBe(true);
            expect(document.body.textContent).toContain(line);
        }
        cleanup();

        const voted = { silence, proposals: [proposal({ myVote: 'yes', canVote: false })], canPropose: false };
        vi.mocked(getGroupSuccession).mockResolvedValue(voted as any);
        panel();
        expect(await screen.findByText(xx("You voted yes. Votes can't be changed."))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it('proposing: the picker with the viewer in it, and a refusal with no words of its own', async () => {
        const data = { silence, proposals: [], canPropose: true };
        vi.mocked(getGroupSuccession).mockResolvedValue(data as any);
        vi.mocked(proposeGroupSuccession).mockRejectedValue(new Error(''));
        await showIn('xx');
        render(<GroupSuccessionPanel groupId="g1" members={ROSTER} myPubkey={DAMO} />);
        const picker = await screen.findByLabelText(xx('Propose a new lead'));
        expect(screen.getByRole('option', { name: xx('{name} (yourself)').replace('{name}', 'Damo') })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: xx('Choose someone…') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        fireEvent.change(picker, { target: { value: DAMO } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('Propose') })); });
        expect(await screen.findByText(xx('Could not propose a new lead.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it("a vote that closed: the quiet heading over the outcome", async () => {
        const data = { silence: { ...silence, isSilent: false, isEligible: false }, proposals: [proposal({ status: 'passed', executedAt: new Date().toISOString() })], canPropose: false };
        vi.mocked(getGroupSuccession).mockResolvedValue(data as any);
        await showIn('xx');
        panel();
        expect(await screen.findByRole('heading', { name: xx('Lead convenor') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });
});

describe('groups in English', () => {
    it('nothing is bracketed, and the words are as they were', async () => {
        render(<GroupDetailModal group={GROUP} isOpen onClose={() => {}} myPubkey={ME} onPostToGroup={() => {}} />);
        await screen.findByText('Zed');
        expect(bracketed()).toBe(0);
        expect(screen.getByText(/Lead convenor:/).textContent).toBe('Lead convenor: Marty (you). Only the lead can remove or demote a convenor, and nobody can remove the lead.');
        expect(screen.getByText(/A group is a place/).closest('div')!.textContent).toBe('ℹ️ A group is a place to talk to some people rather than everyone. It does not hold beans and does not confer trust.');
        expect(screen.getByText('working group')).toBeInTheDocument();
        expect(screen.getAllByText('request to join')).toHaveLength(2);
        expect(screen.getByText(/^Join Policy:/).textContent).toBe('Join Policy: request to join');
        expect(screen.getByText('Pending Join Requests (1)')).toBeInTheDocument();
        expect(screen.getByText('Roster (4)')).toBeInTheDocument();
        expect(screen.getAllByText('Lead')).toHaveLength(1);
        expect(screen.getByText('(You)')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Post to Garden Crew/ }).textContent).toBe('✏️ Post to Garden Crew');
        fireEvent.click(screen.getByRole('button', { name: 'Make Damo the lead convenor' }));
        expect(said).toEqual(['Make Damo the lead convenor of Garden Crew? They can remove and demote convenors, and you cannot take the lead back.']);
        cleanup();

        render(<CreateGroupModal isOpen onClose={() => {}} onCreated={() => {}} />);
        expect(screen.getByText(/A group is a place/).closest('div')!.textContent)
            .toBe('ℹ️ A group is a place to talk to some people rather than everyone. It does not hold beans and does not confer trust or voting standing.');
        expect(screen.getByRole('button', { name: 'Create Group (You become Convenor)' })).toBeInTheDocument();
        cleanup();

        vi.mocked(getGroupSuccession).mockResolvedValue({ silence: { ...HEALTHY.silence, isSilent: true, isEligible: true }, proposals: [], canPropose: true } as any);
        render(<GroupSuccessionPanel groupId="g1" members={ROSTER} myPubkey={DAMO} />);
        expect(await screen.findByRole('option', { name: 'Damo (yourself)' })).toBeInTheDocument();
        expect(screen.getByRole('heading').textContent).toBe('⚠️ Choosing a new lead convenor');
    });
});
