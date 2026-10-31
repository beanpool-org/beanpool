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
    reportRemovalCase,
} from '../utils/db';
import { beansOn, type NodeFeatures } from '../utils/node-profile';
import { ownVoteSummary, startingVoteCount, voteButtonStates } from '../utils/decision-own-vote';
import { LOCAL_COMMUNITY_STRIP, formatDate, formatNumber, inCapitalsOf, t, tn, word, type WordKey } from '@beanpool/core';
import {
    DECISION_CARD_WORDS, NO_TRADE_POOL_VOTE_MESSAGE, caseHiddenLine, electorateLine, isOwnRemoval, isPauseVote, keepSuspensionHeadline, minYesLine,
    notExecutedLine, ownerDecisionLine, pauseVoteBody, pauseVoteHeadline, poolVoteBlocker, proposedByLine, replyHeading, replyTakenDownLine, secondPauseLine, turnoutLine,
    voiceCreditsLine,
} from '../utils/decision-card';
import { LocalCommunityMark, ExampleHeader } from './showcase/LocalCommunityMark';
import { samplePoolVoting } from './showcase/sample-screens';
import { signedRequestWords } from './signed-request-lines';
import { RemovalReplySheet } from './RemovalReplySheet';

/**
 * The question Decide's button and the Commons "+" ask before a Decision can be proposed, whole, in the member's language.
 * With Beans on, a member proposes once they have completed a trade (or as a node admin). With Beans off no trade can be made,
 * so only node admins and members who traded before Beans went off can propose (checkProposalStanding), and nothing may
 * ask for a trade. True when it refused.
 */
export function proposeRefusal(canPropose: boolean, hasOpenDecision: boolean, beans: boolean): boolean {
    if (!canPropose) {
        if (beans) Alert.alert(t('Complete a Trade First'), t('You can propose a Decision once you have completed a trade.'));
        else Alert.alert(t('No Trades Here'), t("With Beans switched off, nobody can complete a trade here, so you can't propose a Decision. Node admins can."));
        return true;
    }
    if (hasOpenDecision) {
        Alert.alert(t('Limit Reached'), t('You already have an open decision (limit 1 open decision per author).'));
        return true;
    }
    return false;
}

/**
 * What a Decision does, what it touches and where it ended, as the node names them: word() keys, shown through t(). A
 * name this build doesn't know is shown as the node wrote it (an effect title-cased, a status in capitals, as always).
 * The tables' own names only (a "constructor" is not one).
 */
