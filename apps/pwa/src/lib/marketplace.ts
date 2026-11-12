/**
 * Marketplace Categories — 16-category spec
 * Blue (#3b82f6) = Offers, Orange (#f97316) = Needs
 *
 * Each category's name is a word() key, shown through t(cat.label) where a member reads it (the phone's
 * constants/categories.ts keys where the words are the same: 'Services', 'Tools', …). The id is what the node stores.
 */
import type { ShownFromLine } from '@beanpool/core';
import { t, word } from '@beanpool/core';

export const MARKETPLACE_CATEGORIES = [
    { id: 'food', emoji: '🥕', label: word('Food & Produce') },
    { id: 'services', emoji: '🤝', label: word('Services') },
    { id: 'labour', emoji: '👷', label: word('Labour') },
    { id: 'tools', emoji: '🛠️', label: word('Tools') },
    { id: 'goods', emoji: '📦', label: word('Goods') },
    { id: 'garden', emoji: '🌻', label: word('Garden') },
    { id: 'housing', emoji: '🏠', label: word('Housing') },
    { id: 'transport', emoji: '🚗', label: word('Transport') },
    { id: 'education', emoji: '📚', label: word('Education') },
    { id: 'arts', emoji: '🎨', label: word('Arts') },
    { id: 'health', emoji: '🌿', label: word('Health & Wellness') },
    { id: 'care', emoji: '❤️', label: word('Care & Support') },
    { id: 'animals', emoji: '🐾', label: word('Animals') },
    { id: 'tech', emoji: '💻', label: word('Tech & Digital') },
    { id: 'energy', emoji: '☀️', label: word('Energy') },
    { id: 'mindset', emoji: '📜', label: word('Mindset & Philosophy') },
    { id: 'general', emoji: '🌱', label: word('General') },
] as const;

// ⚡ Bolt: O(1) Map lookup for marketplace categories instead of repeated O(N) .find() scans
export const MARKETPLACE_CATEGORIES_BY_ID = new Map(
    MARKETPLACE_CATEGORIES.map(c => [c.id as string, c])
);

export type PostType = 'offer' | 'need' | 'poll' | 'event';

/**
 * A listing's type on its chip, the list card's and the listing page's (the chip's caller puts it in capitals); a type this
 * build doesn't know, as written.
 */
export function typeWords(type: string): string {
    return type === 'offer' ? t('offer', undefined, 'post type') : type === 'need' ? t('need', undefined, 'post type') : String(type ?? '');
}

export const POST_TYPE_COLORS = {
    offer: '#10b981',  // Sage Green (Emerald-500)
    need: '#d97757',  // Soft Terracotta
    poll: '#8b5cf6',  // Purple / Violet
    event: '#7c3aed', // Deep violet — the event pin (docs/events-on-the-map.md §3)
} as const;

export interface PollOption {
    /** This answer is Other, which takes typed words. Only the node sets it. */
    other?: boolean;
    id: string;
    text: string;
    votes?: number;
    percentage?: number;
    /** Of this option's votes, how many came from new or 12-word accounts, where the node gives the split. */
    newOrWordsVotes?: number;
}

export interface PollVoteRecord {
    voterPubkey: string;
    voterCallsign?: string;
    optionId: string;
    createdAt: string;
}

export interface MarketplacePost {
    id: string;
    /** A member's copy on the global community (@beanpool/core eventCopyOf): no author, no RSVP, no deal. */
    shownCopy?: boolean;
    shownFrom?: ShownFromLine;
    /** Its price at home, for its words alone (core copyPriceLine). */
    shownPrice?: string;
    type: PostType;
    category: string;
    title: string;
    description: string;
    /** The price, whole hundredths of a Bean. */
    price_c: number;
    priceType: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly';
    /** An Offer priced for each one (the node sends priceType 'each'; the union above is widened by the slice that offers it, P4): how many can be taken now, and the price for all of them as stored (core per-item.ts). */
    unitsLeft?: number;
    lot?: { units: number; price_c: number } | null;
    authorCallsign: string;
    authorPublicKey: string;
    location: { lat: number; lng: number } | null;
    createdAt: string;
    photos?: string[];
    status?: 'active' | 'pending' | 'paused' | 'completed' | 'cancelled';
    pinnedUntil?: string | null;
    pinnedAt?: string | null;
    repeatable?: boolean;
    lendable?: boolean;
    /** #108: a real cash outlay is involved (fuel / consumables). No amount — terms live in chat. */
    cashAlsoNeeded?: boolean;
    acceptedBy?: string;
    authorEnergyCycled?: number;
    authorFoundingNeeded?: boolean;
    authorBannerUrl?: string | null;
    lat?: number;
    lng?: number;
    pollOptions?: PollOption[];
    pollClosesAt?: string;
    /** A poll its creator made an open vote: members see who chose what (pollVotes). Otherwise anonymous. */
    pollOpenVote?: boolean;
    totalVotes?: number;
    /** How many of the votes came from new or 12-word accounts (the global node's public polls). */
    pollNewOrWordsVotes?: number;
    userVotedOptionId?: string;
    pollAnswered?: boolean;
    pollVotes?: PollVoteRecord[];
    audienceScope?: 'public' | 'group' | 'direct';
    targetGroupId?: string;
    targetGroupName?: string;
}

/**
 * Format a node origin or peer name into a clean, human-readable label.
 * Handles domain names, multi-addrs, raw IP addresses, and custom callsigns/link names.
 */
export function formatNodeName(origin?: string | null, knownName?: string | null): string {
    if (knownName && typeof knownName === 'string') {
        const cleaned = knownName.replace(/\s+Link$/i, '').trim();
        if (cleaned) return cleaned;
    }
    if (!origin || typeof origin !== 'string') return '';

    const multiAddrMatch = origin.match(/^\/(?:ip4|ip6|dns4|dns6)\/([^/]+)/);
    if (multiAddrMatch) {
        const host = multiAddrMatch[1];
        return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ? `peer (${host})` : host;
    }

    const name = origin.replace(/^https?:\/\//, '').replace(/\.beanpool\.org.*$/, '').replace(/:\d+.*$/, '');
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) {
        return `peer (${name})`;
    }
    return name;
}

/**
 * A listing tile's screen-reader name: "Open listing: <title>", with " (from byron)" for a listing pulled from another
 * community (#143 step 4).
 *
 * The community is needed because the tile's `aria-label` REPLACES its children for a screen reader, so the 🌐 badge
 * inside `MarketplaceCard` is announced to nobody (review finding). Which community a listing comes from is not
 * decoration here — it decides who the buyer's beans are owed to.
 *
 * Same trimming as the visible badge, and one definition would be better than two; the badge's copy lives
 * inside `MarketplaceCard` and hoisting it is a wider change than this PR should make. The Market's tiles and the map's
 * pop-up (MapPage) both name their card with it.
 */
export function openListingLabel(post: any): string {
    const title = post?.title ?? '';
    const remote = post?._remoteNode ?? post?.originNode;
    const name = formatNodeName(remote, post?._remoteCallsign);
    if (!name) return t('Open listing: {title}', { title });
    return name.startsWith('peer (')
        ? t('Open listing: {title} from {community}', { title, community: name })
        : t('Open listing: {title} (from {community})', { title, community: name });
}
