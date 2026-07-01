/**
 * MemberAvatar — Universal avatar component for BeanPool.
 * 
 * Design Rule: Every callsign gets an avatar. If there's a name displayed,
 * there's an avatar beside it.
 * 
 * Handles:
 * - Remote image URLs (with cache-busting)
 * - Base64 data URIs
 * - Bundled avatar references
 * - Letter-initial fallback when no image is available
 */
import React from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';
import { avatarUri } from '../utils/image-processing';
import { resolveBundledAvatar } from '../utils/bundled-avatars';
import { colors, palette } from '../constants/colors';

// Consistent color palette for letter-initial fallbacks
const FALLBACK_COLORS = [
    palette.violet500, palette.cyan500, palette.emerald500, palette.amber500,
    palette.red500, palette.pink500, palette.indigo500, palette.teal500,
] as const;

function getColorForPubkey(pubkey: string | null | undefined): string {
    if (!pubkey) return FALLBACK_COLORS[0];
    let hash = 0;
    for (let i = 0; i < Math.min(pubkey.length, 8); i++) {
        hash = pubkey.charCodeAt(i) + ((hash << 5) - hash);
    }
    return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

interface MemberAvatarProps {
    avatarUrl: string | null | undefined;
    pubkey: string;
    callsign: string;
    /** Avatar diameter in pixels. Default: 36 */
    size?: number;
    /** ISO timestamp of last profile update — used for cache-busting */
    updatedAt?: string | null;
    /** Border radius override. Default: size/2 (circle). Use lower value for rounded square. */
    borderRadius?: number;
}

export function MemberAvatar({
    avatarUrl,
    pubkey,
    callsign,
    size = 36,
    updatedAt,
    borderRadius,
}: MemberAvatarProps) {
    const radius = borderRadius ?? size / 2;
    // Defensively clean raw string inputs to prevent invalid rendering on iOS
    const cleanedAvatarUrl = (avatarUrl && avatarUrl !== 'null' && avatarUrl !== 'undefined' && avatarUrl.trim() !== '') ? avatarUrl : null;
    let uri = avatarUri(cleanedAvatarUrl, pubkey, updatedAt);
    const fontSize = Math.max(Math.round(size * 0.42), 10);

    // Resolve bundled:// references to require() image sources
    if (uri && uri.startsWith('bundled://')) {
        const bundledSource = resolveBundledAvatar(uri);
        if (bundledSource) {
            return (
                <Image
                    source={bundledSource}
                    accessible={true}
                    accessibilityRole="image"
                    accessibilityLabel={`${callsign}'s avatar`}
                    style={[
                        styles.image,
                        { width: size, height: size, borderRadius: radius, overflow: 'hidden', flexShrink: 0 },
                    ]}
                />
            );
        }
        // If it's a bundled URL but resolution fails, do NOT fall through to network URI (which crashes iOS).
        // Break out to render the initial fallback.
        uri = null;
    }

    if (uri) {
        return (
            <Image
                source={{ uri }}
                accessible={true}
                accessibilityRole="image"
                accessibilityLabel={`${callsign}'s avatar`}
                style={[
                    styles.image,
                    { width: size, height: size, borderRadius: radius, overflow: 'hidden', flexShrink: 0 },
                ]}
            />
        );
    }

    // Letter-initial fallback with deterministic color
    const bgColor = getColorForPubkey(pubkey);
    const initial = (callsign || '?').charAt(0).toUpperCase();

    return (
        <View
            style={[
                styles.fallback,
                {
                    width: size,
                    height: size,
                    borderRadius: radius,
                    backgroundColor: bgColor + '20', // 12% opacity bg
                },
            ]}
        >
            <Text
                allowFontScaling={false}
                numberOfLines={1}
                style={[
                    styles.fallbackText,
                    { fontSize, color: bgColor },
                ]}
            >
                {initial}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    image: {
        backgroundColor: colors.surface.subtle,
        overflow: 'hidden',
    },
    fallback: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    fallbackText: {
        fontWeight: '800',
    },
});
