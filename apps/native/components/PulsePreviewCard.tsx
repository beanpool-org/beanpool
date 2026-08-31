/**
 * Facade Card for previewing Pulse posts before manual submission (The Pulse, Package 05).
 *
 * Displays:
 * - Thumbnail image (with clean fallback when unavailable or loading fails).
 * - Post title (multi-line reflow, capped max lines, resilient to 1.3x font scaling).
 * - Platform badge (e.g. 📷 Instagram, 🎵 TikTok, 🎥 YouTube, ✍️ Blog/RSS) via @beanpool/core.
 * - Category badge (e.g. 📣 Community, 🔨 Making & craft) via @beanpool/core.
 * - Author callsign / verification badge.
 * - Deduplication banner notice if the post is already in the feed.
 * - Optional review toggle ("Include in Pulse") for deliberate per-item review.
 *
 * Rules:
 * - Renders at 320dp width and 1.3x font scale without clipping or horizontal overflow.
 * - Uses flexGrow/flexBasis, never fixed percentages.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Switch, Platform } from 'react-native';
import { Image } from 'expo-image';
import {
    platformMeta,
    categoryMeta,
    isWebUrl,
    type ChannelPlatform,
    type ChannelCategory,
} from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';

export interface PulsePreviewData {
    url: string;
    title: string | null;
    thumbnailUrl: string | null;
    platform: ChannelPlatform;
    category: ChannelCategory;
    isDuplicate?: boolean;
    duplicateItemId?: string | null;
    authorCallsign?: string;
    isVerified?: boolean;
    publishedAt?: string | null;
}

interface Props {
    preview: PulsePreviewData;
    callsign?: string;
    isOptedIn?: boolean;
    onToggleOptIn?: (optedIn: boolean) => void;
    showReviewToggle?: boolean;
}

export function PulsePreviewCard({
    preview,
    callsign,
    isOptedIn = true,
    onToggleOptIn,
    showReviewToggle = false,
}: Props) {
    const { colors, theme } = useTheme();
    const styles = useStyles(makeStyles);
    const [imageError, setImageError] = useState(false);

    React.useEffect(() => {
        setImageError(false);
    }, [preview.thumbnailUrl]);

    const platform = platformMeta(preview.platform);
    const category = categoryMeta(preview.category);
    const displayCallsign = preview.authorCallsign || callsign || 'You';
    const hasValidThumbnail = Boolean(preview.thumbnailUrl && isWebUrl(preview.thumbnailUrl) && !imageError);

    return (
        <View
            style={[
                styles.cardContainer,
                preview.isDuplicate && styles.cardDuplicate,
                !isOptedIn && styles.cardOptedOut,
            ]}
            accessibilityRole="summary"
            accessibilityLabel={`Preview of ${platform.label} post: ${preview.title || 'Untitled'}`}
        >
            {/* Header: Author Callout & Badges */}
            <View style={styles.headerRow}>
                <View style={styles.authorBadge}>
                    <Text style={styles.authorIcon} allowFontScaling={false}>
                        {platform.icon}
                    </Text>
                    <Text style={styles.authorText} numberOfLines={1}>
                        {displayCallsign}
                    </Text>
                    {preview.isVerified ? (
                        <View style={styles.verifiedBadge} accessibilityLabel="Verified creator">
                            <Text style={styles.verifiedIcon} allowFontScaling={false}>✓</Text>
                        </View>
                    ) : null}
                </View>

                <View style={styles.categoryBadge}>
                    <Text style={styles.categoryIcon} allowFontScaling={false}>
                        {category.icon}
                    </Text>
                    <Text style={styles.categoryText} numberOfLines={1}>
                        {category.label}
                    </Text>
                </View>
            </View>

            {/* Media & Content */}
            <View style={styles.bodyRow}>
                {hasValidThumbnail ? (
                    <Image
                        source={{ uri: preview.thumbnailUrl! }}
                        style={styles.thumbnail}
                        contentFit="cover"
                        transition={200}
                        onError={() => setImageError(true)}
                        accessibilityLabel="Post thumbnail"
                    />
                ) : (
                    <View style={styles.thumbnailPlaceholder} accessibilityLabel="No image preview">
                        <Text style={styles.placeholderIcon} allowFontScaling={false}>
                            {platform.icon}
                        </Text>
                    </View>
                )}

                <View style={styles.contentCol}>
                    <Text
                        style={[styles.title, !isOptedIn && styles.textOptedOut]}
                        numberOfLines={3}
                        ellipsizeMode="tail"
                    >
                        {preview.title || 'Untitled Post'}
                    </Text>

                    <Text style={styles.urlText} numberOfLines={1} ellipsizeMode="middle">
                        {preview.url}
                    </Text>
                </View>
            </View>

            {/* Duplicate Notice Banner */}
            {preview.isDuplicate ? (
                <View style={styles.duplicateBanner} accessibilityRole="alert">
                    <Text style={styles.duplicateIcon} allowFontScaling={false}>ℹ️</Text>
                    <Text style={styles.duplicateText}>
                        Already published to Pulse. Submitting will update the title or category.
                    </Text>
                </View>
            ) : null}

            {/* Review Opt-out Toggle */}
            {showReviewToggle && onToggleOptIn ? (
                <Pressable
                    style={styles.reviewRow}
                    onPress={() => onToggleOptIn(!isOptedIn)}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: isOptedIn }}
                    accessibilityLabel="Publish to Pulse"
                >
                    <View style={styles.reviewLabelGroup}>
                        <Text style={styles.reviewTitle}>Publish to Pulse</Text>
                        <Text style={styles.reviewSub}>
                            {isOptedIn ? 'Will be shared with your local community' : 'Excluded from this publish'}
                        </Text>
                    </View>
                    <Switch
                        value={isOptedIn}
                        onValueChange={onToggleOptIn}
                        trackColor={{ false: colors.border.default, true: colors.brand.primary }}
                        thumbColor={Platform.OS === 'android' ? (isOptedIn ? colors.brand.primary : colors.surface.card) : undefined}
                        accessibilityLabel="Include this post in Pulse"
                    />
                </Pressable>
            ) : null}
        </View>
    );
}

