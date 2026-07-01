import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, SafeAreaView, TextInput, Image,
    DeviceEventEmitter, Alert, ScrollView, Keyboard, Platform } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useFocusEffect, router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useIdentity } from '../IdentityContext';
import { getBalance, getTransactions, getMemberProfile, getAllCommunityMembers, sendTransfer, getPledgeHistory, getEscrowTotal } from '../../utils/db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hapticSuccess, hapticWarning } from '../../utils/haptics';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { MemberAvatar } from '../../components/MemberAvatar';
import { BalanceInfoModal } from '../../components/info-content/BalanceInfoModal';
import { CirculationInfoModal } from '../../components/info-content/CirculationInfoModal';
import { CommonsInfoModal } from '../../components/CommonsInfoModal';
import { TrustInfoModal } from '../../components/info-content/TrustInfoModal';
import { SliderInfoModal } from '../../components/info-content/SliderInfoModal';
import { useTheme, useStyles } from '../ThemeContext';
import { palette } from '../../constants/colors';

// ── Tier constants (mirrors beanpool-core/protocol.ts) ──
// floor: the credit limit at that tier (negative = how far into debt you can go)
// dailyLimit: velocity gate bean limit (null = unrestricted)
const BASE_FLOOR = -80; // Everyone starts here
const CIRC_TICKS = [200, 500, 1000]; // Circulation rate change points
const W_TRADES = 8, W_PARTNERS = 40, W_DAYS = 2;

function getTierIndex(ec: number) {
    if (ec >= 1320) return 3;
    if (ec >= 520)  return 2;
    if (ec >= 120)  return 1;
    return 0;
}

