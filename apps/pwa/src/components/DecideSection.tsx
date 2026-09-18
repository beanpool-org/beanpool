import { useState, useEffect } from 'react';
import {
    castDecisionVote,
    getGovernanceCredits,
    type DecisionWithTally,
    type BalanceInfo,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { ownVoteSummary, startingVoteCount, voteButtonStates } from '../lib/decision-own-vote';

interface Props {
    decisions: DecisionWithTally[];
    activeMembers30d: number;
    identity: BeanPoolIdentity | null;
    balanceInfo: BalanceInfo | null;
    commonsBalance: number;
    onRefresh: () => Promise<void>;
    onOpenPropose: () => void;
    canPropose: boolean;
    hasOpenDecision: boolean;
    activeView: 'open' | 'history';
    onChangeView: (view: 'open' | 'history') => void;
}

export function DecideSection({
    decisions,
    activeMembers30d,
    identity,
    balanceInfo,
    commonsBalance,
    onRefresh,
    onOpenPropose,
    canPropose,
    hasOpenDecision,
    activeView,
    onChangeView,
}: Props) {
    const [votingId, setVotingId] = useState<string | null>(null);
    const [selectedVoteCount, setSelectedVoteCount] = useState<Record<string, number>>({});
    const [historyFilter, setHistoryFilter] = useState<'all' | 'executed' | 'failed' | 'void'>('all');
    const [voteError, setVoteError] = useState<string | null>(null);
    const [voiceCredits, setVoiceCredits] = useState<{ totalCredits: number; usedCredits: number; availableCredits: number } | null>(null);

    useEffect(() => {
        if (!identity?.publicKey) {
            setVoiceCredits(null);
            return;
        }
        getGovernanceCredits(identity.publicKey)
            .then(setVoiceCredits)
            .catch(() => {});
    }, [identity?.publicKey]);

    const openDecisions = decisions.filter(d => d.status === 'open');
    const pastDecisions = decisions.filter(d => d.status !== 'open');

    const filteredPastDecisions = pastDecisions.filter(d => {
        if (historyFilter === 'executed') return d.status === 'executed' || d.status === 'passed';
        if (historyFilter === 'failed') return d.status === 'failed' || d.status === 'unresolved';
        if (historyFilter === 'void') return d.status === 'execution_void' || d.status === 'execution_blocked' || d.status === 'admin_halted';
        return true;
    });

    const formatTimeLeft = (closesAt: string) => {
        const diffMs = new Date(closesAt).getTime() - Date.now();
        if (diffMs <= 0) return 'Closing now';
        const mins = Math.floor(diffMs / 60000);
        if (mins < 60) return `${mins}m left`;
        const hours = Math.floor(diffMs / 3600000);
        if (hours < 48) return `${hours}h left`;
        const days = Math.ceil(diffMs / (24 * 3600000));
        return `${days} days left`;
    };

    const formatEffectLabel = (effect: string) => {
        return effect
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    };

    const handleVote = async (decision: DecisionWithTally, support: boolean) => {
        if (!identity?.publicKey) {
            setVoteError('You must be logged in to vote.');
            return;
        }

        const count = startingVoteCount(selectedVoteCount[decision.id], decision.myVote);
        if (decision.franchise === 'quadratic_trade') {
            const cost = count * count;
            let available = voiceCredits?.availableCredits ?? 0;
            try {
                const fresh = await getGovernanceCredits(identity.publicKey);
                setVoiceCredits(fresh);
                available = fresh.availableCredits ?? 0;
            } catch { }

            if (cost > available) {
                setVoteError(`Casting ${count} votes costs ${cost} credits, but you have ${available}.`);
                return;
            }
        }

        setVotingId(decision.id);
        setVoteError(null);
        try {
            const res = await castDecisionVote(decision.id, {
                voterPubkey: identity.publicKey,
                support,
                voteCount: count,
            });

            if (res.success) {
                if (identity?.publicKey) {
                    getGovernanceCredits(identity.publicKey).then(setVoiceCredits).catch(() => {});
                }
                await onRefresh();
            } else {
                setVoteError((res as any).error || 'Failed to record vote');
            }
        } catch (err: any) {
            setVoteError(err.message || 'Failed to cast vote');
        } finally {
            setVotingId(null);
        }
    };

    return (
        <div className="space-y-4">
            {voteError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-sm p-3 rounded-xl flex items-center justify-between">
                    <span>{voteError}</span>
                    <button onClick={() => setVoteError(null)} className="text-red-400 hover:text-white p-1">✕</button>
                </div>
            )}

            {/* View Switcher: Open Decisions vs History */}
            <div role="tablist" aria-label="Decisions view" className="flex gap-2">
                <button
                    role="tab"
                    id="tab-open-decisions"
                    aria-selected={activeView === 'open'}
                    aria-controls="panel-open-decisions"
                    onClick={() => onChangeView('open')}
                    className={`flex-1 py-2.5 px-4 rounded-xl border text-sm font-bold flex items-center justify-center gap-2 transition-all ${
                        activeView === 'open'
                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-sm'
                            : 'bg-nature-900 border-nature-800 text-nature-400 hover:border-nature-700'
                    }`}
                >
                    <span>🗳️ Open Decisions</span>
                    {openDecisions.length > 0 && (
                        <span className="bg-emerald-500 text-white text-xs px-2 py-0.5 rounded-full font-extrabold">
                            {openDecisions.length}
                        </span>
                    )}
                </button>

                <button
                    role="tab"
                    id="tab-history-decisions"
                    aria-selected={activeView === 'history'}
                    aria-controls="panel-history-decisions"
                    onClick={() => onChangeView('history')}
                    className={`flex-1 py-2.5 px-4 rounded-xl border text-sm font-bold flex items-center justify-center gap-2 transition-all ${
                        activeView === 'history'
                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-sm'
                            : 'bg-nature-900 border-nature-800 text-nature-400 hover:border-nature-700'
                    }`}
                >
                    <span>📜 Decisions History</span>
                </button>
            </div>

            {/* OPEN DECISIONS VIEW */}
            {activeView === 'open' && (
                <div role="tabpanel" id="panel-open-decisions" aria-labelledby="tab-open-decisions" className="space-y-4">
                    {/* Propose Action Banner */}
                    <div className="bg-nature-900 border border-nature-800 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm">
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-white font-bold text-base">🌱 Propose Community Action</h3>
                                <span className="text-xs text-nature-400 font-medium">No bond required</span>
                            </div>
                            <p className="text-nature-400 text-xs sm:text-sm mt-1 max-w-xl">
                                Binding decisions execute automatically upon passing (§3.7). Open to anyone who has completed a trade.
                            </p>
                            {!canPropose && (
                                <p className="text-amber-400 text-xs font-semibold mt-1">
                                    ⚠️ You can propose once you have completed a trade.
                                </p>
                            )}
                            {canPropose && hasOpenDecision && (
                                <p className="text-sky-400 text-xs font-semibold mt-1">
                                    ℹ️ You already have an open decision (limit 1 open per author).
                                </p>
                            )}
                        </div>

                        <button
                            onClick={onOpenPropose}
                            disabled={!canPropose || hasOpenDecision}
                            className={`w-full sm:w-auto py-2.5 px-5 rounded-xl font-bold text-sm shadow-md transition-all active:scale-95 whitespace-nowrap ${
                                canPropose && !hasOpenDecision
                                    ? 'bg-accent hover:bg-emerald-500 text-white'
                                    : 'bg-nature-800 text-nature-500 cursor-not-allowed border border-nature-700/50'
                            }`}
                        >
                            + Propose Decision
                        </button>
                    </div>

                    {/* Decisions List */}
                    {openDecisions.length === 0 ? (
                        <div className="bg-nature-900 border border-nature-800 rounded-2xl p-8 text-center text-nature-400 flex flex-col items-center gap-2">
                            <span className="text-4xl opacity-40">🗳️</span>
                            <div className="text-white font-bold text-base mt-2">No open decisions right now</div>
                            <div className="text-sm max-w-md">
                                Decisions appear here when members propose community actions. Propose one or check back later.
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {openDecisions.map(item => {
                                const { tally } = item;
                                const quorumPct = Math.min(100, Math.round((tally.totalVoters / Math.max(1, tally.quorumRequired)) * 100));
                                const supportPct = Math.round(tally.supportRatio * 100);
                                const thresholdPct = Math.round(tally.thresholdRequired * 100);
                                const currentCount = startingVoteCount(selectedVoteCount[item.id], item.myVote);
                                const isQuadratic = item.franchise === 'quadratic_trade';
                                const myVoteLine = ownVoteSummary(item.myVote, isQuadratic);
                                const buttons = voteButtonStates(item.myVote, isQuadratic, currentCount);

                                // §3.8 Removal ballot debt line
                                const targetName = item.params?.memberName || item.subject?.slice(0, 8) || 'Member';
                                const debtAmount = item.params?.debt !== undefined ? Math.abs(item.params.debt) : (item.params?.balance !== undefined ? Math.abs(Math.min(0, item.params.balance)) : 0);
                                const poolAmount = Math.round(item.params?.commonsPool ?? commonsBalance ?? 0);
                                const debtWriteOffLine = `${targetName}'s balance is \u2212${debtAmount} beans. Removing them charges that ${debtAmount} to the Commons pool, which currently holds ${poolAmount}.`;

                                return (
                                    <div
                                        key={item.id}
                                        className="bg-nature-900 border border-nature-800 rounded-2xl p-5 shadow-sm space-y-3"
                                    >
                                        {/* Card Header: Touches, Effect, Franchise, Time Left */}
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="bg-emerald-500/20 text-emerald-400 text-xs font-bold px-2.5 py-1 rounded-lg uppercase tracking-wider">
                                                    Touches: {item.touches}
                                                </span>
                                                <span className="bg-nature-800 text-nature-300 text-xs font-semibold px-2.5 py-1 rounded-lg border border-nature-700/60">
                                                    {formatEffectLabel(item.effect)}
                                                </span>
                                                <span className="bg-nature-800 text-nature-300 text-xs font-semibold px-2.5 py-1 rounded-lg border border-nature-700/60">
                                                    {item.franchise === 'quadratic_trade' ? 'Quadratic on Trade' : '1 Member 1 Vote'}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1.5 bg-amber-500/15 text-amber-300 text-xs font-bold px-2.5 py-1 rounded-lg border border-amber-500/20">
                                                <span>⏱️</span>
                                                <span>{formatTimeLeft(item.closesAt)}</span>
                                            </div>
                                        </div>

                                        {/* Title & Description */}
                                        <div>
                                            <h4 className="text-white font-extrabold text-lg tracking-tight">
                                                {item.title}
                                            </h4>
                                            <p className="text-nature-300 text-sm mt-1 leading-relaxed">
                                                {item.description}
                                            </p>
                                        </div>

                                        {/* §3.8 Removal Ballot Debt Write-Off Warning Box */}
                                        {item.effect === 'remove_member' && (
                                            <div
                                                className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 my-2"
                                                data-testid="removal-debt-write-off-box"
                                            >
                                                <div className="text-xs font-bold text-red-400 uppercase tracking-wider mb-0.5">
                                                    Mandatory Debt Disclosure (§3.8)
                                                </div>
                                                <div
                                                    className="text-sm font-semibold text-red-200"
                                                    data-testid="removal-debt-write-off-line"
                                                >
                                                    {debtWriteOffLine}
                                                </div>
                                            </div>
                                        )}

                                        {/* Metrics: Quorum Progress and Tally */}
                                        <div className="bg-nature-800/40 border border-nature-700/50 rounded-xl p-3.5 space-y-3">
                                            {/* Quorum */}
                                            <div>
                                                <div className="flex justify-between text-xs font-semibold mb-1">
                                                    <span className="text-nature-400">
                                                        Quorum Progress: {tally.totalVoters} / {tally.quorumRequired} voters ({quorumPct}%)
                                                    </span>
                                                    <span className={tally.quorumMet ? 'text-emerald-400' : 'text-nature-400'}>
                                                        {tally.quorumMet ? 'Quorum Met ✅' : 'Pending Quorum'}
                                                    </span>
                                                </div>
                                                <div
                                                    role="progressbar"
                                                    aria-valuenow={Math.min(100, quorumPct)}
                                                    aria-valuemin={0}
                                                    aria-valuemax={100}
                                                    aria-label="Quorum progress"
                                                    className="h-2 bg-nature-800 rounded-full overflow-hidden"
                                                >
                                                    <div
                                                        className={`h-full rounded-full transition-all duration-300 ${tally.quorumMet ? 'bg-emerald-500' : 'bg-sky-500'}`}
                                                        style={{ width: `${quorumPct}%` }}
                                                    />
                                                </div>
                                            </div>

                                            {/* Tally & Support */}
                                            <div>
                                                <div className="flex justify-between text-xs font-semibold mb-1">
                                                    <span className="text-nature-300">
                                                        Tally: Yes {tally.yesWeight} ({supportPct}%) · No {tally.noWeight}
                                                    </span>
                                                    <span className="text-nature-400">
                                                        Threshold required: {thresholdPct}%
                                                    </span>
                                                </div>
                                                <div
                                                    role="progressbar"
                                                    aria-valuenow={Math.min(100, supportPct)}
                                                    aria-valuemin={0}
                                                    aria-valuemax={100}
                                                    aria-label="Support progress"
                                                    className="h-2 bg-nature-800 rounded-full overflow-hidden"
                                                >
                                                    <div
                                                        className={`h-full rounded-full transition-all duration-300 ${tally.passed ? 'bg-emerald-500' : 'bg-amber-500'}`}
                                                        style={{ width: `${supportPct}%` }}
                                                    />
                                                </div>
                                            </div>
                                        </div>

                                        {/* Voting Action Section */}
                                        <div className="pt-2 border-t border-nature-800 flex flex-col gap-2.5">
                                            {item.franchise === 'quadratic_trade' && (
                                                <div className="flex items-center justify-between bg-nature-800/60 border border-nature-700/60 rounded-xl px-3 py-2 text-xs">
                                                    <span className="text-nature-300 font-medium">
                                                        Vote Count: <strong className="text-white">{currentCount}</strong> (Cost: <strong className="text-emerald-400">{currentCount * currentCount} cr</strong> · Available: {voiceCredits?.availableCredits ?? balanceInfo?.qualifiedValue ?? balanceInfo?.earnedCredit ?? 0})
                                                    </span>
                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => setSelectedVoteCount(prev => ({
                                                                ...prev,
                                                                [item.id]: Math.max(1, startingVoteCount(prev[item.id], item.myVote) - 1),
                                                            }))}
                                                            className="w-11 h-11 rounded-xl text-base bg-nature-700 text-white font-bold hover:bg-nature-600 flex items-center justify-center transition-colors"
                                                            aria-label="Decrease votes"
                                                        >
                                                            -
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => setSelectedVoteCount(prev => ({
                                                                ...prev,
                                                                [item.id]: startingVoteCount(prev[item.id], item.myVote) + 1,
                                                            }))}
                                                            className="w-11 h-11 rounded-xl text-base bg-nature-700 text-white font-bold hover:bg-nature-600 flex items-center justify-center transition-colors"
                                                            aria-label="Increase votes"
                                                        >
                                                            +
                                                        </button>
                                                    </div>
                                                </div>
                                            )}

                                            {myVoteLine && (
                                                <p className="text-sm font-bold text-emerald-300 flex items-center gap-1.5">
                                                    <span aria-hidden="true">✓</span>
                                                    <span>{myVoteLine}</span>
                                                </p>
                                            )}

                                            <div className="flex gap-3">
                                                <button
                                                    onClick={() => handleVote(item, true)}
                                                    disabled={votingId === item.id || buttons.yes.disabled}
                                                    className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-sm shadow transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-1.5"
                                                >
                                                    <span>👍</span>
                                                    <span>{votingId === item.id ? 'Recording...' : buttons.yes.label}</span>
                                                </button>

                                                <button
                                                    onClick={() => handleVote(item, false)}
                                                    disabled={votingId === item.id || buttons.no.disabled}
                                                    className="flex-1 py-2.5 px-4 rounded-xl bg-red-600 hover:bg-red-500 text-white font-extrabold text-sm shadow transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-1.5"
                                                >
                                                    <span>👎</span>
                                                    <span>{votingId === item.id ? 'Recording...' : buttons.no.label}</span>
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* DECISIONS HISTORY VIEW */}
            {activeView === 'history' && (
                <div role="tabpanel" id="panel-history-decisions" aria-labelledby="tab-history-decisions" className="space-y-4">
                    {/* Filters */}
                    <div className="flex flex-wrap gap-2">
                        {(['all', 'executed', 'failed', 'void'] as const).map(f => (
                            <button
                                key={f}
                                onClick={() => setHistoryFilter(f)}
                                className={`py-1.5 px-3 rounded-xl text-xs font-bold border transition-colors ${
                                    historyFilter === f
                                        ? 'bg-emerald-500 text-white border-emerald-500'
                                        : 'bg-nature-900 text-nature-400 border-nature-800 hover:border-nature-700'
                                }`}
                            >
                                {f.toUpperCase()}
                            </button>
                        ))}
                    </div>

                    {filteredPastDecisions.length === 0 ? (
                        <div className="bg-nature-900 border border-nature-800 rounded-2xl p-8 text-center text-nature-400">
                            <span className="text-3xl opacity-40">📜</span>
                            <div className="text-white font-bold text-base mt-2">No history records found</div>
                            <div className="text-sm mt-1">
                                Past decisions, tallies, and executed effect provenances will be listed here.
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {filteredPastDecisions.map(item => {
                                const { tally } = item;
                                const supportPct = Math.round(tally.supportRatio * 100);

                                let badgeColor = 'bg-red-500/20 text-red-300 border-red-500/40';
                                if (item.status === 'executed' || item.status === 'passed') {
                                    badgeColor = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
                                } else if (item.status === 'execution_pending_grace') {
                                    badgeColor = 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40';
                                } else if (item.status === 'execution_void' || item.status === 'admin_halted') {
                                    badgeColor = 'bg-amber-500/20 text-amber-300 border-amber-500/40';
                                }

                                return (
                                    <div
                                        key={item.id}
                                        className="bg-nature-900 border border-nature-800 rounded-2xl p-5 shadow-sm space-y-3"
                                    >
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="flex items-center gap-2">
                                                <span className="bg-nature-800 text-nature-300 text-xs font-semibold px-2.5 py-1 rounded-lg border border-nature-700/60">
                                                    Touches: {item.touches}
                                                </span>
                                                <span className="bg-nature-800 text-nature-300 text-xs font-semibold px-2.5 py-1 rounded-lg border border-nature-700/60">
                                                    {formatEffectLabel(item.effect)}
                                                </span>
                                            </div>
                                            <span className={`text-xs font-extrabold px-2.5 py-1 rounded-lg border uppercase tracking-wider ${badgeColor}`}>
                                                {item.status.replace(/_/g, ' ')}
                                            </span>
                                        </div>

                                        <div>
                                            <h4 className="text-white font-extrabold text-base">
                                                {item.title}
                                            </h4>
                                            <p className="text-nature-300 text-xs sm:text-sm mt-0.5 leading-relaxed">
                                                {item.description}
                                            </p>
                                        </div>

                                        {/* Final Tally */}
                                        <div className="bg-nature-800/40 border border-nature-700/50 rounded-xl p-3 text-xs text-nature-300 flex justify-between items-center">
                                            <span>
                                                Quorum: {tally.totalVoters} / {tally.quorumRequired} ({tally.quorumMet ? 'Met ✅' : 'Unmet ❌'})
                                            </span>
                                            <span className="font-semibold">
                                                Yes: {tally.yesWeight} ({supportPct}%) · No: {tally.noWeight}
                                            </span>
                                        </div>

                                        {/* Who Authorised Each Executed Effect (§3.7, §3.8) */}
                                        <div className="bg-nature-800/60 border border-nature-700/60 rounded-xl p-3 text-xs space-y-1">
                                            <div className="text-xs font-bold uppercase tracking-wider text-nature-400">
                                                Authorisation & Provenance
                                            </div>
                                            {item.status === 'executed' && (
                                                <>
                                                    <div className="text-emerald-300 font-semibold">
                                                        Authorised by: Community Vote (system:decision:{item.id.slice(0, 8)})
                                                    </div>
                                                    <div className="text-nature-400 font-mono text-[11px]">
                                                        Provenance: system:decision:{item.id} · {item.executionReason || 'Executed successfully'}
                                                    </div>
                                                </>
                                            )}
                                            {item.status === 'admin_halted' && (
                                                <div className="text-amber-300 font-semibold">
                                                    Halted by Admin: {item.adminHaltedBy} — Reason: {item.adminHaltReason}
                                                </div>
                                            )}
                                            {item.status === 'execution_pending_grace' && (
                                                <div className="text-indigo-300 font-semibold">
                                                    In 7-day Grace Window: Scheduled for removal on {new Date(item.gracePeriodEndsAt!).toLocaleDateString()}
                                                </div>
                                            )}
                                            {item.status === 'execution_void' && (
                                                <div className="text-amber-300">
                                                    Void: {item.executionReason || 'Subject no longer exists or was pruned'}
                                                </div>
                                            )}
                                            {item.status === 'failed' && (
                                                <div className="text-red-300">
                                                    Not executed: {tally.quorumMet ? 'Threshold not met' : 'Quorum not reached'}
                                                </div>
                                            )}
                                            {item.status === 'unresolved' && (
                                                <div className="text-nature-400">
                                                    Expired unresolved: Quorum not reached
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
