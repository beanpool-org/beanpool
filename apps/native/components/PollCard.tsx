/**
 * PollCard — Interactive Community Poll card for the Marketplace feed (apps/native).
 *
 * Implements docs/the-commons.md §3.2, §3.8 and §8 specifications:
 * - Shows question (title), author, time ago, and category (community).
 * - Options list with live progress bars, vote counts, and percentages.
 * - Tap-to-vote: one member, one vote; re-voting overwrites choice.
 * - Turnout tally & close date or "Closed" badge.
 * - Anonymous by default (Marty, 2026-09-28): everyone sees the counts. On a poll its creator made an open vote
 *   (`pollOpenVote`, `poll_open_vote` in the phone's cache), members also get a collapsible list of who voted for what.
 *   The card says which.
 * - Author "Close Poll" action for early closure.
 * - On the worldwide community (`informal`), "An informal poll; it decides nothing": anyone may join there with a sign-in,
 *   so a count can be tipped by one person with several accounts (utils/node-profile.ts pollsInformal).
 * - Once an anonymous poll has closed, where the node says (the worldwide community's public polls), how many votes came
 *   from new or 12-word accounts (never while it is open, never on an open vote), and
 *   under each answer how many of its own when the node gives that split (@beanpool/core poll-vote-origins; the count is
 *   `poll_new_or_words_votes` in the phone's cache). Every vote still counts; the lines say where votes came from, never
 *   whose they are.
 */

import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Pressable,
    ActivityIndicator,
    TextInput,
} from 'react-native';
import { Alert } from '../utils/keyboard-alert';
import { MemberAvatar } from './MemberAvatar';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import { votePoll, closePoll, isOwnerHere, unpinPostOnNode, getPost } from '../utils/db';
import { isPostPinned, pinnedDetailLine, showPinMenu, pinFailureText } from '../utils/pins';
import { usePinRole } from '../utils/use-pin-role';
import { PinSheet } from './PinSheet';
import { INFORMAL_POLL_NOTE } from '../utils/node-profile';
import { pollVoteOriginsLine, pollOptionOriginsLine, pollOriginsShown, pollIsSealed, pollOtherLines, pollOtherOption, POLL_OTHER_WORDS_MAX, LOCAL_COMMUNITY_LINES, t, tn } from '@beanpool/core';
import { PollOtherAnswers } from './PollOtherAnswers';
import { LocalCommunityMark } from './showcase/LocalCommunityMark';
import { signedRequestWords } from './signed-request-lines';
import { MARKET_CARD_SHELL, MARKET_CARD_TYPE } from '@beanpool/core';
import { CardChip, useCardShell } from './market-card-shell';

export interface PollOption {
    id: string;
    text: string;
    votes?: number;
    percentage?: number;
    /** Of this option's votes, how many came from new or 12-word accounts, where the node gives the split. */
    newOrWordsVotes?: number;
    /** This answer is Other, which takes typed words (@beanpool/core poll-other). Only the node sets it. */
    other?: boolean;
}

export interface PollVoteRecord {
    voterPubkey: string;
    voterCallsign?: string;
    optionId: string;
    createdAt: string;
}

/** Where the compact row splits its mark's one key (`{label} ✓`) round the answer: a character no answer holds. */
const MARK_SPLIT = '\u0001';

/** Lines kept as word() elsewhere, shown here in the member's language. */
const LINES = { informal: INFORMAL_POLL_NOTE };

interface PollCardProps {
    post: any;
    currentPubkey?: string | null;
    onVoteSuccess?: () => void;
    /** The worldwide community's polls (utils/node-profile.ts pollsInformal): the card says it decides nothing. */
    informal?: boolean;
    /** Where the node previews Decisions (the showcase): the marker's line under the note, "a Decision binds" (design §1 row 7). */
    decisionsPreview?: boolean;
    /** The node's profile says pins are on (`features.pins`): the Market, which has the profile, says so; the card asks nothing of it. */
    pinsOn?: boolean;
    /**
     * The Market's view (slice C1, DESIGN-card-style-box-fable.md §2): in the compact view the poll is a compact row like a
     * listing's (the question, its quiet status, your answer ✓) that opens the poll's page; its answers are on that page,
     * never on the row. The list and the grid draw the card. None: the poll's own page (app/post/[id].tsx), where the grid's
     * poll tile sends members to vote (Marty, 5 Nov 2026), so each answer is shown whole there, as on the web's page.
     */
    viewMode?: 'list' | 'grid' | 'compact';
    /** The compact row's one press: the Market opens the poll's page (/post/{id}). */
    onOpen?: () => void;
    /**
     * The poll's page (app/post/[id].tsx): its author's name opens their profile, as every page's author does. The Market's
     * card has none: a profile is opened from inside the item (Marty, 4 Nov).
     */
    onOpenProfile?: (who: { publicKey: string; callsign: string }) => void;
}

