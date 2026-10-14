import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
    getTreasuries, getBalance, type Treasury, type BalanceInfo,
    createEnterprise,
    getDecisions, type DecisionWithTally, type MyPoolVoting,
    getCommonsBalance,
    getAllMembers, type MemberSummary,
    getGroups, type Group,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';
import { resizePhotoFile } from '../lib/photo-resize';
import { DecideSection } from '../components/DecideSection';
import { ProposeDecisionModal } from '../components/ProposeDecisionModal';
import { CreateGroupModal } from '../components/CreateGroupModal';
import { GroupDetailModal } from '../components/GroupDetailModal';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import { decisionsOn } from '../lib/node-decisions';
import { useMembersOnDemand } from '../lib/members-on-demand';
import { pledgeClosedLine } from '../lib/enterprise-pledge';
import { modeFor, readerFeaturesOnce } from '../lib/features';
import type { FeatureMode } from '@beanpool/core';
import { CommonsPreview } from '../components/ShowcasePreviews';

interface Props {
    identity: BeanPoolIdentity | null;
    onOpenTreasury?: (publicKey: string) => void;
    initialSection?: 'decide' | 'enterprises' | 'groups';
    onNavigate?: (tab: string, contextId?: string) => void;
    /**
     * Whether the viewer is a member of this node. False for a guest (a local key the node has no member
     * for), so the viewer's balance is never requested. Null while App is still checking, so the request
     * waits for the answer. Omitted means a member.
     */
    isMember?: boolean | null;
}

/** Shown when the browser cannot read or decode the picked photo (resizePhotoFile rejected). */
const PHOTO_READ_ERROR = 'That photo could not be read. Please choose another one.';

