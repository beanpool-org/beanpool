/**
 * PollCard — Interactive Community Poll card for the Marketplace feed (apps/pwa).
 *
 * Implements docs/the-commons.md §3.2, §3.8, §8 specifications:
 * - Displays poll question (title), author, time remaining or closed status.
 * - Options list with live progress bars, vote counts, and percentages.
 * - Tap-to-vote: one member, one vote; re-voting overwrites choice.
 * - Total turnout count & close date.
 * - Public open ballot: collapsible list of who voted for what.
 * - Author "Close Poll" action for early closure.
 */

import { useState, useEffect } from 'react';
import { type PollOption, type PollVoteRecord } from '../lib/marketplace';
import { votePoll, closePoll, type MarketplacePost } from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';

interface PollCardProps {
    post: MarketplacePost;
    identity?: BeanPoolIdentity | null;
    onVoteSuccess?: () => void;
    onOpenProfile?: (pubkey: string) => void;
}

export function PollCard({ post, identity, onVoteSuccess, onOpenProfile }: PollCardProps) {
    const [livePost, setLivePost] = useState<MarketplacePost>(post);
    const [votingOptionId, setVotingOptionId] = useState<string | null>(null);
    const [isClosing, setIsClosing] = useState(false);
    const [showVoters, setShowVoters] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLivePost(post);
    }, [post]);

    const isAuthor = Boolean(identity?.publicKey && livePost.authorPublicKey === identity.publicKey);
    const isClosed = livePost.status === 'completed' || (livePost.pollClosesAt ? new Date(livePost.pollClosesAt).getTime() <= Date.now() : false);
    const authorName = livePost.authorCallsign || (livePost.authorPublicKey ? livePost.authorPublicKey.slice(0, 6) : 'Anonymous');
    const avatarSrc = resolveAvatarUrl((livePost as any).authorAvatarUrl || (livePost as any).author_avatar);

    const rawOptions = livePost.pollOptions;
    let options: PollOption[] = [];
    if (Array.isArray(rawOptions)) {
        options = rawOptions;
    } else if (typeof rawOptions === 'string') {
        try {
            options = JSON.parse(rawOptions);
        } catch {
            options = [];
        }
    }

    const totalVotes = livePost.totalVotes ?? options.reduce((sum, o) => sum + (o.votes || 0), 0);
    const userVotedOptionId = livePost.userVotedOptionId;
    const votesList: PollVoteRecord[] = livePost.pollVotes || [];

    const handleVote = async (optionId: string) => {
        if (isClosed) {
            setError('This poll has ended and can no longer receive votes.');
            return;
        }
        if (!identity) {
            setError('Please connect your member identity to vote.');
            return;
        }

        setVotingOptionId(optionId);
        setError(null);
        try {
            const res = await votePoll(livePost.id, optionId);
            if (res?.post) {
                setLivePost(res.post);
            }
            onVoteSuccess?.();
        } catch (err: any) {
            setError(err.message || 'Could not record your vote.');
        } finally {
            setVotingOptionId(null);
        }
    };

    const handleClosePoll = async () => {
        if (!window.confirm('Are you sure you want to close this poll early? No more votes will be accepted.')) {
            return;
        }

        setIsClosing(true);
        setError(null);
        try {
            const res = await closePoll(livePost.id);
            if (res?.post) {
                setLivePost(res.post);
            } else {
                setLivePost(prev => ({ ...prev, status: 'completed' }));
            }
            onVoteSuccess?.();
        } catch (err: any) {
            setError(err.message || 'Failed to close poll.');
        } finally {
            setIsClosing(false);
        }
    };

    const formatTimeRemaining = () => {
        if (isClosed) return 'Closed';
        const closesAt = livePost.pollClosesAt;
        if (!closesAt) return 'Active';
        const diffMs = new Date(closesAt).getTime() - Date.now();
        if (diffMs <= 0) return 'Closed';
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        if (diffHours < 24) return `Closes in ${diffHours}h`;
        const diffDays = Math.floor(diffHours / 24);
        return `Closes in ${diffDays}d`;
    };

    return (
        <div className="bg-white dark:bg-nature-950 border-2 border-purple-200 dark:border-purple-900/60 rounded-2xl p-4 shadow-sm hover:shadow-md transition-all flex flex-col h-full relative overflow-hidden">
            {/* Header: Badges & Actions */}
            <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-black text-[10px] tracking-wider uppercase px-2.5 py-1 rounded-lg border border-purple-300/40">
                        🗳️ POLL
                    </span>
                    <span
                        className={`text-[10px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-lg border ${
                            isClosed
                                ? 'bg-nature-100 text-nature-600 dark:bg-nature-800 dark:text-nature-400 border-nature-300/40'
                                : 'bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 border-purple-200 dark:border-purple-800'
                        }`}
                    >
                        {formatTimeRemaining()}
                    </span>
                </div>

                {isAuthor && !isClosed && (
                    <button
                        type="button"
                        onClick={handleClosePoll}
                        disabled={isClosing}
                        aria-label={isClosing ? 'Closing poll...' : 'Close poll'}
                        aria-busy={isClosing}
                        className="text-xs font-bold text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 border border-red-200 dark:border-red-900/40 rounded-lg px-3 py-2 min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer disabled:opacity-50"
                    >
                        {isClosing ? 'Closing...' : 'Close Poll'}
                    </button>
                )}
            </div>

            {/* Author Row */}
            <div className="flex items-center gap-2 mb-2">
                <button
                    type="button"
                    onClick={() => onOpenProfile?.(livePost.authorPublicKey)}
                    aria-label={`View ${authorName}'s profile`}
                    className="flex items-center gap-2 cursor-pointer group bg-transparent border-0 p-0 text-left focus:outline-none focus:ring-2 focus:ring-purple-400 rounded-lg"
                >
                    {avatarSrc ? (
                        <img
                            src={avatarSrc}
                            alt={authorName}
                            className="w-6 h-6 rounded-full object-cover border border-nature-200 dark:border-nature-700"
                        />
                    ) : (
                        <div className="w-6 h-6 rounded-full bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300 flex items-center justify-center text-[10px] font-black">
                            {authorName.charAt(0).toUpperCase()}
                        </div>
                    )}
                    <span className="text-xs font-bold text-nature-600 dark:text-nature-300 group-hover:text-nature-900 dark:group-hover:text-white transition-colors">
                        {authorName} {isAuthor && <span className="text-blue-600 dark:text-blue-400 font-extrabold">(You)</span>}
                    </span>
                </button>
            </div>

            {/* Question Title */}
            <h3 className="font-extrabold text-base text-nature-950 dark:text-white mb-1 leading-snug">
                {livePost.title}
            </h3>

            {/* Background Context (if provided) */}
            {livePost.description && (
                <p className="text-xs text-nature-600 dark:text-nature-400 mb-3 whitespace-pre-wrap leading-relaxed">
                    {livePost.description}
                </p>
            )}

            {/* Options List with Live Bars */}
            <div className="space-y-2 mb-3 mt-1">
                {options.map((opt, idx) => {
                    const isVoted = userVotedOptionId === opt.id;
                    const isVotingThis = votingOptionId === opt.id;
                    const pct = opt.percentage ?? (totalVotes > 0 ? Math.round(((opt.votes || 0) / totalVotes) * 100) : 0);
                    const count = opt.votes ?? 0;

                    return (
                        <button
                            key={opt.id || String(idx)}
                            type="button"
                            aria-pressed={isVoted}
                            disabled={isClosed || Boolean(votingOptionId)}
                            onClick={() => handleVote(opt.id)}
                            className={`w-full relative overflow-hidden rounded-xl border text-left transition-all p-3 cursor-pointer group ${
                                isVoted
                                    ? 'border-purple-500 ring-2 ring-purple-400/40 bg-purple-50/30 dark:bg-purple-950/30'
                                    : 'border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 hover:border-purple-300 dark:hover:border-purple-700'
                            } ${isClosed ? 'cursor-default' : ''}`}
                        >
                            {/* Live Progress Bar Fill */}
                            <div
                                role="progressbar"
                                aria-valuenow={pct}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-label={`${opt.text}: ${pct}% of votes`}
                                className={`absolute top-0 bottom-0 left-0 transition-all duration-500 rounded-l-xl ${
                                    isVoted
                                        ? 'bg-purple-200/70 dark:bg-purple-800/50'
                                        : 'bg-purple-100/50 dark:bg-purple-900/25'
                                }`}
                                style={{ width: `${pct}%` }}
                            />

                            {/* Option Row Content */}
                            <div className="relative z-10 flex items-center justify-between gap-3 text-xs">
                                <div className="flex items-center gap-2 min-w-0">
                                    <div
                                        aria-hidden="true"
                                        className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 border text-[9px] font-black ${
                                            isVoted
                                                ? 'bg-purple-600 border-purple-600 text-white'
                                                : 'border-nature-300 dark:border-nature-600 group-hover:border-purple-400'
                                        }`}
                                    >
                                        {isVoted ? '✓' : null}
                                    </div>
                                    <span className={`font-bold truncate ${isVoted ? 'text-purple-950 dark:text-purple-200' : 'text-nature-900 dark:text-white'}`}>
                                        {opt.text}
                                    </span>
                                </div>

                                <div className="flex items-center gap-2 flex-shrink-0 text-right">
                                    <span className="font-black text-nature-700 dark:text-nature-300">
                                        {isVotingThis ? 'Voting...' : `${pct}%`}
                                    </span>
                                    <span className="text-[10px] text-nature-400 dark:text-nature-500">
                                        ({count})
                                    </span>
                                </div>
                            </div>
                        </button>
                    );
                })}
            </div>

            {/* Error Message */}
            {error && (
                <div className="mb-2 p-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400 text-center">
                    {error}
                </div>
            )}

            {/* Footer: Turnout and Voter List Toggle */}
            <div className="mt-auto pt-2 border-t border-nature-100 dark:border-nature-800 flex items-center justify-between text-xs text-nature-500 dark:text-nature-400">
                <span className="font-semibold">
                    📊 {totalVotes} vote{totalVotes === 1 ? '' : 's'} cast
                </span>

                {votesList.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setShowVoters(v => !v)}
                        aria-expanded={showVoters}
                        aria-controls="poll-voters-list"
                        className="text-xs font-bold text-purple-600 dark:text-purple-400 hover:underline cursor-pointer py-2 px-2.5 rounded-lg hover:bg-purple-50 dark:hover:bg-purple-950/40 min-h-[44px] flex items-center"
                    >
                        {showVoters ? 'Hide Voters ▲' : `Show Voters (${votesList.length}) ▼`}
                    </button>
                )}
            </div>

            {/* Collapsible Open Ballot Public Voter List */}
            {showVoters && votesList.length > 0 && (
                <div id="poll-voters-list" className="mt-2.5 pt-2 border-t border-purple-100 dark:border-purple-900/40 max-h-36 overflow-y-auto space-y-1 text-xs">
                    <p className="text-[10px] uppercase tracking-wider font-extrabold text-nature-400 mb-1">
                        Public Village Ballot
                    </p>
                    {votesList.map((vote, idx) => {
                        const opt = options.find(o => o.id === vote.optionId);
                        const voterName = vote.voterCallsign || vote.voterPubkey.slice(0, 8);
                        return (
                            <div
                                key={idx}
                                className="flex items-center justify-between text-[11px] py-0.5 px-1 rounded bg-nature-50 dark:bg-nature-900/40"
                            >
                                <span className="font-bold text-nature-700 dark:text-nature-300">
                                    {voterName}
                                </span>
                                <span className="font-semibold text-purple-600 dark:text-purple-400">
                                    {opt ? opt.text : vote.optionId}
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Village Notice */}
            <p className="mt-2 text-[9px] text-nature-400 dark:text-nature-500 text-center">
                ℹ️ Public signed village voting · Re-voting overwrites choice
            </p>
        </div>
    );
}
