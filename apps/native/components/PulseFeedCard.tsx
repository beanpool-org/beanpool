/**
 * PulseFeedCard — Facade presentation card for Pulse community feed items (Phase 3).
 *
 * Rules:
 * - Facade cards, NOT embeds. Renders a static thumbnail, title, platform, category, and author.
 * - External linking: Tapping the card opens the post URL in the device browser/app via Linking.openURL,
 *   strictly validated via `isWebUrl` before invocation.
 * - Emphasizes community: "my neighbour made this" — shows author avatar, callsign, and verified status.
 * - Owner Mute: When the item is owned by the current viewer, provides a mute action with confirmation.
 * - Responsive at 320dp and 1.3x font scale: cards reflow and titles wrap cleanly with no horizontal overflow.
 */

import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Pressable,
    Linking,
    Alert,
    Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import {
    isWebUrl,
    platformMeta,
    categoryMeta,
    VIDEO_PLATFORMS,
} from '@beanpool/core';
import { type PulseFeedItem, formatRelativeTime } from '../utils/pulse';
import { MemberAvatar } from './MemberAvatar';
import { useTheme, useStyles } from '../app/ThemeContext';

interface PulseFeedCardProps {
    item: PulseFeedItem;
    currentPubkey?: string | null;
    onMute?: (itemId: string) => void | Promise<void>;
}

export function PulseFeedCard({ item, currentPubkey, onMute }: PulseFeedCardProps) {
    const { colors, theme } = useTheme();
    const styles = useStyles(makeStyles);
    const [imageFailed, setImageFailed] = useState(false);

    const isOwner = Boolean(currentPubkey && item.ownerPubkey === currentPubkey);
    const platMeta = platformMeta(item.platform);
    const catMeta = categoryMeta(item.category);
    const isVideo = VIDEO_PLATFORMS.includes(item.platform as any);
    const timeAgo = formatRelativeTime(item.publishedAt);

    const handleOpenPost = async () => {
        if (!item.url) return;
        const targetUrl = item.url.trim();
        if (!isWebUrl(targetUrl)) {
            console.warn('[PulseFeedCard] Refusing non-web URL scheme:', targetUrl);
            return;
        }

        try {
            const canOpen = await Linking.canOpenURL(targetUrl).catch(() => false);
            if (canOpen) {
                await Linking.openURL(targetUrl);
            } else {
                Alert.alert('Cannot Open Link', 'The link could not be opened on this device.');
            }
        } catch (e) {
            console.warn('[PulseFeedCard] Error opening URL:', e);
        }
    };

    const handleAuthorPress = () => {
        if (!item.ownerPubkey) return;
        router.push({
            pathname: '/public-profile',
            params: { publicKey: item.ownerPubkey },
        });
    };

    const handleMutePress = () => {
        if (!onMute) return;
        Alert.alert(
            'Hide this post from feed?',
            `"${item.title || 'This item'}" will no longer be visible to your neighbours on the community feed.`,
            [
                { text: 'Keep post', style: 'cancel' },
                {
                    text: 'Hide from feed',
                    style: 'destructive',
                    onPress: () => onMute(item.id),
                },
            ],
        );
    };

    const cardAccessibilityLabel = `${item.title || 'Community post'} by ${item.callsign} on ${platMeta.label}${item.isVerified ? ', verified creator' : ''}`;

    return (
        <View style={styles.cardContainer}>
            {/* Header: Neighbour details + Category */}
            <View style={styles.headerRow}>
                <Pressable
                    onPress={handleAuthorPress}
                    style={styles.authorButton}
                    accessibilityRole="button"
                    accessibilityLabel={`View ${item.callsign}'s public profile`}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                    <MemberAvatar
                        avatarUrl={item.avatarUrl}
                        pubkey={item.ownerPubkey}
                        callsign={item.callsign}
                        size={38}
                    />
                    <View style={styles.authorInfo}>
                        <View style={styles.callsignRow}>
                            <Text style={styles.callsign} numberOfLines={1}>
                                {item.callsign}
                            </Text>
                            {item.isVerified ? (
                                <View style={styles.verifiedBadge} accessibilityLabel="Verified account">
                                    <Text style={styles.verifiedText} allowFontScaling={false}>✓</Text>
                                </View>
                            ) : null}
                        </View>
                        <View style={styles.metaRow}>
                            <Text style={styles.platformBadge}>
                                {platMeta.icon} {platMeta.label}
                            </Text>
                            {timeAgo ? (
                                <Text style={styles.timeText}> · {timeAgo}</Text>
                            ) : null}
                        </View>
                    </View>
                </Pressable>

                <View style={styles.headerActions}>
                    <View style={styles.categoryPill} accessibilityLabel={`Category: ${catMeta.label}`}>
                        <Text style={styles.categoryText} numberOfLines={1}>
                            {catMeta.icon} {catMeta.label}
                        </Text>
                    </View>

                    {isOwner && onMute && (
                        <Pressable
                            onPress={handleMutePress}
                            style={styles.muteBtn}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            accessibilityRole="button"
                            accessibilityLabel="Hide this item from feed"
                        >
                            <Text style={styles.muteBtnText}>Mute</Text>
                        </Pressable>
                    )}
                </View>
            </View>

            {/* Facade Poster / Thumbnail with Open Link Handler */}
            <Pressable
                onPress={handleOpenPost}
                style={({ pressed }) => [
                    styles.contentPressable,
                    pressed && styles.contentPressed,
                ]}
                accessibilityRole="link"
                accessibilityLabel={cardAccessibilityLabel}
                accessibilityHint="Opens external post in browser or app"
            >
                {item.thumbnailUrl && !imageFailed ? (
                    <View style={styles.thumbnailWrap}>
                        <Image
                            source={{ uri: item.thumbnailUrl }}
                            style={styles.thumbnail}
                            contentFit="cover"
                            transition={200}
                            onError={() => setImageFailed(true)}
                            accessibilityLabel={`${item.title || 'Thumbnail image'}`}
                        />
                        {isVideo && (
                            <View style={styles.playOverlay} aria-hidden={true}>
                                <View style={styles.playCircle}>
                                    <Text style={styles.playIcon} allowFontScaling={false}>▶</Text>
                                </View>
                            </View>
                        )}
                        <View style={styles.externalBadge}>
                            <Text style={styles.externalBadgeText}>{platMeta.label} ↗</Text>
                        </View>
                    </View>
                ) : (
                    <View style={[styles.thumbnailWrap, styles.placeholderThumbnail]}>
                        <Text style={styles.placeholderIcon}>{platMeta.icon}</Text>
                        <View style={styles.externalBadge}>
                            <Text style={styles.externalBadgeText}>{platMeta.label} ↗</Text>
                        </View>
                    </View>
                )}

                {/* Title and permalink action */}
                <View style={styles.bodyWrap}>
                    <Text style={styles.title} numberOfLines={3}>
                        {item.title || 'View post on ' + platMeta.label}
                    </Text>
                    <View style={styles.footerLinkRow}>
                        <Text style={styles.footerLinkText}>
                            Open on {platMeta.label} <Text style={styles.arrowIcon}>↗</Text>
                        </Text>
                    </View>
                </View>
            </Pressable>
        </View>
    );
}

