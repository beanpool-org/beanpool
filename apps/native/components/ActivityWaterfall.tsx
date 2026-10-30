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
    AppState,
    type AppStateStatus,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../app/ThemeContext';
import { withJitter } from '../utils/jitter';
import { signedGet } from '../utils/db';
import { t, tn, activityTarget } from '@beanpool/core';
import { Sentence } from './Sentence';

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
    if (diffMins < 1) return t('just now');
    if (diffMins < 60) return t('{n}m ago', { n: diffMins });
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return t('{n}h ago', { n: diffHours });
    const diffDays = Math.floor(diffHours / 24);
    return t('{n}d ago', { n: diffDays });
}

interface Props {
    onCreatePostPress?: () => void;
    /** Open the listing a row names (the phone's own post screen). Omitted means rows that would open a listing stay plain text. */
    onOpenPost?: (postId: string) => void;
    /** Open a member's profile from a row. Same rule as `onOpenPost` when omitted. */
    onOpenProfile?: (pubkey: string, callsign?: string) => void;
    /** The signed-in member, so a rating or trade row opens the OTHER member's profile, never the viewer's own. */
    viewerPubkey?: string | null;
}

export function ActivityWaterfall({ onCreatePostPress, onOpenPost, onOpenProfile, viewerPubkey }: Props) {
    const { theme, colors } = useTheme();
    const isDark = theme === 'dark';
    const [feed, setFeed] = useState<ActivityFeedItem[]>([]);
    const [loading, setLoading] = useState(true);
    // The node serves this feed to its members only (it names who traded with whom, and for how
    // many Beans). A guest browsing a community they have not joined gets 401/403.
    const [membersOnly, setMembersOnly] = useState(false);

    useEffect(() => {
        let isMounted = true;
        let refused = false;

        async function loadFeed() {
            try {
                const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                if (!anchorUrl) {
                    if (isMounted) setLoading(false);
                    return;
                }
                const res = await signedGet('/api/activity/feed?limit=25');
                if (res.status === 401 || res.status === 403) {
                    // Not a member here: stop polling for an answer that will not change while this screen is up.
                    refused = true;
                    stopPolling();
                    if (isMounted) setMembersOnly(true);
                    return;
                }
                if (res.ok && isMounted) {
                    const data = await res.json();
                    if (Array.isArray(data?.feed)) {
                        setFeed(data.feed);
                    }
                }
            } catch (e) {
                console.warn('[ActivityWaterfall] Error loading feed:', e);
            } finally {
                if (isMounted) setLoading(false);
            }
        }

        // No standalone loadFeed() here — startPolling() does the initial load, so calling it
        // here too fetched the feed twice on every mount. If the app is backgrounded at mount,
        // startPolling is not called and nothing is fetched until it foregrounds, which is the
        // point of the change.
        let interval: ReturnType<typeof setInterval> | null = null;

        const startPolling = () => {
            if (!interval && !refused) {
                loadFeed();
                interval = setInterval(loadFeed, withJitter(30_000));
            }
        };

        const stopPolling = () => {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
        };

        const handleAppStateChange = (nextState: AppStateStatus) => {
            if (nextState === 'active') {
                startPolling();
            } else {
                stopPolling();
            }
        };

        if (AppState.currentState === 'active') {
            startPolling();
        }

        const sub = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            isMounted = false;
            stopPolling();
            sub.remove();
        };
    }, []);

    if (membersOnly) {
        return (
            <View style={[styles.emptyCard, { backgroundColor: isDark ? '#18181b' : '#f4f4f5', borderColor: colors.border.default }]}>
                <Text style={styles.bigEmoji}>🌱</Text>
                <Text style={[styles.emptyTitle, { color: colors.text.body }]}>{t('Community activity is for members')}</Text>
                <Text style={[styles.emptySubtitle, { color: colors.text.secondary }]}>
                    {t('Join this community to see who is trading and who is new.')}
                </Text>
            </View>
        );
    }

    if (loading && feed.length === 0) {
        return (
            <View style={styles.centerContainer}>
                <ActivityIndicator size="small" color={colors.brand.primary} />
                <Text style={[styles.loadingText, { color: colors.text.secondary }]}>
                    {t('Tuning into community pulse…')}
                </Text>
            </View>
        );
    }

    if (feed.length === 0) {
        return (
            <View style={[styles.emptyCard, { backgroundColor: isDark ? '#18181b' : '#f4f4f5', borderColor: colors.border.default }]}>
                <Text style={styles.bigEmoji}>🌱</Text>
                <Text style={[styles.emptyTitle, { color: colors.text.body }]}>{t('Welcome to the Community')}</Text>
                <Text style={[styles.emptySubtitle, { color: colors.text.secondary }]}>
                    {t("You're among the first here! Create an offer or need to start local circulation.")}
                </Text>
                {onCreatePostPress && (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('Create First Post')}
                        accessibilityHint={t('Opens form to create a new offer or need post')}
                        style={[styles.primaryButton, { backgroundColor: colors.brand.fill }]}
                        onPress={onCreatePostPress}
                    >
                        <Text style={[styles.primaryButtonText, { color: colors.text.inverse }]}>{t('+ Create First Post')}</Text>
                    </Pressable>
                )}
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.headerRow}>
                <View style={[styles.pulseBadge, { backgroundColor: isDark ? 'rgba(16, 185, 129, 0.15)' : '#ecfdf5', borderColor: isDark ? '#065f46' : '#a7f3d0' }]}>
                    <View style={[styles.pulseDot, { backgroundColor: colors.brand.fill }]} />
                    <Text style={[styles.pulseBadgeText, { color: colors.feedback.success.fg }]}>
                        {t('Community Pulse')}
                    </Text>
                </View>
                <Text style={[styles.sectionTitle, { color: colors.text.body }]}>{t('Recent Activity')}</Text>
            </View>

            <View style={styles.cardsList}>
                {feed.map((item) => {
                    const actorName = item.actorCallsign || t('Member');
                    const targetName = item.targetCallsign || t('Member');
                    const timeStr = formatRelativeTime(item.createdAt);
                    // Each line is one sentence in the member's language; the names are bold parts of it, wherever the
                    // language puts them (components/Sentence).
                    const actor = <Text style={styles.bold}>{actorName}</Text>;
                    const target = <Text style={styles.bold}>{targetName}</Text>;
                    const names = { actor: actorName, target: targetName };

                    let emoji = '✨';
                    let content = null;
                    let summaryText = '';

                    switch (item.eventType) {
                        case 'member_joined':
                            emoji = '🎉';
                            summaryText = t('{actor} joined the community', names);
                            content = (
                                <Text style={[styles.itemText, { color: colors.text.body }]}>
                                    <Sentence text={t('{actor} joined the community')} parts={{ actor }} />
                                </Text>
                            );
                            break;
                        case 'trade_completed': {
                            emoji = '✅';
                            const credits = item.metadata?.credits;
                            summaryText = credits
                                ? tn(Number(credits), '{actor} traded with {target} for {n} Beans', '{actor} traded with {target} for {n} Beans', names)
                                : t('{actor} traded with {target}', names);
                            content = (
                                <Text style={[styles.itemText, { color: colors.text.body }]}>
                                    <Sentence text={t('{actor} traded with {target}')} parts={{ actor, target }} />
                                    {credits ? (
                                        <Text style={{ fontWeight: 'bold', color: colors.brand.primary }}> (🫘 {credits})</Text>
                                    ) : null}
                                </Text>
                            );
                            break;
                        }
                        case 'rating_given': {
                            const starCount = Math.max(1, Math.min(5, Math.round(Number(item.metadata?.stars) || 5)));
                            emoji = '⭐️';
                            summaryText = tn(starCount, '{actor} rated {target} {n} out of 5 stars', '{actor} rated {target} {n} out of 5 stars', names);
                            const stars = (
                                <Text
                                    style={{ color: colors.feedback.warning.fg, fontWeight: 'bold' }}
                                    accessibilityLabel={tn(starCount, '{n} out of 5 stars', '{n} out of 5 stars')}
                                >
                                    {'★'.repeat(starCount)}
                                </Text>
                            );
                            content = (
                                <Text style={[styles.itemText, { color: colors.text.body }]}>
                                    <Sentence text={t('{actor} rated {target} {stars}')} parts={{ actor, target, stars }} />
                                </Text>
                            );
                            break;
                        }
                        case 'post_created': {
                            emoji = '📍';
                            const title = item.metadata?.title || t('Listing');
                            summaryText = t('{actor} posted "{title}"', { actor: actorName, title });
                            content = (
                                <Text style={[styles.itemText, { color: colors.text.body }]}>
                                    <Sentence text={t('{actor} posted "{title}"')} parts={{ actor, title: <Text style={styles.bold}>{title}</Text> }} />
                                </Text>
                            );
                            break;
                        }
                    }

                    const rowTarget = activityTarget(item, viewerPubkey);
                    const canOpen = rowTarget !== null
                        && ((rowTarget.kind === 'post' && !!onOpenPost) || (rowTarget.kind === 'profile' && !!onOpenProfile));
                    const cardStyle = [
                        styles.card,
                        {
                            backgroundColor: isDark ? '#18181b' : '#ffffff',
                            borderColor: colors.border.default,
                        },
                    ];
                    const cardBody = (
                        <>
                            <View style={[styles.emojiBox, { backgroundColor: isDark ? '#27272a' : '#f4f4f5' }]}>
                                <Text style={styles.cardEmoji}>{emoji}</Text>
                            </View>
                            <View style={styles.textContainer}>
                                {content}
                            </View>
                            <Text style={[styles.timeText, { color: colors.text.secondary }]}>
                                {timeStr}
                            </Text>
                        </>
                    );
                    const rowLabel = t('{summary}, {time}', { summary: summaryText, time: timeStr });

                    // One real button when the row has somewhere to go; a row with nothing to open stays plain text.
                    if (!canOpen || rowTarget === null) {
                        return (
                            <View key={item.id} accessible={true} accessibilityLabel={rowLabel} style={cardStyle}>
                                {cardBody}
                            </View>
                        );
                    }
                    return (
                        <Pressable
                            key={item.id}
                            accessibilityRole="button"
                            accessibilityLabel={rowLabel}
                            style={({ pressed }) => [cardStyle, pressed && { opacity: 0.7 }]}
                            onPress={() => {
                                if (rowTarget.kind === 'post') onOpenPost?.(rowTarget.postId);
                                else onOpenProfile?.(rowTarget.pubkey, item.targetPubkey === rowTarget.pubkey ? item.targetCallsign : item.actorCallsign);
                            }}
                        >
                            {cardBody}
                        </Pressable>
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
        minHeight: 44,
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
        minHeight: 44,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 12,
    },
    primaryButtonText: {
        fontSize: 13,
        fontWeight: '800',
    },
});
