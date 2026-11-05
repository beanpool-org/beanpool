/**
 * PollCard — Interactive Community Poll card for the Marketplace feed (apps/pwa).
 *
 * Implements docs/the-commons.md §3.2, §3.8, §8 specifications:
 * - Displays poll question (title), author, time remaining or closed status.
 * - Options list with live progress bars, vote counts, and percentages.
 * - Tap-to-vote: one member, one vote; re-voting overwrites choice.
 * - Total turnout count & close date.
 * - Anonymous by default (Marty, 2026-09-28): everyone sees the counts. On a poll its creator made an open vote
 *   (`pollOpenVote`), members also get a collapsible list of who voted for what. The card says which.
 * - Author "Close Poll" action for early closure.
 * - Other, where the maker offered it (@beanpool/core poll-other): picking it opens a line to type in. On an anonymous poll the
 *   answer is then final and the card can't say which it was, only that it was given. The words: PollOtherAnswers.
 * - On the global community (`informal`), "An informal poll; it decides nothing", for members and visitors alike: anyone
 *   may join there with a sign-in, so a count can be tipped by one person with several accounts (lib/informal-polls.ts).
 * - Once an anonymous poll has closed, where the node says (the global community's public polls), how many votes came
 *   from new or 12-word accounts (never while it is open, never on an open vote), and
 *   under each answer how many of its own when the node gives that split (@beanpool/core poll-vote-origins). Every vote
 *   still counts; the lines say where votes came from, never whose they are.
 */

import { useState, useEffect, useMemo } from 'react';
import { type PollOption, type PollVoteRecord } from '../lib/marketplace';
import { votePoll, closePoll, myNodeRoleOnce, type MarketplacePost } from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';
import { MemberAvatar } from './MemberAvatar';
import { marked, useFeatureMode } from '../lib/features';
import { LocalCommunityLine, type LocalCommunityWays } from './LocalCommunityMark';
import { LOCAL_COMMUNITY_LINES, pinLive, t, tn } from '@beanpool/core';
import { pollVoteOriginsLine, pollOptionOriginsLine, pollOriginsShown, pollIsSealed, pollOtherLines, pollOtherOption, POLL_OTHER_WORDS_MAX } from '@beanpool/core';
import { PollOtherAnswers } from './PollOtherAnswers';
import {
    CARD_INK, COMPACT_END, COMPACT_LEAD, COMPACT_LINE, COMPACT_MARK, COMPACT_PICTURE, COMPACT_POLL_TILE, COMPACT_ROW, COMPACT_TEXT, COMPACT_TITLE,
    COMPACT_WORD, LIST_TYPE, POLL_CARD, chip,
} from './market-card-shell';

/** Where the compact row splits its mark's one key (`{label} ✓`) round the answer: a character no answer holds. */
const MARK_SPLIT = '\u0001';

interface PollCardProps {
    post: MarketplacePost;
    identity?: BeanPoolIdentity | null;
    onVoteSuccess?: () => void;
    onOpenProfile?: (pubkey: string) => void;
    /**
     * Where the card is drawn. In the Market grid it is given two columns, so the answers get two columns too. In the compact
     * view (slice C1, DESIGN-card-style-box-fable.md §2) the poll is a compact row like a listing's (the question, its quiet
     * status, your answer ✓) that opens the poll's page (`onOpen`); its answers are on that page, never on the row.
     */
    viewMode?: 'grid' | 'list' | 'compact';
    /** The compact row's one press: the Market opens the poll's page, as a listing's row opens its own. */
    onOpen?: () => void;
    /**
     * A visitor to the global lobby (G9b): the question, its answers and the counts, read only. No author row (the node
     * sends none), no voting, and no voter list.
     */
    visitor?: boolean;
    /** The global community's polls (lib/informal-polls.ts): the card says it decides nothing. */
    informal?: boolean;
    /** Where the 🏘️ line's sheet leads besides Start a community: Communities near you, How it works. */
    localWays?: LocalCommunityWays;
}