const EFFECT_WORDS: Readonly<Record<string, WordKey>> = {
    suspend_member: word('Suspend Member'), unsuspend_member: word('Unsuspend Member'), freeze_credit: word('Freeze Credit'),
    unfreeze_credit: word('Unfreeze Credit'), grant_voucher: word('Grant Voucher'), revoke_voucher: word('Revoke Voucher'),
    remove_lead_keeper: word('Remove Lead Keeper'), reinstate_member: word('Reinstate Member'), keep_suspension: word('Keep Suspension?'),
    remove_member: word('Remove Member'), grant_enterprise: word('Grant Enterprise'), grant_hardship: word('Grant Hardship'),
    write_off_deficit: word('Write Off Deficit'), forgive_debt: word('Forgive Debt'),
};
const TOUCH_WORDS: Readonly<Record<string, WordKey>> = { member: word('member', 'what a Decision touches'), pool: word('pool', 'what a Decision touches') };
const STATUS_WORDS: Readonly<Record<string, WordKey>> = {
    open: word('OPEN', 'Decision status'), passed: word('PASSED'), failed: word('FAILED'), unresolved: word('UNRESOLVED'),
    passed_queued_for_funds: word('PASSED QUEUED FOR FUNDS'), execution_pending_grace: word('EXECUTION PENDING GRACE'),
    execution_blocked: word('EXECUTION BLOCKED'), execution_void: word('EXECUTION VOID'), executed: word('EXECUTED'), admin_halted: word('ADMIN HALTED'),
};
const HISTORY_FILTER_WORDS: Readonly<Record<'all' | 'executed' | 'failed' | 'void', WordKey>> = {
    all: word('All'), executed: word('Executed', 'Decision history filter'), failed: word('Failed', 'Decision history filter'), void: word('Void', 'Decision history filter'),
};
const own = (table: object, name: string) => Object.prototype.hasOwnProperty.call(table, name);

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
    preview?: boolean;
    features?: NodeFeatures | null;
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
    preview = false,
    features,
}: Props) {
    const { theme, colors } = useTheme();
    const showsBeans = beansOn(features);
    const [votingId, setVotingId] = useState<string | null>(null);
    const [selectedVoteCount, setSelectedVoteCount] = useState<Record<string, number>>({});
    const [historyFilter, setHistoryFilter] = useState<'all' | 'executed' | 'failed' | 'void'>('all');
    // The vote on removing this member whose case they are replying to (removal by vote, Amendment A point 2), and the
    // reply the node has, to start a change from.
    const [replyTarget, setReplyTarget] = useState<{ id: string; current: string | null } | null>(null);
    // Votes whose case the member has reported as false (Amendment A point 4).
    const [reportedCases, setReportedCases] = useState<Record<string, boolean>>({});

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
        if (diffMs <= 0) return t('Closing now');
        // English writes one form for both, as it always has.
        const mins = Math.floor(diffMs / 60000);
        if (mins < 60) return tn(mins, '{n}m left', '{n}m left');
        const hours = Math.floor(diffMs / 3600000);
        if (hours < 48) return tn(hours, '{n}h left', '{n}h left');
        const days = Math.ceil(diffMs / (24 * 3600000));
        return tn(days, '{n} days left', '{n} days left');
    };

    const formatEffectLabel = (effect: string) => {
        if (own(EFFECT_WORDS, effect)) return t(EFFECT_WORDS[effect]);
        return effect
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    };

    /** "TOUCHES: POOL": what a Decision touches, in capitals the language's way. */
    const touchesLabel = (touches: string) => inCapitalsOf(t('Touches: {what}', { what: own(TOUCH_WORDS, touches) ? t(TOUCH_WORDS[touches]) : touches }));

    const handleVote = async (decision: DecisionWithTally, support: boolean) => {
        if (!identity?.publicKey) {
            Alert.alert(t('Not Logged In'), t('You must be connected with an active account to vote.'));
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
                // English writes one form for both, as it always has.
                Alert.alert(t('Vote Recorded'), support
                    ? tn(count, 'Your YES vote ({n} weight) has been cast.', 'Your YES vote ({n} weight) has been cast.')
                    : tn(count, 'Your NO vote ({n} weight) has been cast.', 'Your NO vote ({n} weight) has been cast.'));
                await onRefresh();
            } else {
                // The node's own words as it sent them (slice S4); the one the card also says, in the member's language.
                const refusal: string | undefined = (res as any).error;
                Alert.alert(t('Voting Error'), refusal === NO_TRADE_POOL_VOTE_MESSAGE ? t(DECISION_CARD_WORDS.noTradePoolVote) : refusal || t('Failed to record vote'));
            }
        } catch (err: any) {
            Alert.alert(t('Error'), err.message ? signedRequestWords(err.message) : t('Failed to cast vote'));
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
        // The Commons switch's shape (app/(tabs)/projects.tsx): the icon above the words and the count in the corner, so a
        // longer language's words have the whole half at 320 dp and 1.3x text, not what an icon and a count beside them leave.
        viewTab: {
            flex: 1,
            minWidth: 0,
            minHeight: 56,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            paddingVertical: 8,
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
        // Shrinks onto two lines in its half rather than past the edge (a longer language's "Decisions History").
        viewTabText: {
            flexShrink: 1,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        viewTabTextActive: {
            color: colors.brand.primary,
        },
        badgePill: {
            position: 'absolute',
            top: 4,
            right: 6,
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 10,
            backgroundColor: colors.brand.fill,
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
            backgroundColor: colors.brand.fill,
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
            color: colors.feedback.warning.fg,
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
        // Shrinks to the card, so its pills wrap rather than run past the edge at 320 dp and 1.3x text (measured on main:
        // "1m1v" ran 59 px past it on a removal vote's card).
        tagRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            flexShrink: 1,
            minWidth: 0,
            gap: 6,
            alignItems: 'center',
        },
        touchPill: {
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 8,
            backgroundColor: colors.brand.tint,
        },
        // Labels in capitals are written so by inCapitalsOf (the language's way), never a textTransform (the phone's).
        touchPillText: {
            fontSize: 11,
            fontWeight: '700',
            color: colors.brand.primary,
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
            color: theme === 'dark' ? colors.feedback.warning.fg : palette.amber700,
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
            color: theme === 'dark' ? colors.feedback.warning.fg : palette.amber800,
        },
        keepBody: {
            fontSize: 13,
            color: colors.text.heading,
            lineHeight: 18,
        },
        blockerText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.feedback.warning.fg,
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
            backgroundColor: colors.brand.fill,
        },
        voteBtnNo: {
            backgroundColor: colors.feedback.danger.solid,
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
            flexShrink: 1,
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
        // Wraps: four filters in a longer language are wider than 320 dp.
        filterRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
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
            backgroundColor: colors.brand.fill,
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
        statCard: {
            backgroundColor: colors.surface.card,
            borderRadius: 14,
            padding: 12,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        statCardLabel: {
            fontSize: 11,
            color: colors.text.secondary,
            fontWeight: '700',
            letterSpacing: 0.5,
            marginBottom: 6,
        },
        statCardAmount: {
            fontSize: 20,
            color: colors.text.heading,
            fontWeight: '800',
        },
        statCardHint: {
            fontSize: 11,
            color: colors.text.muted,
            marginTop: 4,
            lineHeight: 15,
        },
        // A vote on removing a member (removal by vote, Amendment A): its case hidden as false, who proposed it, the
        // member's reply, and the member's own ways to reply and to report the case.
        caseHiddenText: {
            fontSize: 13,
            color: colors.feedback.warning.fg,
            fontWeight: '700',
            lineHeight: 18,
            marginBottom: 12,
        },
        proposedByText: {
            fontSize: 12,
            color: colors.text.secondary,
            marginBottom: 8,
        },
        replyBox: {
            backgroundColor: colors.feedback.info.bg,
            borderRadius: 12,
            padding: 12,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: colors.feedback.info.border,
            gap: 4,
        },
        replyHeading: {
            fontSize: 13,
            fontWeight: '800',
            color: colors.feedback.info.fg,
        },
        replyText: {
            fontSize: 14,
            color: colors.text.heading,
            lineHeight: 20,
        },
        caseLinkBtn: {
            minHeight: 44,
            justifyContent: 'center',
            alignSelf: 'flex-start',
        },
        caseLinkText: {
            fontSize: 13,
            fontWeight: '800',
            color: colors.feedback.info.fg,
            textDecorationLine: 'underline',
        },
        reportLinkText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.feedback.danger.fg,
            textDecorationLine: 'underline',
        },
        reportedText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.feedback.success.fg,
            marginBottom: 8,
        },
    }));

    const handleReportCase = (decision: DecisionWithTally) => {
        Alert.alert(
            t('Report this case as false'),
            t('Report this case as a false accusation? The admins and owners see your report, and who brought the case.'),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Report'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await reportRemovalCase(decision.id);
                            setReportedCases(prev => ({ ...prev, [decision.id]: true }));
                        } catch (err: any) {
                            Alert.alert(t('Error'), err?.message ? signedRequestWords(err.message) : t('Your report could not be sent.'));
                        }
                    },
                },
            ],
        );
    };

    /**
     * A vote on removing a member, beside its case (removal by vote, Amendment A): who proposed it (a member's own, from
     * before; a pause's names its admin in its box), the member's reply or, once an admin took it down, their reason in its
     * place, and to the member themself the way to reply while it is open (a sheet, RemovalReplySheet; not after a
     * takedown) and to report the case as false. Nothing for any other Decision.
     */
    const removalCaseParts = (item: DecisionWithTally, open: boolean) => {
        if (item.effect !== 'remove_member') return null;
        const mine = !preview && isOwnRemoval(item, identity?.publicKey);
        const proposedBy = proposedByLine(item);
        const takenDown = !!item.replyHiddenAt;
        return (
            <>
                {!!proposedBy && <Text style={styles.proposedByText} testID="removal-proposed-by">{proposedBy}</Text>}
                {takenDown && (
                    <Text style={styles.caseHiddenText} testID="removal-reply-taken-down">
                        {replyTakenDownLine(item.params, item.subject?.slice(0, 8) || t('a member'), mine, item.replyHiddenReason)}
                    </Text>
                )}
                {!!item.subjectReply && (
                    <View style={styles.replyBox} testID="removal-reply">
                        <Text style={styles.replyHeading}>{replyHeading(item.params, item.subject?.slice(0, 8) || t('a member'), mine)}</Text>
                        <Text style={styles.replyText}>{item.subjectReply}</Text>
                    </View>
                )}
                {mine && open && !takenDown && (
                    <Pressable
                        accessibilityRole="button"
                        style={styles.caseLinkBtn}
                        onPress={() => setReplyTarget({ id: item.id, current: item.subjectReply ?? null })}
                        testID="removal-reply-open"
                    >
                        <Text style={styles.caseLinkText}>{item.subjectReply ? t('Change your reply') : t('Reply to this case')}</Text>
                    </Pressable>
                )}
                {mine && item.proposer?.kind !== 'password' && (
                    reportedCases[item.id] ? (
                        <Text style={styles.reportedText} testID="removal-case-reported">{t('Reported. The admins and owners will look at it.')}</Text>
                    ) : (
                        <Pressable accessibilityRole="button" style={styles.caseLinkBtn} onPress={() => handleReportCase(item)} testID="removal-case-report">
                            <Text style={styles.reportLinkText}>{t('Report this case as false')}</Text>
                        </Pressable>
                    )
                )}
            </>
        );
    };

    return (
        <View style={styles.container} testID={preview ? 'decide-preview' : undefined}>
            <RemovalReplySheet
                decisionId={replyTarget?.id ?? null}
                current={replyTarget?.current ?? null}
                onClose={() => setReplyTarget(null)}
                onSent={onRefresh}
            />
            {preview && (
                <View style={{ marginBottom: 16 }}>
                    <View style={{ marginHorizontal: -16 }}>
                        <LocalCommunityMark variant="strip" feature="decisions" />
                        <ExampleHeader text={t(LOCAL_COMMUNITY_STRIP.header)} />
                    </View>
                    <View style={[styles.statCard, { marginTop: 12 }]} testID="voice-credits-card">
                        <Text style={styles.statCardLabel} numberOfLines={2}>{inCapitalsOf(t('Voice credits'))}</Text>
                        <Text style={styles.statCardAmount} numberOfLines={1}>{formatNumber(Math.floor(samplePoolVoting().voiceCredits))}</Text>
                        <Text style={styles.statCardHint}>
                            {t('For money votes · from completed trades · N votes cost N×N')}
                        </Text>
                    </View>
                </View>
            )}
            {/* View Switcher: Open Decisions vs History */}
            <View style={styles.viewSelector} accessibilityRole="tablist" accessibilityLabel={t('Decisions view')}>
                <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected: activeView === 'open' }}
                    accessibilityLabel={t('Open Decisions')}
                    style={[styles.viewTab, activeView === 'open' && styles.viewTabActive]}
                    onPress={() => onChangeView('open')}
                >
                    <MaterialCommunityIcons
                        name="vote"
                        size={16}
                        color={activeView === 'open' ? colors.brand.primary : colors.text.secondary}
                    />
                    <Text style={[styles.viewTabText, activeView === 'open' && styles.viewTabTextActive]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>
                        {t('Open Decisions')}
                    </Text>
                    {openDecisions.length > 0 && (
                        <View style={styles.badgePill}>
                            <Text style={styles.badgePillText}>{formatNumber(openDecisions.length)}</Text>
                        </View>
                    )}
                </Pressable>

                <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected: activeView === 'history' }}
                    accessibilityLabel={t('Decisions History')}
                    style={[styles.viewTab, activeView === 'history' && styles.viewTabActive]}
                    onPress={() => onChangeView('history')}
                >
                    <MaterialCommunityIcons
                        name="history"
                        size={16}
                        color={activeView === 'history' ? colors.brand.primary : colors.text.secondary}
                    />
                    <Text style={[styles.viewTabText, activeView === 'history' && styles.viewTabTextActive]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>
                        {t('Decisions History')}
                    </Text>
                </Pressable>
            </View>

            {/* OPEN DECISIONS VIEW */}
            {activeView === 'open' && (
                <>
                    {/* Propose Decision Banner (a completed trade or a node admin; with Beans off no new trade can count; 1 open per author; no bond) */}
                    <View style={styles.proposeBanner}>
                        <View style={styles.proposeHeaderRow}>
                            <Text style={styles.proposeTitle}>{t('🌱 Propose Community Action')}</Text>
                            <Text style={{ fontSize: 12, color: colors.text.muted }}>{t('No bond required')}</Text>
                        </View>
                        <Text style={styles.proposeDesc}>
                            {showsBeans
                                ? t('Binding decisions execute automatically upon passing (§3.7). Open to members who have completed a trade, and to node admins.')
                                : t('Binding decisions execute automatically upon passing (§3.7). Open to node admins, and to members who completed a trade before Beans were switched off.')}
                        </Text>
                        {preview ? (
                            <LocalCommunityMark variant="action" feature="decisions" label={t('+ Propose a Decision')} />
                        ) : (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Propose a Community Decision')}
                                style={[styles.proposeBtn, (!canPropose || hasOpenDecision) && styles.proposeBtnDisabled]}
                                onPress={() => {
                                    if (proposeRefusal(canPropose, hasOpenDecision, showsBeans)) return;
                                    onOpenPropose();
                                }}
                            >
                                <Text style={[styles.proposeBtnText, (!canPropose || hasOpenDecision) && styles.proposeBtnTextDisabled]}>
                                    {t('+ Propose a Decision')}
                                </Text>
                            </Pressable>
                        )}
                        {!preview && !canPropose && (
                            <Text style={styles.gateWarning}>
                                {showsBeans
                                    ? t('⚠️ You can propose once you have completed a trade.')
                                    : t("⚠️ With Beans switched off, you can't complete a trade here, so you can't propose. Node admins can.")}
                            </Text>
                        )}
                        {!preview && canPropose && hasOpenDecision && (
                            <Text style={styles.gateWarning}>
                                {t('ℹ️ You have an open decision. Wait for it to conclude before opening another.')}
                            </Text>
                        )}
                    </View>

                    {/* Open Decisions List */}
                    {openDecisions.length === 0 ? (
                        <View style={styles.emptyState}>
                            <MaterialCommunityIcons name="ballot-outline" size={40} color={colors.text.muted} />
                            <Text style={styles.emptyTitle}>{t('No open decisions right now')}</Text>
                            <Text style={styles.emptyDesc}>
                                {t('Community decisions appear here when members propose binding actions.')}
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
                            const targetName = item.params?.memberName || item.subject?.slice(0, 8) || t('Member');
                            // The node sends the member's balance and debt only to those who can vote in it (and to the member):
                            // balances are private (2026-09-28). Anyone else is told so, never shown a made-up 0.
                            const knowsDebt = typeof item.params?.debt === 'number' || typeof item.params?.balance === 'number';
                            const debtAmount = typeof item.params?.debt === 'number' ? Math.abs(item.params.debt) : (typeof item.params?.balance === 'number' ? Math.abs(Math.min(0, item.params.balance)) : 0);
                            const poolAmount = Math.round(item.params?.commonsPool ?? balanceState.commons ?? 0);
                            // Whole sentences; English writes "beans" for one and many, as it always has.
                            const debtWriteOffLine = !knowsDebt
                                ? tn(poolAmount, "Balances are private: only the members who can vote in this see {name}'s balance and any debt. The Commons pool holds {n} beans.", "Balances are private: only the members who can vote in this see {name}'s balance and any debt. The Commons pool holds {n} beans.", { name: targetName })
                                : debtAmount > 0
                                    ? tn(debtAmount, "{name}'s balance is \u2212{n} beans. Removing them charges that {n} to the Commons pool, which currently holds {pool}.", "{name}'s balance is \u2212{n} beans. Removing them charges that {n} to the Commons pool, which currently holds {pool}.", { name: targetName, pool: poolAmount })
                                    : t('{name} has no debt. Removing them charges nothing to the Commons pool, which currently holds {pool}.', { name: targetName, pool: poolAmount });

                            return (
                                <View key={item.id} style={styles.card} testID={preview ? 'sample-decision' : undefined}>
                                    {/* Header tags: Touches, Effect, Franchise, Time Left */}
                                    <View style={styles.cardHeader}>
                                        <View style={styles.tagRow}>
                                            <View style={styles.touchPill}>
                                                <Text style={styles.touchPillText}>{touchesLabel(item.touches)}</Text>
                                            </View>
                                            <View style={styles.effectPill}>
                                                <Text style={styles.effectPillText}>{formatEffectLabel(item.effect)}</Text>
                                            </View>
                                            <View style={styles.effectPill}>
                                                <Text style={styles.effectPillText}>
                                                    {item.franchise === 'quadratic_trade' ? t('Quadratic') : t('1m1v')}
                                                </Text>
                                            </View>
                                        </View>
                                        <View style={styles.timePill}>
                                            <MaterialCommunityIcons name="clock-outline" size={12} color={styles.timePillText.color} />
                                            <Text style={styles.timePillText}>{formatTimeLeft(item.closesAt)}</Text>
                                        </View>
                                    </View>

                                    {/* Title & Description; a case an admin hid as false, in its place (Amendment A point 4) */}
                                    <Text style={styles.decisionTitle}>{item.title}</Text>
                                    {item.caseHiddenAt
                                        ? <Text style={styles.caseHiddenText} testID="removal-case-hidden">{caseHiddenLine(item.caseHiddenReason)}</Text>
                                        : <Text style={styles.decisionDesc}>{item.description}</Text>}

                                    {/* Emergency suspension: the node opened this vote when an admin suspended someone (answer L) */}
                                    {item.effect === 'keep_suspension' && (
                                        <View style={styles.keepBox} testID="keep-suspension-box">
                                            <Text style={styles.keepHeadline}>
                                                {keepSuspensionHeadline(item.params, item.subject?.slice(0, 8) || t('a member'))}
                                            </Text>
                                            <Text style={styles.keepBody}>
                                                {t("Vote Yes to keep it. If this vote doesn't pass, the suspension lifts by itself.")}
                                            </Text>
                                        </View>
                                    )}

                                    {/* A pause's own vote: the node opened it when an admin paused someone (removal by vote S2) */}
                                    {isPauseVote(item) && (
                                        <View style={styles.keepBox} testID="pause-vote-box">
                                            <Text style={styles.keepHeadline}>
                                                {pauseVoteHeadline(item.params, item.subject?.slice(0, 8) || t('a member'), item.proposer)}
                                            </Text>
                                            {/* A second pause within 30 days of a vote that didn't remove them (removal by vote S4) */}
                                            {secondPauseLine(item.params) && (
                                                <Text style={styles.keepHeadline} testID="second-pause-line">{secondPauseLine(item.params)}</Text>
                                            )}
                                            {pauseVoteBody(item.params, item.subject?.slice(0, 8) || t('a member'), tally) && (
                                                <Text style={styles.keepBody}>
                                                    {pauseVoteBody(item.params, item.subject?.slice(0, 8) || t('a member'), tally)}
                                                </Text>
                                            )}
                                            {/* Too few can vote: the owner decides when it closes (removal by vote S6) */}
                                            {ownerDecisionLine(item, tally, item.subject?.slice(0, 8) || t('a member')) && (
                                                <Text style={styles.keepHeadline} testID="owner-decision-line">
                                                    {ownerDecisionLine(item, tally, item.subject?.slice(0, 8) || t('a member'))}
                                                </Text>
                                            )}
                                        </View>
                                    )}

                                    {removalCaseParts(item, true)}

                                    {/* §3.8 Removal Ballot debt-write-off line */}
                                    {showsBeans && item.effect === 'remove_member' && (
                                        <View style={styles.debtWarningBox} testID="removal-debt-write-off-box">
                                            <Text style={styles.debtWarningLabel}>{inCapitalsOf(t('Mandatory Debt Disclosure (§3.8)'))}</Text>
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
                                                    {t('Turnout: {line}', { line: turnoutLine(tally) })}
                                                </Text>
                                                <Text style={[styles.metricValue, { color: tally.quorumMet ? colors.feedback.success.fg : colors.text.secondary }]}>
                                                    {tally.quorumMet ? t('Met ✅') : t('Pending', undefined, 'quorum not met yet')}
                                                </Text>
                                            </View>
                                            <View
                                                style={styles.barBg}
                                                accessibilityRole="progressbar"
                                                accessibilityValue={{ min: 0, max: 100, now: Math.min(100, quorumPct) }}
                                                accessibilityLabel={t('Quorum progress')}
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
                                                    {t('Tally: Yes {yes} ({pct}%) · No {no}', { yes: tally.yesWeight, pct: supportPct, no: tally.noWeight })}
                                                </Text>
                                                <Text style={styles.metricValue}>
                                                    {t('Needs {pct}%', { pct: thresholdPct })}
                                                </Text>
                                            </View>
                                            <View
                                                style={styles.barBg}
                                                accessibilityRole="progressbar"
                                                accessibilityValue={{ min: 0, max: 100, now: Math.min(100, supportPct) }}
                                                accessibilityLabel={t('Support progress')}
                                            >
                                                <View
                                                    style={[
                                                        styles.barFill,
                                                        { width: `${supportPct}%`, backgroundColor: tally.passed ? palette.green500 : colors.feedback.warning.solid },
                                                    ]}
                                                />
                                            </View>
                                            {minYesLine(tally) && <Text style={styles.electorateText} testID="min-yes-line">{minYesLine(tally)}</Text>}
                                        </View>
                                    </View>

                                    {/* Voting Action Section */}
                                    <View style={styles.voteSection}>
                                        {item.franchise === 'quadratic_trade' && (
                                            <View style={styles.qvStepper}>
                                                <Text style={styles.qvLabel}>
                                                    {/* English writes one form for both, as it always has. */}
                                                    {tn(currentCount * currentCount, 'Votes: {count} (Cost: {n} credits)', 'Votes: {count} (Cost: {n} credits)', { count: currentCount })}
                                                </Text>
                                                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                                                    <Pressable
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('Decrease votes')}
                                                        accessibilityHint={t('Decreases vote count from {n}', { n: currentCount })}
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
                                                        accessibilityLabel={t('Increase votes')}
                                                        accessibilityHint={t('Increases vote count from {n}', { n: currentCount })}
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

                                        {preview ? (
                                            <View style={{ gap: 8 }}>
                                                <LocalCommunityMark variant="action" feature="decisions" label={t('👍 Vote YES')} />
                                                <LocalCommunityMark variant="action" feature="decisions" label={t('👎 Vote NO')} />
                                            </View>
                                        ) : isOwnRemoval(item, identity?.publicKey) ? (
                                            <Text style={styles.blockerText} testID="own-removal-note">{t("This vote is about you, so you can't vote on it.")}</Text>
                                        ) : (
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
                                        )}
                                        <Text style={styles.secretNote} testID="secret-ballot-note">
                                            {preview ? t('Secret ballot: members see the totals, never who voted how.') : t('🔒 Secret ballot: members see the totals, never who voted how.')}
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
                                    {t(HISTORY_FILTER_WORDS[f])}
                                </Text>
                            </Pressable>
                        ))}
                    </View>

                    {filteredPastDecisions.length === 0 ? (
                        <View style={styles.emptyState}>
                            <MaterialCommunityIcons name="history" size={40} color={colors.text.muted} />
                            <Text style={styles.emptyTitle}>{t('No past decisions')}</Text>
                            <Text style={styles.emptyDesc}>
                                {t('Completed community votes and executed effects will be recorded here.')}
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
                                                <Text style={styles.touchPillText}>{touchesLabel(item.touches)}</Text>
                                            </View>
                                            <View style={styles.effectPill}>
                                                <Text style={styles.effectPillText}>{formatEffectLabel(item.effect)}</Text>
                                            </View>
                                        </View>
                                        <View style={[styles.historyStatusBadge, badgeStyle]}>
                                            <Text style={textStyle}>{own(STATUS_WORDS, item.status) ? t(STATUS_WORDS[item.status]) : item.status.toUpperCase().replace(/_/g, ' ')}</Text>
                                        </View>
                                    </View>

                                    <Text style={styles.decisionTitle}>{item.title}</Text>
                                    {item.caseHiddenAt
                                        ? <Text style={styles.caseHiddenText} testID="removal-case-hidden">{caseHiddenLine(item.caseHiddenReason)}</Text>
                                        : <Text style={styles.decisionDesc}>{item.description}</Text>}

                                    {removalCaseParts(item, false)}

                                    {/* Final Tally Summary */}
                                    <View style={styles.metricsContainer}>
                                        <View style={styles.metricRow}>
                                            <Text style={styles.metricLabel}>
                                                {tally.quorumMet ? t('Turnout: {line} (Met)', { line: turnoutLine(tally) }) : t('Turnout: {line} (Unmet)', { line: turnoutLine(tally) })}
                                            </Text>
                                            <Text style={styles.metricValue}>
                                                {t('Yes: {yes} ({pct}%) · No: {no}', { yes: tally.yesWeight, pct: supportPct, no: tally.noWeight })}
                                            </Text>
                                        </View>
                                    </View>

                                    {/* Who Authorised Each Executed Effect (§3.7, §3.8) */}
                                    <View style={styles.historyProvenanceBox}>
                                        <Text style={styles.historyProvenanceLabel}>{inCapitalsOf(t('Authorisation & Provenance'))}</Text>
                                        {/* Too few could vote, and an owner decided it (removal by vote S6): not the community's vote */}
                                        {item.ownerDecisionCarriedAt && (
                                            <Text style={styles.historyProvenanceText} testID="owner-decision-line">
                                                {ownerDecisionLine(item, tally, item.subject?.slice(0, 8) || t('a member'))}
                                            </Text>
                                        )}
                                        {item.status === 'executed' && (
                                            <>
                                                {!item.ownerDecisionCarriedAt && (
                                                    <Text style={styles.historyProvenanceText}>
                                                        {t('Authorised by: Community Vote ({ref})', { ref: `system:decision:${item.id.slice(0, 8)}` })}
                                                    </Text>
                                                )}
                                                <Text style={{ fontSize: 11, color: colors.text.muted, marginTop: 2 }}>
                                                    {t('Provenance: {ref} · {reason}', { ref: `system:decision:${item.id}`, reason: item.executionReason || t('Executed successfully') })}
                                                </Text>
                                            </>
                                        )}
                                        {item.status === 'admin_halted' && (
                                            <Text style={styles.historyProvenanceText}>
                                                {t('Halted by an admin — Reason: {reason}', { reason: item.adminHaltReason ?? '' })}
                                            </Text>
                                        )}
                                        {item.status === 'execution_pending_grace' && (
                                            <Text style={styles.historyProvenanceText}>
                                                {t('In 7-day Grace Period: Scheduled for removal on {date}', { date: formatDate(new Date(item.gracePeriodEndsAt!), 'day-month-year') })}
                                            </Text>
                                        )}
                                        {item.status === 'execution_void' && (
                                            <Text style={styles.historyProvenanceText}>
                                                {t('Void: {reason}', { reason: item.executionReason || t('Subject does not exist or was pruned') })}
                                            </Text>
                                        )}
                                        {item.status === 'failed' && (
                                            <Text style={styles.historyProvenanceText}>
                                                {notExecutedLine(tally, item)}
                                            </Text>
                                        )}
                                        {item.status === 'unresolved' && (
                                            <Text style={styles.historyProvenanceText}>
                                                {t('Expired unresolved: Quorum not reached')}
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
