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
import { TrustBadge, TrustLevel } from '../../components/TrustBadge';
import { CreditBar } from '../../components/CreditBar';
import { useTheme, useStyles } from '../ThemeContext';
import { palette } from '../../constants/colors';

// ── Trust model constants (mirrors beanpool-core/protocol.ts) ──
// Earned trust is a SATURATING CURVE over qualified, diversity-capped trade VALUE (V):
//   earned = floor(CREDIT_MAX_EARNED × V / (V + TRUST_CURVE_K))
// There is NO baked-in floor: floor = -(20 welcome voucher + earned + granted), so it slides
// continuously from 0 down to -2000. Tiers are recognition milestones (they don't set the floor).
// (The 20 voucher is already folded into the tier thresholds below, so the client needs no constant.)
const CREDIT_MAX_EARNED = 1920;      // asymptote of the earned-trust curve
const TRUST_CURVE_K = 5000;          // curve constant (higher = stricter)
const PER_COUNTERPARTY_CAP = 5000;   // diversity: value with any ONE partner counts at most this much
const CIRC_TICKS = [200, 500, 1000]; // circulation rate change points

// Tier credit thresholds (earned+granted). They map to the floor breakpoints
// -200/-600/-1400 the server uses in getTier(), given floor = -(20 voucher + earned + granted).
function getTierIndex(credit: number) {
    if (credit >= 1380) return 3;
    if (credit >= 580)  return 2;
    if (credit >= 180)  return 1;
    return 0;
}
// Inverse of the curve: qualified value needed to reach a target earned credit.
function valueForEarned(target: number): number {
    if (target <= 0) return 0;
    if (target >= CREDIT_MAX_EARNED) return Infinity;
    return Math.ceil((TRUST_CURVE_K * target) / (CREDIT_MAX_EARNED - target));
}

