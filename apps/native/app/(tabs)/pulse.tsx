/**
 * The Pulse — Local Community Activity Feed (Phase 3).
 *
 * Consumes Contract B:
 * - GET /api/pulse/feed (public read, cursor pagination, category filtering)
 * - POST /api/member/pulse/items/:id/mute (signed owner mutation)
 *
 * Rules:
 * - Facade cards, NOT embeds: taps open external post on platform.
 * - Prioritizes creator attribution: "my neighbour made this".
 * - Honest empty states for newly syndicated nodes.
 * - Responsive at 320dp and 1.3x font scale with pull-to-refresh & infinite cursor scroll.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Pressable,
    FlatList,
    ActivityIndicator,
    RefreshControl,
    ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { CATEGORIES, type ChannelCategory } from '@beanpool/core';
import { useIdentity } from '../IdentityContext';
import { useTheme, useStyles } from '../ThemeContext';
import {
    fetchPulseFeed,
    isOfficialSource,
    mutePulseItem,
    type PulseFeedItem,
} from '../../utils/pulse';
import { PulseFeedCard } from '../../components/PulseFeedCard';

export default function PulseScreen() {
    const { colors, theme } = useTheme();
    const { identity } = useIdentity();
    const styles = useStyles(makeStyles);

    const [lane, setLane] = useState<'neighbours' | 'local' | 'learn'>('neighbours');
    const [items, setItems] = useState<PulseFeedItem[]>([]);
    const [selectedCategory, setSelectedCategory] = useState<ChannelCategory | 'all'>('all');
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasLocalLane, setHasLocalLane] = useState(false);

    // Client-side split is a prototype shortcut — see isOfficialSource(). Production
    // should pass the lane to the API so pagination stays correct per lane.
    const localItems = items.filter(isOfficialSource);
    const neighbourItems = items.filter(i => !isOfficialSource(i));

    useEffect(() => {
        if (lane !== 'learn') {
            setHasLocalLane(localItems.length > 0);
        }
    }, [lane, localItems.length]);

    const localLaneAvailable = lane === 'learn' ? hasLocalLane : localItems.length > 0;
    const activeLane = lane === 'learn'
        ? 'learn'
        : (lane === 'local' && localLaneAvailable)
        ? 'local'
        : 'neighbours';
    const visibleItems = activeLane === 'learn'
        ? items
        : activeLane === 'local'
        ? localItems
        : neighbourItems;

    // Track active category and lane for async callbacks
    const activeCategoryRef = useRef(selectedCategory);
    const activeLaneRef = useRef(lane);
    useEffect(() => {
        activeCategoryRef.current = selectedCategory;
    }, [selectedCategory]);
    useEffect(() => {
        activeLaneRef.current = lane;
    }, [lane]);

    const loadFeed = useCallback(async (isRefresh = false, currentLane = lane, category = selectedCategory) => {
        if (isRefresh) {
            setRefreshing(true);
        } else {
            setLoading(true);
        }
        setError(null);

        const fetchCat = currentLane === 'learn'
            ? 'learn'
            : (category === 'all' ? undefined : category);

        try {
            const res = await fetchPulseFeed({
                category: fetchCat,
                limit: 20,
            });

            // Prevent race condition if category or lane switched mid-flight
            if (activeCategoryRef.current !== category || activeLaneRef.current !== currentLane) return;

            setItems(res.items);
            setNextCursor(res.nextCursor);
        } catch (e: any) {
            if (activeCategoryRef.current === category && activeLaneRef.current === currentLane) {
                setError(e?.message || 'Could not load community feed.');
            }
        } finally {
            if (activeCategoryRef.current === category && activeLaneRef.current === currentLane) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, [lane, selectedCategory]);

    useEffect(() => {
        loadFeed(false, lane, selectedCategory);
    }, [loadFeed, lane, selectedCategory]);

    const handleRefresh = async () => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        await loadFeed(true, lane, selectedCategory);
    };

    const handleLoadMore = async () => {
        if (loadingMore || !nextCursor || loading || refreshing) return;
        setLoadingMore(true);

        const fetchCat = lane === 'learn'
            ? 'learn'
            : (selectedCategory === 'all' ? undefined : selectedCategory);

        try {
            const res = await fetchPulseFeed({
                category: fetchCat,
                cursor: nextCursor,
                limit: 20,
            });

            if (activeCategoryRef.current !== selectedCategory || activeLaneRef.current !== lane) return;

            setItems(prev => {
                const existingIds = new Set(prev.map(i => i.id));
                const newItems = res.items.filter(i => !existingIds.has(i.id));
                return [...prev, ...newItems];
            });
            setNextCursor(res.nextCursor);
        } catch (e: any) {
            console.warn('[PulseScreen] Failed to load more items:', e);
        } finally {
            setLoadingMore(false);
        }
    };

    const handleSelectCategory = (cat: ChannelCategory | 'all') => {
        if (cat === selectedCategory) return;
        void Haptics.selectionAsync().catch(() => {});
        setSelectedCategory(cat);
    };

    const handleMute = async (itemId: string) => {
        if (!identity) return;

        const itemToMute = items.find(i => i.id === itemId);
        if (!itemToMute) return;

        // Optimistic removal from feed
        setItems(prev => prev.filter(i => i.id !== itemId));

        try {
            await mutePulseItem(itemId, true, identity);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        } catch (e: any) {
            // Revert only the specific item without overwriting other feed updates
            setItems(prev => {
                if (prev.some(i => i.id === itemId)) return prev;
                const updated = [...prev, itemToMute];
                updated.sort((a, b) => {
                    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
                    const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
                    return db - da;
                });
                return updated;
            });
            setError(e?.message || 'Could not hide that item.');
        }
    };

    const renderEmptyState = () => {
        if (loading) return null;

        if (activeLane === 'learn') {
            return (
                <View style={styles.emptyContainer}>
                    <Text style={styles.emptyIcon}>📚</Text>
                    <Text style={styles.emptyTitle}>No learning guides yet</Text>
                    <Text style={styles.emptyBody}>
                        Curated guides and reflections will appear here.
                    </Text>
                </View>
            );
        }

        if (selectedCategory !== 'all') {
            return (
                <View style={styles.emptyContainer}>
                    <Text style={styles.emptyIcon}>🔍</Text>
                    <Text style={styles.emptyTitle}>No posts in this category yet</Text>
                    <Text style={styles.emptyBody}>
                        Try selecting "All" or check another category to see what neighbours have posted.
                    </Text>
                    <Pressable
                        onPress={() => setSelectedCategory('all')}
                        style={styles.emptyBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Show all categories"
                    >
                        <Text style={styles.emptyBtnText}>Show all categories</Text>
                    </Pressable>
                </View>
            );
        }

        return (
            <View style={styles.emptyContainer}>
                <Text style={styles.emptyIcon}>🗞️</Text>
                <Text style={styles.emptyTitle}>The Pulse is quiet right now</Text>
                <Text style={styles.emptyBody}>
                    Items from neighbours' YouTube channels and blogs appear here automatically once syndicated.
                    As more members connect their channels, this feed will fill up.
                </Text>
                <Pressable
                    onPress={() => router.push('/channels')}
                    style={styles.emptyPrimaryBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Connect your channels"
                >
                    <Text style={styles.emptyPrimaryBtnText}>+ Connect your channels</Text>
                </Pressable>
            </View>
        );
    };

    const renderFooter = () => {
        if (!loadingMore) return null;
        return (
            <View style={styles.footerLoader}>
                <ActivityIndicator size="small" color={colors.brand.primary} />
                <Text style={styles.footerLoaderText}>Loading more posts…</Text>
            </View>
        );
    };

    // No 'top' edge: Pulse is a tab now, and GlobalHeader above it already consumes the top
    // safe-area inset. Keeping it here applied the status-bar/notch inset a SECOND time,
    // leaving a dead gap under the tab bar — worst on the small screens we support, where
    // the header, tab bar and gap stack up before any content gets a chance.
    return (
        <SafeAreaView style={styles.screen} edges={['left', 'right']}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerTop}>
                    {/* Pulse is a tab now, but settings still pushes to /pulse (kept as a
                        fallback while the app-review instructions reference that path), so
                        Back only makes sense when we actually arrived on a stack. */}
                    {router.canGoBack() ? (
                        <Pressable
                            onPress={() => router.back()}
                            style={styles.backBtn}
                            accessibilityRole="button"
                            accessibilityLabel="Go back"
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                            <Text style={styles.backText}>‹ Back</Text>
                        </Pressable>
                    ) : <View />}

                    <Pressable
                        onPress={() => router.push('/channels')}
                        style={styles.channelsBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Manage your channels"
                    >
                        <Text style={styles.channelsBtnText}>+ Channels</Text>
                    </Pressable>
                </View>

                {/* Title lives in GlobalHeader now that Pulse is a tab; keeping it here too
                    would say "The Pulse" twice and cost a line of vertical space. */}
                <View style={styles.titleRow}>
                    <Text style={styles.subtitle}>
                        {activeLane === 'learn'
                            ? 'How BeanPool works and daily reflections'
                            : activeLane === 'local'
                            ? 'News and notices from around the shire'
                            : 'What your neighbours are creating and sharing'}
                    </Text>
                </View>

                {/* Lane switch */}
                <View style={styles.laneBar}>
                    {([
                        { id: 'neighbours' as const, label: 'Neighbours', icon: '\u{1F465}', count: activeLane === 'learn' ? 0 : neighbourItems.length },
                        ...(localLaneAvailable ? [{ id: 'local' as const, label: 'Local', icon: '\u{1F4F0}', count: localItems.length }] : []),
                        { id: 'learn' as const, label: 'Learn', icon: '📚', count: activeLane === 'learn' ? items.length : 0 },
                    ]).map(l => {
                        const active = activeLane === l.id;
                        return (
                            <Pressable
                                key={l.id}
                                onPress={() => {
                                    void Haptics.selectionAsync().catch(() => {});
                                    setLane(l.id);
                                }}
                                style={[styles.laneTab, active && styles.laneTabActive]}
                                accessibilityRole="radio"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={l.count > 0 ? `${l.label} feed, ${l.count} items` : `${l.label} feed`}
                            >
                                <Text
                                    style={[styles.laneTabText, active && styles.laneTabTextActive]}
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                >
                                    {l.icon}  {l.label}
                                </Text>
                                {l.count > 0 ? (
                                    <Text style={[styles.laneCount, active && styles.laneCountActive]}>
                                        {l.count}
                                    </Text>
                                ) : null}
                            </Pressable>
                        );
                    })}
                </View>

                {/* Category Filter Bar — only shown for Neighbours and Local lanes */}
                {activeLane !== 'learn' && (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.categoryScroll}
                    style={styles.categoryContainer}
                >
                    <Pressable
                        onPress={() => handleSelectCategory('all')}
                        style={[
                            styles.categoryChip,
                            selectedCategory === 'all' && styles.categoryChipActive,
                        ]}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: selectedCategory === 'all' }}
                        accessibilityLabel="All categories"
                        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                    >
                        <Text
                            style={[
                                styles.categoryChipText,
                                selectedCategory === 'all' && styles.categoryChipTextActive,
                            ]}
                        >
                            🌐 All
                        </Text>
                    </Pressable>

                    {CATEGORIES.map(c => {
                        const active = selectedCategory === c.id;
                        return (
                            <Pressable
                                key={c.id}
                                onPress={() => handleSelectCategory(c.id)}
                                style={[
                                    styles.categoryChip,
                                    active && styles.categoryChipActive,
                                ]}
                                accessibilityRole="radio"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={c.label}
                                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                            >
                                <Text
                                    style={[
                                        styles.categoryChipText,
                                        active && styles.categoryChipTextActive,
                                    ]}
                                >
                                    {c.icon} {c.label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>
                )}
            </View>

            {/* Error Message Box */}
            {error && (
                <View style={styles.errorBox} accessibilityRole="alert">
                    <Text style={styles.errorText}>{error}</Text>
                    <Pressable
                        onPress={() => loadFeed(false, lane, selectedCategory)}
                        style={styles.retryBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Retry loading feed"
                    >
                        <Text style={styles.retryBtnText}>Retry</Text>
                    </Pressable>
                </View>
            )}

            {/* Feed List */}
            {loading && !refreshing ? (
                <View style={styles.centerLoader}>
                    <ActivityIndicator size="large" color={colors.brand.primary} />
                    <Text style={styles.loaderText}>Loading community feed…</Text>
                </View>
            ) : (
                <FlatList
                    data={visibleItems}
                    keyExtractor={item => item.id}
                    renderItem={({ item }) => (
                        <PulseFeedCard
                            item={item}
                            currentPubkey={identity?.publicKey}
                            onMute={handleMute}
                        />
                    )}
                    contentContainerStyle={styles.listContent}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={handleRefresh}
                            tintColor={colors.brand.primary}
                            colors={[colors.brand.primary]}
                        />
                    }
                    onEndReached={handleLoadMore}
                    onEndReachedThreshold={0.3}
                    ListEmptyComponent={renderEmptyState}
                    ListFooterComponent={renderFooter}
                />
            )}
        </SafeAreaView>
    );
}

const makeStyles = ({ colors, theme }: { colors: any; theme: string }) =>
    StyleSheet.create({
        screen: {
            flex: 1,
            backgroundColor: colors.surface.app,
        },
        header: {
            paddingTop: 8,
            paddingBottom: 10,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
            backgroundColor: colors.surface.app,
        },
        headerTop: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
        },
        backBtn: {
            paddingVertical: 6,
            paddingHorizontal: 4,
            alignSelf: 'flex-start',
        },
        backText: {
            color: colors.text.link,
            fontSize: 16,
            fontWeight: '600',
        },
        channelsBtn: {
            paddingVertical: 6,
            paddingHorizontal: 12,
            borderRadius: 8,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        channelsBtnText: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.text.body,
        },
        titleRow: {
            paddingHorizontal: 16,
            marginTop: 6,
        },
        title: {
            fontSize: 22,
            fontWeight: '800',
            color: colors.text.heading,
        },
        subtitle: {
            fontSize: 13,
            color: colors.text.secondary,
            marginTop: 2,
            lineHeight: 18,
        },
        categoryContainer: {
            marginTop: 10,
        },
        categoryScroll: {
            paddingHorizontal: 16,
            gap: 8,
            flexDirection: 'row',
            alignItems: 'center',
        },
        laneBar: {
            flexDirection: 'row',
            marginHorizontal: 16,
            marginBottom: 12,
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            padding: 3,
            gap: 3,
        },
        laneTab: {
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingVertical: 9,
            minHeight: 44,
            borderRadius: 9,
        },
        laneTabActive: {
            backgroundColor: colors.surface.card,
            shadowColor: '#000',
            shadowOpacity: 0.08,
            shadowRadius: 3,
            shadowOffset: { width: 0, height: 1 },
            elevation: 2,
        },
        laneTabText: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        laneTabTextActive: {
            color: colors.text.heading,
            fontWeight: '800',
        },
        laneCount: {
            fontSize: 11,
            fontWeight: '700',
            color: colors.text.muted,
            overflow: 'hidden',
        },
        laneCountActive: {
            color: colors.accent.primary,
        },
        categoryChip: {
            paddingVertical: 6,
            paddingHorizontal: 12,
            borderRadius: 999,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
            minHeight: 34,
            justifyContent: 'center',
            alignItems: 'center',
        },
        categoryChipActive: {
            backgroundColor: colors.brand.primary,
            borderColor: colors.brand.primary,
        },
        categoryChipText: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.text.body,
        },
        categoryChipTextActive: {
            color: colors.text.inverse,
        },
        errorBox: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: colors.market.need.bg,
            padding: 12,
            marginHorizontal: 16,
            marginTop: 12,
            borderRadius: 10,
        },
        errorText: {
            color: colors.market.need.fg,
            fontSize: 14,
            flex: 1,
            marginRight: 8,
        },
        retryBtn: {
            paddingVertical: 6,
            paddingHorizontal: 12,
            backgroundColor: colors.surface.card,
            borderRadius: 6,
        },
        retryBtnText: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.market.need.fg,
        },
        centerLoader: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 32,
        },
        loaderText: {
            marginTop: 12,
            fontSize: 14,
            color: colors.text.secondary,
        },
        listContent: {
            padding: 16,
            paddingBottom: 36,
            flexGrow: 1,
        },
        footerLoader: {
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
            paddingVertical: 16,
            gap: 8,
        },
        footerLoaderText: {
            fontSize: 13,
            color: colors.text.secondary,
        },
        emptyContainer: {
            paddingVertical: 48,
            paddingHorizontal: 24,
            alignItems: 'center',
            justifyContent: 'center',
        },
        emptyIcon: {
            fontSize: 48,
            marginBottom: 12,
        },
        emptyTitle: {
            fontSize: 18,
            fontWeight: '700',
            color: colors.text.heading,
            textAlign: 'center',
            marginBottom: 8,
        },
        emptyBody: {
            fontSize: 14,
            lineHeight: 21,
            color: colors.text.secondary,
            textAlign: 'center',
            marginBottom: 20,
        },
        emptyBtn: {
            paddingVertical: 10,
            paddingHorizontal: 18,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border.strong,
        },
        emptyBtnText: {
            fontSize: 14,
            fontWeight: '600',
            color: colors.text.body,
        },
        emptyPrimaryBtn: {
            paddingVertical: 12,
            paddingHorizontal: 20,
            borderRadius: 8,
            backgroundColor: colors.brand.primary,
        },
        emptyPrimaryBtnText: {
            fontSize: 15,
            fontWeight: '600',
            color: colors.text.inverse,
        },
    });
