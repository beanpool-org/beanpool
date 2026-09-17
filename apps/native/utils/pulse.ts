/**
 * Pulse Feed API client & fixture utilities (The Pulse, Phase 3).
 *
 * Implements Contract B read/mute consumer for React Native:
 * 1. GET /api/pulse/feed (public read, cursor pagination, category filtering)
 * 2. POST /api/member/pulse/items/:id/mute (signed owner mutation)
 * 3. POST /api/reports with targetPulseItemId (signed report of someone else's item)
 * 4. Local fixture fallback for development, testing, and offline preview.
 */

import { type ChannelPlatform, type ChannelCategory } from '@beanpool/core';
import { anchorUrl, signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';

export interface PulseFeedItem {
    id: string;
    ownerPubkey: string;
    callsign: string;
    avatarUrl: string | null;
    platform: ChannelPlatform | string;
    category: ChannelCategory | string;
    url: string | null;
    title: string | null;
    thumbnailUrl: string | null;
    publishedAt: string | null;
    source: string;
    isVerified: boolean;
}

/**
 * Which lane of the feed an item belongs to.
 *
 * SKETCH ONLY. In production this must be a server-side flag on the channel
 * (creator_channels.is_official, set when an admin creates the channel) and the
 * lane should be a query parameter on GET /api/pulse/feed so pagination stays
 * correct. Deriving it on the client the way this does is a prototype shortcut:
 * it cannot see items that live on later pages.
 */
export function isOfficialSource(item: PulseFeedItem): boolean {
    return item.source === 'official';
}

export interface PulseFeedResponse {
    items: PulseFeedItem[];
    nextCursor: string | null;
}

export interface FetchPulseFeedOptions {
    cursor?: string | null;
    category?: ChannelCategory | string | null;
    limit?: number;
    forceFixture?: boolean;
}

/**
 * Built-in realistic community feed fixture.
 * Used for tests, offline mode, and local UI verification before live syndication.
 */
export const PULSE_FIXTURE_ITEMS: readonly PulseFeedItem[] = [
    {
        id: 'item_fix_01',
        ownerPubkey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        callsign: 'Mullum Ceramics',
        avatarUrl: null,
        platform: 'youtube',
        category: 'craft',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Firing the wood kiln for winter pottery collection',
        thumbnailUrl: 'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?w=800&q=80',
        publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        source: 'autolist',
        isVerified: true,
    },
    {
        id: 'item_fix_02',
        ownerPubkey: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        callsign: 'Byron Organics',
        avatarUrl: null,
        platform: 'rss',
        category: 'food',
        url: 'https://byronorganics.example.com/blog/garlic-harvest-guide',
        title: 'Spring planting notes: Heirloom garlic and comfrey mulch',
        thumbnailUrl: 'https://images.unsplash.com/photo-1592417817098-8f3d6eb22509?w=800&q=80',
        publishedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
        source: 'autolist',
        isVerified: false,
    },
    {
        id: 'item_fix_03',
        ownerPubkey: '111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000',
        callsign: 'Tool Library',
        avatarUrl: null,
        platform: 'website',
        category: 'repair',
        url: 'https://mullumtoollibrary.example.org/news/solar-inverter-teardown',
        title: 'Community Repair Cafe: Fixing 14 off-grid solar inverters',
        thumbnailUrl: 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=800&q=80',
        publishedAt: new Date(Date.now() - 22 * 60 * 60 * 1000).toISOString(),
        source: 'manual',
        isVerified: true,
    },
    {
        id: 'item_fix_04',
        ownerPubkey: '22223333444455556666777788889999aaaabbbbccccddddeeeeffff00001111',
        callsign: 'River Folk Studio',
        avatarUrl: null,
        platform: 'youtube',
        category: 'art',
        url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        title: 'Live acoustic session: Songs from the Creek',
        thumbnailUrl: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=800&q=80',
        publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'autolist',
        isVerified: true,
    },
    {
        id: 'item_fix_05',
        ownerPubkey: '3333444455556666777788889999aaaabbbbccccddddeeeeffff000011112222',
        callsign: 'EcoHub',
        avatarUrl: null,
        platform: 'rss',
        category: 'community',
        url: 'https://ecohub.example.org/seed-swap-recap',
        title: 'Over 200 seed packets shared at Saturday Seed Swap',
        thumbnailUrl: 'https://images.unsplash.com/photo-1530595467537-0b5996c41f2d?w=800&q=80',
        publishedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'autolist',
        isVerified: false,
    },
    {
        id: 'item_fix_06',
        ownerPubkey: '444455556666777788889999aaaabbbbccccddddeeeeffff0000111122223333',
        callsign: 'Northern Rivers Honey',
        avatarUrl: null,
        platform: 'instagram',
        category: 'food',
        url: 'https://www.instagram.com/p/C_honey_harvest/',
        title: 'Raw seasonal honeycomb ready for the weekend market',
        thumbnailUrl: 'https://images.unsplash.com/photo-1587049352846-4a222e784d38?w=800&q=80',
        publishedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'manual',
        isVerified: false,
    },
    {
        id: 'item_fix_07',
        ownerPubkey: '55556666777788889999aaaabbbbccccddddeeeeffff00001111222233334444',
        callsign: 'Green Timber Co',
        avatarUrl: null,
        platform: 'youtube',
        category: 'craft',
        url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
        title: 'Milling fallen cedar into workbench slabs',
        thumbnailUrl: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=800&q=80',
        publishedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
        source: 'autolist',
        isVerified: true,
    },
];

/**
 * Filter and paginate fixture items in-memory.
 */
export function getFixturePulseFeed(options: FetchPulseFeedOptions = {}): PulseFeedResponse {
    const { cursor, category, limit = 20 } = options;
    let filtered = [...PULSE_FIXTURE_ITEMS];

    if (category && category !== 'all') {
        filtered = filtered.filter(item => item.category === category);
    }

    // Sort descending by publishedAt
    filtered.sort((a, b) => {
        const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return db - da;
    });

    if (cursor) {
        const cursorIndex = filtered.findIndex(item => item.id === cursor || item.publishedAt === cursor);
        if (cursorIndex !== -1) {
            filtered = filtered.slice(cursorIndex + 1);
        } else {
            // Unmatched cursor: return empty slice instead of looping back to page 1
            return { items: [], nextCursor: null };
        }
    }

    const pageSize = Math.max(1, Math.min(limit, 50));
    const items = filtered.slice(0, pageSize);
    const nextCursor = items.length === pageSize && filtered.length > pageSize
        ? (items[items.length - 1].publishedAt || items[items.length - 1].id)
        : null;

    return { items, nextCursor };
}

const EMPTY_FEED: PulseFeedResponse = { items: [], nextCursor: null };

/**
 * What to show when the node cannot be reached on a first page.
 *
 * NEVER the fixture in a shipping build. PULSE_FIXTURE_ITEMS is fabricated content — it
 * attributes invented posts to a named community business and one of them links to a
 * Rickroll — and every one of the fallbacks below is reachable in production: no anchor
 * node, a node without the pulse endpoint, a 5xx, malformed JSON, or simply being offline,
 * which is the normal state for a lot of our users. Shipping invented posts into a social
 * feed is also the kind of thing an app review rejects.
 *
 * The screen already has an honest empty state, so an empty feed is the right answer.
 * Tests and local UI work opt in explicitly with `forceFixture`.
 */
function offlineFeed(options: FetchPulseFeedOptions): PulseFeedResponse {
    return (typeof __DEV__ !== 'undefined' && __DEV__) ? getFixturePulseFeed(options) : EMPTY_FEED;
}

/**
 * Where the phone loads a feed item's preview image from: the node's thumbnail proxy
 * (GET /api/pulse/items/:id/thumbnail), the same endpoint the web app uses. The platform's
 * own image URL is never handed to the image loader, so a member's phone does not contact
 * Meta, Google or TikTok image servers just by scrolling the feed.
 *
 * Null when the item has no thumbnail or there is no node to ask; the card then shows its
 * platform placeholder. That is also the fallback when the proxy fails (404, node offline):
 * falling back to the platform URL would bring back exactly the contact this avoids.
 */
export function resolvePulseThumbnailUrl(
    nodeUrl: string | null | undefined,
    item: Pick<PulseFeedItem, 'id' | 'thumbnailUrl'>,
): string | null {
    const base = nodeUrl?.trim().replace(/\/+$/, '');
    const id = item.id?.trim();
    if (!base || !id || !item.thumbnailUrl) return null;
    return `${base}/api/pulse/items/${encodeURIComponent(id)}/thumbnail`;
}

/**
 * Fetch pulse feed items from the node. On a first page, an unreachable node yields an
 * empty feed (see offlineFeed); during pagination it throws so the UI can say so.
 */
export async function fetchPulseFeed(options: FetchPulseFeedOptions = {}): Promise<PulseFeedResponse> {
    if (options.forceFixture) {
        return getFixturePulseFeed(options);
    }

    try {
        const url = await anchorUrl();
        if (!url) {
            return offlineFeed(options);
        }

        const queryParams = new URLSearchParams();
        if (options.cursor) queryParams.set('cursor', options.cursor);
        if (options.category && options.category !== 'all') queryParams.set('category', options.category);
        if (options.limit) queryParams.set('limit', String(options.limit));

        const queryString = queryParams.toString();
        const endpoint = `${url.replace(/\/+$/, '')}/api/pulse/feed${queryString ? `?${queryString}` : ''}`;

        const res = await fetch(endpoint, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });

        if (!res.ok) {
            // Do not inject fixture items into live pagination streams on server errors
            if (options.cursor) {
                throw new Error(`Failed to load feed page (${res.status})`);
            }
            return offlineFeed(options);
        }

        const data = await res.json().catch(() => null);
        if (!data || !Array.isArray(data.items)) {
            if (options.cursor) {
                throw new Error('Invalid feed response from server');
            }
            return offlineFeed(options);
        }

        return {
            items: data.items,
            nextCursor: data.nextCursor ?? null,
        };
    } catch (e: any) {
        // Network failure / offline during pagination should propagate error, not inject fixture
        if (options.cursor) {
            throw e;
        }
        return offlineFeed(options);
    }
}

