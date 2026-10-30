import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Image, Pressable, ScrollView, ActivityIndicator, Alert, DeviceEventEmitter } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { MemberAvatar } from '../components/MemberAvatar';
import { getMemberProfile, getMemberRatings, getMemberPosts, getBalance, getRatingsGiven, getFriendsLocal, isFriendLocal, addFriendLocal, removeFriendLocal, createConversationApi, getTrustProfile, vouchMember, updateMemberProfile } from '../utils/db';
import { blockUser, unblockUser, isUserBlocked, BLOCKLIST_UPDATED_EVENT } from '../utils/blocklist';
import { useIdentity } from './IdentityContext';
import { ReviewModal } from '../components/ReviewModal';
import { ArchetypeQuizModal } from '../components/ArchetypeQuizModal';
import { parseArchetype, calculateSynergy, ARCHETYPES, listPhotoUrl, type QuizResult, type PublicCreatorChannel } from '@beanpool/core';
import { getCanonicalProfile } from '../utils/canonical-profile';
import { ChannelChips } from '../components/ChannelChips';
import { fetchPublicChannels } from '../utils/channels';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildSignedHeaders } from '../utils/crypto';
import { palette } from '../constants/colors';
import { useTheme, useStyles } from './ThemeContext';
import { HIDDEN_AUTHOR, isHiddenAuthor } from '../utils/posts-view';
import { useNodeProfile } from '../utils/use-node-profile';
import { useOwnProfile } from '../utils/use-own-profile';
import { cardNeedsFetch, fetchCardByKey } from '../utils/members-lookup';
import { useShowcaseMode } from '../utils/use-reader-features';
import { readsOwn } from '../utils/reads-own';
import { LocalCommunityMark } from '../components/showcase/LocalCommunityMark';
import { LOCAL_COMMUNITY_LINES, formatDate, formatNumber, t, tn, type TierName } from '@beanpool/core';
import { beansOn, membersByKey } from '../utils/node-profile';
import { enterprisesOn } from '../utils/commons-sections';
import { meetingTips } from '../utils/market-global';
import { TIER_WORDS } from '../utils/trust-tier';
import { Sentence } from '../components/Sentence';
import { signedRequestWords } from '../components/signed-request-lines';



/** A day through core's formatDate ("3 Oct 2026"), in the member's language; '' for none or a date that can't be read. */
const fmtDay = (iso?: string | null, caps = false): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return formatDate(d, 'day-month-year', { caps });
};

/** A month and year through core's formatDate ("Oct 2026"), in the member's language; '' for none or a date that can't be read. */
const fmtMonthYear = (iso?: string | null, caps = false): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return formatDate(d, 'month-year', { caps });
};

const fmtLastActive = (iso?: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (days <= 0) return t('Active today');
    if (days === 1) return t('Active yesterday');
    if (days < 7) return tn(days, 'Active {n}d ago', 'Active {n}d ago');
    if (days < 30) return tn(Math.floor(days / 7), 'Active {n}w ago', 'Active {n}w ago');
    return t('Active {date}', { date: fmtDay(iso) });
};

/** A tier the node names (Newcomer, Resident, Steward, Elder) in the member's language; one this build doesn't know as the node wrote it. */
const tierWords = (name?: string | null): string => (name && Object.prototype.hasOwnProperty.call(TIER_WORDS, name) ? t(TIER_WORDS[name as TierName]) : name ?? '');

