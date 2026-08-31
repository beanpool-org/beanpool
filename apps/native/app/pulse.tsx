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
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import {
    fetchPulseFeed,
    mutePulseItem,
    type PulseFeedItem,
} from '../utils/pulse';
import { PulseFeedCard } from '../components/PulseFeedCard';

export default function PulseScreen() {
    const { colors, theme } = useTheme();
    const { identity } = useIdentity();
    const styles = useStyles(makeStyles);

    const [items, setItems] = useState<PulseFeedItem[]>([]);
    const [selectedCategory, setSelectedCategory] = useState<ChannelCategory | 'all'>('all');
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Track active category for async callbacks
    const activeCategoryRef = useRef(selectedCategory);
    useEffect(() => {
        activeCategoryRef.current = selectedCategory;
    }, [selectedCategory]);

    const loadFeed = useCallback(async (isRefresh = false, category = selectedCategory) => {
        if (isRefresh) {
            setRefreshing(true);
        } else {
            setLoading(true);
        }
        setError(null);

        try {
            const res = await fetchPulseFeed({
                category: category === 'all' ? undefined : category,
                limit: 20,
            });

            // Prevent race condition if category switched mid-flight
            if (activeCategoryRef.current !== category) return;

            setItems(res.items);
            setNextCursor(res.nextCursor);
        } catch (e: any) {
            if (activeCategoryRef.current === category) {
                setError(e?.message || 'Could not load community feed.');
            }
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [selectedCategory]);

    useEffect(() => {
        loadFeed(false, selectedCategory);
    }, [loadFeed, selectedCategory]);

    const handleRefresh = async () => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        await loadFeed(true, selectedCategory);
    };

    const handleLoadMore = async () => {
        if (loadingMore || !nextCursor || loading || refreshing) return;
        setLoadingMore(true);

        try {
            const res = await fetchPulseFeed({
                category: selectedCategory === 'all' ? undefined : selectedCategory,
                cursor: nextCursor,
                limit: 20,
            });

            if (activeCategoryRef.current !== selectedCategory) return;

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

        // Optimistic removal from feed
        const previousItems = [...items];
        setItems(prev => prev.filter(i => i.id !== itemId));

        try {
            await mutePulseItem(itemId, true, identity);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        } catch (e: any) {
            // Revert on failure
            setItems(previousItems);
            setError(e?.message || 'Could not hide that item.');
        }
    };

    const renderEmptyState = () => {
        if (loading) return null;

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

    return (
        <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerTop}>
                    <Pressable
                        onPress={() => router.back()}
                        style={styles.backBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Go back"
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Text style={styles.backText}>‹ Back</Text>
                    </Pressable>

                    <Pressable
                        onPress={() => router.push('/channels')}
                        style={styles.channelsBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Manage your channels"
                    >
                        <Text style={styles.channelsBtnText}>+ Channels</Text>
                    </Pressable>
                </View>

                <View style={styles.titleRow}>
                    <Text style={styles.title}>The Pulse</Text>
                    <Text style={styles.subtitle}>
                        What your neighbours are creating and sharing
                    </Text>
                </View>

                {/* Category Filter Bar */}
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
            </View>

            {/* Error Message Box */}
            {error && (
                <View style={styles.errorBox} accessibilityRole="alert">
                    <Text style={styles.errorText}>{error}</Text>
                    <Pressable
                        onPress={() => loadFeed(false, selectedCategory)}
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
                    data={items}
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
