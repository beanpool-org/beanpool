/**
 * CategoryTile — The designed category tile that replaces faded emojis everywhere.
 *
 * Drawn from the shared brand-colours tile tokens:
 *   - Ground: the category's tint (--bp-tile-<cat>-tint)
 *   - Sticker disc: circle in surface colour with 1px outline in category ink at 25% alpha
 *   - Emoji: full-strength inside the disc
 *   - Word: category name in ink colour, uppercase, 10px / weight 800, tracking 1, 6px below disc
 *
 * Props follow DESIGN-pictures-fable.md §3.2.
 */

import React from 'react';
import { normalizeCategory, t, upperCase } from '@beanpool/core';
import { MARKETPLACE_CATEGORIES_BY_ID } from '../lib/marketplace';

export type CategoryTileKind = 'listing' | 'event' | 'pulse' | 'group';
export type CategoryTileSize = 'grid' | 'thumb' | 'banner';

export interface CategoryTileProps {
    category?: string | null;
    kind?: CategoryTileKind;
    size?: CategoryTileSize;
    label?: boolean;
    className?: string;
    style?: React.CSSProperties;
    testID?: string;
    'data-testid'?: string;
}

const KNOWN_TILES = new Set([
    'food', 'services', 'labour', 'tools', 'goods', 'garden', 'housing', 'transport',
    'education', 'arts', 'health', 'care', 'animals', 'tech', 'energy', 'mindset',
    'general', 'event', 'pulse',
]);

const GROUP_CATEGORY_MAP: Record<string, { tile: string; emoji: string; label: string }> = {
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
    className = '',
    style,
    testID,
    'data-testid': dataTestId,
}) => {
    let tileKey = 'general';
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
        tileKey = KNOWN_TILES.has(normalized) ? normalized : 'general';
        const isKnown = !!category && (normalized !== 'general' || category.trim().toLowerCase() === 'general');
        const meta = isKnown ? MARKETPLACE_CATEGORIES_BY_ID.get(normalized) : undefined;
        if (meta) {
            emoji = meta.emoji;
            word = upperCase(t(meta.label));
        } else {
            // Unknown or null category falls back to 📦 on general tint
            emoji = '📦';
            word = upperCase(t(MARKETPLACE_CATEGORIES_BY_ID.get('general')!.label));
        }
    }

    const showWord = label !== undefined ? label : (size === 'grid' || size === 'banner');

    // Dimensions per spec:
    // grid: disc 44px, emoji 24px
    // thumb: disc 28px, emoji 16px
    // banner: disc 56px, emoji 30px, leading third placement
    let discSize = 44;
    let emojiSize = 24;

    if (size === 'thumb') {
        discSize = 28;
        emojiSize = 16;
    } else if (size === 'banner') {
        discSize = 56;
        emojiSize = 30;
    }

    const containerAlignment = size === 'banner'
        ? 'items-start justify-center pl-[25%]'
        : 'items-center justify-center';

    return (
        <div
            data-testid={testID || dataTestId || 'category-tile'}
            className={`relative w-full h-full flex flex-col ${containerAlignment} overflow-hidden ${className}`}
            style={{
                backgroundColor: `var(--bp-tile-${tileKey}-tint)`,
                ...style,
            }}
            aria-label={word}
        >
            <div
                className="relative rounded-full flex items-center justify-center bg-white dark:bg-[var(--bg-card)] shrink-0"
                style={{
                    width: `${discSize}px`,
                    height: `${discSize}px`,
                }}
            >
                {/* 1px outline in category ink at 25% alpha (a plain opacity layer: old WebViews can't mix colours) */}
                <div
                    className="absolute inset-0 rounded-full border pointer-events-none"
                    style={{
                        borderColor: `var(--bp-tile-${tileKey}-ink)`,
                        opacity: 0.25,
                    }}
                    aria-hidden="true"
                />
                <span
                    className="leading-none select-none"
                    style={{ fontSize: `${emojiSize}px`, lineHeight: 1 }}
                    aria-hidden="true"
                >
                    {emoji}
                </span>
            </div>

            {showWord && (
                <span
                    className="font-extrabold uppercase select-none leading-tight truncate px-1 text-center"
                    style={{
                        color: `var(--bp-tile-${tileKey}-ink)`,
                        fontSize: '10px',
                        fontWeight: 800,
                        letterSpacing: '1px',
                        marginTop: '6px',
                        maxWidth: '100%',
                    }}
                >
                    {word}
                </span>
            )}
        </div>
    );
};

export default CategoryTile;
