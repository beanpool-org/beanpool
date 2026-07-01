import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    View, Text, StyleSheet, FlatList, Pressable, TextInput,
    Platform, Image, ActivityIndicator, Animated
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useIdentity } from './IdentityContext';
import { getDb, createConversationApi, getRecentChatMembers, getFriendsLocal } from '../utils/db';
import { MemberAvatar } from '../components/MemberAvatar';
import { colors, palette } from '../constants/colors';
import { useTheme, useStyles } from './ThemeContext';

// ── Fixed Row Height for getItemLayout ──────────────────────────────────────
const MEMBER_ROW_HEIGHT = 72;
const SEPARATOR_HEIGHT = 0;
const ITEM_HEIGHT = MEMBER_ROW_HEIGHT + SEPARATOR_HEIGHT;

// ── Shimmer Placeholder ─────────────────────────────────────────────────────
function ShimmerRow({ index, styles }: { index: number; styles: any }) {
    const anim = useRef(new Animated.Value(0.3)).current;
    useEffect(() => {
        Animated.loop(
            Animated.sequence([
                Animated.timing(anim, { toValue: 1, duration: 800, delay: index * 60, useNativeDriver: true }),
                Animated.timing(anim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
            ])
        ).start();
    }, []);
    return (
        <Animated.View style={[styles.shimmerRow, { opacity: anim }]}>
            <View style={styles.shimmerAvatar} />
            <View style={styles.shimmerTextGroup}>
                <View style={[styles.shimmerLine, { width: '55%' }]} />
                <View style={[styles.shimmerLine, { width: '35%', marginTop: 6 }]} />
            </View>
        </Animated.View>
    );
}

// ── Utilities ───────────────────────────────────────────────────────────────
function formatJoinDate(dateStr: string | null) {
    if (!dateStr) return 'Member';
    try {
        const d = new Date(dateStr);
        const now = new Date();
        const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays < 1) return 'Joined today';
        if (diffDays < 7) return `Joined ${diffDays}d ago`;
        if (diffDays < 30) return `Joined ${Math.floor(diffDays / 7)}w ago`;
        return `Joined ${d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
    } catch {
        return 'Member';
    }
}

/** Build a cache-busting URI for avatar images so updates propagate immediately. */

export default function NewMessageScreen() {
    const { identity } = useIdentity();
    const { theme, colors } = useTheme();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.card },
        container: { flex: 1 },

        // Header
        header: {
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
            paddingHorizontal: 16, paddingVertical: 12,
            borderBottomWidth: 1, borderBottomColor: colors.border.default,
        },
        backBtn: { padding: 8, borderRadius: 12, backgroundColor: colors.surface.subtle },
        title: { fontSize: 18, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.3 },

        // Search
        searchContainer: {
            flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginVertical: 12,
            backgroundColor: colors.surface.subtle, borderRadius: 14, paddingHorizontal: 14,
            borderWidth: 1, borderColor: colors.border.default,
        },
        searchIcon: { marginRight: 8 },
        searchInput: { flex: 1, paddingVertical: 14, fontSize: 16, color: colors.text.body, fontWeight: '500' },
        clearBtn: { padding: 4 },

        // Shimmer loading
        shimmerContainer: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
        shimmerRow: {
            flexDirection: 'row', alignItems: 'center', height: MEMBER_ROW_HEIGHT,
            paddingHorizontal: 16, paddingVertical: 14,
        },
        shimmerAvatar: {
            width: 44, height: 44, borderRadius: 22, backgroundColor: colors.border.default, marginRight: 14,
        },
        shimmerTextGroup: { flex: 1 },
        shimmerLine: { height: 12, borderRadius: 6, backgroundColor: colors.border.default },

        // List
        list: { paddingBottom: 100 },

        // Recents
        recentsSection: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        recentsList: { gap: 12, paddingTop: 12 },
        recentChip: { alignItems: 'center', width: 72 },
        recentAvatar: {
            width: 52, height: 52, borderRadius: 26, backgroundColor: colors.surface.subtle,
            justifyContent: 'center', alignItems: 'center', marginBottom: 6,
            borderWidth: 2, borderColor: colors.border.default,
        },
        recentAvatarImage: { width: 52, height: 52, borderRadius: 26 },
        recentAvatarText: { fontSize: 20, fontWeight: 'bold', color: colors.text.secondary },
        recentName: { fontSize: 11, fontWeight: '600', color: colors.text.secondary, textAlign: 'center' },
        recentStar: { fontSize: 10, color: colors.trust.star, marginTop: 1 },

        // Directory header
        directoryHeader: {
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
            paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8,
        },
        sectionTitle: { fontSize: 13, fontWeight: '800', color: colors.text.secondary, letterSpacing: 0.3, textTransform: 'uppercase' },
        memberCount: { fontSize: 12, fontWeight: '600', color: colors.text.muted },

        // Member Cards (fixed height)
        memberCard: {
            flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
            height: MEMBER_ROW_HEIGHT,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border.default,
        },
        memberCardActive: { backgroundColor: colors.accent.tint },
        memberAvatarWrap: { position: 'relative', marginRight: 14 },
        avatarImage: { width: 44, height: 44, borderRadius: 22 },
        avatarFallback: {
            width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface.subtle,
            justifyContent: 'center', alignItems: 'center',
        },
        avatarInitial: { fontSize: 18, fontWeight: 'bold', color: colors.text.secondary },
        friendBadge: {
            position: 'absolute', bottom: -2, right: -2, width: 18, height: 18, borderRadius: 9,
            backgroundColor: colors.trust.star, justifyContent: 'center', alignItems: 'center',
            borderWidth: 2, borderColor: colors.text.inverse,
        },
        friendBadgeText: { fontSize: 9, color: colors.text.inverse, fontWeight: '800' },
        memberInfo: { flex: 1, justifyContent: 'center' },
        memberNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
        memberName: { fontSize: 15, fontWeight: '700', color: colors.text.heading, flexShrink: 1 },
        friendLabel: {
            fontSize: 10, fontWeight: '800', color: colors.trust.resident.fg, backgroundColor: colors.trust.resident.bg,
            paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, overflow: 'hidden',
        },
        memberMeta: { fontSize: 12, color: colors.text.muted, marginTop: 2, fontWeight: '500' },



        // Empty state
        emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
        emptyTitle: { marginTop: 12, fontSize: 15, color: colors.text.secondary, fontWeight: '700' },
        emptySubtitle: { marginTop: 4, fontSize: 13, color: colors.text.muted, fontWeight: '500', textAlign: 'center', paddingHorizontal: 32 },
    }));

    const [searchQuery, setSearchQuery] = useState('');
    const searchRef = useRef<TextInput>(null);

    // ── Data state ──────────────────────────────────────────────────────────
    const [allMembers, setAllMembers] = useState<any[]>([]);
    const [friendPubkeys, setFriendPubkeys] = useState<Set<string>>(new Set());
    const [recents, setRecents] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState<string | null>(null);

    // ── Load on mount ───────────────────────────────────────────────────────
    useEffect(() => {
        if (!identity?.publicKey) return;

        const load = async () => {
            setLoading(true);
            try {
                const database = await getDb();

                // Paginated initial load — pull all non-pruned members
                const members = await database.getAllAsync<any>(
                    `SELECT public_key, callsign, avatar_url, joined_at
                     FROM members
                     WHERE public_key != ?
                       AND (status IS NULL OR status != 'pruned')
                       AND public_key NOT LIKE 'escrow_%'
                       AND public_key NOT LIKE 'project_%'
                       AND public_key != 'SYSTEM'
                     ORDER BY callsign COLLATE NOCASE ASC`,
                    [identity.publicKey]
                );
                setAllMembers(members);

                // Friends
                const friends = await getFriendsLocal(identity.publicKey);
                setFriendPubkeys(new Set(friends.map((f: any) => f.publicKey)));

                // Recents
                const recentMembers = await getRecentChatMembers(identity.publicKey, 8);
                setRecents(recentMembers);
            } catch (e) {
                console.error('[NewMessage] Load error:', e);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [identity?.publicKey]);

    // ── Search / sort (memo) ────────────────────────────────────────────────
    const filteredMembers = useMemo(() => {
        let list = allMembers;

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase().trim();
            list = list.filter(m =>
                m.callsign?.toLowerCase().includes(q) ||
                m.public_key?.toLowerCase().includes(q)
            );
        }

        // Friends-first sort, then alphabetical
        return [...list].sort((a, b) => {
            const aF = friendPubkeys.has(a.public_key) ? 0 : 1;
            const bF = friendPubkeys.has(b.public_key) ? 0 : 1;
            if (aF !== bF) return aF - bF;
            return (a.callsign || '').localeCompare(b.callsign || '');
        });
    }, [allMembers, searchQuery, friendPubkeys]);

    // ── Handlers ────────────────────────────────────────────────────────────
    const handleSelectMember = useCallback(async (pubkey: string) => {
        if (!identity?.publicKey || creating) return;
        setCreating(pubkey);
        try {
            const apiConv = await createConversationApi('dm', [identity.publicKey, pubkey], identity.publicKey);
            router.replace(`/chat/${apiConv.id}`);
        } catch (e: any) {
            console.error('[NewMessage] Create conversation error:', e);
            setCreating(null);
        }
    }, [identity?.publicKey, creating]);



    // ── getItemLayout for zero-measurement scrolling ────────────────────────
    const getItemLayout = useCallback((_data: any, index: number) => ({
        length: ITEM_HEIGHT,
        offset: ITEM_HEIGHT * index,
        index,
    }), []);

    // ── Render: Member Row ──────────────────────────────────────────────────
    const renderMemberCard = useCallback(({ item }: { item: any }) => {
        const isFriend = friendPubkeys.has(item.public_key);
        const isCreating = creating === item.public_key;

        return (
            <Pressable
                accessibilityRole="button"
                style={[styles.memberCard, isCreating && styles.memberCardActive]}
                onPress={() => handleSelectMember(item.public_key)}
                disabled={!!creating}
            >
                <View style={styles.memberAvatarWrap}>
                    <MemberAvatar avatarUrl={item.avatar_url} pubkey={item.public_key} callsign={item.callsign || '?'} size={44} />
                    {isFriend && (
                        <View style={styles.friendBadge}>
                            <Text style={styles.friendBadgeText}>★</Text>
                        </View>
                    )}
                </View>

                <View style={styles.memberInfo}>
                    <View style={styles.memberNameRow}>
                        <Text style={styles.memberName} numberOfLines={1}>{item.callsign || 'Unknown'}</Text>
                        {isFriend && <Text style={styles.friendLabel}>Friend</Text>}
                    </View>
                    <Text style={styles.memberMeta} numberOfLines={1}>
                        {formatJoinDate(item.joined_at)}
                    </Text>
                </View>

                {isCreating ? (
                    <ActivityIndicator size="small" color={colors.accent.primary} style={{ marginLeft: 8 }} />
                ) : (
                    <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.secondary} style={{ marginLeft: 4 }} />
                )}
            </Pressable>
        );
    }, [friendPubkeys, creating, handleSelectMember]);

    // ── Render: Recents Chip ────────────────────────────────────────────────
    const renderRecentCard = useCallback(({ item }: { item: any }) => {
        const isFriend = friendPubkeys.has(item.publicKey);

        return (
            <Pressable
                accessibilityRole="button"
                style={styles.recentChip}
                onPress={() => handleSelectMember(item.publicKey)}
                disabled={!!creating}
            >
                <View style={styles.recentAvatar}>
                    <MemberAvatar avatarUrl={item.avatar_url} pubkey={item.publicKey} callsign={item.callsign || '?'} size={52} />
                </View>
                <Text style={styles.recentName} numberOfLines={1}>{item.callsign}</Text>
                {isFriend && <Text style={styles.recentStar}>★</Text>}
            </Pressable>
        );
    }, [friendPubkeys, creating, handleSelectMember]);

    const showRecents = !searchQuery.trim() && recents.length > 0;

    // ── Header component (Recents + Directory label) ────────────────────────
    const ListHeader = useMemo(() => (
        <>
            {/* Recents */}
            {showRecents && (
                <View style={styles.recentsSection}>
                    <Text style={styles.sectionTitle}>💬 Recently Chatted</Text>
                    <FlatList
                        data={recents}
                        keyExtractor={item => item.publicKey}
                        renderItem={renderRecentCard}
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.recentsList}
                    />
                </View>
            )}

            {/* Directory Header */}
            <View style={styles.directoryHeader}>
                <Text style={styles.sectionTitle}>
                    {searchQuery ? '🔍 Results' : '🏘️ Community Directory'}
                </Text>
                <Text style={styles.memberCount}>
                    {filteredMembers.length} {filteredMembers.length === 1 ? 'member' : 'members'}
                </Text>
            </View>
        </>
    ), [showRecents, recents, searchQuery, filteredMembers.length, renderRecentCard]);

    // ── Main Return ─────────────────────────────────────────────────────────
    return (
        <SafeAreaView style={styles.safeArea}>
            <KeyboardAvoidingView
                style={styles.container}
                behavior="padding"
            >
                {/* Header Bar */}
                <View style={styles.header}>
                    <Pressable style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
                        <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.body} />
                    </Pressable>
                    <Text style={styles.title}>New Message</Text>
                    <View style={{ width: 40 }} />
                </View>

                {/* Search Input — pinned at the top */}
                <View style={styles.searchContainer}>
                    <MaterialCommunityIcons name="magnify" size={20} color={colors.text.muted} style={styles.searchIcon} />
                    <TextInput
                        accessibilityLabel="Search by callsign or public key"
                        ref={searchRef}
                        style={styles.searchInput}
                        placeholder="Search by callsign or public key..."
                        placeholderTextColor={colors.text.muted}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        autoFocus={true}
                        returnKeyType="search"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    {searchQuery.length > 0 && (
                        <Pressable onPress={() => setSearchQuery('')} style={styles.clearBtn} accessibilityRole="button" accessibilityLabel="Clear search">
                            <MaterialCommunityIcons name="close-circle" size={18} color={colors.text.muted} />
                        </Pressable>
                    )}
                </View>

                {/* Body */}
                {loading ? (
                    <View style={styles.shimmerContainer}>
                        {Array.from({ length: 8 }).map((_, i) => <ShimmerRow key={i} index={i} styles={styles} />)}
                    </View>
                ) : (
                    <FlatList
                        data={filteredMembers}
                        keyExtractor={item => item.public_key}
                        renderItem={renderMemberCard}
                        getItemLayout={getItemLayout}
                        contentContainerStyle={styles.list}
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode="on-drag"
                        // ── Performance tuning for 1,000+ rows ──
                        initialNumToRender={15}
                        maxToRenderPerBatch={20}
                        windowSize={7}
                        removeClippedSubviews={Platform.OS !== 'web'}
                        ListHeaderComponent={ListHeader}
                        ListEmptyComponent={
                            <View style={styles.emptyContainer}>
                                <MaterialCommunityIcons name="account-search-outline" size={48} color={colors.border.strong} />
                                <Text style={styles.emptyTitle}>
                                    {searchQuery ? 'No members match your search' : 'No community members found'}
                                </Text>
                                <Text style={styles.emptySubtitle}>
                                    {searchQuery
                                        ? 'Try a different callsign or public key.'
                                        : 'Sync with a node to populate your directory.'}
                                </Text>
                            </View>
                        }
                    />
                )}
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}


