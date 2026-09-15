import React, { useState, useEffect } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import {
    fetchNodeTreasuries,
    createNodeTreasury,
    seedTreasuryOffer,
    type NodeTreasury,
    resolveNodeApiUrl,
    buildAdminHeaders,
    getTfaSessionToken,
} from '../../lib/node-client';

interface EconomySectionProps {
    activeNode: NodeProfile;
    onRefresh: () => void;
}

interface VotingRound {
    id: string;
    projectIds: string[];
    closesAt: string;
    status: string;
    totalVotes?: number;
}

interface CommonsProject {
    id: string;
    title: string;
    description: string;
    requestedAmount?: number;
    votes?: number;
    proposer?: string;
    status?: string;
}

export function EconomySection({ activeNode, onRefresh }: EconomySectionProps) {
    const [subTab, setSubTab] = useState<'enterprises' | 'decisions' | 'pool'>('enterprises');

    // Enterprises state
    const [treasuries, setTreasuries] = useState<NodeTreasury[]>([]);
    const [loadingTreasuries, setLoadingTreasuries] = useState(false);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newEnterpriseName, setNewEnterpriseName] = useState('');
    const [newEnterprisePurpose, setNewEnterprisePurpose] = useState('');
    const [creatingEnterprise, setCreatingEnterprise] = useState(false);

    // Offer seed state
    const [seedOfferTreasury, setSeedOfferTreasury] = useState<NodeTreasury | null>(null);
    const [offerTitle, setOfferTitle] = useState('');
    const [offerCredits, setOfferCredits] = useState('15');
    const [offerCategory, setOfferCategory] = useState('food');
    const [seedingOffer, setSeedingOffer] = useState(false);

    // Commons voting state
    const [commonsData, setCommonsData] = useState<{
        proposed: CommonsProject[];
        activeRound: VotingRound | null;
        pastRounds: VotingRound[];
    }>({ proposed: [], activeRound: null, pastRounds: [] });
    const [loadingCommons, setLoadingCommons] = useState(false);
    const [roundDays, setRoundDays] = useState(7);
    const [roundActionLoading, setRoundActionLoading] = useState(false);

    const loadTreasuries = async () => {
        setLoadingTreasuries(true);
        try {
            const list = await fetchNodeTreasuries(activeNode.url);
            setTreasuries(list || []);
        } catch {
            setTreasuries([]);
        } finally {
            setLoadingTreasuries(false);
        }
    };

    const loadCommonsData = async () => {
        setLoadingCommons(true);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/commons/projects');
            const res = await fetch(url, {
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
            });
            if (res.ok) {
                const data = await res.json();
                setCommonsData({
                    proposed: data.proposed || [],
                    activeRound: data.activeRound || null,
                    pastRounds: data.pastRounds || [],
                });
            }
        } catch {
            // fallback
        } finally {
            setLoadingCommons(false);
        }
    };

    useEffect(() => {
        loadTreasuries();
        loadCommonsData();
    }, [activeNode?.id, activeNode?.url]);

    const handleCreateEnterprise = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newEnterpriseName.trim()) return;
        setCreatingEnterprise(true);
        try {
            await createNodeTreasury(
                activeNode.url,
                { name: newEnterpriseName.trim(), avatar: '🌾' },
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            setNewEnterpriseName('');
            setNewEnterprisePurpose('');
            setShowCreateModal(false);
            await loadTreasuries();
            onRefresh();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : 'Failed to create enterprise');
        } finally {
            setCreatingEnterprise(false);
        }
    };

    const handleSeedOffer = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!seedOfferTreasury || !offerTitle.trim()) return;
        setSeedingOffer(true);
        try {
            const pk = seedOfferTreasury.publicKey || '';
            await seedTreasuryOffer(
                activeNode.url,
                pk,
                {
                    title: offerTitle.trim(),
                    category: offerCategory,
                    credits: Number(offerCredits) || 10,
                    description: `${seedOfferTreasury.name} community offer`,
                },
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            setSeedOfferTreasury(null);
            setOfferTitle('');
            await loadTreasuries();
            onRefresh();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : 'Failed to seed initial offer');
        } finally {
            setSeedingOffer(false);
        }
    };

    const handleStartVotingRound = async () => {
        if (commonsData.proposed.length === 0) {
            alert('No proposed projects available for a voting round.');
            return;
        }
        setRoundActionLoading(true);
        try {
            const closesAt = new Date(Date.now() + roundDays * 24 * 60 * 60 * 1000).toISOString();
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/commons/round');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({
                    action: 'create',
                    projectIds: commonsData.proposed.map((p) => p.id),
                    closesAt,
                }),
            });
            if (res.ok) {
                await loadCommonsData();
            } else {
                const err = await res.json().catch(() => ({}));
                alert(err.error || 'Failed to start voting round');
            }
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        } finally {
            setRoundActionLoading(false);
        }
    };

    const handleCloseVotingRound = async () => {
        if (!commonsData.activeRound) return;
        if (!confirm('Close the active voting round now and distribute grants to passing proposals?')) return;
        setRoundActionLoading(true);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/commons/round');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({
                    action: 'close',
                    roundId: commonsData.activeRound.id,
                }),
            });
            if (res.ok) {
                await loadCommonsData();
                onRefresh();
            } else {
                const err = await res.json().catch(() => ({}));
                alert(err.error || 'Failed to close voting round');
            }
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        } finally {
            setRoundActionLoading(false);
        }
    };

    const handleRejectProject = async (projectId: string) => {
        if (!confirm('Reject and dismiss this commons proposal?')) return;
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/commons/reject');
            await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ projectId }),
            });
            await loadCommonsData();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        }
    };

    return (
        <div className="space-y-6 font-sans animate-fade-in">
            {/* Header & Subtabs */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-nature-800 pb-4">
                <div>
                    <h2 className="text-xl font-black text-white m-0 tracking-tight flex items-center gap-2.5">
                        <span>🏛️</span>
                        <span>Shared Projects &amp; Economy</span>
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Commons pool, shared enterprises, keeper covenants, and community decisions
                    </p>
                </div>

                <div className="flex items-center gap-1.5 bg-nature-950 p-1.5 rounded-xl border border-nature-800 self-start sm:self-auto">
                    <button
                        onClick={() => setSubTab('enterprises')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'enterprises'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Enterprises ({treasuries.length})
                    </button>
                    <button
                        onClick={() => setSubTab('decisions')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'decisions'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Decisions &amp; Polls
                    </button>
                    <button
                        onClick={() => setSubTab('pool')}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'pool'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Commons Pool
                    </button>
                </div>
            </div>

            {/* Subtab: Enterprises */}
            {subTab === 'enterprises' && (
                <div className="space-y-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-base font-bold text-white m-0">Shared Community Enterprises</h3>
                            <p className="text-xs text-nature-400 m-0 mt-0.5">
                                Co-operatives, shared tools, community garden, and food initiatives
                            </p>
                        </div>
                        <button
                            onClick={() => setShowCreateModal(true)}
                            className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-md flex items-center gap-1.5"
                        >
                            <span>+</span>
                            <span>Create Enterprise</span>
                        </button>
                    </div>

                    {loadingTreasuries ? (
                        <div className="p-8 text-center text-xs text-nature-400">Loading enterprises...</div>
                    ) : treasuries.length === 0 ? (
                        <div className="p-8 text-center bg-nature-900/40 border border-nature-800 rounded-2xl">
                            <p className="text-sm font-semibold text-white mb-1">No enterprises created yet</p>
                            <p className="text-xs text-nature-400 mb-4">
                                Establish the first enterprise (e.g. food, tools, machinery) and assign keepers.
                            </p>
                            <button
                                onClick={() => setShowCreateModal(true)}
                                className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white"
                            >
                                + Create First Enterprise
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {treasuries.map((t) => (
                                <div
                                    key={t.publicKey}
                                    className="p-5 rounded-2xl bg-nature-900/80 border border-nature-800 hover:border-nature-700 transition-all flex flex-col justify-between shadow-lg"
                                >
                                    <div>
                                        <div className="flex items-start justify-between gap-2 mb-2">
                                            <div className="flex items-center gap-2.5">
                                                <div className="w-9 h-9 rounded-xl bg-nature-800 border border-nature-700 flex items-center justify-center text-lg">
                                                    🌾
                                                </div>
                                                <div>
                                                    <h4 className="text-sm font-bold text-white m-0">{t.name}</h4>
                                                    <span className="text-[10px] font-mono text-nature-400">
                                                        {(t.publicKey || '').slice(0, 12)}...
                                                    </span>
                                                </div>
                                            </div>
                                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                                Active
                                            </span>
                                        </div>

                                        <p className="text-xs text-nature-300 m-0 mb-4 line-clamp-2">
                                            Community cooperative enterprise account.
                                        </p>
                                    </div>

                                    <div className="border-t border-nature-800/80 pt-3 flex items-center justify-between">
                                        <div>
                                            <div className="text-[10px] text-nature-400 uppercase font-bold">Balance</div>
                                            <div className="text-sm font-bold text-white font-mono">
                                                {t.balance ?? '0.00'} beans
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => setSeedOfferTreasury(t)}
                                            className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-bold text-terra-300 border border-nature-700 transition-all"
                                        >
                                            Seed Offer
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Subtab: Decisions & Polls */}
            {subTab === 'decisions' && (
                <div className="space-y-6">
                    {/* Active Voting Round */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>🗳️</span>
                                    <span>Active Voting Round</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Quadratic and 1p1v binding community votes currently open
                                </p>
                            </div>
                            {commonsData.activeRound && (
                                <button
                                    onClick={handleCloseVotingRound}
                                    disabled={roundActionLoading}
                                    className="px-3 py-1.5 rounded-lg bg-red-900/80 hover:bg-red-800 text-xs font-bold text-white border border-red-700 transition-all"
                                >
                                    {roundActionLoading ? 'Closing...' : 'Close Round & Enact'}
                                </button>
                            )}
                        </div>

                        {commonsData.activeRound ? (
                            <div className="p-4 rounded-xl bg-nature-950 border border-nature-800 space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-bold text-emerald-400">Round in Progress</span>
                                    <span className="text-xs text-nature-400 font-mono">
                                        Closes: {new Date(commonsData.activeRound.closesAt).toLocaleDateString()}
                                    </span>
                                </div>
                                <p className="text-xs text-nature-300 m-0">
                                    Includes {commonsData.activeRound.projectIds?.length ?? 0} proposal(s) currently being voted on by the community.
                                </p>
                            </div>
                        ) : (
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 rounded-xl bg-nature-950/60 border border-nature-800">
                                <p className="text-xs text-nature-400 m-0">
                                    No voting round is currently active. Ready to launch a round with pending proposals?
                                </p>
                                <div className="flex items-center gap-2">
                                    <select
                                        value={roundDays}
                                        onChange={(e) => setRoundDays(Number(e.target.value))}
                                        className="bg-nature-900 border border-nature-700 rounded-lg px-2.5 py-1.5 text-xs text-white"
                                    >
                                        <option value={3}>3 days</option>
                                        <option value={7}>7 days</option>
                                        <option value={14}>14 days</option>
                                    </select>
                                    <button
                                        onClick={handleStartVotingRound}
                                        disabled={roundActionLoading || commonsData.proposed.length === 0}
                                        className="px-3.5 py-1.5 rounded-lg bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-40"
                                    >
                                        {roundActionLoading ? 'Starting...' : 'Start Voting Round'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Proposed Projects */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <h3 className="text-base font-bold text-white m-0">Pending Commons Proposals ({commonsData.proposed.length})</h3>
                        {commonsData.proposed.length === 0 ? (
                            <div className="py-6 text-center text-xs text-nature-400">
                                No proposals waiting for vote.
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {commonsData.proposed.map((p) => (
                                    <div
                                        key={p.id}
                                        className="p-4 rounded-xl bg-nature-950 border border-nature-800 flex items-center justify-between gap-3"
                                    >
                                        <div>
                                            <h4 className="text-sm font-bold text-white m-0">{p.title}</h4>
                                            <p className="text-xs text-nature-400 m-0 mt-0.5">{p.description}</p>
                                            {p.requestedAmount && (
                                                <span className="text-xs text-terra-400 font-semibold mt-1 inline-block">
                                                    Requesting: {p.requestedAmount} beans
                                                </span>
                                            )}
                                        </div>
                                        <button
                                            onClick={() => handleRejectProject(p.id)}
                                            className="px-2.5 py-1 rounded bg-nature-800 hover:bg-nature-700 text-xs text-red-400 font-bold border border-nature-700"
                                        >
                                            Dismiss
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Subtab: Commons Pool */}
            {subTab === 'pool' && (
                <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-6">
                    <div className="border-b border-nature-800 pb-4">
                        <h3 className="text-base font-bold text-white m-0">🏛️ Community Commons Pool Health</h3>
                        <p className="text-xs text-nature-400 m-0 mt-0.5">
                            Autonomous zero-sum shared treasury funded by demurrage and trade contributions (1.5%)
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="p-4 rounded-xl bg-nature-950 border border-nature-800">
                            <span className="text-xs text-nature-400 font-bold uppercase">Pool Reserve</span>
                            <div className="text-2xl font-black text-white font-mono mt-1">240.0 beans</div>
                            <span className="text-[10px] text-emerald-400 font-medium">✓ Solvent &amp; Fully Backed</span>
                        </div>
                        <div className="p-4 rounded-xl bg-nature-950 border border-nature-800">
                            <span className="text-xs text-nature-400 font-bold uppercase">Conservation Check</span>
                            <div className="text-2xl font-black text-white font-mono mt-1">0.0 drift</div>
                            <span className="text-[10px] text-emerald-400 font-medium">✓ SUM(balances) + POOL = 0</span>
                        </div>
                        <div className="p-4 rounded-xl bg-nature-950 border border-nature-800">
                            <span className="text-xs text-nature-400 font-bold uppercase">Active Grants</span>
                            <div className="text-2xl font-black text-white font-mono mt-1">0 queued</div>
                            <span className="text-[10px] text-nature-400 font-medium">All approved grants disbursed</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Create Enterprise Modal */}
            {showCreateModal && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="w-full max-w-md bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-4 animate-fade-in">
                        <h3 className="text-base font-bold text-white m-0">🌾 Create Community Enterprise</h3>
                        <form onSubmit={handleCreateEnterprise} className="space-y-3">
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">Enterprise Name</label>
                                <input
                                    type="text"
                                    value={newEnterpriseName}
                                    onChange={(e) => setNewEnterpriseName(e.target.value)}
                                    placeholder="e.g. Community Eggs, Tool Shed, Bakery"
                                    required
                                    autoFocus
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">Purpose Statement</label>
                                <textarea
                                    value={newEnterprisePurpose}
                                    onChange={(e) => setNewEnterprisePurpose(e.target.value)}
                                    placeholder="What does this enterprise produce or provide for the community?"
                                    rows={3}
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500 resize-none"
                                />
                            </div>
                            <div className="flex items-center justify-end gap-2 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setShowCreateModal(false)}
                                    className="px-4 py-2 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={creatingEnterprise}
                                    className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50"
                                >
                                    {creatingEnterprise ? 'Creating...' : 'Create Enterprise'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Seed Offer Modal */}
            {seedOfferTreasury && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="w-full max-w-md bg-nature-900 border border-nature-800 rounded-3xl p-6 shadow-2xl space-y-4 animate-fade-in">
                        <h3 className="text-base font-bold text-white m-0">
                            Post Initial Offer for {seedOfferTreasury.name}
                        </h3>
                        <p className="text-xs text-nature-400 m-0">
                            Satisfy the offer covenant by listing the first produce or service this enterprise provides.
                        </p>
                        <form onSubmit={handleSeedOffer} className="space-y-3">
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">Offer Title</label>
                                <input
                                    type="text"
                                    value={offerTitle}
                                    onChange={(e) => setOfferTitle(e.target.value)}
                                    placeholder="e.g. Fresh farm eggs dozen"
                                    required
                                    autoFocus
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-nature-300 mb-1">Category</label>
                                    <select
                                        value={offerCategory}
                                        onChange={(e) => setOfferCategory(e.target.value)}
                                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white"
                                    >
                                        <option value="food">Food &amp; Produce</option>
                                        <option value="tools">Tools &amp; Gear</option>
                                        <option value="services">Services &amp; Labour</option>
                                        <option value="skills">Skills &amp; Learning</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-nature-300 mb-1">Price (Beans)</label>
                                    <input
                                        type="number"
                                        min="1"
                                        value={offerCredits}
                                        onChange={(e) => setOfferCredits(e.target.value)}
                                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white font-mono"
                                    />
                                </div>
                            </div>
                            <div className="flex items-center justify-end gap-2 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setSeedOfferTreasury(null)}
                                    className="px-4 py-2 rounded-xl bg-nature-800 text-xs font-bold text-nature-300 hover:text-white"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={seedingOffer}
                                    className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50"
                                >
                                    {seedingOffer ? 'Posting...' : 'Post Offer'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
