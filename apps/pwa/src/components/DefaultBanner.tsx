/**
 * DefaultBanner — The drawn default banner for shops, enterprises, and groups (DESIGN-pictures-fable.md §2.2).
 *
 * Drawn at render time from the logo the screen already has, with no stored banner and no second fetch:
 *   - Ground: the category's tint (--bp-tile-<category>-tint)
 *   - Monogram (bundled:// logo): 10 round copies (5 + 5 brick pattern) at opacity 0.16 light / 0.14 dark
 *   - Echo (photo logo): one round copy (1.9× height) bleeding off trailing edge at opacity 0.20 light / 0.24 dark
 *
 * Fully decorative: aria-hidden="true", pointer-events-none.
 */

import React from 'react';
import { normalizeCategory, isBundledAvatar, type ShopCategory } from '@beanpool/core';
import { resolveAvatarUrl } from '../lib/avatar';

export interface DefaultBannerProps {
    category?: ShopCategory | string | null;
    logoUrl?: string | null;
    pubkey?: string | null;
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

const GROUP_CATEGORY_MAP: Record<string, string> = {
    social: 'arts',
    general: 'general',
    working_group: 'services',
    guild: 'education',
};

const MONOGRAM_ROW_1_LEFTS = ['-5.1667%', '17.98%', '41.1267%', '64.2733%', '87.42%'];
const MONOGRAM_ROW_2_LEFTS = ['6.4067%', '29.5533%', '52.7%', '75.8467%', '98.9933%'];

export const DefaultBanner: React.FC<DefaultBannerProps> = ({
    category,
    logoUrl,
    pubkey,
    className = '',
    style,
    testID,
    'data-testid': dataTestId,
}) => {
    let tileKey = 'general';
    if (category && GROUP_CATEGORY_MAP[category]) {
        tileKey = GROUP_CATEGORY_MAP[category];
    } else if (category) {
        const normalized = normalizeCategory(category);
        tileKey = KNOWN_TILES.has(normalized) ? normalized : 'general';
    }

    const isBundled = !logoUrl || (typeof logoUrl === 'string' && (isBundledAvatar(logoUrl) || logoUrl.startsWith('/avatars/')));
    const resolvedLogo = resolveAvatarUrl(logoUrl, pubkey) || '/avatars/avatar_bean_green.jpg';

    const testIdProp = dataTestId || testID || 'default-banner';

    return (
        <div
            data-testid={testIdProp}
            aria-hidden="true"
            className={`w-full h-full relative overflow-hidden pointer-events-none select-none ${className}`}
            style={{ backgroundColor: `var(--bp-tile-${tileKey}-tint)`, ...style }}
        >
            {isBundled ? (
                <>
                    {MONOGRAM_ROW_1_LEFTS.map((left, idx) => (
                        <img
                            key={`m1-${idx}`}
                            src={resolvedLogo}
                            alt=""
                            aria-hidden="true"
                            data-testid="default-banner-monogram-copy"
                            className="absolute rounded-full object-cover pointer-events-none opacity-[0.16] dark:opacity-[0.14]"
                            style={{
                                top: '8%',
                                left,
                                width: '20.6667%',
                                height: '62%',
                            }}
                        />
                    ))}
                    {MONOGRAM_ROW_2_LEFTS.map((left, idx) => (
                        <img
                            key={`m2-${idx}`}
                            src={resolvedLogo}
                            alt=""
                            aria-hidden="true"
                            data-testid="default-banner-monogram-copy"
                            className="absolute rounded-full object-cover pointer-events-none opacity-[0.16] dark:opacity-[0.14]"
                            style={{
                                top: '63.8%',
                                left,
                                width: '20.6667%',
                                height: '62%',
                            }}
                        />
                    ))}
                </>
            ) : (
                <img
                    src={resolvedLogo}
                    alt=""
                    aria-hidden="true"
                    data-testid="default-banner-echo-copy"
                    className="absolute rounded-full object-cover pointer-events-none opacity-[0.20] dark:opacity-[0.24] left-[50%] rtl:left-[-13.333%]"
                    style={{
                        top: '-45%',
                        width: '63.3333%',
                        height: '190%',
                    }}
                />
            )}
        </div>
    );
};