/**
 * Mute / un-mute a pulse feed item owned by the active member.
 *
 * Calls Contract B: POST /api/member/pulse/items/:id/mute (signed request).
 */
export async function mutePulseItem(
    itemId: string,
    muted: boolean,
    identity?: BeanPoolIdentity | null,
): Promise<{ success: boolean; item?: PulseFeedItem }> {
    if (!identity) {
        throw new Error('Identity required to mute items.');
    }
    if (!itemId) {
        throw new Error('Item ID is required.');
    }

    const url = await anchorUrl();
    if (!url || itemId.startsWith('item_fix_')) {
        // In fixture / mock mode: mock success
        return { success: true };
    }

    const res = await signedPost(
        url,
        `/api/member/pulse/items/${encodeURIComponent(itemId)}/mute`,
        { muted },
        identity,
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data?.message || data?.error || `Failed to update mute status (${res.status})`);
    }

    return {
        success: Boolean(data.success),
        item: data.item,
    };
}

/** The same reasons the post-detail report form offers. */
export const PULSE_REPORT_REASONS = ['Spam or scam', 'Offensive content', 'Misleading post', 'Other'] as const;

/** A signed-in member can report an item that is not theirs. Fixture items are not on any node. */
export function canReportPulseItem(item: PulseFeedItem, currentPubkey?: string | null): boolean {
    return Boolean(currentPubkey && item.ownerPubkey && item.ownerPubkey !== currentPubkey && !item.id.startsWith('item_fix_'));
}

