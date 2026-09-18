import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Pressable,
    Alert,
    ActivityIndicator,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import {
    type DecisionWithTally,
    type MyPoolVoting,
    castDecisionVote,
} from '../utils/db';
import { ownVoteSummary, startingVoteCount, voteButtonStates } from '../utils/decision-own-vote';
import { electorateLine, keepSuspensionHeadline, poolVoteBlocker, turnoutLine, voiceCreditsLine } from '../utils/decision-card';

interface Props {
    decisions: DecisionWithTally[];
    /** The signer's voice credits for money votes; null for a guest or before it loads. */
    myPoolVoting?: MyPoolVoting | null;
    identity: any;
    balanceState: { earnedCredit: number; commons: number };
    onRefresh: () => Promise<void>;
    onOpenPropose: () => void;
    canPropose: boolean;
    hasOpenDecision: boolean;
    activeView: 'open' | 'history';
    onChangeView: (view: 'open' | 'history') => void;
}

export function DecideSection({
    decisions,
    myPoolVoting = null,
    identity,
    balanceState,
    onRefresh,
    onOpenPropose,
    canPropose,
    hasOpenDecision,
    activeView,
    onChangeView,
}: Props) {
    const { theme, colors } = useTheme();
    const [votingId, setVotingId] = useState<string | null>(null);
    const [selectedVoteCount, setSelectedVoteCount] = useState<Record<string, number>>({});
    const [historyFilter, setHistoryFilter] = useState<'all' | 'executed' | 'failed' | 'void'>('all');

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
        if (effect === 'keep_suspension') return 'Keep Suspension?';
        return effect
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    };

    const handleVote = async (decision: DecisionWithTally, support: boolean) => {
        if (!identity?.publicKey) {
            Alert.alert('Not Logged In', 'You must be connected with an active account to vote.');
            return;
        }

        // The node checks the cost of a quadratic vote against this Decision; its refusal shows in the alert below.
        const count = startingVoteCount(selectedVoteCount[decision.id], decision.myVote);

        setVotingId(decision.id);
        try {
            const res = await castDecisionVote(decision.id, {
                voterPubkey: identity.publicKey,
                support,
                voteCount: count,
            });

            if (res.success) {
                Alert.alert('Vote Recorded', `Your ${support ? 'YES' : 'NO'} vote (${count} weight) has been cast.`);
                await onRefresh();
            } else {
                Alert.alert('Voting Error', (res as any).error || 'Failed to record vote');
            }
        } catch (err: any) {
            Alert.alert('Error', err.message || 'Failed to cast vote');
        } finally {
            setVotingId(null);
        }
    };

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: {
            marginBottom: 20,
        },
        viewSelector: {
            flexDirection: 'row',
            gap: 10,
            marginBottom: 16,
        },
        viewTab: {
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: 14,
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        viewTabActive: {
            backgroundColor: colors.brand.tint,
            borderColor: colors.brand.primary,
        },
        viewTabText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        viewTabTextActive: {
            color: colors.brand.primary,
        },
        badgePill: {
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 10,
            backgroundColor: colors.brand.primary,
        },
        badgePillText: {
            color: colors.text.inverse,
            fontSize: 11,
            fontWeight: '800',
        },
        proposeBanner: {
            backgroundColor: colors.surface.card,
            borderRadius: 16,
            padding: 16,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        // Wraps: at 320dp + 1.3x text the title fills the row and "No bond required" ran off the right edge.
        proposeHeaderRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            columnGap: 8,
            rowGap: 4,
            marginBottom: 8,
        },
        proposeTitle: {
            flexShrink: 1,
            fontSize: 16,
            fontWeight: '800',
            color: colors.text.heading,
        },
        proposeDesc: {
            fontSize: 13,
            color: colors.text.secondary,
            lineHeight: 18,
            marginBottom: 12,
        },
        proposeBtn: {
            backgroundColor: colors.brand.primary,
            borderRadius: 12,
            paddingVertical: 12,
            paddingHorizontal: 16,
            alignItems: 'center',
            justifyContent: 'center',
        },
        proposeBtnDisabled: {
            opacity: 0.5,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        proposeBtnText: {
            color: colors.text.inverse,
            fontSize: 14,
            fontWeight: '700',
        },
        proposeBtnTextDisabled: {
            color: colors.text.muted,
        },
        gateWarning: {
            fontSize: 11,
            color: colors.feedback.warning.solid,
            marginTop: 6,
            fontWeight: '600',
        },
        card: {
            backgroundColor: colors.surface.card,
            borderRadius: 16,
            padding: 16,
            marginBottom: 14,
            borderWidth: 1,
            borderColor: colors.border.default,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.05,
            shadowRadius: 6,
            elevation: 2,
        },
        cardHeader: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
            marginBottom: 10,
        },
        tagRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
        },
        touchPill: {
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 8,
            backgroundColor: colors.brand.tint,
        },
        touchPillText: {
            fontSize: 11,
            fontWeight: '700',
            color: colors.brand.primary,
            textTransform: 'uppercase',
        },
        effectPill: {
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 8,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        effectPillText: {
            fontSize: 11,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        timePill: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 8,
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.amber100,
        },
        timePillText: {
            fontSize: 11,
            fontWeight: '700',
            color: theme === 'dark' ? colors.feedback.warning.solid : palette.amber700,
        },
        decisionTitle: {
            fontSize: 17,
            fontWeight: '800',
            color: colors.text.heading,
            marginBottom: 6,
            letterSpacing: -0.3,
        },
        decisionDesc: {
            fontSize: 13,
            color: colors.text.secondary,
            lineHeight: 18,
            marginBottom: 12,
        },
        // §3.8 Debt write-off block
        debtWarningBox: {
            backgroundColor: palette.red100,
            borderRadius: 12,
            padding: 12,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: palette.red300,
        },
        debtWarningLabel: {
            fontSize: 11,
            fontWeight: '800',
            color: palette.red700,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 4,
        },
        debtWriteOffText: {
            fontSize: 13,
            color: palette.red900,
            lineHeight: 18,
            fontWeight: '700',
        },
        metricsContainer: {
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            padding: 12,
            marginBottom: 12,
            gap: 10,
        },
        metricRow: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 4,
        },
        metricLabel: {
            flexShrink: 1,
            fontSize: 12,
            color: colors.text.secondary,
            fontWeight: '600',
        },
        metricValue: {
            fontSize: 12,
            color: colors.text.heading,
            fontWeight: '700',
        },
        electorateText: {
            fontSize: 11,
            color: colors.text.muted,
            marginTop: 4,
        },
        keepBox: {
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.amber100,
            borderRadius: 12,
            padding: 12,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: theme === 'dark' ? colors.border.default : palette.amber300,
            gap: 4,
        },
        keepHeadline: {
            fontSize: 14,
            fontWeight: '800',
            color: theme === 'dark' ? colors.feedback.warning.solid : palette.amber800,
        },
        keepBody: {
            fontSize: 13,
            color: colors.text.heading,
            lineHeight: 18,
        },
        blockerText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.feedback.warning.solid,
            marginBottom: 6,
        },
        creditsText: {
            fontSize: 12,
            color: colors.text.secondary,
            marginBottom: 6,
        },
        secretNote: {
            fontSize: 11,
            color: colors.text.muted,
            marginTop: 8,
        },
        barBg: {
            height: 6,
            backgroundColor: colors.border.default,
            borderRadius: 3,
            overflow: 'hidden',
        },
        barFill: {
            height: '100%',
            borderRadius: 3,
        },
        voteSection: {
            marginTop: 4,
            paddingTop: 10,
            borderTopWidth: 1,
            borderTopColor: colors.border.default,
        },
        voteButtonsRow: {
            flexDirection: 'row',
            gap: 10,
            marginTop: 8,
        },
        voteBtn: {
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            minHeight: 48,
            paddingVertical: 10,
            paddingHorizontal: 8,
            borderRadius: 12,
        },
        voteBtnCurrent: {
            opacity: 0.55,
        },
        myVoteRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            marginTop: 8,
        },
        myVoteText: {
            flexShrink: 1,
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.heading,
        },
        voteBtnYes: {
            backgroundColor: palette.green600,
        },
        voteBtnNo: {
            backgroundColor: palette.red600,
        },
        voteBtnText: {
            flexShrink: 1,
            textAlign: 'center',
            color: colors.text.inverse,
            fontSize: 13,
            fontWeight: '800',
        },
        qvStepper: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: colors.surface.app,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 6,
            marginBottom: 8,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        stepperBtn: {
            padding: 4,
            minWidth: 44,
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'center',
        },
        qvLabel: {
            fontSize: 12,
            color: colors.text.heading,
            fontWeight: '700',
        },
        historyProvenanceBox: {
            backgroundColor: colors.surface.subtle,
            borderRadius: 10,
            padding: 10,
            marginTop: 10,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        historyProvenanceLabel: {
            fontSize: 11,
            fontWeight: '800',
            color: colors.text.secondary,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 2,
        },
        historyProvenanceText: {
            fontSize: 12,
            color: colors.text.heading,
            fontWeight: '600',
        },
        historyStatusBadge: {
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 8,
        },
        statusExecuted: { backgroundColor: palette.green100 },
        statusFailed: { backgroundColor: palette.red100 },
        statusVoid: { backgroundColor: palette.amber100 },
        statusGrace: { backgroundColor: palette.indigo100 },
        statusTextExecuted: { color: palette.green700, fontWeight: '800', fontSize: 11 },
        statusTextFailed: { color: palette.red700, fontWeight: '800', fontSize: 11 },
        statusTextVoid: { color: palette.amber800, fontWeight: '800', fontSize: 11 },
        statusTextGrace: { color: palette.indigo700, fontWeight: '800', fontSize: 11 },
        filterRow: {
            flexDirection: 'row',
            gap: 6,
            marginBottom: 12,
        },
        filterBtn: {
            paddingVertical: 6,
            paddingHorizontal: 12,
            borderRadius: 14,
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        filterBtnActive: {
            backgroundColor: colors.brand.primary,
            borderColor: colors.brand.dark,
        },
        filterBtnText: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        filterBtnTextActive: {
            color: colors.text.inverse,
        },
        emptyState: {
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 32,
            paddingHorizontal: 20,
            backgroundColor: colors.surface.card,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        emptyTitle: {
            fontSize: 16,
            fontWeight: '700',
            color: colors.text.heading,
            marginTop: 8,
            marginBottom: 4,
        },
        emptyDesc: {
            fontSize: 13,
            color: colors.text.muted,
            textAlign: 'center',
            lineHeight: 18,
        },
    }));

    return (
        <View style={styles.container}>
            {/* View Switcher: Open Decisions vs History */}
            <View style={styles.viewSelector} accessibilityRole="tablist" accessibilityLabel="Decisions view">
                <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected: activeView === 'open' }}
                    accessibilityLabel="Open Decisions"
                    style={[styles.viewTab, activeView === 'open' && styles.viewTabActive]}
                    onPress={() => onChangeView('open')}
                >
                    <MaterialCommunityIcons
                        name="vote"
                        size={16}
                        color={activeView === 'open' ? colors.brand.primary : colors.text.secondary}
                    />
                    <Text style={[styles.viewTabText, activeView === 'open' && styles.viewTabTextActive]}>
                        Open Decisions
                    </Text>
                    {openDecisions.length > 0 && (
                        <View style={styles.badgePill}>
                            <Text style={styles.badgePillText}>{openDecisions.length}</Text>
                        </View>
                    )}
                </Pressable>

                <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected: activeView === 'history' }}
                    accessibilityLabel="Decisions History"
                    style={[styles.viewTab, activeView === 'history' && styles.viewTabActive]}
                    onPress={() => onChangeView('history')}
                >
                    <MaterialCommunityIcons
                        name="history"
                        size={16}
                        color={activeView === 'history' ? colors.brand.primary : colors.text.secondary}
                    />
                    <Text style={[styles.viewTabText, activeView === 'history' && styles.viewTabTextActive]}>
                        Decisions History
                    </Text>
                </Pressable>
            </View>

            {/* OPEN DECISIONS VIEW */}
            {activeView === 'open' && (
                <>
                    {/* Propose Decision Banner (open to anyone who has completed a trade; 1 open per author; no bond) */}
                    <View style={styles.proposeBanner}>
                        <View style={styles.proposeHeaderRow}>
                            <Text style={styles.proposeTitle}>🌱 Propose Community Action</Text>
                            <Text style={{ fontSize: 12, color: colors.text.muted }}>No bond required</Text>
                        </View>
                        <Text style={styles.proposeDesc}>
                            Binding decisions execute automatically upon passing (§3.7). Open to anyone who has completed a trade.
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Propose a Community Decision"
                            style={[styles.proposeBtn, (!canPropose || hasOpenDecision) && styles.proposeBtnDisabled]}
                            onPress={() => {
                                if (!canPropose) {
                                    Alert.alert('Complete a Trade First', 'You can propose a Decision once you have completed a trade.');
                                    return;
                                }
                                if (hasOpenDecision) {
                                    Alert.alert('Limit Reached', 'You already have an open decision (limit 1 open decision per author).');
                                    return;
                                }
                                onOpenPropose();
                            }}
                        >
                            <Text style={[styles.proposeBtnText, (!canPropose || hasOpenDecision) && styles.proposeBtnTextDisabled]}>
                                + Propose a Decision
                            </Text>
                        </Pressable>
                        {!canPropose && (
                            <Text style={styles.gateWarning}>
                                ⚠️ You can propose once you have completed a trade.
                            </Text>
                        )}
                        {canPropose && hasOpenDecision && (
                            <Text style={styles.gateWarning}>
                                ℹ️ You have an open decision. Wait for it to conclude before opening another.
                            </Text>
                        )}
                    </View>

                    {/* Open Decisions List */}
                    {openDecisions.length === 0 ? (
                        <View style={styles.emptyState}>
                            <MaterialCommunityIcons name="ballot-outline" size={40} color={colors.text.muted} />
                            <Text style={styles.emptyTitle}>No open decisions right now</Text>
                            <Text style={styles.emptyDesc}>
                                Community decisions appear here when members propose binding actions.
                            </Text>
                        </View>
                    ) : (
                        openDecisions.map(item => {
                            const { tally } = item;
                            const quorumPct = Math.min(100, Math.round((tally.totalVoters / Math.max(1, tally.quorumRequired)) * 100));
                            const supportPct = Math.round(tally.supportRatio * 100);
                            const thresholdPct = Math.round(tally.thresholdRequired * 100);
                            const currentCount = startingVoteCount(selectedVoteCount[item.id], item.myVote);
                            const isQuadratic = item.franchise === 'quadratic_trade';
                            const myVoteLine = ownVoteSummary(item.myVote, isQuadratic);
                            const buttons = voteButtonStates(item.myVote, isQuadratic, currentCount);
                            const blocker = isQuadratic ? poolVoteBlocker(myPoolVoting) : null;
                            const creditsLine = isQuadratic ? voiceCreditsLine(myPoolVoting) : null;
                            const yesDisabled = votingId === item.id || buttons.yes.disabled || !!blocker;
                            const noDisabled = votingId === item.id || buttons.no.disabled || !!blocker;

                            // §3.8 Removal ballot text
                            const targetName = item.params?.memberName || item.subject?.slice(0, 8) || 'Member';
                            const debtAmount = item.params?.debt !== undefined ? Math.abs(item.params.debt) : (item.params?.balance !== undefined ? Math.abs(Math.min(0, item.params.balance)) : 0);
                            const poolAmount = Math.round(item.params?.commonsPool ?? balanceState.commons ?? 0);
                            const debtWriteOffLine = `${targetName}'s balance is \u2212${debtAmount} beans. Removing them charges that ${debtAmount} to the Commons pool, which currently holds ${poolAmount}.`;

                            return (
                                <View key={item.id} style={styles.card}>
                                    {/* Header tags: Touches, Effect, Franchise, Time Left */}
                                    <View style={styles.cardHeader}>
                                        <View style={styles.tagRow}>
                                            <View style={styles.touchPill}>
                                                <Text style={styles.touchPillText}>Touches: {item.touches}</Text>
                                            </View>
                                            <View style={styles.effectPill}>
                                                <Text style={styles.effectPillText}>{formatEffectLabel(item.effect)}</Text>
                                            </View>
                                            <View style={styles.effectPill}>
                                                <Text style={styles.effectPillText}>
                                                    {item.franchise === 'quadratic_trade' ? 'Quadratic' : '1m1v'}
                                                </Text>
                                            </View>
                                        </View>
                                        <View style={styles.timePill}>
                                            <MaterialCommunityIcons name="clock-outline" size={12} color={styles.timePillText.color} />
                                            <Text style={styles.timePillText}>{formatTimeLeft(item.closesAt)}</Text>
                                        </View>
                                    </View>

                                    {/* Title & Description */}
                                    <Text style={styles.decisionTitle}>{item.title}</Text>
                                    <Text style={styles.decisionDesc}>{item.description}</Text>

                                    {/* Emergency suspension: the node opened this vote when an admin suspended someone (answer L) */}
                                    {item.effect === 'keep_suspension' && (
                                        <View style={styles.keepBox} testID="keep-suspension-box">
                                            <Text style={styles.keepHeadline}>
                                                {keepSuspensionHeadline(item.params, item.subject?.slice(0, 8) || 'a member')}
                                            </Text>
                                            <Text style={styles.keepBody}>
                                                Vote Yes to keep it. If this vote doesn't pass, the suspension lifts by itself.
                                            </Text>
                                        </View>
                                    )}

                                    {/* §3.8 Removal Ballot debt-write-off line */}
                                    {item.effect === 'remove_member' && (
                                        <View style={styles.debtWarningBox} testID="removal-debt-write-off-box">
                                            <Text style={styles.debtWarningLabel}>Mandatory Debt Disclosure (§3.8)</Text>
                                            <Text style={styles.debtWriteOffText} testID="removal-debt-write-off-line">
                                                {debtWriteOffLine}
                                            </Text>
                                        </View>
                                    )}

                                    {/* Metrics: Quorum Progress & Tally */}
                                    <View style={styles.metricsContainer}>
                                        {/* Quorum */}
                                        <View>
                                            <View style={styles.metricRow}>
                                                <Text style={styles.metricLabel}>
                                                    Turnout: {turnoutLine(tally)}
                                                </Text>
                                                <Text style={[styles.metricValue, { color: tally.quorumMet ? palette.green600 : colors.text.secondary }]}>
                                                    {tally.quorumMet ? 'Met ✅' : 'Pending'}
                                                </Text>
                                            </View>
                                            <View
                                                style={styles.barBg}
                                                accessibilityRole="progressbar"
                                                accessibilityValue={{ min: 0, max: 100, now: Math.min(100, quorumPct) }}
                                                accessibilityLabel="Quorum progress"
                                            >
                                                <View
                                                    style={[
                                                        styles.barFill,
                                                        { width: `${quorumPct}%`, backgroundColor: tally.quorumMet ? palette.green500 : palette.blue500 },
                                                    ]}
                                                />
                                            </View>
                                            <Text style={styles.electorateText}>{electorateLine(tally)}</Text>
                                        </View>

                                        {/* Tally */}
                                        <View>
                                            <View style={styles.metricRow}>
                                                <Text style={styles.metricLabel}>
                                                    Tally: Yes {tally.yesWeight} ({supportPct}%) · No {tally.noWeight}
                                                </Text>
                                                <Text style={styles.metricValue}>
                                                    Needs {thresholdPct}%
                                                </Text>
                                            </View>
                                            <View
                                                style={styles.barBg}
                                                accessibilityRole="progressbar"
                                                accessibilityValue={{ min: 0, max: 100, now: Math.min(100, supportPct) }}
                                                accessibilityLabel="Support progress"
                                            >
                                                <View
                                                    style={[
                                                        styles.barFill,
                                                        { width: `${supportPct}%`, backgroundColor: tally.passed ? palette.green500 : palette.amber500 },
                                                    ]}
                                                />
                                            </View>
                                        </View>
                                    </View>

                                    {/* Voting Action Section */}
                                    <View style={styles.voteSection}>
                                        {item.franchise === 'quadratic_trade' && (
                                            <View style={styles.qvStepper}>
                                                <Text style={styles.qvLabel}>
                                                    Votes: {currentCount} (Cost: {currentCount * currentCount} credits)
                                                </Text>
                                                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                                                    <Pressable
                                                        accessibilityRole="button"
                                                        accessibilityLabel="Decrease votes"
                                                        accessibilityHint={`Decreases vote count from ${currentCount}`}
                                                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                        disabled={votingId === item.id || currentCount <= 1}
                                                        style={[styles.stepperBtn, { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }, (votingId === item.id || currentCount <= 1) && { opacity: 0.5 }]}
                                                        onPress={() => {
                                                            setSelectedVoteCount(prev => ({
                                                                ...prev,
                                                                [item.id]: Math.max(1, startingVoteCount(prev[item.id], item.myVote) - 1),
                                                            }));
                                                        }}
                                                    >
                                                        <MaterialCommunityIcons name="minus-circle-outline" size={24} color={colors.brand.primary} />
                                                    </Pressable>
                                                    <Pressable
                                                        accessibilityRole="button"
                                                        accessibilityLabel="Increase votes"
                                                        accessibilityHint={`Increases vote count from ${currentCount}`}
                                                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                        disabled={votingId === item.id}
                                                        style={[styles.stepperBtn, { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }, votingId === item.id && { opacity: 0.5 }]}
                                                        onPress={() => {
                                                            setSelectedVoteCount(prev => ({
                                                                ...prev,
                                                                [item.id]: startingVoteCount(prev[item.id], item.myVote) + 1,
                                                            }));
                                                        }}
                                                    >
                                                        <MaterialCommunityIcons name="plus-circle-outline" size={24} color={colors.brand.primary} />
                                                    </Pressable>
                                                </View>
                                            </View>
                                        )}

                                        {!!blocker && <Text style={styles.blockerText} testID="pool-vote-blocker">{blocker}</Text>}
                                        {!blocker && !!creditsLine && <Text style={styles.creditsText}>{creditsLine}</Text>}

                                        {myVoteLine && (
                                            <View style={styles.myVoteRow}>
                                                <MaterialCommunityIcons name="check-circle" size={16} color={colors.brand.primary} />
                                                <Text style={styles.myVoteText}>{myVoteLine}</Text>
                                            </View>
                                        )}

                                        <View style={styles.voteButtonsRow}>
                                            <Pressable
                                                accessibilityRole="button"
                                                accessibilityLabel={buttons.yes.label}
                                                accessibilityState={{ disabled: yesDisabled }}
                                                style={[styles.voteBtn, styles.voteBtnYes, (buttons.yes.disabled || !!blocker) && styles.voteBtnCurrent]}
                                                disabled={yesDisabled}
                                                onPress={() => handleVote(item, true)}
                                            >
                                                {votingId === item.id ? (
                                                    <ActivityIndicator color="#fff" size="small" />
                                                ) : (
                                                    <>
                                                        <MaterialCommunityIcons name="thumb-up" size={16} color="#fff" />
                                                        <Text style={styles.voteBtnText}>{buttons.yes.label}</Text>
                                                    </>
                                                )}
                                            </Pressable>

                                            <Pressable
                                                accessibilityRole="button"
                                                accessibilityLabel={buttons.no.label}
                                                accessibilityState={{ disabled: noDisabled }}
                                                style={[styles.voteBtn, styles.voteBtnNo, (buttons.no.disabled || !!blocker) && styles.voteBtnCurrent]}
                                                disabled={noDisabled}
                                                onPress={() => handleVote(item, false)}
                                            >
                                                {votingId === item.id ? (
                                                    <ActivityIndicator color="#fff" size="small" />
                                                ) : (
                                                    <>
                                                        <MaterialCommunityIcons name="thumb-down" size={16} color="#fff" />
                                                        <Text style={styles.voteBtnText}>{buttons.no.label}</Text>
                                                    </>
                                                )}
                                            </Pressable>
                                        </View>
                                        <Text style={styles.secretNote} testID="secret-ballot-note">
                                            🔒 Secret ballot: members see the totals, never who voted how.
                                        </Text>
                                    </View>
                                </View>
                            );
                        })
                    )}
                </>
            )}

            {/* DECISIONS HISTORY VIEW */}
            {activeView === 'history' && (
                <>
                    {/* Filters */}
                    <View style={styles.filterRow}>
                        {(['all', 'executed', 'failed', 'void'] as const).map(f => (
                            <Pressable
                                key={f}
                                accessibilityRole="button"
                                style={[styles.filterBtn, historyFilter === f && styles.filterBtnActive]}
                                onPress={() => setHistoryFilter(f)}
                            >
                                <Text style={[styles.filterBtnText, historyFilter === f && styles.filterBtnTextActive]}>
                                    {f.charAt(0).toUpperCase() + f.slice(1)}
                                </Text>
                            </Pressable>
                        ))}
                    </View>

                    {filteredPastDecisions.length === 0 ? (
                        <View style={styles.emptyState}>
                            <MaterialCommunityIcons name="history" size={40} color={colors.text.muted} />
                            <Text style={styles.emptyTitle}>No past decisions</Text>
                            <Text style={styles.emptyDesc}>
                                Completed community votes and executed effects will be recorded here.
                            </Text>
                        </View>
                    ) : (
                        filteredPastDecisions.map(item => {
                            const { tally } = item;
                            const supportPct = Math.round(tally.supportRatio * 100);

                            let badgeStyle: any = styles.statusFailed;
                            let textStyle: any = styles.statusTextFailed;
                            if (item.status === 'executed' || item.status === 'passed') {
                                badgeStyle = styles.statusExecuted;
                                textStyle = styles.statusTextExecuted;
                            } else if (item.status === 'execution_pending_grace') {
                                badgeStyle = styles.statusGrace;
                                textStyle = styles.statusTextGrace;
                            } else if (item.status === 'execution_void' || item.status === 'admin_halted') {
                                badgeStyle = styles.statusVoid;
                                textStyle = styles.statusTextVoid;
                            }

                            return (
                                <View key={item.id} style={styles.card}>
                                    <View style={styles.cardHeader}>
                                        <View style={styles.tagRow}>
                                            <View style={styles.touchPill}>
                                                <Text style={styles.touchPillText}>Touches: {item.touches}</Text>
                                            </View>
                                            <View style={styles.effectPill}>
                                                <Text style={styles.effectPillText}>{formatEffectLabel(item.effect)}</Text>
                                            </View>
                                        </View>
                                        <View style={[styles.historyStatusBadge, badgeStyle]}>
                                            <Text style={textStyle}>{item.status.toUpperCase().replace(/_/g, ' ')}</Text>
                                        </View>
                                    </View>

                                    <Text style={styles.decisionTitle}>{item.title}</Text>
                                    <Text style={styles.decisionDesc}>{item.description}</Text>

                                    {/* Final Tally Summary */}
                                    <View style={styles.metricsContainer}>
                                        <View style={styles.metricRow}>
                                            <Text style={styles.metricLabel}>
                                                Turnout: {turnoutLine(tally)} ({tally.quorumMet ? 'Met' : 'Unmet'})
                                            </Text>
                                            <Text style={styles.metricValue}>
                                                Yes: {tally.yesWeight} ({supportPct}%) · No: {tally.noWeight}
                                            </Text>
                                        </View>
                                    </View>

                                    {/* Who Authorised Each Executed Effect (§3.7, §3.8) */}
                                    <View style={styles.historyProvenanceBox}>
                                        <Text style={styles.historyProvenanceLabel}>Authorisation & Provenance</Text>
                                        {item.status === 'executed' && (
                                            <>
                                                <Text style={styles.historyProvenanceText}>
                                                    Authorised by: Community Vote (system:decision:{item.id.slice(0, 8)})
                                                </Text>
                                                <Text style={{ fontSize: 11, color: colors.text.muted, marginTop: 2 }}>
                                                    Provenance: system:decision:{item.id} · {item.executionReason || 'Executed successfully'}
                                                </Text>
                                            </>
                                        )}
                                        {item.status === 'admin_halted' && (
                                            <Text style={styles.historyProvenanceText}>
                                                Halted by an admin — Reason: {item.adminHaltReason}
                                            </Text>
                                        )}
                                        {item.status === 'execution_pending_grace' && (
                                            <Text style={styles.historyProvenanceText}>
                                                In 7-day Grace Period: Scheduled for removal on {new Date(item.gracePeriodEndsAt!).toLocaleDateString()}
                                            </Text>
                                        )}
                                        {item.status === 'execution_void' && (
                                            <Text style={styles.historyProvenanceText}>
                                                Void: {item.executionReason || 'Subject does not exist or was pruned'}
                                            </Text>
                                        )}
                                        {item.status === 'failed' && (
                                            <Text style={styles.historyProvenanceText}>
                                                Not executed: {tally.quorumMet ? 'Threshold not met' : 'Quorum not reached'}
                                            </Text>
                                        )}
                                        {item.status === 'unresolved' && (
                                            <Text style={styles.historyProvenanceText}>
                                                Expired unresolved: Quorum not reached
                                            </Text>
                                        )}
                                    </View>
                                </View>
                            );
                        })
                    )}
                </>
            )}
        </View>
    );
}
