/**
 * ActivityWaterfall — Living Community Activity Pulse (#208) for React Native.
 *
 * Renders recent ambient community activity (joins, trades, ratings, posts)
 * when the marketplace is quiet or during cold-start.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ActivityIndicator,
    Pressable,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../app/ThemeContext';

export interface ActivityFeedItem {
    id: number;
    eventType: 'member_joined' | 'trade_completed' | 'rating_given' | 'post_created';
    actorPubkey: string;
    actorCallsign?: string;
    targetPubkey?: string;
    targetCallsign?: string;
    metadata?: Record<string, any>;
    createdAt: string;
}

function formatRelativeTime(isoDate: string): string {
    const diffMs = Date.now() - new Date(isoDate).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
}

interface Props {
    onCreatePostPress?: () => void;
}

export function ActivityWaterfall({ onCreatePostPress }: Props) {
    const { theme, colors } = useTheme();
    const isDark = theme === 'dark';
    const [feed, setFeed] = useState<ActivityFeedItem[]>([]);
    const [loading, setLoading] = useState(true);

    const loadFeed = useCallback(async () => {
        try {
            const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            if (!anchorUrl) {
                setLoading(false);
                return;
            }
            const cleanUrl = anchorUrl.replace(/\/$/, '');
            const res = await fetch(`${cleanUrl}/api/activity/feed?limit=25`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data?.feed)) {
                    setFeed(data.feed);
                }
            }
        } catch (e) {
            console.warn('[ActivityWaterfall] Error loading feed:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadFeed();
        const interval = setInterval(loadFeed, 30_000);
        return () => clearInterval(interval);
    }, [loadFeed]);

    if (loading && feed.length === 0) {
        return (
            <View style={styles.centerContainer}>
                <ActivityIndicator size="small" color={colors.brand.primary} />
                <Text style={[styles.loadingText, { color: colors.text.secondary }]}>
                    Tuning into community pulse…
                </Text>
            </View>
        );
    }

    if (feed.length === 0) {
        return (
            <View style={[styles.emptyCard, { backgroundColor: isDark ? '#18181b' : '#f4f4f5', borderColor: colors.border.default }]}>
                <Text style={styles.bigEmoji}>🌱</Text>
                <Text style={[styles.emptyTitle, { color: colors.text.body }]}>Welcome to the Community</Text>
                <Text style={[styles.emptySubtitle, { color: colors.text.secondary }]}>
                    You're among the first here! Create an offer or need to start local circulation.
                </Text>
                {onCreatePostPress && (
                    <Pressable
                        accessibilityRole="button"
                        style={[styles.primaryButton, { backgroundColor: colors.brand.primary }]}
                        onPress={onCreatePostPress}
                    >
                        <Text style={[styles.primaryButtonText, { color: colors.text.inverse }]}>+ Create First Post</Text>
                    </Pressable>
                )}
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.headerRow}>
                <View style={[styles.pulseBadge, { backgroundColor: isDark ? 'rgba(16, 185, 129, 0.15)' : '#ecfdf5', borderColor: isDark ? '#065f46' : '#a7f3d0' }]}>
                    <View style={styles.pulseDot} />
                    <Text style={[styles.pulseBadgeText, { color: isDark ? '#34d399' : '#047857' }]}>
                        Community Pulse
                    </Text>
                </View>
                <Text style={[styles.sectionTitle, { color: colors.text.body }]}>Recent Activity</Text>
            </View>

            <View style={styles.cardsList}>
                {feed.map((item) => {
                    const actorName = item.actorCallsign || 'Member';
                    const targetName = item.targetCallsign || 'Member';
                    const timeStr = formatRelativeTime(item.createdAt);

                    let emoji = '✨';
                    let content = null;

                    switch (item.eventType) {
                        case 'member_joined':
                            emoji = '🎉';
                            content = (
                                <Text style={[styles.itemText, { color: colors.text.body }]}>
                                    <Text style={styles.bold}>{actorName}</Text> joined the community
                                </Text>
                            );
                            break;
                        case 'trade_completed':
                            emoji = '✅';
                            content = (
                                <Text style={[styles.itemText, { color: colors.text.body }]}>
                                    <Text style={styles.bold}>{actorName}</Text> traded with{' '}
                                    <Text style={styles.bold}>{targetName}</Text>
                                    {item.metadata?.credits ? (
                                        <Text style={{ fontWeight: 'bold', color: '#10b981' }}> (🫘 {item.metadata.credits})</Text>
                                    ) : null}
                                </Text>
                            );
                            break;
                        case 'rating_given':
                            emoji = '⭐️';
                            content = (
                                <Text style={[styles.itemText, { color: colors.text.body }]}>
                                    <Text style={styles.bold}>{actorName}</Text> rated{' '}
                                    <Text style={styles.bold}>{targetName}</Text>{' '}
                                    <Text style={{ color: '#f59e0b', fontWeight: 'bold' }}>
                                        {'★'.repeat(item.metadata?.stars || 5)}
                                    </Text>
                                </Text>
                            );
                            break;
                        case 'post_created':
                            emoji = '📍';
                            content = (
                                <Text style={[styles.itemText, { color: colors.text.body }]}>
                                    <Text style={styles.bold}>{actorName}</Text> posted{' '}
                                    <Text style={styles.bold}>"{item.metadata?.title || 'Listing'}"</Text>
                                </Text>
                            );
                            break;
                    }

                    return (
                        <View
                            key={item.id}
                            style={[
                                styles.card,
                                {
                                    backgroundColor: isDark ? '#18181b' : '#ffffff',
                                    borderColor: colors.border.default,
                                },
                            ]}
                        >
                            <View style={[styles.emojiBox, { backgroundColor: isDark ? '#27272a' : '#f4f4f5' }]}>
                                <Text style={styles.cardEmoji}>{emoji}</Text>
                            </View>
                            <View style={styles.textContainer}>
                                {content}
                            </View>
                            <Text style={[styles.timeText, { color: colors.text.secondary }]}>
                                {timeStr}
                            </Text>
                        </View>
                    );
                })}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        width: '100%',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    centerContainer: {
        padding: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
    loadingText: {
        fontSize: 13,
        fontWeight: '600',
        marginTop: 10,
    },
    headerRow: {
        alignItems: 'center',
        marginBottom: 14,
    },
    pulseBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 16,
        borderWidth: 1,
        marginBottom: 6,
        gap: 6,
    },
    pulseDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#10b981',
    },
    pulseBadgeText: {
        fontSize: 11,
        fontWeight: '800',
    },
    sectionTitle: {
        fontSize: 15,
        fontWeight: '800',
    },
    cardsList: {
        gap: 8,
    },
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 16,
        borderWidth: 1,
        gap: 10,
    },
    emojiBox: {
        width: 36,
        height: 36,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    cardEmoji: {
        fontSize: 18,
    },
    textContainer: {
        flex: 1,
    },
    itemText: {
        fontSize: 13,
        lineHeight: 18,
    },
    bold: {
        fontWeight: '700',
    },
    timeText: {
        fontSize: 11,
        fontWeight: '500',
    },
    emptyCard: {
        margin: 16,
        padding: 28,
        borderRadius: 20,
        borderWidth: 1,
        alignItems: 'center',
    },
    bigEmoji: {
        fontSize: 38,
        marginBottom: 10,
    },
    emptyTitle: {
        fontSize: 16,
        fontWeight: '800',
        marginBottom: 6,
    },
    emptySubtitle: {
        fontSize: 13,
        textAlign: 'center',
        lineHeight: 18,
        marginBottom: 16,
    },
    primaryButton: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 12,
    },
    primaryButtonText: {
        fontSize: 13,
        fontWeight: '800',
    },
});