export default function LedgerScreen() {
    const { theme, colors } = useTheme();
    const { identity } = useIdentity();
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    const TIERS = useMemo(() => [
        { name: 'Newcomer', emoji: '🌱', color: colors.trust.newcomer.fg, bg: colors.trust.newcomer.bg, border: colors.trust.newcomer.border, min: 0,    floor: -80,   dailyLimit: 20, perks: ['Marketplace access', 'Receive credits', 'Invite members', 'Overdraft unlocks after 1st trade'] },
        { name: 'Resident', emoji: '🏠', color: colors.trust.resident.fg, bg: colors.trust.resident.bg, border: colors.trust.resident.border, min: 120,  floor: -200,  dailyLimit: null, perks: ['Send credits', 'Invite members', 'Full marketplace'] },
        { name: 'Steward',  emoji: '🏛️', color: colors.trust.steward.fg, bg: colors.trust.steward.bg, border: colors.trust.steward.border, min: 520,  floor: -600,  dailyLimit: null, perks: ['All Resident perks', 'Trusted trader status'] },
        { name: 'Elder',    emoji: '⛰️', color: colors.trust.elder.fg, bg: colors.trust.elder.bg, border: colors.trust.elder.border, min: 1320, floor: -1400, dailyLimit: null, perks: ['All perks', 'Community governance voice'] },
    ], [colors]);

    React.useEffect(() => {
        const showSub = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardHeight(e.endCoordinates.height));
        const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
        return () => { showSub.remove(); hideSub.remove(); };
    }, []);
    const [txns, setTxns] = useState<any[]>([]);
    const [balanceState, setBalanceState] = useState<any>({
        balance: 0, floor: -100,
        tier: { name: 'Ghost', emoji: '👻', canGift: false, canInvite: false },
        earnedCredit: 0, commons: 0, trustStats: null,
    });
    const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'trust' | 'financials'>('trust');
    const [escrowTotal, setEscrowTotal] = useState(0);
    const [pledgeHistory, setPledgeHistory] = useState<any[]>([]);
    const [exporting, setExporting] = useState(false);

    const [showBalanceInfo, setShowBalanceInfo] = useState(false);
    const [showCommonsInfo, setShowCommonsInfo] = useState(false);
    const [showCirculationInfo, setShowCirculationInfo] = useState(false);
    const [showTrustInfo, setShowTrustInfo] = useState(false);
    const [trustInfoTab, setTrustInfoTab] = useState<'levels' | 'perks'>('levels');
    const [showSliderInfo, setShowSliderInfo] = useState(false);

    const [showSend, setShowSend] = useState(false);
    const [members, setMembers] = useState<{ publicKey: string; callsign: string }[]>([]);
    const [sendTo, setSendTo] = useState('');
    const [sendAmount, setSendAmount] = useState('');
    const [sendMemo, setSendMemo] = useState('');
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);
    const [sendSuccess, setSendSuccess] = useState(false);
    const [memberSearch, setMemberSearch] = useState('');
    const [showMemberPicker, setShowMemberPicker] = useState(false);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.surface.app },

        // Top bar
        topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: colors.surface.card, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        profileChunk: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
        avatarRing: { width: 56, height: 56, borderRadius: 28, borderWidth: 2.5, borderColor: colors.brand.primary, overflow: 'hidden', shadowColor: colors.brand.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
        profileName: { fontSize: 17, fontWeight: '800', color: colors.text.heading, marginBottom: 3 },
        tierChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1, alignSelf: 'flex-start' },
        tierChipEmoji: { fontSize: 12, marginRight: 4 },
        tierChipText: { fontSize: 11, fontWeight: '700' },

        // Big balance — the whole point of this page
        balanceChunk: { alignItems: 'flex-end', paddingLeft: 8 },
        bigBalance: { fontSize: 34, fontWeight: '900', letterSpacing: -1 },
        balanceWord: { fontSize: 10, fontWeight: '800', color: colors.text.muted, letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 0 },

        pos: { color: colors.brand.primary },
        neg: { color: colors.feedback.danger.solid },

        // Tab bar
        tabBar: { flexDirection: 'row', backgroundColor: colors.surface.card, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 13, borderBottomWidth: 2.5, borderBottomColor: 'transparent' },
        tabActive: { borderBottomColor: colors.accent.primary },
        tabText: { fontSize: 13, fontWeight: '600', color: colors.text.muted },

        // ── Trust Tab ──
        tierHero: { borderRadius: 20, padding: 20, borderWidth: 1, marginBottom: 16 },
        tierHeroLabel: { fontSize: 10, fontWeight: '800', color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: 1 },
        tierHeroName: { fontSize: 30, fontWeight: '900', letterSpacing: -0.5 },
        levelBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, borderWidth: 1 },
        levelBadgeText: { fontSize: 13, fontWeight: '800' },
        progressBg: { height: 10, backgroundColor: colors.border.default, borderRadius: 5, overflow: 'hidden' },
        progressFill: { height: '100%', borderRadius: 5 },
        progressLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '600' },
        // Journey-to-Elder bar
        journeyTrack: { height: 10, backgroundColor: colors.border.default, borderRadius: 5, position: 'relative', marginTop: 6 },
        journeyFill: { position: 'absolute', left: 0, top: 0, height: 10, borderRadius: 5 },
        journeyTick: { position: 'absolute', top: -2, alignItems: 'center', width: 16, marginLeft: -8 },
        journeyTickMark: { width: 2, height: 14, backgroundColor: colors.border.strong, borderRadius: 1 },
        journeyTickEmoji: { fontSize: 12, marginTop: 2 },
        perksRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
        perkPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1 },
        perkText: { fontSize: 12, fontWeight: '700' },

        pathCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
        pathTitle: { fontSize: 13, fontWeight: '700', color: colors.text.heading, marginBottom: 14 },
        pathRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-evenly' },
        pathOption: { alignItems: 'center', flex: 1, minWidth: 0 },
        pathNumber: { fontSize: 32, fontWeight: '900', lineHeight: 36 },
        pathLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '600', marginTop: 2, textAlign: 'center' },
        pathOr: { fontSize: 11, color: colors.border.strong, fontWeight: '600' },
        pathGap: { fontSize: 18, fontWeight: '900', color: colors.text.heading, marginTop: -6, marginBottom: 6 },
        pathHint: { fontSize: 12, color: colors.text.secondary, lineHeight: 18, marginBottom: 14 },
        pathLeverTag: { fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 },

        sectionLabel: { fontSize: 11, fontWeight: '800', color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },

        achieveRow: { flexDirection: 'row', gap: 10, marginBottom: 24 },
        achieveCard: { flex: 1, backgroundColor: colors.surface.card, borderRadius: 14, padding: 12, borderWidth: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
        achieveCount: { fontSize: 24, fontWeight: '900', marginBottom: 1 },
        achieveLabel: { fontSize: 9, fontWeight: '800', color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5 },
        achieveText: { fontSize: 12, fontWeight: '700' },
        achieveContrib: { fontSize: 10, color: colors.text.muted, fontWeight: '600', marginBottom: 8 },
        achieveBarBg: { height: 5, borderRadius: 3, overflow: 'hidden', marginBottom: 4 },
        achieveBarFill: { height: '100%', borderRadius: 3 },
        achieveFooter: { fontSize: 9, color: colors.text.muted, fontWeight: '600' },

        ladder: { backgroundColor: colors.surface.card, borderRadius: 16, overflow: 'hidden', marginBottom: 12, borderWidth: 1, borderColor: colors.border.default },
        ladderRow: { padding: 14, paddingLeft: 12, gap: 0, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle, borderColor: 'transparent' },
        ladderDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, marginRight: 6 },
        ladderName: { fontSize: 14, fontWeight: '800' },
        ladderReq: { fontSize: 11, color: colors.text.muted, fontWeight: '500', marginBottom: 4 },
        ladderDetail: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
        ladderDetailText: { fontSize: 11, color: colors.text.secondary, fontWeight: '500', flex: 1 },
        ladderBadge: { fontSize: 10, fontWeight: '700', borderWidth: 1, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
        formula: { fontSize: 11, color: colors.text.muted, fontStyle: 'italic', textAlign: 'center', paddingBottom: 4 },

        // ── Activity Tab ──
        activityContent: { padding: 16, paddingBottom: 100 },
        balanceRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
        balanceCard: { flex: 1, backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: colors.border.default },
        balCardLabel: { fontSize: 12, fontWeight: '600', color: colors.text.secondary, marginBottom: 6 },
        balCardAmount: { fontSize: 22, fontWeight: '800' },
        commonsAmt: { fontSize: 22, fontWeight: '800', color: theme === 'dark' ? palette.amber400 : palette.amber600, flexShrink: 1 },
        balCardSub: { fontSize: 11, color: colors.text.muted, marginTop: 4 },
        // Escrow / forecast / pledge
        infoCard: { backgroundColor: colors.feedback.warning.bg, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: colors.feedback.warning.border },
        infoCardRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
        infoCardLabel: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.feedback.warning.fg },
        infoCardValue: { fontSize: 15, fontWeight: '800', color: colors.feedback.warning.solid } as any,
        infoCardSub: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
        forecastCard: { backgroundColor: colors.accent.tint, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: colors.border.default, gap: 6 },
        forecastDate: { fontSize: 13, fontWeight: '700', color: colors.accent.primary },
        forecastSub: { flex: 1, fontSize: 12, color: colors.text.secondary },
        forecastAmt: { fontSize: 15, fontWeight: '800', color: colors.accent.primary } as any,
        pledgeSection: { marginBottom: 12 },
        pledgeRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.card, borderRadius: 10, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: colors.border.default },
        pledgeName: { fontSize: 13, fontWeight: '700', color: colors.text.heading },
        pledgeDate: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
        pledgeAmt: { fontSize: 13, fontWeight: '700', color: colors.feedback.danger.solid },
        txnHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, marginBottom: 4 },
        exportBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.surface.subtle, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.border.default },
        exportBtnText: { fontSize: 11, color: colors.text.secondary, fontWeight: '700' },
        circBox: { backgroundColor: colors.feedback.success.bg, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: colors.feedback.success.border },
        circBoxAmber: { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border },
        circLabel: { fontSize: 13, fontWeight: '700', color: colors.feedback.success.fg } as any,
        circRate: { fontSize: 13, fontWeight: '700', color: colors.feedback.success.fg, fontFamily: 'Courier' } as any,
        sendBtn: { paddingVertical: 16, borderRadius: 14, backgroundColor: colors.action.fab, alignItems: 'center', marginBottom: 12 },
        sendBtnOpen: { backgroundColor: colors.border.strong },
        sendBtnLocked: { backgroundColor: colors.border.default, opacity: 0.7 },
        sendBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: '800' },
        sendForm: { backgroundColor: colors.surface.app, borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: colors.border.default },
        recipientRow: { backgroundColor: colors.surface.card, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
        recipientText: { fontSize: 15, fontWeight: '600', color: colors.text.heading },
        pickerBox: { backgroundColor: colors.surface.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 10, overflow: 'hidden' },
        pickerSearch: { padding: 12, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle, fontSize: 14, color: colors.text.heading },
        pickerRow: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.surface.app },
        pickerRowActive: { backgroundColor: colors.brand.primary },
        pickerName: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        pickerPk: { fontSize: 11, color: colors.text.muted, fontFamily: 'Courier', marginTop: 2 },
        sendInput: { backgroundColor: colors.surface.card, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 10, fontSize: 15, color: colors.text.heading },
        taxBreakdown: { backgroundColor: colors.surface.app, borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: colors.border.default },
        breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
        breakdownLabel: { fontSize: 13, color: colors.text.secondary, fontWeight: '500' },
        breakdownValue: { fontSize: 13, color: colors.text.heading, fontWeight: '700' },
        errBox: { backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border, borderRadius: 10, padding: 10, marginBottom: 10 },
        errText: { color: colors.feedback.danger.fg, fontSize: 13, fontWeight: '700', textAlign: 'center' },
        okBox: { backgroundColor: colors.feedback.success.bg, borderWidth: 1, borderColor: colors.feedback.success.border, borderRadius: 10, padding: 10, marginBottom: 10 },
        okText: { color: colors.feedback.success.fg, fontSize: 13, fontWeight: '700', textAlign: 'center' },
        confirmBtn: { backgroundColor: colors.brand.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
        confirmBtnOff: { backgroundColor: colors.border.default },
        confirmBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: '700' },
        txnRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border.default },
        txnIcon: { width: 38, height: 38, borderRadius: 19, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
        txnIconCredit: { backgroundColor: colors.feedback.success.bg },
        txnIconDebit: { backgroundColor: colors.feedback.danger.bg },
        txnPeer: { fontSize: 14, fontWeight: '700', color: colors.text.heading, marginBottom: 2 },
        txnMemo: { fontSize: 12, color: colors.text.secondary, marginBottom: 2 },
        txnTime: { fontSize: 11, color: colors.text.muted },
        txnAmount: { fontSize: 16, fontWeight: '800' },

        // Velocity gate meter
        velocityCard: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.indigo50, borderRadius: 16, padding: 18, marginBottom: 12, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.indigo200 },
        velocityTitle: { fontSize: 14, fontWeight: '800', color: theme === 'dark' ? colors.text.heading : palette.indigo800, marginLeft: 8 },
        velocityLabel: { fontSize: 10, fontWeight: '800', color: theme === 'dark' ? colors.text.secondary : palette.indigo600, letterSpacing: 1, textTransform: 'uppercase' as const, marginBottom: 6 },
        velocityBarBg: { height: 8, backgroundColor: theme === 'dark' ? colors.border.strong : palette.indigo100, borderRadius: 4, overflow: 'hidden' as const },
        velocityBarFill: { height: '100%' as const, borderRadius: 4 },
        velocityUsed: { fontSize: 12, fontWeight: '700', color: colors.text.body },
        velocityLimit: { fontSize: 12, fontWeight: '700', color: colors.text.secondary },
        velocityRemaining: { fontSize: 12, fontWeight: '600', color: colors.text.body, marginTop: 6 },
        velocityWarning: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, marginTop: 8, backgroundColor: colors.feedback.danger.bg, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
        velocityWarningText: { fontSize: 12, fontWeight: '700', color: colors.feedback.danger.fg, flex: 1 },
        velocityUnlock: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, marginTop: 10, backgroundColor: colors.feedback.success.bg, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
        velocityUnlockText: { fontSize: 12, fontWeight: '700', color: colors.feedback.success.fg },
        velocityExplainer: { fontSize: 11, color: colors.text.muted, marginTop: 10, lineHeight: 16 },

        // ── Credit Spectrum Bar (ruler/mercury design) ──
        creditBarOuter: { backgroundColor: colors.surface.card, borderBottomWidth: 1, borderBottomColor: colors.border.default, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
        rulerWrap: { height: 88, position: 'relative', marginBottom: 4 },
        // Bar segments: borderRadius set per-segment in JSX for clean straight joins
        rulerSeg: { position: 'absolute', height: 12, top: 24 },
        // Zero line: starts at bar bottom (36) and drops below only
        rulerZeroLine: { position: 'absolute', width: 2, height: 16, top: 36, backgroundColor: colors.text.body, marginLeft: -1 },
        rulerZeroLabel: { position: 'absolute', top: 54, fontSize: 9, fontWeight: '700', color: colors.text.body, textAlign: 'center', width: 16, marginLeft: -8 },
        // Tick wrapper: starts at bar bottom (36)
        rulerTickWrap: { position: 'absolute', alignItems: 'center', top: 36, marginLeft: -16, width: 32 },
        rulerTickMark: { width: 1, height: 6 },
        rulerTickVal: { fontSize: 8, fontWeight: '600', color: colors.text.secondary, marginTop: 2, textAlign: 'center', width: 32 },
        rulerTickSym: { fontSize: 11, marginTop: 1, textAlign: 'center' },
        rulerSymRing: { marginTop: 1, borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 3, paddingVertical: 0, alignItems: 'center', justifyContent: 'center' },
        rulerYouTag: { fontSize: 7, fontWeight: '900', letterSpacing: 0.5, marginTop: 1 },
        rulerTickRate: { fontSize: 9, fontWeight: '600', color: colors.text.muted, marginTop: 1, textAlign: 'center' },
        rulerZoneRate: { position: 'absolute', top: 54, fontSize: 9, fontWeight: '700', color: colors.text.secondary, textAlign: 'center', width: 40, marginLeft: -20 },
        // Equilibrium note centred below the zero mark
        rulerEquilibriumWrap: { alignItems: 'center', marginTop: 2, marginBottom: 4 },
        rulerEquilibriumText: { fontSize: 12, color: colors.text.body, fontStyle: 'italic', textAlign: 'center', lineHeight: 17 },
        // Bead: 64px centered wrap, label above, circle below — fixed width prevents horizontal drifting
        rulerBeadWrap: { position: 'absolute', alignItems: 'center', width: 64, top: 3, marginLeft: -32 },
        rulerBeadLabel: { fontSize: 12, fontWeight: '800', marginBottom: 3, textAlign: 'center' },
        rulerBead: { width: 16, height: 16, borderRadius: 8, borderWidth: 2.5, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 3, elevation: 3 },
        velocityPill: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 5, marginTop: 6, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.indigo50, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, alignSelf: 'flex-start' as const, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.indigo200 },
        velocityPillText: { fontSize: 11, fontWeight: '600', color: theme === 'dark' ? colors.text.heading : palette.indigo600 },
        velocityPillDot: { fontSize: 11, color: colors.text.muted },
    }));

    const loadData = () => {
        if (identity?.publicKey) {
            getBalance(identity.publicKey).then(setBalanceState).catch(console.error);
            getTransactions(identity.publicKey).then(setTxns).catch(console.error);
            getMemberProfile(identity.publicKey).then(p => setAvatarUrl(p?.avatar_url || null)).catch(console.error);
            getEscrowTotal(identity.publicKey).then(setEscrowTotal).catch(() => {});
            getPledgeHistory(identity.publicKey).then(setPledgeHistory).catch(() => {});
        }
    };

    const handleExport = async () => {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl || !identity?.publicKey) return;
        setExporting(true);
        try {
            const res = await fetch(`${anchorUrl}/api/ledger/export`);
            if (!res.ok) throw new Error('Export failed');
            const { transactionsCsv } = await res.json();
            const path = `${FileSystem.cacheDirectory}beanpool-ledger.csv`;
            await FileSystem.writeAsStringAsync(path, transactionsCsv, { encoding: FileSystem.EncodingType.UTF8 });
            await Sharing.shareAsync(path, { mimeType: 'text/csv', dialogTitle: 'Export Ledger' });
        } catch (e: any) {
            Alert.alert('Export Failed', e.message || 'Could not export ledger.');
        } finally {
            setExporting(false);
        }
    };
    const loadMembers = () => {
        getAllCommunityMembers().then(m => setMembers(m.filter(mm => mm.publicKey !== identity?.publicKey))).catch(console.error);
    };

    useFocusEffect(
        React.useCallback(() => {
            loadData(); loadMembers();
            const s1 = DeviceEventEmitter.addListener('transaction_completed', loadData);
            const s2 = DeviceEventEmitter.addListener('sync_data_updated', loadData);
            return () => { s1.remove(); s2.remove(); };
        }, [identity])
    );

    const handleSend = async () => {
        if (!sendTo || !sendAmount || !identity?.publicKey) return;
        const amount = parseFloat(sendAmount);
        if (isNaN(amount) || amount <= 0) { setSendError('Enter a valid amount'); return; }
        setSending(true); setSendError(null); setSendSuccess(false);
        try {
            await sendTransfer(identity.publicKey, sendTo, amount, sendMemo || '');
            hapticSuccess();
            setSendSuccess(true);
            setSendTo(''); setSendAmount(''); setSendMemo(''); setMemberSearch('');
            loadData();
            setTimeout(() => { setSendSuccess(false); setShowSend(false); }, 1500);
        } catch (e: any) {
            hapticWarning();
            setSendError(e.message || 'Transfer failed');
        } finally { setSending(false); }
    };

    // Trust calculations
    const ec = balanceState.earnedCredit || 0;
    const ts = balanceState.trustStats;
    const tradeCount    = ts?.tradeCount     || 0;
    const uniquePartners = ts?.uniquePartners || 0;
    const ageDays       = ts?.ageDays        || 0;
    const tierIdx = getTierIndex(ec);
    const tier = TIERS[tierIdx];
    const nextTier = TIERS[tierIdx + 1] || null;
    const ELDER_MIN = TIERS[TIERS.length - 1].min;
    const journeyPct = ELDER_MIN > 0 ? Math.min(1, ec / ELDER_MIN) : 1; // cumulative progress toward Elder
    const creditsToNext = nextTier ? Math.max(0, nextTier.min - ec) : 0;
    const tradesToLevel   = nextTier ? Math.ceil(creditsToNext / W_TRADES)   : 0;
    const partnersToLevel = nextTier ? Math.ceil(creditsToNext / W_PARTNERS) : 0;
    const daysToLevel     = nextTier ? Math.ceil(creditsToNext / W_DAYS)     : 0;

    const selectedMember = members.find(m => m.publicKey === sendTo);
    const filteredMembers = members.filter(m => m.callsign.toLowerCase().includes(memberSearch.toLowerCase()));

    // ─── Credit Spectrum Bar ──────────────────────────────────────────────────
    const renderCreditBar = () => {
        const balance = balanceState.balance;

        // Fixed visual anchor positions — evenly spaced for readability, NOT linear.
        // 9 anchors: 4 tier floors + zero + 4 circ bracket boundaries (incl. 2000)
        const ANCHORS: [number, number][] = [
            [-1400, 0.04],  // Elder floor       ⛰️
            [-600,  0.13],  // Steward floor      🏛️  (evenly spaced so each colour band is equal width)
            [-200,  0.24],  // Resident floor     🏠
            [-80,   0.35],  // Newcomer floor     🌱
            [0,     0.46],  // Zero line
            [200,   0.57],  // 0–200: 0% (Tax-Free Green Zone) → rate changes to 1% above 200
            [500,   0.68],  // 200–500: 1% → rate changes to 1.5% above here
            [1000,  0.79],  // 500–1000: 1.5% → rate changes to 2% above here
            [2000,  0.91],  // 1000–2000: 2% → rate changes to 2.5% above here
        ];

        // Piecewise linear interpolation between anchors — bead tracks accurately
        const toPos = (v: number): number => {
            if (v <= ANCHORS[0][0]) return ANCHORS[0][1];
            if (v >= ANCHORS[ANCHORS.length - 1][0]) return ANCHORS[ANCHORS.length - 1][1];
            for (let i = 0; i < ANCHORS.length - 1; i++) {
                const [v0, p0] = ANCHORS[i];
                const [v1, p1] = ANCHORS[i + 1];
                if (v >= v0 && v <= v1) {
                    const t = (v - v0) / (v1 - v0);
                    return p0 + t * (p1 - p0);
                }
            }
            return 0.5;
        };

        // Named positions (extracted from ANCHORS for readability)
        const ZERO_P  = 0.46;
        const P_200   = 0.57;
        const P_500   = 0.68;
        const P_1000  = 0.79;
        const P_2000  = 0.91;
        // Negative-side anchor positions (tier floors) — for the mirrored zones
        const P_N80   = 0.35;
        const P_N200  = 0.24;
        const P_N600  = 0.13;

        const balancePct = toPos(balance);

        // Your (continuous) credit floor — floors slide with value now, so instead of fixed
        // per-tier floor ticks we mark just YOUR floor with a single chevron.
        const floorPct = toPos(balanceState.floor);

        // Circ zone boundary ticks — just the threshold values; the rate label
        // for each bracket sits centered in the zone it applies to (zoneRates below).
        const circMarkers = [
            { v: 200,  pos: P_200  },
            { v: 500,  pos: P_500  },
            { v: 1000, pos: P_1000 },
            { v: 2000, pos: P_2000 },
        ];

        // Tax rate per bracket, positioned at the CENTER of the zone it applies to.
        const zoneRates: { rate: string; pos: number; color?: string }[] = [
            { rate: '0%',   pos: (ZERO_P + P_200) / 2, color: palette.green600 }, // 0–200 tax-free
            { rate: '1%',   pos: (P_200 + P_500) / 2 },   // 200–500
            { rate: '1.5%', pos: (P_500 + P_1000) / 2 },  // 500–1000
            { rate: '2%',   pos: (P_1000 + P_2000) / 2 }, // 1000–2000
            { rate: '2.5%', pos: (P_2000 + 1) / 2 },      // 2000+
        ];

        const vg = balanceState.velocityGate;

        return (
            <Pressable
                style={styles.creditBarOuter}
                accessibilityRole="button"
                accessibilityLabel="Credit spectrum"
                onPress={() => {
                    setShowSliderInfo(true);
                }}
            >
                <View style={styles.rulerWrap}>

                    {/* ── Continuous diverging bar: zero is the sweet spot, worse the further out either way ── */}
                    {/* Negative side (mirrored): green near zero → red at the Elder floor */}
                    {/* Red: ≤ -600 (down to the Elder floor) — rounded left cap */}
                    <View style={[styles.rulerSeg, { left: '2%', width: `${(P_N600 - 0.02) * 100}%`, backgroundColor: colors.feedback.danger.solid, borderTopLeftRadius: 6, borderBottomLeftRadius: 6, borderTopRightRadius: 0, borderBottomRightRadius: 0 }]} />
                    {/* Orange: -600 to -200 */}
                    <View style={[styles.rulerSeg, { left: `${P_N600 * 100}%`, width: `${(P_N200 - P_N600) * 100}%`, backgroundColor: palette.orange500, borderRadius: 0 }]} />
                    {/* Yellow: -200 to -80 */}
                    <View style={[styles.rulerSeg, { left: `${P_N200 * 100}%`, width: `${(P_N80 - P_N200) * 100}%`, backgroundColor: palette.yellow500, borderRadius: 0 }]} />
                    {/* Green: -80 to 0 (sweet-spot band continues across zero) */}
                    <View style={[styles.rulerSeg, { left: `${P_N80 * 100}%`, width: `${(ZERO_P - P_N80) * 100}%`, backgroundColor: palette.green500, borderRadius: 0 }]} />
                    {/* Green: 0–200 (Tax-Free Zone) */}
                    <View style={[styles.rulerSeg, { left: `${ZERO_P * 100}%`, width: `${(P_200 - ZERO_P) * 100}%`, backgroundColor: palette.green500, borderRadius: 0 }]} />
                    {/* Lime: 200–500 (1%) */}
                    <View style={[styles.rulerSeg, { left: `${P_200 * 100}%`, width: `${(P_500 - P_200) * 100}%`, backgroundColor: palette.lime500, borderRadius: 0 }]} />
                    {/* Yellow: 500–1000 (1.5%) */}
                    <View style={[styles.rulerSeg, { left: `${P_500 * 100}%`, width: `${(P_1000 - P_500) * 100}%`, backgroundColor: palette.yellow500, borderRadius: 0 }]} />
                    {/* Orange: 1000–2000 (2%) */}
                    <View style={[styles.rulerSeg, { left: `${P_1000 * 100}%`, width: `${(P_2000 - P_1000) * 100}%`, backgroundColor: palette.orange500, borderRadius: 0 }]} />
                    {/* Red: 2000+ (2.5%) — rounded right cap */}
                    <View style={[styles.rulerSeg, { left: `${P_2000 * 100}%`, right: 0, backgroundColor: colors.feedback.danger.solid, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderTopRightRadius: 6, borderBottomRightRadius: 6 }]} />

                    {/* ── Zero marker — only extends BELOW the line so it doesn't clip the bead label ── */}
                    <View style={[styles.rulerZeroLine, { left: `${ZERO_P * 100}%` }]} />
                    <Text style={[styles.rulerZeroLabel, { left: `${ZERO_P * 100}%` }]} allowFontScaling={false}>0</Text>

                    {/* ── Your credit floor — one chevron at your (continuous) floor ── */}
                    {balanceState.floor < 0 && (
                        <View style={[styles.rulerTickWrap, { left: `${floorPct * 100}%` }]}>
                            <MaterialCommunityIcons name="menu-up" size={18} color={tier.color} style={{ marginTop: -7 }} />
                            <Text style={[styles.rulerTickVal, { color: tier.color, fontWeight: '800', marginTop: -2 }]} numberOfLines={1} allowFontScaling={false}>{Math.round(balanceState.floor)}</Text>
                            <Text style={[styles.rulerYouTag, { color: tier.color }]} allowFontScaling={false}>your floor</Text>
                        </View>
                    )}

                    {/* ── Circ zone boundary ticks (right) — threshold value only ── */}
                    {circMarkers.map(c => (
                        <View key={c.v} style={[styles.rulerTickWrap, { left: `${c.pos * 100}%` }]}>
                            <View style={[styles.rulerTickMark, { backgroundColor: colors.text.muted }]} />
                            <Text style={styles.rulerTickVal} numberOfLines={1} allowFontScaling={false}>{c.v}</Text>
                        </View>
                    ))}

                    {/* ── Tax rate centered in the bracket it applies to ── */}
                    {zoneRates.map(z => (
                        <Text key={z.rate} style={[styles.rulerZoneRate, z.color ? { color: z.color, fontWeight: '800' } : null, { left: `${z.pos * 100}%` }]} numberOfLines={1} allowFontScaling={false}>{z.rate}</Text>
                    ))}

                    {/* ── Balance bead: label above, circle on the line ── */}
                    <View style={[styles.rulerBeadWrap, { left: `${balancePct * 100}%` }]}>
                        <Text style={[styles.rulerBeadLabel, { color: balance >= 0 ? palette.emerald800 : palette.red800 }]}>
                            {balance >= 0 ? '+' : ''}{balance.toFixed(1)}B
                        </Text>
                        <View style={[styles.rulerBead, { backgroundColor: tier.color, borderColor: colors.text.inverse }]} />
                    </View>

                </View>

                {/* ── Zero equilibrium note ── */}
                <View style={styles.rulerEquilibriumWrap}>
                    <Text style={styles.rulerEquilibriumText}>
                        ⚖️ Zero is the sweet spot — you've given as much as you've received. This is where the commons flows best.
                    </Text>
                </View>

                {/* ── Velocity gate pill — Newcomer only ── */}
                {vg?.active && (
                    <View style={styles.velocityPill}>
                        <MaterialCommunityIcons name="shield-check-outline" size={13} color={palette.indigo500} />
                        <Text style={styles.velocityPillText}>
                            Daily: {(vg.dailyUsed || 0).toFixed(1)} / {vg.dailyLimit}B used
                        </Text>
                        <Text style={styles.velocityPillDot}>·</Text>
                        <Text style={styles.velocityPillText}>Lifts in ~{vg.unlockHours}h</Text>
                    </View>
                )}
            </Pressable>
        );
    };



    // ─── Trust Tab ───────────────────────────────────────────────────────────
    const renderTrustTab = () => (
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.app }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }} showsVerticalScrollIndicator={false}>

            {/* Tier Hero */}
            <Pressable
                style={[styles.tierHero, { backgroundColor: tier.bg, borderColor: tier.border }]}
                accessibilityRole="button"
                onPress={() => {
                    setTrustInfoTab('levels');
                    setShowTrustInfo(true);
                }}
            >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                    <View>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={styles.tierHeroLabel}>YOUR TRUST LEVEL</Text>
                            <MaterialCommunityIcons name="information-outline" size={14} color={colors.text.muted} style={{ marginLeft: 4 }} />
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                            <Text style={{ fontSize: 32 }}>{tier.emoji}</Text>
                            <Text style={[styles.tierHeroName, { color: tier.color }]}>{tier.name}</Text>
                        </View>
                    </View>
                    <View style={[styles.levelBadge, { borderColor: tier.border, backgroundColor: colors.surface.card }]}>
                        <Text style={[styles.levelBadgeText, { color: tier.color }]}>Level {tierIdx + 1} / {TIERS.length}</Text>
                    </View>
                </View>

                {/* Journey bar: cumulative progress 0 → Elder, with tier milestone ticks */}
                <View style={styles.journeyTrack}>
                    <View style={[styles.journeyFill, { width: `${journeyPct * 100}%`, backgroundColor: tier.color }]} />
                    {TIERS.map((t: any) => {
                        // Include Newcomer (min 0); inset slightly so the leftmost badge isn't clipped.
                        const pos = Math.max(0.02, Math.min(1, t.min / ELDER_MIN));
                        const reached = ec >= t.min;
                        return (
                            <View key={t.name} style={[styles.journeyTick, { left: `${pos * 100}%` }]}>
                                <View style={[styles.journeyTickMark, reached && { backgroundColor: t.color }]} />
                                <Text style={styles.journeyTickEmoji} allowFontScaling={false}>{t.emoji}</Text>
                            </View>
                        );
                    })}
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 }}>
                    <Text style={styles.progressLabel}>{ec} trust points</Text>
                    {nextTier
                        ? <Text style={styles.progressLabel}>{creditsToNext} to {nextTier.name}</Text>
                        : <Text style={[styles.progressLabel, { color: theme === 'dark' ? palette.amber400 : palette.amber600, fontWeight: '700' }]}>✨ Maximum level!</Text>
                    }
                </View>

                {/* Perks */}
                <View style={styles.perksRow}>
                    <View style={[styles.perkPill, { borderColor: balanceState.tier.canGift ? palette.green200 : colors.border.default, backgroundColor: balanceState.tier.canGift ? palette.green50 : colors.surface.app }]}>
                        <MaterialCommunityIcons name={balanceState.tier.canGift ? 'check-circle' : 'lock-outline'} size={13} color={balanceState.tier.canGift ? colors.brand.primary : colors.text.muted} />
                        <Text style={[styles.perkText, { color: balanceState.tier.canGift ? colors.brand.dark : colors.text.muted }]}>Send Credits</Text>
                    </View>
                    <View style={[styles.perkPill, { borderColor: balanceState.tier.canInvite ? palette.green200 : colors.border.default, backgroundColor: balanceState.tier.canInvite ? palette.green50 : colors.surface.app }]}>
                        <MaterialCommunityIcons name={balanceState.tier.canInvite ? 'check-circle' : 'lock-outline'} size={13} color={balanceState.tier.canInvite ? colors.brand.primary : colors.text.muted} />
                        <Text style={[styles.perkText, { color: balanceState.tier.canInvite ? colors.brand.dark : colors.text.muted }]}>Invite Members</Text>
                    </View>
                </View>
            </Pressable>

            {/* How to reach the next tier — leads with the highest-leverage lever */}
            {nextTier && (
                <Pressable
                    style={styles.pathCard}
                    accessibilityRole="button"
                    onPress={() => {
                        setTrustInfoTab('levels');
                        setShowTrustInfo(true);
                    }}
                >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                        <Text style={[styles.pathTitle, { marginBottom: 0 }]}>🚀 Reach {nextTier.emoji} {nextTier.name}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Text style={{ fontSize: 11, fontWeight: '700', color: palette.indigo500 }}>Trust Manual</Text>
                            <MaterialCommunityIcons name="information-outline" size={14} color={palette.indigo500} />
                        </View>
                    </View>
                    <Text style={styles.pathGap}>{creditsToNext} trust points to go</Text>
                    <Text style={styles.pathHint}>
                        Trading with someone new is the fastest route — each new partner is worth {W_PARTNERS} points,
                        vs {W_TRADES} for a repeat trade. You also earn {W_DAYS}/day just by staying active.
                    </Text>
                    <View style={styles.pathRow}>
                        <View style={styles.pathOption}>
                            <Text style={[styles.pathNumber, { color: palette.blue500 }]}>{partnersToLevel}</Text>
                            <Text style={styles.pathLabel} numberOfLines={2}>new partners</Text>
                            <Text style={[styles.pathLeverTag, { color: palette.blue500 }]}>fastest</Text>
                        </View>
                        <View style={styles.pathOption}>
                            <Text style={[styles.pathNumber, { color: colors.brand.primary }]}>{tradesToLevel}</Text>
                            <Text style={styles.pathLabel} numberOfLines={2}>repeat trades</Text>
                        </View>
                        <View style={styles.pathOption}>
                            <Text style={[styles.pathNumber, { color: palette.orange500 }]}>~{Math.max(1, Math.round(daysToLevel / 30))}mo</Text>
                            <Text style={styles.pathLabel} numberOfLines={2}>just waiting</Text>
                        </View>
                    </View>
                </Pressable>
            )}

            {/* Achievement cards */}
            <Text style={styles.sectionLabel}>YOUR ACHIEVEMENTS</Text>
            <View style={styles.achieveRow}>
                {[
                    { icon: '🤝', label: 'TRADES',   count: tradeCount,     contrib: tradeCount * W_TRADES,     target: 50,  color: colors.brand.primary, trackBg: theme === 'dark' ? 'rgba(34,197,94,0.15)' : palette.green50 },
                    { icon: '👥', label: 'TRADE PARTNERS', count: uniquePartners, contrib: uniquePartners * W_PARTNERS, target: 20, color: palette.blue500, trackBg: theme === 'dark' ? 'rgba(59,130,246,0.15)' : palette.blue50 },
                    { icon: '📅', label: 'DAYS',     count: ageDays,        contrib: ageDays * W_DAYS,          target: 365, color: palette.orange500, trackBg: theme === 'dark' ? 'rgba(249,115,22,0.15)' : palette.orange50 },
                ].map(a => (
                    <Pressable
                        key={a.label}
                        style={[styles.achieveCard, { borderColor: a.color + '30' }]}
                        accessibilityRole="button"
                        onPress={() => {
                            setTrustInfoTab('levels');
                            setShowTrustInfo(true);
                        }}
                    >
                        <Text style={{ fontSize: 22, marginBottom: 4 }}>{a.icon}</Text>
                        <Text numberOfLines={1} style={[styles.achieveCount, { color: a.color }]}>{a.count}</Text>
                        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.achieveLabel}>{a.label}</Text>
                        <Text style={styles.achieveContrib}>+{a.contrib} pts</Text>
                        <View style={[styles.achieveBarBg, { backgroundColor: a.trackBg }]}>
                            <View style={[styles.achieveBarFill, { width: `${Math.min(100, (a.count / a.target) * 100)}%`, backgroundColor: a.color }]} />
                        </View>
                        <Text style={styles.achieveFooter}>{a.count}/{a.target}</Text>
                    </Pressable>
                ))}
            </View>

            {/* Tier Ladder */}
            <Text style={styles.sectionLabel}>TRUST LADDER</Text>
            <View style={styles.ladder}>
                {TIERS.map((t: any, i: number) => {
                    const reached = tierIdx >= i;
                    const isCurrent = tierIdx === i;
                    const hoursEquiv = Math.round(Math.abs(t.floor) / 40 * 10) / 10;
                    const creditsNeeded = Math.max(0, t.min - ec);
                    return (
                        <Pressable
                            key={t.name}
                            style={[styles.ladderRow, isCurrent && { backgroundColor: t.bg, borderColor: t.border }]}
                            accessibilityRole="button"
                            onPress={() => {
                                setTrustInfoTab('perks');
                                setShowTrustInfo(true);
                            }}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                                <View style={[styles.ladderDot, { backgroundColor: reached ? t.color : colors.border.default, borderColor: t.color, marginTop: 4 }]} />
                                <Text style={{ fontSize: 18, width: 24, textAlign: 'center', marginTop: 1 }}>{t.emoji}</Text>
                                <View style={{ flex: 1 }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <Text style={[styles.ladderName, { color: reached ? t.color : colors.text.muted }]}>
                                            {t.name}{isCurrent ? '  ← you' : ''}
                                        </Text>
                                        {reached
                                            ? <MaterialCommunityIcons name="check-circle" size={16} color={t.color} />
                                            : creditsNeeded > 0
                                                ? <Text style={[styles.ladderBadge, { color: t.color, borderColor: t.color + '40' }]}>{creditsNeeded} to go</Text>
                                                : null
                                        }
                                    </View>

                                    {/* Credits required */}
                                    <Text style={styles.ladderReq}>
                                        {t.min === 0 ? 'Starting tier' : `Earn ${t.min} pts via trades, partners & days`}
                                    </Text>

                                    {/* Floor info */}
                                    <View style={styles.ladderDetail}>
                                        <MaterialCommunityIcons name="scale-balance" size={11} color={colors.text.secondary} />
                                        <Text style={styles.ladderDetailText}>
                                            Floor {t.floor} · ≈{hoursEquiv}hrs credit
                                        </Text>
                                    </View>

                                    {/* Daily limit */}
                                    <View style={styles.ladderDetail}>
                                        <MaterialCommunityIcons name={t.dailyLimit ? 'shield-check-outline' : 'infinity'} size={11} color={t.dailyLimit ? palette.indigo500 : colors.brand.primary} />
                                        <Text style={styles.ladderDetailText}>
                                            {t.dailyLimit ? `Daily limit: ${t.dailyLimit}B (new account protection)` : 'No daily spending limit'}
                                        </Text>
                                    </View>

                                    {/* Perks */}
                                    <View style={{ marginTop: 4, gap: 2 }}>
                                        {t.perks.map((p: string) => (
                                            <View key={p} style={styles.ladderDetail}>
                                                <MaterialCommunityIcons name={reached ? 'check' : 'lock-outline'} size={11} color={reached ? colors.brand.primary : colors.border.strong} />
                                                <Text style={[styles.ladderDetailText, { color: reached ? colors.text.body : colors.text.muted }]}>{p}</Text>
                                            </View>
                                        ))}
                                    </View>
                                </View>
                            </View>
                        </Pressable>
                    );
                })}
            </View>
            <Text style={styles.formula}>💡 Credits = (trades × 8) + (partners × 40) + (days as member × 2)</Text>
        </ScrollView>
    );

    // ─── Financials Tab ───────────────────────────────────────────────────────
    const renderActivityHeader = () => {
        const brackets = [{ m: 200, r: 0.0 }, { m: 300, r: 0.010 }, { m: 500, r: 0.015 }, { m: 1000, r: 0.020 }, { m: Infinity, r: 0.025 }];
        let rem = balanceState.balance, monthly = 0;
        for (const b of brackets) { if (rem <= 0) break; monthly += Math.min(rem, b.m) * b.r; rem -= b.m; }
        const amber = balanceState.balance > 1000;
        const now = new Date();
        const nextRun = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const daysUntil = Math.ceil((nextRun.getTime() - now.getTime()) / 86400000);

        return (
            <View>
                <View style={styles.balanceRow}>
                    <Pressable style={styles.balanceCard} accessibilityRole="button" onPress={() => setShowBalanceInfo(true)}>
                        <Text style={styles.balCardLabel}>Balance ⓘ</Text>
                        <CurrencyDisplay asView style={[styles.balCardAmount, balanceState.balance >= 0 ? styles.pos : styles.neg]} amount={`${balanceState.balance >= 0 ? '+' : ''}${balanceState.balance.toFixed(2)}`} />
                        <Text style={styles.balCardSub}>≈ {(Math.abs(balanceState.balance) / 40).toFixed(1)} hrs · Floor {balanceState.floor}</Text>
                    </Pressable>
                    <Pressable style={styles.balanceCard} accessibilityRole="button" onPress={() => setShowCommonsInfo(true)}>
                        <Text style={styles.balCardLabel}>Commons ⓘ</Text>
                        <CurrencyDisplay asView style={styles.commonsAmt} amount={balanceState.commons.toFixed(2)} />
                        <Text style={styles.balCardSub}>🌱 Community Pool</Text>
                    </Pressable>
                </View>

                {/* Velocity Gate — usage meter for new accounts */}
                {balanceState.velocityGate?.active && (() => {
                    const vg = balanceState.velocityGate;
                    const used = vg.dailyUsed || 0;
                    const limit = vg.dailyLimit || 1;
                    const pct = Math.min(1, used / limit);
                    const remaining = Math.max(0, limit - used);
                    const isHigh = pct >= 0.8;
                    const isFull = pct >= 1;
                    return (
                        <View style={styles.velocityCard}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                                <MaterialCommunityIcons name="shield-check-outline" size={18} color={palette.indigo500} />
                                <Text style={styles.velocityTitle}>New Account Protection</Text>
                            </View>

                            <Text style={styles.velocityLabel}>DAILY USAGE (24hr rolling)</Text>
                            <View style={styles.velocityBarBg}>
                                <View style={[styles.velocityBarFill, {
                                    width: `${pct * 100}%`,
                                    backgroundColor: isFull ? colors.feedback.danger.solid : isHigh ? palette.amber500 : palette.indigo500,
                                }]} />
                            </View>
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                                <Text style={styles.velocityUsed}>{used.toFixed(1)}B used</Text>
                                <Text style={styles.velocityLimit}>{limit}B limit</Text>
                            </View>

                            {isFull ? (
                                <View style={styles.velocityWarning}>
                                    <MaterialCommunityIcons name="clock-alert-outline" size={14} color={palette.red600} />
                                    <Text style={styles.velocityWarningText}>Daily limit reached — resets on a rolling 24hr window</Text>
                                </View>
                            ) : (
                                <Text style={styles.velocityRemaining}>{remaining.toFixed(1)}B remaining today</Text>
                            )}

                            <View style={styles.velocityUnlock}>
                                <MaterialCommunityIcons name="lock-open-variant-outline" size={14} color={colors.brand.primary} />
                                <Text style={styles.velocityUnlockText}>
                                    Full access unlocks in ~{vg.unlockHours}h
                                </Text>
                            </View>

                            <Text style={styles.velocityExplainer}>
                                To protect the community, new accounts have daily spending limits that increase over time. Keep trading to build trust!
                            </Text>
                        </View>
                    );
                })()}

                {balanceState.balance > 0 && (
                    <Pressable style={[styles.circBox, amber && styles.circBoxAmber]} accessibilityRole="button" onPress={() => setShowCirculationInfo(true)}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                            <Text style={[styles.circLabel, amber && { color: theme === 'dark' ? palette.amber400 : palette.amber800 }]}>🌿 Community Circulation ⓘ</Text>
                            <CurrencyDisplay style={[styles.circRate, amber && { color: theme === 'dark' ? palette.amber400 : palette.amber800 }]} amount={monthly.toFixed(2)} />
                        </View>
                        <Text style={[styles.circLabel, { color: colors.text.muted, fontSize: 11, marginTop: 2 }]}>per month → commons pool</Text>
                        {amber && <Text style={{ color: theme === 'dark' ? palette.amber400 : palette.amber600, fontSize: 11, marginTop: 4, fontWeight: '600' }}>Balance above 1000 — consider spending!</Text>}
                    </Pressable>
                )}

                {escrowTotal > 0 && (
                    <View style={styles.infoCard}>
                        <View style={styles.infoCardRow}>
                            <MaterialCommunityIcons name="lock-clock" size={18} color={palette.amber500} />
                            <Text style={styles.infoCardLabel}>Held in Trust</Text>
                            <CurrencyDisplay style={styles.infoCardValue} amount={escrowTotal.toFixed(2)} />
                        </View>
                        <Text style={styles.infoCardSub}>Beans locked in active deals held in trust</Text>
                    </View>
                )}

                {balanceState.balance > 0 && (
                    <View style={styles.forecastCard}>
                        <View style={styles.infoCardRow}>
                            <MaterialCommunityIcons name="calendar-clock" size={18} color={colors.accent.primary} />
                            <Text style={styles.infoCardLabel}>Next Circulation</Text>
                            <Text style={styles.forecastDate}>{nextRun.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} · {daysUntil}d</Text>
                        </View>
                        <View style={styles.infoCardRow}>
                            <Text style={styles.forecastSub}>Est. amount</Text>
                            <CurrencyDisplay style={styles.forecastAmt} amount={`~${monthly.toFixed(1)}`} />
                        </View>
                    </View>
                )}

                {pledgeHistory.length > 0 && (
                    <View style={styles.pledgeSection}>
                        <Text style={styles.sectionLabel}>PROJECT PLEDGES</Text>
                        {pledgeHistory.map((pl: any) => (
                            <View key={pl.id} style={styles.pledgeRow}>
                                <MaterialCommunityIcons name="sprout" size={16} color={colors.brand.primary} />
                                <View style={{ flex: 1, marginLeft: 10 }}>
                                    <Text style={styles.pledgeName} numberOfLines={1}>{pl.projectTitle}</Text>
                                    <Text style={styles.pledgeDate}>{new Date(pl.timestamp).toLocaleDateString()}</Text>
                                </View>
                                <Text style={styles.pledgeAmt}>-{pl.amount} B</Text>
                            </View>
                        ))}
                    </View>
                )}

                <Pressable
                    style={[styles.sendBtn, showSend && styles.sendBtnOpen, !balanceState.tier.canGift && styles.sendBtnLocked]}
                    accessibilityRole="button"
                    onPress={async () => {
                        if (!balanceState.tier.canGift) {
                            Alert.alert(
                                'Sending Locked', 
                                'Your current Trust Level does not permit sending credits yet.\n\nEarn points by trading and inviting partners to reach the next tier! See the Trust Level tab for your progress.', 
                                [{ text: 'OK' }]
                            );
                            return;
                        }
                        if (!showSend) {
                            const url = await AsyncStorage.getItem('beanpool_anchor_url');
                            if (!url) { Alert.alert('Not Connected', 'Connect to a community first.', [{ text: 'Cancel' }, { text: 'Connect', onPress: () => router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } }) }]); return; }
                            loadMembers();
                        }
                        setShowSend(!showSend); setSendError(null); setSendSuccess(false);
                    }}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                        <Text style={[styles.sendBtnText, !balanceState.tier.canGift && { color: colors.text.secondary }]}>
                            {!balanceState.tier.canGift ? '🔒 Send Credits (Locked)' : showSend ? '✕ Cancel' : '💸 Send Credits'}
                        </Text>
                        {!balanceState.tier.canGift && (
                            <MaterialCommunityIcons name="information-outline" size={16} color={colors.text.muted} />
                        )}
                    </View>
                </Pressable>

                {showSend && (
                    <View style={styles.sendForm}>
                        <Pressable style={styles.recipientRow} accessibilityRole="button" onPress={() => setShowMemberPicker(!showMemberPicker)}>
                            <Text style={[styles.recipientText, !selectedMember && { color: colors.text.muted }]}>{selectedMember?.callsign || 'Select recipient...'}</Text>
                            <MaterialCommunityIcons name={showMemberPicker ? 'chevron-up' : 'chevron-down'} size={20} color={colors.text.secondary} />
                        </Pressable>
                        {showMemberPicker && (
                            <View style={styles.pickerBox}>
                                <TextInput style={styles.pickerSearch} accessibilityLabel="Search members" placeholder="Search members..." placeholderTextColor={colors.text.muted} value={memberSearch} onChangeText={setMemberSearch} autoCapitalize="none" autoCorrect={false} />
                                {/* Plain ScrollView (not a nested FlatList): a vertical FlatList inside the
                                    outer transactions FlatList has broken scroll on Android. keyboardShouldPersistTaps
                                    lets a member be tapped while the search keyboard is still open. */}
                                <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                                    {filteredMembers.length === 0 ? (
                                        <Text style={{ padding: 16, color: colors.text.muted, textAlign: 'center', fontSize: 13 }}>No members found</Text>
                                    ) : filteredMembers.map(item => (
                                        <Pressable key={item.publicKey} style={[styles.pickerRow, item.publicKey === sendTo && styles.pickerRowActive]} accessibilityRole="button" accessibilityState={{ selected: item.publicKey === sendTo }} onPress={() => { setSendTo(item.publicKey); setShowMemberPicker(false); setMemberSearch(''); }}>
                                            <Text style={[styles.pickerName, item.publicKey === sendTo && { color: colors.text.inverse }]}>{item.callsign}</Text>
                                            <Text style={[styles.pickerPk, item.publicKey === sendTo && { color: palette.emerald100 }]}>{item.publicKey.slice(0, 12)}...</Text>
                                        </Pressable>
                                    ))}
                                </ScrollView>
                            </View>
                        )}
                        <TextInput style={styles.sendInput} accessibilityLabel="Amount to send" placeholder="Amount" placeholderTextColor={colors.text.muted} keyboardType="numeric" value={sendAmount} onChangeText={setSendAmount} />
                        <TextInput style={styles.sendInput} accessibilityLabel="Memo" placeholder="Memo (optional)" placeholderTextColor={colors.text.muted} value={sendMemo} onChangeText={setSendMemo} />
                        {(() => {
                            const parsedAmount = parseFloat(sendAmount);
                            if (!isNaN(parsedAmount) && parsedAmount > 0) {
                                // Peer transfers are fee-free — the recipient receives the full amount.
                                return (
                                    <View style={styles.taxBreakdown}>
                                        <View style={styles.breakdownRow}>
                                            <Text style={styles.breakdownLabel}>Recipient receives:</Text>
                                            <CurrencyDisplay amount={parsedAmount.toFixed(2)} style={styles.breakdownValue} asView />
                                        </View>
                                    </View>
                                );
                            }
                            return null;
                        })()}
                        {sendError && <View style={styles.errBox}><Text style={styles.errText}>{sendError}</Text></View>}
                        {sendSuccess && <View style={styles.okBox}><Text style={styles.okText}>✓ Sent!</Text></View>}
                        <Pressable style={[styles.confirmBtn, (sending || !sendTo || !sendAmount) && styles.confirmBtnOff]} accessibilityRole="button" onPress={handleSend} disabled={sending || !sendTo || !sendAmount}>
                            <Text style={styles.confirmBtnText}>{sending ? 'Sending...' : 'Confirm Transfer'}</Text>
                        </Pressable>
                    </View>
                )}

                <View style={styles.txnHeaderRow}>
                    <Text style={styles.sectionLabel}>RECENT TRANSACTIONS</Text>
                    <Pressable style={styles.exportBtn} accessibilityRole="button" accessibilityLabel="Export CSV" onPress={handleExport} disabled={exporting}>
                        <MaterialCommunityIcons name="download" size={14} color={colors.text.secondary} />
                        <Text style={styles.exportBtnText}>{exporting ? 'Exporting…' : 'Export CSV'}</Text>
                    </Pressable>
                </View>
            </View>
        );
    };

    const renderMemoText = (memo: string) => {
        if (!memo) return null;
        const uuidRegex = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
        const match = memo.match(uuidRegex);
        if (match) {
            const offerId = match[1];
            const parts = memo.split(offerId);
            return (
                <Text style={styles.txnMemo}>
                    {parts[0]}
                    <Text 
                        style={{ color: colors.accent.primary, fontWeight: '800', textDecorationLine: 'underline' }}
                        onPress={() => router.push({ pathname: '/post/[id]', params: { id: offerId } })}
                    >
                        View Offer
                    </Text>
                    {parts[1]}
                </Text>
            );
        }
        return <Text style={styles.txnMemo}>{memo}</Text>;
    };

    const renderTxn = ({ item }: { item: any }) => {
        const isCredit = item.type === 'credit';
        return (
            <View style={styles.txnRow}>
                <View style={[styles.txnIcon, isCredit ? styles.txnIconCredit : styles.txnIconDebit]}>
                    <MaterialCommunityIcons name={isCredit ? 'arrow-bottom-left' : 'arrow-top-right'} size={18} color={isCredit ? colors.brand.primary : colors.feedback.danger.solid} />
                </View>
                <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={styles.txnPeer}>{item.peer}</Text>
                    {renderMemoText(item.memo)}
                    <Text style={styles.txnTime}>{item.timestamp}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={[styles.txnAmount, isCredit ? styles.pos : styles.neg]}>{isCredit ? '+' : '-'}{item.amount}</Text>
                    <Image source={require('../../assets/images/bean.png')} accessibilityElementsHidden={true} importantForAccessibility="no-hide-descendants" style={{ width: 16, height: 16, marginLeft: 2, resizeMode: 'contain', flexShrink: 0 }} />
                </View>
            </View>
        );
    };

    return (
        <SafeAreaView style={styles.root}>
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                keyboardVerticalOffset={88}
                style={{ flex: 1 }}
            >

            {/* ── Compact profile + balance bar ── */}
            <View style={styles.topBar}>
                {/* Avatar + name + tier — left side */}
                <Pressable style={styles.profileChunk} accessibilityRole="button" onPress={() => identity?.publicKey && router.push({ pathname: '/public-profile', params: { publicKey: identity.publicKey, callsign: identity.callsign } })}>
                    <View style={styles.avatarRing}>
                        <MemberAvatar avatarUrl={avatarUrl} pubkey={identity?.publicKey || ''} callsign={identity?.callsign || 'G'} size={48} />
                    </View>
                    <View>
                        <Text style={styles.profileName}>{identity?.callsign || 'GUEST'}</Text>
                        <View style={[styles.tierChip, { backgroundColor: tier.bg, borderColor: tier.border }]}>
                            <Text style={styles.tierChipEmoji}>{tier.emoji}</Text>
                            <Text style={[styles.tierChipText, { color: tier.color }]}>{tier.name}</Text>
                        </View>
                    </View>
                </Pressable>

                {/* Balance — right side, intentionally large */}
                <Pressable style={styles.balanceChunk} accessibilityRole="button" onPress={() => { setActiveTab('financials'); }}>
                    <CurrencyDisplay
                        asView
                        style={[styles.bigBalance, balanceState.balance >= 0 ? styles.pos : styles.neg]}
                        amount={`${balanceState.balance >= 0 ? '+' : ''}${balanceState.balance.toFixed(1)}`}
                    />
                    <Text style={styles.balanceWord}>BEANS</Text>
                </Pressable>
            </View>

            {/* ── Credit Spectrum Bar ── */}
            {renderCreditBar()}

            {/* ── Tab bar ── */}
            <View style={styles.tabBar}>
                <Pressable style={[styles.tab, activeTab === 'trust' && [styles.tabActive, { borderBottomColor: tier.color }]]} accessibilityRole="button" accessibilityState={{ selected: activeTab === 'trust' }} onPress={() => setActiveTab('trust')}>
                    <MaterialCommunityIcons name="shield-star-outline" size={15} color={activeTab === 'trust' ? tier.color : colors.text.muted} />
                    <Text style={[styles.tabText, activeTab === 'trust' && { color: tier.color, fontWeight: '800' }]}>Trust Level</Text>
                </Pressable>
                <Pressable style={[styles.tab, activeTab === 'financials' && styles.tabActive]} accessibilityRole="button" accessibilityState={{ selected: activeTab === 'financials' }} onPress={() => setActiveTab('financials')}>
                    <MaterialCommunityIcons name="swap-horizontal" size={15} color={activeTab === 'financials' ? colors.brand.primary : colors.text.muted} />
                    <Text style={[styles.tabText, activeTab === 'financials' && { color: colors.brand.primary, fontWeight: '800' }]}>Financials</Text>
                </Pressable>
            </View>

            {/* ── Content ── */}
            {activeTab === 'trust' ? renderTrustTab() : (
                <FlatList
                    data={txns}
                    keyExtractor={item => item.id}
                    renderItem={renderTxn}
                    ListHeaderComponent={renderActivityHeader()}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ padding: 16, paddingBottom: keyboardHeight > 0 ? keyboardHeight + 48 : 48 }}
                    showsVerticalScrollIndicator={false}
                    ListEmptyComponent={<Text style={{ textAlign: 'center', color: colors.text.muted, paddingTop: 32, fontSize: 14 }}>No transactions yet.</Text>}
                />
            )}

            </KeyboardAvoidingView>
            <BalanceInfoModal isOpen={showBalanceInfo} onClose={() => setShowBalanceInfo(false)} />
            <CommonsInfoModal isOpen={showCommonsInfo} onClose={() => setShowCommonsInfo(false)} commonsBalance={balanceState.commons} />
            <CirculationInfoModal isOpen={showCirculationInfo} onClose={() => setShowCirculationInfo(false)} />
            <TrustInfoModal isOpen={showTrustInfo} onClose={() => setShowTrustInfo(false)} initialTab={trustInfoTab} />
            <SliderInfoModal isOpen={showSliderInfo} onClose={() => setShowSliderInfo(false)} />
        </SafeAreaView>
    );
}

// Styles defined dynamically inside LedgerScreen component
