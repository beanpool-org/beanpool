/**
 * Pulse Nudges — Clipboard & Post-Count Ingestion Prompts (The Pulse, Package 05).
 *
 * 1. Clipboard Nudge:
 *    - Reads Clipboard.getStringAsync() from expo-clipboard.
 *    - Checks if the URL matches any of the member's connected channels.
 *    - Uses AsyncStorage ('pulse_seen_clip_' + url) to offer adding once per URL,
 *      never repeatedly, never interrupting app boot.
 *    - Banner with "Add to Pulse" directing to /pulse-intake?url=... and "Dismiss".
 *
 * 2. Post-Count Nudge:
 *    - Compares channel's probed count vs post_count_seen.
 *    - Displays "You've posted N new things on <Platform>".
 *    - "Share" button leads to manual intake.
 *    - "Dismiss" button calls POST /api/member/pulse/channels/:id/dismiss-nudge,
 *      advancing the watermark so it goes quiet.
 *
 * Rules:
 * - Reflows cleanly at 320dp width and 1.3x font scale.
 * - Uses flexGrow/flexBasis, never fixed percentages.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, AppState, AppStateStatus } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { platformMeta, isWebUrl, type ChannelPlatform } from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import { anchorUrl, signedPost } from '../utils/node-post';

export interface ChannelSummary {
    id: string;
    platform: ChannelPlatform;
    url?: string | null;
    handle?: string | null;
    postCountSeen?: number | null;
}

interface PostCountNudge {
    channelId: string;
    platform: ChannelPlatform;
    handle: string | null;
    newPostsCount: number;
    currentCount: number;
}

interface Props {
    channels?: ChannelSummary[];
    onNudgeDismissed?: () => void;
}

export function PulseNudges({ channels, onNudgeDismissed }: Props) {
    const { colors, theme } = useTheme();
    const { identity } = useIdentity();
    const styles = useStyles(makeStyles);

    const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);
    const [clipboardPlatform, setClipboardPlatform] = useState<ChannelPlatform | null>(null);
    const [postCountNudges, setPostCountNudges] = useState<PostCountNudge[]>([]);
    const [dismissingChannelId, setDismissingChannelId] = useState<string | null>(null);

    const checkedClipboardsRef = useRef<Set<string>>(new Set());

    /**
     * Check clipboard content non-intrusively
     */
    const checkClipboard = useCallback(async () => {
        if (!channels || channels.length === 0) return;
        try {
            const hasString = await Clipboard.hasStringAsync();
            if (!hasString) return;

            const text = await Clipboard.getStringAsync();
            if (!text || !text.trim()) return;

            const clean = text.trim();
            if (!isWebUrl(clean)) return;

            // Check if already processed in this memory session
            if (checkedClipboardsRef.current.has(clean)) return;
            checkedClipboardsRef.current.add(clean);

            // Check AsyncStorage to offer only ONCE per URL
            const seenKey = `pulse_seen_clip_${clean}`;
            const alreadySeen = await AsyncStorage.getItem(seenKey);
            if (alreadySeen) return;

            // Check if URL matches any connected channel
            const lowerUrl = clean.toLowerCase();
            let matchedPlatform: ChannelPlatform | null = null;

            for (const ch of channels) {
                if (ch.platform === 'instagram' && (lowerUrl.includes('instagram.com/p/') || lowerUrl.includes('instagram.com/reel/'))) {
                    matchedPlatform = 'instagram';
                    break;
                }
                if (ch.platform === 'tiktok' && lowerUrl.includes('tiktok.com/')) {
                    matchedPlatform = 'tiktok';
                    break;
                }
                if (ch.platform === 'youtube' && (lowerUrl.includes('youtube.com/watch') || lowerUrl.includes('youtube.com/shorts/') || lowerUrl.includes('youtu.be/'))) {
                    matchedPlatform = 'youtube';
                    break;
                }
                if (ch.platform === 'facebook' && lowerUrl.includes('facebook.com/')) {
                    matchedPlatform = 'facebook';
                    break;
                }
                if ((ch.platform === 'website' || ch.platform === 'rss') && ch.url) {
                    try {
                        const chHost = new URL(ch.url).hostname.replace(/^www\./, '').toLowerCase();
                        const urlHost = new URL(clean).hostname.replace(/^www\./, '').toLowerCase();
                        if (urlHost === chHost || urlHost.endsWith(`.${chHost}`)) {
                            matchedPlatform = ch.platform;
                            break;
                        }
                    } catch {
                        // ignore malformed URL
                    }
                }
            }

            if (matchedPlatform) {
                setClipboardUrl(clean);
                setClipboardPlatform(matchedPlatform);
            }
        } catch {
            // Non-fatal, never crash app on clipboard access error
        }
    }, [channels]);

    /**
     * Fetch post count nudges from server
     */
    const loadPostCountNudges = useCallback(async () => {
        if (!identity) return;
        try {
            const url = await anchorUrl();
            if (!url) return;
            const res = await signedPost(url, '/api/member/pulse/nudges', {}, identity);
            if (!res.ok) return;
            const data = await res.json().catch(() => ({}));
            if (Array.isArray(data.nudges)) {
                setPostCountNudges(data.nudges);
            }
        } catch {
            // ignore network errors
        }
    }, [identity]);

    // Initial check on mount and channel update
    useEffect(() => {
        // Run after initial paint to prevent interrupting app boot
        const timer = setTimeout(() => {
            checkClipboard();
            loadPostCountNudges();
        }, 1200);

        return () => clearTimeout(timer);
    }, [checkClipboard, loadPostCountNudges]);

    // Re-check clipboard on app foreground
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
            if (nextState === 'active') {
                checkClipboard();
            }
        });
        return () => subscription.remove();
    }, [checkClipboard]);

    // Dismiss clipboard banner and record in AsyncStorage
    const dismissClipboard = async () => {
        if (!clipboardUrl) return;
        const url = clipboardUrl;
        setClipboardUrl(null);
        setClipboardPlatform(null);
        try {
            await AsyncStorage.setItem(`pulse_seen_clip_${url}`, '1');
        } catch {
            // ignore storage error
        }
    };

    // Action: navigate to pulse-intake with prefilled clipboard URL
    const addClipboardToPulse = async () => {
        if (!clipboardUrl) return;
        const url = clipboardUrl;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        await dismissClipboard();
        router.push({
            pathname: '/pulse-intake',
            params: { url },
        });
    };

    // Action: navigate to pulse-intake with channelId
    const shareChannelPosts = (nudge: PostCountNudge) => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        router.push({
            pathname: '/pulse-intake',
            params: { channelId: nudge.channelId },
        });
    };

    // Dismiss post-count watermark
    const dismissPostCountNudge = async (nudge: PostCountNudge) => {
        if (!identity) return;
        setDismissingChannelId(nudge.channelId);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

        // Optimistically remove from UI
        setPostCountNudges(prev => prev.filter(n => n.channelId !== nudge.channelId));

        try {
            const url = await anchorUrl();
            if (url) {
                await signedPost(
                    url,
                    `/api/member/pulse/channels/${nudge.channelId}/dismiss-nudge`,
                    { seenCount: nudge.currentCount },
                    identity
                );
            }
            if (onNudgeDismissed) onNudgeDismissed();
        } catch {
            // ignore failure
        } finally {
            setDismissingChannelId(null);
        }
    };

    if (!clipboardUrl && postCountNudges.length === 0) {
        return null;
    }

    return (
        <View style={styles.container}>
            {/* Clipboard Nudge Banner */}
            {clipboardUrl && clipboardPlatform ? (
                <View style={styles.nudgeCard} accessibilityRole="alert">
                    <View style={styles.headerRow}>
                        <View style={styles.badgeRow}>
                            <Text style={styles.platformIcon} allowFontScaling={false}>
                                {platformMeta(clipboardPlatform).icon}
                            </Text>
                            <Text style={styles.nudgeTitle} numberOfLines={1}>
                                Link from Clipboard
                            </Text>
                        </View>
                        <Pressable
                            onPress={dismissClipboard}
                            style={styles.closeButton}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            accessibilityRole="button"
                            accessibilityLabel="Dismiss clipboard suggestion"
                        >
                            <Text style={styles.closeIcon} allowFontScaling={false}>✕</Text>
                        </Pressable>
                    </View>

                    <Text style={styles.urlPreview} numberOfLines={1} ellipsizeMode="middle">
                        {clipboardUrl}
                    </Text>

                    <Text style={styles.nudgeBody}>
                        Found a link to your {platformMeta(clipboardPlatform).label} channel. Would you like to share it to The Pulse?
                    </Text>

                    <View style={styles.actionRow}>
                        <Pressable
                            onPress={dismissClipboard}
                            style={styles.secondaryButton}
                            accessibilityRole="button"
                            accessibilityLabel="Dismiss"
                        >
                            <Text style={styles.secondaryButtonText}>Dismiss</Text>
                        </Pressable>

                        <Pressable
                            onPress={addClipboardToPulse}
                            style={styles.primaryButton}
                            accessibilityRole="button"
                            accessibilityLabel="Add to Pulse"
                        >
                            <Text style={styles.primaryButtonText}>Add to Pulse</Text>
                        </Pressable>
                    </View>
                </View>
            ) : null}

            {/* Post-Count Nudges */}
            {postCountNudges.map((nudge) => {
                const meta = platformMeta(nudge.platform);
                const count = nudge.newPostsCount;
                const countText = count === 1 ? '1 new thing' : `${count} new things`;

                return (
                    <View key={nudge.channelId} style={styles.nudgeCard} accessibilityRole="alert">
                        <View style={styles.headerRow}>
                            <View style={styles.badgeRow}>
                                <Text style={styles.platformIcon} allowFontScaling={false}>
                                    {meta.icon}
                                </Text>
                                <Text style={styles.nudgeTitle} numberOfLines={1}>
                                    {meta.label} Updates
                                </Text>
                            </View>
                            <Pressable
                                onPress={() => dismissPostCountNudge(nudge)}
                                style={styles.closeButton}
                                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                                accessibilityRole="button"
                                accessibilityLabel="Dismiss update notice"
                            >
                                <Text style={styles.closeIcon} allowFontScaling={false}>✕</Text>
                            </Pressable>
                        </View>

                        <Text style={styles.nudgeBody}>
                            You've posted {countText} on {meta.label} since your last visit.
                        </Text>

                        <View style={styles.actionRow}>
                            <Pressable
                                onPress={() => dismissPostCountNudge(nudge)}
                                style={styles.secondaryButton}
                                accessibilityRole="button"
                                accessibilityLabel="Dismiss update notice"
                            >
                                <Text style={styles.secondaryButtonText}>Dismiss</Text>
                            </Pressable>

                            <Pressable
                                onPress={() => shareChannelPosts(nudge)}
                                style={styles.primaryButton}
                                accessibilityRole="button"
                                accessibilityLabel="Share to Pulse"
                            >
                                <Text style={styles.primaryButtonText}>Share</Text>
                            </Pressable>
                        </View>
                    </View>
                );
            })}
        </View>
    );
}