/**
 * The poll's quiet status, as its card and its grid tile say it: Closed, Active (no end), or the time left. The words are the
 * card's own, so the grid tile (PollGridTile) can never say it differently.
 */
export function pollStatusWords(post: MarketplacePost, isClosed: boolean, now = Date.now()): string {
    if (isClosed) return t('Closed', undefined, 'poll');
    const closesAt = post.pollClosesAt;
    if (!closesAt) return t('Active', undefined, 'poll');
    const diffMs = new Date(closesAt).getTime() - now;
    if (diffMs <= 0) return t('Closed', undefined, 'poll');
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 24) return t('Closes in {n}h', { n: diffHours });
    const diffDays = Math.floor(diffHours / 24);
    return t('Closes in {n}d', { n: diffDays });
}

/**
 * What the card knows about a poll, the one place it is read (the card and the grid tile, PollGridTile): its answers, its
 * total, whether it has closed, its ballot (open vote, sealed) and whether a sealed poll has the member's answer.
 */
export function pollFacts(post: MarketplacePost, now = Date.now()) {
    // Only a poll its creator made an open vote names its voters; a node before the choice sends no flag, and its polls
    // showed voters to members, so a list that comes with the poll is shown there as before.
    const openVote = post.pollOpenVote === true || (post.pollOpenVote === undefined && Array.isArray(post.pollVotes) && post.pollVotes.length > 0);
    const isClosed = post.status === 'completed' || (post.pollClosesAt ? new Date(post.pollClosesAt).getTime() <= now : false);
    const authorName = post.authorCallsign || (post.authorPublicKey ? post.authorPublicKey.slice(0, 6) : t('Anonymous'));
    const avatarSrc = resolveAvatarUrl((post as any).authorAvatarUrl || (post as any).author_avatar);

    const rawOptions = post.pollOptions;
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

    const totalVotes = post.totalVotes ?? options.reduce((sum, o) => sum + (o.votes || 0), 0);
    const sealed = pollIsSealed(options, post.pollOpenVote);
    const answered = sealed && post.pollAnswered === true;
    return { openVote, isClosed, authorName, avatarSrc, options, totalVotes, sealed, answered };
}

