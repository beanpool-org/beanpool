/**
 * Creator channel vocabulary & metadata — The Pulse.
 *
 * Single source of truth for platform and category taxonomy, icons, listing behaviors,
 * and display metadata. Used across Native, PWA, and server surfaces to prevent drift.
 */

export type ChannelPlatform = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'website' | 'rss';
export type ChannelCategory = 'community' | 'food' | 'craft' | 'business' | 'repair' | 'art' | 'other';

/**
 * How each platform behaves once added, in the member's terms:
 * - 'auto': auto-syncs items (e.g. YouTube, RSS feeds)
 * - 'manual': requires manual item submission per post (e.g. Instagram, TikTok, Facebook)
 * - 'card': displays as a single entity card (e.g. website)
 */
export type Listing = 'auto' | 'manual' | 'card';

export const LISTING_LABEL: Record<Listing, string> = {
    auto: 'updates itself',
    manual: 'a tap per post',
    card: 'shows as a card',
};

export interface PlatformInfo {
    id: ChannelPlatform;
    icon: string;
    label: string;
    listing: Listing;
    hint: string;
}

export interface CategoryInfo {
    id: ChannelCategory;
    icon: string;
    label: string;
}

export const PLATFORMS: readonly PlatformInfo[] = [
    { id: 'youtube', icon: '🎥', label: 'YouTube', listing: 'auto', hint: 'youtube.com/@you' },
    { id: 'instagram', icon: '📷', label: 'Instagram', listing: 'manual', hint: '@yourhandle' },
    { id: 'tiktok', icon: '🎵', label: 'TikTok', listing: 'manual', hint: '@yourhandle' },
    { id: 'website', icon: '🌐', label: 'Website', listing: 'card', hint: 'yoursite.com' },
    { id: 'facebook', icon: '📘', label: 'Facebook', listing: 'manual', hint: 'facebook.com/yourpage' },
    { id: 'rss', icon: '✍️', label: 'Blog / RSS', listing: 'auto', hint: 'yourblog.com/feed' },
] as const;

export const CATEGORIES: readonly CategoryInfo[] = [
    { id: 'community', icon: '📣', label: 'Community' },
    { id: 'food', icon: '🌱', label: 'Food & growing' },
    { id: 'craft', icon: '🔨', label: 'Making & craft' },
    { id: 'repair', icon: '🔧', label: 'Repair & reuse' },
    { id: 'art', icon: '🎨', label: 'Art & music' },
    { id: 'business', icon: '☕', label: 'Business' },
    { id: 'other', icon: '✨', label: 'Other' },
] as const;

export const VIDEO_PLATFORMS: readonly ChannelPlatform[] = ['youtube', 'tiktok', 'instagram', 'facebook'] as const;

/**
 * Public channel representation returned by `GET /api/members/:publicKey/channels`.
 * Stripped of private configuration (autopublish, postCountSeen).
 */
export interface PublicCreatorChannel {
    id: string;
    platform: ChannelPlatform;
    url: string | null;
    handle: string | null;
    category: ChannelCategory;
    isPrimaryVideo: boolean;
    supportsAutolist: boolean;
    isVerified: boolean;
}

/**
 * Platform metadata helper with safe fallback.
 *
 * CRITICAL RULE: Never fall back to PLATFORMS[0] for an unknown platform id.
 * That rendered an unknown platform as "YouTube · updates itself" — a false
 * autolist promise attached to the wrong name.
 */
export function platformMeta(id: string | null | undefined): PlatformInfo {
    const match = PLATFORMS.find(p => p.id === id);
    if (match) return match;
    return {
        id: (id || 'website') as ChannelPlatform,
        icon: '🔗',
        label: 'Link',
        listing: 'card',
        hint: '',
    };
}

/**
 * Category metadata helper with safe fallback.
 *
 * CRITICAL RULE: Never fall back to CATEGORIES[0] — an unknown category must
 * not render as "Community". It defaults safely to "Other".
 */
export function categoryMeta(id: string | null | undefined): CategoryInfo {
    const match = CATEGORIES.find(c => c.id === id);
    if (match) return match;
    return {
        id: (id || 'other') as ChannelCategory,
        icon: '✨',
        label: 'Other',
    };
}

/**
 * Is this a URL we are willing to hand to a browser or to Linking.openURL?
 *
 * Only http(s) qualifies. A channel row can carry no URL at all (a tombstoned
 * row NULLs it), and a scheme like `javascript:` or `data:` must never reach an
 * href — so callers render inert text rather than a link when this is false.
 * `#` is not a safe fallback href either: in the PWA it scrolls the router and,
 * with target="_blank", opens an empty tab.
 */
export function isWebUrl(url: string | null | undefined): boolean {
    const trimmed = url?.trim();
    if (!trimmed) return false;
    return /^https?:\/\//i.test(trimmed);
}