/**
 * Report someone else's Pulse item to the node's operators.
 *
 * POST /api/reports with targetPulseItemId (signed). The node resolves the reported member from the
 * item's owner, refuses your own item (400) and an item that is gone (404).
 */
export async function reportPulseItem(
    item: PulseFeedItem,
    reason: string,
    identity?: BeanPoolIdentity | null,
): Promise<{ success: boolean }> {
    if (!identity) {
        throw new Error('Identity required to report items.');
    }
    if (!item?.id || !reason?.trim()) {
        throw new Error('An item and a reason are required.');
    }

    const url = await anchorUrl();
    if (!url) {
        throw new Error('Not connected to a node.');
    }

    const res = await signedPost(
        url,
        '/api/reports',
        { reporterPubkey: identity.publicKey, targetPubkey: item.ownerPubkey, targetPulseItemId: item.id, reason: reason.trim() },
        identity,
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data?.message || data?.error || `Failed to report item (${res.status})`);
    }
    return { success: Boolean(data.success) };
}

/**
 * Format an ISO publishedAt timestamp into a human-readable relative string.
 *
 * e.g. "Just now", "25m ago", "3h ago", "2d ago", "Aug 24"
 */
export function formatRelativeTime(dateString: string | null | undefined): string {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';

    const now = Date.now();
    const diffMs = now - date.getTime();

    // Future timestamp protection
    if (diffMs < 0) return 'Just now';

    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;

    // Format as "MMM D" e.g. "Aug 24"
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