/** Today in the member's own calendar, as a date field reads it (YYYY-MM-DD): a project can't end before it. */
const localToday = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function ProjectsPage({ identity, onOpenTreasury, initialSection = 'enterprises', onNavigate, isMember }: Props) {
    const canLoadBalance = !!identity?.publicKey && isMember !== false && isMember !== null;
    const [treasuries, setTreasuries] = useState<Treasury[]>([]);
    // Avatar URLs that failed to load; those cards show the no-avatar placeholder instead of alt text.
    const [failedAvatars, setFailedAvatars] = useState<ReadonlySet<string>>(() => new Set());
    const [balanceInfo, setBalanceInfo] = useState<BalanceInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // UI States
    // One Groups list holds projects, enterprises and chat groups (pick 7): a page asked for Enterprises opens on it.
    const [pickedSection, setActiveSection] = useState<'decide' | 'groups'>(initialSection === 'enterprises' ? 'groups' : initialSection);
    // Formal Decisions, where the node has them (lib/node-decisions.ts: off on the global node, which refuses every
    // proposal and vote). Until the node has said, on, as on every node before the switch. Where they are off there is
    // no Decide tab, and a page asked to open on Decide opens on Groups.
    const [votes, setVotes] = useState(true);
    // Projects and enterprises hold Beans: where the node has Beans off, the Create form offers neither.
    const [beansOn, setBeansOn] = useState(true);
    // Enterprises or Decisions off here and the node shows previews: the Commons shows Example Valley's, each by its own
    // mode (lib/features.ts).
    const [enterprisesMode, setEnterprisesMode] = useState<FeatureMode>('hidden');
    const [decisionsMode, setDecisionsMode] = useState<FeatureMode>('hidden');
    useEffect(() => {
        let cancelled = false;
        Promise.resolve()
            .then(() => communityInfoOnce())
            .then((info) => {
                if (cancelled) return;
                // The node's info alone sets Decide and the Beans create options, as before: no wait on the reader's set.
                setVotes(decisionsOn(info));
                setBeansOn(info?.features?.beans !== false);
                // The modes wait for the reader's set too (none is read where it cannot matter): no preview flashes and goes.
                return readerFeaturesOnce(info).then((reader) => {
                    if (cancelled) return;
                    setEnterprisesMode(modeFor('enterprises', info, reader));
                    const decisions = modeFor('decisions', info, reader);
                    setDecisionsMode(decisions);
                    setVotes(decisions === 'live');
                });
            })
            .catch(() => { /* Not answered: keep what the page shows; the node refuses a vote itself. */ });
        return () => { cancelled = true; };
    }, []);
    const activeSection = !votes && pickedSection === 'decide' ? 'groups' : pickedSection;
    const [activeDecideView, setActiveDecideView] = useState<'open' | 'history'>('open');
    const [decisions, setDecisions] = useState<DecisionWithTally[]>([]);
    // The signer's voice credits for votes on community money — the number the node checks (answer H).
    const [myPoolVoting, setMyPoolVoting] = useState<MyPoolVoting | null>(null);
    const [nodeSaysCanPropose, setNodeSaysCanPropose] = useState<boolean | null>(null);
    const [commonsBalance, setCommonsBalance] = useState<number>(0);
    const [showProposeDecision, setShowProposeDecision] = useState<boolean>(false);
    const [allMembersList, setAllMembersList] = useState<Array<{ publicKey: string; callsign?: string; balance?: number }>>([]);
    // The directory (only the Decision form's name preview uses it) is read whole only where the node has said it reads
    // whole: never with members on demand, the worldwide community (lib/members-on-demand; review of #1861, N1).
    const membersOnDemand = useMembersOnDemand();
    const membersOnDemandRef = useRef<boolean | null>(null);
    membersOnDemandRef.current = membersOnDemand;

    // Groups State
    const [groups, setGroups] = useState<Group[]>([]);
    const [loadingGroups, setLoadingGroups] = useState(false);
    const [groupCategoryFilter, setGroupCategoryFilter] = useState<string>('all');
    const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
    const [selectedGroupForDetail, setSelectedGroupForDetail] = useState<Group | null>(null);

    // The kind chips: projects and enterprises hold Beans; chat groups (and My groups) are the rest.
    const filter: 'all' | 'ongoing' | 'bounded' = groupCategoryFilter === 'projects' ? 'bounded' : groupCategoryFilter === 'enterprises' ? 'ongoing' : 'all';
    const showEnterprises = groupCategoryFilter === 'all' || groupCategoryFilter === 'projects' || groupCategoryFilter === 'enterprises';
    const showChatGroups = groupCategoryFilter === 'all' || groupCategoryFilter === 'chat' || groupCategoryFilter === 'my_groups';

    // Propose / New Enterprise modal
    const [showNewModal, setShowNewModal] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [newLifecycle, setNewLifecycle] = useState<'ongoing' | 'bounded'>('bounded');
    const [newGoal, setNewGoal] = useState<number | ''>('');
    const [newDeadline, setNewDeadline] = useState('');
    const [newPhotos, setNewPhotos] = useState<string[]>([]);
    // A picked photo is being resized; the form waits for it (handlePhotoUpload). Only the latest pick counts.
    const [preparingPhoto, setPreparingPhoto] = useState(false);
    const photoPick = useRef(0);
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    // Keyboard accessibility: Escape closes modal
    useEffect(() => {
        if (!showNewModal) return;
        const handleKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                setShowNewModal(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [showNewModal]);

    const fetchEnterprises = async () => {
        try {
            setLoading(true);
            setError(null);
            const [tresData, decData, commonsData, membersData] = await Promise.all([
                getTreasuries ? getTreasuries().catch(() => ({ treasuries: [] })) : { treasuries: [] },
                getDecisions ? getDecisions().catch(() => ({ decisions: [], myPoolVoting: null })) : { decisions: [], myPoolVoting: null },
                getCommonsBalance ? getCommonsBalance().catch(() => ({ balance: 0 })) : { balance: 0 },
                // null, not [], when the directory couldn't be read (the node busy with heavy lists answers 503): the
                // members list below keeps who it had, and the next fetch reads them again.
                // Read only once the node has said it reads whole (the effect below reads them when it says so).
                membersOnDemandRef.current !== false ? null : getAllMembers ? getAllMembers().catch(() => null) : null,
            ]);
            setTreasuries(tresData.treasuries || []);
            setDecisions(decData.decisions || []);
            setMyPoolVoting(decData.myPoolVoting ?? null);
            setNodeSaysCanPropose((decData as { canPropose?: boolean | null }).canPropose ?? null);
            setCommonsBalance(commonsData.balance || 0);
            if (Array.isArray(membersData)) {
                setAllMembersList((membersData as MemberSummary[]).map((m: MemberSummary) => ({ publicKey: m.publicKey, callsign: m.callsign, balance: (m as any).balance ?? 0 })));
            }
        } catch (err: any) {
            setError(err.message || 'Failed to fetch community enterprises');
        } finally {
            setLoading(false);
        }
    };

    // The node's rule (earned standing, or a node admin); earned credit only until the list has loaded.
    const canProposeDecision = nodeSaysCanPropose ?? (balanceInfo?.earnedCredit || 0) > 0;
    const hasOpenDecision = useMemo(() => {
        if (!identity?.publicKey) return false;
        return decisions.some(d => d.authorPubkey === identity.publicKey && d.status === 'open');
    }, [decisions, identity]);
    const openDecisionsCount = useMemo(() => {
        return decisions.filter(d => d.status === 'open').length;
    }, [decisions]);

    useEffect(() => {
        fetchEnterprises();
    }, [identity?.publicKey]);

    // The node has just said it reads whole: the list the fetch at open couldn't read yet, read once.
    useEffect(() => {
        if (membersOnDemand !== false) return;
        // Asked inside the promise, so a read that throws before it starts waits for the next fetch too.
        Promise.resolve().then(() => getAllMembers()).then((membersData) => {
            if (Array.isArray(membersData)) setAllMembersList(membersData.map((m: MemberSummary) => ({ publicKey: m.publicKey, callsign: m.callsign, balance: (m as any).balance ?? 0 })));
        }).catch(() => { /* the next fetch reads them again */ });
    }, [membersOnDemand]);

    // The viewer's balance (only earnedCredit, for proposing a Decision) is a member's alone. App learns
    // membership after mount, so this waits for it and a guest never asks the node.
    useEffect(() => {
        if (!canLoadBalance || !identity || !getBalance) {
            if (isMember === false) setBalanceInfo(null);
            return;
        }
        let cancelled = false;
        getBalance(identity.publicKey).then(b => { if (!cancelled) setBalanceInfo(b); }).catch(() => {});
        return () => { cancelled = true; };
    }, [identity?.publicKey, canLoadBalance]);

    const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;

        Array.from(files).forEach((file) => {
            if (!file.type.startsWith('image/')) return;
            // Through the marketplace's canvas resize, never the raw file: 800px at most, and the camera's
            // GPS and serial number stay on the device (G9a-3). The resize can take a second or two on an old
            // phone, and the photo is the last field before the button, so the form waits for it: sent sooner,
            // the enterprise would be created without the photo the member chose.
            const pick = ++photoPick.current;
            setPreparingPhoto(true);
            resizePhotoFile(file)
                .then((resized) => {
                    if (pick !== photoPick.current) return;
                    setNewPhotos([resized]); // Single avatar
                    setCreateError((shown) => (shown === PHOTO_READ_ERROR ? null : shown));
                })
                .catch((err) => {
                    console.warn('[ProjectsPage] Could not read the picked photo:', err);
                    if (pick === photoPick.current) setCreateError(PHOTO_READ_ERROR);
                })
                .finally(() => {
                    if (pick === photoPick.current) setPreparingPhoto(false);
                });
        });
        e.target.value = '';
    };

    const submitNewEnterprise = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!identity || creating || preparingPhoto) return;
        if (!newTitle.trim()) {
            setCreateError('Title is required');
            return;
        }
        if (!newDescription.trim()) {
            setCreateError('Purpose statement is required (docs/the-commons.md §2.1)');
            return;
        }
        if (newLifecycle === 'bounded' && (!newGoal || Number(newGoal) <= 0)) {
            setCreateError('A project needs a goal in Beans');
            return;
        }

        let deadlineAt = null;
        if (newLifecycle === 'bounded' && newDeadline) {
            deadlineAt = new Date(newDeadline).toISOString();
        }

        setCreating(true);
        setCreateError(null);
        try {
            await createEnterprise({
                name: newTitle.trim(),
                purpose: newDescription.trim(),
                description: newDescription.trim(),
                lifecycle: newLifecycle,
                goalAmount: newLifecycle === 'bounded' ? Number(newGoal) : null,
                deadlineAt,
                photos: newPhotos,
                avatar: newPhotos.length > 0 ? newPhotos[0] : undefined,
            });
            setShowNewModal(false);
            setNewTitle('');
            setNewDescription('');
            setNewGoal('');
            setNewDeadline('');
            setNewPhotos([]);
            await fetchEnterprises();
        } catch (err: any) {
            setCreateError(err.message || 'Failed to propose enterprise');
        } finally {
            setCreating(false);
        }
    };

    const fetchGroups = useCallback(async () => {
        setLoadingGroups(true);
        try {
            const list = await getGroups();
            setGroups(Array.isArray(list) ? list : []);
        } catch (e) {
            console.warn('[ProjectsPage] Failed to fetch groups:', e);
        } finally {
            setLoadingGroups(false);
        }
    }, []);

    useEffect(() => {
        if (activeSection === 'groups') {
            fetchGroups();
        }
    }, [activeSection, fetchGroups]);

    const filteredGroups = useMemo(() => {
        if (groupCategoryFilter === 'my_groups') {
            return groups.filter(g => g.viewerStatus === 'active' || g.viewerRole || g.viewerStatus === 'pending_approval');
        }
        return groups;
    }, [groups, groupCategoryFilter]);

    const energySentence = (energyBalance: number): string => {
        const beans = Math.round(Math.abs(energyBalance) * 100) / 100;
        if (beans === 0) return 'Square — nothing owed either way';
        return energyBalance > 0
            ? `We owe them ${beans} bean${beans === 1 ? '' : 's'} of work`
            : `They owe us ${beans} bean${beans === 1 ? '' : 's'} of work`;
    };

    const getDaysRemaining = (deadline: string | null | undefined) => {
        if (!deadline) return null;
        const diff = new Date(deadline).getTime() - new Date().getTime();
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        if (days < 0) return 'Expired';
        if (days === 0) return 'Ends today';
        return `${days} days left`;
    };

    const filteredEnterprises = useMemo(() => {
        let list = [...treasuries];
        if (filter === 'ongoing') {
            list = list.filter(t => t.lifecycle !== 'bounded' && (!t.goalAmount || t.goalAmount <= 0));
        } else if (filter === 'bounded') {
            list = list.filter(t => t.lifecycle === 'bounded' || (t.goalAmount != null && t.goalAmount > 0));
        }
        return list;
    }, [treasuries, filter]);

    return (
        <div className="flex flex-col h-full relative" style={{ overflowY: 'auto', overflowX: 'hidden', paddingBottom: 'var(--bottom-nav-offset)' }}>
            {/* Header — scrolls away with the list. Only the section switcher below stays pinned:
                on a 640px-tall phone at 1.3x text, a fully sticky header left ~29px for the list. */}
            <header className="bg-nature-900 px-4 pt-4 pb-3 flex flex-col gap-3">
                <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full flex justify-between items-center">
                    <div>
                        <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                            <span>🌱</span> The Commons
                        </h1>
                        <p className="text-nature-400 text-sm mt-0.5">Community decisions, the Commons, and your groups: projects, enterprises and more</p>
                    </div>
                    {identity && (
                        <button
                            onClick={() => {
                                if (activeSection === 'decide') {
                                    if (!canProposeDecision) {
                                        alert('You can propose a Decision once you have completed a trade.');
                                        return;
                                    }
                                    if (hasOpenDecision) {
                                        alert('You already have an open decision (limit 1 open decision per author).');
                                        return;
                                    }
                                    setShowProposeDecision(true);
                                } else if (activeSection === 'groups') {
                                    setShowCreateGroupModal(true);
                                } else {
                                    setShowNewModal(true);
                                    setCreateError(null);
                                }
                            }}
                            className="bg-bp-accent-fill hover:bg-bp-accent-hover text-bp-accent-on px-4 py-2 rounded-xl font-bold text-sm shadow-md transition-all active:scale-95"
                        >
                            {activeSection === 'groups' ? '+ Create Group' : '+ Propose'}
                        </button>
                    )}
                </div>

                {/* Enterprises or Decisions off here and the node shows previews: Example Valley's, under the strip; Groups below stay real. */}
                {(enterprisesMode === 'preview' || decisionsMode === 'preview') && (
                    <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full bg-white dark:bg-nature-900 rounded-2xl p-3">
                        <CommonsPreview enterprises={enterprisesMode === 'preview'} decisions={decisionsMode === 'preview'} onNearYou={onNavigate ? () => onNavigate('home') : undefined} onGuide={onNavigate ? (slug) => onNavigate('guide', slug) : undefined} />
                    </div>
                )}
                {/* Commons Pool & Available Governance Credits */}
                {enterprisesMode !== 'preview' && (<>
                <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full grid grid-cols-2 gap-3 pt-1">
                    <div className="bg-nature-950/70 border border-nature-800 rounded-xl p-3">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-nature-400">
                            Commons Pool
                        </div>
                        <div className="text-base sm:text-lg font-black text-white mt-1 truncate">
                            {balanceInfo ? Number(balanceInfo.commonsBalance ?? balanceInfo.commons ?? 0).toFixed(2) : '0.00'} 🫘
                        </div>
                    </div>
                    <div className="bg-nature-950/70 border border-nature-800 rounded-xl p-3" data-testid="voice-credits-card">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-nature-400">
                            Voice credits for money votes
                        </div>
                        <div className="text-base sm:text-lg font-black text-white mt-1 truncate">
                            {Math.floor(myPoolVoting?.voiceCredits ?? 0)}
                        </div>
                        <div className="text-[10px] text-nature-400 mt-0.5 leading-snug">
                            {myPoolVoting && !myPoolVoting.hasCompletedTrade
                                ? 'Opens after your first completed trade'
                                : 'From completed trades · N votes cost N×N'}
                        </div>
                    </div>
                </div>
                </>)}
            </header>

            {/* Section Switcher: Decide vs Groups — the one sticky row */}
            <div className="sticky top-0 z-40 bg-nature-900 px-4 py-2" data-testid="commons-section-tabs">
                {/* Emoji over label below `sm`: side by side, the three tabs need ~400px and pushed
                    Groups off a 320px screen at 1.3x text. */}
                <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full flex bg-nature-950 p-1 rounded-xl border border-nature-800">
                    {([
                        { key: 'decide', emoji: '🗳️', label: 'Decide' },
                        { key: 'groups', emoji: '👥', label: 'Groups' },
                    ] as const).filter(tab => votes || tab.key !== 'decide').map(tab => (
                        <button
                            key={tab.key}
                            onClick={() => setActiveSection(tab.key)}
                            className={`flex-1 min-w-0 py-1.5 px-1 sm:py-2 sm:px-3 rounded-lg text-xs sm:text-sm font-bold flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-2 transition-colors ${
                                activeSection === tab.key
                                    ? 'bg-nature-800 text-white shadow-sm'
                                    : 'text-nature-400 hover:text-white'
                            }`}
                        >
                            <span className="flex items-center gap-1">
                                <span>{tab.emoji}</span>
                                {tab.key === 'decide' && openDecisionsCount > 0 && (
                                    <span className="bg-bp-accent-fill text-bp-accent-on text-xs px-1.5 sm:px-2 py-0.5 rounded-full font-bold leading-none">
                                        {openDecisionsCount}
                                    </span>
                                )}
                            </span>
                            <span className="leading-tight">{tab.label}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Filters scroll away with the content */}
            <div className="bg-nature-900 border-b border-nature-800 px-4 pb-3 shadow-sm empty:hidden" data-testid="commons-filters">
                {/* Filter Controls: Groups Category */}
                {activeSection === 'groups' && (
                    <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full flex items-center justify-between gap-2 pt-1">
                        <div className="min-w-0 flex gap-2 overflow-x-auto py-1 scrollbar-none" data-testid="group-filter-chips">
                            {[
                                { key: 'all', label: 'All' },
                                { key: 'my_groups', label: 'My groups' },
                                { key: 'projects', label: '🌱 Projects' },
                                { key: 'enterprises', label: '🏛️ Enterprises' },
                                { key: 'chat', label: '👥 Chat groups' },
                            ].map(option => (
                                <button
                                    key={option.key}
                                    onClick={() => setGroupCategoryFilter(option.key)}
                                    className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${
                                        groupCategoryFilter === option.key
                                            ? 'bg-bp-commit-fill text-bp-commit-on shadow-sm'
                                            : 'bg-nature-800 text-nature-300 hover:bg-nature-700'
                                    }`}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {activeSection === 'decide' ? (
                <div className="p-4 max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full">
                    <DecideSection
                        decisions={decisions}
                        myPoolVoting={myPoolVoting}
                        identity={identity}
                        commonsBalance={commonsBalance}
                        onRefresh={fetchEnterprises}
                        onOpenPropose={() => {
                            if (!canProposeDecision) {
                                alert('You can propose a Decision once you have completed a trade.');
                                return;
                            }
                            if (hasOpenDecision) {
                                alert('You already have an open decision (limit 1 open decision per author).');
                                return;
                            }
                            setShowProposeDecision(true);
                        }}
                        canPropose={canProposeDecision}
                        hasOpenDecision={hasOpenDecision}
                        activeView={activeDecideView}
                        onChangeView={setActiveDecideView}
                    />
                </div>
            ) : (
                <>
                <div className="px-4 pt-4 max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full">
                    <div className="p-3 bg-nature-950/60 border border-nature-800 rounded-xl text-xs text-nature-300 leading-relaxed">
                        👥 <strong>Groups:</strong> A group is a place for some people rather than everyone. Projects and enterprises hold Beans; chat groups hold none. Being in a group does not change your trust or your vote.
                    </div>
                </div>
                {showChatGroups && (
                <div className="p-4 max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full space-y-4" data-testid="commons-chat-groups">

                    {loadingGroups ? (
                        <div className="py-12 text-center text-sm text-nature-400">Loading groups...</div>
                    ) : filteredGroups.length === 0 ? (
                        <div className="text-center py-16 px-4 bg-nature-950/40 rounded-2xl border border-nature-800/80">
                            <div className="text-4xl mb-3">👥</div>
                            <h3 className="text-base font-bold text-white mb-1">No groups found</h3>
                            <p className="text-xs text-nature-400 max-w-xs mx-auto mb-4">
                                {groupCategoryFilter === 'my_groups'
                                    ? 'You have not joined any groups yet.'
                                    : 'Start a working group, guild, or team to coordinate discussions.'}
                            </p>
                            <button
                                onClick={() => setShowCreateGroupModal(true)}
                                className="px-4 py-2 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-xs font-bold transition-colors"
                            >
                                + Create a Group
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {filteredGroups.map(g => (
                                <div
                                    key={g.id}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`View details for group ${g.name}`}
                                    onClick={() => setSelectedGroupForDetail(g)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            setSelectedGroupForDetail(g);
                                        }
                                    }}
                                    className="p-4 bg-nature-950/70 hover:bg-nature-900/80 border border-nature-800 hover:border-nature-700 rounded-2xl cursor-pointer transition-all space-y-3 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <h4 className="font-extrabold text-base text-white truncate">{g.name}</h4>
                                            <div className="flex items-center gap-2 mt-1">
                                                <span className="text-[11px] font-bold text-nature-400 capitalize">
                                                    🏷️ {g.category.replace(/_/g, ' ')}
                                                </span>
                                                <span className="text-nature-600 dark:text-nature-400">•</span>
                                                <span className="text-[11px] text-nature-400">
                                                    {g.memberCount || 0} {g.memberCount === 1 ? 'member' : 'members'}
                                                </span>
                                            </div>
                                        </div>
                                        {g.viewerRole ? (
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                                                g.viewerRole === 'convenor'
                                                    ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-700/60'
                                                    : 'bg-nature-800 text-nature-300'
                                            }`}>
                                                {g.viewerRole}
                                            </span>
                                        ) : g.viewerStatus === 'pending_approval' ? (
                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-amber-950/60 text-amber-300 border border-amber-700/60">
                                                Pending
                                            </span>
                                        ) : null}
                                    </div>

                                    {g.description && (
                                        <p className="text-xs text-nature-300 line-clamp-2 leading-relaxed">
                                            {g.description}
                                        </p>
                                    )}

                                    <div className="flex items-center justify-between pt-1 border-t border-nature-900 text-[11px] text-nature-500 dark:text-nature-400">
                                        <span>Join: {g.joinPolicy.replace(/_/g, ' ')}</span>
                                        <span className="text-emerald-500 font-bold hover:underline">View Details →</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                )}
                {!showEnterprises ? null : loading ? (
                <div className="p-8 text-center text-nature-500">Loading enterprises…</div>
                ) : error ? (
                    <div className="p-8 text-center text-red-500">{error}</div>
                ) : filteredEnterprises.length === 0 ? (
                    <div className="p-8 text-center text-nature-500 max-w-md mx-auto my-12">
                        <p className="text-4xl opacity-50 mb-3">🌱</p>
                        <p className="text-base font-bold text-white mb-1">No enterprises found</p>
                        <p className="text-sm text-nature-400 mb-6">
                            Got an idea that benefits the community? Start an enterprise or propose a project to get started.
                        </p>
                        {identity && (
                            <button
                                onClick={() => {
                                    setShowNewModal(true);
                                    setCreateError(null);
                                }}
                                className="bg-bp-accent-fill hover:bg-bp-accent-hover text-bp-accent-on px-5 py-2.5 rounded-xl font-bold text-sm shadow-md"
                            >
                                + Propose a Project
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="p-4 max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {filteredEnterprises.map(t => {
                            const hasGoal = t.goalAmount != null && t.goalAmount > 0;
                            const currentRaised = t.currentAmount != null ? t.currentAmount : Math.max(0, t.balance);
                            const goal = t.goalAmount || 1;
                            const progress = Math.min(100, (currentRaised / goal) * 100);
                            const isFunded = hasGoal && (currentRaised >= goal || t.status === 'funded' || t.status === 'completed');
                            const daysRemaining = getDaysRemaining(t.deadlineAt);
                            const resolvedAvatar = resolveAvatarUrl(t.avatar || t.avatarUrl);
                            const avatarSrc = resolvedAvatar && !failedAvatars.has(resolvedAvatar) ? resolvedAvatar : null;

                            return (
                            <div
                                key={t.publicKey}
                                role="button"
                                tabIndex={0}
                                onClick={() => onOpenTreasury?.(t.publicKey)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        onOpenTreasury?.(t.publicKey);
                                    }
                                }}
                                className="bg-nature-900 border border-nature-800 hover:border-emerald-500/50 focus:outline-none focus:ring-2 focus:ring-emerald-500 rounded-2xl p-5 transition-all cursor-pointer shadow-sm hover:shadow-md flex flex-col justify-between group"
                            >
                                <div className="space-y-3">
                                    {/* Top row: Avatar + Name + Lifecycle Tag */}
                                    <div className="flex items-start gap-3">
                                        <div className="w-12 h-12 rounded-xl bg-nature-800 border border-nature-700 flex items-center justify-center overflow-hidden shrink-0 text-xl font-bold text-emerald-400">
                                            {avatarSrc ? (
                                                <img
                                                    src={avatarSrc}
                                                    alt={t.name}
                                                    onError={() => setFailedAvatars(prev => new Set(prev).add(avatarSrc))}
                                                    className="w-full h-full object-cover"
                                                />
                                            ) : (
                                                <span>🌱</span>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <h3 className="font-bold text-base text-white group-hover:text-emerald-400 transition-colors truncate">
                                                    {t.name}
                                                </h3>
                                                {t.paused && t.status !== 'winding_up' && t.status !== 'completed' && (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-500/20 text-amber-400 border-amber-500/40">
                                                        ⏸️ Paused
                                                    </span>
                                                )}
                                                {t.status === 'winding_up' && (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-rose-500/20 text-rose-400 border-rose-500/40">
                                                        ⏳ Winding up
                                                    </span>
                                                )}
                                                {t.status === 'completed' && (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-stone-700 text-stone-300 border-stone-600">
                                                        Closed
                                                    </span>
                                                )}
                                                {isFunded ? (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-950/50 text-emerald-300 border-emerald-800/60">
                                                        🎉 Funded
                                                    </span>
                                                ) : hasGoal || t.lifecycle === 'bounded' ? (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-950/50 text-amber-300 border-amber-800/60">
                                                        🌱 Project
                                                    </span>
                                                ) : (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-blue-950/50 text-blue-300 border-blue-800/60">
                                                        🏛️ Enterprise
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-nature-400 mt-0.5">
                                                {t.callsign ? `@${t.callsign} · ` : ''}
                                                {t.status === 'completed'
                                                    ? 'Completed · Closed'
                                                    : t.status === 'winding_up'
                                                        ? 'Winding up'
                                                        : t.paused
                                                            ? 'Paused for season'
                                                            : `${t.liveOffers ?? 0} live offer${(t.liveOffers ?? 0) === 1 ? '' : 's'}`}
                                                {t.keepers && t.keepers.length > 0 ? ` · ${t.keepers.length} keeper${t.keepers.length === 1 ? '' : 's'}` : ''}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Purpose statement (docs/the-commons.md §2.1) */}
                                    <p className="text-xs text-nature-300 line-clamp-2 leading-relaxed">
                                        {t.purpose || t.description || 'Community enterprise'}
                                    </p>

                                    {/* Energy Balance sentence (docs/the-commons.md §2.2) */}
                                    {t.balance != null && (
                                        <p className="text-[11px] text-nature-400 italic">
                                            {energySentence(t.balance)}
                                        </p>
                                    )}

                                    {/* Financial Ceiling indicator if surplus exists */}
                                    {t.earnedSurplus != null && t.earnedSurplus > 0 && (
                                        <div className="flex items-center gap-1 text-[11px] text-emerald-400">
                                            <span>📈</span>
                                            <span>Earned Surplus: {t.earnedSurplus} 🫘</span>
                                        </div>
                                    )}
                                </div>

                                <div className="mt-4 pt-3 border-t border-nature-800 space-y-2">
                                    {/* Balance Row */}
                                    <div className="flex justify-between items-center text-xs">
                                        <div>
                                            <div className="text-[10px] font-bold uppercase tracking-wider text-nature-400">
                                                Balance
                                            </div>
                                            {t.balance < 0 && (
                                                <div className="text-[11px] font-bold text-amber-400">
                                                    in deficit (keepers eat last)
                                                </div>
                                            )}
                                        </div>
                                        <div className={`font-black text-sm ${t.balance < 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                            {t.balance} 🫘
                                        </div>
                                    </div>

                                    {/* Funding progress if Bounded Project */}
                                    {hasGoal && (
                                        <div className="space-y-1.5 pt-1">
                                            <div className="flex justify-between items-end text-xs">
                                                <span className={`font-bold ${isFunded ? 'text-emerald-400' : 'text-white'}`}>
                                                    {currentRaised} 🫘 <span className="font-normal text-nature-400">raised of {t.goalAmount} 🫘</span>
                                                </span>
                                                {daysRemaining && (
                                                    <span className={`text-[11px] font-bold ${daysRemaining === 'Expired' ? 'text-red-400' : 'text-nature-400'}`}>
                                                        ⏳ {daysRemaining}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="w-full bg-nature-800 h-2 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full transition-all ${isFunded ? 'bg-emerald-500' : 'bg-emerald-600'}`}
                                                    style={{ width: `${progress}%` }}
                                                />
                                            </div>

                                            {/* Primary CTA if has goal, not funded, and the enterprise still takes pledges */}
                                            {!isFunded && !pledgeClosedLine(t.status) && (
                                                <div
                                                    aria-hidden="true"
                                                    className="w-full mt-2 py-2 px-3 rounded-xl bg-bp-commit-fill text-bp-commit-on font-bold text-xs shadow-sm flex items-center justify-center gap-1.5 pointer-events-none"
                                                >
                                                    <span>🌱</span> Pledge Beans
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
                )}
                </>
            )}

            {/* Propose Enterprise / Project Modal */}
            {showNewModal && (
                <div
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                    onClick={() => setShowNewModal(false)}
                    style={{ overflowY: 'auto', paddingBottom: 'calc(var(--bottom-nav-offset) + 2rem)' }}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="propose-modal-title"
                        onClick={(e) => e.stopPropagation()}
                        className="bg-nature-900 border border-nature-800 rounded-2xl p-6 w-full max-w-lg shadow-xl space-y-4 animate-in zoom-in-95 duration-200 text-white max-h-[90vh] overflow-y-auto"
                        style={{ paddingBottom: 'calc(var(--bottom-nav-offset) + 1.5rem)' }}
                    >
                        <div className="flex justify-between items-center">
                            <h2 id="propose-modal-title" className="text-lg font-black text-white">
                                Propose an Enterprise / Project
                            </h2>
                            <button
                                type="button"
                                aria-label="Close dialog"
                                onClick={() => setShowNewModal(false)}
                                className="text-nature-400 hover:text-white text-lg font-bold min-w-[44px] min-h-[44px] flex items-center justify-center -mr-2"
                            >
                                ✕
                            </button>
                        </div>

                        {createError && (
                            <div className="p-3 bg-red-950/40 border border-red-800 text-red-300 rounded-xl text-xs font-semibold">
                                {createError}
                            </div>
                        )}

                        <form onSubmit={submitNewEnterprise} className="space-y-4">
                            {/* Lifecycle choice: Bounded Project vs Ongoing Enterprise */}
                            <div>
                                <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-2">
                                    Initiative Type
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setNewLifecycle('bounded')}
                                        className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all text-left flex flex-col gap-0.5 ${
                                            newLifecycle === 'bounded'
                                                ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
                                                : 'bg-nature-800/60 border-nature-700 text-nature-400 hover:text-white'
                                        }`}
                                    >
                                        <span>🌱 Project</span>
                                        <span className="text-[10px] font-normal opacity-80">A leader, a goal, an end date</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setNewLifecycle('ongoing')}
                                        className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all text-left flex flex-col gap-0.5 ${
                                            newLifecycle === 'ongoing'
                                                ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
                                                : 'bg-nature-800/60 border-nature-700 text-nature-400 hover:text-white'
                                        }`}
                                    >
                                        <span>🏛️ Enterprise</span>
                                        <span className="text-[10px] font-normal opacity-80">Keepers; it keeps going</span>
                                    </button>
                                </div>
                            </div>

                            {/* Title */}
                            <div>
                                <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-1">
                                    Name / Title
                                </label>
                                <input
                                    type="text"
                                    required
                                    placeholder="e.g. Community Tool Shed or Shade House"
                                    value={newTitle}
                                    onChange={(e) => setNewTitle(e.target.value)}
                                    className="w-full bg-nature-800 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                            </div>

                            {/* Purpose Statement (required per docs §2.1) */}
                            <div>
                                <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-1">
                                    Purpose Statement <span className="text-emerald-400">*</span>
                                </label>
                                <textarea
                                    required
                                    rows={3}
                                    placeholder="State clearly what this enterprise exists to do (e.g. 'We build and maintain a communal shade house by November')"
                                    value={newDescription}
                                    onChange={(e) => setNewDescription(e.target.value)}
                                    className="w-full bg-nature-800 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                            </div>

                            {/* Bounded Project Fields: Goal & Deadline */}
                            {newLifecycle === 'bounded' && (
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-1">
                                            Goal Amount (🫘 Beans)
                                        </label>
                                        <input
                                            type="number"
                                            required
                                            min="1"
                                            step="1"
                                            placeholder="e.g. 500"
                                            value={newGoal}
                                            onChange={(e) => setNewGoal(e.target.value === '' ? '' : Number(e.target.value))}
                                            className="w-full bg-nature-800 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-1">
                                            Deadline (Optional)
                                        </label>
                                        <input
                                            type="date"
                                            min={localToday()}
                                            value={newDeadline}
                                            onChange={(e) => setNewDeadline(e.target.value)}
                                            className="w-full bg-nature-800 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Photo / Avatar upload */}
                            <div>
                                <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-1">
                                    Cover Photo / Avatar (Optional)
                                </label>
                                <input
                                    type="file"
                                    accept="image/*"
                                    onChange={handlePhotoUpload}
                                    className="text-xs text-nature-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-nature-800 file:text-nature-200 hover:file:bg-nature-700 cursor-pointer"
                                />
                                {newPhotos.length > 0 && (
                                    <div className="mt-2 flex items-center gap-2">
                                        <img src={newPhotos[0]} alt="Preview" className="w-12 h-12 rounded-xl object-cover border border-nature-700" />
                                        <button
                                            type="button"
                                            onClick={() => setNewPhotos([])}
                                            className="text-xs text-red-400 hover:underline"
                                        >
                                            Remove photo
                                        </button>
                                    </div>
                                )}
                            </div>

                            <div className="flex gap-3 pt-3">
                                <button
                                    type="button"
                                    onClick={() => setShowNewModal(false)}
                                    className="flex-1 py-2.5 rounded-xl border border-nature-700 text-nature-300 font-bold text-sm hover:bg-nature-800"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={creating || preparingPhoto}
                                    className="flex-1 py-2.5 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-sm disabled:opacity-50"
                                >
                                    {creating ? 'Submitting…' : preparingPhoto ? 'Preparing photo…' : 'Propose Enterprise 🌱'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {votes && (
                <ProposeDecisionModal
                    isOpen={showProposeDecision}
                    onClose={() => setShowProposeDecision(false)}
                    onCreated={fetchEnterprises}
                    identity={identity}
                    commonsBalance={commonsBalance}
                    treasuries={treasuries}
                    members={allMembersList}
                />
            )}

            <CreateGroupModal
                isOpen={showCreateGroupModal}
                onClose={() => setShowCreateGroupModal(false)}
                onCreated={() => fetchGroups()}
                onStartWithBeans={!beansOn ? undefined : (lifecycle) => {
                    setShowCreateGroupModal(false);
                    setNewLifecycle(lifecycle);
                    setShowNewModal(true);
                    setCreateError(null);
                }}
            />

            <GroupDetailModal
                group={selectedGroupForDetail}
                isOpen={!!selectedGroupForDetail}
                onClose={() => setSelectedGroupForDetail(null)}
                myPubkey={identity?.publicKey}
                onMembershipChanged={() => fetchGroups()}
                onPostToGroup={(group) => {
                    setSelectedGroupForDetail(null);
                    onNavigate?.('map-post', group.id);
                }}
            />
        </div>
    );
}