export function PollCard({ post, identity, onVoteSuccess, onOpenProfile, viewMode, onOpen, visitor = false, informal = false, localWays }: PollCardProps) {
    const decisionsMarked = marked(useFeatureMode('decisions'));
    const [livePost, setLivePost] = useState<MarketplacePost>(post);
    const [votingOptionId, setVotingOptionId] = useState<string | null>(null);
    const [isClosing, setIsClosing] = useState(false);
    const [showVoters, setShowVoters] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [typingOther, setTypingOther] = useState(false);
    const [otherWords, setOtherWords] = useState('');
    const [ownerHere, setOwnerHere] = useState(false);

    useEffect(() => {
        setLivePost(post);
    }, [post]);

    // `grid`: the card given two columns (the Market's grid draws PollGridTile now, Marty 5 Nov 2026). List and the
    // single-post view give it the full width of a page column, where a single answer column already fits.
    const isGrid = viewMode === 'grid';
    // An answer is a choice only where it can be read whole: on the poll's own page (no viewMode), where the grid's tile
    // opens it to be voted, and in the two-column card. The Market's list keeps its one line, as it was.
    const answersWhole = viewMode !== 'list';

    const { openVote, isClosed, authorName, avatarSrc, options, totalVotes, sealed, answered } = pollFacts(livePost);
    const isAuthor = Boolean(identity?.publicKey && livePost.authorPublicKey === identity.publicKey);
    // Where its votes came from: only once an anonymous poll has closed. While it is open the card says nothing about it,
    // not even that it will (the node sends nothing then either: @beanpool/engine pollOriginsMayShow).
    const showOrigins = pollOriginsShown(isClosed, openVote);
    const originsLine = showOrigins ? pollVoteOriginsLine(totalVotes, livePost.pollNewOrWordsVotes) : null;
    const userVotedOptionId = livePost.userVotedOptionId;
    const votesList: PollVoteRecord[] = livePost.pollVotes || [];

    // ⚡ Bolt: O(1) Map lookup for poll option metadata in open ballot voter list instead of O(O) .find() scans
    const optionsById = useMemo(() => new Map(options.map(o => [o.id, o])), [options]);

    const offersOther = pollOtherOption(options) !== null;
    // Only a card with words to offer asks; a member's card asks nothing. The node decides who reads.
    // The compact row shows no answers' words, so a row asks nothing either.
    const asksRole = offersOther && !visitor && !isAuthor && Boolean(identity) && viewMode !== 'compact';
    useEffect(() => {
        if (!asksRole) return;
        let cancelled = false;
        void myNodeRoleOnce().then(role => { if (!cancelled && role === 'owner') setOwnerHere(true); });
        return () => { cancelled = true; };
    }, [asksRole]);

    const sendVote = async (optionId: string, typed?: string) => {
        setVotingOptionId(optionId);
        setError(null);
        try {
            const res = await (typed === undefined ? votePoll(livePost.id, optionId) : votePoll(livePost.id, optionId, typed));
            if (res?.post) {
                setLivePost(res.post);
            }
            setTypingOther(false);
            setOtherWords('');
            onVoteSuccess?.();
        } catch (err: any) {
            setError(err.message || t('Could not record your vote.'));
        } finally {
            setVotingOptionId(null);
        }
    };

    const handleVote = async (optionId: string, typed?: string) => {
        if (isClosed) {
            setError(t('This poll has ended and can no longer receive votes.'));
            return;
        }
        if (!identity) {
            setError(t('Please connect your member identity to vote.'));
            return;
        }

        if (userVotedOptionId && userVotedOptionId !== optionId) {
            const currentOpt = options.find(o => o.id === userVotedOptionId);
            const currentLabel = currentOpt ? (currentOpt.other ? pollOtherLines.other() : currentOpt.text) : (userVotedOptionId ?? '');
            const newOpt = options.find(o => o.id === optionId);
            const newLabel = newOpt ? (newOpt.other ? pollOtherLines.other() : newOpt.text) : optionId;
            if (!window.confirm(t('You voted for “{current}”. Change it to “{new}”?', { current: currentLabel, new: newLabel }))) {
                return;
            }
        }

        await sendVote(optionId, typed);
    };

    const handleClosePoll = async () => {
        if (!window.confirm(t('Are you sure you want to close this poll early? No more votes will be accepted.'))) {
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
            setError(err.message || t('Failed to close poll.'));
        } finally {
            setIsClosing(false);
        }
    };

    const formatTimeRemaining = () => pollStatusWords(livePost, isClosed);

    const pinned = pinLive(post as any);

    if (viewMode === 'compact') {
        // The compact row (slice C1; the phone's, #2903): the poll's tile where a listing's picture is, the question on one line,
        // then 📌 PINNED and its quiet status ("Closes in 11d", "Closed"), and, when the member has answered, that answer ✓ on a
        // line of its own, the mark an event's row has (the answer gives way, the ✓ never does). A sealed poll (anonymous with
        // Other) names no answer: the node cannot say which, and the page says that it has one. POLL at the end. The whole row
        // is one button that opens the poll's page, where its answers are: no answer, no Close Poll and no voter list here.
        const chosen = sealed ? undefined : options.find(o => o.id === userVotedOptionId);
        const chosenText = chosen ? (chosen.other ? pollOtherLines.other() : chosen.text) : null;
        const rowMark = chosenText ? t('{label} ✓', { label: chosenText }) : null;
        // The one key, split where the answer goes, so each language keeps its own order; a key that cannot be split is drawn whole.
        const markPieces = chosenText ? t('{label} ✓', { label: MARK_SPLIT }).split(MARK_SPLIT) : [];
        const status = formatTimeRemaining();
        return (
            <div data-testid="poll-card" className="w-full min-w-0">
                <button
                    type="button"
                    data-testid="poll-compact-row"
                    onClick={onOpen}
                    disabled={!onOpen}
                    aria-label={[t('Open poll: {title}', { title: livePost.title }), status, rowMark].filter(Boolean).join(', ')}
                    className={`${COMPACT_ROW} text-start disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-nature-500`}
                >
                    <span className={COMPACT_LEAD}>
                        <span data-testid="compact-picture" className={COMPACT_PICTURE}>
                            <span aria-hidden="true" className={COMPACT_POLL_TILE}>🗳️</span>
                        </span>
                        <span className={COMPACT_TEXT}>
                            <span dir="auto" data-testid="poll-row-question" className={`block ${COMPACT_TITLE}`}>{livePost.title}</span>
                            <span data-testid="poll-compact-line" className={`${COMPACT_LINE} font-medium ${CARD_INK.secondary}`}>
                                {pinned && <><span data-testid="poll-pinned-chip" className={COMPACT_WORD.pinned}>{t('📌 PINNED')}</span>{' · '}</>}
                                <span data-testid="poll-status">{status}</span>
                            </span>
                            {rowMark && (markPieces.length === 2 ? (
                                <span data-testid="poll-mark" className={`flex min-w-0 text-[11px] leading-snug ${COMPACT_MARK}`}>
                                    <span dir="auto" className="min-w-0 truncate">{markPieces[0]}{chosenText}</span>
                                    {markPieces[1] && <span className="shrink-0 whitespace-pre">{markPieces[1]}</span>}
                                </span>
                            ) : (
                                <span data-testid="poll-mark" className={`${COMPACT_LINE} ${COMPACT_MARK}`}>{rowMark}</span>
                            ))}
                        </span>
                    </span>
                    <span className={COMPACT_END}>
                        <span data-testid="poll-badge" className={chip('poll')}><span aria-hidden="true">🗳️ </span>{t('POLL')}</span>
                    </span>
                </button>
            </div>
        );
    }

    return (
        <div data-testid="poll-card" className={POLL_CARD}>
            {/* Header: the chips from the style box (📌 PINNED, POLL in the poll's plum, its quiet status), Close Poll at the right */}
            <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-1 flex-wrap min-w-0">
                    {pinned && (
                        <span data-testid="poll-pinned-chip" className={chip('pinned')}>
                            {t('📌 PINNED')}
                        </span>
                    )}
                    <span data-testid="poll-badge" className={chip('poll')}>
                        <span aria-hidden="true">🗳️ </span>{t('POLL')}
                    </span>
                    <span data-testid="poll-status" className={chip('quiet')}>
                        {formatTimeRemaining()}
                    </span>
                </div>

                {isAuthor && !isClosed && (
                    <button
                        type="button"
                        onClick={handleClosePoll}
                        disabled={isClosing}
                        aria-label={isClosing ? t('Closing poll...') : t('Close poll')}
                        aria-busy={isClosing}
                        className="text-xs font-bold text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 border border-red-200 dark:border-red-900/40 rounded-lg px-3 py-2 min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                        {isClosing ? t('Closing...') : t('Close Poll')}
                    </button>
                )}
            </div>

            {/* Author Row: never for a visitor, whom the node sends no author. */}
            {!visitor && (
            <div className="flex items-center gap-2 mb-2">
                {onOpenProfile ? (
                    <button
                        type="button"
                        onClick={() => onOpenProfile(livePost.authorPublicKey)}
                        aria-label={t("View {name}'s profile", { name: authorName })}
                        className="flex items-center gap-2 cursor-pointer group bg-transparent border-0 p-0 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                    >
                        <MemberAvatar avatarUrl={avatarSrc} pubkey={livePost.authorPublicKey} callsign={authorName} size={24} className="border border-nature-200 dark:border-nature-700" />
                        <span className="text-xs font-bold text-nature-600 dark:text-nature-300 group-hover:text-nature-900 dark:group-hover:text-white transition-colors">
                            {authorName} {isAuthor && <span className="text-blue-600 dark:text-blue-400 font-extrabold">{t('(You)')}</span>}
                        </span>
                    </button>
                ) : (
                    // On a card in the Market's list or grid the poster is shown, not pressed: a small card opens its item, never the
                    // poster's profile (Marty, 4 Nov). The poll's own page passes `onOpenProfile`, and there the poster is a button.
                    <div data-testid="poll-author" className="flex items-center gap-2 text-left">
                        <MemberAvatar avatarUrl={avatarSrc} pubkey={livePost.authorPublicKey} callsign={authorName} size={24} className="border border-nature-200 dark:border-nature-700" />
                        <span className="text-xs font-bold text-nature-600 dark:text-nature-300">
                            {authorName} {isAuthor && <span className="text-blue-600 dark:text-blue-400 font-extrabold">{t('(You)')}</span>}
                        </span>
                    </div>
                )}
            </div>
            )}

            {/* The question: the list card's loud line, 16/900 */}
            <h3 dir="auto" className={`m-0 mb-1 break-words ${LIST_TYPE.loud} ${CARD_INK.title}`}>
                {livePost.title}
            </h3>

            {/* Background Context (if provided) */}
            {/* In the grid two lines at most, so the poll fits its 2 x 2 square (DESIGN-market-grid-sizes-fable.md §2.3); the
                whole of it is on the poll's page. */}
            {livePost.description && (
                <p data-testid="poll-description" className={`text-[13px] text-nature-600 dark:text-nature-400 mb-3 whitespace-pre-wrap leading-relaxed${isGrid ? ' line-clamp-2' : ''}`}>
                    {livePost.description}
                </p>
            )}

            {/* Options List with Live Bars */}
            <div className={isGrid ? 'grid grid-cols-1 md:grid-cols-2 gap-2 mb-3 mt-1' : 'space-y-2 mb-3 mt-1'}>
                {options.map((opt, idx) => {
                    const isVoted = userVotedOptionId === opt.id;
                    const isVotingThis = votingOptionId === opt.id;
                    const pct = opt.percentage ?? (totalVotes > 0 ? Math.round(((opt.votes || 0) / totalVotes) * 100) : 0);
                    const count = opt.votes ?? 0;
                    const optionOrigins = showOrigins ? pollOptionOriginsLine(count, opt.newOrWordsVotes) : null;

                    const optionText = opt.other ? pollOtherLines.other() : opt.text;

                    const row = (
                        <>
                            {/* Live Progress Bar Fill */}
                            <div
                                role="progressbar"
                                aria-valuenow={pct}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-label={t('{option}: {pct}% of votes', { option: optionText, pct })}
                                className={`absolute top-0 bottom-0 left-0 transition-all duration-500 rounded-l-xl ${
                                    isVoted
                                        ? 'bg-purple-200/70 dark:bg-purple-800/50'
                                        : 'bg-purple-100/50 dark:bg-purple-900/25'
                                }`}
                                style={{ width: `${pct}%` }}
                            />

                            {/* Option Row Content */}
                            {/* The answer keeps at least three-fifths of the row; a percentage a longer language writes wider than
                                the rest drops to its own line rather than cutting what the member wrote. */}
                            <div className="relative z-10 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                                <div className="flex items-center gap-2 min-w-0 flex-1 basis-3/5">
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
                                    <span className={`font-bold ${answersWhole ? 'break-words' : 'truncate'} ${isVoted ? 'text-purple-950 dark:text-purple-200' : 'text-nature-900 dark:text-white'}`}>
                                        {optionText}
                                    </span>
                                </div>

                                <div className="flex items-center gap-2 flex-shrink-0 ml-auto text-right">
                                    <span className="font-black text-nature-700 dark:text-nature-300">
                                        {isVotingThis ? t('Voting...') : t('{rate}%', { rate: pct })}
                                    </span>
                                    <span className="text-[10px] text-nature-400 dark:text-nature-400">
                                        ({count})
                                    </span>
                                </div>
                            </div>
                            {optionOrigins && (
                            <span className="relative z-10 mt-1 pl-6 block text-[0.625rem] font-semibold text-nature-500 dark:text-nature-400 break-words" data-testid="poll-option-origins">
                                {optionOrigins}
                            </span>
                            )}
                        </>
                    );
                    // A visitor reads the answers and their counts; there is nothing to press.
                    if (visitor) {
                        return (
                            <div key={opt.id || String(idx)} data-testid="poll-option-readonly"
                                className="w-full relative overflow-hidden rounded-xl border text-left p-3 border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900">
                                {row}
                            </div>
                        );
                    }
                    return (
                        <button
                            key={opt.id || String(idx)}
                            type="button"
                            aria-pressed={isVoted}
                            disabled={isClosed || Boolean(votingOptionId) || answered}
                            onClick={() => (opt.other ? setTypingOther(v => !v) : handleVote(opt.id))}
                            className={`w-full relative overflow-hidden rounded-xl border text-left transition-all p-3 cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-1 ${
                                isVoted
                                    ? 'border-purple-500 ring-2 ring-purple-400/40 bg-purple-50/30 dark:bg-purple-950/30'
                                    : 'border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 hover:border-purple-300 dark:hover:border-purple-700'
                            } ${isClosed ? 'cursor-default' : ''}`}
                        >
                            {row}
                        </button>
                    );
                })}
            </div>

            {/* Other: a line to type, and what becomes of it. */}
            {typingOther && !visitor && !isClosed && !answered && (() => {
                const other = pollOtherOption(options)!;
                const typed = otherWords.trim();
                return (
                    <div className="mb-3 p-3 rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50/40 dark:bg-purple-950/20" data-testid="poll-other-box">
                        <input
                            type="text"
                            value={otherWords}
                            maxLength={POLL_OTHER_WORDS_MAX}
                            onChange={e => setOtherWords(e.target.value)}
                            placeholder={pollOtherLines.placeholder()}
                            aria-label={pollOtherLines.placeholder()}
                            data-testid="poll-other-words"
                            className="w-full min-w-0 rounded-lg border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-900 dark:text-white text-sm p-2 focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                        <p className="mt-1 text-[11px] font-bold text-nature-700 dark:text-nature-300 break-words" data-testid="poll-other-no-name">{pollOtherLines.noName()}</p>
                        {sealed && <p className="mt-0.5 text-[11px] text-nature-600 dark:text-nature-400 break-words">{pollOtherLines.sealedNote()}</p>}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                disabled={!typed || Boolean(votingOptionId)}
                                onClick={() => handleVote(other.id, typed)}
                                data-testid="poll-other-send"
                                className="min-h-[44px] px-3 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                            >
                                {pollOtherLines.send()}
                            </button>
                            <button
                                type="button"
                                onClick={() => setTypingOther(false)}
                                className="min-h-[44px] px-3 rounded-lg text-xs font-bold text-nature-600 dark:text-nature-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                            >
                                {pollOtherLines.cancel()}
                            </button>
                            <span className="ml-auto text-[10px] text-nature-500 dark:text-nature-400">{otherWords.length}/{POLL_OTHER_WORDS_MAX}</span>
                        </div>
                    </div>
                );
            })()}
            {answered && (
            <p className="mb-2 text-[11px] font-bold text-purple-700 dark:text-purple-300 break-words" data-testid="poll-answered">
                <span aria-hidden="true">✓ </span>{pollOtherLines.answered()}
            </p>
            )}

            {/* On the global community: a show of opinion, never a decision. Said to visitors too, before they join to vote. */}
            {informal && (
            <p className="mb-1 text-[11px] font-semibold text-purple-700 dark:text-purple-300" data-testid="poll-informal-note">
                {/* lib/informal-polls.ts INFORMAL_POLL_NOTE, the phone's key (utils/node-profile.ts). */}
                <span aria-hidden="true">💬 </span>{t('An informal poll; it decides nothing')}
            </p>
            )}
            {/* Decisions live in a local community here: where one would bind, said once under the note (design §1 row 7). */}
            {decisionsMarked && (
            <div className="mb-1" data-testid="poll-decision-line">
                <LocalCommunityLine feature="decisions" text={t(LOCAL_COMMUNITY_LINES.poll)} {...localWays} />
            </div>
            )}

            {/* Where its votes came from, once it has closed, where the node says: all of them still count. In rem, so a
                larger text setting makes it larger too. */}
            {originsLine && (
            <p className="mb-1 text-[0.6875rem] font-semibold text-nature-600 dark:text-nature-300 break-words" data-testid="poll-vote-origins">
                <span aria-hidden="true">🌱 </span>{originsLine}
            </p>
            )}

            {/* Which ballot this is, said before anyone votes: anonymous unless its creator made it an open vote. */}
            {!visitor && (openVote ? (
            <p className="mb-2 text-[11px] font-semibold text-nature-500 dark:text-nature-400" data-testid="poll-open-ballot-note">
                <span aria-hidden="true">👁️ </span>{t('Open vote: members can see who chose what')}
            </p>
            ) : (
            <p className="mb-2 text-[11px] font-semibold text-nature-500 dark:text-nature-400" data-testid="poll-anonymous-note">
                <span aria-hidden="true">🔒 </span>{t('Anonymous: everyone sees only the totals')}
            </p>
            ))}

            {/* Error Message */}
            {error && (
                <div className="mb-2 p-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400 text-center">
                    {error}
                </div>
            )}

            {/* Footer: Turnout and Voter List Toggle */}
            <div className="mt-auto pt-2 border-t border-nature-100 dark:border-nature-800 flex items-center justify-between text-xs text-nature-500 dark:text-nature-400">
                <span className="font-semibold">
                    <span aria-hidden="true">📊 </span>{tn(totalVotes, '{n} vote cast', '{n} votes cast')}
                </span>

                {!visitor && openVote && votesList.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setShowVoters(v => !v)}
                        aria-expanded={showVoters}
                        aria-controls="poll-voters-list"
                        className="text-xs font-bold text-purple-600 dark:text-purple-400 hover:underline cursor-pointer py-2 px-2.5 rounded-lg hover:bg-purple-50 dark:hover:bg-purple-950/40 min-h-[44px] flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                    >
                        {showVoters ? t('Hide Voters ▲') : t('Show Voters ({n}) ▼', { n: votesList.length })}
                    </button>
                )}
            </div>

            {/* Collapsible Open Ballot Public Voter List */}
            {!visitor && openVote && showVoters && votesList.length > 0 && (
                <div id="poll-voters-list" className="mt-2.5 pt-2 border-t border-purple-100 dark:border-purple-900/40 max-h-36 overflow-y-auto space-y-1 text-xs">
                    <p className="text-[10px] uppercase tracking-wider font-extrabold text-nature-400 mb-1">
                        {t('Open vote')}
                    </p>
                    {votesList.map((vote, idx) => {
                        const opt = optionsById.get(vote.optionId);
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
                                    {opt ? (opt.other ? pollOtherLines.other() : opt.text) : vote.optionId}
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* The words, for the poll's maker and the owners. */}
            {offersOther && !visitor && (isAuthor || ownerHere) && <PollOtherAnswers postId={livePost.id} />}

            {/* Village Notice: the re-vote line is not in the grid, where the ballot note above says which ballot it is and the
                square has no row to spare (§2.3); it stays in list and compact and on the poll's page. A sealed poll's line
                stays everywhere: an answer there is final, and the grid's answers can be pressed. */}
            {!visitor && (!isGrid || sealed) && (
            <p className="mt-2 text-[9px] text-nature-400 dark:text-nature-400 text-center">
                <span aria-hidden="true">ℹ️ </span>{sealed ? pollOtherLines.sealedNote() : openVote ? t('Open vote · Re-voting overwrites choice') : t('Anonymous vote · Re-voting overwrites choice')}
            </p>
            )}
        </div>
    );
}
