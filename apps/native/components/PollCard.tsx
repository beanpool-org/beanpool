/**
 * PollCard — Interactive Community Poll card for the Marketplace feed (apps/native).
 *
 * Implements docs/the-commons.md §3.2, §3.8 and §8 specifications:
 * - Shows question (title), author, time ago, and category (community).
 * - Options list with live progress bars, vote counts, and percentages.
 * - Tap-to-vote: one member, one vote; re-voting overwrites choice.
 * - Turnout tally & close date or "Closed" badge.
 * - Open ballot: collapsible list of who voted for what (open, not secret).
 * - Author "Close Poll" action for early closure.
 */

import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Pressable,
    ActivityIndicator,
    Alert,
} from 'react-native';
import { MemberAvatar } from './MemberAvatar';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { votePoll, closePoll } from '../utils/db';

export interface PollOption {
    id: string;
    text: string;
    votes?: number;
    percentage?: number;
}

export interface PollVoteRecord {
    voterPubkey: string;
    voterCallsign?: string;
    optionId: string;
    createdAt: string;
}

interface PollCardProps {
    post: any;
    currentPubkey?: string | null;
    onVoteSuccess?: () => void;
}

export function PollCard({ post, currentPubkey, onVoteSuccess }: PollCardProps) {
    const { colors, theme } = useTheme();
    const styles = useStyles(makeStyles);

    const [livePost, setLivePost] = useState(post);
    const [votingOptionId, setVotingOptionId] = useState<string | null>(null);
    const [isClosing, setIsClosing] = useState(false);
    const [showVoters, setShowVoters] = useState(false);

    // Keep livePost in sync if prop changes
    React.useEffect(() => {
        setLivePost(post);
    }, [post]);

    const isAuthor = Boolean(currentPubkey && (livePost.author_pubkey === currentPubkey || livePost.authorPublicKey === currentPubkey));
    const isClosed = livePost.status === 'completed' || (livePost.pollClosesAt && new Date(livePost.pollClosesAt) <= new Date());
    const authorName = livePost.author_callsign || livePost.authorCallsign || (livePost.author_pubkey ? livePost.author_pubkey.slice(0, 6) : 'Unknown');
    const avatarUrl = livePost.author_avatar || livePost.authorAvatarUrl;

    const rawOptions = livePost.pollOptions || livePost.poll_options;
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
            Alert.alert('Poll Closed', 'This poll has ended and can no longer receive votes.');
            return;
        }
        if (!currentPubkey) {
            Alert.alert('Sign In Required', 'Please connect your member identity to vote in polls.');
            return;
        }

        setVotingOptionId(optionId);
        try {
            const res = await votePoll(livePost.id, optionId);
            if (res?.post) {
                setLivePost(res.post);
            }
            onVoteSuccess?.();
        } catch (err: any) {
            Alert.alert('Voting Error', err.message || 'Could not record your vote.');
        } finally {
            setVotingOptionId(null);
        }
    };

    const handleClosePoll = () => {
        Alert.alert(
            'Close Poll',
            'Are you sure you want to close this poll early? No more votes will be accepted.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Close Poll',
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
                            Alert.alert('Error', err.message || 'Failed to close poll');
                        } finally {
                            setIsClosing(false);
                        }
                    },
                },
            ]
        );
    };

    const formatTimeRemaining = () => {
        if (isClosed) return 'Closed';
        const closesAt = livePost.pollClosesAt || livePost.poll_closes_at;
        if (!closesAt) return 'Active';
        const diffMs = new Date(closesAt).getTime() - Date.now();
        if (diffMs <= 0) return 'Closed';
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        if (diffHours < 24) return `Closes in ${diffHours}h`;
        const diffDays = Math.floor(diffHours / 24);
        return `Closes in ${diffDays}d`;
    };

    return (
        <View style={styles.card}>
            {/* Header: Badge, Status, Remaining Time */}
            <View style={styles.headerRow}>
                <View style={styles.badgeGroup}>
                    <View style={styles.pollBadge}>
                        <Text style={styles.pollBadgeText}>🗳️ POLL</Text>
                    </View>
                    <View style={[styles.statusBadge, isClosed ? styles.statusClosed : styles.statusActive]}>
                        <Text style={isClosed ? styles.statusClosedText : styles.statusActiveText}>
                            {formatTimeRemaining()}
                        </Text>
                    </View>
                </View>

                {isAuthor && !isClosed && (
                    <Pressable
                        onPress={handleClosePoll}
                        disabled={isClosing}
                        style={styles.closeBtn}
                        accessibilityRole="button"
                    >
                        {isClosing ? (
                            <ActivityIndicator size="small" color="#ef4444" />
                        ) : (
                            <Text style={styles.closeBtnText}>Close Poll</Text>
                        )}
                    </Pressable>
                )}
            </View>

            {/* Author info */}
            <View style={styles.authorRow}>
                <MemberAvatar pubkey={livePost.author_pubkey || livePost.authorPublicKey || ''} avatarUrl={avatarUrl} callsign={authorName} size={30} />
                <View style={{ marginLeft: 8 }}>
                    <Text style={styles.authorText}>
                        {authorName} {isAuthor ? '👤 (You)' : ''}
                    </Text>
                </View>
            </View>

            {/* Question Title */}
            <Text style={styles.title}>{livePost.title}</Text>
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

                    return (
                        <Pressable
                            key={opt.id || String(idx)}
                            disabled={isClosed || Boolean(votingOptionId)}
                            onPress={() => handleVote(opt.id)}
                            style={[
                                styles.optionRow,
                                isVoted && styles.optionRowVoted,
                                isClosed && styles.optionRowClosed,
                            ]}
                            accessibilityRole="button"
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
                                    <Text style={[styles.optionText, isVoted && styles.optionTextVoted]} numberOfLines={2}>
                                        {opt.text}
                                    </Text>
                                </View>
                                <View style={styles.optionRight}>
                                    <Text style={[styles.optionPct, isVoted && styles.optionPctVoted]}>
                                        {pct}%
                                    </Text>
                                    <Text style={styles.optionVotes}>
                                        ({count} {count === 1 ? 'vote' : 'votes'})
                                    </Text>
                                </View>
                            </View>
                        </Pressable>
                    );
                })}
            </View>

            {/* Turnout Tally */}
            <View style={styles.turnoutRow}>
                <Text style={styles.turnoutText}>
                    📊 {totalVotes} total {totalVotes === 1 ? 'vote' : 'votes'} cast
                </Text>
                {votesList.length > 0 && (
                    <Pressable
                        onPress={() => setShowVoters(prev => !prev)}
                        style={styles.votersToggleBtn}
                        accessibilityRole="button"
                    >
                        <Text style={styles.votersToggleText}>
                            {showVoters ? 'Hide voters ▲' : `View voters (${votesList.length}) ▼`}
                        </Text>
                    </Pressable>
                )}
            </View>

            {/* Open / Non-Secret Ballot: Collapsible Voter List */}
            {showVoters && votesList.length > 0 && (
                <View style={styles.votersSection}>
                    <Text style={styles.votersNotice}>
                        Village voting is open and transparent. Every vote is signed and visible to members.
                    </Text>
                    {votesList.map((v, i) => {
                        const matchedOpt = options.find(o => o.id === v.optionId);
                        const optText = matchedOpt ? matchedOpt.text : v.optionId;
                        const voterName = v.voterCallsign || (v.voterPubkey ? v.voterPubkey.slice(0, 8) : 'Member');

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
        </View>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        card: {
            backgroundColor: colors.surface.card,
            borderRadius: 16,
            padding: 16,
            marginBottom: 14,
            borderWidth: 1,
            borderColor: theme === 'dark' ? '#374151' : '#e5e7eb',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.05,
            shadowRadius: 6,
            elevation: 2,
        },
        headerRow: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
        },
        badgeGroup: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
        },
        pollBadge: {
            backgroundColor: theme === 'dark' ? '#4c1d95' : '#ede9fe',
            borderColor: theme === 'dark' ? '#6d28d9' : '#c4b5fd',
            borderWidth: 1,
            borderRadius: 8,
            paddingHorizontal: 8,
            paddingVertical: 3,
        },
        pollBadgeText: {
            fontSize: 11,
            fontWeight: '800',
            color: theme === 'dark' ? '#ddd6fe' : '#6d28d9',
        },
        statusBadge: {
            borderRadius: 8,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderWidth: 1,
        },
        statusActive: {
            backgroundColor: theme === 'dark' ? 'rgba(16, 185, 129, 0.15)' : '#ecfdf5',
            borderColor: theme === 'dark' ? '#059669' : '#a7f3d0',
        },
        statusActiveText: {
            fontSize: 11,
            fontWeight: '700',
            color: theme === 'dark' ? '#34d399' : '#047857',
        },
        statusClosed: {
            backgroundColor: theme === 'dark' ? 'rgba(107, 114, 128, 0.2)' : '#f3f4f6',
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db',
        },
        statusClosedText: {
            fontSize: 11,
            fontWeight: '700',
            color: theme === 'dark' ? '#9ca3af' : '#4b5563',
        },
        closeBtn: {
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: theme === 'dark' ? '#7f1d1d' : '#fecaca',
            backgroundColor: theme === 'dark' ? 'rgba(239, 68, 68, 0.1)' : '#fff1f2',
        },
        closeBtnText: {
            fontSize: 11,
            fontWeight: '700',
            color: '#ef4444',
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
        title: {
            fontSize: 17,
            fontWeight: '800',
            color: colors.text.body,
            marginBottom: 6,
            lineHeight: 22,
        },
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
            color: '#7c3aed',
        },
        optionVotes: {
            fontSize: 11,
            color: colors.text.secondary,
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
            paddingVertical: 4,
            paddingHorizontal: 8,
        },
        votersToggleText: {
            fontSize: 12,
            fontWeight: '700',
            color: '#7c3aed',
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
            color: '#7c3aed',
            fontWeight: '600',
            flex: 1,
        },
    });