const makeStyles = ({ colors, theme }: { colors: any; theme: string }) =>
    StyleSheet.create({
        container: {
            width: '100%',
            marginBottom: 12,
            gap: 10,
        },
        nudgeCard: {
            backgroundColor: theme === 'dark' ? '#1c1d1a' : '#f4fbf7',
            borderRadius: 16,
            borderWidth: 1,
            borderColor: theme === 'dark' ? 'rgba(74, 222, 128, 0.25)' : '#bbf7d0',
            padding: 14,
            width: '100%',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.06,
            shadowRadius: 4,
            elevation: 2,
        },
        headerRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6,
        },
        badgeRow: {
            flexDirection: 'row',
            alignItems: 'center',
            flexShrink: 1,
        },
        platformIcon: {
            fontSize: 16,
            marginRight: 6,
        },
        nudgeTitle: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.primary,
            flexShrink: 1,
        },
        closeButton: {
            padding: 4,
            borderRadius: 12,
            marginLeft: 8,
        },
        closeIcon: {
            fontSize: 14,
            color: colors.text.muted,
            fontWeight: 'bold',
        },
        urlPreview: {
            fontSize: 12,
            color: colors.text.muted,
            backgroundColor: colors.surface.subtle,
            paddingVertical: 4,
            paddingHorizontal: 8,
            borderRadius: 6,
            marginVertical: 4,
        },
        nudgeBody: {
            fontSize: 13,
            color: colors.text.body,
            lineHeight: 18,
            marginTop: 4,
            marginBottom: 12,
        },
        actionRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
            gap: 8,
        },
        secondaryButton: {
            paddingVertical: 8,
            paddingHorizontal: 14,
            borderRadius: 10,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
            minHeight: 38,
            justifyContent: 'center',
            alignItems: 'center',
        },
        secondaryButtonText: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.text.body,
        },
        primaryButton: {
            paddingVertical: 8,
            paddingHorizontal: 16,
            borderRadius: 10,
            backgroundColor: colors.brand.primary,
            minHeight: 38,
            justifyContent: 'center',
            alignItems: 'center',
        },
        primaryButtonText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.inverse,
        },
    });
