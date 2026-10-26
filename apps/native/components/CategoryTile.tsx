/**
 * CategoryTile — The designed category tile that replaces faded emojis everywhere.
 *
 * Drawn from the shared brand-colours tile tokens:
 *   - Ground: the category's tint (colors.tile.<cat>.tint)
 *   - Sticker disc: circle in surface colour (colors.surface.card) with 1px outline in category ink at 25% alpha
 *   - Emoji: full-strength inside the disc
 *   - Word: category name in ink colour, uppercase, 10px / weight 800, tracking 1, 6px below disc
 *
 * Props follow DESIGN-pictures-fable.md §3.2.
 */

import React from 'react';
import { View, Text, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { normalizeCategory, rgbaOf, t, upperCase } from '@beanpool/core';
import { categoryEmoji, categoryLabel } from '../constants/categories';
import type { AppColors } from '../constants/colors';
import { useTheme } from '../app/ThemeContext';

export type CategoryTileKind = 'listing' | 'event' | 'pulse' | 'group';
export type CategoryTileSize = 'grid' | 'thumb' | 'banner';

export interface CategoryTileProps {
    category?: string | null;
    kind?: CategoryTileKind;
    size?: CategoryTileSize;
    label?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

const KNOWN_TILES = new Set([
    'food', 'services', 'labour', 'tools', 'goods', 'garden', 'housing', 'transport',
    'education', 'arts', 'health', 'care', 'animals', 'tech', 'energy', 'mindset',
    'general', 'event', 'pulse',
]);

type TileKey = keyof AppColors['tile'];

const GROUP_CATEGORY_MAP: Record<string, { tile: TileKey; emoji: string; label: string }> = {
    social: { tile: 'arts', emoji: '🌻', label: 'SOCIAL' },
    general: { tile: 'general', emoji: '💬', label: 'GENERAL' },
    working_group: { tile: 'services', emoji: '🤝', label: 'WORKING GROUP' },
    guild: { tile: 'education', emoji: '🛡️', label: 'GUILD' },
};

export const CategoryTile: React.FC<CategoryTileProps> = ({
    category,
    kind = 'listing',
    size = 'grid',
    label,
    style,
    testID = 'category-tile',
}) => {
    let tileKey: TileKey = 'general';
    let emoji = '📦';
    let word = 'GENERAL';

    if (kind === 'event' || category === 'event') {
        tileKey = 'event';
        emoji = '📅';
        word = upperCase(t('EVENT', undefined, 'event category tile label'));
    } else if (kind === 'pulse' || category === 'pulse') {
        tileKey = 'pulse';
        emoji = '🗞️';
        word = upperCase(t('PULSE', undefined, 'pulse category tile label'));
    } else if (kind === 'group') {
        const groupMeta = category ? GROUP_CATEGORY_MAP[category] : undefined;
        if (groupMeta) {
            tileKey = groupMeta.tile;
            emoji = groupMeta.emoji;
            word = groupMeta.label;
        } else {
            tileKey = 'general';
            emoji = '👥';
            word = upperCase(category ? String(category).trim() : 'GENERAL');
        }
    } else {
        // Listing
        const normalized = normalizeCategory(category);
        tileKey = (KNOWN_TILES.has(normalized) ? normalized : 'general') as TileKey;
        const isKnown = !!category && (normalized !== 'general' || category.trim().toLowerCase() === 'general');
        emoji = isKnown ? categoryEmoji(category) : '📦';
        word = isKnown ? upperCase(categoryLabel(category)) : upperCase(categoryLabel('general'));
    }

    const { colors: activeColors } = useTheme();

    const tileColors = activeColors.tile[tileKey] || activeColors.tile.general;
    const showWord = label !== undefined ? label : (size === 'grid' || size === 'banner');

    let discSize = 44;
    let emojiSize = 24;

    if (size === 'thumb') {
        discSize = 28;
        emojiSize = 16;
    } else if (size === 'banner') {
        discSize = 56;
        emojiSize = 30;
    }

    const discOutline = rgbaOf(tileColors.ink, 0.25);

    return (
        <View
            testID={testID}
            style={[
                styles.container,
                { backgroundColor: tileColors.tint },
                size === 'banner' ? styles.bannerAlign : styles.centerAlign,
                style,
            ]}
        >
            <View
                style={[
                    styles.disc,
                    {
                        width: discSize,
                        height: discSize,
                        borderRadius: discSize / 2,
                        backgroundColor: activeColors.surface.card,
                        borderColor: discOutline,
                    },
                ]}
            >
                <Text style={{ fontSize: emojiSize, textAlign: 'center', includeFontPadding: false }}>
                    {emoji}
                </Text>
            </View>

            {showWord && (
                <Text
                    numberOfLines={1}
                    style={[
                        styles.word,
                        {
                            color: tileColors.ink,
                        },
                    ]}
                >
                    {word}
                </Text>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        width: '100%',
        height: '100%',
        overflow: 'hidden',
    },
    centerAlign: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    bannerAlign: {
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingLeft: '25%',
    },
    disc: {
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
    },
    word: {
        fontSize: 10,
        fontWeight: '800',
        letterSpacing: 1,
        marginTop: 6,
        textTransform: 'uppercase',
    },
});

export default CategoryTile;