const makeStyles = ({ colors, theme }: { colors: any; theme: string }) =>
    StyleSheet.create({
        cardContainer: {
            backgroundColor: colors.surface.card,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.border.default,
            marginBottom: 16,
            overflow: 'hidden',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: theme === 'dark' ? 0.3 : 0.06,
            shadowRadius: 6,
            elevation: 2,
        },
        headerRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 10,
        },
        authorButton: {
            flexDirection: 'row',
            alignItems: 'center',
            flex: 1,
            marginRight: 8,
        },
        authorInfo: {
            marginLeft: 10,
            flex: 1,
            justifyContent: 'center',
        },
        callsignRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
        },
        callsign: {
            fontSize: 15,
            fontWeight: '700',
            color: colors.text.heading,
            flexShrink: 1,
        },
        verifiedBadge: {
            width: 15,
            height: 15,
            borderRadius: 7.5,
            backgroundColor: colors.brand.primary,
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: 2,
        },
        verifiedText: {
            color: colors.text.inverse,
            fontSize: 9,
            fontWeight: '900',
            lineHeight: 11,
        },
        metaRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 2,
        },
        platformBadge: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        timeText: {
            fontSize: 12,
            color: colors.text.muted,
        },
        headerActions: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
        },
        categoryPill: {
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            paddingVertical: 4,
            paddingHorizontal: 8,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        categoryText: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        muteBtn: {
            paddingVertical: 6,
            paddingHorizontal: 10,
            borderRadius: 8,
            backgroundColor: theme === 'dark' ? 'rgba(239, 68, 68, 0.15)' : '#fee2e2',
        },
        muteBtnText: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.market.need.fg,
        },
        contentPressable: {
            width: '100%',
        },
        contentPressed: {
            opacity: 0.92,
        },
        thumbnailWrap: {
            width: '100%',
            aspectRatio: 16 / 9,
            backgroundColor: colors.surface.subtle,
            position: 'relative',
            justifyContent: 'center',
            alignItems: 'center',
            overflow: 'hidden',
        },
        thumbnail: {
            width: '100%',
            height: '100%',
        },
        placeholderThumbnail: {
            backgroundColor: theme === 'dark' ? '#1f2937' : '#f3f4f6',
        },
        placeholderIcon: {
            fontSize: 48,
            opacity: 0.6,
        },
        playOverlay: {
            ...StyleSheet.absoluteFillObject,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.2)',
        },
        playCircle: {
            width: 48,
            height: 48,
            borderRadius: 24,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            justifyContent: 'center',
            alignItems: 'center',
            borderWidth: 1.5,
            borderColor: 'rgba(255, 255, 255, 0.85)',
        },
        playIcon: {
            color: '#ffffff',
            fontSize: 18,
            marginLeft: 3, // visual optical center
        },
        externalBadge: {
            position: 'absolute',
            bottom: 8,
            right: 8,
            backgroundColor: 'rgba(0, 0, 0, 0.72)',
            paddingVertical: 3,
            paddingHorizontal: 7,
            borderRadius: 6,
        },
        externalBadgeText: {
            color: '#ffffff',
            fontSize: 11,
            fontWeight: '600',
        },
        bodyWrap: {
            padding: 14,
            paddingTop: 12,
        },
        title: {
            fontSize: 16,
            fontWeight: '600',
            lineHeight: 22,
            color: colors.text.heading,
            flexShrink: 1,
        },
        footerLinkRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 8,
        },
        footerLinkText: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.text.link,
        },
        arrowIcon: {
            fontSize: 13,
        },
    });