export default function PublicProfileScreen() {
    const { publicKey, callsign } = useLocalSearchParams<{ publicKey?: string | string[]; callsign?: string | string[] }>();
    const { identity } = useIdentity();
    const { theme, colors } = useTheme();
    const RISK_BAND = React.useMemo<Record<string, { bg: string; border: string; text: string; emoji: string }>>(() => ({
        green: { bg: colors.feedback.success.bg, border: colors.feedback.success.border, text: colors.feedback.success.fg, emoji: '🟢' },
        yellow: { bg: colors.feedback.warning.bg, border: colors.feedback.warning.border, text: colors.feedback.warning.fg, emoji: '🟡' },
        red: { bg: colors.feedback.danger.bg, border: colors.feedback.danger.border, text: colors.feedback.danger.fg, emoji: '🔴' },
    }), [colors]);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },

        header: {
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.surface.card,
            borderBottomWidth: 1, borderBottomColor: colors.border.default,
        },
        backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingRight: 8 },
        backText: { color: colors.text.body, fontSize: 20, fontWeight: 'bold' },
        backTextLabel: { color: colors.text.body, fontSize: 16, fontWeight: 'bold', marginLeft: 4 },
        headerTitle: { color: colors.text.heading, fontSize: 17, fontWeight: '800' },

        scrollContent: { paddingBottom: 48 },

        // Banner
        banner: {
            alignItems: 'center', paddingVertical: 28, paddingHorizontal: 24,
            backgroundColor: colors.surface.card, borderBottomWidth: 1, borderBottomColor: colors.border.default,
        },
        avatarRing: {
            width: 88, height: 88, borderRadius: 44, borderWidth: 3, borderColor: colors.brand.primary,
            overflow: 'hidden', marginBottom: 14,
            shadowColor: colors.brand.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 8, elevation: 4,
        },
        nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
        callsignText: { fontSize: 24, fontWeight: '800', color: colors.text.heading },
        pubkeyText: {
            fontSize: 12, color: colors.text.muted, fontFamily: 'Courier',
            backgroundColor: colors.surface.subtle, paddingHorizontal: 8, paddingVertical: 3,
            borderRadius: 6, marginBottom: 4, overflow: 'hidden',
        },
        bioText: { marginTop: 10, fontSize: 14, color: colors.text.secondary, fontStyle: 'italic', textAlign: 'center', lineHeight: 20 },
        joinedText: { fontSize: 12, color: colors.text.muted, fontWeight: '600', marginTop: 6 },
        // The way on when no card is held offline: read at 4.5:1 in both schemes, unlike the muted lines around it.
        unreachableText: { fontSize: 13, color: colors.text.secondary, fontWeight: '600', marginTop: 6, textAlign: 'center' },

        // Profile top actions (other members)
        actionRow: {
            flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
            gap: 10, marginHorizontal: 16, marginTop: 16,
        },
        messageBtn: {
            flexGrow: 1, flexBasis: 180, minHeight: 48,
            backgroundColor: colors.brand.fill, borderRadius: 12,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            paddingHorizontal: 16, paddingVertical: 12,
            shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 3, elevation: 2,
        },
        messageBtnText: {
            fontSize: 15, fontWeight: '800', color: colors.text.inverse, flexShrink: 1,
        },
        friendToggleBtn: {
            flexGrow: 1, flexBasis: 120, minHeight: 48,
            backgroundColor: colors.surface.card, borderRadius: 12,
            borderWidth: 1, borderColor: colors.border.strong,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            paddingHorizontal: 16, paddingVertical: 12,
        },
        friendToggleBtnActive: {
            backgroundColor: colors.surface.subtle, borderColor: colors.border.default,
        },
        friendToggleBtnText: {
            fontSize: 14, fontWeight: '700', color: colors.text.heading, flexShrink: 1,
        },
        friendToggleBtnTextActive: {
            color: colors.brand.primary,
        },
        blockedRow: {
            marginHorizontal: 16, marginTop: 16, padding: 14, borderRadius: 14,
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.red50,
            borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.red200,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
        },
        blockedEmoji: {
            fontSize: 16,
        },
        blockedText: {
            fontSize: 14, fontWeight: '600', color: colors.feedback.danger.fg, flexShrink: 1,
        },
        unblockBtn: {
            minHeight: 44, minWidth: 44, paddingHorizontal: 14, paddingVertical: 8,
            borderRadius: 8, backgroundColor: colors.surface.card,
            borderWidth: 1, borderColor: colors.border.strong,
            alignItems: 'center', justifyContent: 'center',
        },
        unblockBtnText: {
            fontSize: 13, fontWeight: '700', color: colors.text.heading,
        },

        // Quick stats strip (self)
        statStrip: { flexDirection: 'row', backgroundColor: colors.surface.card, marginHorizontal: 16, marginTop: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, paddingVertical: 14, alignItems: 'center' },
        statTile: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
        statTileNum: { fontSize: 20, fontWeight: '900', color: colors.text.heading },
        statTileLabel: { fontSize: 11, fontWeight: '700', color: colors.text.muted, marginTop: 2 },
        statDivider: { width: 1, alignSelf: 'stretch', backgroundColor: colors.border.default, marginVertical: 4 },

        // Trust & safety (other members)
        safetyBanner: { marginHorizontal: 16, marginTop: 16, padding: 14, borderRadius: 14, borderWidth: 1 },
        safetyHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
        safetyEmoji: { fontSize: 16, marginRight: 8 },
        safetyHeadline: { fontSize: 16, fontWeight: '800', flexShrink: 1 },
        safetyReason: { fontSize: 13, color: colors.text.secondary, lineHeight: 19, marginTop: 1 },
        safetyTips: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border.default },
        safetyTip: { fontSize: 13, color: colors.feedback.danger.fg, fontWeight: '600', lineHeight: 20 },

        trustSignalCard: {
            flexDirection: 'row', alignItems: 'center', gap: 12,
            backgroundColor: colors.surface.card, marginHorizontal: 16, marginTop: 12, padding: 14,
            borderRadius: 14, borderWidth: 1, borderColor: colors.border.default,
        },

        mutualCard: {
            backgroundColor: colors.surface.card, marginHorizontal: 16, marginTop: 12, padding: 14,
            borderRadius: 14, borderWidth: 1, borderColor: colors.border.default,
        },
        mutualTitle: { fontSize: 13, fontWeight: '800', color: colors.text.heading, marginBottom: 10 },
        mutualRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
        mutualName: { fontSize: 14, fontWeight: '700', color: colors.text.heading, flex: 1 },
        mutualAsk: { fontSize: 12, fontWeight: '700', color: colors.brand.primary, flexShrink: 0 },

        vouchCard: {
            backgroundColor: colors.surface.app, marginHorizontal: 16, marginTop: 12, padding: 14,
            borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, gap: 6,
        },
        vouchLine: { fontSize: 13, color: colors.text.body, fontWeight: '600', lineHeight: 19 },
        vouchInviterRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
        vouchInviterName: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        vouchInviterSub: { fontSize: 12, color: colors.text.secondary, fontWeight: '600', marginTop: 1 },
        systemBadge: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.brand.tint, alignItems: 'center', justifyContent: 'center' },

        // Synergy & Collaboration
        synergyCard: {
            backgroundColor: colors.surface.card,
            marginHorizontal: 16,
            marginTop: 12,
            padding: 16,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: colors.border.default,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.03,
            shadowRadius: 4,
            elevation: 1,
        },
        synergyHeaderRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 8,
        },
        synergyEmoji: {
            fontSize: 26,
            marginRight: 10,
        },
        synergyTitle: {
            fontSize: 14,
            fontWeight: '800',
            color: colors.brand.primary,
        },
        synergyHeadline: {
            fontSize: 15,
            fontWeight: '800',
            color: colors.text.heading,
            marginTop: 1,
        },
        synergySummary: {
            fontSize: 13,
            lineHeight: 19,
            color: colors.text.body,
            marginBottom: 12,
        },
        synergyStrengthsWrap: {
            gap: 6,
            marginBottom: 12,
        },
        synergyStrengthRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
        },
        synergyBullet: {
            fontSize: 12,
            fontWeight: '900',
            color: colors.brand.primary,
            marginRight: 6,
            marginTop: 1,
        },
        synergyStrengthText: {
            flex: 1,
            fontSize: 12,
            lineHeight: 17,
            color: colors.text.secondary,
        },
        synergyTipBox: {
            backgroundColor: colors.surface.subtle,
            padding: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        synergyTipText: {
            fontSize: 12,
            lineHeight: 17,
            color: colors.text.secondary,
        },
        synergyInviteCard: {
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.green50,
            marginHorizontal: 16,
            marginTop: 12,
            padding: 16,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: theme === 'dark' ? colors.border.default : palette.green100,
        },
        synergyInviteTitle: {
            fontSize: 14,
            fontWeight: '800',
            color: colors.text.heading,
        },
        synergyInviteDesc: {
            fontSize: 12,
            lineHeight: 18,
            color: colors.text.secondary,
            marginBottom: 12,
        },
        synergyTakeQuizBtn: {
            backgroundColor: colors.brand.fill,
            paddingVertical: 10,
            paddingHorizontal: 16,
            borderRadius: 10,
            alignSelf: 'flex-start',
        },
        synergyRetakeBtn: {
            paddingVertical: 10,
            paddingHorizontal: 16,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        quizBtnRow: {
            flexDirection: 'row',
            gap: 8,
            marginTop: 4,
        },
        quizBtnFlex: {
            flex: 1,
            alignSelf: 'auto',
            alignItems: 'center',
            justifyContent: 'center',
        },
        synergyRetakeBtnText: {
            color: colors.text.secondary,
            fontWeight: '700',
            fontSize: 13,
        },
        synergyTakeQuizBtnText: {
            color: colors.text.inverse,
            fontSize: 13,
            fontWeight: '800',
        },

        // Stats
        statsGrid: { flexDirection: 'row', padding: 16, gap: 10, backgroundColor: colors.surface.card, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        statBoxOverall: {
            flex: 1, backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default,
            borderRadius: 14, padding: 12, alignItems: 'center',
        },
        statBoxProvider: {
            flex: 1, backgroundColor: theme === 'dark' ? colors.brand.tint : palette.green50, borderWidth: 1, borderColor: theme === 'dark' ? colors.brand.primary : palette.green200,
            borderRadius: 14, padding: 12, alignItems: 'center',
        },
        statBoxReceiver: {
            flex: 1, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.indigo50, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.indigo200,
            borderRadius: 14, padding: 12, alignItems: 'center',
        },
        starRating: { fontSize: 13, color: colors.trust.star, marginBottom: 4, letterSpacing: -1 },
        statValueOverall: { fontSize: 18, fontWeight: '800', color: colors.text.heading, marginBottom: 2 },
        // The stat labels, the role badges and the review dates keep their capitals in the words (and formatDate's caps), never
        // a textTransform: that upper-cases a translation by the phone's rules, not the language's (Turkish i).
        statLabelOverall: { fontSize: 9, fontWeight: '700', color: colors.text.muted, letterSpacing: 0.5 },
        statValueProvider: { fontSize: 18, fontWeight: '800', color: colors.brand.primary, marginBottom: 2, marginTop: 4 },
        statLabelProvider: { fontSize: 9, fontWeight: '700', color: colors.brand.primary, letterSpacing: 0.5 },
        statValueReceiver: { fontSize: 18, fontWeight: '800', color: theme === 'dark' ? colors.text.heading : palette.indigo500, marginBottom: 2, marginTop: 4 },
        statLabelReceiver: { fontSize: 9, fontWeight: '700', color: theme === 'dark' ? colors.text.secondary : palette.indigo500, letterSpacing: 0.5 },

        // Tabs
        tabBar: {
            flexDirection: 'row', backgroundColor: colors.surface.card,
            borderBottomWidth: 1, borderBottomColor: colors.border.default, paddingHorizontal: 16,
        },
        tab: { flex: 1, paddingVertical: 14, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
        tabActive: { borderBottomColor: colors.brand.primary },
        tabText: { fontSize: 14, fontWeight: '600', color: colors.text.muted },
        tabTextActive: { color: colors.brand.primary, fontWeight: '800' },
        tabContent: { padding: 16 },

        // Empty
        emptyCard: {
            backgroundColor: colors.surface.card, padding: 32, borderRadius: 14, alignItems: 'center',
            borderWidth: 1, borderColor: colors.border.default,
        },
        emptyIcon: { fontSize: 32, opacity: 0.4, marginBottom: 8 },
        emptyText: { color: colors.text.muted, fontWeight: '600', fontSize: 14 },

        // Deal cards
        dealCard: {
            backgroundColor: colors.surface.card, borderRadius: 14, padding: 12,
            marginBottom: 10, borderWidth: 1, borderColor: colors.border.default,
            shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
        },
        dealThumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: colors.surface.subtle },
        dealThumbFallback: { alignItems: 'center', justifyContent: 'center' },
        dealTitle: { fontSize: 15, fontWeight: '800', color: colors.text.heading, marginBottom: 2 },
        dealDateText: { fontSize: 12, fontWeight: '600', color: colors.text.muted },
        creditAmount: { fontWeight: '900', fontSize: 15, color: colors.accent.primary },
        beanIcon: { width: 14, height: 14, marginLeft: 2, resizeMode: 'contain' },
        typeBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5 },
        badgeOffer: { backgroundColor: colors.brand.fill },
        badgeNeed: { backgroundColor: colors.action.fab },
        typeBadgeText: { fontSize: 10, fontWeight: '800', color: colors.text.inverse, letterSpacing: 0.5 },

        // Review cards
        reviewCard: {
            backgroundColor: colors.surface.card, padding: 16, borderRadius: 14,
            borderWidth: 1, borderColor: colors.border.default, marginBottom: 10,
            shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
        },
        reviewHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
        starText: { fontSize: 14, color: colors.trust.star, letterSpacing: -1 },
        roleBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 },
        roleBadgeProvider: { backgroundColor: colors.profile.roleProviderBg },
        roleBadgeReceiver: { backgroundColor: colors.profile.roleReceiverBg },
        roleText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.3 },
        roleTextProvider: { color: colors.brand.primary },
        roleTextReceiver: { color: theme === 'dark' ? palette.indigo300 : palette.indigo600 },
        dateText: { fontSize: 10, fontWeight: '700', color: colors.text.muted, letterSpacing: 0.3, flexShrink: 0, marginLeft: 8 },
        commentText: {
            fontSize: 14, color: colors.text.body, fontStyle: 'italic', lineHeight: 20,
            backgroundColor: colors.surface.subtle, padding: 12, borderRadius: 8,
        },
        noCommentText: { fontSize: 13, color: colors.text.muted, fontStyle: 'italic' },

        // Edit button (self)
        editBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: theme === 'dark' ? colors.brand.primary : palette.emerald200, backgroundColor: theme === 'dark' ? colors.brand.tint : palette.green50 },
        editBtnText: { color: colors.brand.primary, fontSize: 14, fontWeight: '800' },

        // Trust summary card (self) → links to Ledger
        trustCard: {
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            backgroundColor: colors.surface.card, marginHorizontal: 16, marginTop: 16, padding: 14,
            borderRadius: 14, borderWidth: 1, borderColor: colors.border.default,
            shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
        },
        trustLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
        trustEmoji: { fontSize: 30 },
        trustTierName: { fontSize: 17, fontWeight: '800', color: colors.text.heading },
        trustSub: { fontSize: 11, fontWeight: '600', color: colors.text.muted, marginTop: 1 },
        trustRight: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 8 },
        trustBalance: { fontSize: 16, fontWeight: '900', color: colors.brand.primary },

        // Given reviews
        givenName: { fontSize: 14, fontWeight: '800', color: colors.text.heading, flexShrink: 1 },
        editReviewBtn: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.surface.subtle,
            borderColor: colors.border.strong,
            borderWidth: 1,
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 8,
        },
        editReviewBtnText: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: '700',
        },
    }));

    const [profile, setProfile] = useState<any>(null);
    const [ratings, setRatings] = useState<any[]>([]);
    const [stats, setStats] = useState<any>(null);
    const [activePosts, setActivePosts] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [ratingsLoading, setRatingsLoading] = useState(true);
    const [trustLoading, setTrustLoading] = useState(false);
    const [givenLoading, setGivenLoading] = useState(false);
    const [activeTab, setActiveTab] = useState<'listings' | 'reviews' | 'given'>('listings');
    const [balanceInfo, setBalanceInfo] = useState<any>(null);
    // On a community with Beans off (the worldwide one) there is no balance to sum up and no Ledger tab to open, and
    // a listing has no price: the card and the figures are not drawn.
    const nodeProfile = useNodeProfile();
    const showsBeans = beansOn(nodeProfile?.features);
    // Where the node previews Beans, the trust card's slot says where badges and Beans are earned (design §1 row 9).
    const beansPreview = useShowcaseMode('beans') === 'preview';
    const [given, setGiven] = useState<any[]>([]);
    const [friendsCount, setFriendsCount] = useState(0);
    const [trust, setTrust] = useState<any>(null);
    /** The key whose trust profile the node has answered (or failed to): until then, what the key is isn't known. */
    const [trustFor, setTrustFor] = useState<string | null>(null);
    const [viewerBalance, setViewerBalance] = useState<any>(null);
    const [vouching, setVouching] = useState(false);
    const [editingReview, setEditingReview] = useState<any | null>(null);
    const [viewerProfile, setViewerProfile] = useState<any>(null);
    const [showQuizModal, setShowQuizModal] = useState(false);
    const [quizInitialMode, setQuizInitialMode] = useState<'quick' | 'deep'>('quick');
    const [channels, setChannels] = useState<PublicCreatorChannel[]>([]);

    const pubKeyStr = Array.isArray(publicKey) ? publicKey[0] : publicKey;
    const isSelf = !!identity?.publicKey && identity.publicKey === pubKeyStr;
    // Your own name and picture are this community's row (utils/use-own-profile.ts), once read: never the name the door
    // passed, nor the phone-wide one, which can be another community's (DESIGN-per-community-profile-fable.md §2). For
    // your own key the door's name is ignored altogether (Profile S2), so a name passed from a screen that read it
    // before a switch, or from the phone-wide one, can never be the title.
    const own = useOwnProfile();
    const ownShown = isSelf && own.read;
    // On a community that says `membersOnDemand` this phone may hold no card for the member: it is fetched by key when
    // missing or a day old (utils/members-lookup.ts). Offline with none held, the profile says so, and the name is never
    // a blank (DESIGN-global-members-by-area §2.4): the name the caller passed, the card's, or the key's first 8 characters.
    // Your own, once the row is read: the row's name, or the card's, or the key's first 8 characters where this community
    // holds no name for you yet (nothing is drawn for a moment before the row is read, rather than another community's).
    const membersOnDemand = membersByKey(nodeProfile?.features);
    const passedName = Array.isArray(callsign) ? callsign[0] : callsign;
    const callsignStr = isSelf
        ? (ownShown ? own.callsign || profile?.callsign || pubKeyStr?.slice(0, 8) : undefined)
        : passedName || (membersOnDemand ? profile?.callsign || pubKeyStr?.slice(0, 8) : undefined);
    const [cardUnreachable, setCardUnreachable] = useState(false);

    useEffect(() => {
        if (identity?.publicKey) {
            getMemberProfile(identity.publicKey).then(async vp => {
                const canonical = await getCanonicalProfile().catch(() => null);
                if (vp) {
                    // Backfill the bio, contact and archetype from canonical, not just archetype.
                    // handleQuizComplete rebuilds the whole profile row from viewerProfile —
                    // `bio: … || ''` — and updateMemberProfile mirrors that straight back into
                    // canonical storage, which merges on `!== undefined`. So '' and null both count
                    // as present and overwrite. On a node where the local row hasn't synced yet,
                    // taking the quiz here wiped the user's canonical bio and contact device-wide.
                    // Filling the gaps on mount is what stops that.
                    // NEVER the picture (Profile S2): the quiz writes viewerProfile into THIS community's row,
                    // so a photo or preset chosen in another community was written into it as its own. An
                    // empty photo is safe without it: updateMemberProfile keeps the row's by COALESCE and
                    // mirrors a null photo into canonical as "unchanged".
                    if (!vp.bio && canonical?.bio) vp.bio = canonical.bio;
                    if (!vp.contact_value && canonical?.contactValue) vp.contact_value = canonical.contactValue;
                    if (!vp.contact_visibility && canonical?.contactVisibility) vp.contact_visibility = canonical.contactVisibility;
                    if (!vp.archetype && canonical?.archetype) vp.archetype = canonical.archetype;
                    setViewerProfile(vp);
                } else if (canonical) {
                    setViewerProfile({
                        public_key: identity.publicKey,
                        callsign: identity.callsign,
                        bio: canonical.bio,
                        contact_value: canonical.contactValue,
                        contact_visibility: canonical.contactVisibility,
                        archetype: canonical.archetype,
                    });
                }
            }).catch(() => null);
        }
    }, [identity?.publicKey]);

    const handleQuizComplete = async (quizResult: QuizResult) => {
        if (!identity) return;
        const jsonStr = JSON.stringify(quizResult);
        setViewerProfile((prev: any) => ({ ...(prev || {}), archetype: jsonStr }));

        const publicArchetype = JSON.stringify({
            primary: quizResult.primary,
            secondary: quizResult.secondary,
            mode: quizResult.mode,
            updatedAt: quizResult.updatedAt,
        });

        const localUpdate: any = {
            callsign: identity.callsign || viewerProfile?.callsign || '',
            avatar_url: viewerProfile?.avatar_url || null,
            bio: viewerProfile?.bio || '',
            contact_value: viewerProfile?.contact_value || '',
            contact_visibility: viewerProfile?.contact_visibility || 'hidden',
            archetype: jsonStr,
        };
        await updateMemberProfile(identity.publicKey, localUpdate);
        if (isSelf) {
            setProfile((prev: any) => ({ ...(prev || {}), archetype: jsonStr }));
        }

        try {
            const url = await AsyncStorage.getItem('beanpool_anchor_url');
            if (url) {
                const payloadObj: any = {
                    publicKey: identity.publicKey,
                    callsign: identity.callsign || '',
                    archetype: publicArchetype,
                };
                const bodyString = JSON.stringify(payloadObj);
                const headers = await buildSignedHeaders('POST', `${url}/api/profile/update`, bodyString, identity.privateKey, identity.publicKey);
                await fetch(`${url}/api/profile/update`, {
                    method: 'POST',
                    headers,
                    body: bodyString,
                });
            }
        } catch (e) {
            console.warn('[Archetype] Profile push best effort:', e);
        }
    };

    useEffect(() => {
        let cancelled = false;
        // No key, or a visitors' view's `'hidden'` author (utils/posts-view.ts; the map's callout still links
        // here for one): nobody to ask the node about.
        if (!pubKeyStr || isHiddenAuthor(pubKeyStr)) {
            setLoading(false);
            setRatingsLoading(false);
            setTrustLoading(false);
            setGivenLoading(false);
            setChannels([]);
            return;
        }

        // Fetch syndicated creator channels (The Pulse, Phase 1). Clear first, so tapping
        // from one member to another never shows the previous member's chips, and drop a
        // reply that lands after we have navigated on.
        setChannels([]);
        fetchPublicChannels(pubKeyStr)
            .then(list => { if (!cancelled) setChannels(list); })
            .catch(() => { if (!cancelled) setChannels([]); });

        // 1. Load local first-class database items instantly
        setLoading(true);
        Promise.all([
            getMemberProfile(pubKeyStr).catch(() => null),
            getMemberPosts(pubKeyStr).catch(() => []),
            // The reader's own balance (the trust card) is Beans: never asked where they are in preview (utils/reads-own.ts).
            isSelf ? readsOwn('beans', pubKeyStr).then(reads => (reads ? getBalance(pubKeyStr) : null)).catch(() => null) : Promise.resolve(null),
            isSelf ? getFriendsLocal(pubKeyStr).catch(() => []) : Promise.resolve([]),
        ]).then(([prof, posts, bal, friends]) => {
            // Never over a card the fetch by key (below) has already brought fresher.
            if (prof) setProfile((cur: any) => (cur?.public_key === prof.public_key && (cur?.card_fetched_at ?? '') > (prof.card_fetched_at ?? '') ? cur : prof));
            if (posts) setActivePosts(posts);
            if (bal) setBalanceInfo(bal);
            if (Array.isArray(friends)) {
                setFriendsCount(friends.length);
            }
            setLoading(false);
        });

        // 2. Load ratings asynchronously in the background
        setRatingsLoading(true);
        getMemberRatings(pubKeyStr)
            .then(rat => {
                if (rat) {
                    setStats({ average: rat.average, count: rat.count, asProvider: rat.asProvider, asReceiver: rat.asReceiver });
                    setRatings(rat.ratings || []);
                }
            })
            .catch(() => null)
            .finally(() => setRatingsLoading(false));

        // 3. Load trust profile asynchronously in the background (if not self)
        if (!isSelf) {
            setTrustLoading(true);
            // A late answer for a key the screen has left never lands on the next one (it would stand for it, or leave
            // the next key waiting on an answer already in).
            const asked = pubKeyStr;
            getTrustProfile(asked)
                .then(trustProfile => {
                    if (!cancelled && trustProfile) setTrust(trustProfile);
                })
                .catch(() => null)
                .finally(() => {
                    if (cancelled) return;
                    setTrustLoading(false);
                    setTrustFor(asked);
                });

            // The reader's own balance (the vouch button's): never asked where Beans are in preview (utils/reads-own.ts).
            if (identity?.publicKey) {
                const viewer = identity.publicKey;
                readsOwn('beans', viewer)
                    .then(reads => (reads ? getBalance(viewer) : null))
                    .then(viewerBal => {
                        if (viewerBal) setViewerBalance(viewerBal);
                    })
                    .catch(() => null);
            }
        } else {
            setTrustLoading(false);
            setTrust(null);
        }

        // 4. Load given ratings asynchronously in the background (if self)
        if (isSelf) {
            setGivenLoading(true);
            getRatingsGiven(pubKeyStr)
                .then(givenRatings => {
                    if (givenRatings) setGiven(givenRatings);
                })
                .catch(() => null)
                .finally(() => setGivenLoading(false));
        } else {
            setGivenLoading(false);
            setGiven([]);
        }
        return () => { cancelled = true; };
    }, [pubKeyStr, isSelf, identity?.publicKey]);

    // On a community that says `membersOnDemand`: the card by key when none is held or it is a day old. Its own effect:
    // the node profile (useNodeProfile) is known a moment after the screen mounts, and as a dependency of the reads above
    // it asked the node for the ratings and the trust profile twice on every open (review of #1859, NB5).
    useEffect(() => {
        setCardUnreachable(false);
        if (!membersOnDemand || !pubKeyStr || isHiddenAuthor(pubKeyStr)) return;
        let cancelled = false;
        getMemberProfile(pubKeyStr).catch(() => null).then(prof => {
            if (cancelled || !cardNeedsFetch(prof, Date.now())) return;
            fetchCardByKey(pubKeyStr).then(async got => {
                if (cancelled) return;
                if (got === 'fetched') {
                    const fresh = await getMemberProfile(pubKeyStr).catch(() => null);
                    if (!cancelled && fresh) setProfile(fresh);
                }
                setCardUnreachable(got === 'unreachable' && !prof);
            });
        });
        return () => { cancelled = true; };
    }, [pubKeyStr, membersOnDemand]);

    const renderStars = (avg: number) => {
        const rounded = Math.round(avg || 0);
        return '★'.repeat(rounded) + '☆'.repeat(5 - rounded);
    };

    // Vouch: an appointed voucher (admin-granted can_vouch capability) can vouch for anyone.
    // A vouch hands out the -20-style credit floor at the chosen level, lifting the newcomer's
    // no-overdraft gate. Gated on the viewer's server-provided canVouch — NOT their tier.
    const viewerCanVouch = !!(isSelf ? balanceInfo : viewerBalance)?.canVouch;
    const canVouch = !isSelf && viewerCanVouch && !trust?.elderVouch;

    const handleVouch = async (level: 1 | 2 | 3) => {
        if (vouching || !pubKeyStr) return;
        setVouching(true);
        try {
            await vouchMember(pubKeyStr, level);
            const fresh = await getTrustProfile(pubKeyStr).catch(() => null);
            if (fresh) setTrust(fresh);
            // With no name of the voucher's own, the badge says "Vouched by a sponsor" (as it always has) in its own words.
            else setTrust((cur: any) => cur ? { ...cur, elderVouch: identity?.callsign ? { callsign: identity.callsign } : { sponsor: true } } : cur);
        } catch (e: any) {
            // The node's own words as it sent them (slice S4); the phone's own (utils/db.ts _signedRequest) in the member's language.
            Alert.alert(t('Could not vouch'), e?.message ? signedRequestWords(e.message) : t('Please try again.'));
        } finally {
            setVouching(false);
        }
    };

    // Let the voucher choose how much of a credit line to extend (their call on confidence).
    const chooseVouchLevel = () => {
        if (vouching || !pubKeyStr) return;
        Alert.alert(
            profile?.callsign ? t('Vouch for {name}', { name: profile.callsign }) : t('Vouch for this member'),
            t("Choose how deep a credit line to extend. This lets them trade on credit down to that floor — it reflects your confidence in them. No beans leave your wallet."),
            [
                { text: t('Light · −{n}', { n: 25 }), onPress: () => handleVouch(1) },
                { text: t('Standard · −{n}', { n: 50 }), onPress: () => handleVouch(2) },
                { text: t('Deep · −{n}', { n: 100 }), onPress: () => handleVouch(3) },
                { text: t('Cancel'), style: 'cancel' },
            ]
        );
    };

    const [isBlocking, setIsBlocking] = useState(false);
    const [isBlocked, setIsBlocked] = useState(false);
    const [isFriend, setIsFriend] = useState(false);
    const [isMessaging, setIsMessaging] = useState(false);
    const [togglingFriend, setTogglingFriend] = useState(false);

    useEffect(() => {
        let sub: any;
        if (pubKeyStr) {
            isUserBlocked(pubKeyStr).then(setIsBlocked).catch(() => {});
            sub = DeviceEventEmitter.addListener(BLOCKLIST_UPDATED_EVENT, (list: string[]) => {
                if (Array.isArray(list)) {
                    setIsBlocked(list.includes(pubKeyStr));
                } else {
                    isUserBlocked(pubKeyStr).then(setIsBlocked).catch(() => {});
                }
            });
        }
        return () => {
            sub?.remove?.();
        };
    }, [pubKeyStr]);

    useEffect(() => {
        let active = true;
        if (identity?.publicKey && pubKeyStr && !isSelf) {
            // The friends table alone: getFriendsLocal joins members, and drops a friend whose card this phone doesn't hold
            // (the friends delta writes friends only; on a community with members on demand cards come later, by key).
            isFriendLocal(identity.publicKey, pubKeyStr).then(friend => {
                if (active) setIsFriend(friend);
            }).catch(() => {});
        }
        return () => { active = false; };
    }, [identity?.publicKey, pubKeyStr, isSelf]);

    const handleUnblock = async () => {
        if (!pubKeyStr) return;
        // unblockUser says false rather than throwing: the list is read back, so the row never shows an unblock that didn't happen.
        await unblockUser(pubKeyStr);
        isUserBlocked(pubKeyStr).then(setIsBlocked).catch(() => {});
    };

    const handleOpenDm = async (prefill?: string) => {
        if (!pubKeyStr || !identity?.publicKey || isMessaging || isBlocked) return;
        setIsMessaging(true);
        try {
            // Read the list again: until the screen's first read answers, the actions row is drawn for a blocked member too,
            // and the node would make a thread nobody can write in.
            if (await isUserBlocked(pubKeyStr)) {
                setIsBlocked(true);
                return;
            }
            const conv = await createConversationApi('dm', [identity.publicKey, pubKeyStr], identity.publicKey);
            if (prefill) {
                router.push({
                    pathname: `/chat/${conv.id}`,
                    params: { prefill },
                });
            } else {
                router.push(`/chat/${conv.id}`);
            }
        } catch (e: any) {
            const isOffline = !e?.message || /off-grid|network|fetch failed|failed to fetch|offline|timeout|abort/i.test(e.message);
            Alert.alert(t('Error'), isOffline ? t('Connect to your community to start a chat.') : signedRequestWords(e.message));
        } finally {
            setIsMessaging(false);
        }
    };

    const handleToggleFriend = async () => {
        if (!identity?.publicKey || !pubKeyStr || togglingFriend) return;
        setTogglingFriend(true);
        try {
            if (isFriend) {
                await removeFriendLocal(identity.publicKey, pubKeyStr);
                setIsFriend(false);
            } else {
                await addFriendLocal(identity.publicKey, pubKeyStr);
                setIsFriend(true);
            }
        } catch (e: any) {
            Alert.alert(t('Not added'), e?.message ? signedRequestWords(e.message) : t('Your community did not add them.'));
        } finally {
            setTogglingFriend(false);
        }
    };

    const handleBlockUser = () => {
        // Someone already blocked: the row under the banner says so and offers Unblock. A second block changes nothing and
        // files no report, so it is never confirmed or announced.
        if (!pubKeyStr || isBlocking || isBlocked) return;
        // Whole sentences with the member's name or without it ("this user"), never a stand-in glued into a sentence.
        const name = callsignStr;
        Alert.alert(
            name ? t('Block {name}?', { name }) : t('Block this user?'),
            name
                ? t('This will instantly hide all posts, offers, and messages from {name}, and notify moderation.', { name })
                : t('This will instantly hide all posts, offers, and messages from this user, and notify moderation.'),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Block User'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            setIsBlocking(true);
                            // The reason goes to the node as written (moderators read it), not in the member's language.
                            const blocked = await blockUser(pubKeyStr, identity?.publicKey, 'Abusive user reported via Trust Profile', undefined);
                            // blockUser says false rather than throwing (no account on the phone, the list not written): the
                            // list is read back, so a block that didn't happen is never announced.
                            if (!blocked && !(await isUserBlocked(pubKeyStr))) throw new Error('Not blocked');
                            Alert.alert(t('User Blocked'), name
                                ? t('{name} has been blocked and removed from your feed.', { name })
                                : t('this user has been blocked and removed from your feed.'), [
                                { text: t('OK'), onPress: () => router.back() }
                            ]);
                        } catch (e) {
                            Alert.alert(t('Error'), t('Failed to block user. Please try again.'));
                        } finally {
                            setIsBlocking(false);
                        }
                    }
                }
            ]
        );
    };

    // An enterprise's key opens the enterprise page, never this one (DESIGN-shops-round3-enterprise-shopfront §1.1,
    // slice E1). Every door that opens someone by key lands here (a post's author, the deal chat's peer, the map's
    // preview, the People lists), and none of them knows what the key is: the node's trust profile says `isTreasury` for
    // an enterprise or a project, and this screen hands over to /treasury-detail on it. The member directory never
    // carries an enterprise, so a key with no card on this phone may be one: where the community has enterprises at all,
    // nothing of a member's profile is drawn for it until the node has said (or couldn't: offline, it is drawn as before).
    // A card still held from the last key (the screen handed a new one in place) is not this key's.
    const hasCard = !!profile && profile.public_key === pubKeyStr;
    const isEnterprise = !isSelf && !!pubKeyStr && !!trust?.isTreasury && trust?.publicKey === pubKeyStr;
    const kindUnknown = !isSelf && !!pubKeyStr && !hasCard && trustFor !== pubKeyStr && enterprisesOn(nodeProfile?.features);
    const enterpriseName = (isEnterprise && trust?.callsign) || (Array.isArray(callsign) ? callsign[0] : callsign);
    useEffect(() => {
        if (!isEnterprise || !pubKeyStr) return;
        router.replace({ pathname: '/treasury-detail', params: { publicKey: pubKeyStr, ...(enterpriseName ? { name: enterpriseName } : {}) } });
    }, [isEnterprise, pubKeyStr]);

    if (isEnterprise || (kindUnknown && pubKeyStr !== HIDDEN_AUTHOR)) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.header}>
                    <Pressable
                        testID="profile-kind-pending-back"
                        accessibilityRole="button"
                        onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
                        style={styles.backButton}
                    >
                        <Text style={styles.backText}>←</Text>
                        <Text style={styles.backTextLabel}>{t('Back')}</Text>
                    </Pressable>
                </View>
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator color={colors.brand.primary} />
                </View>
            </SafeAreaView>
        );
    }

    // A listing seen as a visitor names nobody (utils/posts-view.ts): say so, as a state, not an error.
    if (pubKeyStr === HIDDEN_AUTHOR) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.header}>
                    <Pressable
                        accessibilityRole="button"
                        onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
                        style={styles.backButton}
                    >
                        <Text style={styles.backText}>←</Text>
                        <Text style={styles.backTextLabel}>{t('Back')}</Text>
                    </Pressable>
                </View>
                <Text style={{ margin: 24, fontSize: 16, lineHeight: 22, textAlign: 'center', color: colors.text.secondary }}>
                    {t('Who posted this is shown to members of this community. Join it to see their profile.')}
                </Text>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                        if (router.canGoBack()) {
                            router.back();
                        } else {
                            router.replace('/(tabs)/people');
                        }
                    }}
                    style={styles.backButton}
                >
                    <Text style={styles.backText}>←</Text>
                    <Text style={styles.backTextLabel}>{t('Back')}</Text>
                </Pressable>
                <Text style={[styles.headerTitle, { flexShrink: 1, marginHorizontal: 8 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{isSelf ? t('My Profile') : t('Trust Profile')}</Text>
                {isSelf ? (
                    <Pressable accessibilityRole="button" style={styles.editBtn} onPress={() => router.push({ pathname: '/(tabs)/settings', params: { section: 'profile' } })}>
                        <MaterialCommunityIcons name="pencil" size={15} color={colors.brand.primary} />
                        <Text style={styles.editBtnText}>{t('Edit')}</Text>
                    </Pressable>
                ) : (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={callsignStr ? t('Block user {name}', { name: callsignStr }) : t('Block user')}
                        accessibilityState={{ busy: isBlocking, disabled: isBlocked }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        disabled={isBlocking || isBlocked}
                        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, minWidth: 44, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border, opacity: isBlocking ? 0.6 : 1 }}
                        onPress={handleBlockUser}
                    >
                        {isBlocking ? (
                            <ActivityIndicator size="small" color={colors.feedback.danger.fg} />
                        ) : (
                            <MaterialCommunityIcons name="shield-alert-outline" size={15} color={colors.feedback.danger.fg} />
                        )}
                        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.feedback.danger.fg }} numberOfLines={1}>{isBlocking ? t('Blocking…') : t('Block')}</Text>
                    </Pressable>
                )}
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                {/* Banner */}
                <View style={styles.banner}>
                    <View style={styles.avatarRing}>
                        <MemberAvatar avatarUrl={ownShown ? own.avatarUrl : profile?.avatar_url} updatedAt={ownShown ? own.updatedAt : undefined} pubkey={pubKeyStr || ''} callsign={callsignStr || '?'} size={80} enlargeable />
                    </View>
                    <View style={styles.nameRow}>
                        <Text style={styles.callsignText} numberOfLines={1}>{callsignStr}</Text>
                        <MaterialCommunityIcons name="check-decagram" size={22} color={colors.brand.primary} style={{ marginLeft: 6, marginTop: 2, flexShrink: 0 }} />
                    </View>
                    <Text style={styles.pubkeyText}>{pubKeyStr?.slice(0, 16)}...</Text>
                    {cardUnreachable && <Text style={styles.unreachableText} numberOfLines={2}>{t('Connect to see more')}</Text>}
                    {!!fmtDay(profile?.joined_at) && (
                        <Text style={styles.joinedText} numberOfLines={1}>{t('📅 Joined {date}', { date: fmtDay(profile.joined_at) })}</Text>
                    )}
                    {/* Visual Reciprocity Health Ring / Badge (#4). The deal completion rate: Beans, gated like the trust
                        panel below. Where nobody makes a deal (the worldwide community) it read 100% for everyone. */}
                    {showsBeans && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.brand.tint, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, borderWidth: 1, borderColor: colors.brand.primary, marginTop: 6 }}>
                        <MaterialCommunityIcons name="circle-outline" size={15} color={colors.brand.primary} />
                        <Text style={{ fontSize: 13, fontWeight: '800', color: colors.brand.primary, flexShrink: 1 }}>
                            {t('{pct}% Reciprocity Health', { pct: trust?.completionRate === null || trust?.completionRate === undefined ? 100 : Math.round(trust.completionRate * 100) })}
                        </Text>
                    </View>
                    )}
                    {profile?.bio && (
                        <Text style={styles.bioText}>"{profile.bio}"</Text>
                    )}
                    {/* Syndicated Creator Channels (The Pulse, Phase 1) */}
                    <ChannelChips channels={channels} />
                </View>

                {!isSelf && (
                    // Keyed so Unblock mounts a fresh row: reusing the blocked row's views kept "Unblock" as the toggle's label and squeezed both buttons onto one line (320 dp × 1.3).
                    isBlocked ? (
                        <View key="blocked" style={styles.blockedRow}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
                                <Text style={styles.blockedEmoji}>🚫</Text>
                                <Text style={styles.blockedText}>
                                    {t('You blocked {name}.', { name: callsignStr || '…' })}
                                </Text>
                            </View>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Unblock')}
                                style={styles.unblockBtn}
                                onPress={handleUnblock}
                            >
                                <Text style={styles.unblockBtnText}>{t('Unblock')}</Text>
                            </Pressable>
                        </View>
                    ) : (
                        <View key="actions" style={styles.actionRow}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Message', undefined, 'button: write to')}
                                disabled={isMessaging}
                                style={styles.messageBtn}
                                onPress={() => handleOpenDm()}
                            >
                                {isMessaging ? (
                                    <ActivityIndicator size="small" color={colors.text.inverse} />
                                ) : (
                                    <>
                                        <MaterialCommunityIcons name="message-text-outline" size={18} color={colors.text.inverse} />
                                        <Text style={styles.messageBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Message', undefined, 'button: write to')}</Text>
                                    </>
                                )}
                            </Pressable>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={isFriend ? t('✓ Friend') : t('+ Add friend')}
                                accessibilityState={{ selected: isFriend }}
                                disabled={togglingFriend}
                                style={[styles.friendToggleBtn, isFriend && styles.friendToggleBtnActive]}
                                onPress={handleToggleFriend}
                            >
                                <Text style={[styles.friendToggleBtnText, isFriend && styles.friendToggleBtnTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                                    {isFriend ? t('✓ Friend') : t('+ Add friend')}
                                </Text>
                            </Pressable>
                        </View>
                    )
                )}

                {/* Trust & safety (other members only) — the "is this person safe to trade with?" panel. Its verdict, tier,
                    Trust Points, track record, vouch and Vouch action are all Beans: gated like the own card (`showsBeans`).
                    On a community with Beans off (the worldwide one) every member reads "🌱 Newcomer · 0 Trust Points" and is
                    told to trade to build trust, which can't happen there (global previews audit, item 2); the line below
                    says where badges and Beans are earned. Collaboration Chemistry and connections in common are not Beans:
                    they stay. */}
                {!isSelf && (
                    trustLoading ? (showsBeans && (
                        <View style={{ marginHorizontal: 16, marginTop: 16, padding: 20, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' }}>
                            <ActivityIndicator size="small" color={colors.brand.primary} />
                            <Text style={{ marginTop: 8, color: colors.text.muted, fontSize: 12, fontWeight: '600' }}>{t('Calculating trust signals...')}</Text>
                        </View>
                    )) : trust ? (
                        <>
                            {showsBeans && (<>
                            {/* Safety recommendation */}
                            {(() => {
                                const band = RISK_BAND[trust.risk?.band] || RISK_BAND.yellow;
                                return (
                                    <View style={[styles.safetyBanner, { backgroundColor: band.bg, borderColor: band.border }]}>
                                        {/* The verdict, its reasons and its tips are the node's own words, shown as it sent them (slice S4). */}
                                        <View style={styles.safetyHeaderRow}>
                                            <Text style={styles.safetyEmoji} allowFontScaling={false}>{band.emoji}</Text>
                                            <Text style={[styles.safetyHeadline, { color: band.text }]}>{trust.risk?.headline}</Text>
                                        </View>
                                        {(trust.risk?.reasons || []).map((r: string, i: number) => (
                                            <Text key={i} style={styles.safetyReason}>• {r}</Text>
                                        ))}
                                        {(trust.risk?.tips || []).length > 0 && (
                                            <View style={styles.safetyTips}>
                                                {trust.risk.tips.map((tip: string, i: number) => (
                                                    <Text key={i} style={styles.safetyTip}>⚠️  {tip}</Text>
                                                ))}
                                            </View>
                                        )}
                                    </View>
                                );
                            })()}

                            {/* Tier + Trust Points Banner */}
                            <View style={styles.trustSignalCard}>
                                <Text style={styles.trustEmoji} allowFontScaling={false}>{trust.tier?.emoji || '🌱'}</Text>
                                <View style={{ flex: 1, minWidth: 0 }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                                        <Text style={[styles.trustTierName, { flexShrink: 1 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{trust.tier?.name ? tierWords(trust.tier.name) : t('Member', undefined, 'trust tier')}</Text>
                                        <View style={{ backgroundColor: colors.brand.tint, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: colors.brand.primary }}>
                                            <Text style={{ fontSize: 13, fontWeight: '900', color: colors.brand.primary }}>
                                                {tn(Math.round(trust.earnedCredit || 0), '{n} Trust Points', '{n} Trust Points')}
                                            </Text>
                                        </View>
                                    </View>
                                    <Text style={styles.trustSub} numberOfLines={2}>
                                        {(() => {
                                            const since = fmtDay(trust.joinedAt);
                                            const active = fmtLastActive(trust.lastActiveAt);
                                            if (since && active) return t('Member since {date} · {active}', { date: since, active });
                                            return since ? t('Member since {date}', { date: since }) : active;
                                        })()}
                                    </Text>
                                    
                                    {/* Clear Nuanced Trust Explanation */}
                                    <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border.default }}>
                                        {(() => {
                                            const tradeCount = trust.stats?.tradeCount || 0;
                                            const isHighRisk = trust.risk?.band === 'red' || trust.risk?.band === 'black';
                                            const completionPct = trust.completionRate !== null && trust.completionRate !== undefined ? Math.round(trust.completionRate * 100) : 100;

                                            const partners = trust.stats?.uniquePartners || 0;
                                            // Each verdict one sentence with its bold label inside it (components/Sentence); the
                                            // partners' count is its own phrase, so each count takes its language's plural.
                                            if (tradeCount === 0) {
                                                return (
                                                    <Text style={{ fontSize: 12, color: colors.text.secondary, lineHeight: 17, fontWeight: '500' }}>
                                                        <Sentence
                                                            text={t('🌱 {label} Has not completed any trades yet. Complete a marketplace trade with them to help build their community trust score.')}
                                                            parts={{ label: <Text style={{ fontWeight: '700', color: colors.text.heading }}>{t('New Member:')}</Text> }}
                                                        />
                                                    </Text>
                                                );
                                            }
                                            if (isHighRisk || completionPct < 75) {
                                                return (
                                                    <Text style={{ fontSize: 12, color: colors.feedback.danger.fg, lineHeight: 17, fontWeight: '600' }}>
                                                        <Sentence
                                                            text={tn(tradeCount,
                                                                '⚠️ {label} Completed {n} trade with a {pct}% completion rate across {partners}.',
                                                                '⚠️ {label} Completed {n} trades with a {pct}% completion rate across {partners}.',
                                                                { pct: completionPct, partners: tn(partners, '{n} partner', '{n} partners') })}
                                                            parts={{ label: <Text style={{ fontWeight: '800' }}>{t('Mixed Track Record:')}</Text> }}
                                                        />
                                                    </Text>
                                                );
                                            }
                                            return (
                                                <Text style={{ fontSize: 12, color: colors.brand.primary, lineHeight: 17, fontWeight: '600' }}>
                                                    <Sentence
                                                        text={tn(tradeCount,
                                                            '🤝 {label} Earned trust through {n} completed trade across {partners}.',
                                                            '🤝 {label} Earned trust through {n} completed trades across {partners}.',
                                                            { partners: tn(partners, '{n} unique partner', '{n} unique partners') })}
                                                        parts={{ label: <Text style={{ fontWeight: '800' }}>{t('Proven Partner:')}</Text> }}
                                                    />
                                                </Text>
                                            );
                                        })()}
                                    </View>
                                </View>
                            </View>
                            </>)}

                            {/* ─── Collaboration Chemistry ─── */}
                            {(() => {
                                const viewerArchetype = parseArchetype(viewerProfile?.archetype);
                                const targetArchetype = parseArchetype(profile?.archetype);
                                const synergy = (!isSelf && viewerArchetype && targetArchetype)
                                    ? calculateSynergy(viewerArchetype.primary, targetArchetype.primary)
                                    : null;

                                if (synergy) {
                                    return (
                                        <View style={styles.synergyCard}>
                                            <View style={styles.synergyHeaderRow}>
                                                <Text style={styles.synergyEmoji}>{synergy.emoji}</Text>
                                                <View style={{ flex: 1 }}>
                                                    <Text style={styles.synergyTitle}>{t(synergy.title)}</Text>
                                                    <Text style={styles.synergyHeadline}>{t(synergy.headline)}</Text>
                                                </View>
                                            </View>
                                            <Text style={styles.synergySummary}>{t(synergy.summary)}</Text>

                                            <View style={styles.synergyStrengthsWrap}>
                                                {synergy.strengths.map((_str, idx: number) => (
                                                    <View key={idx} style={styles.synergyStrengthRow}>
                                                        <Text style={styles.synergyBullet}>✓</Text>
                                                        <Text style={styles.synergyStrengthText}>{t(synergy.strengths[idx])}</Text>
                                                    </View>
                                                ))}
                                            </View>

                                            {synergy.collaborationTip && (
                                                <View style={styles.synergyTipBox}>
                                                    <Text style={styles.synergyTipText}>
                                                        <Sentence text={t('💡 {label} {tip}', { tip: t(synergy.collaborationTip) })} parts={{ label: <Text style={{ fontWeight: '700' }}>{t('Collaboration tip:')}</Text> }} />
                                                    </Text>
                                                </View>
                                            )}
                                        </View>
                                    );
                                }

                                if (!isSelf && !viewerArchetype && targetArchetype) {
                                    return (
                                        <View style={styles.synergyInviteCard}>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                                                <Text style={{ fontSize: 20, marginRight: 8 }}>✨</Text>
                                                <Text style={[styles.synergyInviteTitle, { flexShrink: 1 }]}>{t('Collaboration Chemistry')}</Text>
                                            </View>
                                            <Text style={styles.synergyInviteDesc}>
                                                {callsignStr
                                                    ? t('Take the 60-second quiz to get tips for working with {name}.', { name: callsignStr })
                                                    : t('Take the 60-second quiz to get tips for working with this member.')}
                                            </Text>
                                            <Pressable
                                                accessibilityRole="button"
                                                accessibilityLabel={t('Take 60 second quiz to discover collaboration synergy')}
                                                style={styles.synergyTakeQuizBtn}
                                                onPress={() => setShowQuizModal(true)}
                                            >
                                                <Text style={styles.synergyTakeQuizBtnText}>{t('⚡ Take 60s Quiz')}</Text>
                                            </Pressable>
                                        </View>
                                    );
                                }

                                // Blocked: no nudge, as there is no Message.
                                if (!isSelf && !isBlocked && viewerArchetype && !targetArchetype) {
                                    return (
                                        <View style={styles.synergyInviteCard}>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                                                <Text style={{ fontSize: 20, marginRight: 8 }}>✨</Text>
                                                <Text style={[styles.synergyInviteTitle, { flexShrink: 1 }]}>{t('Collaboration Chemistry')}</Text>
                                            </View>
                                            <Text style={styles.synergyInviteDesc}>
                                                {callsignStr
                                                    ? t("{name} hasn't taken the working style quiz yet. Send a friendly nudge in chat to get tips for working together.", { name: callsignStr })
                                                    : t("This member hasn't taken the working style quiz yet. Send a friendly nudge in chat to get tips for working together.")}
                                            </Text>
                                            <Pressable
                                                accessibilityRole="button"
                                                accessibilityLabel={callsignStr ? t('Nudge {name} to take the working style quiz', { name: callsignStr }) : t('Nudge member to take the working style quiz')}
                                                style={styles.synergyTakeQuizBtn}
                                                onPress={() => {
                                                    if (pubKeyStr) {
                                                        // The message starts in the sender's language; they can change it before it goes.
                                                        const prefill = callsignStr
                                                            ? t('Hey {name}! Take the 60-second working style quiz on your profile so we can see how we work best together! ⚡', { name: callsignStr })
                                                            : t('Hey there! Take the 60-second working style quiz on your profile so we can see how we work best together! ⚡');
                                                        handleOpenDm(prefill);
                                                    }
                                                }}
                                            >
                                                <Text style={styles.synergyTakeQuizBtnText}>
                                                    {callsignStr ? t('💬 Nudge {name} in Chat', { name: callsignStr }) : t('💬 Nudge Member in Chat')}
                                                </Text>
                                            </Pressable>
                                        </View>
                                    );
                                }

                                if (!isSelf && !viewerArchetype && !targetArchetype) {
                                    return (
                                        <View style={styles.synergyInviteCard}>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                                                <Text style={{ fontSize: 20, marginRight: 8 }}>✨</Text>
                                                <Text style={[styles.synergyInviteTitle, { flexShrink: 1 }]}>{t('Collaboration Chemistry')}</Text>
                                            </View>
                                            <Text style={styles.synergyInviteDesc}>
                                                {callsignStr
                                                    ? t('Take the 60-second quiz to get tips for working with {name}.', { name: callsignStr })
                                                    : t('Take the 60-second quiz to get tips for working with this member.')}
                                            </Text>
                                            <Pressable
                                                accessibilityRole="button"
                                                accessibilityLabel={t('Take 60 second quiz to discover collaboration synergy')}
                                                style={styles.synergyTakeQuizBtn}
                                                onPress={() => setShowQuizModal(true)}
                                            >
                                                <Text style={styles.synergyTakeQuizBtnText}>{t('⚡ Take 60s Quiz')}</Text>
                                            </Pressable>
                                        </View>
                                    );
                                }

                                return null;
                            })()}

                            {/* Track record */}
                            {showsBeans && (
                            <View style={styles.statStrip} testID="trust-track-record">
                                <View style={styles.statTile}>
                                    <Text style={styles.statTileNum} numberOfLines={1}>{trust.stats?.tradeCount ?? 0}</Text>
                                    <Text style={styles.statTileLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Trades')}</Text>
                                </View>
                                <View style={styles.statDivider} />
                                <View style={styles.statTile}>
                                    <Text style={styles.statTileNum} numberOfLines={1}>{trust.stats?.uniquePartners ?? 0}</Text>
                                    <Text style={styles.statTileLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Partners')}</Text>
                                </View>
                                <View style={styles.statDivider} />
                                <View style={styles.statTile}>
                                    <Text style={styles.statTileNum} numberOfLines={1}>{trust.completionRate === null || trust.completionRate === undefined ? '100%' : `${Math.round(trust.completionRate * 100)}%`}</Text>
                                    <Text style={styles.statTileLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Completion')}</Text>
                                </View>
                            </View>
                            )}

                            {/* Mutual connections — the line that calms nerves */}
                            {trust.mutualCount > 0 && (
                                <View style={styles.mutualCard}>
                                    <Text style={styles.mutualTitle}>{tn(trust.mutualCount, '👥 {n} connection in common', '👥 {n} connections in common')}</Text>
                                    {trust.mutualConnections.map((m: any) => (
                                        <Pressable
                                            key={m.publicKey}
                                            accessibilityRole="button"
                                            style={styles.mutualRow}
                                            onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: m.publicKey, callsign: m.callsign || '' } })}
                                        >
                                            <MemberAvatar avatarUrl={m.avatarUrl} pubkey={m.publicKey} callsign={m.callsign || '?'} size={32} />
                                            <Text style={styles.mutualName} numberOfLines={1}>{m.callsign || `${m.publicKey?.slice(0, 8)}…`}</Text>
                                            <Text style={[styles.mutualAsk, { flexShrink: 1, maxWidth: '50%' }]} numberOfLines={2}>{t('Ask about them ›')}</Text>
                                        </Pressable>
                                    ))}
                                </View>
                            )}

                            {showsBeans && (<>
                            {/* Vouched in by */}
                            {trust.vouchedInBy && (
                                <View style={styles.vouchCard}>
                                    {trust.vouchedInBy.kind === 'member' && (
                                        <Pressable
                                            accessibilityRole="button"
                                            style={styles.vouchInviterRow}
                                            onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: trust.vouchedInBy.publicKey, callsign: trust.vouchedInBy.callsign || '' } })}
                                        >
                                            <MemberAvatar avatarUrl={trust.vouchedInBy.avatarUrl} pubkey={trust.vouchedInBy.publicKey} callsign={trust.vouchedInBy.callsign || '?'} size={32} />
                                            <View style={{ flex: 1, minWidth: 0 }}>
                                                <Text style={styles.vouchInviterName} numberOfLines={1}>{t('🌱 Vouched in by {name}', { name: trust.vouchedInBy.callsign ?? '' })}</Text>
                                                <Text style={styles.vouchInviterSub} numberOfLines={2}>{t('{tier} tier · tap to reach out', { tier: tierWords(trust.vouchedInBy.tier) })}</Text>
                                            </View>
                                            <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.secondary} />
                                        </Pressable>
                                    )}
                                    {trust.vouchedInBy.kind !== 'member' && (
                                        <View style={styles.vouchInviterRow}>
                                            <View style={styles.systemBadge}>
                                                <MaterialCommunityIcons name="shield-check" size={20} color={colors.brand.primary} />
                                            </View>
                                            <View style={{ flex: 1, minWidth: 0 }}>
                                                <Text style={styles.vouchInviterName} numberOfLines={2}>
                                                    {trust.vouchedInBy.kind === 'founder' ? t('Founding member') : t('Invited directly by the system admin')}
                                                </Text>
                                                <Text style={styles.vouchInviterSub} numberOfLines={2}>
                                                    {trust.vouchedInBy.kind === 'founder' ? t('Here since the community began') : t('Vetted by the admin at sign-up')}
                                                </Text>
                                            </View>
                                        </View>
                                    )}
                                </View>
                            )}

                            {/* Elder endorsement badge */}
                            {trust.elderVouch && (
                                <View style={[styles.vouchCard, { flexDirection: 'row', alignItems: 'center', gap: 8, borderColor: '#f59e0b' }]}>
                                    <Text style={{ fontSize: 18 }} allowFontScaling={false}>⛰️</Text>
                                    <Text style={[styles.vouchInviterName, { flexShrink: 1 }]} numberOfLines={2}>
                                        {trust.elderVouch.callsign
                                            ? t('Vouched by {name}', { name: trust.elderVouch.callsign })
                                            : trust.elderVouch.sponsor ? t('Vouched by a sponsor') : t('Vouched by an Elder')}
                                    </Text>
                                </View>
                            )}

                            {/* Vouch action — extend a credit line to this member (voucher picks the level) */}
                            {canVouch && (
                                <Pressable
                                    accessibilityRole="button"
                                    disabled={vouching}
                                    onPress={chooseVouchLevel}
                                    style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.feedback.warning.solid, opacity: vouching ? 0.6 : 1 }}
                                    >
                                    <Text style={{ color: colors.text.onGold, fontWeight: '800', fontSize: 15, flexShrink: 1, textAlign: 'center' }} allowFontScaling={false}>{vouching ? t('🤝 Vouching…') : t('🤝 Vouch for Member')}</Text>
                                </Pressable>
                            )}
                            </>)}
                        </>
                    ) : null
                )}

                {/* Where Beans are off, another member's profile still carries the plain meeting advice, without the verdict. */}
                {!isSelf && !showsBeans && (
                    <View style={[styles.safetyBanner, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]} testID="meeting-tips">
                        <View style={styles.safetyHeaderRow}>
                            <Text style={styles.safetyEmoji} allowFontScaling={false}>🛡️</Text>
                            <Text style={[styles.safetyHeadline, { color: colors.text.heading }]} accessibilityRole="header">{meetingTips().heading}</Text>
                        </View>
                        {meetingTips().tips.map((tip, i) => (
                            <Text key={i} style={[styles.safetyReason, { color: colors.text.body }]}>• {tip}</Text>
                        ))}
                    </View>
                )}

                {!showsBeans && beansPreview && (
                    <View style={{ marginHorizontal: 16 }}>
                        <LocalCommunityMark variant="line" feature="beans" text={t(LOCAL_COMMUNITY_LINES.profile)} />
                    </View>
                )}

                {/* Trust summary (self only) — links to the full Ledger */}
                {isSelf && balanceInfo && showsBeans && (
                    <Pressable accessibilityRole="button" style={styles.trustCard} onPress={() => router.push('/(tabs)/ledger')}>
                        <View style={styles.trustLeft}>
                            <Text style={styles.trustEmoji} allowFontScaling={false}>{balanceInfo.tier?.emoji || '🌱'}</Text>
                            <View style={{ flexShrink: 1 }}>
                                <Text style={styles.trustTierName} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{balanceInfo.tier?.name ? tierWords(balanceInfo.tier.name) : t('Member', undefined, 'trust tier')}</Text>
                                <Text style={styles.trustSub} numberOfLines={1}>{tn(Math.round(balanceInfo.earnedCredit || 0), '{n} trust points', '{n} trust points')}</Text>
                            </View>
                        </View>
                        <View style={styles.trustRight}>
                            <View style={{ alignItems: 'flex-end' }}>
                                <Text style={styles.trustBalance}>{balanceInfo.balance >= 0 ? '+' : ''}{formatNumber(balanceInfo.balance ?? 0, 1)}</Text>
                                <Text style={styles.trustSub}>{t('Beans')}</Text>
                            </View>
                            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.secondary} />
                        </View>
                    </Pressable>
                )}

                {/* Quick stats (self) — tappable through to the relevant screens */}
                {isSelf && (
                    <View style={styles.statStrip}>
                        <Pressable accessibilityRole="button" style={styles.statTile} onPress={() => {
                            DeviceEventEmitter.emit('set_people_view', { view: 'friends' });
                            router.push({ pathname: '/(tabs)/people', params: { view: 'friends' } });
                        }}>
                            <Text style={styles.statTileNum} numberOfLines={1}>{friendsCount}</Text>
                            <Text style={styles.statTileLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Friends')}</Text>
                        </Pressable>
                        {/* A count of deals: Beans, so not drawn where nobody makes one (the worldwide community). */}
                        {showsBeans && (<>
                        <View style={styles.statDivider} />
                        <View style={styles.statTile}>
                            <Text style={styles.statTileNum} numberOfLines={1}>{balanceInfo?.trustStats?.tradeCount ?? 0}</Text>
                            <Text style={styles.statTileLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Trades')}</Text>
                        </View>
                        </>)}
                    </View>
                )}

                {/* Working style (self). The synergy panel above is inside a !isSelf block, so
                    your own archetype had no home — which also made the "take the quiz on your
                    profile" chat nudge point at a screen that had no quiz on it. */}
                {isSelf && (() => {
                    const mine = parseArchetype(profile?.archetype) || parseArchetype(viewerProfile?.archetype);
                    const primary = mine ? ARCHETYPES[mine.primary] : null;
                    const secondary = mine ? ARCHETYPES[mine.secondary] : null;

                    if (mine && primary) {
                        return (
                            <View style={styles.synergyCard}>
                                <View style={styles.synergyHeaderRow}>
                                    <Text style={styles.synergyEmoji}>{primary.emoji}</Text>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.synergyTitle}>{t(primary.name)}</Text>
                                        <Text style={styles.synergyHeadline}>{t(primary.tagline)}</Text>
                                    </View>
                                </View>
                                <Text style={styles.synergySummary}>{t(primary.description)}</Text>

                                {secondary && (
                                    <Text style={styles.synergyHeadline}>
                                        {t('Secondary rhythm: {emoji} {name}', { emoji: secondary.emoji, name: t(secondary.name) })}
                                    </Text>
                                )}

                                <View style={styles.synergyStrengthsWrap}>
                                    {primary.superpowers.map((_sp, idx: number) => (
                                        <View key={idx} style={styles.synergyStrengthRow}>
                                            <Text style={styles.synergyBullet}>✓</Text>
                                            <Text style={styles.synergyStrengthText}>{t(primary.superpowers[idx])}</Text>
                                        </View>
                                    ))}
                                </View>

                                <View style={styles.synergyTipBox}>
                                    <Text style={styles.synergyTipText}>
                                        <Sentence text={t('💡 {label} {style}', { style: t(primary.collaborationStyle) })} parts={{ label: <Text style={{ fontWeight: '700' }}>{t('How you work best:')}</Text> }} />
                                    </Text>
                                </View>

                                {/* "Deepen" said nothing about what you'd get. The longer quiz's
                                    selling point is a more accurate result, so say that. */}
                                <View style={styles.quizBtnRow}>
                                    {mine.mode === 'quick' && (
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel={t('Take the longer 27 question quiz for a more accurate result')}
                                            style={[styles.synergyTakeQuizBtn, styles.quizBtnFlex]}
                                            onPress={() => { setQuizInitialMode('deep'); setShowQuizModal(true); }}
                                        >
                                            <Text style={styles.synergyTakeQuizBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('🧭 More accurate')}</Text>
                                        </Pressable>
                                    )}
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={t('Retake community working style quiz')}
                                        style={[styles.synergyRetakeBtn, styles.quizBtnFlex]}
                                        onPress={() => { setQuizInitialMode('quick'); setShowQuizModal(true); }}
                                    >
                                        <Text style={styles.synergyRetakeBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('🔄 Retake')}</Text>
                                    </Pressable>
                                </View>
                            </View>
                        );
                    }

                    return (
                        <View style={styles.synergyInviteCard}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                                <Text style={{ fontSize: 20, marginRight: 8 }}>✨</Text>
                                <Text style={[styles.synergyInviteTitle, { flexShrink: 1 }]}>{t('Your Working Style')}</Text>
                            </View>
                            <Text style={styles.synergyInviteDesc}>
                                {t('Take the 60-second quiz on how you prefer to work. Neighbours then get tips for working with you.')}
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Take 60 second community working style quiz')}
                                style={styles.synergyTakeQuizBtn}
                                onPress={() => { setQuizInitialMode('quick'); setShowQuizModal(true); }}
                            >
                                <Text style={styles.synergyTakeQuizBtnText}>{t('⚡ Take 60s Quiz')}</Text>
                            </Pressable>
                        </View>
                    );
                })()}

                {loading ? (
                    <ActivityIndicator size="large" color={colors.brand.primary} style={{ marginTop: 40 }} />
                ) : (
                    <>
                        {/* Stats grid */}
                        {ratingsLoading ? (
                            <View style={{ marginHorizontal: 16, marginTop: 12, padding: 14, backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, alignItems: 'center', justifyContent: 'center' }}>
                                <ActivityIndicator size="small" color={colors.brand.primary} />
                            </View>
                        ) : stats && stats.count > 0 ? (
                             <View style={styles.statsGrid}>
                                 <View style={styles.statBoxOverall}>
                                     <Text style={styles.starRating} allowFontScaling={false} numberOfLines={1}>{renderStars(stats.average)}</Text>
                                     <Text style={styles.statValueOverall} numberOfLines={1}>{formatNumber(stats.average, 1)}</Text>
                                     <Text style={styles.statLabelOverall} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('OVERALL')}</Text>
                                 </View>
                                 <View style={styles.statBoxProvider}>
                                     <MaterialCommunityIcons name="inbox-arrow-up" size={26} color={colors.brand.primary} />
                                     <Text style={styles.statValueProvider} numberOfLines={1}>{typeof stats.asProvider?.average === 'number' ? formatNumber(stats.asProvider.average, 1) : '-'}</Text>
                                     <Text style={styles.statLabelProvider} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('AS PROVIDER')}</Text>
                                 </View>
                                 <View style={styles.statBoxReceiver}>
                                     <MaterialCommunityIcons name="inbox-arrow-down" size={26} color={palette.indigo500} />
                                     <Text style={styles.statValueReceiver} numberOfLines={1}>{typeof stats.asReceiver?.average === 'number' ? formatNumber(stats.asReceiver.average, 1) : '-'}</Text>
                                     <Text style={styles.statLabelReceiver} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('AS RECEIVER')}</Text>
                                 </View>
                             </View>
                        ) : null}

                        {/* Tabs */}
                        <View style={styles.tabBar}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ selected: activeTab === 'listings' }}
                                style={[styles.tab, activeTab === 'listings' && styles.tabActive]}
                                onPress={() => setActiveTab('listings')}
                            >
                                <Text style={[styles.tabText, activeTab === 'listings' && styles.tabTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} allowFontScaling={false}>
                                    {activePosts.length > 0 ? t('Listings ({n})', { n: activePosts.length }) : t('Listings')}
                                </Text>
                            </Pressable>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ selected: activeTab === 'reviews' }}
                                style={[styles.tab, activeTab === 'reviews' && styles.tabActive]}
                                onPress={() => setActiveTab('reviews')}
                            >
                                <Text style={[styles.tabText, activeTab === 'reviews' && styles.tabTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} allowFontScaling={false}>
                                    {isSelf
                                        ? (ratings.length > 0 ? t('Received ({n})', { n: ratings.length }) : t('Received', undefined, 'reviews'))
                                        : (ratings.length > 0 ? t('Reviews ({n})', { n: ratings.length }) : t('Reviews'))}
                                </Text>
                            </Pressable>
                            {isSelf && (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: activeTab === 'given' }}
                                    style={[styles.tab, activeTab === 'given' && styles.tabActive]}
                                    onPress={() => setActiveTab('given')}
                                >
                                    <Text style={[styles.tabText, activeTab === 'given' && styles.tabTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} allowFontScaling={false}>
                                        {given.length > 0 ? t('Given ({n})', { n: given.length }) : t('Given', undefined, 'reviews')}
                                    </Text>
                                </Pressable>
                            )}
                        </View>

                        {/* Listings tab */}
                        {activeTab === 'listings' && (
                            <View style={styles.tabContent}>
                                {activePosts.length === 0 ? (
                                    <View style={styles.emptyCard}>
                                        <Text style={styles.emptyIcon}>🛒</Text>
                                        <Text style={styles.emptyText}>{t('No active listings.')}</Text>
                                    </View>
                                ) : (
                                    activePosts.map((p, i) => {
                                        let coverImage: string | null = null;
                                        if (p.photos) {
                                            try {
                                                const arr = Array.isArray(p.photos) ? p.photos : JSON.parse(p.photos);
                                                if (arr.length > 0) coverImage = arr[0];
                                            } catch {}
                                        }
                                        return (
                                            <Pressable key={p.id || i} accessibilityRole="button" onPress={() => router.push(`/post/${p.id}`)}>
                                                <View style={styles.dealCard}>
                                                    <View style={{ flexDirection: 'row', gap: 12 }}>
                                                        {coverImage && typeof coverImage === 'string' && coverImage.trim() !== '' && coverImage !== 'null' && coverImage !== 'undefined' ? (
                                                            <Image accessibilityLabel={t('Listing photo')} source={{ uri: listPhotoUrl(coverImage) }} style={styles.dealThumb} />
                                                        ) : (
                                                            <View style={[styles.dealThumb, styles.dealThumbFallback]}>
                                                                <Text style={{ fontSize: 24, opacity: 0.4 }}>📦</Text>
                                                            </View>
                                                        )}
                                                        <View style={{ flex: 1, justifyContent: 'center' }}>
                                                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                                                                <View style={[styles.typeBadge, p.type === 'offer' ? styles.badgeOffer : styles.badgeNeed]}>
                                                                    <Text style={styles.typeBadgeText}>{p.type === 'offer' ? t('OFFER') : p.type === 'need' ? t('NEED') : p.type?.toUpperCase()}</Text>
                                                                </View>
                                                                {showsBeans && (
                                                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                                    <Text style={styles.creditAmount}>{p.credits ?? '?'}</Text>
                                                                    <Image accessibilityElementsHidden={true} importantForAccessibility="no-hide-descendants" source={require('../assets/images/bean.png')} style={styles.beanIcon} />
                                                                </View>
                                                                )}
                                                            </View>
                                                            <Text style={styles.dealTitle} numberOfLines={1}>{p.title}</Text>
                                                            <Text style={styles.dealDateText}>{t('Active', undefined, 'listing status')}</Text>
                                                        </View>
                                                    </View>
                                                </View>
                                            </Pressable>
                                        );
                                    })
                                )}
                            </View>
                        )}

                        {/* Reviews tab */}
                        {activeTab === 'reviews' && (
                            <View style={styles.tabContent}>
                                {ratingsLoading ? (
                                    <ActivityIndicator size="small" color={colors.brand.primary} style={{ marginTop: 24 }} />
                                ) : ratings.length === 0 ? (
                                    <View style={styles.emptyCard}>
                                        <Text style={styles.emptyIcon}>🌱</Text>
                                        <Text style={styles.emptyText}>{t('No reviews yet.')}</Text>
                                    </View>
                                ) : (
                                    ratings.map((r, i) => (
                                        <View key={i} style={styles.reviewCard}>
                                            <View style={styles.reviewHeader}>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                                                    <Text style={styles.starText} allowFontScaling={false} numberOfLines={1}>{renderStars(r.stars)}</Text>
                                                    <View style={[styles.roleBadge, { flexShrink: 1 }, r.role === 'provider' ? styles.roleBadgeProvider : styles.roleBadgeReceiver]}>
                                                        <Text style={[styles.roleText, r.role === 'provider' ? styles.roleTextProvider : styles.roleTextReceiver]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                                                            {r.role === 'provider' ? t('PROVIDED SERVICE') : t('RECEIVED SERVICE')}
                                                        </Text>
                                                    </View>
                                                </View>
                                                <Text style={styles.dateText}>
                                                    {(r.mine || isSelf)
                                                        ? fmtDay(r.createdAt || new Date().toISOString(), true)
                                                        : fmtMonthYear(r.createdAt || new Date().toISOString(), true)}
                                                </Text>
                                            </View>
                                            {r.comment ? (
                                                <Text style={styles.commentText}>"{r.comment}"</Text>
                                            ) : (
                                                <Text style={styles.noCommentText}>{t('No comment provided.')}</Text>
                                            )}
                                        </View>
                                    ))
                                )}
                            </View>
                        )}
                        {/* Reviews I've given (self only) */}
                        {isSelf && activeTab === 'given' && (
                            <View style={styles.tabContent}>
                                {givenLoading ? (
                                    <ActivityIndicator size="small" color={colors.brand.primary} style={{ marginTop: 24 }} />
                                ) : given.length === 0 ? (
                                    <View style={styles.emptyCard}>
                                        <Text style={styles.emptyIcon}>✍️</Text>
                                        <Text style={styles.emptyText}>{t("You haven't reviewed anyone yet.")}</Text>
                                    </View>
                                ) : (
                                    given.map((r, i) => (
                                        <View key={r.id || i} style={styles.reviewCard}>
                                            <View style={styles.reviewHeader}>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                                                    <MemberAvatar avatarUrl={r.target_avatar} pubkey={r.target_pubkey} callsign={r.target_callsign || '?'} size={28} />
                                                    <Text style={styles.givenName} numberOfLines={1}>{r.target_callsign || `${r.target_pubkey?.slice(0, 8)}…`}</Text>
                                                </View>
                                                <Text style={styles.dateText}>
                                                    {fmtDay(r.created_at || new Date().toISOString(), true)}
                                                </Text>
                                            </View>
                                            <Text style={styles.starText} allowFontScaling={false} numberOfLines={1}>{renderStars(r.stars)}</Text>
                                            {r.comment ? (
                                                <Text style={styles.commentText}>"{r.comment}"</Text>
                                            ) : (
                                                <Text style={styles.noCommentText}>{t('No comment provided.')}</Text>
                                            )}
                                            
                                            {/* Edit review button */}
                                            {r.transaction_id && (
                                                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10 }}>
                                                    <Pressable
                                                        accessibilityRole="button"
                                                        style={({ pressed }) => [
                                                            styles.editReviewBtn,
                                                            pressed && { opacity: 0.8 }
                                                        ]}
                                                        onPress={() => setEditingReview({
                                                            txId: r.transaction_id,
                                                            targetPubkey: r.target_pubkey,
                                                            targetCallsign: r.target_callsign || t('Partner', undefined, 'a member with no name')
                                                        })}
                                                    >
                                                        <MaterialCommunityIcons name="pencil" size={12} color={colors.text.secondary} style={{ marginRight: 4 }} />
                                                        <Text style={styles.editReviewBtnText}>{t('Edit Review')}</Text>
                                                    </Pressable>
                                                </View>
                                            )}
                                        </View>
                                    ))
                                )}
                            </View>
                        )}
                        {/* Not for someone already blocked: their row offers Unblock, and this would promise a block and a report that never happen. */}
                        {!isSelf && !isBlocked && (
                            <View style={{ marginHorizontal: 16, marginTop: 24, marginBottom: 32 }}>
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={callsignStr ? t('Block user {name}', { name: callsignStr }) : t('Block user')}
                                    accessibilityState={{ busy: isBlocking }}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    disabled={isBlocking}
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: 8,
                                        paddingVertical: 14,
                                        borderRadius: 12,
                                        backgroundColor: colors.feedback.danger.bg,
                                        borderWidth: 1,
                                        borderColor: colors.feedback.danger.border,
                                        opacity: isBlocking ? 0.6 : 1
                                    }}
                                    onPress={handleBlockUser}
                                >
                                    {isBlocking ? (
                                        <ActivityIndicator size="small" color={colors.feedback.danger.fg} />
                                    ) : (
                                        <MaterialCommunityIcons name="shield-alert" size={18} color={colors.feedback.danger.fg} />
                                    )}
                                    <Text style={{ color: colors.feedback.danger.fg, fontWeight: '800', fontSize: 14, flexShrink: 1, textAlign: 'center' }}>
                                        {isBlocking ? t('Blocking…') : callsignStr ? t('Block {name}', { name: callsignStr }) : t('Block User')}
                                    </Text>
                                </Pressable>
                                <Text style={{ textAlign: 'center', color: colors.text.muted, fontSize: 11, marginTop: 6 }}>
                                    {t('Blocking will instantly hide their content from your feed and notify moderation.')}
                                </Text>
                            </View>
                        )}
                    </>
                )}
            </ScrollView>

            {editingReview && (
                <ReviewModal
                    visible={!!editingReview}
                    txId={editingReview.txId}
                    targetPubkey={editingReview.targetPubkey}
                    targetCallsign={editingReview.targetCallsign}
                    onClose={() => setEditingReview(null)}
                    onSuccess={async () => {
                        setEditingReview(null);
                        if (identity?.publicKey) {
                            const givenRatings = await getRatingsGiven(identity.publicKey).catch(() => []);
                            setGiven(givenRatings);
                        }
                    }}
                />
            )}

            <ArchetypeQuizModal
                visible={showQuizModal}
                initialMode={quizInitialMode}
                onClose={() => setShowQuizModal(false)}
                onComplete={handleQuizComplete}
            />
        </SafeAreaView>
    );
}


