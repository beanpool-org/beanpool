import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Image, Alert, DeviceEventEmitter, RefreshControl } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { getBalance, getActiveVotingRound, getTreasuries, type TreasurySummary } from '../../utils/db';
import { loadIdentity } from '../../utils/identity';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { CommonsInfoModal } from '../../components/CommonsInfoModal';
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

        statCardRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
        statCard: { flex: 1, minWidth: 0, backgroundColor: colors.surface.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: colors.border.default },
        statCardLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
        statCardValueRow: { flexDirection: 'row', alignItems: 'center' },
        statCardAmount: { fontSize: 20, color: colors.text.heading, fontWeight: '800' },

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
    }, []);

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
        const isFunded = hasGoal && currentRaised >= goalAmount;
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
                        <Pressable
                            accessibilityRole="button"
                            style={styles.pledgeCardBtn}
                            onPress={(e) => {
                                e.stopPropagation();
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
                            <MaterialCommunityIcons name="sprout" size={16} color={colors.text.inverse} />
                            <Text style={styles.pledgeCardBtnText}>Pledge Beans</Text>
                        </Pressable>
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
                                Community enterprises trade, produce, and steward shared initiatives. Bounded initiatives raise beans toward specific community goals.
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
                    </View>
                }
                ListEmptyComponent={
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
                }
            />
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Propose a project or start an enterprise"
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
                    router.push('/propose-project');
                }}
            >
                <MaterialCommunityIcons name="plus" size={30} color={colors.text.inverse} />
            </Pressable>

            <CommonsInfoModal
                isOpen={showCommonsInfo}
                onClose={() => setShowCommonsInfo(false)}
                commonsBalance={balanceState.commons || 0}
            />
        </View>
    );
}
