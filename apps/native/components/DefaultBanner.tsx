/**
 * DefaultBanner — The drawn default banner for shops, enterprises, and groups (DESIGN-pictures-fable.md §2.2).
 *
 * Drawn at render time from the logo the screen already has, with no stored banner and no second fetch:
 *   - Ground: the category's tint (colors.tile.<category>.tint)
 *   - Monogram (bundled:// logo): 10 round copies (5 + 5 brick pattern) at opacity 0.16 light / 0.14 dark
 *   - Echo (photo logo): one round copy (1.9× height) bleeding off trailing edge at opacity 0.20 light / 0.24 dark
 *
 * Fully decorative: accessibilityElementsHidden, importantForAccessibility="no-hide-descendants".
 */

import React, { useState } from 'react';
import { View, StyleSheet, type ViewStyle, type StyleProp, I18nManager } from 'react-native';
import { Image } from 'expo-image';
import { normalizeCategory, isBundledAvatar, bundledAvatarForPubkey, type ShopCategory } from '@beanpool/core';
import { resolveBundledAvatar } from '../utils/bundled-avatars';
import { useNodeUri } from '../utils/node-uri';
import { useTheme } from '../app/ThemeContext';
import type { AppColors } from '../constants/colors';

export interface DefaultBannerProps {
    category?: ShopCategory | string | null;
    logoUrl?: string | null;
    pubkey?: string | null;
    ownerKey?: string | null;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

const KNOWN_TILES = new Set([
    'food', 'services', 'labour', 'tools', 'goods', 'garden', 'housing', 'transport',
    'education', 'arts', 'health', 'care', 'animals', 'tech', 'energy', 'mindset',
    'general', 'event', 'pulse',
]);

type TileKey = keyof AppColors['tile'];

const GROUP_CATEGORY_MAP: Record<string, TileKey> = {
    social: 'arts',
    general: 'general',
    working_group: 'services',
    guild: 'education',
};

export const DefaultBanner: React.FC<DefaultBannerProps> = ({
    category,
    logoUrl,
    pubkey,
    ownerKey,
    style,
    testID = 'default-banner',
}) => {
    const key = pubkey || ownerKey;
    const { colors: activeColors, theme } = useTheme();
    const isDark = theme === 'dark';

    let tileKey: TileKey = 'general';
    if (category && Object.prototype.hasOwnProperty.call(GROUP_CATEGORY_MAP, category)) {
        tileKey = GROUP_CATEGORY_MAP[category];
    } else if (category) {
        const normalized = normalizeCategory(category);
        tileKey = (KNOWN_TILES.has(normalized) ? normalized : 'general') as TileKey;
    }

    const tileColors = activeColors.tile[tileKey] || activeColors.tile.general;

    const isBundled = !logoUrl || (typeof logoUrl === 'string' && (isBundledAvatar(logoUrl) || logoUrl.startsWith('/avatars/')));

    // Resolve source
    const photoUri = useNodeUri(logoUrl);
    let imageSource: any;
    if (isBundled) {
        const bundledRef = logoUrl && typeof logoUrl === 'string'
            ? (isBundledAvatar(logoUrl)
                ? logoUrl
                : logoUrl.startsWith('/avatars/')
                    ? `bundled://${logoUrl.replace(/^\/avatars\/avatar_/, '').replace(/\.[^.]+$/, '').replace(/_/g, '-')}`
                    : (key ? bundledAvatarForPubkey(key) : 'bundled://bean-green'))
            : (key ? bundledAvatarForPubkey(key) : 'bundled://bean-green');
        imageSource = resolveBundledAvatar(bundledRef) || resolveBundledAvatar(key ? bundledAvatarForPubkey(key) : 'bundled://bean-green');
    } else {
        imageSource = photoUri ? { uri: photoUri } : null;
    }

    const [dimensions, setDimensions] = useState({ width: 320, height: 106.67 });

    const W = dimensions.width;
    const H = W / 3;
    const d = 0.62 * H;
    const colStep = 1.12 * d;
    const row1Top = 0.08 * H;
    const row2Top = 0.08 * H + 0.9 * d;
    const row1Start = -0.25 * d;
    const row2Start = -0.25 * d + 0.56 * d;

    const opacity = isBundled ? (isDark ? 0.14 : 0.16) : (isDark ? 0.24 : 0.20);

    const echoDiameter = 1.9 * H;
    const echoRadius = echoDiameter / 2;
    const isRTL = Boolean(I18nManager?.isRTL);
    const echoLeft = isRTL ? (0.55 * H - echoRadius) : (W - 0.55 * H - echoRadius);
    const echoTop = 0.5 * H - echoRadius;

    return (
        <View
            testID={testID}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
                styles.container,
                { backgroundColor: tileColors.tint },
                style,
            ]}
            onLayout={(e) => {
                const { width } = e.nativeEvent.layout;
                if (width > 0 && Math.abs(width - dimensions.width) > 1) {
                    setDimensions({ width, height: width / 3 });
                }
            }}
        >
            {isBundled ? (
                <>
                    {[0, 1, 2, 3, 4].map((col) => (
                        <Image
                            key={`m1-${col}`}
                            source={imageSource}
                            style={{
                                position: 'absolute',
                                left: row1Start + col * colStep,
                                top: row1Top,
                                width: d,
                                height: d,
                                borderRadius: d / 2,
                                opacity,
                            }}
                            contentFit="cover"
                            cachePolicy="memory-disk"
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            testID="default-banner-monogram-copy"
                        />
                    ))}
                    {[0, 1, 2, 3, 4].map((col) => (
                        <Image
                            key={`m2-${col}`}
                            source={imageSource}
                            style={{
                                position: 'absolute',
                                left: row2Start + col * colStep,
                                top: row2Top,
                                width: d,
                                height: d,
                                borderRadius: d / 2,
                                opacity,
                            }}
                            contentFit="cover"
                            cachePolicy="memory-disk"
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            testID="default-banner-monogram-copy"
                        />
                    ))}
                </>
            ) : (
                <Image
                    source={imageSource}
                    style={{
                        position: 'absolute',
                        left: echoLeft,
                        top: echoTop,
                        width: echoDiameter,
                        height: echoDiameter,
                        borderRadius: echoDiameter / 2,
                        opacity,
                    }}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    testID="default-banner-echo-copy"
                />
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
    },
});
