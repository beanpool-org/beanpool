import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, SafeAreaView, Image, Alert, DeviceEventEmitter } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { getProjects, getBalance, voteForProjectApi, getActiveVotingRound } from '../../utils/db';
import { loadIdentity } from '../../utils/identity';
import { MemberAvatar } from '../../components/MemberAvatar';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { CommonsInfoModal } from '../../components/CommonsInfoModal';
import { hapticSuccess, hapticWarning, hapticTick } from '../../utils/haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme, useStyles } from '../ThemeContext';
import { palette } from '../../constants/colors';

export default function ProjectsScreen() {
    const { theme, colors } = useTheme();
    const [projects, setProjects] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [identity, setIdentity] = useState<any>(null);
    const [balanceState, setBalanceState] = useState<any>({ earnedCredit: 0, commons: 0 });
    const [activeRound, setActiveRound] = useState<any>(null);
    const [showCommonsInfo, setShowCommonsInfo] = useState(false);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.app },
        headerContainer: { marginBottom: 16 },
        headerInfo: { marginBottom: 16 },
        headerTitle: { fontSize: 24, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.5, marginBottom: 8 },
        headerDesc: { fontSize: 14, color: colors.text.secondary, lineHeight: 20 },
        govCreditsBanner: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.indigo100, padding: 12, borderRadius: 14, marginBottom: 12, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.indigo200 },
        govCreditsLabel: { fontSize: 13, color: theme === 'dark' ? colors.text.heading : palette.indigo600, fontWeight: '600' },
        govCreditsAmount: { fontSize: 16, color: theme === 'dark' ? colors.brand.primary : palette.indigo800, fontWeight: '800', fontFamily: 'Courier' },

        titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
        infoBtn: { padding: 4 },

        statCardRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
        statCard: { flex: 1, minWidth: 0, backgroundColor: colors.surface.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: colors.border.default },
        statCardLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
        statCardValueRow: { flexDirection: 'row', alignItems: 'center' },
        statCardAmount: { fontSize: 20, color: colors.text.heading, fontWeight: '800' },

        roundBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.feedback.info.bg, borderRadius: 14, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: colors.feedback.info.border },
        roundBannerTitle: { fontSize: 13, color: colors.feedback.info.fg, fontWeight: '700' },
        roundBannerSubtitle: { fontSize: 12, color: colors.feedback.info.solid, fontWeight: '500', marginTop: 2 },
        noRoundBanner: { backgroundColor: colors.surface.app, borderRadius: 14, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: colors.border.default },
        noRoundText: { fontSize: 12, color: colors.text.secondary, fontStyle: 'italic', textAlign: 'center' },
        sortContainer: { flexDirection: 'row', gap: 8 },
        sortBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default },
        sortBtnActive: { backgroundColor: colors.brand.primary, borderColor: colors.brand.dark },
        sortBtnText: { fontSize: 12, color: colors.text.secondary, fontWeight: '600' },
        sortBtnTextActive: { color: colors.text.inverse },
        listContainer: { padding: 16, paddingBottom: 100 },
        card: { backgroundColor: colors.surface.card, borderRadius: 16, marginBottom: 16, borderWidth: 1, borderColor: colors.border.default, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 3 },
        heroImage: { height: 120, width: '100%', justifyContent: 'flex-end', position: 'relative' },
        heroOverlay: { padding: 12, backgroundColor: 'rgba(0,0,0,0.4)' },
        cardTitle: { color: colors.text.inverse, fontSize: 18, fontWeight: '800', letterSpacing: -0.5 },
        fundedBadge: { position: 'absolute', top: 8, right: 8, backgroundColor: colors.brand.primary, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
        fundedBadgeText: { color: colors.text.inverse, fontSize: 10, fontWeight: 'bold' },
        editBadge: { position: 'absolute', top: 8, left: 8, backgroundColor: 'rgba(0,0,0,0.6)', padding: 8, borderRadius: 20 },
        cardBody: { padding: 16 },
        description: { fontSize: 14, color: colors.text.secondary, lineHeight: 20, marginBottom: 16 },
        metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
        proposedBy: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, marginRight: 8 },
        proposedByText: { fontSize: 12, color: colors.text.secondary, fontWeight: '500', flexShrink: 1 },
        proposedByCallsign: { color: colors.brand.primary, fontWeight: 'bold' },
        voteTriggerBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0, backgroundColor: theme === 'dark' ? 'rgba(16, 185, 129, 0.15)' : palette.emerald50, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: colors.brand.primary },
        voteTriggerBtnActive: { backgroundColor: colors.brand.primary },
        voteTriggerText: { fontSize: 12, fontWeight: '700', color: colors.brand.primary },
        votedMiniBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: theme === 'dark' ? 'rgba(16, 185, 129, 0.15)' : palette.emerald50, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
        votedMiniText: { fontSize: 11, color: colors.brand.dark, fontWeight: '600' },
        votingArea: { backgroundColor: colors.surface.subtle, borderRadius: 14, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: colors.border.default },
        stepperContainer: { alignItems: 'center' },
        stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 12 },
        stepperBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface.card, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: colors.border.strong, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
        stepperBtnText: { fontSize: 20, color: colors.text.secondary, marginTop: -2 },
        stepperValue: { fontSize: 18, fontWeight: '700', color: colors.text.body, width: 28, textAlign: 'center', fontFamily: 'Courier' },
        castBtn: { backgroundColor: colors.brand.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
        castBtnDisabled: { backgroundColor: colors.text.muted },
        castBtnText: { color: colors.text.inverse, fontSize: 14, fontWeight: 'bold' },
        stepperCostText: { fontSize: 11, color: colors.text.secondary, marginTop: 8, fontWeight: '500' },
        stepperCostTextError: { color: colors.feedback.danger.solid },
        stepperHintText: { fontSize: 11, color: colors.text.secondary, marginTop: 4, fontStyle: 'italic', textAlign: 'center' },
        progressSection: { marginTop: 4 },
        progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
        currentText: { fontSize: 13, fontWeight: 'bold', color: colors.text.body },
        currentTextFunded: { color: colors.brand.primary },
        faintText: { fontWeight: 'normal', color: colors.text.muted },
        goalText: { fontSize: 13, color: colors.text.muted, fontWeight: '500' },
        progressBarBg: { height: 8, width: '100%', backgroundColor: colors.surface.subtle, borderRadius: 4, overflow: 'hidden' },
        progressBarFill: { height: '100%', borderRadius: 4 },
        pledgeCardBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 14, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.brand.primary, shadowColor: colors.brand.dark, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
        pledgeCardBtnText: { color: colors.text.inverse, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
        emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, paddingHorizontal: 32 },
        emptyEmoji: { fontSize: 48, opacity: 0.3, marginBottom: 16 },
        emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8, textAlign: 'center' },
        emptyDesc: { fontSize: 14, color: colors.text.muted, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
        emptyBtn: { backgroundColor: colors.brand.primary, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12, shadowColor: colors.brand.dark, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
        emptyBtnText: { color: colors.text.inverse, fontSize: 14, fontWeight: '700' },
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

    // Sort & Vote state
    const [sortBy, setSortBy] = useState<'trending' | 'newest' | 'cost'>('trending');
    const [expandedVote, setExpandedVote] = useState<string | null>(null);
    const [voteSteppers, setVoteSteppers] = useState<Record<string, number>>({});
    const [votingInProgress, setVotingInProgress] = useState<string | null>(null);

    const loadData = useCallback(() => {
        let isActive = true;
        loadIdentity().then((id: any) => {
            if (isActive) {
                setIdentity(id);
                if (id?.publicKey) {
                    getBalance(id.publicKey).then(setBalanceState).catch(console.error);
                }
            }
        });
        getProjects().then((data) => {
            if (isActive) {
                setProjects(data);
                setLoading(false);
            }
        }).catch(err => {
            console.error(err);
            if (isActive) setLoading(false);
        });
        getActiveVotingRound().then(r => { if (isActive) setActiveRound(r); }).catch(() => {});
        return () => {
            isActive = false;
        };
    }, []);

    useFocusEffect(loadData);

    useEffect(() => {
        const sub = DeviceEventEmitter.addListener('sync_data_updated', loadData);
        return () => sub.remove();
    }, [loadData]);

    const sortedProjects = useMemo(() => {
        const projectsWithProgress = projects.map(p => {
            const progress = (p.current_amount / p.goal_amount) * 100 || 0;
            return { ...p, progress };
        });

        switch (sortBy) {
            case 'trending':
                return projectsWithProgress.sort((a, b) => b.progress - a.progress);
            case 'cost':
                return projectsWithProgress.sort((a, b) => b.goal_amount - a.goal_amount);
            case 'newest':
            default:
                // Fallback to sort by creation date descending if available, else by ID
                return projectsWithProgress.sort((a, b) => {
                    const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
                    const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
                    return dateB - dateA;
                });
        }
    }, [projects, sortBy]);

    const formatRoundCountdown = (closesAt: string | null) => {
        if (!closesAt) return 'No deadline set';
        const ms = new Date(closesAt).getTime() - Date.now();
        if (ms <= 0) return 'Closing now';
        const mins = Math.floor(ms / 60000);
        if (mins < 60) return `Closes in ${mins} minute${mins === 1 ? '' : 's'}`;
        const hours = Math.floor(mins / 60);
        if (hours < 48) return `Closes in ${hours} hour${hours === 1 ? '' : 's'}`;
        const days = Math.floor(hours / 24);
        return `Closes in ${days} day${days === 1 ? '' : 's'}`;
    };

    const getDaysRemaining = (deadline: string | null) => {
        if (!deadline) return null;
        const diff = new Date(deadline).getTime() - new Date().getTime();
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        if (days < 0) return 'Expired';
        if (days === 0) return 'Ends today';
        return `${days} days left`;
    };

    const renderItem = ({ item }: { item: any }) => {
        const progress = Math.min(100, item.progress);
        const isFunded = item.current_amount >= item.goal_amount;

        let parsedPhotos: string[] = [];
        try {
            if (item.photos) {
                parsedPhotos = typeof item.photos === 'string' ? JSON.parse(item.photos) : item.photos;
            }
        } catch(e) {
            console.error('[Projects] Error parsing photos:', e);
        }
        
        const heroUri = parsedPhotos.length > 0 ? parsedPhotos[0] : null;

        // Calculate total votes
        let parsedVotes = item.votes || [];
        if (typeof item.votes === 'string') {
            try { parsedVotes = JSON.parse(item.votes); } catch (e) { parsedVotes = []; }
        }
        
        const myVote = parsedVotes.find((v: any) => v.pubkey === identity?.publicKey);
        const hasVoted = !!myVote;
        
        const stepperVotes = voteSteppers[item.id] ?? 1;
        const stepperCost = stepperVotes * stepperVotes;
        const isOverBudget = stepperCost > balanceState.earnedCredit;
        const isExpanded = expandedVote === item.id;

        return (
            <Pressable
                accessibilityRole="button"
                style={styles.card}
                onPress={() => {
                    // Collapse expanded vote if tapping the card
                    if (isExpanded) {
                        setExpandedVote(null);
                        return;
                    }
                    router.push({
                        pathname: '/project-detail',
                        params: {
                            id: item.id,
                            title: item.title,
                            description: item.description,
                            goal: item.goal_amount,
                            current: item.current_amount,
                            creator_pubkey: item.creator_pubkey,
                            creator_callsign: item.creator_callsign
                        }
                    });
                }}
            >
                <View style={[styles.heroImage, { backgroundColor: colors.text.body }]}>
                    {heroUri && typeof heroUri === 'string' && heroUri.trim() !== '' && heroUri !== 'null' && heroUri !== 'undefined' && (
                        <Image accessibilityLabel="Project cover photo" source={{ uri: heroUri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                    )}
                    {isFunded && (
                        <View style={styles.fundedBadge}>
                            <Text style={styles.fundedBadgeText}>🎉 FUNDED</Text>
                        </View>
                    )}
                    {identity && item.creator_pubkey === identity.publicKey && (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Edit project"
                            style={styles.editBadge}
                            onPress={() => router.push({
                                pathname: '/edit-project',
                                params: { 
                                    id: item.id, 
                                    title: item.title, 
                                    description: item.description, 
                                    goal: item.goal_amount, 
                                    current: item.current_amount
                                } 
                            })}
                        >
                            <MaterialCommunityIcons name="pencil" size={16} color={colors.text.inverse} />
                        </Pressable>
                    )}
                    <View style={styles.heroOverlay}>
                        <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
                    </View>
                </View>

                <View style={styles.cardBody}>
                    <Text style={styles.description} numberOfLines={2}>
                        {item.description || 'No description provided.'}
                    </Text>

                    <View style={styles.metaRow}>
                        <Pressable
                            accessibilityRole="button"
                            style={styles.proposedBy}
                            onPress={(e) => {
                                e.stopPropagation();
                                router.push({ pathname: '/public-profile', params: { publicKey: item.creator_pubkey, callsign: item.creator_callsign || 'Unknown' } });
                            }}
                        >
                            <MemberAvatar avatarUrl={item.creator_avatar} pubkey={item.creator_pubkey || ''} callsign={item.creator_callsign || '?'} size={20} />
                            <Text style={styles.proposedByText} numberOfLines={1}>
                                Proposed by <Text style={styles.proposedByCallsign}>{item.creator_callsign || 'Unknown'}</Text>
                            </Text>
                        </Pressable>
                        
                        {/* Vote Button Trigger */}
                        {!isFunded && !hasVoted && (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ selected: isExpanded }}
                                style={[styles.voteTriggerBtn, isExpanded && styles.voteTriggerBtnActive]}
                                onPress={(e) => {
                                    e.stopPropagation();
                                    setExpandedVote(isExpanded ? null : item.id);
                                }}
                            >
                                <MaterialCommunityIcons name="vote" size={14} color={isExpanded ? colors.text.inverse : colors.brand.primary} />
                                <Text style={[styles.voteTriggerText, isExpanded && { color: colors.text.inverse }]}>Vote with Credits</Text>
                            </Pressable>
                        )}
                        {hasVoted && (
                            <View style={styles.votedMiniBadge}>
                                <MaterialCommunityIcons name="check-circle" size={12} color={colors.brand.primary} />
                                <Text style={styles.votedMiniText}>Voted</Text>
                            </View>
                        )}
                    </View>

                    {/* Expandable Voting Area */}
                    {isExpanded && !isFunded && !hasVoted && (
                        <View style={styles.votingArea}>
                            <View style={styles.stepperContainer}>
                                <View style={styles.stepperControls}>
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Decrease votes"
                                        style={styles.stepperBtn}
                                        onPress={(e) => { e.stopPropagation(); hapticTick(); setVoteSteppers(prev => ({ ...prev, [item.id]: Math.max(1, (prev[item.id] ?? 1) - 1) })); }}
                                    >
                                        <Text style={styles.stepperBtnText}>-</Text>
                                    </Pressable>
                                    <Text style={styles.stepperValue}>{stepperVotes}</Text>
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Increase votes"
                                        style={styles.stepperBtn}
                                        onPress={(e) => { e.stopPropagation(); hapticTick(); setVoteSteppers(prev => ({ ...prev, [item.id]: Math.min(10, (prev[item.id] ?? 1) + 1) })); }}
                                    >
                                        <Text style={styles.stepperBtnText}>+</Text>
                                    </Pressable>
                                    
                                    <Pressable
                                        accessibilityRole="button"
                                        style={[styles.castBtn, (votingInProgress === item.id || isOverBudget) && styles.castBtnDisabled]}
                                        disabled={votingInProgress === item.id || isOverBudget}
                                        onPress={async (e) => {
                                            e.stopPropagation();
                                            setVotingInProgress(item.id);
                                            try {
                                                await voteForProjectApi(item.id, stepperVotes);
                                                hapticSuccess();
                                                setExpandedVote(null);
                                                loadData();
                                            } catch (err: any) {
                                                hapticWarning();
                                                Alert.alert('Voting Failed', err.message);
                                            }
                                            setVotingInProgress(null);
                                        }}
                                    >
                                        <Text style={styles.castBtnText}>{votingInProgress === item.id ? '...' : 'Cast'}</Text>
                                    </Pressable>
                                </View>
                                <Text style={[styles.stepperCostText, isOverBudget && styles.stepperCostTextError]}>
                                    {stepperVotes} vote{stepperVotes > 1 ? 's' : ''} = {stepperCost} credits
                                </Text>
                                {isOverBudget && balanceState.earnedCredit === 0 && (
                                    <Text style={styles.stepperHintText}>
                                        Earn credits by completing trades to unlock voting.
                                    </Text>
                                )}
                            </View>
                        </View>
                    )}

                    <View style={styles.progressSection}>
                        <View style={styles.progressHeader}>
                            <Text style={[styles.currentText, isFunded && styles.currentTextFunded]}>
                                {item.current_amount} B <Text style={styles.faintText}>raised</Text>
                            </Text>
                            <View style={{ alignItems: 'flex-end' }}>
                                <Text style={styles.goalText}>Goal: {item.goal_amount} B</Text>
                                {item.deadline_at && (
                                    <Text style={{ fontSize: 10, color: getDaysRemaining(item.deadline_at) === 'Expired' ? colors.feedback.danger.solid : colors.accent.primary, marginTop: 2, fontWeight: 'bold' }}>
                                        {getDaysRemaining(item.deadline_at)}
                                    </Text>
                                )}
                            </View>
                        </View>
                        <View style={styles.progressBarBg}>
                            <View style={[styles.progressBarFill, { width: `${progress}%`, backgroundColor: isFunded ? colors.brand.primary : colors.accent.primary }]} />
                        </View>
                    </View>

                    {/* Primary CTA: pledge beans — this is fundamentally a crowdfunding system */}
                    {!isFunded && (
                        <Pressable
                            accessibilityRole="button"
                            style={styles.pledgeCardBtn}
                            onPress={(e) => {
                                e.stopPropagation();
                                router.push({
                                    pathname: '/project-detail',
                                    params: {
                                        id: item.id,
                                        title: item.title,
                                        description: item.description,
                                        goal: item.goal_amount,
                                        current: item.current_amount,
                                        creator_pubkey: item.creator_pubkey,
                                        creator_callsign: item.creator_callsign,
                                    },
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
        <SafeAreaView style={styles.safeArea}>
            <FlatList
                data={sortedProjects}
                keyExtractor={item => item.id}
                renderItem={renderItem}
                contentContainerStyle={styles.listContainer}
                ListHeaderComponent={
                    <View style={styles.headerContainer}>
                        <View style={styles.headerInfo}>
                            <View style={styles.titleRow}>
                                <Text style={styles.headerTitle}>🌱 Community Projects</Text>
                                <Pressable accessibilityRole="button" accessibilityLabel="About the Commons Pool" onPress={() => setShowCommonsInfo(true)} hitSlop={10} style={styles.infoBtn}>
                                    <MaterialCommunityIcons name="information-outline" size={22} color={colors.text.secondary} />
                                </Pressable>
                            </View>
                            <Text style={styles.headerDesc}>
                                Projects are funded through direct pledges and community circulation (demurrage). Propose an idea and let the community decide.
                            </Text>
                        </View>

                        {/* Commons Pool + My Governance Credits — two cards side by side */}
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

                        {/* Active round banner / no-round note */}
                        {activeRound ? (
                            <View style={styles.roundBanner}>
                                <MaterialCommunityIcons name="vote" size={18} color={colors.feedback.info.solid} />
                                <View style={{ flex: 1, marginLeft: 8 }}>
                                    <Text style={styles.roundBannerTitle}>Voting round open</Text>
                                    <Text style={styles.roundBannerSubtitle}>
                                        {formatRoundCountdown(activeRound.closesAt)} · {activeRound.projectIds?.length || 0} project{(activeRound.projectIds?.length || 0) === 1 ? '' : 's'}
                                    </Text>
                                </View>
                            </View>
                        ) : (
                            <View style={styles.noRoundBanner}>
                                <Text style={styles.noRoundText}>No active voting round. Propose a project or wait for the next round.</Text>
                            </View>
                        )}

                        {/* Sort Controls */}
                        <View style={styles.sortContainer}>
                            {(['trending', 'newest', 'cost'] as const).map(option => (
                                <Pressable
                                    key={option}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: sortBy === option }}
                                    style={[styles.sortBtn, sortBy === option && styles.sortBtnActive]}
                                    onPress={() => setSortBy(option)}
                                >
                                    <Text style={[styles.sortBtnText, sortBy === option && styles.sortBtnTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                                        {option.charAt(0).toUpperCase() + option.slice(1)}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                    </View>
                }
                ListEmptyComponent={
                    <View style={styles.emptyState}>
                        <Text style={styles.emptyEmoji}>🌱</Text>
                        <Text style={styles.emptyTitle}>No projects proposed yet</Text>
                        <Text style={styles.emptyDesc}>
                            Got an idea that benefits the community? Propose a project and get it funded through collective contributions.
                        </Text>
                        <Pressable accessibilityRole="button" style={styles.emptyBtn} onPress={async () => {
                            const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                            if (!anchorUrl) {
                                Alert.alert('Not Connected', 'Connect to a community first.', [
                                    { text: 'Cancel', style: 'cancel' },
                                    { text: 'Connect', onPress: () => router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } }) }
                                ]);
                                return;
                            }
                            router.push('/propose-project');
                        }}>
                            <Text style={styles.emptyBtnText}>+ Propose a Project</Text>
                        </Pressable>
                    </View>
                }
            />
            <Pressable accessibilityRole="button" accessibilityLabel="Propose a project" style={styles.fab} onPress={async () => {
                const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                if (!anchorUrl) {
                    Alert.alert('Not Connected', 'Connect to a community before proposing projects.', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Connect', onPress: () => router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } }) }
                    ]);
                    return;
                }
                router.push('/propose-project');
            }}>
                <MaterialCommunityIcons name="plus" size={30} color={colors.text.inverse} />
            </Pressable>

            <CommonsInfoModal
                isOpen={showCommonsInfo}
                onClose={() => setShowCommonsInfo(false)}
                commonsBalance={balanceState.commons || 0}
            />
        </SafeAreaView>
    );
}

// Styles defined dynamically inside ProjectsScreen component
