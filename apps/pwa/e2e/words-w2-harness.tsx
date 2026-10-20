/**
 * The screens of words sweep W2 (the enterprise page, the Ledger, the Commons and its Decisions, people and groups), each
 * on its own, in the language the address names: `?screen=<name>&lang=<xx|en|ru|…>`. The real components and the real
 * compiled stylesheet; every /api call is answered by words-w2-check.mjs, which opens each screen at 320 px with 1.3×
 * text and measures what overflows.
 *
 * No Tailwind classes are written here: this file is outside tailwind.config.js's `content` globs, so a class invented
 * here would not be built. Layout below is inline style, as in harness-main.tsx.
 */
import { createRoot } from 'react-dom/client';
import type { UiLang } from '@beanpool/core';
import { showLanguage } from '../src/lib/language';
import { useTheme } from '../src/lib/useTheme';
import { LedgerPage } from '../src/pages/LedgerPage';
import { TreasuryDetailPage } from '../src/pages/TreasuryDetailPage';
import { ProjectsPage } from '../src/pages/ProjectsPage';
import { PeoplePage } from '../src/pages/PeoplePage';
import { CreditBar } from '../src/components/CreditBar';
import { DecideSection } from '../src/components/DecideSection';
import { CommonsInfoModal } from '../src/components/CommonsInfoModal';
import { ProposeDecisionModal } from '../src/components/ProposeDecisionModal';
import { PollCard } from '../src/components/PollCard';
import { GroupDetailModal } from '../src/components/GroupDetailModal';
import { CreateGroupModal } from '../src/components/CreateGroupModal';
import { GroupSuccessionPanel } from '../src/components/GroupSuccessionPanel';
import { EnterpriseCard } from '../src/components/EnterpriseCard';
import { EnterpriseDecisions } from '../src/components/EnterpriseDecisions';
import { EnterpriseLocationPicker } from '../src/components/EnterpriseLocationPicker';
import { IDENTITY } from './fixtures.mjs';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const SCREEN = params.get('screen') ?? 'ledger';
const LANG = (params.get('lang') ?? 'en') as UiLang;
const ME = IDENTITY.publicKey;
const DAY = 24 * 3600 * 1000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const none = () => {};
const noneAsync = async () => {};

function Column({ children, gap = 14 }: { children: React.ReactNode; gap?: number }) {
    return <div style={{ padding: '16px 12px', display: 'flex', flexDirection: 'column', gap, maxWidth: '100%', boxSizing: 'border-box' }}>{children}</div>;
}

const decision = (id: string, over: Record<string, any> = {}): any => ({
    id, authorPubkey: 'author', title: `Fix the hall roof (${id})`, description: 'The north side leaks in heavy rain.', touches: 'member', effect: 'grant_voucher',
    subject: 'subject-pk', params: null, franchise: '1m1v', status: 'open', opensAt: iso(-2 * DAY), closesAt: iso(3 * DAY), gracePeriodEndsAt: null,
    createdAt: iso(-2 * DAY), executedAt: null, executionError: null, executionReason: null, adminHaltedAt: null, adminHaltReason: null, updatedAt: iso(-DAY),
    tally: { decisionId: id, status: 'open', totalVoters: 1, electorate: 20, quorumRatio: 0.3, quorumRequired: 6, quorumMet: false, yesWeight: 1, noWeight: 0, totalWeight: 1, supportRatio: 1, thresholdRequired: 0.6, passed: false },
    myVote: null,
    ...over,
});
const DECISIONS = [
    decision('a', { myVote: { support: true, voteCount: 1, creditsUsed: 0, updatedAt: '' } }),
    decision('b', { touches: 'pool', effect: 'grant_enterprise', franchise: 'quadratic_trade', params: { amount: 50 }, myVote: { support: false, voteCount: 3, creditsUsed: 9, updatedAt: '' } }),
    decision('c', { effect: 'keep_suspension', params: { memberName: 'Dave', suspendedAt: iso(-2 * DAY) } }),
    decision('d', { effect: 'remove_member', params: { memberName: 'Eve', debt: 12.5, commonsPool: 300 } }),
];
const POOL_VOTING = { hasCompletedTrade: true, voiceCredits: 16 };

const poll = (over: Record<string, unknown> = {}): any => ({
    id: 'poll-1', type: 'poll', category: 'community', title: 'Where should the tool shed go?', description: 'North gate or south barn.',
    authorPublicKey: ME, authorCallsign: 'Alice', createdAt: iso(-DAY), status: 'active', active: true, credits: 0, priceType: 'fixed', repeatable: false,
    pollOptions: [{ id: 'o1', text: 'North Gate', votes: 3, percentage: 60 }, { id: 'o2', text: 'South Barn', votes: 2, percentage: 40 }],
    pollClosesAt: iso(6.5 * DAY), totalVotes: 5, userVotedOptionId: 'o1', pollOpenVote: true,
    pollVotes: [{ voterPubkey: 'v1', voterCallsign: 'Bob', optionId: 'o1', createdAt: iso(-DAY) }],
    ...over,
});