export default function LedgerScreen() {
    const { theme, colors } = useTheme();
    const { identity } = useIdentity();
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    // Tiers are recognition milestones. `floor` is the credit floor you reach on ENTERING
    // the tier (floors slide continuously between them). `min` = earned+granted credit needed.
    const TIERS = useMemo(() => [
        { name: 'Newcomer', emoji: '🌱', color: colors.trust.newcomer.fg, bg: colors.trust.newcomer.bg, border: colors.trust.newcomer.border, min: 0,    floor: -20,
          blurb: "Welcome. From day one you can browse, trade, receive credits and invite others — a small welcome voucher gets you moving.",
          perks: ['Browse & trade the marketplace', 'Receive credits', 'Invite others to join', 'Send credits when your balance is positive'] },
        { name: 'Resident', emoji: '🏠', color: colors.trust.resident.fg, bg: colors.trust.resident.bg, border: colors.trust.resident.border, min: 180,  floor: -200,
          blurb: "You've traded real value with the community. Your credit line deepens with every trade — the more value you exchange, the deeper it grows.",
          perks: ['Credit floor deepens with the value you trade', 'Invite others to join'] },
        { name: 'Steward',  emoji: '🏛️', color: colors.trust.steward.fg, bg: colors.trust.steward.bg, border: colors.trust.steward.border, min: 580,  floor: -600,
          blurb: "A trusted trader with a broad circle of partners. The community recognises you, and your credit line runs deeper still.",
          perks: ['Credit floor continues deepening', 'Trusted-trader recognition'] },
        { name: 'Elder',    emoji: '⛰️', color: colors.trust.elder.fg, bg: colors.trust.elder.bg, border: colors.trust.elder.border, min: 1380, floor: -1400,
          blurb: "A pillar of the commons — the deepest possible credit line and the community's highest recognition.",
          perks: ['Credit floor can reach -2000 (the maximum)', 'Recognised as a community Elder'] },
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
    const [selectedLevel, setSelectedLevel] = useState<number | null>(null); // Levels shelf: null → follows current tier
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
        perksRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
        perkPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1 },
        perkText: { fontSize: 12, fontWeight: '700' },

        // Standing hero
        heroInfo: { position: 'absolute', top: 14, right: 14, zIndex: 2 },
        heroSub: { fontSize: 12, fontWeight: '600', color: colors.text.secondary, marginTop: 3 },
        heroProgressRow: { marginTop: 16 },
        heroProgressText: { fontSize: 13, color: colors.text.body, fontWeight: '600' },

        // Medallion shelf — every level at a glance
        shelf: { flexDirection: 'row', gap: 8, marginBottom: 18 },
        shelfItem: { flex: 1, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 2, borderRadius: 16, borderWidth: 1.5, borderColor: 'transparent', backgroundColor: colors.surface.card },
        shelfName: { fontSize: 11, fontWeight: '800', marginTop: 6 },
        shelfState: { fontSize: 9, fontWeight: '600', color: colors.text.muted, marginTop: 2 },

        // Selected-level detail card
        detailCard: { backgroundColor: colors.surface.card, borderRadius: 18, padding: 18, marginBottom: 20, borderWidth: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
        detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
        detailName: { fontSize: 20, fontWeight: '900', letterSpacing: -0.3 },
        detailStatePill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, borderWidth: 1 },
        detailStateText: { fontSize: 11, fontWeight: '800' },
        detailBlurb: { fontSize: 13, color: colors.text.body, lineHeight: 19, marginBottom: 14 },
        detailFloorRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface.app, borderRadius: 12, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: colors.border.default },
        detailFloorLabel: { flex: 1, fontSize: 13, color: colors.text.secondary, fontWeight: '600' },
        detailFloorVal: { fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] },
        detailPerkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 7 },
        detailPerkText: { flex: 1, fontSize: 13, color: colors.text.body, lineHeight: 18 },
        detailNote: { fontSize: 11, color: colors.text.muted, fontStyle: 'italic', marginTop: 8, lineHeight: 16 },

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
        // ── Wallet Hero ──
        walletHero: { borderRadius: 20, padding: 20, borderWidth: 1, marginBottom: 16 },
        walletBigBalance: { fontSize: 42, fontWeight: '900', letterSpacing: -2, marginVertical: 8 },
        walletMetricRow: { flexDirection: 'row', backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderRadius: 14, overflow: 'hidden', marginTop: 16 },
        walletMetric: { flex: 1, alignItems: 'center', paddingVertical: 10, gap: 3 },
        walletMetricDivider: { width: 1, backgroundColor: colors.border.default },
        walletMetricVal: { fontSize: 15, fontWeight: '800', color: colors.text.heading },
        walletMetricLabel: { fontSize: 10, fontWeight: '700', color: colors.text.muted, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
        circRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
        circNextDate: { fontSize: 12, fontWeight: '700' as const },
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
        txnPeer: { fontSize: 14, fontWeight: '800', color: colors.text.heading, marginBottom: 2 },
        txnMemo: { fontSize: 12, color: colors.text.secondary, marginBottom: 2 },
        txnTime: { fontSize: 11, color: colors.text.muted },
        txnAmount: { fontSize: 16, fontWeight: '800' },

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
        floorChevronTop: { position: 'absolute', top: 8, marginLeft: -8 },
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
        // Sends are positive-balance only — you can only send beans you actually hold. Your credit
        // line (overdraft) is for trading, not for gifting yourself into debt.
        if (amount > balanceState.balance) {
            setSendError(`You can only send beans you hold — your balance is ${balanceState.balance.toFixed(2)}B.`);
            return;
        }
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

    // Open the Send flow from anywhere (Levels hero or Wallet). Surfaces the form in the Wallet tab.
    const openSend = async () => {
        if (!canSend) {
            Alert.alert(
                'No balance to send',
                'You can send credits whenever your balance is positive — earn some by completing a trade on the Marketplace.',
                [{ text: 'OK' }]
            );
            return;
        }
        const url = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!url) {
            Alert.alert('Not Connected', 'Connect to a community first.', [{ text: 'Cancel' }, { text: 'Connect', onPress: () => router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } }) }]);
            return;
        }
        loadMembers();
        setActiveTab('financials');
        setSendError(null); setSendSuccess(false);
        setShowSend(true);
    };

    // Trust calculations (value-based)
    const earned = balanceState.earnedCredit || 0;   // from the saturating value curve
    const granted = balanceState.grantedCredit || 0; // vouch/genesis/admin (separate lane)
    const totalCredit = Math.min(CREDIT_MAX_EARNED, earned + granted); // this is what backs the floor & tier
    const ec = totalCredit;                            // "trust" shown to the user
    const qualifiedValue = balanceState.qualifiedValue || 0;
    const avgRating = balanceState.avgRating || 0;
    const reviewCount = balanceState.reviewCount || 0;
    const canSend = balanceState.balance > 0;           // gate: positive balance only (tiers are merit badges, not gates)
    const ts = balanceState.trustStats;
    const uniquePartners = ts?.uniquePartners || 0;

    // Tier: trust the server's authoritative tier name; fall back to the credit threshold.
    const TIER_NAMES = ['Newcomer', 'Resident', 'Steward', 'Elder'];
    const serverIdx = TIER_NAMES.indexOf(balanceState.tier?.name);
    const tierIdx = serverIdx >= 0 ? serverIdx : getTierIndex(totalCredit);
    const tier = TIERS[tierIdx];
    const nextTier = TIERS[tierIdx + 1] || null;
    const ELDER_MIN = TIERS[TIERS.length - 1].min;
    const journeyPct = ELDER_MIN > 0 ? Math.min(1, totalCredit / ELDER_MIN) : 1; // progress toward Elder
    const creditsToNext = nextTier ? Math.max(0, nextTier.min - totalCredit) : 0;

    // Value needed for the next tier: invert the curve for the earned credit that tier
    // requires (granted credit is fixed), minus the value already traded. Then translate
    // to a rough "new partners" count (value with any one partner is diversity-capped).
    const targetEarned = nextTier ? Math.max(0, nextTier.min - granted) : 0;
    const valueToNext = nextTier ? Math.max(0, valueForEarned(targetEarned) - qualifiedValue) : 0;
    const partnersToNext = nextTier && Number.isFinite(valueToNext)
        ? Math.max(1, Math.ceil(valueToNext / PER_COUNTERPARTY_CAP)) : 0;

    // Level → coin-badge key (for the new SVG TrustBadge medallions).
    const LEVEL_KEYS: TrustLevel[] = ['newcomer', 'resident', 'steward', 'elder'];
    const levelKey = LEVEL_KEYS[tierIdx] || 'newcomer';
    // Which level the Levels shelf is inspecting (defaults to your current tier until you tap another).
    const selLevel = selectedLevel ?? tierIdx;

    const selectedMember = members.find(m => m.publicKey === sendTo);
    const filteredMembers = members.filter(m => m.callsign.toLowerCase().includes(memberSearch.toLowerCase()));

    // Credit position is now the reusable <CreditBar> component (zero-centred, anchored scale).
    // The old inline spectrum slider was removed in the ledger redesign.



    // ─── Levels Tab ──────────────────────────────────────────────────────────
    const renderTrustTab = () => {
        const sel = TIERS[selLevel];
        const selReached = tierIdx >= selLevel;
        const selCurrent = tierIdx === selLevel;
        const selNeeded = Math.max(0, sel.min - ec);
        return (
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.app }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }} showsVerticalScrollIndicator={false}>

            {/* ── Standing hero ── */}
            <View style={[styles.tierHero, { backgroundColor: tier.bg, borderColor: tier.border }]}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="How trust works"
                    hitSlop={8}
                    style={styles.heroInfo}
                    onPress={() => { setTrustInfoTab('levels'); setShowTrustInfo(true); }}
                >
                    <MaterialCommunityIcons name="information-outline" size={18} color={colors.text.muted} />
                </Pressable>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                    <TrustBadge level={levelKey} size={76} ring ringPct={journeyPct} />
                    <View style={{ flex: 1 }}>
                        <Text style={styles.tierHeroLabel}>YOUR TRUST LEVEL</Text>
                        <Text style={[styles.tierHeroName, { color: tier.color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{tier.name}</Text>
                        <Text style={styles.heroSub}>Level {tierIdx + 1} of {TIERS.length} · {ec} trust</Text>
                    </View>
                </View>

                <View style={styles.heroProgressRow}>
                    {nextTier
                        ? <Text style={styles.heroProgressText}><Text style={{ fontWeight: '900', color: tier.color }}>{creditsToNext}</Text> more trust to {nextTier.emoji} {nextTier.name}</Text>
                        : <Text style={[styles.heroProgressText, { color: theme === 'dark' ? palette.amber400 : palette.amber600, fontWeight: '800' }]}>✨ Highest level reached</Text>
                    }
                </View>

                {/* Quick actions */}
                <View style={styles.perksRow}>
                    <Pressable
                        accessibilityRole="button"
                        style={[styles.perkPill, { borderColor: canSend ? palette.green200 : colors.border.default, backgroundColor: canSend ? palette.green50 : colors.surface.app }]}
                        onPress={openSend}
                    >
                        <MaterialCommunityIcons name={canSend ? 'send' : 'lock-outline'} size={13} color={canSend ? colors.brand.primary : colors.text.muted} />
                        <Text style={[styles.perkText, { color: canSend ? colors.brand.dark : colors.text.muted }]}>{canSend ? 'Send Credits' : 'Send (needs +ve balance)'}</Text>
                    </Pressable>
                    <View style={[styles.perkPill, { borderColor: palette.green200, backgroundColor: palette.green50 }]}>
                        <MaterialCommunityIcons name="check-circle" size={13} color={colors.brand.primary} />
                        <Text style={[styles.perkText, { color: colors.brand.dark }]}>Invite Members</Text>
                    </View>
                </View>
            </View>

            {/* ── Medallion shelf: every level at a glance, tap to inspect ── */}
            <Text style={styles.sectionLabel}>ALL LEVELS</Text>
            <View style={styles.shelf}>
                {TIERS.map((t: any, i: number) => {
                    const reached = tierIdx >= i;
                    const isSel = selLevel === i;
                    return (
                        <Pressable
                            key={t.name}
                            accessibilityRole="button"
                            accessibilityState={{ selected: isSel }}
                            onPress={() => setSelectedLevel(i)}
                            style={[styles.shelfItem, isSel && { borderColor: t.color, backgroundColor: t.bg }]}
                        >
                            <TrustBadge level={LEVEL_KEYS[i]} size={46} locked={!reached} />
                            <Text style={[styles.shelfName, { color: reached ? t.color : colors.text.muted }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{t.name}</Text>
                            <Text style={styles.shelfState} numberOfLines={1}>
                                {tierIdx === i ? "You're here" : reached ? 'Reached' : `${t.min} trust`}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>

            {/* ── Selected-level detail ── */}
            <View style={[styles.detailCard, { borderColor: sel.border }]}>
                <View style={styles.detailHeader}>
                    <TrustBadge level={LEVEL_KEYS[selLevel]} size={44} locked={!selReached} />
                    <View style={{ flex: 1 }}>
                        <Text style={[styles.detailName, { color: sel.color }]}>{sel.name}</Text>
                        <Text style={styles.shelfState}>Level {selLevel + 1} of {TIERS.length}</Text>
                    </View>
                    <View style={[styles.detailStatePill, { borderColor: sel.border, backgroundColor: selReached ? sel.bg : colors.surface.app }]}>
                        <Text style={[styles.detailStateText, { color: selReached ? sel.color : colors.text.muted }]}>
                            {selCurrent ? "You're here" : selReached ? 'Reached ✓' : '🔒 Locked'}
                        </Text>
                    </View>
                </View>

                <Text style={styles.detailBlurb}>{sel.blurb}</Text>

                {/* Credit floor — show YOUR actual floor when this is your tier; the tier entry floor otherwise */}
                <View style={styles.detailFloorRow}>
                    <MaterialCommunityIcons name="scale-balance" size={18} color={sel.color} />
                    <View style={{ flex: 1 }}>
                        <Text style={styles.detailFloorLabel}>
                            {selCurrent ? 'Your current floor' : selReached ? `Floor from this tier` : `Floor starts at`}
                        </Text>
                        {selCurrent && (
                            <Text style={{ fontSize: 10, color: colors.text.muted, marginTop: 1 }}>
                                Grows deeper as you trade more
                            </Text>
                        )}
                    </View>
                    <Text style={[styles.detailFloorVal, { color: sel.color }]}>
                        {selCurrent ? balanceState.floor : sel.floor}
                    </Text>
                </View>

                {sel.perks.map((p: string) => (
                    <View key={p} style={styles.detailPerkRow}>
                        <MaterialCommunityIcons name={selReached ? 'check-circle' : 'circle-outline'} size={15} color={selReached ? colors.brand.primary : colors.border.strong} />
                        <Text style={styles.detailPerkText}>{p}</Text>
                    </View>
                ))}

                {!selReached && selNeeded > 0 && (
                    <Text style={styles.detailNote}>Reach {sel.min} trust ({selNeeded} to go) from the real value you trade.</Text>
                )}
                <Text style={styles.detailNote}>Levels are merit badges — they don't gate any action. Anyone can invite. Anyone with a positive balance can send. Higher levels mean a deeper credit line and community recognition.</Text>
            </View>

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
                    <Text style={styles.pathGap}>{creditsToNext} trust to go</Text>
                    <Text style={styles.pathHint}>
                        Trust grows with the real value you trade. Trading with someone NEW counts fastest —
                        value with any one partner is capped, so a wide circle beats repeat trades with the same person.
                    </Text>
                    <View style={styles.pathRow}>
                        <View style={styles.pathOption}>
                            <Text style={[styles.pathNumber, { color: colors.brand.primary }]}>{Number.isFinite(valueToNext) ? `~${valueToNext}` : '—'}</Text>
                            <Text style={styles.pathLabel} numberOfLines={2}>beans of value to trade</Text>
                            <Text style={[styles.pathLeverTag, { color: colors.brand.primary }]}>the lever</Text>
                        </View>
                        <View style={styles.pathOption}>
                            <Text style={[styles.pathNumber, { color: palette.blue500 }]}>{partnersToNext || '—'}</Text>
                            <Text style={styles.pathLabel} numberOfLines={2}>new partners (roughly)</Text>
                        </View>
                    </View>
                </Pressable>
            )}

            {/* Achievement cards — the things that actually build trust: value traded, a diverse
                circle of partners, and your reputation (which scales the earned score). */}
            <Text style={styles.sectionLabel}>WHAT BUILDS YOUR TRUST</Text>
            <View style={styles.achieveRow}>
                {[
                    { icon: '💰', label: 'VALUE TRADED', big: `${qualifiedValue}`, foot: `+${earned} trust`, pct: Math.min(1, qualifiedValue / valueForEarned(1380)), color: colors.brand.primary, trackBg: theme === 'dark' ? 'rgba(34,197,94,0.15)' : palette.green50 },
                    { icon: '👥', label: 'PARTNERS', big: `${uniquePartners}`, foot: 'diverse = faster', pct: Math.min(1, uniquePartners / 20), color: palette.blue500, trackBg: theme === 'dark' ? 'rgba(59,130,246,0.15)' : palette.blue50 },
                    { icon: '⭐', label: 'RATING', big: reviewCount > 0 ? avgRating.toFixed(1) : '—', foot: reviewCount > 0 ? `${reviewCount} review${reviewCount === 1 ? '' : 's'}` : 'no reviews yet', pct: reviewCount > 0 ? avgRating / 5 : 1, color: palette.orange500, trackBg: theme === 'dark' ? 'rgba(249,115,22,0.15)' : palette.orange50 },
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
                        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.achieveCount, { color: a.color }]}>{a.big}</Text>
                        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.achieveLabel}>{a.label}</Text>
                        <View style={[styles.achieveBarBg, { backgroundColor: a.trackBg }]}>
                            <View style={[styles.achieveBarFill, { width: `${Math.min(100, a.pct * 100)}%`, backgroundColor: a.color }]} />
                        </View>
                        <Text style={styles.achieveFooter}>{a.foot}</Text>
                    </Pressable>
                ))}
            </View>

            <Text style={styles.formula}>💡 Trust is a saturating curve over the real value you trade — diverse trades climb fastest, and it levels off near the top so no one runs away. Gifts don't build trust.</Text>
        </ScrollView>
        );
    };

    // ─── Wallet Tab ───────────────────────────────────────────────────────────
    const renderActivityHeader = () => {
        const brackets = [{ m: 200, r: 0.0 }, { m: 300, r: 0.010 }, { m: 500, r: 0.015 }, { m: 1000, r: 0.020 }, { m: Infinity, r: 0.025 }];
        let rem = balanceState.balance, monthly = 0;
        for (const b of brackets) { if (rem <= 0) break; monthly += Math.min(rem, b.m) * b.r; rem -= b.m; }
        const amber = balanceState.balance > 1000;
        const now = new Date();
        const nextRun = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const daysUntil = Math.ceil((nextRun.getTime() - now.getTime()) / 86400000);
        const isPositive = balanceState.balance >= 0;
        const heroBg = isPositive
            ? (theme === 'dark' ? 'rgba(16,185,129,0.1)' : 'rgba(16,185,129,0.06)')
            : (theme === 'dark' ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.06)');
        const heroBorder = isPositive
            ? (theme === 'dark' ? 'rgba(16,185,129,0.4)' : 'rgba(16,185,129,0.3)')
            : (theme === 'dark' ? 'rgba(239,68,68,0.4)' : 'rgba(239,68,68,0.3)');

        return (
            <View>
                {/* ── Balance Hero ── */}
                <View style={[styles.walletHero, { backgroundColor: heroBg, borderColor: heroBorder }]}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="About your balance"
                        hitSlop={8}
                        style={styles.heroInfo}
                        onPress={() => setShowBalanceInfo(true)}
                    >
                        <MaterialCommunityIcons name="information-outline" size={18} color={colors.text.muted} />
                    </Pressable>

                    <Text style={styles.tierHeroLabel}>YOUR BALANCE</Text>
                    <CurrencyDisplay
                        asView
                        style={[styles.walletBigBalance, isPositive ? styles.pos : styles.neg]}
                        amount={`${isPositive ? '+' : ''}${balanceState.balance.toFixed(1)}`}
                    />
                    <Text style={styles.heroSub}>
                        ≈ {(Math.abs(balanceState.balance) / 40).toFixed(1)} hrs of value · Floor {balanceState.floor}
                    </Text>

                    {/* Key metrics strip */}
                    <View style={styles.walletMetricRow}>
                        <Pressable style={styles.walletMetric} accessibilityRole="button" onPress={() => setShowCommonsInfo(true)}>
                            <MaterialCommunityIcons name="sprout" size={14} color={theme === 'dark' ? palette.amber400 : palette.amber600} />
                            <CurrencyDisplay asView style={[styles.walletMetricVal, { color: theme === 'dark' ? palette.amber400 : palette.amber600 }]} amount={balanceState.commons.toFixed(1)} />
                            <Text style={styles.walletMetricLabel}>Commons ⓘ</Text>
                        </Pressable>
                        <View style={styles.walletMetricDivider} />
                        <View style={styles.walletMetric}>
                            <MaterialCommunityIcons name="scale-balance" size={14} color={colors.text.secondary} />
                            <Text style={styles.walletMetricVal}>{balanceState.floor}</Text>
                            <Text style={styles.walletMetricLabel}>Credit Floor</Text>
                        </View>
                        {escrowTotal > 0 && (
                            <>
                                <View style={styles.walletMetricDivider} />
                                <View style={styles.walletMetric}>
                                    <MaterialCommunityIcons name="lock-clock" size={14} color={palette.amber500} />
                                    <Text style={[styles.walletMetricVal, { color: palette.amber500 }]}>{escrowTotal.toFixed(1)}</Text>
                                    <Text style={styles.walletMetricLabel}>In Escrow</Text>
                                </View>
                            </>
                        )}
                    </View>
                </View>

                {/* ── Community Circulation ── */}
                {balanceState.balance > 0 && (
                    <Pressable style={[styles.circBox, amber && styles.circBoxAmber]} accessibilityRole="button" onPress={() => setShowCirculationInfo(true)}>
                        <View style={styles.circRow}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <MaterialCommunityIcons name="leaf" size={15} color={amber ? (theme === 'dark' ? palette.amber400 : palette.amber800) : colors.feedback.success.fg} />
                                <Text style={[styles.circLabel, amber && { color: theme === 'dark' ? palette.amber400 : palette.amber800 }]}>Community Circulation ⓘ</Text>
                            </View>
                            <CurrencyDisplay style={[styles.circRate, amber && { color: theme === 'dark' ? palette.amber400 : palette.amber800 }]} amount={monthly.toFixed(2)} />
                        </View>
                        <View style={styles.circRow}>
                            <Text style={{ fontSize: 11, fontWeight: '500', color: colors.text.muted }}>per month → commons pool</Text>
                            <Text style={[styles.circNextDate, { color: amber ? (theme === 'dark' ? palette.amber400 : palette.amber800) : colors.feedback.success.fg }]}>
                                {nextRun.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} · {daysUntil}d
                            </Text>
                        </View>
                        {amber && (
                            <Text style={{ color: theme === 'dark' ? palette.amber400 : palette.amber600, fontSize: 11, marginTop: 6, fontWeight: '600' }}>
                                ⚠️ Balance above 1000 — consider spending!
                            </Text>
                        )}
                    </Pressable>
                )}

                {/* ── Project Pledges ── */}
                {pledgeHistory.length > 0 && (
                    <View style={styles.pledgeSection}>
                        <Text style={styles.sectionLabel}>PROJECT PLEDGES</Text>
                        {pledgeHistory.map((pl: any) => (
                            <View key={pl.id} style={styles.pledgeRow}>
                                <View style={[styles.txnIcon, { backgroundColor: colors.brand.primary + '18' }]}>
                                    <MaterialCommunityIcons name="sprout" size={17} color={colors.brand.primary} />
                                </View>
                                <View style={{ flex: 1, marginLeft: 10 }}>
                                    <Text style={styles.pledgeName} numberOfLines={1}>{pl.projectTitle}</Text>
                                    <Text style={styles.pledgeDate}>{new Date(pl.timestamp).toLocaleDateString()}</Text>
                                </View>
                                <Text style={styles.pledgeAmt}>-{pl.amount} B</Text>
                            </View>
                        ))}
                    </View>
                )}

                {/* ── Send Credits ── */}
                <Pressable
                    style={[styles.sendBtn, showSend && styles.sendBtnOpen, !canSend && styles.sendBtnLocked]}
                    accessibilityRole="button"
                    onPress={showSend ? () => { setShowSend(false); setSendError(null); setSendSuccess(false); } : openSend}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                        <MaterialCommunityIcons
                            name={!canSend ? 'lock-outline' : showSend ? 'close' : 'send'}
                            size={17}
                            color={!canSend ? colors.text.secondary : colors.text.inverse}
                        />
                        <Text style={[styles.sendBtnText, !canSend && { color: colors.text.secondary }]}>
                            {!canSend ? 'Send Credits (needs positive balance)' : showSend ? 'Cancel' : 'Send Credits'}
                        </Text>
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
                                {/* Plain ScrollView — nested FlatList breaks vertical scroll on Android */}
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

            {/* ── Credit position — zero is the sweet spot. Un-vouched members have no credit line
                 yet (floor 0), so show a plain-language "get vouched" prompt instead of the bar. ── */}
            {balanceState.activated === false ? (
                <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, backgroundColor: colors.surface.card, borderBottomWidth: 1, borderBottomColor: colors.border.default }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: palette.green50, borderWidth: 1, borderColor: palette.green200, borderRadius: 12, padding: 12 }}>
                        <Text style={{ fontSize: 20 }}>🌱</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 14, fontWeight: '800', color: colors.brand.dark }}>No credit line yet</Text>
                            <Text style={{ fontSize: 12.5, color: colors.text.body, lineHeight: 18, marginTop: 2 }}>
                                You can trade right now with the beans you hold. Complete your first trade and your credit line opens automatically — the more value you trade, the deeper it grows. (A community voucher can also give you a starter line.)
                            </Text>
                        </View>
                    </View>
                </View>
            ) : (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Credit position — tap to learn how it works"
                    onPress={() => setShowSliderInfo(true)}
                    style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, backgroundColor: colors.surface.card, borderBottomWidth: 1, borderBottomColor: colors.border.default }}
                >
                    {/* The bar itself now carries the offer ladder (locked zone, rungs, unlock caption). */}
                    <CreditBar balance={balanceState.balance} floor={balanceState.floor} colors={colors} usableFloor={balanceState.usableFloor} liveOffers={balanceState.liveOffers} />
                    {/* Frozen is the one state the ladder can't fully convey — call it out explicitly. */}
                    {balanceState.frozen && (
                        <Text style={{ fontSize: 11.5, color: '#d97706', lineHeight: 16, marginTop: 8 }}>
                            ⚠️  Spending paused — your balance is below what your {balanceState.liveOffers ?? 0} active offer{(balanceState.liveOffers ?? 0) === 1 ? '' : 's'} unlock (−{Math.abs(balanceState.usableFloor ?? balanceState.floor)}). Post an Offer or trade back up to lift it. You can still receive and sell.
                        </Text>
                    )}
                </Pressable>
            )}

            {/* ── Tab bar ── */}
            <View style={styles.tabBar}>
                <Pressable style={[styles.tab, activeTab === 'trust' && [styles.tabActive, { borderBottomColor: tier.color }]]} accessibilityRole="button" accessibilityState={{ selected: activeTab === 'trust' }} onPress={() => setActiveTab('trust')}>
                    <MaterialCommunityIcons name="shield-star-outline" size={15} color={activeTab === 'trust' ? tier.color : colors.text.muted} />
                    <Text style={[styles.tabText, activeTab === 'trust' && { color: tier.color, fontWeight: '800' }]}>Levels</Text>
                </Pressable>
                <Pressable style={[styles.tab, activeTab === 'financials' && styles.tabActive]} accessibilityRole="button" accessibilityState={{ selected: activeTab === 'financials' }} onPress={() => setActiveTab('financials')}>
                    <MaterialCommunityIcons name="swap-horizontal" size={15} color={activeTab === 'financials' ? colors.brand.primary : colors.text.muted} />
                    <Text style={[styles.tabText, activeTab === 'financials' && { color: colors.brand.primary, fontWeight: '800' }]}>Wallet</Text>
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