/**
 * The poll's quiet status, as its card and its grid tile say it: Closed, Active (no end), or the time left. The card's own
 * words, so the grid tile (PollGridTile) can never say it differently.
 */
export function pollStatusWords(post: any, isClosed: boolean, now = Date.now()): string {
    if (isClosed) return t('Closed', undefined, 'poll');
    const closesAt = post.pollClosesAt || post.poll_closes_at;
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
export function pollFacts(post: any, now = Date.now()) {
    const closesAt = post.pollClosesAt || post.poll_closes_at;
    const isClosed = post.status === 'completed' || (closesAt ? new Date(closesAt).getTime() <= now : false);
    const authorName: string = post.author_callsign || post.authorCallsign || (post.author_pubkey ? post.author_pubkey.slice(0, 6) : t('Unknown'));
    const avatarUrl = post.author_avatar || post.authorAvatarUrl;

    const rawOptions = post.pollOptions || post.poll_options;
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

    const totalVotes: number = post.totalVotes ?? options.reduce((sum, o) => sum + (o.votes || 0), 0);
    const userVotedOptionId: string | undefined = post.userVotedOptionId;
    const votesList: PollVoteRecord[] = post.pollVotes || [];
    // Only a poll its creator made an open vote names its voters. A node before the choice sends no flag, and its polls
    // showed voters to members, so a list that comes with such a poll is shown as before.
    const openFlag = post.pollOpenVote ?? post.poll_open_vote;
    const openVote = openFlag === true || openFlag === 1 || (openFlag === undefined && votesList.length > 0);
    const sealed = pollIsSealed(options, openFlag);
    // The node's word on a card it sent, or this phone's own record of its answer (utils/db.ts votePoll).
    const answered = sealed && (post.pollAnswered === true || !!userVotedOptionId);
    return { isClosed, authorName, avatarUrl, options, totalVotes, userVotedOptionId, votesList, openVote, sealed, answered };
}

/**
 * The card's vote, the one path for the card and the grid's tile (PollGridTile, voted in place when the whole poll is in front
 * of the member: Marty and Damo, 6 Nov 2026): votePoll, the node's answer drawn in place (`setLivePost`), and a change of vote
 * asked first (#2907: "Change your vote?", Keep my vote / Change). `onSent` is the card's own tidy-up after a vote (its Other
 * line).
 */
export function usePollVote(
    livePost: any,
    setLivePost: (post: any) => void,
    { currentPubkey, onVoteSuccess, onSent, inline = false }: {
        currentPubkey?: string | null; onVoteSuccess?: () => void; onSent?: () => void;
        /** The node's refusal shown where the vote was cast (`error`, the grid's tile), not in an Alert (the card). */
        inline?: boolean;
    },
) {
    const [votingOptionId, setVotingOptionId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { isClosed, options, userVotedOptionId } = pollFacts(livePost);

    const sendVote = async (optionId: string, typed?: string) => {
        setVotingOptionId(optionId);
        setError(null);
        try {
            const res = await (typed === undefined ? votePoll(livePost.id, optionId) : votePoll(livePost.id, optionId, typed));
            if (res?.post) {
                setLivePost(res.post);
            }
            onSent?.();
            onVoteSuccess?.();
        } catch (err: any) {
            const words = err.message ? signedRequestWords(err.message) : t('Could not record your vote.');
            if (inline) setError(words);
            else Alert.alert(t('Voting Error'), words);
        } finally {
            setVotingOptionId(null);
        }
    };

    const handleVote = async (optionId: string, typed?: string) => {
        if (isClosed) {
            Alert.alert(t('Poll Closed'), t('This poll has ended and can no longer receive votes.'));
            return;
        }
        if (!currentPubkey) {
            Alert.alert(t('Sign In Required'), t('Please connect your member identity to vote in polls.'));
            return;
        }

        if (userVotedOptionId && userVotedOptionId !== optionId) {
            const currentOpt = options.find(o => o.id === userVotedOptionId);
            const currentLabel = currentOpt ? (currentOpt.other ? pollOtherLines.other() : currentOpt.text) : (userVotedOptionId ?? '');
            const newOpt = options.find(o => o.id === optionId);
            const newLabel = newOpt ? (newOpt.other ? pollOtherLines.other() : newOpt.text) : optionId;
            Alert.alert(
                t('Change your vote?'),
                t('You voted for “{current}”. Change it to “{new}”?', { current: currentLabel, new: newLabel }),
                [
                    { text: t('Keep my vote'), style: 'cancel' },
                    {
                        text: t('Change'),
                        onPress: () => {
                            void sendVote(optionId, typed);
                        },
                    },
                ]
            );
            return;
        }

        await sendVote(optionId, typed);
    };

    return { votingOptionId, error, handleVote };
}

export function PollCard({ post, currentPubkey, onVoteSuccess, informal = false, decisionsPreview = false, pinsOn = false, viewMode, onOpen, onOpenProfile }: PollCardProps) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    // The style box (components/market-card-shell.ts): the card's shell, its chips and the compact row.
    const shell = useCardShell();

    const [livePost, setLivePost] = useState(post);
    const [isClosing, setIsClosing] = useState(false);
    const [showVoters, setShowVoters] = useState(false);
    const [typingOther, setTypingOther] = useState(false);
    const [otherWords, setOtherWords] = useState('');
    const [ownerHere, setOwnerHere] = useState(false);
    const [showPinSheet, setShowPinSheet] = useState(false);
    const [unpinning, setUnpinning] = useState(false);
    // The "···" is for an owner or admin (Pin, Take the pin off) and for a pinned poll's author (Take the pin off).
    const pinRole = usePinRole(pinsOn, currentPubkey);

    // Keep livePost in sync if prop changes
    React.useEffect(() => {
        setLivePost((prev: any) => ({
            ...post,
            pollVotes: (prev?.pollVotes && prev.pollVotes.length > 0) ? prev.pollVotes : post.pollVotes,
        }));
    }, [post]);

    const isAuthor = Boolean(currentPubkey && (livePost.author_pubkey === currentPubkey || livePost.authorPublicKey === currentPubkey));
    const { isClosed, authorName, avatarUrl, options, totalVotes, userVotedOptionId, votesList, openVote, sealed, answered } = pollFacts(livePost);
    // Where its votes came from: only once an anonymous poll has closed. While it is open the card says nothing about it,
    // not even that it will (the node sends nothing then either: @beanpool/engine pollOriginsMayShow).
    const showOrigins = pollOriginsShown(isClosed, openVote);
    const originsLine = showOrigins ? pollVoteOriginsLine(totalVotes, livePost.pollNewOrWordsVotes ?? livePost.poll_new_or_words_votes) : null;

    // ⚡ Bolt: O(1) Map lookup for poll option metadata in open ballot voter list instead of O(O) .find() scans
    const optionsById = React.useMemo(() => new Map(options.map(o => [o.id, o])), [options]);

    const offersOther = pollOtherOption(options) !== null;
    // Only a card with words to offer asks; a member's card asks nothing. The node decides who reads.
    const asksRole = offersOther && !isAuthor && Boolean(currentPubkey);
    React.useEffect(() => {
        if (!asksRole) return;
        let cancelled = false;
        void isOwnerHere().then(owner => { if (!cancelled && owner) setOwnerHere(true); });
        return () => { cancelled = true; };
    }, [asksRole]);

    // The vote, the one path the grid's tile votes by too: after a vote the Other line closes and empties.
    const { votingOptionId, handleVote } = usePollVote(livePost, setLivePost, {
        currentPubkey, onVoteSuccess, onSent: () => { setTypingOther(false); setOtherWords(''); },
    });

    const handleClosePoll = () => {
        Alert.alert(
            t('Close Poll'),
            t('Are you sure you want to close this poll early? No more votes will be accepted.'),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Close Poll'),
                    style: 'destructive',
                    onPress: async () => {
                        setIsClosing(true);
                        try {
                            const res = await closePoll(livePost.id);
                            if (res?.post) {
                                setLivePost(res.post);
                            } else {
                                setLivePost((prev: any) => ({ ...prev, status: 'completed' }));
                            }
                            onVoteSuccess?.();
                        } catch (err: any) {
                            Alert.alert(t('Error'), err.message ? signedRequestWords(err.message) : t('Failed to close poll'));
                        } finally {
                            setIsClosing(false);
                        }
                    },
                },
            ]
        );
    };

    const formatTimeRemaining = () => pollStatusWords(livePost, isClosed);

    const handlePollOptions = () => {
        const pinned = isPostPinned(livePost);
        if (pinned) {
            Alert.alert(t('Poll options'), undefined, [
                {
                    text: t('Take the pin off'),
                    style: 'destructive',
                    onPress: async () => {
                        if (unpinning) return;
                        setUnpinning(true);
                        try {
                            await unpinPostOnNode(livePost.id);
                            const updated = await getPost(livePost.id);
                            if (updated) {
                                setLivePost((prev: any) => ({
                                    ...prev,
                                    pinned_until: updated.pinned_until,
                                    pinned_at: updated.pinned_at,
                                    pinnedUntil: updated.pinnedUntil,
                                    pinnedAt: updated.pinnedAt,
                                }));
                            }
                        } catch (e: any) {
                            Alert.alert(t('Error'), pinFailureText(e, t('Failed to unpin post')));
                        } finally {
                            setUnpinning(false);
                        }
                    },
                },
                { text: t('Cancel'), style: 'cancel' },
            ]);
        } else {
            Alert.alert(t('Poll options'), undefined, [
                {
                    text: t('Pin to the top…'),
                    onPress: () => setShowPinSheet(true),
                },
                { text: t('Cancel'), style: 'cancel' },
            ]);
        }
    };

    const pinned = isPostPinned(livePost);
    const authorKey: string = livePost.author_pubkey || livePost.authorPublicKey || '';

    if (viewMode === 'compact') {
        // The compact row (slice C1): the poll's tile where a listing's picture is, the question on one line, then its quiet
        // status and, when the member has answered, that answer ✓, the mark an event's row has; POLL at the end. A sealed poll
        // (anonymous with Other) names no answer: the node cannot say which, and the page says that it has one. The whole row is
        // one press that opens the poll's page, where its answers are: no answer, no Close Poll and no ··· on the row.
        const chosen = sealed ? undefined : options.find(o => o.id === userVotedOptionId);
        const chosenText = chosen ? (chosen.other ? pollOtherLines.other() : chosen.text) : null;
        const rowMark = chosenText ? t('{label} ✓', { label: chosenText }) : null;
        // The mark on a line of its own: the answer gives way ("Better matches…") and the ✓ stays. The one key, split where the
        // answer goes, so each language keeps its own order; a key that cannot be split is drawn whole.
        const markPieces = chosenText ? t('{label} ✓', { label: MARK_SPLIT }).split(MARK_SPLIT) : [];
        const [markBefore, markAfter] = markPieces.length === 2 ? markPieces : [null, null];
        const status = formatTimeRemaining();
        // 📌 PINNED whole, in its chip's ink, then ' · ' (the separator every line on a card uses).
        const pinWord = pinned ? t('📌 PINNED') : null;
        return (
            <Pressable
                style={shell.compactRow}
                onPress={onOpen}
                accessibilityRole="button"
                accessibilityLabel={[t('Poll: {title}', { title: livePost.title }), status, rowMark].filter(Boolean).join(', ')}
                testID={`poll-row-${livePost.id}`}
            >
                <View style={[shell.compactPicture, styles.pollTile]} testID="compact-picture">
                    <Text style={styles.pollTileEmoji}>🗳️</Text>
                </View>
                <View style={shell.compactText}>
                    <Text style={shell.compactTitle} numberOfLines={1}>{livePost.title}</Text>
                    <Text testID="poll-compact-line" style={shell.compactLine} numberOfLines={1}>
                        {!!pinWord && <Text testID="pinned-chip" style={shell.compactPinned}>{pinWord} · </Text>}
                        <Text testID="poll-status" style={shell.compactLine}>{status}</Text>
                    </Text>
                    {!!rowMark && (markBefore === null ? (
                        <Text testID="poll-mark" style={[shell.compactLine, shell.compactMark]} numberOfLines={1}>{rowMark}</Text>
                    ) : (
                        <View testID="poll-mark" style={shell.compactMarkRow}>
                            <Text style={[shell.compactLine, shell.compactMark, shell.compactGiveWay]} numberOfLines={1}>{markBefore}{chosenText}</Text>
                            {!!markAfter && <Text style={[shell.compactLine, shell.compactMark, shell.compactKeep]} numberOfLines={1}>{markAfter}</Text>}
                        </View>
                    ))}
                </View>
                <View style={shell.compactEnd}>
                    <CardChip shell={shell} role="poll" label={t('🗳️ POLL')} testID="poll-badge" />
                </View>
            </Pressable>
        );
    }

    // The author: on the page a press opens their profile; on the Market's card it is words only.
    const author = (
        <>
            <MemberAvatar pubkey={authorKey} avatarUrl={avatarUrl} callsign={authorName} size={MARKET_CARD_TYPE.list.whoAvatar} />
            <View style={{ marginLeft: 8, flexShrink: 1 }}>
                <Text style={styles.authorText}>
                    {isAuthor ? t('{name} 👤 (You)', { name: authorName }) : authorName}
                </Text>
            </View>
        </>
    );

    return (
        <View style={[shell.card, styles.card, viewMode === 'grid' && styles.gridRowGap]} testID="poll-card">
            {/* Header: Badge, Status, Remaining Time */}
            <View style={styles.headerRow} testID="poll-header">
                {/* The chip row, from the box: 📌 PINNED, POLL (plum), and its quiet status (Closes in, Closed). */}
                <View style={[shell.chipRow, styles.badgeGroup]}>
                    {pinned && <CardChip shell={shell} role="pinned" label={t('📌 PINNED')} testID="pinned-chip" />}
                    <CardChip shell={shell} role="poll" label={t('🗳️ POLL')} testID="poll-badge" />
                    <CardChip shell={shell} role="quiet" label={formatTimeRemaining()} testID="poll-status" />
                </View>

                <View style={styles.headerActions}>
                    {showPinMenu({ pinsOn, role: pinRole, pinned: isPostPinned(livePost), isAuthor }) && (
                        <Pressable
                            testID="poll-menu-btn"
                            accessibilityRole="button"
                            accessibilityLabel={t('Poll options')}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}
                            onPress={handlePollOptions}
                        >
                            <Text style={{ fontSize: 20, color: colors.text.body, fontWeight: '900' }}>···</Text>
                        </Pressable>
                    )}
                    {isAuthor && !isClosed && (
                        <Pressable
                            onPress={handleClosePoll}
                            disabled={isClosing}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            style={styles.closeBtn}
                            accessibilityRole="button"
                            accessibilityLabel={isClosing ? t('Closing poll...') : t('Close poll')}
                            accessibilityState={{ busy: isClosing }}
                        >
                            {isClosing ? (
                                <ActivityIndicator size="small" color="#ef4444" />
                            ) : (
                                <Text style={styles.closeBtnText}>{t('Close Poll')}</Text>
                            )}
                        </Pressable>
                    )}
                </View>
            </View>

            {isPostPinned(livePost) && (
                <View style={{ marginTop: 6, marginBottom: 4 }} testID="pinned-detail-line">
                    <Text style={{ fontSize: 12, color: colors.text.secondary, fontWeight: '600' }} numberOfLines={2}>
                        {pinnedDetailLine(livePost)}
                    </Text>
                </View>
            )}

            {/* Author info */}
            {onOpenProfile && authorKey ? (
                <Pressable
                    style={styles.authorRow}
                    onPress={() => onOpenProfile({ publicKey: authorKey, callsign: authorName })}
                    accessibilityRole="button"
                    accessibilityLabel={t('Open {name}', { name: authorName })}
                    testID="poll-author"
                >
                    {author}
                </Pressable>
            ) : (
                <View style={styles.authorRow} testID="poll-author">{author}</View>
            )}

            {/* Question Title: the list card's loud line, 16/900 */}
            <Text style={[shell.loud, styles.title]}>{livePost.title}</Text>
            {Boolean(livePost.description) && (
                <Text style={styles.description}>{livePost.description}</Text>
            )}

            {/* Options & Live Progress Bars */}
            <View style={styles.optionsContainer}>
                {options.map((opt, idx) => {
                    const isVoted = userVotedOptionId === opt.id;
                    const isVotingThis = votingOptionId === opt.id;
                    const pct = opt.percentage ?? (totalVotes > 0 ? Math.round(((opt.votes || 0) / totalVotes) * 100) : 0);
                    const count = opt.votes ?? 0;
                    const optionOrigins = showOrigins ? pollOptionOriginsLine(count, opt.newOrWordsVotes) : null;
                    const optionText = opt.other ? pollOtherLines.other() : opt.text;
                    // One sentence for a screen reader, in the member's language: the option, its share, its votes, then
                    // where they came from and whether it is the member's own, each said after the last.
                    let optionLabel = tn(count, '{option}, {pct} percent, {n} vote', '{option}, {pct} percent, {n} votes', { option: optionText, pct });
                    if (optionOrigins) optionLabel = t('{label}, {origins}', { label: optionLabel, origins: optionOrigins });
                    if (isVoted) optionLabel = t('{label}, your vote', { label: optionLabel });

                    return (
                        <Pressable
                            key={opt.id || String(idx)}
                            disabled={isClosed || Boolean(votingOptionId) || answered}
                            onPress={() => (opt.other ? setTypingOther(v => !v) : handleVote(opt.id))}
                            style={[
                                styles.optionRow,
                                isVoted && styles.optionRowVoted,
                                isClosed && styles.optionRowClosed,
                            ]}
                            accessibilityRole="button"
                            accessibilityState={{ selected: isVoted, disabled: isClosed || Boolean(votingOptionId) || answered }}
                            accessibilityLabel={optionLabel}
                        >
                            {/* Background percentage fill bar */}
                            <View
                                style={[
                                    styles.progressBarFill,
                                    { width: `${pct}%` },
                                    isVoted ? styles.progressBarFillVoted : styles.progressBarFillNormal,
                                ]}
                            />

                            <View style={styles.optionContent}>
                                <View style={styles.optionLeft}>
                                    {isVotingThis ? (
                                        <ActivityIndicator size="small" color="#7c3aed" style={{ marginRight: 8 }} />
                                    ) : isVoted ? (
                                        <View style={styles.votedCheckBadge}>
                                            <Text style={styles.votedCheckText}>✓</Text>
                                        </View>
                                    ) : null}
                                    {/* Two lines in the Market's list; whole on the poll's page, where it is voted: a ballot answer cut short is not a choice. */}
                                    <Text style={[styles.optionText, isVoted && styles.optionTextVoted]} numberOfLines={viewMode ? 2 : undefined} testID="poll-option-text">
                                        {optionText}
                                    </Text>
                                </View>
                                <View style={styles.optionRight}>
                                    <Text style={[styles.optionPct, isVoted && styles.optionPctVoted]}>
                                        {pct}%
                                    </Text>
                                    <Text style={styles.optionVotes}>
                                        {tn(count, '({n} vote)', '({n} votes)')}
                                    </Text>
                                </View>
                            </View>
                            {optionOrigins && (
                                <Text style={styles.optionOrigins} testID="poll-option-origins">
                                    {optionOrigins}
                                </Text>
                            )}
                        </Pressable>
                    );
                })}
            </View>

            {/* Other: a line to type, and what becomes of it. */}
            {typingOther && !isClosed && !answered && (
                <View style={styles.otherBox} testID="poll-other-box">
                    <TextInput
                        value={otherWords}
                        onChangeText={setOtherWords}
                        maxLength={POLL_OTHER_WORDS_MAX}
                        placeholder={pollOtherLines.placeholder()}
                        placeholderTextColor={colors.text.muted}
                        accessibilityLabel={pollOtherLines.placeholder()}
                        style={styles.otherInput}
                        testID="poll-other-words"
                    />
                    <Text style={styles.otherNoName} testID="poll-other-no-name">{pollOtherLines.noName()}</Text>
                    {sealed && <Text style={styles.openBallotNote}>{pollOtherLines.sealedNote()}</Text>}
                    <View style={styles.otherActions}>
                        <Pressable
                            onPress={() => handleVote(pollOtherOption(options)!.id, otherWords.trim())}
                            disabled={!otherWords.trim() || Boolean(votingOptionId)}
                            style={[styles.otherSend, (!otherWords.trim() || Boolean(votingOptionId)) && styles.otherSendOff]}
                            accessibilityRole="button"
                            accessibilityLabel={pollOtherLines.send()}
                            testID="poll-other-send"
                        >
                            <Text style={styles.otherSendText}>{pollOtherLines.send()}</Text>
                        </Pressable>
                        <Pressable onPress={() => setTypingOther(false)} style={styles.otherCancel} accessibilityRole="button" accessibilityLabel={pollOtherLines.cancel()}>
                            <Text style={styles.otherCancelText}>{pollOtherLines.cancel()}</Text>
                        </Pressable>
                        <Text style={styles.otherCount}>{otherWords.length}/{POLL_OTHER_WORDS_MAX}</Text>
                    </View>
                </View>
            )}
            {answered && <Text style={styles.answeredNote} testID="poll-answered">{t('✓ {line}', { line: pollOtherLines.answered() })}</Text>}

            {/* On the worldwide community: a show of opinion, never a decision. */}
            {informal && (
                <Text style={styles.informalNote} testID="poll-informal-note">
                    {t('💬 {note}', { note: t(LINES.informal) })}
                </Text>
            )}
            {informal && decisionsPreview && <LocalCommunityMark variant="line" feature="decisions" text={t(LOCAL_COMMUNITY_LINES.poll)} />}

            {/* Where its votes came from, once it has closed, where the node says: all of them still count. */}
            {originsLine && (
                <Text style={styles.originsNote} testID="poll-vote-origins">
                    {t('🌱 {line}', { line: originsLine })}
                </Text>
            )}

            {/* Which ballot this is, said before anyone votes: anonymous unless its creator made it an open vote. */}
            {openVote ? (
                <Text style={styles.openBallotNote} testID="poll-open-ballot-note">
                    {t('👁️ Open vote: members can see who chose what')}
                </Text>
            ) : (
                <Text style={styles.openBallotNote} testID="poll-anonymous-note">
                    {t('🔒 Anonymous: everyone sees only the totals')}
                </Text>
            )}
            {sealed && !answered && !isClosed && !typingOther && <Text style={styles.openBallotNote}>{pollOtherLines.sealedNote()}</Text>}

            {/* Turnout Tally */}
            <View style={styles.turnoutRow}>
                <Text style={styles.turnoutText}>
                    {tn(totalVotes, '📊 {n} total vote cast', '📊 {n} total votes cast')}
                </Text>
                {openVote && votesList.length > 0 && (
                    <Pressable
                        onPress={() => setShowVoters(prev => !prev)}
                        style={styles.votersToggleBtn}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel={showVoters ? t('Hide voters list') : tn(votesList.length, 'View voters list, {n} votes', 'View voters list, {n} votes')}
                    >
                        <Text style={styles.votersToggleText}>
                            {showVoters ? t('Hide voters ▲') : t('View voters ({n}) ▼', { n: votesList.length })}
                        </Text>
                    </Pressable>
                )}
            </View>

            {/* An open vote's collapsible voter list */}
            {openVote && showVoters && votesList.length > 0 && (
                <View style={styles.votersSection}>
                    <Text style={styles.votersNotice}>
                        {t('This is an open vote: its creator chose to let members see who chose what.')}
                    </Text>
                    {votesList.map((v, i) => {
                        const matchedOpt = optionsById.get(v.optionId);
                        const optText = matchedOpt ? (matchedOpt.other ? pollOtherLines.other() : matchedOpt.text) : v.optionId;
                        const voterName = v.voterCallsign || (v.voterPubkey ? v.voterPubkey.slice(0, 8) : t('Member'));

                        return (
                            <View key={`${v.voterPubkey}_${i}`} style={styles.voterItem}>
                                <Text style={styles.voterName}>{voterName}</Text>
                                <Text style={styles.voterArrow}>→</Text>
                                <Text style={styles.voterChoice} numberOfLines={1}>{optText}</Text>
                            </View>
                        );
                    })}
                </View>
            )}

            {/* The words, for the poll's maker and the owners. */}
            {offersOther && (isAuthor || ownerHere) && <PollOtherAnswers postId={livePost.id} />}
            {/* Drawn only while open: the sheet is a Modal, and most cards never open it. */}
            {showPinSheet && (
                <PinSheet
                    visible
                    postId={livePost.id}
                    onClose={() => setShowPinSheet(false)}
                    onPinned={async () => {
                        const updated = await getPost(livePost.id);
                        if (updated) {
                            setLivePost((prev: any) => ({
                                ...prev,
                                pinned_until: updated.pinned_until,
                                pinned_at: updated.pinned_at,
                                pinnedUntil: updated.pinnedUntil,
                                pinnedAt: updated.pinnedAt,
                            }));
                        }
                    }}
                />
            )}
        </View>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        otherBox: {
            marginBottom: 10,
            padding: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme === 'dark' ? palette.violet500 : palette.violet200,
            backgroundColor: colors.surface.card,
        },
        otherInput: {
            minHeight: 44,
            borderWidth: 1,
            borderRadius: 8,
            borderColor: theme === 'dark' ? palette.gray700 : palette.gray300,
            backgroundColor: colors.surface.app,
            color: colors.text.body,
            paddingHorizontal: 10,
            fontSize: 15,
        },
        otherNoName: { marginTop: 6, fontSize: 12, fontWeight: '700', color: colors.text.body },
        otherActions: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
        otherSend: { minHeight: 44, paddingHorizontal: 14, borderRadius: 8, justifyContent: 'center', backgroundColor: palette.violet600 },
        otherSendOff: { opacity: 0.5 },
        otherSendText: { fontSize: 13, fontWeight: '800', color: palette.white },
        otherCancel: { minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' },
        otherCancelText: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
        otherCount: { marginLeft: 'auto', fontSize: 11, color: colors.text.muted },
        answeredNote: { marginBottom: 6, fontSize: 12, fontWeight: '700', color: theme === 'dark' ? palette.violet300 : palette.violet700 },
        // The card's shell is the box's (shell.card: corners 14, the 1 dp border, the card ground, the one shadow, 8 under it);
        // the poll's words sit 12 in, as every card's do.
        card: { padding: MARKET_CARD_SHELL.textPadding },
        // In the grid a poll is a row of the lattice: the gutter under it, as under every row of tiles (16, not the list's 8).
        gridRowGap: { marginBottom: MARKET_CARD_SHELL.gap.grid },
        // The compact row's tile: the poll's own plum, the ballot box in it.
        pollTile: { backgroundColor: colors.market.poll.bg, justifyContent: 'center', alignItems: 'center' },
        pollTileEmoji: { fontSize: 16 },
        // Wraps: at 320 dp and 130% text a pinned poll's owner has PINNED, POLL, the status, "···" and Close Poll to
        // draw in 288 dp. The badges wrap among themselves; the buttons drop to their own line, to the right.
        headerRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            rowGap: 8,
            columnGap: 8,
            marginBottom: 10,
        },
        badgeGroup: { flexShrink: 1 },
        headerActions: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            marginLeft: 'auto',
        },
        closeBtn: {
            paddingHorizontal: 10,
            paddingVertical: 6,
            minHeight: 44,
            minWidth: 44,
            justifyContent: 'center',
            alignItems: 'center',
            borderRadius: 6,
            borderWidth: 1,
            borderColor: theme === 'dark' ? '#7f1d1d' : '#fecaca',
            backgroundColor: theme === 'dark' ? 'rgba(239, 68, 68, 0.1)' : '#fff1f2',
        },
        closeBtnText: {
            fontSize: 11,
            fontWeight: '700',
            color: colors.feedback.danger.fg,
        },
        authorRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 10,
        },
        authorText: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        title: { marginBottom: 6 },
        description: {
            fontSize: 13,
            color: colors.text.secondary,
            marginBottom: 12,
            lineHeight: 18,
        },
        optionsContainer: {
            gap: 8,
            marginVertical: 6,
        },
        optionRow: {
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db',
            backgroundColor: theme === 'dark' ? '#1f2937' : '#f9fafb',
            overflow: 'hidden',
            position: 'relative',
            minHeight: 44,
            justifyContent: 'center',
        },
        optionRowVoted: {
            borderColor: '#7c3aed',
            borderWidth: 2,
        },
        optionRowClosed: {
            opacity: 0.9,
        },
        progressBarFill: {
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            borderRadius: 10,
        },
        progressBarFillNormal: {
            backgroundColor: theme === 'dark' ? 'rgba(124, 58, 237, 0.25)' : '#ede9fe',
        },
        progressBarFillVoted: {
            backgroundColor: theme === 'dark' ? 'rgba(124, 58, 237, 0.45)' : '#ddd6fe',
        },
        optionContent: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 12,
            paddingVertical: 10,
        },
        optionLeft: {
            flexDirection: 'row',
            alignItems: 'center',
            flex: 1,
            marginRight: 8,
        },
        votedCheckBadge: {
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: '#7c3aed',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 8,
        },
        votedCheckText: {
            color: '#fff',
            fontSize: 11,
            fontWeight: 'bold',
        },
        optionText: {
            fontSize: 14,
            fontWeight: '600',
            color: colors.text.body,
            flex: 1,
        },
        optionTextVoted: {
            fontWeight: '800',
            color: theme === 'dark' ? '#c4b5fd' : '#5b21b6',
        },
        optionRight: {
            alignItems: 'flex-end',
        },
        optionPct: {
            fontSize: 14,
            fontWeight: '800',
            color: colors.text.body,
        },
        optionPctVoted: {
            color: theme === 'dark' ? palette.violet300 : '#7c3aed', // violet600 is 2.9:1 on the dark card; violet300 9.43:1
        },
        optionVotes: {
            fontSize: 11,
            color: colors.text.secondary,
        },
        openBallotNote: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.muted,
            marginTop: 4,
            marginBottom: 2,
        },
        informalNote: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.text.secondary,
            marginTop: 4,
        },
        // Where the votes came from: a wrapping line, never cut short.
        originsNote: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.secondary,
            marginTop: 4,
        },
        // An answer's own share, on a line of its own under the answer, inside its row.
        optionOrigins: {
            fontSize: 11,
            fontWeight: '600',
            color: colors.text.secondary,
            paddingHorizontal: 12,
            paddingBottom: 8,
            marginTop: -4,
        },
        turnoutRow: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 10,
            paddingTop: 8,
            borderTopWidth: 1,
            borderTopColor: theme === 'dark' ? '#374151' : '#f3f4f6',
        },
        turnoutText: {
            fontSize: 12,
            color: colors.text.secondary,
            fontWeight: '600',
        },
        votersToggleBtn: {
            paddingVertical: 6,
            paddingHorizontal: 10,
            minHeight: 44,
            justifyContent: 'center',
        },
        votersToggleText: {
            fontSize: 12,
            fontWeight: '700',
            color: theme === 'dark' ? palette.violet300 : '#7c3aed', // violet600 is 2.9:1 on the dark card; violet300 9.43:1
        },
        votersSection: {
            marginTop: 10,
            padding: 10,
            borderRadius: 10,
            backgroundColor: theme === 'dark' ? '#111827' : '#f8fafc',
            borderWidth: 1,
            borderColor: theme === 'dark' ? '#1f2937' : '#e2e8f0',
        },
        votersNotice: {
            fontSize: 11,
            color: colors.text.secondary,
            fontStyle: 'italic',
            marginBottom: 8,
        },
        voterItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 4,
            borderBottomWidth: 1,
            borderBottomColor: theme === 'dark' ? '#1f2937' : '#f1f5f9',
        },
        voterName: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.text.body,
            minWidth: 70,
        },
        voterArrow: {
            fontSize: 11,
            color: colors.text.muted,
            marginHorizontal: 8,
        },
        voterChoice: {
            fontSize: 12,
            color: theme === 'dark' ? '#c4b5fd' : '#7c3aed',
            fontWeight: '600',
            flex: 1,
        },
    });
