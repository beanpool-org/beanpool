import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, SafeAreaView, Image, Alert, DeviceEventEmitter, ScrollView } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { getProjects, getBalance, voteForProjectApi, getActiveVotingRound, getTreasuries, fetchGroups, joinGroupApi, type GroupItem } from '../../utils/db';
import { loadIdentity } from '../../utils/identity';
import { MemberAvatar } from '../../components/MemberAvatar';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { CommonsInfoModal } from '../../components/CommonsInfoModal';
import { CreateGroupModal } from '../../components/CreateGroupModal';
import { GroupDetailModal } from '../../components/GroupDetailModal';
import { hapticSuccess, hapticWarning, hapticTick } from '../../utils/haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme, useStyles } from '../ThemeContext';
import { palette } from '../../constants/colors';

export default function ProjectsScreen() {
    const { theme, colors } = useTheme();
    const [tabSegment, setTabSegment] = useState<'projects' | 'groups'>('projects');
    const [projects, setProjects] = useState<any[]>([]);
    const [groups, setGroups] = useState<GroupItem[]>([]);
    const [selectedGroupCategory, setSelectedGroupCategory] = useState<string>('all');
    const [selectedGroupForDetail, setSelectedGroupForDetail] = useState<GroupItem | null>(null);
    const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
    const [loading, setLoading] = useState(true);
    const [identity, setIdentity] = useState<any>(null);
    const [balanceState, setBalanceState] = useState<any>({ earnedCredit: 0, commons: 0 });
    const [activeRound, setActiveRound] = useState<any>(null);
    const [showCommonsInfo, setShowCommonsInfo] = useState(false);
    const [treasuries, setTreasuries] = useState<any[]>([]);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.app },
        segmentRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 8 },
        segmentBtn: { flex: 1, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border.default },
        segmentBtnActive: { backgroundColor: colors.brand.primary, borderColor: colors.brand.dark },
        segmentBtnText: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
        segmentBtnTextActive: { color: colors.text.inverse },
        headerContainer: { marginBottom: 16 },
        headerInfo: { marginBottom: 16 },
        headerTitle: { fontSize: 24, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.5, marginBottom: 8 },
        headerDesc: { fontSize: 14, color: colors.text.secondary, lineHeight: 20 },
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
        groupCard: { backgroundColor: colors.surface.card, borderRadius: 16, marginBottom: 14, padding: 16, borderWidth: 1, borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 6, elevation: 2 },
        groupHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
        groupIconWrap: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
        groupTitleWrap: { flex: 1 },
        groupName: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        groupCategoryBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
        groupCategoryText: { fontSize: 12, color: colors.text.secondary, textTransform: 'capitalize' },
        groupDesc: { fontSize: 13, color: colors.text.secondary, lineHeight: 18, marginBottom: 12 },
        groupFooterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border.default },
        groupMetaText: { fontSize: 12, color: colors.text.muted, fontWeight: '600' },
        groupRoleBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: colors.surface.subtle },
        groupRoleBadgeSteward: { backgroundColor: colors.brand.tint },
        groupRoleText: { fontSize: 11, fontWeight: '700', color: colors.text.secondary },
        groupRoleTextSteward: { color: colors.brand.primary },
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
                    getTreasuries().then(setTreasuries).catch(() => {});
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
        fetchGroups().then((g) => {
            if (isActive) setGroups(g);
        }).catch(err => console.warn('[Projects] fetchGroups err:', err));

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

    const filteredGroups = useMemo(() => {
        if (selectedGroupCategory === 'all') return groups;
        return groups.filter(g => g.category === selectedGroupCategory);
    }, [groups, selectedGroupCategory]);

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

    const getCategoryIcon = (category: string) => {
        switch (category) {
            case 'enterprise': return 'office-building';
            case 'project': return 'hammer-wrench';
            case 'guild': return 'shield-star';
            case 'working_group': return 'account-group';
            case 'social': return 'coffee';
            default: return 'flag';
        }
    };

    const renderGroupItem = ({ item }: { item: GroupItem }) => {
        const isSteward = item.myRole === 'steward' || item.createdBy === identity?.publicKey;
        const isMember = !!item.myRole;

        return (
            <Pressable
                accessibilityRole="button"
                style={styles.groupCard}
                onPress={() => setSelectedGroupForDetail(item)}
            >
                <View style={styles.groupHeaderRow}>
                    <View style={styles.groupIconWrap}>
                        <MaterialCommunityIcons name={getCategoryIcon(item.category) as any} size={22} color={colors.brand.primary} />
                    </View>
                    <View style={styles.groupTitleWrap}>
                        <Text style={styles.groupName} numberOfLines={1}>{item.name}</Text>
                        <View style={styles.groupCategoryBadge}>
                            <Text style={styles.groupCategoryText}>{item.category.replace('_', ' ')}</Text>
                            {item.isOfficial && (
                                <Text style={{ color: colors.brand.primary, fontSize: 11, fontWeight: '700' }}> · 🏛️ Official</Text>
                            )}
                        </View>
                    </View>
                    {isSteward ? (
                        <View style={[styles.groupRoleBadge, styles.groupRoleBadgeSteward]}>
                            <Text style={[styles.groupRoleText, styles.groupRoleTextSteward]}>STEWARD</Text>
                        </View>
                    ) : isMember ? (
                        <View style={styles.groupRoleBadge}>
                            <Text style={styles.groupRoleText}>{item.myRole?.toUpperCase()}</Text>
                        </View>
                    ) : null}
                </View>

                {item.description && (
                    <Text style={styles.groupDesc} numberOfLines={2}>{item.description}</Text>
                )}

                <View style={styles.groupFooterRow}>
                    <Text style={styles.groupMetaText}>
                        👥 {item.memberCount ?? 0} member{(item.memberCount ?? 0) === 1 ? '' : 's'} · {item.joinPolicy.replace(/_/g, ' ')}
                    </Text>
                    <MaterialCommunityIcons name="chevron-right" size={18} color={colors.text.muted} />
                </View>
            </Pressable>
        );
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

                    {/* Meta row: Proposer info and Vote CTA */}
                    <View style={styles.metaRow}>
                        <View style={styles.proposedBy}>
                            <MemberAvatar avatarUrl={item.creator_avatar} pubkey={item.creator_pubkey || ''} callsign={item.creator_callsign || '?'} size={20} />
                            <Text style={styles.proposedByText} numberOfLines={1}>
                                by <Text style={styles.proposedByCallsign}>{item.creator_callsign || 'Community'}</Text>
                            </Text>
                        </View>

                        {/* Vote Trigger / Badge */}
                        {activeRound && (
                            hasVoted ? (
                                <View style={styles.votedMiniBadge}>
                                    <MaterialCommunityIcons name="check-circle" size={14} color={colors.brand.primary} />
                                    <Text style={styles.votedMiniText}>Voted ({myVote.votes})</Text>
                                </View>
                            ) : (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel="Vote for this project"
                                    style={[styles.voteTriggerBtn, isExpanded && styles.voteTriggerBtnActive]}
                                    onPress={() => {
                                        hapticTick();
                                        setExpandedVote(isExpanded ? null : item.id);
                                    }}
                                >
                                    <MaterialCommunityIcons name="vote" size={14} color={isExpanded ? colors.text.inverse : colors.brand.primary} />
                                    <Text style={[styles.voteTriggerText, isExpanded && { color: colors.text.inverse }]}>
                                        Vote
                                    </Text>
                                </Pressable>
                            )
                        )}
                    </View>

                    {/* Expandable Quadratic Voting Stepper */}
                    {isExpanded && activeRound && !hasVoted && (
                        <View style={styles.votingArea}>
                            <View style={styles.stepperContainer}>
                                <View style={styles.stepperControls}>
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Decrease votes"
                                        style={styles.stepperBtn}
                                        onPress={() => {
                                            hapticTick();
                                            setVoteSteppers(prev => ({ ...prev, [item.id]: Math.max(1, stepperVotes - 1) }));
                                        }}
                                    >
                                        <Text style={styles.stepperBtnText}>−</Text>
                                    </Pressable>

                                    <Text style={styles.stepperValue}>{stepperVotes}</Text>

                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Increase votes"
                                        style={styles.stepperBtn}
                                        onPress={() => {
                                            hapticTick();
                                            setVoteSteppers(prev => ({ ...prev, [item.id]: stepperVotes + 1 }));
                                        }}
                                    >
                                        <Text style={styles.stepperBtnText}>+</Text>
                                    </Pressable>

                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={`Cast ${stepperVotes} votes for ${stepperCost} credits`}
                                        style={[styles.castBtn, (isOverBudget || votingInProgress === item.id) && styles.castBtnDisabled]}
                                        disabled={isOverBudget || votingInProgress === item.id}
                                        onPress={async () => {
                                            if (isOverBudget) {
                                                hapticWarning();
                                                Alert.alert('Insufficient Credits', `You have ${balanceState.earnedCredit} governance credits, but ${stepperVotes} votes cost ${stepperCost}.`);
                                                return;
                                            }
                                            setVotingInProgress(item.id);
                                            try {
                                                await voteForProjectApi(item.id, stepperVotes);
                                                hapticSuccess();
                                                setExpandedVote(null);
                                                loadData();
                                            } catch (err: any) {
                                                hapticWarning();
                                                Alert.alert('Vote Failed', err.message || 'Could not cast vote.');
                                            } finally {
                                                setVotingInProgress(null);
                                            }
                                        }}
                                    >
                                        <Text style={styles.castBtnText}>
                                            {votingInProgress === item.id ? 'Voting...' : `Cast Vote (${stepperCost} pts)`}
                                        </Text>
                                    </Pressable>
                                </View>

                                <Text style={[styles.stepperCostText, isOverBudget && styles.stepperCostTextError]}>
                                    Cost: {stepperVotes}² = {stepperCost} credit{stepperCost === 1 ? '' : 's'} · Available: {balanceState.earnedCredit}
                                </Text>
                                <Text style={styles.stepperHintText}>
                                    Quadratic voting: each additional vote costs progressively more to prevent plutocracy.
                                </Text>
                            </View>
                        </View>
                    )}

                    {/* Progress Bar & Amounts */}
                    <View style={styles.progressSection}>
                        <View style={styles.progressHeader}>
                            <Text style={[styles.currentText, isFunded && styles.currentTextFunded]}>
                                <CurrencyDisplay amount={item.current_amount} />
                                <Text style={styles.faintText}> raised</Text>
                            </Text>
                            <Text style={styles.goalText}>
                                <CurrencyDisplay amount={item.goal_amount} /> goal
                            </Text>
                        </View>
                        <View style={styles.progressBarBg}>
                            <View
                                style={[
                                    styles.progressBarFill,
                                    {
                                        width: `${progress}%`,
                                        backgroundColor: isFunded ? colors.brand.primary : (theme === 'dark' ? colors.brand.dark : palette.emerald500)
                                    }
                                ]}
                            />
                        </View>
                    </View>

                    {/* Direct Pledge CTA — always accessible right on the card */}
                    {!isFunded && (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Pledge Beans to ${item.title}`}
                            style={styles.pledgeCardBtn}
                            onPress={() => {
                                hapticTick();
                                router.push({
                                    pathname: '/pledge-project',
                                    params: {
                                        id: item.id,
                                        title: item.title,
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
            {/* Segment Switcher */}
            <View style={styles.segmentRow}>
                <Pressable
                    style={[styles.segmentBtn, tabSegment === 'projects' && styles.segmentBtnActive]}
                    onPress={() => {
                        hapticTick();
                        setTabSegment('projects');
                    }}
                >
                    <Text style={[styles.segmentBtnText, tabSegment === 'projects' && styles.segmentBtnTextActive]}>
                        🌱 Projects & Commons
                    </Text>
                </Pressable>
                <Pressable
                    style={[styles.segmentBtn, tabSegment === 'groups' && styles.segmentBtnActive]}
                    onPress={() => {
                        hapticTick();
                        setTabSegment('groups');
                    }}
                >
                    <Text style={[styles.segmentBtnText, tabSegment === 'groups' && styles.segmentBtnTextActive]}>
                        👥 Groups & Teams ({groups.length})
                    </Text>
                </Pressable>
            </View>

            {tabSegment === 'projects' ? (
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
            ) : (
                <FlatList
                    data={filteredGroups}
                    keyExtractor={item => item.id}
                    renderItem={renderGroupItem}
                    contentContainerStyle={styles.listContainer}
                    ListHeaderComponent={
                        <View style={styles.headerContainer}>
                            <View style={styles.headerInfo}>
                                <Text style={styles.headerTitle}>👥 Groups & Teams</Text>
                                <Text style={styles.headerDesc}>
                                    Enterprise project teams, working groups, and guilds. Collaborate on team objectives and direct needs.
                                </Text>
                            </View>

                            {/* Category Filter Chips */}
                            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                                <View style={{ flexDirection: 'row', gap: 8 }}>
                                    {[
                                        { key: 'all', label: 'All Teams' },
                                        { key: 'enterprise', label: '🏢 Enterprise' },
                                        { key: 'project', label: '🛠️ Projects' },
                                        { key: 'working_group', label: '🤝 Working Groups' },
                                        { key: 'guild', label: '🛡️ Guilds' },
                                        { key: 'social', label: '💬 Social' },
                                    ].map(cat => {
                                        const active = selectedGroupCategory === cat.key;
                                        return (
                                            <Pressable
                                                key={cat.key}
                                                style={[styles.sortBtn, active && styles.sortBtnActive]}
                                                onPress={() => setSelectedGroupCategory(cat.key)}
                                            >
                                                <Text style={[styles.sortBtnText, active && styles.sortBtnTextActive]}>
                                                    {cat.label}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>
                            </ScrollView>
                        </View>
                    }
                    ListEmptyComponent={
                        <View style={styles.emptyState}>
                            <Text style={styles.emptyEmoji}>👥</Text>
                            <Text style={styles.emptyTitle}>No groups in this category</Text>
                            <Text style={styles.emptyDesc}>
                                Start a new working group or guild to collaborate with peers on shared goals and tasks.
                            </Text>
                            <Pressable accessibilityRole="button" style={styles.emptyBtn} onPress={() => setShowCreateGroupModal(true)}>
                                <Text style={styles.emptyBtnText}>+ Create a Group</Text>
                            </Pressable>
                        </View>
                    }
                />
            )}

            {/* FAB Button */}
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={tabSegment === 'projects' ? 'Propose a project' : 'Create a group'}
                style={styles.fab}
                onPress={async () => {
                    if (tabSegment === 'groups') {
                        setShowCreateGroupModal(true);
                        return;
                    }
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

            <CreateGroupModal
                isOpen={showCreateGroupModal}
                onClose={() => setShowCreateGroupModal(false)}
                onCreated={() => loadData()}
            />

            <GroupDetailModal
                group={selectedGroupForDetail}
                isOpen={!!selectedGroupForDetail}
                onClose={() => setSelectedGroupForDetail(null)}
                myPubkey={identity?.publicKey}
                onMembershipChanged={() => loadData()}
            />
        </SafeAreaView>
    );
}