const GROUP: any = {
    id: 'g1', name: 'Garden Crew', slug: 'garden-crew', category: 'working_group', joinPolicy: 'request_to_join', description: 'We grow things together',
    memberCount: 4, createdBy: ME, createdAt: '2026-01-01T00:00:00.000Z', leadPubkey: ME, leadCallsign: 'Marty',
};
const ROSTER: any[] = [
    { groupId: 'g1', memberPubkey: ME, callsign: 'Marty', role: 'convenor', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
    { groupId: 'g1', memberPubkey: 'pk-damo', callsign: 'Damo', role: 'convenor', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
    { groupId: 'g1', memberPubkey: 'pk-zed', callsign: 'Zed', role: 'member', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
    { groupId: 'g1', memberPubkey: 'pk-obi', callsign: 'Obi', role: 'observer', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
    { groupId: 'g1', memberPubkey: 'pk-pia', callsign: 'Pia', role: 'member', status: 'pending_approval', joinedAt: '2026-01-01T00:00:00.000Z' },
];

const card = (over: Record<string, unknown> = {}): any => ({
    publicKey: 'ent-1', name: 'Bindarrabi Bakery', callsign: 'bakery', balance: 120, creditLine: 0, liveOffers: 1,
    purpose: 'Bread for the valley, baked at dawn.', keepers: [{ publicKey: 'a', callsign: 'Ann' }, { publicKey: 'b', callsign: 'Bob' }],
    lifecycle: 'ongoing', status: 'active', ...over,
});
const KEEPERS = [
    { publicKey: 'a'.repeat(64), callsign: 'Ann', role: 'lead' },
    { publicKey: ME, callsign: 'Bob', role: 'keeper' },
    { publicKey: 'c'.repeat(64), callsign: 'Cat', role: 'keeper' },
];

function Screen() {
    useTheme();
    switch (SCREEN) {
        case 'ledger':
        case 'ledger-wallet':
            return <LedgerPage identity={IDENTITY as never} isMember onNavigate={none} />;
        case 'credit-bar':
            return (
                <Column>
                    <CreditBar balance={-100} floor={-1000} usableFloor={-200} liveOffers={1} />
                    <CreditBar balance={0} floor={-1000} usableFloor={0} liveOffers={0} />
                    <CreditBar balance={600} floor={-500} />
                </Column>
            );
        case 'enterprise':
        case 'enterprise-project':
        case 'enterprise-member':
            return <TreasuryDetailPage identity={(SCREEN === 'enterprise-member' ? { publicKey: 'member-dan', callsign: 'Dan' } : IDENTITY) as never}
                pubkey={SCREEN === 'enterprise' ? 'ent-busy' : 'prj-roof'} onBack={none} onOpenProfile={none} />;
        case 'commons': return <ProjectsPage identity={IDENTITY as never} />;
        case 'commons-decide': return <ProjectsPage identity={IDENTITY as never} initialSection="decide" />;
        case 'decide':
            return (
                <DecideSection decisions={DECISIONS} myPoolVoting={POOL_VOTING} identity={IDENTITY as never} commonsBalance={300} onRefresh={noneAsync}
                    onOpenPropose={none} canPropose hasOpenDecision activeView="open" onChangeView={none} />
            );
        case 'commons-info': return <CommonsInfoModal isOpen onClose={none} commonsBalance={123.45} />;
        case 'propose':
            return <ProposeDecisionModal isOpen onClose={none} onCreated={none} identity={IDENTITY as never} commonsBalance={321.6} treasuries={[]} members={[{ publicKey: 'm'.repeat(64), callsign: 'Mia' }] as never} />;
        case 'polls':
            return (
                <Column>
                    <PollCard post={poll()} identity={IDENTITY as never} />
                    <PollCard post={poll({ id: 'poll-2', authorPublicKey: 'someone', userVotedOptionId: null, pollClosesAt: iso(2.5 * 3600 * 1000) })} identity={IDENTITY as never} />
                    <PollCard post={poll({ id: 'poll-3', pollOpenVote: false, pollVotes: [], status: 'completed', userVotedOptionId: null })} identity={IDENTITY as never} informal />
                </Column>
            );
        case 'people': return <PeoplePage identity={IDENTITY as never} onNavigate={none} />;
        case 'people-community': return <PeoplePage identity={IDENTITY as never} initialView="community" />;
        case 'group': return <GroupDetailModal group={GROUP} isOpen onClose={none} myPubkey={ME} onPostToGroup={none} />;
        case 'create-group': return <CreateGroupModal isOpen onClose={none} onCreated={none} />;
        case 'group-succession': return <Column><GroupSuccessionPanel groupId="g1" members={ROSTER} myPubkey="pk-damo" /></Column>;
        case 'enterprise-cards':
            return (
                <Column>
                    <EnterpriseCard treasury={card({ earnedSurplus: 30 })} />
                    <EnterpriseCard treasury={card({ publicKey: 'e2', balance: -1, liveOffers: 3, keepers: [], callsign: undefined, purpose: null })} />
                    <EnterpriseCard treasury={card({ publicKey: 'e3', name: 'Seed library', lifecycle: 'bounded', goalAmount: 500, currentAmount: 120, deadlineAt: iso(5 * DAY) })} />
                    <EnterpriseCard treasury={card({ publicKey: 'e5', paused: true, balance: 0 })} />
                    <EnterpriseCard treasury={card({ publicKey: 'e6', status: 'winding_up' })} />
                    <EnterpriseCard treasury={card({ publicKey: 'e7', status: 'completed' })} />
                </Column>
            );
        case 'enterprise-decisions':
            return <Column><EnterpriseDecisions treasuryKey="ent-busy" myPubkey={ME} keepers={KEEPERS} balance={120} earnedSurplus={100} lifecycle="ongoing" /></Column>;
        case 'location-picker':
            return <Column><EnterpriseLocationPicker treasury={{ publicKey: 'ent-1', lat: -28.549, lng: 153.501 }} onLocationSaved={none} onClose={none} /></Column>;
        default: return <p>Unknown screen {SCREEN}</p>;
    }
}

void showLanguage(LANG).then(() => {
    createRoot(document.getElementById('root')!).render(<Screen />);
    document.documentElement.dataset.harnessReady = 'true';
});
