import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Image, Alert, DeviceEventEmitter, RefreshControl } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { getBalance, getActiveVotingRound, getTreasuries, getDecisions, getAllCommunityMembers, type DecisionWithTally, type TreasurySummary } from '../../utils/db';
import { loadIdentity } from '../../utils/identity';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { CommonsInfoModal } from '../../components/CommonsInfoModal';
import { DecideSection } from '../../components/DecideSection';
import { ProposeDecisionModal } from '../../components/ProposeDecisionModal';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme, useStyles } from '../ThemeContext';
import { palette } from '../../constants/colors';

export default function ProjectsScreen() {
    const { theme, colors } = useTheme();
    const [enterprises, setEnterprises] = useState<TreasurySummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [identity, setIdentity] = useState<any>(null);
    const [balanceState, setBalanceState] = useState<any>({ earnedCredit: 0, commons: 0 });
    const [activeRound, setActiveRound] = useState<any>(null);
    const [showCommonsInfo, setShowCommonsInfo] = useState(false);
    const [treasuries, setTreasuries] = useState<any[]>([]);
    const [membersList, setMembersList] = useState<Array<{ publicKey: string; callsign?: string; balance?: number }>>([]);
    const [activeSection, setActiveSection] = useState<'decide' | 'enterprises'>('decide');
    const [decisions, setDecisions] = useState<DecisionWithTally[]>([]);
    const [activeMembers30d, setActiveMembers30d] = useState<number>(0);
    const [showProposeDecision, setShowProposeDecision] = useState<boolean>(false);
    const [activeDecideView, setActiveDecideView] = useState<'open' | 'history'>('open');

    // Filter & sort states
    const [filter, setFilter] = useState<'all' | 'ongoing' | 'bounded'>('all');
    const [sortBy, setSortBy] = useState<'trending' | 'balance' | 'newest'>('trending');

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.app },
        headerContainer: { marginBottom: 16 },
        headerInfo: { marginBottom: 16 },
        titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
        headerTitle: { fontSize: 24, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.5 },
        headerDesc: { fontSize: 14, color: colors.text.secondary, lineHeight: 20 },
        infoBtn: { padding: 4 },
        treasuryPanelLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
        treasuryCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.card, borderRadius: 12, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: colors.border.default },
        treasuryAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface.subtle },
        treasuryAvatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
        treasuryName: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        treasuryMeta: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },
        treasuryBalance: { fontSize: 14, fontWeight: '800' },
        treasuryBalancePos: { color: colors.brand.primary },
        treasuryBalanceNeg: { color: colors.feedback.warning.solid },
        operatorBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.brand.tint, borderRadius: 10, padding: 8, marginTop: 2 },
        operatorBadgeText: { fontSize: 12, color: colors.brand.primary, fontWeight: '600', flex: 1 },

        statCardRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
        statCard: { flex: 1, minWidth: 0, backgroundColor: colors.surface.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: colors.border.default },
        statCardLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
        statCardValueRow: { flexDirection: 'row', alignItems: 'center' },
        statCardAmount: { fontSize: 20, color: colors.text.heading, fontWeight: '800' },

        sectionTabsRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
        sectionTabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 14, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        sectionTabBtnActive: { backgroundColor: colors.brand.tint, borderColor: colors.brand.primary },
        sectionTabText: { fontSize: 14, fontWeight: '700', color: colors.text.secondary },
        sectionTabTextActive: { color: colors.brand.primary },
        sectionBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, backgroundColor: colors.brand.primary },
        sectionBadgeText: { color: colors.text.inverse, fontSize: 11, fontWeight: '800' },

        roundBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.feedback.info.bg, borderRadius: 14, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: colors.feedback.info.border },
        roundBannerTitle: { fontSize: 13, color: colors.feedback.info.fg, fontWeight: '700' },
        roundBannerSubtitle: { fontSize: 12, color: colors.feedback.info.solid, fontWeight: '500', marginTop: 2 },

        filterRow: { flexDirection: 'row', gap: 8, marginTop: 4, marginBottom: 4 },
        filterBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default },
        filterBtnActive: { backgroundColor: colors.brand.primary, borderColor: colors.brand.dark },
        filterBtnText: { fontSize: 12, color: colors.text.secondary, fontWeight: '600' },
        filterBtnTextActive: { color: colors.text.inverse },

        listContainer: { padding: 16, paddingBottom: 100 },
        card: { backgroundColor: colors.surface.card, borderRadius: 16, marginBottom: 16, borderWidth: 1, borderColor: colors.border.default, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 3 },
        cardHeader: { flexDirection: 'row', alignItems: 'center', padding: 14, paddingBottom: 8, gap: 12 },
        avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface.subtle },
        avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border.default },
        cardTitleCol: { flex: 1, minWidth: 0 },
        titleBadgeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
        cardTitle: { fontSize: 17, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.3, flex: 1 },
        cardMeta: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },

        badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, alignSelf: 'flex-start' },
        badgeOngoing: { backgroundColor: colors.brand.tint },
        badgeOngoingText: { fontSize: 10, fontWeight: '800', color: colors.brand.primary, letterSpacing: 0.5 },
        badgeProject: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.indigo100 },
        badgeProjectText: { fontSize: 10, fontWeight: '800', color: theme === 'dark' ? colors.brand.primary : palette.indigo600, letterSpacing: 0.5 },
        badgeFunded: { backgroundColor: colors.brand.primary },
        badgeFundedText: { fontSize: 10, fontWeight: '800', color: colors.text.inverse, letterSpacing: 0.5 },

        cardBody: { paddingHorizontal: 14, paddingBottom: 14 },
        purposeText: { fontSize: 14, color: colors.text.body, lineHeight: 20, marginBottom: 12 },
        purposeTextPlaceholder: { fontStyle: 'italic', color: colors.text.muted },

        financeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface.app, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: colors.border.default },
        financeLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
        balanceText: { fontSize: 16, fontWeight: '900' },
        balancePos: { color: colors.brand.primary },
        balanceNeg: { color: colors.feedback.warning.solid },
        deficitWarning: { fontSize: 10, color: colors.feedback.warning.solid, fontWeight: '700', marginTop: 1 },

        progressSection: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border.default },
        progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 6 },
        currentText: { fontSize: 13, fontWeight: 'bold', color: colors.text.body },
        currentTextFunded: { color: colors.brand.primary },
        goalText: { fontSize: 12, color: colors.text.secondary, fontWeight: '500' },
        progressBarBg: { height: 7, width: '100%', backgroundColor: colors.surface.subtle, borderRadius: 4, overflow: 'hidden' },
        progressBarFill: { height: '100%', borderRadius: 4 },
        deadlineText: { fontSize: 11, fontWeight: '700', color: colors.brand.primary, marginTop: 4 },
        deadlineExpired: { color: colors.feedback.danger.solid },

        pledgeCardBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.brand.primary },
        pledgeCardBtnText: { color: colors.text.inverse, fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },

        emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, paddingHorizontal: 32 },
        emptyEmoji: { fontSize: 48, opacity: 0.4, marginBottom: 16 },
        emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8, textAlign: 'center' },
        emptyDesc: { fontSize: 14, color: colors.text.muted, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
        emptyBtn: { backgroundColor: colors.brand.primary, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12, shadowColor: colors.brand.dark, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
        emptyBtnText: { color: colors.text.inverse, fontSize: 14, fontWeight: '700' },

        skeletonCard: { backgroundColor: colors.surface.card, borderRadius: 16, marginBottom: 16, borderWidth: 1, borderColor: colors.border.default, padding: 16, gap: 12 },
        skeletonLineTitle: { height: 18, width: '60%', borderRadius: 6, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.grayAlt100 },
        skeletonLineDesc: { height: 14, width: '90%', borderRadius: 4, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.grayAlt100 },
        skeletonLineProgress: { height: 8, width: '100%', borderRadius: 4, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.grayAlt100, marginTop: 4 },

        fab: {
            position: 'absolute',
            bottom: 24,
            right: 24,
            width: 60,
            height: 60,
            borderRadius: 30,
            backgroundColor: colors.brand.primary,
            justifyContent: 'center',
            alignItems: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.3,
            shadowRadius: 5,
            elevation: 6
        }
    }));

    const loadData = useCallback(async () => {
        try {
            const id = await loadIdentity();
            setIdentity(id);
            if (id?.publicKey) {
                getBalance(id.publicKey).then(setBalanceState).catch(console.error);
            }
        } catch (e) {
            console.error('[Commons] Failed loading identity:', e);
        }

        try {
            const list = await getTreasuries();
            setEnterprises(list);
            setLoading(false);
        } catch (err) {
            console.error('[Commons] Failed loading enterprises:', err);
            setLoading(false);
        }

        try {
            const r = await getActiveVotingRound();
            setActiveRound(r);
        } catch {}

        try {
            const decData = await getDecisions();
            setDecisions(decData.decisions || []);
            setActiveMembers30d(decData.activeMembers30d || 0);
        } catch (err) {
            console.error('[Projects] Failed loading decisions:', err);
        }

        try {
            const mems = await getAllCommunityMembers();
            setMembersList(mems || []);
        } catch (err) {
            console.error('[Projects] Failed loading members:', err);
        }
    }, []);

    const canProposeDecision = (balanceState.earnedCredit || 0) > 0;
    const hasOpenDecision = useMemo(() => {
        if (!identity?.publicKey) return false;
        return decisions.some(d => d.authorPubkey === identity.publicKey && d.status === 'open');
    }, [decisions, identity]);
    const openDecisionsCount = useMemo(() => {
        return decisions.filter(d => d.status === 'open').length;
    }, [decisions]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            const { requestSync } = await import('../../services/pillar-sync');
            await requestSync();
        } catch (e) {
            console.warn('[Commons] Sync error during refresh:', e);
        }
        await loadData();
        setRefreshing(false);
    }, [loadData]);

    useFocusEffect(
        useCallback(() => {
            loadData();
        }, [loadData])
    );

    useEffect(() => {
        const sub = DeviceEventEmitter.addListener('sync_data_updated', loadData);
        return () => sub.remove();
    }, [loadData]);

    const getDaysRemaining = (deadline: string | null | undefined) => {
        if (!deadline) return null;
        const diff = new Date(deadline).getTime() - new Date().getTime();
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        if (days < 0) return 'Expired';
        if (days === 0) return 'Ends today';
        return `${days} days left`;
    };

    const filteredEnterprises = useMemo(() => {
        let list = [...enterprises];

        // Filter
        if (filter === 'ongoing') {
            list = list.filter(e => e.lifecycle !== 'bounded' && (!e.goalAmount || e.goalAmount <= 0));
        } else if (filter === 'bounded') {
            list = list.filter(e => e.lifecycle === 'bounded' || (e.goalAmount != null && e.goalAmount > 0));
        }

        // Sort
        switch (sortBy) {
            case 'balance':
                return list.sort((a, b) => (b.balance || 0) - (a.balance || 0));
            case 'trending':
                return list.sort((a, b) => {
                    const aBounded = a.goalAmount != null && a.goalAmount > 0;
                    const bBounded = b.goalAmount != null && b.goalAmount > 0;
                    if (aBounded && !bBounded) return -1;
                    if (!aBounded && bBounded) return 1;
                    return (b.liveOffers || 0) - (a.liveOffers || 0);
                });
            case 'newest':
            default:
                return list;
        }
    }, [enterprises, filter, sortBy]);

    const renderItem = ({ item }: { item: TreasurySummary }) => {
        const hasGoal = item.goalAmount != null && item.goalAmount > 0;
        const currentRaised = item.currentAmount != null ? item.currentAmount : Math.max(0, item.balance);
        const goalAmount = item.goalAmount || 1;
        const progress = Math.min(100, (currentRaised / goalAmount) * 100);
        const isFunded = hasGoal && (currentRaised >= goalAmount || item.status === 'funded' || item.status === 'completed');
        const daysRemaining = getDaysRemaining(item.deadlineAt);

        return (
            <Pressable
                accessibilityRole="button"
                style={styles.card}
                onPress={() => {
                    router.push({
                        pathname: '/treasury-detail',
                        params: {
                            publicKey: item.publicKey,
                            name: item.name || item.callsign,
                            avatar: item.avatar || item.avatarUrl || ''
                        }
                    });
                }}
            >
                <View style={styles.cardHeader}>
                    {item.avatar ? (
                        <Image source={{ uri: item.avatar }} style={styles.avatar} accessibilityLabel="Enterprise avatar" />
                    ) : (
                        <View style={[styles.avatar, styles.avatarPlaceholder]}>
                            <Text style={{ fontSize: 22 }}>{hasGoal ? '🌱' : '🏛️'}</Text>
                        </View>
                    )}
                    <View style={styles.cardTitleCol}>
                        <View style={styles.titleBadgeRow}>
                            <Text style={styles.cardTitle} numberOfLines={1}>{item.name || item.callsign}</Text>
                            {isFunded ? (
                                <View style={[styles.badge, styles.badgeFunded]}>
                                    <Text style={styles.badgeFundedText}>🎉 FUNDED</Text>
                                </View>
                            ) : hasGoal ? (
                                <View style={[styles.badge, styles.badgeProject]}>
                                    <Text style={styles.badgeProjectText}>🌱 PROJECT</Text>
                                </View>
                            ) : (
                                <View style={[styles.badge, styles.badgeOngoing]}>
                                    <Text style={styles.badgeOngoingText}>🏛️ ONGOING</Text>
                                </View>
                            )}
                        </View>
                        <Text style={styles.cardMeta}>
                            {item.liveOffers} live offer{item.liveOffers === 1 ? '' : 's'}
                            {item.keepers && item.keepers.length > 0 ? ` · ${item.keepers.length} keeper${item.keepers.length === 1 ? '' : 's'}` : ''}
                        </Text>
                    </View>
                </View>

                <View style={styles.cardBody}>
                    {/* Purpose Statement (docs §4) */}
                    <Text
                        style={[styles.purposeText, !item.purpose && styles.purposeTextPlaceholder]}
                        numberOfLines={2}
                    >
                        {item.purpose || 'No stated purpose yet.'}
                    </Text>

                    {/* Financial summary row */}
                    <View style={styles.financeRow}>
                        <View>
                            <Text style={styles.financeLabel}>Enterprise Balance</Text>
                            {item.balance < 0 && (
                                <Text style={styles.deficitWarning}>in deficit (keepers eat last)</Text>
                            )}
                        </View>
                        <Text style={[styles.balanceText, item.balance < 0 ? styles.balanceNeg : styles.balancePos]}>
                            {item.balance} 🫘
                        </Text>
                    </View>

                    {/* Funding progress if Bounded / Project */}
                    {hasGoal && (
                        <View style={styles.progressSection}>
                            <View style={styles.progressHeader}>
                                <Text style={[styles.currentText, isFunded && styles.currentTextFunded]}>
                                    {currentRaised} 🫘 <Text style={{ fontWeight: 'normal', color: colors.text.secondary }}>raised</Text>
                                </Text>
                                <Text style={styles.goalText}>Goal: {item.goalAmount} 🫘</Text>
                            </View>
                            <View style={styles.progressBarBg}>
                                <View
                                    style={[
                                        styles.progressBarFill,
                                        { width: `${progress}%`, backgroundColor: isFunded ? colors.brand.primary : colors.accent.primary }
                                    ]}
                                />
                            </View>
                            {daysRemaining && (
                                <Text style={[styles.deadlineText, daysRemaining === 'Expired' && styles.deadlineExpired]}>
                                    ⏳ {daysRemaining}
                                </Text>
                            )}
                        </View>
                    )}

                    {/* Primary CTA if has goal and not funded */}
                    {hasGoal && !isFunded && (
                        <View style={styles.pledgeCardBtn} aria-hidden={true}>
                            <MaterialCommunityIcons name="sprout" size={16} color={colors.text.inverse} />
                            <Text style={styles.pledgeCardBtnText}>Pledge Beans</Text>
                        </View>
                    )}
                </View>
            </Pressable>
        );
    };

    return (
        <View style={styles.safeArea}>
            <FlatList
                data={filteredEnterprises}
                keyExtractor={item => item.publicKey}
                renderItem={renderItem}
                contentContainerStyle={styles.listContainer}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor={colors.brand.primary}
                        colors={[colors.brand.primary]}
                    />
                }
                ListHeaderComponent={
                    <View style={styles.headerContainer}>
                        <View style={styles.headerInfo}>
                            <View style={styles.titleRow}>
                                <Text style={styles.headerTitle}>🌱 The Commons</Text>
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel="About the Commons Pool"
                                    onPress={() => setShowCommonsInfo(true)}
                                    hitSlop={10}
                                    style={styles.infoBtn}
                                >
                                    <MaterialCommunityIcons name="information-outline" size={22} color={colors.text.secondary} />
                                </Pressable>
                            </View>
                            <Text style={styles.headerDesc}>
                                Community decisions, pooled circulation, and shared enterprises. Propose binding actions and vote on what matters.
                            </Text>
                        </View>

                        {/* Commons Pool + My Governance Credits */}
                        <View style={styles.statCardRow}>
                            <View style={styles.statCard}>
                                <Text style={styles.statCardLabel} numberOfLines={2}>Commons Pool</Text>
                                <View style={styles.statCardValueRow}>
                                    <CurrencyDisplay amount={(balanceState.commons || 0).toFixed(2)} style={styles.statCardAmount} />
                                </View>
                            </View>
                            <View style={styles.statCard}>
                                <Text style={styles.statCardLabel} numberOfLines={2}>My Available Governance Credits</Text>
                                <Text style={styles.statCardAmount} numberOfLines={1}>{balanceState.earnedCredit || 0}</Text>
                            </View>
                        </View>

                        {/* Section Switcher: Decide vs Enterprises */}
                        <View style={styles.sectionTabsRow}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Decide Section"
                                style={[styles.sectionTabBtn, activeSection === 'decide' && styles.sectionTabBtnActive]}
                                onPress={() => setActiveSection('decide')}
                            >
                                <MaterialCommunityIcons
                                    name="vote"
                                    size={18}
                                    color={activeSection === 'decide' ? colors.brand.primary : colors.text.secondary}
                                />
                                <Text style={[styles.sectionTabText, activeSection === 'decide' && styles.sectionTabTextActive]}>
                                    Decide
                                </Text>
                                {openDecisionsCount > 0 && (
                                    <View style={styles.sectionBadge}>
                                        <Text style={styles.sectionBadgeText}>{openDecisionsCount}</Text>
                                    </View>
                                )}
                            </Pressable>

                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Enterprises Section"
                                style={[styles.sectionTabBtn, activeSection === 'enterprises' && styles.sectionTabBtnActive]}
                                onPress={() => setActiveSection('enterprises')}
                            >
                                <MaterialCommunityIcons
                                    name="office-building"
                                    size={18}
                                    color={activeSection === 'enterprises' ? colors.brand.primary : colors.text.secondary}
                                />
                                <Text style={[styles.sectionTabText, activeSection === 'enterprises' && styles.sectionTabTextActive]}>
                                    Enterprises
                                </Text>
                            </Pressable>
                        </View>

                        {activeSection === 'decide' ? (
                            <DecideSection
                                decisions={decisions}
                                activeMembers30d={activeMembers30d}
                                identity={identity}
                                balanceState={balanceState}
                                onRefresh={loadData}
                                onOpenPropose={() => {
                                    if (!canProposeDecision) {
                                        Alert.alert('Standing Required', 'Proposing a Decision requires earned trade standing (earnedCredit > 0).');
                                        return;
                                    }
                                    if (hasOpenDecision) {
                                        Alert.alert('Limit Reached', 'You already have an open decision (limit 1 open decision per author).');
                                        return;
                                    }
                                    setShowProposeDecision(true);
                                }}
                                canPropose={canProposeDecision}
                                hasOpenDecision={hasOpenDecision}
                                activeView={activeDecideView}
                                onChangeView={setActiveDecideView}
                            />
                        ) : (
                            <>
                                {/* Community Treasuries — the Commons' trading accounts (eggs, etc.) */}
                        {treasuries.length > 0 && (
                            <View style={{ marginBottom: 12 }}>
                                <Text style={styles.treasuryPanelLabel}>🏛️ Community Treasuries</Text>
                                {treasuries.map((t: any, index: number) => (
                                    <Pressable
                                        key={t.publicKey || `treasury-${index}`}
                                        style={styles.treasuryCard}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Open ${t.name} treasury`}
                                        onPress={() => {
                                            if (!t.publicKey) return;
                                            router.push({ pathname: '/treasury-detail', params: { publicKey: t.publicKey, name: t.name, avatar: t.avatar } });
                                        }}
                                    >
                                        {t.avatar ? (
                                            <Image source={{ uri: t.avatar }} style={styles.treasuryAvatar} />
                                        ) : (
                                            <View style={[styles.treasuryAvatar, styles.treasuryAvatarPlaceholder]}><Text style={{ fontSize: 18 }}>🏛️</Text></View>
                                        )}
                                        <View style={{ flex: 1, marginLeft: 10, minWidth: 0 }}>
                                            <Text style={styles.treasuryName} numberOfLines={1}>{t.name}</Text>
                                            <Text style={styles.treasuryMeta}>{t.liveOffers} live offer{t.liveOffers === 1 ? '' : 's'}</Text>
                                        </View>
                                        <Text style={[styles.treasuryBalance, t.balance < 0 ? styles.treasuryBalanceNeg : styles.treasuryBalancePos]}>{t.balance} 🫘</Text>
                                        <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.muted} style={{ marginLeft: 4 }} />
                                    </Pressable>
                                ))}
                                {balanceState.canOperate && (
                                    <View style={styles.operatorBadge}>
                                        <MaterialCommunityIcons name="shield-account" size={14} color={colors.brand.primary} />
                                        <Text style={styles.operatorBadgeText}>You can operate treasuries — post their offers & pay tenders</Text>
                                    </View>
                                )}
                            </View>
                        )}

                        {/* Active round banner if any */}
                        {activeRound && (
                            <View style={styles.roundBanner}>
                                <MaterialCommunityIcons name="vote" size={18} color={colors.feedback.info.solid} />
                                <View style={{ flex: 1, marginLeft: 8 }}>
                                    <Text style={styles.roundBannerTitle}>Voting round open</Text>
                                    <Text style={styles.roundBannerSubtitle}>
                                        {activeRound.projectIds?.length || 0} proposal{(activeRound.projectIds?.length || 0) === 1 ? '' : 's'}
                                    </Text>
                                </View>
                            </View>
                        )}

                        {/* Filter Controls: All / Ongoing / Bounded */}
                        <View style={styles.filterRow}>
                            {(['all', 'ongoing', 'bounded'] as const).map(option => (
                                <Pressable
                                    key={option}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: filter === option }}
                                    style={[styles.filterBtn, filter === option && styles.filterBtnActive]}
                                    onPress={() => setFilter(option)}
                                >
                                    <Text style={[styles.filterBtnText, filter === option && styles.filterBtnTextActive]}>
                                        {option === 'all' ? 'All Enterprises' : option === 'ongoing' ? 'Ongoing' : 'Bounded Projects'}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                            </>
                        )}
                    </View>
                }
                ListEmptyComponent={
                    activeSection === 'decide' ? null : (
                        loading ? (
                            <View style={{ gap: 16 }}>
                                <View style={styles.skeletonCard}>
                                    <View style={styles.skeletonLineTitle} />
                                    <View style={styles.skeletonLineDesc} />
                                    <View style={styles.skeletonLineProgress} />
                                </View>
                                <View style={styles.skeletonCard}>
                                    <View style={styles.skeletonLineTitle} />
                                    <View style={styles.skeletonLineDesc} />
                                    <View style={styles.skeletonLineProgress} />
                                </View>
                            </View>
                        ) : (
                            <View style={styles.emptyState}>
                                <Text style={styles.emptyEmoji}>🌱</Text>
                                <Text style={styles.emptyTitle}>No enterprises proposed yet</Text>
                                <Text style={styles.emptyDesc}>
                                    Got an idea that benefits the community? Start an enterprise or propose a project to get started.
                                </Text>
                                <Pressable
                                    accessibilityRole="button"
                                    style={styles.emptyBtn}
                                    onPress={async () => {
                                        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                                        if (!anchorUrl) {
                                            Alert.alert('Not Connected', 'Connect to a community first.', [
                                                { text: 'Cancel', style: 'cancel' },
                                                { text: 'Connect', onPress: () => router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } }) }
                                            ]);
                                            return;
                                        }
                                        router.push('/propose-project');
                                    }}
                                >
                                    <Text style={styles.emptyBtnText}>+ Propose a Project</Text>
                                </Pressable>
                            </View>
                        )
                    )
                }
            />
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={activeSection === 'decide' ? "Propose a decision" : "Propose a project or start an enterprise"}
                style={styles.fab}
                onPress={async () => {
                    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                    if (!anchorUrl) {
                        Alert.alert('Not Connected', 'Connect to a community before proposing projects.', [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Connect', onPress: () => router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } }) }
                        ]);
                        return;
                    }
                    if (activeSection === 'decide') {
                        if (!canProposeDecision) {
                            Alert.alert('Standing Required', 'Proposing a Decision requires earned trade standing (earnedCredit > 0).');
                            return;
                        }
                        if (hasOpenDecision) {
                            Alert.alert('Limit Reached', 'You already have an open decision (limit 1 open decision per author).');
                            return;
                        }
                        setShowProposeDecision(true);
                    } else {
                        router.push('/propose-project');
                    }
                }}
            >
                <MaterialCommunityIcons name="plus" size={30} color={colors.text.inverse} />
            </Pressable>

            <CommonsInfoModal
                isOpen={showCommonsInfo}
                onClose={() => setShowCommonsInfo(false)}
                commonsBalance={balanceState.commons || 0}
            />

            <ProposeDecisionModal
                isOpen={showProposeDecision}
                onClose={() => setShowProposeDecision(false)}
                onCreated={loadData}
                identity={identity}
                commonsBalance={balanceState.commons || 0}
                treasuries={treasuries}
                members={membersList}
            />
        </View>
    );
}
