import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Image, Pressable, ScrollView, ActivityIndicator, Alert, DeviceEventEmitter } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { MemberAvatar } from '../components/MemberAvatar';
import { getMemberProfile, getMemberRatings, getMemberPosts, getBalance, getRatingsGiven, getFriendsLocal, getTrustProfile, vouchMember } from '../utils/db';
import { useIdentity } from './IdentityContext';
import { ReviewModal } from '../components/ReviewModal';
import { colors, palette } from '../constants/colors';
import { useTheme, useStyles } from './ThemeContext';



const fmtMonthYear = (iso?: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};

const fmtLastActive = (iso?: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (days <= 0) return 'Active today';
    if (days === 1) return 'Active yesterday';
    if (days < 7) return `Active ${days}d ago`;
    if (days < 30) return `Active ${Math.floor(days / 7)}w ago`;
    return `Active ${d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
};

export default function PublicProfileScreen() {
    const { publicKey, callsign } = useLocalSearchParams();
    const { identity } = useIdentity();
    const { theme, colors } = useTheme();
    const RISK_BAND = React.useMemo<Record<string, { bg: string; border: string; text: string; emoji: string }>>(() => ({
        green: { bg: colors.feedback.success.bg, border: colors.feedback.success.border, text: colors.feedback.success.fg, emoji: '🟢' },
        yellow: { bg: colors.feedback.warning.bg, border: colors.feedback.warning.border, text: colors.feedback.warning.fg, emoji: '🟡' },
        red: { bg: colors.feedback.danger.bg, border: colors.feedback.danger.border, text: colors.feedback.danger.fg, emoji: '🔴' },
    }), [colors]);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },

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
        statLabelOverall: { fontSize: 9, fontWeight: '700', color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
        statValueProvider: { fontSize: 18, fontWeight: '800', color: colors.brand.primary, marginBottom: 2, marginTop: 4 },
        statLabelProvider: { fontSize: 9, fontWeight: '700', color: colors.brand.primary, textTransform: 'uppercase', letterSpacing: 0.5 },
        statValueReceiver: { fontSize: 18, fontWeight: '800', color: theme === 'dark' ? colors.text.heading : palette.indigo500, marginBottom: 2, marginTop: 4 },
        statLabelReceiver: { fontSize: 9, fontWeight: '700', color: theme === 'dark' ? colors.text.secondary : palette.indigo500, textTransform: 'uppercase', letterSpacing: 0.5 },

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
        badgeOffer: { backgroundColor: colors.brand.primary },
        badgeNeed: { backgroundColor: palette.orange600 },
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
        roleText: { fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.3 },
        roleTextProvider: { color: colors.brand.dark },
        roleTextReceiver: { color: theme === 'dark' ? palette.indigo300 : palette.indigo600 },
        dateText: { fontSize: 10, fontWeight: '700', color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.3, flexShrink: 0, marginLeft: 8 },
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
    const [given, setGiven] = useState<any[]>([]);
    const [friendsCount, setFriendsCount] = useState(0);
    const [guardianCount, setGuardianCount] = useState(0);
    const [trust, setTrust] = useState<any>(null);
    const [viewerBalance, setViewerBalance] = useState<any>(null);
    const [vouching, setVouching] = useState(false);
    const [editingReview, setEditingReview] = useState<any | null>(null);

    const pubKeyStr = Array.isArray(publicKey) ? publicKey[0] : publicKey;
    const isSelf = !!identity?.publicKey && identity.publicKey === pubKeyStr;
    const callsignStr = (Array.isArray(callsign) ? callsign[0] : callsign) || (isSelf ? identity?.callsign : undefined);

    useEffect(() => {
        if (!pubKeyStr) {
            setLoading(false);
            setRatingsLoading(false);
            setTrustLoading(false);
            setGivenLoading(false);
            return;
        }

        // 1. Load local first-class database items instantly
        setLoading(true);
        Promise.all([
            getMemberProfile(pubKeyStr).catch(() => null),
            getMemberPosts(pubKeyStr).catch(() => []),
            isSelf ? getBalance(pubKeyStr).catch(() => null) : Promise.resolve(null),
            isSelf ? getFriendsLocal(pubKeyStr).catch(() => []) : Promise.resolve([]),
        ]).then(([prof, posts, bal, friends]) => {
            if (prof) setProfile(prof);
            if (posts) setActivePosts(posts);
            if (bal) setBalanceInfo(bal);
            if (Array.isArray(friends)) {
                setFriendsCount(friends.length);
                setGuardianCount(friends.filter((f: any) => f.isGuardian).length);
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
            getTrustProfile(pubKeyStr)
                .then(trustProfile => {
                    if (trustProfile) setTrust(trustProfile);
                })
                .catch(() => null)
                .finally(() => setTrustLoading(false));

            if (identity?.publicKey) {
                getBalance(identity.publicKey)
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
    }, [pubKeyStr, isSelf, identity?.publicKey]);

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
            else setTrust((t: any) => t ? { ...t, elderVouch: { callsign: identity?.callsign || 'a sponsor' } } : t);
        } catch (e: any) {
            Alert.alert('Could not vouch', e?.message || 'Please try again.');
        } finally {
            setVouching(false);
        }
    };

    // Let the voucher choose how much of a credit line to extend (their call on confidence).
    const chooseVouchLevel = () => {
        if (vouching || !pubKeyStr) return;
        Alert.alert(
            `Vouch for ${profile?.callsign || 'this member'}`,
            "Choose how deep a credit line to extend. This lets them trade on credit down to that floor — it reflects your confidence in them. No beans leave your wallet.",
            [
                { text: 'Light · −25', onPress: () => handleVouch(1) },
                { text: 'Standard · −50', onPress: () => handleVouch(2) },
                { text: 'Deep · −100', onPress: () => handleVouch(3) },
                { text: 'Cancel', style: 'cancel' },
            ]
        );
    };

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
                    <Text style={styles.backTextLabel}>Back</Text>
                </Pressable>
                <Text style={styles.headerTitle}>{isSelf ? 'My Profile' : 'Trust Profile'}</Text>
                {isSelf ? (
                    <Pressable accessibilityRole="button" style={styles.editBtn} onPress={() => router.push({ pathname: '/(tabs)/settings', params: { section: 'profile' } })}>
                        <MaterialCommunityIcons name="pencil" size={15} color={colors.brand.primary} />
                        <Text style={styles.editBtnText}>Edit</Text>
                    </Pressable>
                ) : (
                    <View style={{ width: 60 }} />
                )}
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                {/* Banner */}
                <View style={styles.banner}>
                    <View style={styles.avatarRing}>
                        <MemberAvatar avatarUrl={profile?.avatar_url} pubkey={pubKeyStr} callsign={callsignStr || '?'} size={80} enlargeable />
                    </View>
                    <View style={styles.nameRow}>
                        <Text style={styles.callsignText} numberOfLines={1}>{callsignStr}</Text>
                        <MaterialCommunityIcons name="check-decagram" size={22} color={colors.brand.primary} style={{ marginLeft: 6, marginTop: 2, flexShrink: 0 }} />
                    </View>
                    <Text style={styles.pubkeyText}>{pubKeyStr?.slice(0, 16)}...</Text>
                    {profile?.joined_at && (
                        <Text style={styles.joinedText} numberOfLines={1}>📅 Joined {new Date(profile.joined_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
                    )}
                    {/* Visual Reciprocity Health Ring / Badge (#4) — 50% larger */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.brand.tint, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 24, borderWidth: 1.5, borderColor: colors.brand.primary, marginTop: 10 }}>
                        <MaterialCommunityIcons name="circle-outline" size={22} color={colors.brand.primary} />
                        <Text style={{ fontSize: 18, fontWeight: '900', color: colors.brand.primary }}>
                            {trust?.completionRate === null || trust?.completionRate === undefined ? 100 : Math.round(trust.completionRate * 100)}% Reciprocity Health
                        </Text>
                    </View>
                    {profile?.bio && (
                        <Text style={styles.bioText}>"{profile.bio}"</Text>
                    )}
                </View>

                {/* Trust & safety (other members only) — the "is this person safe to trade with?" panel */}
                {!isSelf && (
                    trustLoading ? (
                        <View style={{ marginHorizontal: 16, marginTop: 16, padding: 20, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' }}>
                            <ActivityIndicator size="small" color={colors.brand.primary} />
                            <Text style={{ marginTop: 8, color: colors.text.muted, fontSize: 12, fontWeight: '600' }}>Calculating trust signals...</Text>
                        </View>
                    ) : trust ? (
                        <>
                            {/* Safety recommendation */}
                            {(() => {
                                const band = RISK_BAND[trust.risk?.band] || RISK_BAND.yellow;
                                return (
                                    <View style={[styles.safetyBanner, { backgroundColor: band.bg, borderColor: band.border }]}>
                                        <View style={styles.safetyHeaderRow}>
                                            <Text style={styles.safetyEmoji} allowFontScaling={false}>{band.emoji}</Text>
                                            <Text style={[styles.safetyHeadline, { color: band.text }]}>{trust.risk?.headline}</Text>
                                        </View>
                                        {(trust.risk?.reasons || []).map((r: string, i: number) => (
                                            <Text key={i} style={styles.safetyReason}>• {r}</Text>
                                        ))}
                                        {(trust.risk?.tips || []).length > 0 && (
                                            <View style={styles.safetyTips}>
                                                {trust.risk.tips.map((t: string, i: number) => (
                                                    <Text key={i} style={styles.safetyTip}>⚠️  {t}</Text>
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
                                        <Text style={styles.trustTierName} numberOfLines={1}>{trust.tier?.name || 'Member'}</Text>
                                        <View style={{ backgroundColor: colors.brand.tint, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: colors.brand.primary }}>
                                            <Text style={{ fontSize: 13, fontWeight: '900', color: colors.brand.primary }}>
                                                {Math.round(trust.earnedCredit || 0)} Trust Points
                                            </Text>
                                        </View>
                                    </View>
                                    <Text style={styles.trustSub} numberOfLines={1}>
                                        {[trust.joinedAt ? `Member since ${fmtMonthYear(trust.joinedAt)}` : '', fmtLastActive(trust.lastActiveAt)].filter(Boolean).join(' · ')}
                                    </Text>
                                    
                                    {/* Clear Nuanced Trust Explanation */}
                                    <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border.default }}>
                                        {(trust.stats?.tradeCount || 0) === 0 ? (
                                            <Text style={{ fontSize: 12, color: colors.text.secondary, lineHeight: 17, fontWeight: '500' }}>
                                                💡 <Text style={{ fontWeight: '700', color: colors.text.heading }}>New Member Notice:</Text> A low score simply means they are new to the community — not that they've done anything wrong! Complete a marketplace trade with them to help them build community trust.
                                            </Text>
                                        ) : (
                                            <Text style={{ fontSize: 12, color: colors.brand.primary, lineHeight: 17, fontWeight: '600' }}>
                                                🤝 <Text style={{ fontWeight: '800' }}>Proven Partner:</Text> Earned trust through {trust.stats?.tradeCount || 0} completed trade{(trust.stats?.tradeCount || 0) === 1 ? '' : 's'} across {trust.stats?.uniquePartners || 0} unique partner{(trust.stats?.uniquePartners || 0) === 1 ? '' : 's'}.
                                            </Text>
                                        )}
                                    </View>
                                </View>
                            </View>

                            {/* Track record */}
                            <View style={styles.statStrip}>
                                <View style={styles.statTile}>
                                    <Text style={styles.statTileNum} numberOfLines={1}>{trust.stats?.tradeCount ?? 0}</Text>
                                    <Text style={styles.statTileLabel} numberOfLines={1}>Trades</Text>
                                </View>
                                <View style={styles.statDivider} />
                                <View style={styles.statTile}>
                                    <Text style={styles.statTileNum} numberOfLines={1}>{trust.stats?.uniquePartners ?? 0}</Text>
                                    <Text style={styles.statTileLabel} numberOfLines={1}>Partners</Text>
                                </View>
                                <View style={styles.statDivider} />
                                <View style={styles.statTile}>
                                    <Text style={styles.statTileNum} numberOfLines={1}>{trust.completionRate === null || trust.completionRate === undefined ? '100%' : `${Math.round(trust.completionRate * 100)}%`}</Text>
                                    <Text style={styles.statTileLabel} numberOfLines={1}>Completion</Text>
                                </View>
                            </View>

                            {/* Mutual connections — the line that calms nerves */}
                            {trust.mutualCount > 0 && (
                                <View style={styles.mutualCard}>
                                    <Text style={styles.mutualTitle}>👥 {trust.mutualCount} connection{trust.mutualCount === 1 ? '' : 's'} in common</Text>
                                    {trust.mutualConnections.map((m: any) => (
                                        <Pressable
                                            key={m.publicKey}
                                            accessibilityRole="button"
                                            style={styles.mutualRow}
                                            onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: m.publicKey, callsign: m.callsign || '' } })}
                                        >
                                            <MemberAvatar avatarUrl={m.avatarUrl} pubkey={m.publicKey} callsign={m.callsign || '?'} size={32} />
                                            <Text style={styles.mutualName} numberOfLines={1}>{m.callsign || `${m.publicKey?.slice(0, 8)}…`}</Text>
                                            <Text style={styles.mutualAsk}>Ask about them ›</Text>
                                        </Pressable>
                                    ))}
                                </View>
                            )}

                            {/* Vouched in by / trusted as guardian */}
                            {(trust.vouchedInBy || trust.wardsCount > 0) && (
                                <View style={styles.vouchCard}>
                                    {trust.vouchedInBy && trust.vouchedInBy.kind === 'member' && (
                                        <Pressable
                                            accessibilityRole="button"
                                            style={styles.vouchInviterRow}
                                            onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: trust.vouchedInBy.publicKey, callsign: trust.vouchedInBy.callsign || '' } })}
                                        >
                                            <MemberAvatar avatarUrl={trust.vouchedInBy.avatarUrl} pubkey={trust.vouchedInBy.publicKey} callsign={trust.vouchedInBy.callsign || '?'} size={32} />
                                            <View style={{ flex: 1, minWidth: 0 }}>
                                                <Text style={styles.vouchInviterName} numberOfLines={1}>🌱 Vouched in by {trust.vouchedInBy.callsign}</Text>
                                                <Text style={styles.vouchInviterSub} numberOfLines={1}>{trust.vouchedInBy.tier} tier · tap to reach out</Text>
                                            </View>
                                            <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.secondary} />
                                        </Pressable>
                                    )}
                                    {trust.vouchedInBy && trust.vouchedInBy.kind !== 'member' && (
                                        <View style={styles.vouchInviterRow}>
                                            <View style={styles.systemBadge}>
                                                <MaterialCommunityIcons name="shield-check" size={20} color={colors.brand.primary} />
                                            </View>
                                            <View style={{ flex: 1, minWidth: 0 }}>
                                                <Text style={styles.vouchInviterName} numberOfLines={1}>
                                                    {trust.vouchedInBy.kind === 'founder' ? 'Founding member' : 'Invited directly by the system admin'}
                                                </Text>
                                                <Text style={styles.vouchInviterSub} numberOfLines={1}>
                                                    {trust.vouchedInBy.kind === 'founder' ? 'Here since the community began' : 'Vetted by the admin at sign-up'}
                                                </Text>
                                            </View>
                                        </View>
                                    )}
                                    {trust.wardsCount > 0 && (
                                        <Text style={styles.vouchLine} numberOfLines={2}>
                                            🛡️ {trust.wardsCount} {trust.wardsCount === 1 ? 'person trusts' : 'people trust'} them as a recovery guardian
                                        </Text>
                                    )}
                                </View>
                            )}

                            {/* Elder endorsement badge */}
                            {trust.elderVouch && (
                                <View style={[styles.vouchCard, { flexDirection: 'row', alignItems: 'center', gap: 8, borderColor: '#f59e0b' }]}>
                                    <Text style={{ fontSize: 18 }} allowFontScaling={false}>⛰️</Text>
                                    <Text style={styles.vouchInviterName} numberOfLines={1}>Vouched by {trust.elderVouch.callsign || 'an Elder'}</Text>
                                </View>
                            )}

                            {/* Vouch action — extend a credit line to this member (voucher picks the level) */}
                            {canVouch && (
                                <Pressable
                                    accessibilityRole="button"
                                    disabled={vouching}
                                    onPress={chooseVouchLevel}
                                    style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 12, backgroundColor: '#f59e0b', opacity: vouching ? 0.6 : 1 }}
                                    >
                                    <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }} allowFontScaling={false}>🤝 {vouching ? 'Vouching…' : 'Vouch for Member'}</Text>
                                </Pressable>
                            )}
                        </>
                    ) : null
                )}

                {/* Trust summary (self only) — links to the full Ledger */}
                {isSelf && balanceInfo && (
                    <Pressable accessibilityRole="button" style={styles.trustCard} onPress={() => router.push('/(tabs)/ledger')}>
                        <View style={styles.trustLeft}>
                            <Text style={styles.trustEmoji} allowFontScaling={false}>{balanceInfo.tier?.emoji || '🌱'}</Text>
                            <View style={{ flexShrink: 1 }}>
                                <Text style={styles.trustTierName} numberOfLines={1}>{balanceInfo.tier?.name || 'Member'}</Text>
                                <Text style={styles.trustSub} numberOfLines={1}>{Math.round(balanceInfo.earnedCredit || 0)} trust points</Text>
                            </View>
                        </View>
                        <View style={styles.trustRight}>
                            <View style={{ alignItems: 'flex-end' }}>
                                <Text style={styles.trustBalance}>{balanceInfo.balance >= 0 ? '+' : ''}{(balanceInfo.balance ?? 0).toFixed(1)}</Text>
                                <Text style={styles.trustSub}>Beans</Text>
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
                            <Text style={styles.statTileLabel} numberOfLines={1}>Friends</Text>
                        </Pressable>
                        <View style={styles.statDivider} />
                        <View style={styles.statTile}>
                            <Text style={styles.statTileNum} numberOfLines={1}>{balanceInfo?.trustStats?.tradeCount ?? 0}</Text>
                            <Text style={styles.statTileLabel} numberOfLines={1}>Trades</Text>
                        </View>
                        <View style={styles.statDivider} />
                        <Pressable accessibilityRole="button" style={styles.statTile} onPress={() => {
                            DeviceEventEmitter.emit('set_people_view', { view: 'guardians' });
                            router.push({ pathname: '/(tabs)/people', params: { view: 'guardians' } });
                        }}>
                            <Text style={[styles.statTileNum, guardianCount >= 3 ? { color: colors.brand.primary } : guardianCount === 0 ? { color: colors.feedback.danger.solid } : null]} numberOfLines={1}>{guardianCount}/5</Text>
                            <Text style={styles.statTileLabel} numberOfLines={1}>Guardians{guardianCount >= 3 ? ' ✓' : ''}</Text>
                        </Pressable>
                    </View>
                )}

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
                                     <Text style={styles.statValueOverall} numberOfLines={1}>{stats.average.toFixed(1)}</Text>
                                     <Text style={styles.statLabelOverall} numberOfLines={1}>OVERALL</Text>
                                 </View>
                                 <View style={styles.statBoxProvider}>
                                     <MaterialCommunityIcons name="inbox-arrow-up" size={26} color={colors.brand.primary} />
                                     <Text style={styles.statValueProvider} numberOfLines={1}>{stats.asProvider?.average.toFixed(1) || '-'}</Text>
                                     <Text style={styles.statLabelProvider} numberOfLines={1} adjustsFontSizeToFit>AS PROVIDER</Text>
                                 </View>
                                 <View style={styles.statBoxReceiver}>
                                     <MaterialCommunityIcons name="inbox-arrow-down" size={26} color={palette.indigo500} />
                                     <Text style={styles.statValueReceiver} numberOfLines={1}>{stats.asReceiver?.average.toFixed(1) || '-'}</Text>
                                     <Text style={styles.statLabelReceiver} numberOfLines={1} adjustsFontSizeToFit>AS RECEIVER</Text>
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
                                <Text style={[styles.tabText, activeTab === 'listings' && styles.tabTextActive]} numberOfLines={1} allowFontScaling={false}>
                                    Listings {activePosts.length > 0 ? `(${activePosts.length})` : ''}
                                </Text>
                            </Pressable>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ selected: activeTab === 'reviews' }}
                                style={[styles.tab, activeTab === 'reviews' && styles.tabActive]}
                                onPress={() => setActiveTab('reviews')}
                            >
                                <Text style={[styles.tabText, activeTab === 'reviews' && styles.tabTextActive]} numberOfLines={1} allowFontScaling={false}>
                                    {isSelf ? 'Received' : 'Reviews'} {ratings.length > 0 ? `(${ratings.length})` : ''}
                                </Text>
                            </Pressable>
                            {isSelf && (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: activeTab === 'given' }}
                                    style={[styles.tab, activeTab === 'given' && styles.tabActive]}
                                    onPress={() => setActiveTab('given')}
                                >
                                    <Text style={[styles.tabText, activeTab === 'given' && styles.tabTextActive]} numberOfLines={1} allowFontScaling={false}>
                                        Given {given.length > 0 ? `(${given.length})` : ''}
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
                                        <Text style={styles.emptyText}>No active listings.</Text>
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
                                                            <Image accessibilityLabel="Listing photo" source={{ uri: coverImage }} style={styles.dealThumb} />
                                                        ) : (
                                                            <View style={[styles.dealThumb, styles.dealThumbFallback]}>
                                                                <Text style={{ fontSize: 24, opacity: 0.4 }}>📦</Text>
                                                            </View>
                                                        )}
                                                        <View style={{ flex: 1, justifyContent: 'center' }}>
                                                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                                                                <View style={[styles.typeBadge, p.type === 'offer' ? styles.badgeOffer : styles.badgeNeed]}>
                                                                    <Text style={styles.typeBadgeText}>{p.type?.toUpperCase()}</Text>
                                                                </View>
                                                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                                    <Text style={styles.creditAmount}>{p.credits ?? '?'}</Text>
                                                                    <Image accessibilityElementsHidden={true} importantForAccessibility="no-hide-descendants" source={require('../assets/images/bean.png')} style={styles.beanIcon} />
                                                                </View>
                                                            </View>
                                                            <Text style={styles.dealTitle} numberOfLines={1}>{p.title}</Text>
                                                            <Text style={styles.dealDateText}>Active</Text>
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
                                        <Text style={styles.emptyText}>No reviews yet.</Text>
                                    </View>
                                ) : (
                                    ratings.map((r, i) => (
                                        <View key={i} style={styles.reviewCard}>
                                            <View style={styles.reviewHeader}>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                                                    <Text style={styles.starText} allowFontScaling={false} numberOfLines={1}>{renderStars(r.stars)}</Text>
                                                    <View style={[styles.roleBadge, { flexShrink: 1 }, r.role === 'provider' ? styles.roleBadgeProvider : styles.roleBadgeReceiver]}>
                                                        <Text style={[styles.roleText, r.role === 'provider' ? styles.roleTextProvider : styles.roleTextReceiver]} numberOfLines={1}>
                                                            {r.role === 'provider' ? 'Provided Service' : 'Received Service'}
                                                        </Text>
                                                    </View>
                                                </View>
                                                <Text style={styles.dateText}>
                                                    {new Date(r.createdAt || Date.now()).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase()}
                                                </Text>
                                            </View>
                                            {r.comment ? (
                                                <Text style={styles.commentText}>"{r.comment}"</Text>
                                            ) : (
                                                <Text style={styles.noCommentText}>No comment provided.</Text>
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
                                        <Text style={styles.emptyText}>You haven't reviewed anyone yet.</Text>
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
                                                    {new Date(r.created_at || Date.now()).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase()}
                                                </Text>
                                            </View>
                                            <Text style={styles.starText} allowFontScaling={false} numberOfLines={1}>{renderStars(r.stars)}</Text>
                                            {r.comment ? (
                                                <Text style={styles.commentText}>"{r.comment}"</Text>
                                            ) : (
                                                <Text style={styles.noCommentText}>No comment provided.</Text>
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
                                                            targetCallsign: r.target_callsign || 'Partner'
                                                        })}
                                                    >
                                                        <MaterialCommunityIcons name="pencil" size={12} color={colors.text.secondary} style={{ marginRight: 4 }} />
                                                        <Text style={styles.editReviewBtnText}>Edit Review</Text>
                                                    </Pressable>
                                                </View>
                                            )}
                                        </View>
                                    ))
                                )}
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
        </SafeAreaView>
    );
}


