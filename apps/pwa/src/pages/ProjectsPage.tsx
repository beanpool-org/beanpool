import { useState, useEffect, useMemo, useCallback } from 'react';
import {
    getTreasuries, getBalance, type Treasury, type BalanceInfo,
    createEnterprise
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';

interface Props {
    identity: BeanPoolIdentity | null;
    onOpenTreasury?: (publicKey: string) => void;
}

export function ProjectsPage({ identity, onOpenTreasury }: Props) {
    const [treasuries, setTreasuries] = useState<Treasury[]>([]);
    const [balanceInfo, setBalanceInfo] = useState<BalanceInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

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
            const data = await getTreasuries();
            setTreasuries(data.treasuries || []);
        } catch (err: any) {
            setError(err.message || 'Failed to fetch community enterprises');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchEnterprises();
        if (identity?.publicKey) {
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
                        <p className="text-nature-400 text-sm mt-0.5">Community enterprises, initiatives & projects</p>
                    </div>
                    {identity && (
                        <button
                            onClick={() => {
                                setShowNewModal(true);
                                setCreateError(null);
                            }}
                            className="bg-accent hover:bg-emerald-500 text-white px-4 py-2 rounded-xl font-bold text-sm shadow-md transition-all active:scale-95"
                        >
                            + Propose
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

                {/* Filter Controls: All / Ongoing / Bounded */}
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
            </header>

            {/* Content List */}
            {loading ? (
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
                            onClick={() => setShowNewModal(true)}
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
                                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                                                    t.lifecycle === 'bounded'
                                                        ? 'bg-amber-950/50 text-amber-300 border-amber-800/60'
                                                        : 'bg-blue-950/50 text-blue-300 border-blue-800/60'
                                                }`}>
                                                    {t.lifecycle === 'bounded' ? '⏱️ Bounded' : '🏛️ Ongoing'}
                                                </span>
                                            </div>
                                            {t.callsign && (
                                                <p className="text-xs text-nature-400 mt-0.5">
                                                    @{t.callsign}
                                                </p>
                                            )}
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
                                                <span className="font-bold text-white">
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
        </div>
    );
}
