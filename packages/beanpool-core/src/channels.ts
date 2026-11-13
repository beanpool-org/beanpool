/**
 * Creator channel vocabulary & metadata — The Pulse.
 *
 * Single source of truth for platform and category taxonomy, icons, listing behaviors,
 * and display metadata. Used across Native, PWA, and server surfaces to prevent drift.
 *
 * Our own words here (what a platform asks of the member, the categories, the example handles, the names that are not
 * a brand) are word() keys: the English itself, translated through t() where they are drawn. A platform's brand name
 * (YouTube, TikTok …) reads as it is written in every language: platformName says which is which.
 */

import { t, word, type WordKey } from './words.js';

export type ChannelPlatform = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'soundcloud' | 'website' | 'rss';
export type ChannelCategory = 'community' | 'food' | 'craft' | 'business' | 'repair' | 'art' | 'learn' | 'other';

/**
 * How each platform behaves once added, in the member's terms:
 * - 'auto': auto-syncs items (e.g. YouTube, RSS feeds)
 * - 'manual': requires manual item submission per post (e.g. Instagram, TikTok, Facebook)
 * - 'card': displays as a single entity card (e.g. website)
 */
export type Listing = 'auto' | 'manual' | 'card';

/** Shown through t() where it is drawn. */
export const LISTING_LABEL: Record<Listing, WordKey> = {
    auto: word('updates itself'),
    manual: word('a tap per post'),
    card: word('shows as a card'),
};

export interface PlatformInfo {
    id: ChannelPlatform;
    icon: string;
    /** The platform's name as written: a brand, or one of our own (drawn with platformName, which translates those). */
    label: string;
    listing: Listing;
    /** An example of what to type, shown through t() where it is drawn; '' when there is none. */
    hint: WordKey | '';
}

export interface CategoryInfo {
    id: ChannelCategory;
    icon: string;
    /** Shown through t() where it is drawn. */
    label: WordKey;
}

export const PLATFORMS: readonly PlatformInfo[] = [
    { id: 'youtube', icon: '🎥', label: 'YouTube', listing: 'auto', hint: word('youtube.com/@you') },
    { id: 'instagram', icon: '📷', label: 'Instagram', listing: 'manual', hint: word('@yourhandle') },
    { id: 'tiktok', icon: '🎵', label: 'TikTok', listing: 'manual', hint: word('@yourhandle') },
    { id: 'soundcloud', icon: '🎧', label: 'SoundCloud', listing: 'auto', hint: word('soundcloud.com/you') },
    { id: 'website', icon: '🌐', label: 'Website', listing: 'card', hint: word('yoursite.com') },
    { id: 'facebook', icon: '📘', label: 'Facebook', listing: 'manual', hint: word('facebook.com/yourpage') },
    { id: 'rss', icon: '✍️', label: 'Blog / RSS', listing: 'auto', hint: word('yourblog.com/feed') },
] as const;

export const CATEGORIES: readonly CategoryInfo[] = [
    { id: 'community', icon: '📣', label: word('Community') },
    { id: 'food', icon: '🌱', label: word('Food & growing') },
    { id: 'craft', icon: '🔨', label: word('Making & craft') },
    { id: 'repair', icon: '🔧', label: word('Repair & reuse') },
    { id: 'art', icon: '🎨', label: word('Art & music') },
    { id: 'business', icon: '☕', label: word('Business') },
    { id: 'learn', icon: '📚', label: word('How it works') },
    { id: 'other', icon: '✨', label: word('Other') },
] as const;

/** The platform names that are our own words rather than a brand, by their English: these are translated. */
const OUR_PLATFORM_NAMES: Readonly<Record<string, WordKey>> = {
    Website: word('Website'),
    'Blog / RSS': word('Blog / RSS'),
    Link: word('Link'),
};

/**
 * A platform's name in the member's language: a brand (YouTube, Instagram, TikTok, SoundCloud, Facebook) as it is
 * written everywhere, our own names (Website, Blog / RSS, and Link for a platform this build does not know) through
 * t(). English reads exactly as platformMeta(id).label.
 */
export function platformName(id: string | null | undefined): string {
    const label = platformMeta(id).label;
    return Object.prototype.hasOwnProperty.call(OUR_PLATFORM_NAMES, label) ? t(OUR_PLATFORM_NAMES[label]) : label;
}

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
        label: word('Other'),
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

// ── The Pulse page: its one add button and a quiet week (DESIGN-pulse-home-fable.md §3.2, §3.4, §3.8, P2/P3) ─────────

/** The Pulse page's own words, the same on the phone and the web. Shown through t() where drawn. */
export const PULSE_PAGE_WORDS = {
    /** The one add button, bottom right (in the middle of the page on a quiet week, where it is still the only one). */
    add: word('Add to Pulse'),
    /** The title row's way to the member's own channels (was "+ Channels"). */
    yourChannels: word('Your channels'),
    quietTitle: word('Nothing new this week.'),
    quietBody: word('Have a video, a song, a blog or photos of your own? Add a link and your neighbours see it here.'),
    learnLine: word('Nothing to add? The Learn lane has short videos on how BeanPool works.'),
    /** On the worldwide community, where nothing is asked to be added yet: the Learn lane leads. */
    learnGlobal: word('The Learn lane has short videos on how BeanPool works.'),
} as const;

/**
 * Whether the Pulse page offers Add to Pulse on this community (Marty's pick 3 of 14 Nov 2026). On the worldwide community
 * it waits until adding there has rules for new people (the design's P5: a first look, and reports that can hide an item);
 * a local community adds at once. A profile not heard yet is no reason to take a local member's button away. The Settings
 * path to Channels that exists today is neither widened nor narrowed.
 */
export function pulseAddsHere(profile: string | null | undefined): boolean {
    return profile !== 'global';
}
