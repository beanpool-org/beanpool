import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, SafeAreaView, Platform, Image, TextInput, DeviceEventEmitter } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useIdentity } from '../IdentityContext';
import { getConversations, getActionableDeals, createConversationApi, syncMessages, getFriendsLocal } from '../../utils/db';
import { MemberAvatar } from '../../components/MemberAvatar';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';

export default function ChatsScreen() {
    const { theme, colors } = useTheme();
    const { identity } = useIdentity();
    const [conversations, setConversations] = useState<any[]>([]);
    const [deals, setDeals] = useState<any[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<'recent' | 'unread' | 'credits_desc' | 'credits_asc'>('recent');
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'pending' | 'completed'>('all');
    const [readFilter, setReadFilter] = useState<'all' | 'unread'>('all');
    const [peopleFilter, setPeopleFilter] = useState<'all' | 'friends'>('all');
    const [friendPubkeys, setFriendPubkeys] = useState<Set<string>>(new Set());
    const [showOptions, setShowOptions] = useState(false);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.card },
        header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle },
        title: { fontSize: 32, fontWeight: '800', color: colors.text.body, letterSpacing: -0.5 },
        newChatBtn: { padding: 8, backgroundColor: colors.accent.tint, borderRadius: 12 },
        list: { paddingBottom: 100 },
        chatRow: { flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.surface.app, alignItems: 'center' },
        chatRowActionNeeded: {
            backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber50,
            borderLeftWidth: 4,
            borderColor: theme === 'dark' ? colors.feedback.warning.border : palette.amber500,
            paddingLeft: 12
        },
        avatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: colors.surface.subtle, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
        avatarText: { fontSize: 20, fontWeight: 'bold', color: colors.text.secondary },
        avatarWrapper: { width: 50, height: 50, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
        overlayAvatar: { position: 'absolute', bottom: -2, right: -2, backgroundColor: palette.gray600, width: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: colors.surface.card },
        overlayAvatarText: { color: colors.text.inverse, fontSize: 10, fontWeight: 'bold' },
        chatDetails: { flex: 1 },
        chatHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
        peerName: { fontSize: 16, fontWeight: '700', color: colors.text.body },
        peerNameUnread: { color: colors.text.heading, fontWeight: '900' },
        timestamp: { fontSize: 12, color: colors.text.muted, fontWeight: '500' },
        timestampUnread: { color: colors.accent.primary, fontWeight: '700' },
        messageRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
        lastMessage: { fontSize: 14, color: colors.text.secondary, flex: 1, paddingRight: 16 },
        lastMessageUnread: { color: colors.text.heading, fontWeight: '600' },
        actionNeededText: { fontSize: 13, color: colors.feedback.warning.fg, fontWeight: '700', flex: 1 },
        unreadBadge: { backgroundColor: colors.accent.primary, width: 20, height: 20, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
        unreadCount: { color: colors.text.inverse, fontSize: 11, fontWeight: '800' },
        contextRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
        contextPostTitle: { fontSize: 13, color: colors.text.secondary, fontWeight: '500', flex: 1, marginRight: 8 },
        statusPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
        statusPillText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
        avatarMarketplace: { backgroundColor: theme === 'dark' ? colors.brand.tint : palette.emerald100 },
        avatarComposite: { width: 50, height: 50, marginRight: 16 },
        postPhotoAvatar: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.border.default },
        overlayAvatarWrap: { position: 'absolute', bottom: -3, right: -3, borderWidth: 2, borderColor: colors.surface.card, borderRadius: 12, overflow: 'hidden' },
        tabContainer: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle, gap: 8 },
        tabBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 20, backgroundColor: colors.surface.subtle },
        tabBtnActive: { backgroundColor: colors.text.body },
        tabBtnText: { color: colors.text.secondary, fontSize: 14, fontWeight: '600' },
        tabBtnTextActive: { color: colors.text.inverse },
        emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingVertical: 100 },
        emptyText: { marginTop: 16, fontSize: 15, color: colors.text.muted, fontWeight: '500' },
     
        // Action Required Section
        actionSection: { margin: 12, padding: 16, backgroundColor: theme === 'dark' ? colors.brand.tint : palette.green50, borderRadius: 16, borderWidth: 1, borderColor: theme === 'dark' ? colors.brand.primary : palette.green200 },
        actionSectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 6 },
        actionSectionTitle: { fontSize: 15, fontWeight: '800', color: theme === 'dark' ? colors.text.heading : palette.green800, letterSpacing: 0.3 },
        actionCountBadge: { backgroundColor: colors.brand.dark, width: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center' },
        actionCountText: { color: colors.text.inverse, fontSize: 12, fontWeight: '800' },
        actionCard: { backgroundColor: colors.surface.card, borderRadius: 12, padding: 11, marginBottom: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2, borderWidth: 1, borderColor: colors.border.default },
        actionCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
        actionIconContainer: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.brand.dark, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
        actionCardInfo: { flex: 1 },
        actionCardTitle: { fontSize: 15, fontWeight: '700', color: colors.text.body },
        actionCardPeer: { fontSize: 13, color: colors.text.secondary, marginTop: 1 },
        actionAmountBadge: { backgroundColor: theme === 'dark' ? colors.brand.tint : palette.emerald100, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
        actionAmountText: { fontSize: 14, fontWeight: '800', color: colors.brand.dark },
        actionCardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.surface.subtle },
        actionLabel: { fontSize: 14, fontWeight: '700', color: colors.brand.dark },
    
        searchBarRow: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 10, gap: 10, alignItems: 'center' },
        searchContainer: { flex: 1, flexDirection: 'row', backgroundColor: colors.surface.subtle, borderRadius: 12, alignItems: 'center', paddingHorizontal: 10, height: 42 },
        searchIcon: { marginRight: 6 },
        searchInput: { flex: 1, fontSize: 15, color: colors.text.body, height: '100%', paddingVertical: 0 },
        clearBtn: { padding: 4 },
        optionsToggleBtn: { width: 42, height: 42, borderRadius: 12, backgroundColor: colors.surface.subtle, justifyContent: 'center', alignItems: 'center' },
        optionsToggleBtnActive: { backgroundColor: colors.accent.primary },
        filterBadge: { position: 'absolute', top: -3, right: -3, backgroundColor: colors.action.fab, width: 18, height: 18, borderRadius: 9, justifyContent: 'center', alignItems: 'center', borderWidth: 1.5, borderColor: colors.surface.card },
        filterBadgeText: { color: colors.text.inverse, fontSize: 10, fontWeight: '800' },
    
        optionsDrawer: { backgroundColor: colors.surface.app, borderBottomWidth: 1, borderBottomColor: colors.border.default, padding: 16 },
        optionsLabel: { fontSize: 12, fontWeight: '700', color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 12 },
        chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
        chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        chipActive: { backgroundColor: colors.text.body, borderColor: colors.text.body },
        chipText: { color: colors.text.secondary, fontSize: 13, fontWeight: '600' },
        chipTextActive: { color: colors.text.inverse },
        optionsFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, borderTopWidth: 1, borderTopColor: colors.border.default, paddingTop: 12 },
        resetBtn: { paddingVertical: 4 },
        resetBtnText: { color: colors.feedback.danger.solid, fontSize: 14, fontWeight: '700' },
        closeBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.border.default },
        closeBtnText: { color: colors.text.secondary, fontSize: 13, fontWeight: '700' },
    }));

    // Partition conversations into "Action Required" and regular
    const { actionRequired, regularConversations } = React.useMemo(() => {
        let list = conversations;

        // 1. Text Search Filter
        if (searchQuery.trim() !== '') {
            const q = searchQuery.toLowerCase().trim();
            list = list.filter(c => {
                const matchPeer = (c.peer || '').toLowerCase().includes(q);
                const matchTitle = (c.postTitle || '').toLowerCase().includes(q);
                const matchMsg = (c.lastMessage || '').toLowerCase().includes(q);
                return matchPeer || matchTitle || matchMsg;
            });
        }

        // 2. Read State Filter
        if (readFilter === 'unread') {
            list = list.filter(c => c.unread > 0);
        }

        // 3. People Filter
        if (peopleFilter === 'friends') {
            list = list.filter(c => c.peerPubkey && friendPubkeys.has(c.peerPubkey));
        }

        // Action Required is now per-DEAL (release / fulfill / review), derived from
        // marketplace_transactions — not from per-thread fields, since a thread is per-person
        // now and may hold several deals. Hidden while searching.
        const actionRequired = searchQuery.trim() !== '' ? [] : deals;

        let regular = list.map(c => {
            const conversationDeals = deals.filter(d => d.conversationId === c.id);
            const releaseCount = conversationDeals.filter(d => d.action === 'release').length;
            const fulfillCount = conversationDeals.filter(d => d.action === 'fulfill').length;
            const reviewCount = conversationDeals.filter(d => d.action === 'review').length;
            return {
                ...c,
                actionableCount: conversationDeals.length,
                conversationDeals,
                releaseCount,
                fulfillCount,
                reviewCount
            };
        });
        
        // 4. Advanced Sorting
        regular = [...regular].sort((a, b) => {
            if (sortBy === 'unread') {
                // Prioritize unread messages
                if (a.unread > 0 && b.unread === 0) return -1;
                if (a.unread === 0 && b.unread > 0) return 1;
            } else if (sortBy === 'credits_desc') {
                const credA = a.postCredits || a.pendingAmount || 0;
                const credB = b.postCredits || b.pendingAmount || 0;
                if (credA !== credB) return credB - credA;
            } else if (sortBy === 'credits_asc') {
                const credA = a.postCredits || a.pendingAmount || 0;
                const credB = b.postCredits || b.pendingAmount || 0;
                if (credA !== credB) return credA - credB;
            }

            // Fallback: raw timestamp
            const timeA = a.rawTimestamp ? new Date(a.rawTimestamp).getTime() : 0;
            const timeB = b.rawTimestamp ? new Date(b.rawTimestamp).getTime() : 0;
            return timeB - timeA;
        });

        return { actionRequired, regularConversations: regular };
    }, [conversations, deals, searchQuery, sortBy, readFilter, peopleFilter, friendPubkeys]);

    const resetFilters = () => {
        setSearchQuery('');
        setSortBy('recent');
        setStatusFilter('all');
        setReadFilter('all');
        setPeopleFilter('all');
    };

    const activeFiltersCount = (sortBy !== 'recent' ? 1 : 0) + (statusFilter !== 'all' ? 1 : 0) + (readFilter !== 'all' ? 1 : 0) + (peopleFilter !== 'all' ? 1 : 0);

    useFocusEffect(
        React.useCallback(() => {
            let active = true;

            const loadData = () => {
                if (identity?.publicKey && active) {
                    getConversations(identity.publicKey)
                        .then(res => {
                            if (active) setConversations(res);
                        })
                        .catch(console.error);
                    getActionableDeals(identity.publicKey)
                        .then(res => {
                            if (active) setDeals(res);
                        })
                        .catch(console.error);
                    getFriendsLocal(identity.publicKey)
                        .then(res => {
                            if (active) setFriendPubkeys(new Set(res.map((f: any) => f.publicKey)));
                        })
                        .catch(console.error);
                }
            };

            loadData();

            // Background sync messages
            if (identity?.publicKey) {
                syncMessages(identity.publicKey).then(() => {
                    loadData();
                });
            }

            const sub = DeviceEventEmitter.addListener('sync_data_updated', loadData);

            const wsSub = DeviceEventEmitter.addListener('ws_activity', () => {
                if (identity?.publicKey && active) {
                    syncMessages(identity.publicKey).then(() => {
                        loadData();
                    });
                }
            });

            return () => {
                active = false;
                sub.remove();
                wsSub.remove();
            };
        }, [identity])
    );



    const getActionLabel = (deal: any) => {
        if (deal.action === 'release') return '🔓 Release Credits';
        if (deal.action === 'fulfill') return '📦 Fulfill Order';
        if (deal.action === 'review') return '⭐ Leave Review';
        return '⚡ Action Required';
    };

    const renderActionCard = ({ item }: { item: any }) => (
        <Pressable
            accessibilityRole="button"
            style={styles.actionCard}
            onPress={() => {
                if (item.action === 'review') {
                    router.push({ pathname: `/chat/${item.conversationId}`, params: { triggerReview: 'true', txId: item.txId } });
                } else {
                    router.push({ pathname: `/chat/${item.conversationId}`, params: { focusTx: item.txId } });
                }
            }}
        >
            <View style={styles.actionCardHeader}>
                <View style={styles.actionIconContainer}>
                    <MemberAvatar avatarUrl={item.peerAvatar} pubkey={item.peerPubkey || ''} callsign={item.peerCallsign || ''} size={28} />
                </View>
                <View style={styles.actionCardInfo}>
                    <Text style={styles.actionCardTitle} numberOfLines={1}>{item.postTitle || 'Transaction'}</Text>
                    <Text style={styles.actionCardPeer}>{item.peerCallsign || (item.peerPubkey || '').slice(0, 8)}</Text>
                </View>
                {item.credits ? (
                    <View style={styles.actionAmountBadge}>
                        <CurrencyDisplay amount={item.credits} style={styles.actionAmountText} asView />
                    </View>
                ) : null}
            </View>
            <View style={styles.actionCardFooter}>
                <Text style={styles.actionLabel}>{getActionLabel(item)}</Text>
                <MaterialCommunityIcons name="chevron-right" size={20} color={colors.brand.dark} />
            </View>
        </Pressable>
    );

    const renderItem = ({ item }: { item: any }) => {
        const needsAction = item.actionableCount > 0;
        
        let actionText = '';
        let actionIcon: any = 'alert-circle-outline';
        if (item.actionableCount > 0) {
            if (item.releaseCount > 0 && item.reviewCount > 0) {
                actionText = `Action Required (${item.actionableCount})`;
                actionIcon = 'lightning-bolt';
            } else if (item.releaseCount > 0) {
                actionText = `Release Credits (${item.releaseCount})`;
                actionIcon = 'lock-open-outline';
            } else if (item.reviewCount > 0) {
                actionText = `Review Needed (${item.reviewCount})`;
                actionIcon = 'star-outline';
            } else if (item.fulfillCount > 0) {
                actionText = `Fulfill Order (${item.fulfillCount})`;
                actionIcon = 'package-variant-closed';
            } else {
                actionText = `Action Required (${item.actionableCount})`;
                actionIcon = 'lightning-bolt';
            }
        }
        
        return (
            <Pressable
                accessibilityRole="button"
                style={[styles.chatRow, needsAction && styles.chatRowActionNeeded]}
                onPress={() => {
                    const firstActionable = item.conversationDeals?.[0];
                    if (firstActionable) {
                        if (firstActionable.action === 'review') {
                            router.push({ pathname: `/chat/${item.id}`, params: { triggerReview: 'true', txId: firstActionable.txId } });
                        } else {
                            router.push({ pathname: `/chat/${item.id}`, params: { focusTx: firstActionable.txId } });
                        }
                    } else {
                        router.push(`/chat/${item.id}`);
                    }
                }}
            >
                {item.postId && item.postPhoto && typeof item.postPhoto === 'string' && item.postPhoto.trim() !== '' && item.postPhoto !== 'null' && item.postPhoto !== 'undefined' ? (
                    <View style={styles.avatarComposite}>
                        {/* Post photo as primary (rounded square) */}
                        <Image source={{ uri: item.postPhoto }} style={styles.postPhotoAvatar} accessibilityElementsHidden={true} importantForAccessibility="no-hide-descendants" />
                        {/* Peer profile overlay (small circle) */}
                        <View style={styles.overlayAvatarWrap}>
                            <MemberAvatar avatarUrl={item.peerAvatar} pubkey={item.peerPubkey || ''} callsign={item.peer} size={20} />
                        </View>
                    </View>
                ) : item.postId ? (
                    <View style={styles.avatarComposite}>
                        <View style={[styles.avatar, styles.avatarMarketplace]}>
                            <MaterialCommunityIcons name="shopping-outline" size={24} color={colors.brand.dark} />
                        </View>
                        <View style={styles.overlayAvatarWrap}>
                            <MemberAvatar avatarUrl={item.peerAvatar} pubkey={item.peerPubkey || ''} callsign={item.peer} size={20} />
                        </View>
                    </View>
                ) : (
                    <View style={styles.avatarWrapper}>
                        <MemberAvatar avatarUrl={item.peerAvatar} pubkey={item.peerPubkey || ''} callsign={item.peer} size={44} />
                    </View>
                )}
                
                <View style={styles.chatDetails}>
                    <View style={styles.chatHeader}>
                        <Text style={[styles.peerName, item.unread > 0 && styles.peerNameUnread]}>{item.peer}</Text>
                        <Text style={[styles.timestamp, item.unread > 0 && styles.timestampUnread]}>{item.timestamp}</Text>
                    </View>
                    
                    {item.postTitle && (
                        <View style={styles.contextRow}>
                            <Text style={styles.contextPostTitle} numberOfLines={1}>{item.postTitle}</Text>
                            {item.postStatus && (
                                <View style={[styles.statusPill,
                                    item.postStatus === 'active' ? { backgroundColor: colors.feedback.info.bg } :
                                    item.postStatus === 'pending' ? { backgroundColor: colors.feedback.success.bg } :
                                    { backgroundColor: colors.surface.subtle }
                                ]}>
                                    <Text style={[styles.statusPillText,
                                        item.postStatus === 'active' ? { color: colors.feedback.info.fg } :
                                        item.postStatus === 'pending' ? { color: colors.feedback.success.fg } :
                                        { color: colors.text.secondary }
                                    ]}>
                                        {item.postStatus === 'pending' ? 'HELD IN TRUST' : item.postStatus.toUpperCase()}
                                    </Text>
                                </View>
                            )}
                        </View>
                    )}
                    
                    <View style={styles.messageRow}>
                        {needsAction ? (
                            <Text style={styles.actionNeededText} numberOfLines={1}>
                                <MaterialCommunityIcons name={actionIcon} size={14} color={palette.amber500} /> {actionText}
                            </Text>
                        ) : (
                            <Text style={[styles.lastMessage, item.unread > 0 && styles.lastMessageUnread]} numberOfLines={1}>
                                {item.lastMessage}
                            </Text>
                        )}
                        {item.unread > 0 && (
                            <View style={styles.unreadBadge}>
                                <Text style={styles.unreadCount}>{item.unread}</Text>
                            </View>
                        )}
                    </View>
                </View>
            </Pressable>
        );
    };

    const ListHeader = () => (
        <>
            {actionRequired.length > 0 && (
                <View style={styles.actionSection}>
                    <View style={styles.actionSectionHeader}>
                        <MaterialCommunityIcons name="lightning-bolt" size={18} color={colors.brand.dark} />
                        <Text style={styles.actionSectionTitle}>Action Required</Text>
                        <View style={styles.actionCountBadge}>
                            <Text style={styles.actionCountText}>{actionRequired.length}</Text>
                        </View>
                    </View>
                    {actionRequired.map(item => (
                        <View key={item.txId}>
                            {renderActionCard({ item })}
                        </View>
                    ))}
                </View>
            )}
        </>
    );

    return (
        <SafeAreaView style={styles.safeArea}>
            <View style={[styles.header, { borderBottomWidth: 0, paddingBottom: 8 }]}>
                <Text style={styles.title}>Inbox</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="New message" style={styles.newChatBtn} onPress={() => {
                    if (Platform.OS === 'web') {
                        const val = window.prompt("Enter PubKey or Callsign:");
                        if (val) router.push(`/chat/${val}`);
                    } else {
                        router.push('/new-message');
                    }
                }}>
                    <MaterialCommunityIcons name="pencil-outline" size={24} color={colors.accent.primary} />
                </Pressable>
            </View>

            {/* Search, Sort, and Filter row */}
            <View style={styles.searchBarRow}>
                <View style={styles.searchContainer}>
                    <MaterialCommunityIcons name="magnify" size={20} color={colors.text.muted} style={styles.searchIcon} />
                    <TextInput
                        accessibilityLabel="Search chats, posts, partners"
                        style={styles.searchInput}
                        placeholder="Search chats, posts, partners..."
                        placeholderTextColor={colors.text.muted}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                    />
                    {searchQuery.trim() !== '' && (
                        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setSearchQuery('')} style={styles.clearBtn}>
                            <MaterialCommunityIcons name="close-circle" size={18} color={colors.text.muted} />
                        </Pressable>
                    )}
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Filter and sort"
                    accessibilityState={{ selected: showOptions || activeFiltersCount > 0 }}
                    style={[styles.optionsToggleBtn, (showOptions || activeFiltersCount > 0) && styles.optionsToggleBtnActive]}
                    onPress={() => setShowOptions(!showOptions)}
                >
                    <MaterialCommunityIcons name="tune-variant" size={20} color={showOptions || activeFiltersCount > 0 ? colors.text.inverse : palette.gray600} />
                    {activeFiltersCount > 0 && (
                        <View style={styles.filterBadge}>
                            <Text style={styles.filterBadgeText}>{activeFiltersCount}</Text>
                        </View>
                    )}
                </Pressable>
            </View>

            {/* Collapsible sort and filter options drawer */}
            {showOptions && (
                <View style={styles.optionsDrawer}>
                    {/* Sort Section */}
                    <Text style={styles.optionsLabel}>Sort by</Text>
                    <View style={styles.chipsRow}>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: sortBy === 'recent' }}
                            style={[styles.chip, sortBy === 'recent' && styles.chipActive]}
                            onPress={() => setSortBy('recent')}
                        >
                            <Text style={[styles.chipText, sortBy === 'recent' && styles.chipTextActive]}>⇅ Recent</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: sortBy === 'unread' }}
                            style={[styles.chip, sortBy === 'unread' && styles.chipActive]}
                            onPress={() => setSortBy('unread')}
                        >
                            <Text style={[styles.chipText, sortBy === 'unread' && styles.chipTextActive]}>✉ Unread</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: sortBy === 'credits_desc' }}
                            style={[styles.chip, sortBy === 'credits_desc' && styles.chipActive]}
                            onPress={() => setSortBy('credits_desc')}
                        >
                            <Image
                                source={require('../../assets/images/bean.png')}
                                style={{ width: 14, height: 14, resizeMode: 'contain' }}
                            />
                            <Text style={[styles.chipText, sortBy === 'credits_desc' && styles.chipTextActive]}>Credits: High</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: sortBy === 'credits_asc' }}
                            style={[styles.chip, sortBy === 'credits_asc' && styles.chipActive]}
                            onPress={() => setSortBy('credits_asc')}
                        >
                            <Image
                                source={require('../../assets/images/bean.png')}
                                style={{ width: 14, height: 14, resizeMode: 'contain' }}
                            />
                            <Text style={[styles.chipText, sortBy === 'credits_asc' && styles.chipTextActive]}>Credits: Low</Text>
                        </Pressable>
                    </View>

                    {/* Read State Filter Section */}
                    <Text style={styles.optionsLabel}>Read Status</Text>
                    <View style={styles.chipsRow}>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: readFilter === 'all' }}
                            style={[styles.chip, readFilter === 'all' && styles.chipActive]}
                            onPress={() => setReadFilter('all')}
                        >
                            <Text style={[styles.chipText, readFilter === 'all' && styles.chipTextActive]}>✓ All</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: readFilter === 'unread' }}
                            style={[styles.chip, readFilter === 'unread' && styles.chipActive]}
                            onPress={() => setReadFilter('unread')}
                        >
                            <Text style={[styles.chipText, readFilter === 'unread' && styles.chipTextActive]}>✉ Unread Only</Text>
                        </Pressable>
                    </View>

                    {/* People Filter Section */}
                    <Text style={styles.optionsLabel}>People</Text>
                    <View style={styles.chipsRow}>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: peopleFilter === 'all' }}
                            style={[styles.chip, peopleFilter === 'all' && styles.chipActive]}
                            onPress={() => setPeopleFilter('all')}
                        >
                            <Text style={[styles.chipText, peopleFilter === 'all' && styles.chipTextActive]}>✓ All</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: peopleFilter === 'friends' }}
                            style={[styles.chip, peopleFilter === 'friends' && styles.chipActive]}
                            onPress={() => setPeopleFilter('friends')}
                        >
                            <Text style={[styles.chipText, peopleFilter === 'friends' && styles.chipTextActive]}>👫 Friends Only</Text>
                        </Pressable>
                    </View>

                    {/* Reset Footer */}
                    <View style={styles.optionsFooter}>
                        <Pressable accessibilityRole="button" style={styles.resetBtn} onPress={resetFilters}>
                            <Text style={styles.resetBtnText}>Reset Defaults</Text>
                        </Pressable>
                        <Pressable accessibilityRole="button" style={styles.closeBtn} onPress={() => setShowOptions(false)}>
                            <Text style={styles.closeBtnText}>✕ Close</Text>
                        </Pressable>
                    </View>
                </View>
            )}

            <FlatList
                data={regularConversations}
                keyExtractor={item => item.id}
                renderItem={renderItem}
                ListHeaderComponent={ListHeader}
                contentContainerStyle={styles.list}
                showsVerticalScrollIndicator={false}
                ListEmptyComponent={
                    actionRequired.length === 0 ? (
                        <View style={styles.emptyContainer}>
                            <MaterialCommunityIcons name="message-outline" size={48} color={colors.border.strong} />
                            <Text style={styles.emptyText}>No conversations yet.</Text>
                            <Pressable
                                accessibilityRole="button"
                                onPress={() => router.push('/')}
                                style={{ marginTop: 12, backgroundColor: colors.accent.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 }}
                            >
                                <Text style={{ color: colors.text.inverse, fontWeight: 'bold' }}>Browse Market</Text>
                            </Pressable>
                        </View>
                    ) : null
                }
            />


        </SafeAreaView>
    );
}

