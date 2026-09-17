import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, ActivityIndicator, Image, TextInput, Modal } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useFocusEffect, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import {
    getTreasuryDetail, getBalance, treasurySweep, treasuryApprove,
    treasuryComplete, treasuryReject, treasuryPledge, reportAbuse,
    deleteCrowdfundProjectApi, requestToJoinEnterprise, approveKeeperRequest,
    declineKeeperRequest, proposeEnterpriseSuccession, voteEnterpriseSuccession,
    getEnterpriseThread, postEnterpriseThreadMessage, removeEnterpriseThreadMessage
} from '../utils/db';
import { decodeBase64, decodeUtf8 } from '../utils/crypto';
import { loadIdentity } from '../utils/identity';
import { MemberAvatar } from '../components/MemberAvatar';
import { useTheme, useStyles } from './ThemeContext';

function decodeThreadMessage(ciphertext: string, type: string): string {
    if (type === 'removed') return 'removed by a keeper';
    try {
        return decodeUtf8(decodeBase64(ciphertext));
    } catch {
        return ciphertext;
    }
}

// A community enterprise's detail screen. Everyone sees the transparency view (balance, credit line,
// purpose, goal progress if bounded, live listings, recent activity — the Commons is meant to be legible).
// A member holding the keepership of THIS enterprise additionally gets the keeper controls: post its
// Offer/Need and sweep its surplus into the shared Commons pool.
export default function TreasuryDetailScreen() {
    const params = useLocalSearchParams<{ publicKey?: string | string[]; id?: string | string[]; name?: string | string[]; avatar?: string | string[] }>();
    const rawKey = params.publicKey || params.id;
    const treasuryKey = typeof rawKey === 'string' ? rawKey : Array.isArray(rawKey) ? rawKey[0] : undefined;
    const nameParam = typeof params.name === 'string' ? params.name : Array.isArray(params.name) ? params.name[0] : undefined;
    const avatarParam = typeof params.avatar === 'string' ? params.avatar : Array.isArray(params.avatar) ? params.avatar[0] : undefined;
    const { theme, colors } = useTheme();

    const [detail, setDetail] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [isKeeperOfThis, setIsKeeperOfThis] = useState(false);
    const [sweepAmount, setSweepAmount] = useState('');
    const [sweeping, setSweeping] = useState(false);
    const [actionState, setActionState] = useState<{ id: string; type: 'approve' | 'reject' | 'complete' } | null>(null);
    const [hourlyDealPrompt, setHourlyDealPrompt] = useState<any | null>(null);
    const [hourlyDealHours, setHourlyDealHours] = useState('');
    const [pledgeAmount, setPledgeAmount] = useState('');
    const [pledgeMemo, setPledgeMemo] = useState('');
    const [pledging, setPledging] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [showReportForm, setShowReportForm] = useState(false);
    const [reportReason, setReportReason] = useState('');
    const [reporting, setReporting] = useState(false);
    const [identity, setIdentity] = useState<any>(null);

    // Keeper Join Request State
    const [joinBackingPledge, setJoinBackingPledge] = useState('0');
    const [submittingJoin, setSubmittingJoin] = useState(false);
    const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);

    // Lead Succession State
    const [submittingSuccession, setSubmittingSuccession] = useState(false);
    const [showCandidatePicker, setShowCandidatePicker] = useState(false);

    // Enterprise Discussion Thread State
    const [threadMessages, setThreadMessages] = useState<any[]>([]);
    const [threadReadOnly, setThreadReadOnly] = useState(false);
    const [threadInput, setThreadInput] = useState('');
    const [threadPosting, setThreadPosting] = useState(false);
    const [threadRemovingId, setThreadRemovingId] = useState<string | null>(null);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: colors.surface.app },
        backButton: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, fontSize: 18, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.3 },
        scroll: { padding: 16, paddingBottom: 60 },

        identityRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
        avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.surface.subtle },
        avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
        name: { fontSize: 20, fontWeight: '800', color: colors.text.heading },
        subtitle: { fontSize: 13, color: colors.text.secondary, marginTop: 2 },

        purposeCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        purposeLabel: { fontSize: 10, fontWeight: '800', color: colors.text.secondary, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 },
        purposeText: { fontSize: 14, color: colors.text.body, lineHeight: 21 },

        progressCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 10 },
        currentAmt: { fontSize: 20, fontWeight: '800', color: colors.text.body },
        progressLabel: { fontSize: 13, fontWeight: 'normal', color: colors.text.secondary },
        goalAmt: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
        deadlineBadge: { fontSize: 12, fontWeight: '700', color: colors.brand.primary, backgroundColor: colors.brand.tint, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden' },
        deadlineExpired: { color: colors.feedback.danger.solid, backgroundColor: colors.surface.subtle },
        progressBarBg: { height: 8, backgroundColor: colors.surface.subtle, borderRadius: 4, overflow: 'hidden', marginBottom: 10 },
        progressBarFill: { height: '100%', borderRadius: 4 },
        escrowNotice: { fontSize: 12, color: colors.text.secondary, lineHeight: 17, marginBottom: 14 },
        pledgeBox: { backgroundColor: colors.surface.app, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.default },
        pledgeInputRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
        pledgeAmountInput: { flex: 1, height: 44, backgroundColor: colors.surface.card, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, fontWeight: '700', color: colors.text.body, borderWidth: 1, borderColor: colors.border.strong },
        pledgeMemoInput: { flex: 2, height: 44, backgroundColor: colors.surface.card, borderRadius: 10, paddingHorizontal: 12, fontSize: 14, color: colors.text.body, borderWidth: 1, borderColor: colors.border.strong },
        pledgeButton: { backgroundColor: colors.brand.primary, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
        pledgeButtonText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13, letterSpacing: 0.5 },

        keepersCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        keepersLabel: { fontSize: 10, fontWeight: '800', color: colors.text.secondary, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
        keepersList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        keeperChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.surface.app, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default },
        keeperChipSuspended: { opacity: 0.6 },
        keeperCallsign: { fontSize: 13, fontWeight: '700', color: colors.text.heading },
        leadKeeperBadge: { backgroundColor: colors.feedback.warning.bg, color: colors.feedback.warning.fg, fontSize: 10, fontWeight: '800', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden', textTransform: 'uppercase', letterSpacing: 0.5 },
        keeperBadge: { backgroundColor: colors.surface.subtle, color: colors.text.secondary, fontSize: 10, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
        backingText: { fontSize: 11, fontWeight: '700', color: colors.brand.primary },

        // Join Request Section
        joinCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        joinTitle: { fontSize: 13, fontWeight: '800', color: colors.text.heading, marginBottom: 4 },
        joinDesc: { fontSize: 12, color: colors.text.secondary, lineHeight: 18, marginBottom: 12 },
        joinInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
        joinInput: { width: 80, height: 44, backgroundColor: colors.surface.app, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, fontWeight: '700', color: colors.text.body, borderWidth: 1, borderColor: colors.border.strong },
        joinAvailableText: { fontSize: 12, fontWeight: '700', color: colors.text.secondary, flex: 1 },
        joinButton: { backgroundColor: colors.brand.primary, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
        joinButtonDisabled: { opacity: 0.5 },
        joinButtonText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13 },
        pendingRequestBanner: { backgroundColor: colors.brand.tint, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.brand.primary, marginBottom: 16 },
        pendingRequestTitle: { fontSize: 12, fontWeight: '800', color: colors.brand.primary, marginBottom: 2 },
        pendingRequestText: { fontSize: 12, color: colors.brand.primary },

        // Pending Requests Review (for Lead / Sole / Admin)
        requestsCard: { backgroundColor: colors.feedback.warning.bg, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.feedback.warning.border, marginBottom: 16 },
        requestsTitle: { fontSize: 12, fontWeight: '800', color: colors.feedback.warning.fg, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
        requestRow: { backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border.default, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        requestInfo: { flex: 1 },
        requestCallsign: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        requestBacking: { fontSize: 12, color: colors.brand.primary, fontWeight: '600', marginTop: 2 },
        requestBtnRow: { flexDirection: 'row', gap: 8 },
        approveBtn: { backgroundColor: colors.brand.primary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
        approveBtnText: { color: colors.text.inverse, fontWeight: '700', fontSize: 12 },
        declineBtn: { backgroundColor: colors.surface.subtle, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border.default },
        declineBtnText: { color: colors.text.secondary, fontWeight: '600', fontSize: 12 },

        // Lead Succession
        successionCard: { backgroundColor: colors.feedback.warning.bg, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.feedback.warning.border, marginBottom: 16 },
        successionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
        successionTitle: { fontSize: 13, fontWeight: '800', color: colors.feedback.warning.solid },
        successionText: { fontSize: 12, color: colors.text.body, lineHeight: 18, marginBottom: 12 },
        successionVoteBox: { backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 8 },
        successionCandidateText: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        successionVotesText: { fontSize: 12, color: colors.text.secondary, marginTop: 2, marginBottom: 8 },
        voteBtn: { backgroundColor: colors.feedback.warning.solid, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
        voteBtnText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13 },
        votedBadge: { fontSize: 12, fontWeight: '700', color: colors.brand.primary, marginTop: 4 },
        proposeBtn: { backgroundColor: colors.brand.primary, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
        proposeBtnText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13 },
        candidateOption: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border.default, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        candidateOptionText: { fontSize: 15, fontWeight: '600', color: colors.text.heading },


        balanceCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 18, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        balanceLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
        balanceValue: { fontSize: 34, fontWeight: '900', letterSpacing: -1, marginTop: 4 },
        balancePos: { color: colors.brand.primary },
        balanceNeg: { color: colors.feedback.warning.solid },
        balanceMetaRow: { flexDirection: 'row', marginTop: 14, gap: 12 },
        metaBox: { flex: 1, backgroundColor: colors.surface.app, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: colors.border.default },
        metaLabel: { fontSize: 10, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
        metaValue: { fontSize: 16, fontWeight: '800', color: colors.text.heading, marginTop: 3 },

        sectionLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 8 },

        opPanel: { backgroundColor: colors.brand.tint, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.brand.primary, marginBottom: 16 },
        opTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
        opTitle: { fontSize: 13, fontWeight: '800', color: colors.brand.primary, letterSpacing: 0.3 },
        opBtnRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
        opBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.brand.primary, paddingVertical: 12, borderRadius: 12 },
        opBtnText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13 },
        sweepRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
        sweepInput: { flex: 1, height: 46, backgroundColor: colors.surface.card, borderRadius: 12, paddingHorizontal: 14, fontSize: 16, fontWeight: '700', color: colors.text.body, borderWidth: 1, borderColor: colors.border.strong },
        sweepBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.brand.primary, paddingHorizontal: 14, height: 46, borderRadius: 12, justifyContent: 'center' },
        sweepBtnDisabled: { opacity: 0.4 },
        sweepBtnText: { color: colors.brand.primary, fontWeight: '800', fontSize: 13 },
        opHint: { fontSize: 12, color: colors.brand.primary, marginTop: 10, lineHeight: 17 },

        listingCard: { backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 8 },
        listingTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
        typeBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
        typeBadgeOffer: { backgroundColor: colors.brand.tint },
        typeBadgeNeed: { backgroundColor: colors.surface.subtle },
        typeBadgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
        recurBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
        recurText: { fontSize: 10, color: colors.text.secondary, fontWeight: '700' },
        listingTitle: { fontSize: 15, fontWeight: '700', color: colors.text.heading, flex: 1 },
        listingPrice: { fontSize: 15, fontWeight: '800', color: colors.brand.primary },
        listingDesc: { fontSize: 13, color: colors.text.secondary, lineHeight: 18 },

        flowRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        flowIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
        flowMemo: { fontSize: 13, color: colors.text.body, fontWeight: '500' },
        flowTime: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
        flowAmount: { fontSize: 15, fontWeight: '800' },

        threadCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border.default, marginTop: 20 },
        threadHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
        threadTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        threadSubtitle: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },
        threadReadOnlyBanner: { backgroundColor: colors.surface.subtle, padding: 10, borderRadius: 8, marginBottom: 12, borderWidth: 1, borderColor: colors.border.default },
        threadReadOnlyText: { fontSize: 12, fontStyle: 'italic', color: colors.text.muted, textAlign: 'center' },
        threadMsgRow: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        threadMsgAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface.subtle },
        threadMsgContent: { flex: 1, minWidth: 0 },
        threadMsgMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 },
        threadMsgAuthor: { fontSize: 12, fontWeight: '700', color: colors.text.heading },
        threadMsgTime: { fontSize: 10, color: colors.text.muted },
        threadMsgText: { fontSize: 13, color: colors.text.body, lineHeight: 18 },
        threadMsgRemoved: { fontSize: 13, fontStyle: 'italic', color: colors.text.muted },
        threadInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border.default },
        threadInput: { flex: 1, backgroundColor: colors.surface.app, height: 42, borderRadius: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border.default, color: colors.text.body, fontSize: 13 },
        threadSendBtn: { height: 42, paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center' },
        threadSendBtnText: { color: colors.text.inverse, fontWeight: '700', fontSize: 13 },
        threadRemoveBtn: { padding: 4, marginLeft: 4 },

        emptyNote: { fontSize: 13, color: colors.text.muted, fontStyle: 'italic', paddingVertical: 12 },
        centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    }));

    const load = useCallback(() => {
        let active = true;
        setLoading(true);
        (async () => {
            try {
                const [d, id] = await Promise.all([
                    treasuryKey ? getTreasuryDetail(treasuryKey) : Promise.resolve(null),
                    loadIdentity()
                ]);
                if (!active) return;
                if (d) setDetail(d);
                setIdentity(id);
                if (id?.publicKey && treasuryKey) {
                    const b: any = await getBalance(id.publicKey).catch(() => ({}));
                    if (!active) return;
                    const mine: string[] = Array.isArray(b?.keeperOf) ? b.keeperOf : [];
                    const inKeepers = Array.isArray(d?.keepers) && d.keepers.some((k: any) => !k.suspended && (k.publicKey || k.pubkey || k.memberPubkey) === id.publicKey);
                    setIsKeeperOfThis(mine.includes(treasuryKey) || inKeepers);
                } else {
                    setIsKeeperOfThis(false);
                }
            } catch {
                // handle error
            } finally {
                if (active) setLoading(false);
            }
        })();
        loadThread();
        return () => { active = false; };
    }, [treasuryKey]);

    const loadThread = useCallback(async () => {
        if (!treasuryKey) return;
        try {
            const res = await getEnterpriseThread(treasuryKey);
            if (res) {
                setThreadMessages(res.messages || []);
                setThreadReadOnly(!!res.readOnly);
            }
        } catch {
            // ignore
        }
    }, [treasuryKey]);

    const handlePostThreadMessage = async () => {
        if (!treasuryKey || threadPosting || !threadInput.trim()) return;
        setThreadPosting(true);
        try {
            const res = await postEnterpriseThreadMessage(treasuryKey, threadInput.trim());
            if (res?.success) {
                setThreadInput('');
                await loadThread();
            } else {
                Alert.alert('Could not post', (res as any)?.error || 'Failed to post message');
            }
        } catch (e: any) {
            Alert.alert('Error', e.message || 'Could not post message');
        } finally {
            setThreadPosting(false);
        }
    };

    const handleRemoveThreadMessage = (messageId: string) => {
        Alert.alert(
            'Remove Message',
            'Are you sure you want to remove this message? It will show as "removed by a keeper".',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: async () => {
                        if (!treasuryKey) return;
                        setThreadRemovingId(messageId);
                        try {
                            await removeEnterpriseThreadMessage(treasuryKey, messageId);
                            await loadThread();
                        } catch (e: any) {
                            Alert.alert('Error', e.message || 'Could not remove message');
                        } finally {
                            setThreadRemovingId(null);
                        }
                    }
                }
            ]
        );
    };

    useFocusEffect(load);

    const balance = detail?.balance ?? 0;
    const name = detail?.name || nameParam || 'Community Enterprise';
    const avatar = detail?.avatar || avatarParam;

    const availableToBack = detail?.availableToBack ?? 0;
    const isLeadOrSoleKeeperOrAdmin = !!detail?.isLeadOrSoleKeeperOrAdmin;
    const keeperRequests: any[] = detail?.keeperRequests || [];
    const myPendingRequest = detail?.myPendingRequest || null;
    const leadInactivity = detail?.leadInactivity || null;
    const successionInfo = detail?.succession || null;
    const activeProposal = successionInfo?.proposals?.find((p: any) => p.status === 'active') || null;
    const isEligibleSuccessor = isKeeperOfThis && !!identity?.publicKey && !!leadInactivity?.leadPubkey && identity.publicKey !== leadInactivity.leadPubkey;


    const handleSweep = async () => {
        if (!treasuryKey || sweeping) return;
        const amt = Number(sweepAmount);
        if (isNaN(amt) || amt <= 0) { Alert.alert('Enter an amount', 'Type a positive number of Beans to sweep into the Commons.'); return; }
        if (amt > balance) { Alert.alert('Not enough surplus', `This enterprise only holds ${balance} 🫘.`); return; }
        setSweeping(true);
        try {
            await treasurySweep(treasuryKey, amt);
            Alert.alert('Swept to the Commons 🌱', `${amt} 🫘 moved from ${name} into the shared Commons pool.`);
            setSweepAmount('');
            load();
        } catch (e: any) {
            Alert.alert('Sweep failed', e.message || 'Could not sweep to the Commons.');
        } finally {
            setSweeping(false);
        }
    };

    const handleJoinRequest = async () => {
        if (!treasuryKey || submittingJoin) return;
        const available = detail?.availableToBack ?? 0;
        const amt = Number(joinBackingPledge);
        if (isNaN(amt) || amt < 0) {
            Alert.alert('Invalid Backing', 'Please enter 0 or a positive number of standing beans.');
            return;
        }
        if (amt > available) {
            Alert.alert('Exceeds Available Standing', `You have ${available} Beans of standing available to back this enterprise.`);
            return;
        }
        setSubmittingJoin(true);
        try {
            await requestToJoinEnterprise(treasuryKey, amt);
            Alert.alert('Request Submitted 🌱', `Your request to join as a keeper with ${amt} 🫘 backing has been submitted for review.`);
            load();
        } catch (e: any) {
            Alert.alert('Request Failed', e.message || 'Could not submit keeper request.');
        } finally {
            setSubmittingJoin(false);
        }
    };

    const handleApproveRequest = async (requestId: string) => {
        if (!treasuryKey || processingRequestId) return;
        setProcessingRequestId(requestId);
        try {
            await approveKeeperRequest(treasuryKey, requestId);
            Alert.alert('Request Approved 🌱', 'Member is now a keeper of this enterprise.');
            load();
        } catch (e: any) {
            Alert.alert('Approval Failed', e.message || 'Could not approve keeper request.');
        } finally {
            setProcessingRequestId(null);
        }
    };

    const handleDeclineRequest = async (requestId: string) => {
        if (!treasuryKey || processingRequestId) return;
        setProcessingRequestId(requestId);
        try {
            await declineKeeperRequest(treasuryKey, requestId);
            Alert.alert('Request Declined', 'Keeper request has been declined.');
            load();
        } catch (e: any) {
            Alert.alert('Decline Failed', e.message || 'Could not decline keeper request.');
        } finally {
            setProcessingRequestId(null);
        }
    };

    const handleProposeSuccession = async (candidatePubkey: string) => {
        if (!treasuryKey || submittingSuccession) return;
        setSubmittingSuccession(true);
        try {
            const res: any = await proposeEnterpriseSuccession(treasuryKey, candidatePubkey);
            const leadMoved = res?.executed ?? res?.leadMoved ?? false;
            const votesCount = res?.proposal?.votesCount ?? res?.votesCount ?? 1;
            const votesRequired = res?.proposal?.requiredVotes ?? res?.votesRequired ?? 2;
            if (leadMoved) {
                Alert.alert('Succession Passed 🌱', 'Lead keeper role has been transferred.');
            } else {
                Alert.alert('Succession Proposed 🌱', `Proposal submitted (${votesCount} of ${votesRequired} votes recorded).`);
            }
            setShowCandidatePicker(false);
            load();
        } catch (e: any) {
            Alert.alert('Proposal Failed', e.message || 'Could not propose lead succession.');
        } finally {
            setSubmittingSuccession(false);
        }
    };

    const handleVoteSuccession = async (proposalId: string) => {
        if (!treasuryKey || submittingSuccession) return;
        setSubmittingSuccession(true);
        try {
            const res: any = await voteEnterpriseSuccession(treasuryKey, proposalId);
            const leadMoved = res?.executed ?? res?.leadMoved ?? false;
            const votesCount = res?.proposal?.votesCount ?? res?.votesCount ?? 1;
            const votesRequired = res?.proposal?.requiredVotes ?? res?.votesRequired ?? 2;
            if (leadMoved) {
                Alert.alert('Succession Passed 🌱', 'Your vote was recorded and the lead keeper role has been transferred!');
            } else {
                Alert.alert('Vote Registered 🌱', `Vote recorded (${votesCount} of ${votesRequired} votes).`);
            }
            load();
        } catch (e: any) {
            Alert.alert('Vote Failed', e.message || 'Could not vote on succession.');
        } finally {
            setSubmittingSuccession(false);
        }
    };

    const handlePledge = async () => {
        if (!treasuryKey || pledging) return;
        const amt = Number(pledgeAmount);
        if (isNaN(amt) || amt <= 0) {
            Alert.alert('Invalid Amount', 'Please enter a positive number of Beans to pledge.');
            return;
        }
        setPledging(true);
        try {
            await treasuryPledge(treasuryKey, amt, pledgeMemo.trim() || undefined);
            Alert.alert('Pledge Successful! 🌱', `Thank you for pledging ${amt} 🫘 to ${name}.`);
            setPledgeAmount('');
            setPledgeMemo('');
            load();
        } catch (e: any) {
            Alert.alert('Pledge Failed', e.message || 'Could not complete pledge.');
        } finally {
            setPledging(false);
        }
    };

    const handleCancelInitiative = () => {
        if (!treasuryKey || cancelling) return;
        Alert.alert(
            'Cancel Initiative & Refund Backers?',
            'This will close the initiative and immediately refund all escrowed pledges back to their backers.',
            [
                { text: 'Keep Initiative', style: 'cancel' },
                {
                    text: 'Cancel & Refund',
                    style: 'destructive',
                    onPress: async () => {
                        setCancelling(true);
                        try {
                            await deleteCrowdfundProjectApi(treasuryKey);
                            Alert.alert('Initiative Cancelled 🌱', 'Pledges have been refunded to backers.');
                            router.back();
                        } catch (e: any) {
                            Alert.alert('Cancellation Failed', e.message || 'Could not cancel initiative.');
                        } finally {
                            setCancelling(false);
                        }
                    }
                }
            ]
        );
    };

    const getDaysRemaining = (deadline: string | null) => {
        if (!deadline) return null;
        const diff = new Date(deadline).getTime() - new Date().getTime();
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        if (days < 0) return 'Expired';
        if (days === 0) return 'Ends today';
        return `${days} days left`;
    };

    const handleApproveBid = async (txId: string) => {
        if (!treasuryKey) return;
        setActionState({ id: txId, type: 'approve' });
        try {
            await treasuryApprove(treasuryKey, txId);
            Alert.alert('Bid Approved ✅', 'Funds locked in trust successfully.');
            load();
        } catch (e: any) {
            Alert.alert('Approve Failed', e.message || 'Could not approve bid.');
        } finally {
            setActionState(null);
        }
    };

    const handleRejectBid = (txId: string) => {
        if (!treasuryKey) return;
        Alert.alert(
            'Decline Bid?',
            'Are you sure you want to decline this request? The member will be notified.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Decline',
                    style: 'destructive',
                    onPress: async () => {
                        setActionState({ id: txId, type: 'reject' });
                        try {
                            await treasuryReject(treasuryKey, txId);
                            Alert.alert('Bid Declined', 'The request has been declined.');
                            load();
                        } catch (e: any) {
                            Alert.alert('Decline Failed', e.message || 'Could not decline bid.');
                        } finally {
                            setActionState(null);
                        }
                    }
                }
            ]
        );
    };

    const handleCompleteDeal = (d: any) => {
        if (!treasuryKey) return;
        if (d.price_type && d.price_type !== 'fixed') {
            setHourlyDealHours(d.hours ? String(d.hours) : '1');
            setHourlyDealPrompt(d);
            return;
        }
        Alert.alert(
            'Release Payment?',
            `Are you sure you want to release ${d.credits} 🫘 to ${d.peer_callsign || 'the member'}? This cannot be undone.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Release Payment',
                    onPress: async () => {
                        setActionState({ id: d.id, type: 'complete' });
                        try {
                            await treasuryComplete(treasuryKey, d.id);
                            Alert.alert('Payment Released ✅', 'The beans have been paid to the member.');
                            load();
                        } catch (e: any) {
                            Alert.alert('Release Failed', e.message || 'Could not release payment.');
                        } finally {
                            setActionState(null);
                        }
                    }
                }
            ]
        );
    };

    const formatTime = (t: any) => {
        try {
            const d = new Date(typeof t === 'number' ? t : String(t));
            if (isNaN(d.getTime())) return '';
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        } catch { return ''; }
    };

    const posts: any[] = detail?.posts || [];
    const flow: any[] = detail?.flow || [];
    const pendingBids: any[] = detail?.pendingBids || [];
    const activeDeals: any[] = detail?.activeDeals || [];
    const deferredClaims: any[] = detail?.deferredClaims || [];
    const pendingClaims = deferredClaims.filter((c: any) => c.status === 'pending');
    const pendingClaimsTotal = pendingClaims.reduce((sum: number, c: any) => sum + (Number(c.amount) || 0), 0);

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
                    <MaterialCommunityIcons name="chevron-left" size={30} color={colors.text.heading} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1}>{name}</Text>
            </View>

            {loading ? (
                <View style={styles.centerFill}><ActivityIndicator color={colors.brand.primary} /></View>
            ) : !detail ? (
                <View style={styles.centerFill}>
                    <Text style={styles.emptyNote}>Couldn't load this enterprise. Check your connection.</Text>
                </View>
            ) : (
                <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={64}>
                    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                        {/* Identity */}
                        <View style={styles.identityRow}>
                            {avatar ? (
                                <Image source={{ uri: avatar }} style={styles.avatar} accessibilityLabel="Enterprise avatar" />
                            ) : (
                                <View style={[styles.avatar, styles.avatarPlaceholder]}><Text style={{ fontSize: 28 }}>{detail?.lifecycle === 'bounded' ? '🌱' : '🏛️'}</Text></View>
                            )}
                            <View style={{ marginLeft: 12, flex: 1, minWidth: 0 }}>
                                <Text style={styles.name} numberOfLines={1}>{name}</Text>
                                <Text style={styles.subtitle}>{detail?.lifecycle === 'bounded' ? 'Bounded enterprise · Community project' : 'Community enterprise · Run by the Commons'}</Text>
                            </View>
                        </View>

                        {/* Purpose Statement (docs/the-commons.md §2.1) */}
                        {!!detail?.purpose && (
                            <View style={styles.purposeCard}>
                                <Text style={styles.purposeLabel}>PURPOSE</Text>
                                <Text style={styles.purposeText}>{detail.purpose}</Text>
                            </View>
                        )}

                        {/* Funding Progress (for Bounded Enterprises with a goal) */}
                        {detail?.goalAmount != null && detail.goalAmount > 0 && (() => {
                            const current = detail.currentAmount != null ? detail.currentAmount : Math.max(0, balance);
                            const goal = detail.goalAmount;
                            const progress = Math.min(100, (current / goal) * 100);
                            const isFunded = current >= goal || detail?.status === 'funded' || detail?.status === 'completed';
                            const daysRemaining = getDaysRemaining(detail.deadlineAt);
                            return (
                                <View style={styles.progressCard}>
                                    <View style={styles.progressHeader}>
                                        <View>
                                            <Text style={[styles.currentAmt, isFunded && { color: colors.brand.primary }]}>
                                                {current} 🫘 <Text style={styles.progressLabel}>raised</Text>
                                            </Text>
                                            <Text style={styles.goalAmt}>Goal: {goal} 🫘</Text>
                                        </View>
                                        {daysRemaining && (
                                            <Text style={[styles.deadlineBadge, daysRemaining === 'Expired' && styles.deadlineExpired]}>
                                                ⏳ {daysRemaining}
                                            </Text>
                                        )}
                                    </View>
                                    <View style={styles.progressBarBg}>
                                        <View style={[styles.progressBarFill, { width: `${progress}%`, backgroundColor: isFunded ? colors.brand.primary : colors.accent.primary }]} />
                                    </View>
                                    <Text style={styles.escrowNotice}>
                                        {isFunded 
                                            ? "🎉 This enterprise reached its funding goal! Pledged funds are held securely in the enterprise account."
                                            : "🔒 Pledges are held securely in the enterprise account, spendable only on transparent offers and needs that the whole community can see."}
                                    </Text>

                                    {/* Inline Pledge Beans Input */}
                                    <View style={styles.pledgeBox}>
                                        <View style={styles.pledgeInputRow}>
                                            <TextInput
                                                accessibilityLabel="Pledge amount"
                                                style={styles.pledgeAmountInput}
                                                placeholder="Amount (🫘)"
                                                placeholderTextColor={colors.text.muted}
                                                keyboardType="numeric"
                                                value={pledgeAmount}
                                                onChangeText={setPledgeAmount}
                                            />
                                            <TextInput
                                                accessibilityLabel="Pledge memo"
                                                style={styles.pledgeMemoInput}
                                                placeholder="Memo (optional)"
                                                placeholderTextColor={colors.text.muted}
                                                value={pledgeMemo}
                                                onChangeText={setPledgeMemo}
                                            />
                                        </View>
                                        <Pressable
                                            style={[styles.pledgeButton, (pledging || !pledgeAmount.trim()) && { opacity: 0.6 }]}
                                            disabled={pledging || !pledgeAmount.trim()}
                                            onPress={handlePledge}
                                            accessibilityRole="button"
                                            accessibilityLabel="Pledge Beans"
                                            accessibilityState={{ disabled: pledging || !pledgeAmount.trim(), busy: pledging }}
                                        >
                                            {pledging ? (
                                                <ActivityIndicator color={colors.text.inverse} />
                                            ) : (
                                                <Text style={styles.pledgeButtonText}>PLEDGE BEANS 🌱</Text>
                                            )}
                                        </Pressable>
                                    </View>
                                </View>
                            );
                        })()}

                        {/* Pending Keeper Requests (for Lead / Sole Keeper / Admin) */}
                        {isLeadOrSoleKeeperOrAdmin && keeperRequests.length > 0 && (
                            <View style={styles.requestsCard}>
                                <Text style={styles.requestsTitle}>PENDING KEEPER REQUESTS ({keeperRequests.length})</Text>
                                {keeperRequests.map((req: any) => (
                                    <View key={req.id} style={styles.requestRow}>
                                        <View style={styles.requestInfo}>
                                            <Text style={styles.requestCallsign}>{req.callsign || req.applicantCallsign || req.memberCallsign || 'Member'}</Text>
                                            <Text style={styles.requestBacking}>
                                                Backing pledge: {req.pledgedBacking} 🫘
                                            </Text>
                                        </View>
                                        <View style={styles.requestBtnRow}>
                                            <Pressable
                                                style={[styles.approveBtn, processingRequestId === req.id && { opacity: 0.6 }]}
                                                disabled={processingRequestId === req.id}
                                                onPress={() => handleApproveRequest(req.id)}
                                                accessibilityRole="button"
                                                accessibilityLabel="Approve keeper request"
                                            >
                                                {processingRequestId === req.id ? (
                                                    <ActivityIndicator size="small" color={colors.text.inverse} />
                                                ) : (
                                                    <Text style={styles.approveBtnText}>Approve</Text>
                                                )}
                                            </Pressable>
                                            <Pressable
                                                style={[styles.declineBtn, processingRequestId === req.id && { opacity: 0.6 }]}
                                                disabled={processingRequestId === req.id}
                                                onPress={() => handleDeclineRequest(req.id)}
                                                accessibilityRole="button"
                                                accessibilityLabel="Decline keeper request"
                                            >
                                                <Text style={styles.declineBtnText}>Decline</Text>
                                            </Pressable>
                                        </View>
                                    </View>
                                ))}
                            </View>
                        )}

                        {/* Lead Succession Panel (when lead has no activity for 30+ days) */}
                        {Boolean(leadInactivity?.isEligible ?? leadInactivity?.isEligibleForSuccession) && (
                            <View style={styles.successionCard}>
                                <View style={styles.successionHeader}>
                                    <MaterialCommunityIcons name="alert-circle" size={18} color={colors.feedback.warning.solid} />
                                    <Text style={styles.successionTitle}>
                                        LEAD KEEPER INACTIVE ({Math.floor(leadInactivity.daysInactive)} DAYS)
                                    </Text>
                                </View>
                                <Text style={styles.successionText}>
                                    The lead keeper ({leadInactivity.leadCallsign}) has recorded no node activity for 30+ days. A strict majority of the other keepers can move the lead role to an active keeper. If the lead returns before completion, the proposal is cancelled automatically.
                                </Text>

                                {activeProposal ? (
                                    <View style={styles.successionVoteBox}>
                                        <Text style={styles.successionCandidateText}>
                                            Succession Proposal: Elect {activeProposal.candidateCallsign} as lead keeper
                                        </Text>
                                        <Text style={styles.successionVotesText}>
                                            Votes: {activeProposal.votesCount} of {activeProposal.requiredVotes ?? activeProposal.votesRequired ?? 0} required (strict majority of {activeProposal.totalEligible ?? 'other'} other keepers)
                                        </Text>
                                        {isEligibleSuccessor && (
                                            activeProposal.votes?.some((v: any) => (v.voterPubkey || v.voter_pubkey) === identity?.publicKey) ? (
                                                <Text style={styles.votedBadge}>✓ You voted to approve this succession</Text>
                                            ) : (
                                                <Pressable
                                                    style={[styles.voteBtn, submittingSuccession && { opacity: 0.6 }]}
                                                    disabled={submittingSuccession}
                                                    onPress={() => handleVoteSuccession(activeProposal.id)}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`Vote to elect ${activeProposal.candidateCallsign} as lead keeper`}
                                                >
                                                    {submittingSuccession ? (
                                                        <ActivityIndicator size="small" color={colors.text.inverse} />
                                                    ) : (
                                                        <Text style={styles.voteBtnText}>
                                                            Vote to elect {activeProposal.candidateCallsign} as lead keeper
                                                        </Text>
                                                    )}
                                                </Pressable>
                                            )
                                        )}
                                    </View>
                                ) : isEligibleSuccessor ? (
                                    <Pressable
                                        style={[styles.proposeBtn, submittingSuccession && { opacity: 0.6 }]}
                                        disabled={submittingSuccession}
                                        onPress={() => setShowCandidatePicker(true)}
                                        accessibilityRole="button"
                                        accessibilityLabel="Propose Active Keeper as Lead"
                                    >
                                        <Text style={styles.proposeBtnText}>Propose Active Keeper as Lead</Text>
                                    </Pressable>
                                ) : null}
                            </View>
                        )}

                        {/* Ask to Join as a Keeper (for non-keepers when enterprise is not completed) */}
                        {identity && !isKeeperOfThis && detail?.status !== 'completed' && (
                            myPendingRequest ? (
                                <View style={styles.pendingRequestBanner}>
                                    <Text style={styles.pendingRequestTitle}>⏳ KEEPER REQUEST PENDING</Text>
                                    <Text style={styles.pendingRequestText}>
                                        You asked to join this enterprise with {myPendingRequest.pledgedBacking} 🫘 of backing standing. Awaiting review by the lead keeper.
                                    </Text>
                                </View>
                            ) : (
                                <View style={styles.joinCard}>
                                    <Text style={styles.joinTitle}>🤝 ASK TO JOIN AS A KEEPER</Text>
                                    <Text style={styles.joinDesc}>
                                        Help run this enterprise. You can back it with your earned trading standing to expand its credit floor.
                                    </Text>

                                    <Text style={[styles.sectionLabel, { marginBottom: 6 }]}>
                                        Back this enterprise with your standing: 0 … {availableToBack}
                                    </Text>
                                    <View style={styles.joinInputRow}>
                                        <TextInput
                                            style={styles.joinInput}
                                            value={joinBackingPledge}
                                            onChangeText={(t) => {
                                                const raw = Math.floor(Number(t) || 0);
                                                const clamped = Math.max(0, Math.min(availableToBack, raw));
                                                setJoinBackingPledge(isNaN(raw) ? '0' : String(clamped));
                                            }}
                                            keyboardType="numeric"
                                            accessibilityLabel={`Back this enterprise with your standing: 0 to ${availableToBack}`}
                                        />
                                        <Text style={styles.joinAvailableText}>
                                            / {availableToBack} 🫘 available
                                        </Text>
                                    </View>
                                    <Text style={{ fontSize: 11, color: colors.text.muted, marginBottom: 12 }}>
                                        A pledge of 0 is valid: someone who helps run it without pledging standing can still be a keeper.
                                    </Text>

                                    <Pressable
                                        style={[styles.joinButton, (submittingJoin || Number(joinBackingPledge) > availableToBack) && styles.joinButtonDisabled]}
                                        disabled={submittingJoin || Number(joinBackingPledge) > availableToBack}
                                        onPress={handleJoinRequest}
                                        accessibilityRole="button"
                                        accessibilityLabel="Request to join as keeper"
                                    >
                                        {submittingJoin ? (
                                            <ActivityIndicator size="small" color={colors.text.inverse} />
                                        ) : (
                                            <Text style={styles.joinButtonText}>Request to join as keeper</Text>
                                        )}
                                    </Pressable>
                                </View>
                            )
                        )}

                        {/* Accountable Keepers */}
                        {detail?.keepers && detail.keepers.length > 0 && (
                            <View style={styles.keepersCard}>
                                <Text style={styles.keepersLabel}>ACCOUNTABLE KEEPERS ({detail.keepers.length})</Text>
                                <View style={styles.keepersList}>
                                    {detail.keepers.map((k: any) => {
                                        const isLead = k.role === 'lead';
                                        const pk = k.publicKey || k.pubkey || k.memberPubkey;
                                        // Suspended keepers are shown, not hidden: they still count as keepers of this
                                        // enterprise, but cannot act until the suspension is lifted.
                                        const isSuspended = !!k.suspended;
                                        return (
                                            <View
                                                key={pk}
                                                style={[styles.keeperChip, isSuspended && styles.keeperChipSuspended]}
                                                accessibilityLabel={isSuspended ? `${k.callsign}, ${isLead ? 'lead keeper' : 'keeper'}, suspended` : undefined}
                                            >
                                                <MaterialCommunityIcons name="shield-account" size={14} color={isSuspended ? colors.text.secondary : colors.brand.primary} />
                                                <Text style={styles.keeperCallsign}>{k.callsign}</Text>
                                                {isSuspended && <Text style={styles.keeperBadge}>Suspended</Text>}
                                                <Text style={isLead ? styles.leadKeeperBadge : styles.keeperBadge}>
                                                    {isLead ? 'Lead keeper' : 'Keeper'}
                                                </Text>
                                                {Number(k.backing) > 0 && (
                                                    <Text style={styles.backingText}>+{k.backing} 🫘</Text>
                                                )}
                                            </View>
                                        );
                                    })}
                                </View>
                            </View>
                        )}

                        {/* Balance */}
                        <View style={styles.balanceCard}>
                            <Text style={styles.balanceLabel}>Balance</Text>
                            <Text style={[styles.balanceValue, balance < 0 ? styles.balanceNeg : styles.balancePos]}>{balance} 🫘</Text>
                            <View style={styles.balanceMetaRow}>
                                <View style={styles.metaBox}>
                                    <Text style={styles.metaLabel}>Credit line</Text>
                                    <Text style={styles.metaValue}>{detail.creditLine ?? 0} 🫘</Text>
                                </View>
                                <View style={styles.metaBox}>
                                    <Text style={styles.metaLabel}>Live offers</Text>
                                    <Text style={styles.metaValue}>{detail.liveOffers ?? 0}</Text>
                                </View>
                            </View>
                            <View style={styles.balanceMetaRow}>
                                <View style={styles.metaBox}>
                                    <Text style={styles.metaLabel}>Earned surplus</Text>
                                    <Text style={styles.metaValue}>{detail.earnedSurplus ?? 0} 🫘</Text>
                                </View>
                                <View style={styles.metaBox}>
                                    <Text style={styles.metaLabel}>Capital ceiling</Text>
                                    <Text style={styles.metaValue}>{detail.workingCapitalCeiling != null ? `${detail.workingCapitalCeiling} 🫘` : 'Uncapped'}</Text>
                                </View>
                            </View>
                            {balance < 0 && (
                                <View
                                    accessible={true}
                                    accessibilityRole="alert"
                                    accessibilityLabel={`Warning: Operator eats last. This enterprise is currently in deficit with ${balance} beans. Credit buys inputs and supplies, but keepers can only be paid from profit. Keepers cannot be paid while the enterprise is in deficit.`}
                                    style={{ marginTop: 12, padding: 10, backgroundColor: colors.surface.app, borderRadius: 10, borderWidth: 1, borderColor: colors.feedback.warning.solid }}
                                >
                                    <Text style={{ fontSize: 11, color: colors.feedback.warning.solid, fontWeight: '700', lineHeight: 16 }}>
                                        ⚠️ OPERATOR EATS LAST: This enterprise is currently in deficit ({balance} 🫘). Credit buys inputs and supplies, but keepers can only be paid from profit. Keepers cannot be paid while the enterprise is in deficit.
                                    </Text>
                                </View>
                            )}
                            {pendingClaims.length > 0 && (
                                <View style={{ marginTop: 12, padding: 12, backgroundColor: colors.surface.app, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <Text style={{ fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                                            Pending Wage Claims ({pendingClaims.length})
                                        </Text>
                                        <Text style={{ fontSize: 13, fontWeight: '800', color: colors.feedback.warning.solid }}>
                                            {pendingClaimsTotal} 🫘
                                        </Text>
                                    </View>
                                    <Text style={{ fontSize: 11, color: colors.text.secondary, marginTop: 4, lineHeight: 15 }}>
                                        Deferred until enterprise earns sufficient trading profit. Paid automatically from future sales.
                                    </Text>
                                </View>
                            )}
                        </View>

                        {/* Operator controls */}
                        {isKeeperOfThis && (
                            <View style={styles.opPanel}>
                                <View style={styles.opTitleRow}>
                                    <MaterialCommunityIcons name="shield-account" size={16} color={colors.brand.primary} />
                                    <Text style={styles.opTitle}>OPERATOR CONTROLS</Text>
                                </View>
                                <View style={styles.opBtnRow}>
                                    <Pressable
                                        style={styles.opBtn}
                                        accessibilityRole="button"
                                        onPress={() => router.push({ pathname: '/treasury-post', params: { treasury: params.publicKey, mode: 'offer', name } })}
                                    >
                                        <MaterialCommunityIcons name="tag-plus" size={16} color={colors.text.inverse} />
                                        <Text style={styles.opBtnText}>Post Offer</Text>
                                    </Pressable>
                                    <Pressable
                                        style={styles.opBtn}
                                        accessibilityRole="button"
                                        onPress={() => router.push({ pathname: '/treasury-post', params: { treasury: params.publicKey, mode: 'need', name } })}
                                    >
                                        <MaterialCommunityIcons name="hand-extended" size={16} color={colors.text.inverse} />
                                        <Text style={styles.opBtnText}>Post Need</Text>
                                    </Pressable>
                                </View>
                                <View style={styles.sweepRow}>
                                    <TextInput
                                        style={styles.sweepInput}
                                        placeholder="Sweep surplus…"
                                        placeholderTextColor={colors.text.muted}
                                        keyboardType="numeric"
                                        value={sweepAmount}
                                        onChangeText={setSweepAmount}
                                        accessibilityLabel="Amount to sweep to the Commons"
                                    />
                                    <Pressable
                                        style={[styles.sweepBtn, (sweeping || balance <= 0) && styles.sweepBtnDisabled]}
                                        disabled={sweeping || balance <= 0}
                                        onPress={handleSweep}
                                        accessibilityRole="button"
                                    >
                                        {sweeping ? <ActivityIndicator color={colors.brand.primary} /> : (
                                            <>
                                                <MaterialCommunityIcons name="bank-transfer-out" size={16} color={colors.brand.primary} />
                                                <Text style={styles.sweepBtnText}>To Commons</Text>
                                            </>
                                        )}
                                    </Pressable>
                                </View>

                                {pendingBids.length > 0 && (
                                    <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: colors.brand.primary, paddingTop: 12 }}>
                                        <Text style={[styles.opTitle, { marginBottom: 8 }]}>PENDING BIDS ON NEEDS ({pendingBids.length})</Text>
                                        {pendingBids.map((b) => (
                                            <View key={b.id} style={{ backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border.default }}>
                                                <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text.heading }}>{b.post_title}</Text>
                                                <Text style={{ fontSize: 12, color: colors.text.secondary, marginTop: 2 }}>
                                                    Bid by <Text style={{ fontWeight: '700', color: colors.text.body }}>{b.peer_callsign || 'Member'}</Text> · {b.credits} 🫘
                                                </Text>
                                                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                                                    <Pressable
                                                        style={[styles.opBtn, { minHeight: 44, paddingVertical: 8, justifyContent: 'center' }]}
                                                        disabled={actionState?.id === b.id}
                                                        onPress={() => handleApproveBid(b.id)}
                                                        accessibilityRole="button"
                                                    >
                                                        {actionState?.id === b.id && actionState?.type === 'approve' ? (
                                                            <ActivityIndicator size="small" color={colors.text.inverse} />
                                                        ) : (
                                                            <Text style={styles.opBtnText}>Approve Bid ({b.credits} 🫘)</Text>
                                                        )}
                                                    </Pressable>
                                                    <Pressable
                                                        style={[styles.sweepBtn, { minHeight: 44, height: 44, paddingHorizontal: 16 }]}
                                                        disabled={actionState?.id === b.id}
                                                        onPress={() => handleRejectBid(b.id)}
                                                        accessibilityRole="button"
                                                    >
                                                        {actionState?.id === b.id && actionState?.type === 'reject' ? (
                                                            <ActivityIndicator size="small" color={colors.feedback.warning.solid} />
                                                        ) : (
                                                            <Text style={[styles.sweepBtnText, { color: colors.feedback.warning.solid }]}>Decline</Text>
                                                        )}
                                                    </Pressable>
                                                </View>
                                            </View>
                                        ))}
                                    </View>
                                )}

                                {activeDeals.length > 0 && (
                                    <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: colors.brand.primary, paddingTop: 12 }}>
                                        <Text style={[styles.opTitle, { marginBottom: 8 }]}>ACTIVE DEALS ({activeDeals.length})</Text>
                                        {activeDeals.map((d) => (
                                            <View key={d.id} style={{ backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border.default }}>
                                                <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text.heading }}>{d.post_title}</Text>
                                                <Text style={{ fontSize: 12, color: colors.text.secondary, marginTop: 2 }}>
                                                    {d.action_required === 'fulfill' ? 'Customer' : 'Worker'}: <Text style={{ fontWeight: '700', color: colors.text.body }}>{d.peer_callsign || 'Member'}</Text> · {d.credits} 🫘 in escrow
                                                </Text>
                                                <View style={{ marginTop: 10 }}>
                                                    {d.action_required === 'fulfill' ? (
                                                        <Pressable
                                                            style={[styles.sweepBtn, { minHeight: 44, height: 44 }]}
                                                            onPress={() => router.push({ pathname: '/post/[id]', params: { id: d.post_id, txId: d.id } })}
                                                            accessibilityRole="button"
                                                        >
                                                            <Text style={[styles.sweepBtnText, { color: colors.text.secondary }]}>
                                                                Fulfill Deal · Awaiting Customer Release
                                                            </Text>
                                                        </Pressable>
                                                    ) : (
                                                        <Pressable
                                                            style={[styles.opBtn, { backgroundColor: colors.feedback.success.solid, minHeight: 44, paddingVertical: 8 }]}
                                                            disabled={actionState?.id === d.id}
                                                            onPress={() => handleCompleteDeal(d)}
                                                            accessibilityRole="button"
                                                        >
                                                            {actionState?.id === d.id && actionState?.type === 'complete' ? (
                                                                <ActivityIndicator size="small" color={colors.text.inverse} />
                                                            ) : (
                                                                <Text style={styles.opBtnText}>Release Payment ({d.credits} 🫘)</Text>
                                                            )}
                                                        </Pressable>
                                                    )}
                                                </View>
                                            </View>
                                        ))}
                                    </View>
                                )}

                                <Text style={styles.opHint}>
                                    Post the enterprise's recurring Offer (what it sells) and its Needs (tenders it pays for). Surplus can be swept into the shared Commons pool.
                                </Text>

                                {detail?.lifecycle === 'bounded' && detail?.status !== 'funded' && (
                                    <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: colors.border.default, paddingTop: 12 }}>
                                        <Pressable
                                            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.feedback.danger.solid }}
                                            onPress={handleCancelInitiative}
                                            disabled={cancelling}
                                            accessibilityRole="button"
                                            accessibilityLabel="Cancel initiative and refund escrow"
                                        >
                                            {cancelling ? (
                                                <ActivityIndicator size="small" color={colors.feedback.danger.solid} />
                                            ) : (
                                                <>
                                                    <MaterialCommunityIcons name="cancel" size={16} color={colors.feedback.danger.solid} />
                                                    <Text style={{ fontSize: 13, fontWeight: '700', color: colors.feedback.danger.solid }}>
                                                        Cancel Initiative & Refund Escrow
                                                    </Text>
                                                </>
                                            )}
                                        </Pressable>
                                    </View>
                                )}
                            </View>
                        )}

                        {/* Live listings */}
                        <Text style={styles.sectionLabel}>Listings</Text>
                        {posts.length === 0 ? (
                            <Text style={styles.emptyNote}>No live listings yet.</Text>
                        ) : posts.map((p) => (
                            <Pressable key={p.id} style={styles.listingCard} onPress={() => router.push({ pathname: '/post/[id]', params: { id: p.id } })} accessibilityRole="button">
                                <View style={styles.listingTopRow}>
                                    <View style={[styles.typeBadge, p.type === 'offer' ? styles.typeBadgeOffer : styles.typeBadgeNeed]}>
                                        <Text style={[styles.typeBadgeText, { color: p.type === 'offer' ? colors.brand.primary : colors.text.secondary }]}>{p.type}</Text>
                                    </View>
                                    {!!p.repeatable && (
                                        <View style={styles.recurBadge}>
                                            <MaterialCommunityIcons name="autorenew" size={12} color={colors.text.secondary} />
                                            <Text style={styles.recurText}>Recurring</Text>
                                        </View>
                                    )}
                                    <Text style={styles.listingTitle} numberOfLines={1}>{p.title}</Text>
                                    <Text style={styles.listingPrice}>{p.credits} 🫘</Text>
                                </View>
                                {!!p.description && <Text style={styles.listingDesc} numberOfLines={2}>{p.description}</Text>}
                            </Pressable>
                        ))}

                        {/* Recent activity */}
                        <Text style={styles.sectionLabel}>Recent activity</Text>
                        {flow.length === 0 ? (
                            <Text style={styles.emptyNote}>No transactions yet.</Text>
                        ) : flow.map((f, i) => (
                            <View key={i} style={[styles.flowRow, i === flow.length - 1 && { borderBottomWidth: 0 }]}>
                                <View style={[styles.flowIcon, { backgroundColor: f.incoming ? colors.brand.tint : colors.surface.subtle }]}>
                                    <MaterialCommunityIcons name={f.incoming ? 'arrow-down' : 'arrow-up'} size={16} color={f.incoming ? colors.brand.primary : colors.text.secondary} />
                                </View>
                                <View style={{ flex: 1, minWidth: 0 }}>
                                    <Text style={styles.flowMemo} numberOfLines={1}>{f.memo || (f.incoming ? 'Received' : 'Sent')}</Text>
                                    <Text style={styles.flowTime}>{formatTime(f.timestamp)}</Text>
                                </View>
                                <Text style={[styles.flowAmount, { color: f.incoming ? colors.brand.primary : colors.feedback.warning.solid }]}>
                                    {f.incoming ? '+' : '−'}{Math.abs(f.amount)} 🫘
                                </Text>
                            </View>
                        ))}

                        {/* Enterprise Discussion Thread (Slice 6) */}
                        <View style={styles.threadCard}>
                            <View style={styles.threadHeader}>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.threadTitle}>Discussion</Text>
                                    <Text style={styles.threadSubtitle}>Public coordination for this enterprise</Text>
                                </View>
                                <MaterialCommunityIcons name="forum-outline" size={22} color={colors.brand.primary} />
                            </View>

                            {threadReadOnly && (
                                <View style={styles.threadReadOnlyBanner}>
                                    <Text style={styles.threadReadOnlyText}>
                                        Enterprise has wound up — discussion thread is read-only.
                                    </Text>
                                </View>
                            )}

                            {threadMessages.length === 0 ? (
                                <Text style={styles.emptyNote}>No messages yet. Start the conversation!</Text>
                            ) : (
                                threadMessages.map((m: any, idx: number) => {
                                    const isRemoved = m.type === 'removed';
                                    const authorName = m.authorCallsign || (m.authorPubkey ? m.authorPubkey.slice(0, 8) : 'Member');
                                    const authorAvatar = m.authorAvatar;
                                    const textContent = decodeThreadMessage(m.ciphertext, m.type);
                                    return (
                                        <View key={m.id} style={[styles.threadMsgRow, idx === threadMessages.length - 1 && { borderBottomWidth: 0 }]}>
                                            <MemberAvatar
                                                avatarUrl={authorAvatar}
                                                pubkey={m.authorPubkey}
                                                callsign={authorName}
                                                size={32}
                                            />
                                            <View style={styles.threadMsgContent}>
                                                <View style={styles.threadMsgMeta}>
                                                    <Text style={styles.threadMsgAuthor} numberOfLines={1}>{authorName}</Text>
                                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                                        <Text style={styles.threadMsgTime}>{formatTime(m.timestamp)}</Text>
                                                        {isKeeperOfThis && !isRemoved && (
                                                            <Pressable
                                                                style={styles.threadRemoveBtn}
                                                                hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                                                                onPress={() => handleRemoveThreadMessage(m.id)}
                                                                disabled={threadRemovingId === m.id}
                                                                accessibilityRole="button"
                                                                accessibilityLabel={`Remove message from ${authorName}`}
                                                                accessibilityState={{ disabled: threadRemovingId === m.id, busy: threadRemovingId === m.id }}
                                                            >
                                                                {threadRemovingId === m.id ? (
                                                                    <ActivityIndicator size="small" color={colors.feedback.danger.solid} />
                                                                ) : (
                                                                    <MaterialCommunityIcons name="trash-can-outline" size={14} color={colors.feedback.danger.solid} />
                                                                )}
                                                            </Pressable>
                                                        )}
                                                    </View>
                                                </View>
                                                <Text style={isRemoved ? styles.threadMsgRemoved : styles.threadMsgText}>
                                                    {textContent}
                                                </Text>
                                            </View>
                                        </View>
                                    );
                                })
                            )}

                            {!threadReadOnly && (
                                <View style={styles.threadInputRow}>
                                    <TextInput
                                        style={[styles.threadInput, threadPosting && { opacity: 0.6 }]}
                                        placeholder="Message the enterprise..."
                                        placeholderTextColor={colors.text.muted}
                                        value={threadInput}
                                        onChangeText={setThreadInput}
                                        maxLength={2000}
                                        returnKeyType="send"
                                        onSubmitEditing={handlePostThreadMessage}
                                        editable={!threadPosting}
                                        accessibilityLabel="Message the enterprise"
                                    />
                                    <Pressable
                                        style={[
                                            styles.threadSendBtn,
                                            (!threadInput.trim() || threadPosting) && { opacity: 0.5 }
                                        ]}
                                        disabled={!threadInput.trim() || threadPosting}
                                        onPress={handlePostThreadMessage}
                                        accessibilityRole="button"
                                        accessibilityLabel="Send message"
                                    >
                                        {threadPosting ? (
                                            <ActivityIndicator size="small" color={colors.text.inverse} />
                                        ) : (
                                            <Text style={styles.threadSendBtnText}>Send</Text>
                                        )}
                                    </Pressable>
                                </View>
                            )}
                        </View>

                        {/* Report Enterprise Action */}
                        <View style={{ marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border.default, marginBottom: 20 }}>
                            <Pressable style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} onPress={() => setShowReportForm(!showReportForm)} accessibilityRole="button" accessibilityLabel="Report Enterprise">
                                <MaterialCommunityIcons name="shield-alert-outline" size={18} color={colors.feedback.danger.solid} />
                                <Text style={{ color: colors.feedback.danger.solid, fontSize: 14, fontWeight: '600' }}>Report Enterprise</Text>
                            </Pressable>
                            {showReportForm && (
                                <View style={{ marginTop: 12, backgroundColor: colors.feedback.danger.bg, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.feedback.danger.border }}>
                                    <Text style={{ fontSize: 11, fontWeight: '700', color: colors.feedback.danger.solid, marginBottom: 8, letterSpacing: 0.5 }}>REPORT REASON</Text>
                                    <TextInput
                                        accessibilityLabel="Report reason"
                                        style={{ backgroundColor: colors.surface.card, height: 40, borderRadius: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.border.default, marginBottom: 10, color: colors.text.body }}
                                        placeholder="Why are you reporting this enterprise?"
                                        placeholderTextColor={colors.text.muted}
                                        value={reportReason}
                                        onChangeText={setReportReason}
                                    />
                                    <Pressable
                                        accessibilityRole="button"
                                        style={{ backgroundColor: reportReason ? colors.feedback.danger.solid : colors.surface.subtle, height: 40, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }}
                                        disabled={!reportReason || reporting}
                                        onPress={async () => {
                                            if (!identity?.publicKey || !treasuryKey) return;
                                            setReporting(true);
                                            try {
                                                await reportAbuse(identity.publicKey, treasuryKey, reportReason, treasuryKey);
                                                setShowReportForm(false);
                                                setReportReason('');
                                                Alert.alert('Reported', 'This enterprise has been flagged for review.');
                                            } catch (e: any) {
                                                Alert.alert('Error', e.message || 'Could not submit report.');
                                            } finally {
                                                setReporting(false);
                                            }
                                        }}
                                    >
                                        <Text style={{ color: colors.text.inverse, fontWeight: 'bold' }}>{reporting ? 'Reporting...' : 'Submit Report'}</Text>
                                    </Pressable>
                                </View>
                            )}
                        </View>
                    </ScrollView>
                </KeyboardAvoidingView>
            )}

            {hourlyDealPrompt && (
                <Modal visible transparent animationType="fade" onRequestClose={() => setHourlyDealPrompt(null)}>
                    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
                        <View style={{ backgroundColor: colors.surface.card, borderRadius: 16, padding: 20, width: '100%', maxWidth: 400, borderWidth: 1, borderColor: colors.border.default }}>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text.heading, marginBottom: 6 }}>
                                Confirm Hours Worked
                            </Text>
                            <Text style={{ fontSize: 13, color: colors.text.secondary, marginBottom: 14 }}>
                                Enter actual hours worked for "{hourlyDealPrompt.post_title}":
                            </Text>
                            <TextInput
                                style={{ height: 44, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, color: colors.text.body, marginBottom: 16 }}
                                value={hourlyDealHours}
                                onChangeText={setHourlyDealHours}
                                keyboardType="numeric"
                                placeholder="e.g. 2.5"
                                placeholderTextColor={colors.text.muted}
                                autoFocus
                            />
                            <View style={{ flexDirection: 'row', gap: 10 }}>
                                <Pressable
                                    style={{ flex: 1, height: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border.default }}
                                    onPress={() => setHourlyDealPrompt(null)}
                                    accessibilityRole="button"
                                >
                                    <Text style={{ color: colors.text.body, fontWeight: '700' }}>Cancel</Text>
                                </Pressable>
                                <Pressable
                                    style={{ flex: 1, height: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 10, backgroundColor: colors.feedback.success.solid }}
                                    accessibilityRole="button"
                                    onPress={async () => {
                                        const parsed = Number(hourlyDealHours);
                                        if (isNaN(parsed) || parsed <= 0) {
                                            Alert.alert('Invalid Hours', 'Please enter a valid positive number of hours.');
                                            return;
                                        }
                                        const deal = hourlyDealPrompt;
                                        setHourlyDealPrompt(null);
                                        if (!treasuryKey) return;
                                        setActionState({ id: deal.id, type: 'complete' });
                                        try {
                                            await treasuryComplete(treasuryKey, deal.id, parsed);
                                            Alert.alert('Payment Released ✅', 'The beans have been paid to the member.');
                                            load();
                                        } catch (e: any) {
                                            Alert.alert('Release Failed', e.message || 'Could not release payment.');
                                        } finally {
                                            setActionState(null);
                                        }
                                    }}
                                >
                                    <Text style={{ color: colors.text.inverse, fontWeight: '800' }}>Release Payment</Text>
                                </Pressable>
                            </View>
                        </View>
                    </View>
                </Modal>
            )}

            {showCandidatePicker && (
                <Modal visible transparent animationType="fade" onRequestClose={() => setShowCandidatePicker(false)}>
                    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
                        <View style={{ backgroundColor: colors.surface.card, borderRadius: 16, padding: 20, width: '100%', maxWidth: 400, borderWidth: 1, borderColor: colors.border.default }}>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text.heading, marginBottom: 6 }}>
                                Propose Lead Keeper
                            </Text>
                            <Text style={{ fontSize: 13, color: colors.text.secondary, marginBottom: 14 }}>
                                Select an active keeper to move the lead role to:
                            </Text>
                            <ScrollView style={{ maxHeight: 240, marginBottom: 16 }}>
                                {(detail?.keepers || [])
                                    .filter((k: any) => !k.suspended && (k.publicKey || k.pubkey || k.memberPubkey) !== leadInactivity?.leadPubkey)
                                    .map((k: any) => {
                                        const pk = k.publicKey || k.pubkey || k.memberPubkey;
                                        return (
                                            <Pressable
                                                key={pk}
                                                style={styles.candidateOption}
                                                onPress={() => handleProposeSuccession(pk)}
                                                accessibilityRole="button"
                                                accessibilityLabel={`Propose ${k.callsign} as lead keeper`}
                                            >
                                                <Text style={styles.candidateOptionText}>
                                                    {k.callsign} {pk === identity?.publicKey ? '(yourself)' : ''}
                                                </Text>
                                                <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.secondary} />
                                            </Pressable>
                                        );
                                    })}
                            </ScrollView>
                            <Pressable
                                style={{ height: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border.default }}
                                onPress={() => setShowCandidatePicker(false)}
                                accessibilityRole="button"
                            >
                                <Text style={{ color: colors.text.body, fontWeight: '700' }}>Cancel</Text>
                            </Pressable>
                        </View>
                    </View>
                </Modal>
            )}
        </SafeAreaView>
    );
}