const makeStyles = ({ colors, theme }: { colors: any; theme: string }) =>
    StyleSheet.create({
        cardContainer: {
            backgroundColor: colors.surface.card,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: colors.border.default,
            padding: 14,
            width: '100%',
            marginBottom: 12,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: theme === 'dark' ? 0.25 : 0.06,
            shadowRadius: 6,
            elevation: 2,
        },
        cardDuplicate: {
            borderColor: theme === 'dark' ? '#d97706' : '#f59e0b',
        },
        cardOptedOut: {
            opacity: 0.6,
            backgroundColor: colors.surface.subtle,
        },
        headerRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 12,
        },
        authorBadge: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.surface.subtle,
            paddingVertical: 4,
            paddingHorizontal: 10,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.border.default,
            flexShrink: 1,
        },
        authorIcon: {
            fontSize: 13,
            marginRight: 6,
        },
        authorText: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.text.body,
            flexShrink: 1,
        },
        verifiedBadge: {
            marginLeft: 5,
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: colors.brand.primary,
            alignItems: 'center',
            justifyContent: 'center',
        },
        verifiedIcon: {
            color: colors.text.inverse,
            fontSize: 9,
            fontWeight: '900',
            lineHeight: 11,
        },
        categoryBadge: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            paddingVertical: 4,
            paddingHorizontal: 8,
            borderRadius: 12,
        },
        categoryIcon: {
            fontSize: 12,
            marginRight: 4,
        },
        categoryText: {
            fontSize: 12,
            color: colors.text.muted,
            fontWeight: '500',
        },
        bodyRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 12,
        },
        thumbnail: {
            width: 80,
            height: 80,
            borderRadius: 12,
            backgroundColor: colors.surface.subtle,
            flexShrink: 0,
        },
        thumbnailPlaceholder: {
            width: 80,
            height: 80,
            borderRadius: 12,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
        },
        placeholderIcon: {
            fontSize: 28,
            opacity: 0.8,
        },
        contentCol: {
            flex: 1,
            flexGrow: 1,
            flexBasis: 0,
            justifyContent: 'center',
            minHeight: 80,
        },
        title: {
            fontSize: 15,
            fontWeight: '600',
            color: colors.text.primary,
            lineHeight: 20,
            marginBottom: 6,
        },
        textOptedOut: {
            textDecorationLine: 'line-through',
            color: colors.text.muted,
        },
        urlText: {
            fontSize: 12,
            color: colors.text.muted,
        },
        duplicateBanner: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: theme === 'dark' ? 'rgba(245, 158, 11, 0.15)' : '#fef3c7',
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 10,
            marginTop: 12,
            gap: 8,
            borderWidth: 1,
            borderColor: theme === 'dark' ? 'rgba(245, 158, 11, 0.3)' : '#fde68a',
        },
        duplicateIcon: {
            fontSize: 14,
        },
        duplicateText: {
            fontSize: 12,
            color: theme === 'dark' ? '#fbbf24' : '#92400e',
            flex: 1,
            lineHeight: 16,
            fontWeight: '500',
        },
        reviewRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 14,
            paddingTop: 12,
            borderTopWidth: 1,
            borderTopColor: colors.border.default,
        },
        reviewLabelGroup: {
            flex: 1,
            marginRight: 12,
        },
        reviewTitle: {
            fontSize: 14,
            fontWeight: '600',
            color: colors.text.primary,
        },
        reviewSub: {
            fontSize: 12,
            color: colors.text.muted,
            marginTop: 2,
        },
    });
