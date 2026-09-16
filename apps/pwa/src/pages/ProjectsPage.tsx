import { useState, useEffect, useMemo, useCallback } from 'react';
import {
    getTreasuries, getBalance, type Treasury, type BalanceInfo,
    createEnterprise,
    getDecisions, type DecisionWithTally,
    getCommonsBalance,
    getAllMembers, type MemberSummary,
    getGroups, type Group,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';
import { DecideSection } from '../components/DecideSection';
import { ProposeDecisionModal } from '../components/ProposeDecisionModal';
import { CreateGroupModal } from '../components/CreateGroupModal';
import { GroupDetailModal } from '../components/GroupDetailModal';

interface Props {
    identity: BeanPoolIdentity | null;
    onOpenTreasury?: (publicKey: string) => void;
    initialSection?: 'decide' | 'enterprises' | 'groups';
    onNavigate?: (tab: string, contextId?: string) => void;
}

export function ProjectsPage({ identity, onOpenTreasury, initialSection = 'enterprises', onNavigate }: Props) {
    const [treasuries, setTreasuries] = useState<Treasury[]>([]);
    const [balanceInfo, setBalanceInfo] = useState<BalanceInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // UI States
    const [activeSection, setActiveSection] = useState<'decide' | 'enterprises' | 'groups'>(initialSection);
    const [activeDecideView, setActiveDecideView] = useState<'open' | 'history'>('open');
    const [decisions, setDecisions] = useState<DecisionWithTally[]>([]);
    const [activeMembers30d, setActiveMembers30d] = useState<number>(0);
    const [commonsBalance, setCommonsBalance] = useState<number>(0);
    const [showProposeDecision, setShowProposeDecision] = useState<boolean>(false);
    const [allMembersList, setAllMembersList] = useState<Array<{ publicKey: string; callsign?: string; balance?: number }>>([]);

    // Groups State
    const [groups, setGroups] = useState<Group[]>([]);
    const [loadingGroups, setLoadingGroups] = useState(false);
    const [groupCategoryFilter, setGroupCategoryFilter] = useState<string>('all');
    const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
    const [selectedGroupForDetail, setSelectedGroupForDetail] = useState<Group | null>(null);

    // Filter: all | ongoing | bounded
    const [filter, setFilter] = useState<'all' | 'ongoing' | 'bounded'>('all');

    // Propose / New Enterprise modal
    const [showNewModal, setShowNewModal] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [newLifecycle, setNewLifecycle] = useState<'ongoing' | 'bounded'>('bounded');
    const [newGoal, setNewGoal] = useState<number | ''>('');
    const [newDeadline, setNewDeadline] = useState('');
    const [newPhotos, setNewPhotos] = useState<string[]>([]);
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
            const [tresData, decData, commonsData, membersData, balData] = await Promise.all([
                getTreasuries ? getTreasuries().catch(() => ({ treasuries: [] })) : { treasuries: [] },
                getDecisions ? getDecisions().catch(() => ({ decisions: [], activeMembers30d: 0 })) : { decisions: [], activeMembers30d: 0 },
                getCommonsBalance ? getCommonsBalance().catch(() => ({ balance: 0 })) : { balance: 0 },
                getAllMembers ? getAllMembers().catch(() => []) : [],
                identity?.publicKey && getBalance ? getBalance(identity.publicKey).catch(() => null) : null,
            ]);
            setTreasuries(tresData.treasuries || []);
            setDecisions(decData.decisions || []);
            setActiveMembers30d(decData.activeMembers30d || 0);
            setCommonsBalance(commonsData.balance || 0);
            if (balData) setBalanceInfo(balData);
            if (Array.isArray(membersData)) {
                setAllMembersList((membersData as MemberSummary[]).map((m: MemberSummary) => ({ publicKey: m.publicKey, callsign: m.callsign, balance: (m as any).balance ?? 0 })));
            }
        } catch (err: any) {
            setError(err.message || 'Failed to fetch community enterprises');
        } finally {
            setLoading(false);
        }
    };

    const canProposeDecision = (balanceInfo?.earnedCredit || 0) > 0;
    const hasOpenDecision = useMemo(() => {
        if (!identity?.publicKey) return false;
        return decisions.some(d => d.authorPubkey === identity.publicKey && d.status === 'open');
    }, [decisions, identity]);
    const openDecisionsCount = useMemo(() => {
        return decisions.filter(d => d.status === 'open').length;
    }, [decisions]);

    useEffect(() => {
        fetchEnterprises();
        if (identity?.publicKey && getBalance) {
            getBalance(identity.publicKey).then(setBalanceInfo).catch(() => {});
        }
    }, [identity?.publicKey]);

    const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;
        
        Array.from(files).forEach((file) => {
            if (!file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                const base64 = event.target?.result as string;
                if (base64) {
                    setNewPhotos([base64]); // Single avatar
                }
            };
            reader.readAsDataURL(file); 
        });
        e.target.value = '';
    };

    const submitNewEnterprise = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!identity || creating) return;
        if (!newTitle.trim()) {
            setCreateError('Title is required');
            return;
        }
        if (!newDescription.trim()) {
            setCreateError('Purpose statement is required (docs/the-commons.md §2.1)');
            return;
        }
        if (newLifecycle === 'bounded' && (!newGoal || Number(newGoal) <= 0)) {
            setCreateError('Goal amount must be a positive number for a bounded project');
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
        if (groupCategoryFilter === 'all') return groups;
        if (groupCategoryFilter === 'my_groups') {
            return groups.filter(g => g.viewerStatus === 'active' || g.viewerRole || g.viewerStatus === 'pending_approval');
        }
        return groups.filter(g => g.category === groupCategoryFilter);
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
        <div className="flex flex-col h-full bg-bg-primary relative" style={{ overflowY: 'auto', paddingBottom: 'var(--bottom-nav-offset)' }}>
            {/* Header */}
            <header className="sticky top-0 z-40 bg-nature-900 border-b border-nature-800 p-4 shadow-sm flex flex-col gap-3">
                <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full flex justify-between items-center">
                    <div>
                        <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                            <span>🌱</span> The Commons
                        </h1>
                        <p className="text-nature-400 text-sm mt-0.5">Community decisions, pooled circulation, and shared enterprises</p>
                    </div>
                    {identity && (
                        <button
                            onClick={() => {
                                if (activeSection === 'decide') {
                                    if (!canProposeDecision) {
                                        alert('Proposing a Decision requires earned trade standing (earnedCredit > 0).');
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
                            className="bg-accent hover:bg-emerald-500 text-white px-4 py-2 rounded-xl font-bold text-sm shadow-md transition-all active:scale-95"
                        >
                            {activeSection === 'groups' ? '+ Create Group' : '+ Propose'}
                        </button>
                    )}
                </div>

                {/* Commons Pool & Available Governance Credits */}
                <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full grid grid-cols-2 gap-3 pt-1">
                    <div className="bg-nature-950/70 border border-nature-800 rounded-xl p-3">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-nature-400">
                            Commons Pool
                        </div>
                        <div className="text-base sm:text-lg font-black text-white mt-1 truncate">
                            {balanceInfo ? Number(balanceInfo.commonsBalance ?? balanceInfo.commons ?? 0).toFixed(2) : '0.00'} 🫘
                        </div>
                    </div>
                    <div className="bg-nature-950/70 border border-nature-800 rounded-xl p-3">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-nature-400">
                            My Governance Credits
                        </div>
                        <div className="text-base sm:text-lg font-black text-white mt-1 truncate">
                            {balanceInfo?.earnedCredit ?? 0}
                        </div>
                    </div>
                </div>

                {/* Section Switcher: Decide vs Enterprises vs Groups */}
                <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full flex bg-nature-950 p-1 rounded-xl border border-nature-800">
                    <button
                        onClick={() => setActiveSection('decide')}
                        className={`flex-1 py-2 px-3 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-colors ${
                            activeSection === 'decide'
                                ? 'bg-nature-800 text-white shadow-sm'
                                : 'text-nature-400 hover:text-white'
                        }`}
                    >
                        <span>🗳️</span>
                        <span>Decide</span>
                        {openDecisionsCount > 0 && (
                            <span className="bg-accent text-white text-xs px-2 py-0.5 rounded-full font-bold">
                                {openDecisionsCount}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => setActiveSection('enterprises')}
                        className={`flex-1 py-2 px-3 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-colors ${
                            activeSection === 'enterprises'
                                ? 'bg-nature-800 text-white shadow-sm'
                                : 'text-nature-400 hover:text-white'
                        }`}
                    >
                        <span>🏛️</span>
                        <span>Enterprises</span>
                    </button>
                    <button
                        onClick={() => setActiveSection('groups')}
                        className={`flex-1 py-2 px-3 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-colors ${
                            activeSection === 'groups'
                                ? 'bg-nature-800 text-white shadow-sm'
                                : 'text-nature-400 hover:text-white'
                        }`}
                    >
                        <span>👥</span>
                        <span>Groups</span>
                    </button>
                </div>

                {/* Filter Controls: All / Ongoing / Bounded */}
                {activeSection === 'enterprises' && (
                    <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full flex gap-2 pt-1">
                        {(['all', 'ongoing', 'bounded'] as const).map(option => (
                            <button
                                key={option}
                                onClick={() => setFilter(option)}
                                className={`px-3 py-1 rounded-full text-xs font-bold transition-colors ${
                                    filter === option
                                        ? 'bg-emerald-600 text-white shadow-sm'
                                        : 'bg-nature-800 text-nature-300 hover:bg-nature-700'
                                }`}
                            >
                                {option === 'all' ? 'All Enterprises' : option === 'ongoing' ? 'Ongoing' : 'Bounded Projects'}
                            </button>
                        ))}
                    </div>
                )}

                {/* Filter Controls: Groups Category */}
                {activeSection === 'groups' && (
                    <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full flex items-center justify-between gap-2 pt-1">
                        <div className="flex gap-2 overflow-x-auto py-1 scrollbar-none">
                            {[
                                { key: 'all', label: 'All Groups' },
                                { key: 'my_groups', label: 'My Groups' },
                                { key: 'working_group', label: '🤝 Working Groups' },
                                { key: 'project', label: '🛠️ Projects' },
                                { key: 'guild', label: '🛡️ Guilds' },
                                { key: 'social', label: '☕ Social' },
                            ].map(option => (
                                <button
                                    key={option.key}
                                    onClick={() => setGroupCategoryFilter(option.key)}
                                    className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${
                                        groupCategoryFilter === option.key
                                            ? 'bg-emerald-600 text-white shadow-sm'
                                            : 'bg-nature-800 text-nature-300 hover:bg-nature-700'
                                    }`}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </header>

            {activeSection === 'decide' ? (
                <div className="p-4 max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full">
                    <DecideSection
                        decisions={decisions}
                        activeMembers30d={activeMembers30d}
                        identity={identity}
                        balanceInfo={balanceInfo}
                        commonsBalance={commonsBalance}
                        onRefresh={fetchEnterprises}
                        onOpenPropose={() => {
                            if (!canProposeDecision) {
                                alert('Proposing a Decision requires earned trade standing (earnedCredit > 0).');
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
            ) : activeSection === 'groups' ? (
                <div className="p-4 max-w-lg sm:max-w-2xl lg:max-w-4xl mx-auto w-full space-y-4">
                    <div className="p-3 bg-nature-950/60 border border-nature-800 rounded-xl text-xs text-nature-300 leading-relaxed">
                        👥 <strong>Groups & Teams:</strong> A group is a place to talk to some people rather than everyone. Groups do not hold beans and do not confer trust or voting standing.
                    </div>

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
                                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-colors"
                            >
                                + Create a Group
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {filteredGroups.map(g => (
                                <div
                                    key={g.id}
                                    onClick={() => setSelectedGroupForDetail(g)}
                                    className="p-4 bg-nature-950/70 hover:bg-nature-900/80 border border-nature-800 hover:border-nature-700 rounded-2xl cursor-pointer transition-all space-y-3"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <h4 className="font-extrabold text-base text-white truncate">{g.name}</h4>
                                            <div className="flex items-center gap-2 mt-1">
                                                <span className="text-[11px] font-bold text-nature-400 capitalize">
                                                    🏷️ {g.category.replace('_', ' ')}
                                                </span>
                                                <span className="text-nature-600">•</span>
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

                                    <div className="flex items-center justify-between pt-1 border-t border-nature-900 text-[11px] text-nature-500">
                                        <span>Join: {g.joinPolicy.replace(/_/g, ' ')}</span>
                                        <span className="text-emerald-500 font-bold hover:underline">View Details →</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ) : loading ? (
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
                                className="bg-accent hover:bg-emerald-500 text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-md"
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
                            const avatarSrc = resolveAvatarUrl(t.avatar || t.avatarUrl);

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
                                                <img src={avatarSrc} alt={t.name} className="w-full h-full object-cover" />
                                            ) : (
                                                <span>🌱</span>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <h3 className="font-bold text-base text-white group-hover:text-emerald-400 transition-colors truncate">
                                                    {t.name}
                                                </h3>
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
                                                        🏛️ Ongoing
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-nature-400 mt-0.5">
                                                {t.callsign ? `@${t.callsign} · ` : ''}
                                                {t.liveOffers ?? 0} live offer{(t.liveOffers ?? 0) === 1 ? '' : 's'}
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

                                            {/* Primary CTA if has goal and not funded */}
                                            {!isFunded && (
                                                <div
                                                    aria-hidden="true"
                                                    className="w-full mt-2 py-2 px-3 rounded-xl bg-emerald-600 text-white font-bold text-xs shadow-sm flex items-center justify-center gap-1.5 pointer-events-none"
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
                                        <span>⏱️ Bounded Project</span>
                                        <span className="text-[10px] font-normal opacity-80">Has funding goal & deadline</span>
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
                                        <span>🏛️ Ongoing Enterprise</span>
                                        <span className="text-[10px] font-normal opacity-80">Permanent co-op or facility</span>
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
                                    disabled={creating}
                                    className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm disabled:opacity-50"
                                >
                                    {creating ? 'Submitting…' : 'Propose Enterprise 🌱'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            <ProposeDecisionModal
                isOpen={showProposeDecision}
                onClose={() => setShowProposeDecision(false)}
                onCreated={fetchEnterprises}
                identity={identity}
                commonsBalance={commonsBalance}
                treasuries={treasuries}
                members={allMembersList}
            />

            <CreateGroupModal
                isOpen={showCreateGroupModal}
                onClose={() => setShowCreateGroupModal(false)}
                onCreated={() => fetchGroups()}
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
