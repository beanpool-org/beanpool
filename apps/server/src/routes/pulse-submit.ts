/**
 * Manual Ingestion & Creator Pulse Submission Routes (The Pulse, Package 05).
 *
 * Implements:
 * 1. POST /api/member/pulse/preview
 *    - Resolves URL via ssrfSafeFetch or oEmbed (TikTok, YouTube, OpenGraph for Instagram & blogs).
 *    - Validates ownership against signer channels in creator_channels (where owner_pubkey = ctx.state.actor AND deleted_at IS NULL).
 *    - Extracts metadata (title, thumbnail, publishedAt, platform, externalId, category).
 *    - Checks if already imported in pulse_items.
 * 2. POST /api/member/pulse/submit
 *    - Takes { url, channelId, title, thumbnailUrl, category }.
 *    - Verifies channel ownership (owner_pubkey = ctx.state.actor).
 *    - Normalizes URL and extracts external_id.
 *    - If publishedAt is not provided/null from source, set published_at to submission time (new Date().toISOString()).
 *    - Source = 'manual'.
 *    - Deduplicates against existing pulse_items rows (idx_pulse_items_dedupe on channel_id + external_id, or channel_id + url).
 *    - Restores tombstoned rows if resubmitted.
 *    - Returns { success: true, item: PulseFeedCard, deduplicated: boolean }.
 * 3. POST /api/member/pulse/channels/:id/dismiss-nudge
 *    - Owner-scoped (ctx.state.actor).
 *    - Updates post_count_seen on creator_channels to seenCount (or latest probed count) and updated_at = now().
 *    - Returns { success: true, channelId, postCountSeen }.
 * 4. POST /api/member/pulse/items/:id/delete
 *    - Owner-scoped (ctx.state.actor).
 *    - Calls scrubPulseItems({ id: ctx.params.id, ownerPubkey: ctx.state.actor }).
 *    - Returns { success: true }.
 * 5. POST /api/member/pulse/nudges
 *    - Owner-scoped (ctx.state.actor).
 *    - Lists member's channels where probed post count > post_count_seen.
 *    - Returns { nudges: [...] }.
 */

import Router from '@koa/router';
import crypto from 'node:crypto';
import net from 'node:net';
import { URL } from 'node:url';
import { db } from '../db/db.js';
import {
    ssrfSafeFetch,
    extractYouTubeVideoId,
    parseFeedDate,
    decodeHtmlEntities,
    cleanXmlText,
    validateHostnameSyntax,
    validateIpString,
    probeInstagramPostCount,
    scrubPulseItems,
    PulseError,
    SsrfSecurityError,
    type PulseFeedCard,
} from '../engine/pulse-resolver.js';
import {
    CHANNEL_CATEGORIES,
    type ChannelCategory,
    type ChannelPlatform,
    normaliseChannelInput,
} from '../engine/creator-channels.js';
import { getPulseOAuthConfig } from './channels.js';
import type { RouteDeps } from './types.js';

export interface ResolvedPulsePreview {
    channelId: string;
    platform: ChannelPlatform;
    externalId: string | null;
    url: string;
    title: string;
    thumbnailUrl: string | null;
    publishedAt: string | null;
    category: ChannelCategory;
    alreadyImported: boolean;
    existingItemId?: string | null;
}

function pulseErrorStatus(code: string): number {
    switch (code) {
        case 'NOT_FOUND': return 404;
        case 'NOT_YOURS':
        case 'NO_CHANNEL_MATCH':
        case 'FORBIDDEN':
            return 403;
        case 'INVALID_URL':
        case 'BAD_CATEGORY':
        case 'BAD_FIELD':
        case 'SSRF_BLOCKED':
        case 'MISSING_FIELD':
            return 400;
        default: return 400;
    }
}

function extractMetaProperty(html: string, prop: string): string | null {
    if (!html) return null;
    const escaped = prop.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const regex1 = new RegExp(`<meta\\s+[^>]*property=["']${escaped}["'][^>]*content=["']([^"']+)["']`, 'i');
    const regex2 = new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*property=["']${escaped}["']`, 'i');
    const regex3 = new RegExp(`<meta\\s+[^>]*name=["']${escaped}["'][^>]*content=["']([^"']+)["']`, 'i');
    const regex4 = new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*name=["']${escaped}["']`, 'i');
    const m = regex1.exec(html) || regex2.exec(html) || regex3.exec(html) || regex4.exec(html);
    return m ? decodeHtmlEntities(m[1].trim()) : null;
}

function extractTagText(html: string, tagName: string): string | null {
    if (!html) return null;
    const escaped = tagName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const regex = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
    const m = regex.exec(html);
    return m ? decodeHtmlEntities(cleanXmlText(m[1])) : null;
}

/**
 * Detect platform and extract identity from URL without making network calls.
 * Performs strict hostname / IP address SSRF validation.
 */
export function identifyPlatformAndExternalId(rawUrl: string): {
    platform: ChannelPlatform;
    externalId: string | null;
    canonicalUrl: string;
    accountHandle: string | null;
} {
    const trimmed = (rawUrl || '').trim();
    if (!trimmed) {
        throw new PulseError('INVALID_URL', 'URL cannot be empty.');
    }

    let parsed: URL;
    try {
        parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
        throw new PulseError('INVALID_URL', 'Invalid URL format.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new PulseError('INVALID_URL', 'Only HTTP and HTTPS URLs are supported.');
    }

    // Strict IP vs Hostname validation against private/reserved addresses
    let hostClean = parsed.hostname.trim();
    if (hostClean.startsWith('[') && hostClean.endsWith(']')) {
        hostClean = hostClean.slice(1, -1);
    }
    if (net.isIP(hostClean)) {
        validateIpString(hostClean);
    } else {
        validateHostnameSyntax(hostClean);
    }

    const host = hostClean.toLowerCase().replace(/^www\./, '');
    let platform: ChannelPlatform = 'website';
    let externalId: string | null = null;
    let canonicalUrl = parsed.toString();
    let accountHandle: string | null = null;

    if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com') {
        platform = 'youtube';
        const ytId = extractYouTubeVideoId(canonicalUrl);
        if (ytId) {
            externalId = ytId;
            canonicalUrl = `https://www.youtube.com/watch?v=${ytId}`;
        }
        const handleMatch = /@([a-zA-Z0-9_.-]+)/i.exec(parsed.pathname);
        if (handleMatch) {
            accountHandle = `@${handleMatch[1].toLowerCase()}`;
        }
    } else if (host === 'tiktok.com' || host === 'vm.tiktok.com') {
        platform = 'tiktok';
        const vmMatch = /\/video\/(\d+)/i.exec(parsed.pathname);
        if (vmMatch) {
            externalId = vmMatch[1];
        }
        const handleMatch = /@([a-zA-Z0-9_.-]+)/i.exec(parsed.pathname);
        if (handleMatch) {
            accountHandle = `@${handleMatch[1].toLowerCase()}`;
        }
    } else if (host === 'instagram.com' || host === 'instagr.am') {
        platform = 'instagram';
        const igMatch = /\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/i.exec(parsed.pathname);
        if (igMatch) {
            externalId = igMatch[1];
            canonicalUrl = `https://www.instagram.com/p/${igMatch[1]}/`;
        }
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length >= 2 && !['p', 'reel', 'reels', 'tv', 'stories', 'explore'].includes(segments[0].toLowerCase())) {
            accountHandle = `@${segments[0].toLowerCase()}`;
        }
    } else if (host === 'facebook.com' || host === 'fb.com' || host === 'fb.me') {
        platform = 'facebook';
        const fbMatch = /\/(?:posts|share\/p)\/([a-zA-Z0-9_-]+)/i.exec(parsed.pathname);
        if (fbMatch) {
            externalId = fbMatch[1];
        }
    } else if (host === 'soundcloud.com' || host === 'snd.sc' || host === 'm.soundcloud.com') {
        platform = 'soundcloud';
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length >= 1 && !['discover', 'stream', 'upload', 'search', 'you', 'charts', 'messages', 'settings'].includes(segments[0].toLowerCase())) {
            accountHandle = `@${segments[0].toLowerCase()}`;
        }
        externalId = canonicalUrl;
    } else {
        platform = 'website';
        externalId = canonicalUrl;
    }

    return { platform, externalId, canonicalUrl, accountHandle };
}

/**
 * Fetch and extract rich metadata (title, thumbnail, publishedAt) using SSRF-safe fetch.
 */
export async function resolveMetadata(
    url: string,
    platform: ChannelPlatform,
    externalId: string | null
): Promise<{
    title: string;
    thumbnailUrl: string | null;
    publishedAt: string | null;
    externalId: string | null;
    authorHandle: string | null;
}> {
    let title = 'Untitled Post';
    let thumbnailUrl: string | null = null;
    let publishedAt: string | null = null;
    let resolvedExternalId = externalId;
    let authorHandle: string | null = null;

    if (platform === 'youtube' && externalId) {
        thumbnailUrl = `https://i.ytimg.com/vi/${externalId}/hqdefault.jpg`;
        title = 'YouTube Video';
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${externalId}`)}&format=json`;
            const res = await ssrfSafeFetch(oembedUrl, { timeoutMs: 5000, maxBytes: 512 * 1024 });
            if (res.status === 200) {
                const data = await res.json();
                if (data.title) title = cleanXmlText(data.title);
                if (data.thumbnail_url) thumbnailUrl = data.thumbnail_url;
                if (data.author_name) authorHandle = data.author_name;
            }
        } catch (err: any) {
            if (err instanceof SsrfSecurityError) throw err;
        }
    } else if (platform === 'tiktok') {
        title = 'TikTok Video';
        try {
            const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
            const res = await ssrfSafeFetch(oembedUrl, { timeoutMs: 5000, maxBytes: 512 * 1024 });
            if (res.status === 200) {
                const data = await res.json();
                if (data.title) title = cleanXmlText(data.title);
                if (data.thumbnail_url) thumbnailUrl = data.thumbnail_url;
                if (data.author_unique_id) authorHandle = `@${data.author_unique_id.toLowerCase()}`;
                if (!resolvedExternalId && data.embed_product_id) {
                    resolvedExternalId = String(data.embed_product_id);
                }
            }
        } catch (err: any) {
            if (err instanceof SsrfSecurityError) throw err;
        }
    } else if (platform === 'soundcloud') {
        title = 'SoundCloud Track';
        try {
            const oembedUrl = `https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`;
            const res = await ssrfSafeFetch(oembedUrl, { timeoutMs: 5000, maxBytes: 512 * 1024 });
            if (res.status === 200) {
                const data = await res.json();
                if (data.title) title = cleanXmlText(data.title);
                if (data.thumbnail_url) thumbnailUrl = data.thumbnail_url;
                if (data.author_name) authorHandle = data.author_name;
            }
        } catch (err: any) {
            if (err instanceof SsrfSecurityError) throw err;
        }

        if (!thumbnailUrl || title === 'SoundCloud Track') {
            try {
                const res = await ssrfSafeFetch(url, {
                    timeoutMs: 5000,
                    maxBytes: 1024 * 1024,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    },
                });
                if (res.status === 200) {
                    const html = await res.text();
                    const ogTitle = extractMetaProperty(html, 'og:title') || extractMetaProperty(html, 'twitter:title') || extractTagText(html, 'title');
                    const ogImage = extractMetaProperty(html, 'og:image') || extractMetaProperty(html, 'twitter:image');
                    const ogPubDate = extractMetaProperty(html, 'article:published_time') || extractMetaProperty(html, 'og:article:published_time') || extractMetaProperty(html, 'date');
                    if (ogTitle && title === 'SoundCloud Track') title = cleanXmlText(ogTitle);
                    if (ogImage && !thumbnailUrl) thumbnailUrl = ogImage;
                    if (ogPubDate) publishedAt = parseFeedDate(ogPubDate);
                }
            } catch (err: any) {
                if (err instanceof SsrfSecurityError) throw err;
            }
        }
    } else if (platform === 'instagram') {
        title = 'Instagram Post';
        try {
            const res = await ssrfSafeFetch(url, {
                timeoutMs: 5000,
                maxBytes: 1024 * 1024,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
            });
            if (res.status === 200) {
                const html = await res.text();
                const ogTitle = extractMetaProperty(html, 'og:title') || extractMetaProperty(html, 'twitter:title') || extractTagText(html, 'title');
                const ogImage = extractMetaProperty(html, 'og:image') || extractMetaProperty(html, 'twitter:image');
                if (ogTitle) title = cleanXmlText(ogTitle);
                if (ogImage) thumbnailUrl = ogImage;
            }
        } catch (err: any) {
            if (err instanceof SsrfSecurityError) throw err;
        }
    } else {
        // Generic blog / website / RSS
        title = 'Web Article';
        try {
            const res = await ssrfSafeFetch(url, { timeoutMs: 5000, maxBytes: 1024 * 1024 });
            if (res.status === 200) {
                const html = await res.text();
                const ogTitle = extractMetaProperty(html, 'og:title') || extractMetaProperty(html, 'twitter:title') || extractTagText(html, 'title');
                const ogImage = extractMetaProperty(html, 'og:image') || extractMetaProperty(html, 'twitter:image');
                const ogPubDate = extractMetaProperty(html, 'article:published_time') || extractMetaProperty(html, 'og:article:published_time') || extractMetaProperty(html, 'date') || extractMetaProperty(html, 'pubdate');
                if (ogTitle) title = cleanXmlText(ogTitle);
                if (ogImage) thumbnailUrl = ogImage;
                if (ogPubDate) publishedAt = parseFeedDate(ogPubDate);
            }
        } catch (err: any) {
            if (err instanceof SsrfSecurityError) throw err;
        }
    }

    return {
        title,
        thumbnailUrl,
        publishedAt,
        externalId: resolvedExternalId || (platform === 'website' ? url : null),
        authorHandle,
    };
}

/**
 * Match a URL/platform to an owned channel belonging to the authenticated actor.
 */
function matchOwnedChannel(
    actorPubkey: string,
    platform: ChannelPlatform,
    url: string,
    accountHandle: string | null,
    requestedChannelId?: string
): any {
    const ownedChannels = db.prepare(
        `SELECT id, owner_pubkey, platform, url, handle, category, post_count_seen, is_primary_video
           FROM creator_channels
          WHERE owner_pubkey = ? AND deleted_at IS NULL`
    ).all(actorPubkey) as any[];

    if (ownedChannels.length === 0) {
        throw new PulseError('NOT_YOURS', 'You do not have any creator channels registered.');
    }

    if (requestedChannelId) {
        const found = ownedChannels.find(c => c.id === requestedChannelId);
        if (!found) {
            throw new PulseError('NOT_YOURS', 'Channel does not belong to you or does not exist.');
        }
        const platformMatch = found.platform === platform ||
            ((platform === 'website' || platform === 'rss') && (found.platform === 'website' || found.platform === 'rss'));
        if (!platformMatch) {
            throw new PulseError('NO_CHANNEL_MATCH', `Selected channel is a ${found.platform} channel, but the URL is for ${platform}.`);
        }
        return found;
    }

    // Filter by platform compatibility
    const compatible = ownedChannels.filter(c => {
        if (c.platform === platform) return true;
        if ((platform === 'website' || platform === 'rss') && (c.platform === 'website' || c.platform === 'rss')) return true;
        return false;
    });

    if (compatible.length === 0) {
        throw new PulseError('NO_CHANNEL_MATCH', `No owned channel found for platform "${platform}". Add this channel to your profile first.`);
    }

    // If handle is present in the URL, verify it matches
    if (accountHandle) {
        const normAuthor = accountHandle.replace(/^@/, '').toLowerCase();
        const matched = compatible.find(c => {
            const chHandle = (c.handle || '').replace(/^@/, '').toLowerCase();
            const chUrl = (c.url || '').toLowerCase();
            return chHandle === normAuthor || chUrl.includes(`/@${normAuthor}`) || chUrl.includes(`/${normAuthor}/`) || chUrl.endsWith(`/${normAuthor}`);
        });

        if (matched) {
            return matched;
        }

        // If the URL has an explicit handle that conflicts with all member channels on that platform, reject it
        if (platform === 'tiktok' || platform === 'instagram' || platform === 'youtube' || platform === 'soundcloud') {
            throw new PulseError('NOT_YOURS', `The account "${accountHandle}" in the URL does not match your owned channels.`);
        }
    }

    // For website/rss, check hostname match
    if (platform === 'website' || platform === 'rss') {
        try {
            const urlHost = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
            const matched = compatible.find(c => {
                if (!c.url) return false;
                try {
                    const chHost = new URL(c.url).hostname.toLowerCase().replace(/^www\./, '');
                    return chHost === urlHost || urlHost.endsWith(`.${chHost}`);
                } catch {
                    return false;
                }
            });
            if (matched) return matched;
        } catch {
            // ignore
        }
        throw new PulseError('NOT_YOURS', 'The website domain does not match any of your registered website/RSS channels.');
    }

    // Fall back to primary video channel or the first compatible channel
    const primary = compatible.find(c => c.is_primary_video === 1);
    return primary || compatible[0];
}

export function rowToPulseFeedCard(itemId: string): PulseFeedCard {
    const r = db.prepare(
        `SELECT i.id, i.owner_pubkey, i.platform, i.url, i.title, i.thumbnail_url,
                i.published_at, i.category, i.source, c.oauth_verified_at,
                m.callsign, m.avatar_url
           FROM pulse_items i
           LEFT JOIN creator_channels c ON c.id = i.channel_id
           LEFT JOIN members m ON m.public_key = i.owner_pubkey
          WHERE i.id = ?`
    ).get(itemId) as any;

    if (!r) {
        throw new PulseError('NOT_FOUND', 'Item not found.');
    }

    return {
        id: r.id,
        ownerPubkey: r.owner_pubkey,
        callsign: r.callsign || 'Neighbour',
        avatarUrl: r.avatar_url || null,
        platform: r.platform,
        category: r.category,
        url: r.url || null,
        title: r.title || null,
        thumbnailUrl: r.thumbnail_url || null,
        publishedAt: r.published_at || null,
        source: r.source,
        isVerified: Boolean(r.oauth_verified_at),
    };
}

export function createPulseSubmitRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    // Prepare statements outside request and transaction loops (Contract A Rule 4)
    const stmtFindActiveByExternalId = db.prepare(
        `SELECT id, deleted_at FROM pulse_items
          WHERE channel_id = ? AND external_id = ? AND deleted_at IS NULL
          LIMIT 1`
    );
    const stmtFindActiveByUrl = db.prepare(
        `SELECT id, deleted_at FROM pulse_items
          WHERE channel_id = ? AND url = ? AND deleted_at IS NULL
          LIMIT 1`
    );
    const stmtFindExistingByExternalId = db.prepare(
        `SELECT id, deleted_at, title, thumbnail_url, category, published_at
           FROM pulse_items
          WHERE channel_id = ? AND external_id = ?
          ORDER BY (deleted_at IS NULL) DESC, created_at DESC
          LIMIT 1`
    );
    const stmtFindExistingByUrl = db.prepare(
        `SELECT id, deleted_at, title, thumbnail_url, category, published_at
           FROM pulse_items
          WHERE channel_id = ? AND url = ?
          ORDER BY (deleted_at IS NULL) DESC, created_at DESC
          LIMIT 1`
    );
    const stmtRestoreItem = db.prepare(
        `UPDATE pulse_items
            SET deleted_at = NULL,
                url = ?,
                title = ?,
                thumbnail_url = ?,
                published_at = COALESCE(?, published_at, ?),
                category = ?,
                source = 'manual',
                muted = 0,
                updated_at = ?
          WHERE id = ?`
    );
    const stmtUpdateActiveItem = db.prepare(
        `UPDATE pulse_items
            SET title = COALESCE(?, title),
                thumbnail_url = COALESCE(?, thumbnail_url),
                category = ?,
                updated_at = ?
          WHERE id = ?`
    );
    const stmtInsertItem = db.prepare(
        `INSERT INTO pulse_items
            (id, channel_id, owner_pubkey, platform, external_id,
             url, title, thumbnail_url, published_at, category,
             source, muted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 0, ?, ?)`
    );
    const stmtRestoreOauthItem = db.prepare(
        `UPDATE pulse_items
            SET deleted_at = NULL,
                url = ?,
                title = ?,
                thumbnail_url = ?,
                published_at = COALESCE(?, published_at, ?),
                category = ?,
                source = 'oauth',
                muted = 0,
                updated_at = ?
          WHERE id = ?`
    );
    const stmtInsertOauthItem = db.prepare(
        `INSERT INTO pulse_items
            (id, channel_id, owner_pubkey, platform, external_id,
             url, title, thumbnail_url, published_at, category,
             source, muted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'oauth', 0, ?, ?)`
    );
    const stmtUpdateChannelWatermark = db.prepare(
        `UPDATE creator_channels
            SET post_count_seen = ?, updated_at = ?
          WHERE id = ? AND owner_pubkey = ?`
    );
    const stmtGetChannelById = db.prepare(
        `SELECT id, owner_pubkey, platform, url, handle, post_count_seen
           FROM creator_channels
          WHERE id = ? AND deleted_at IS NULL`
    );
    const stmtGetItemById = db.prepare(
        `SELECT id, owner_pubkey, deleted_at FROM pulse_items WHERE id = ?`
    );
    const stmtGetMemberChannels = db.prepare(
        `SELECT id, owner_pubkey, platform, url, handle, post_count_seen
           FROM creator_channels
          WHERE owner_pubkey = ? AND deleted_at IS NULL`
    );

    /**
     * 1. POST /api/member/pulse/preview
     * Resolves metadata via SSRF-safe fetch / oEmbed / OpenGraph, validates ownership
     * against signer's channels, and checks if already imported in pulse_items.
     */
    router.post('/api/member/pulse/preview', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }

        const body = (ctx as any).requestBody || {};
        const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
        const requestedChannelId = typeof body.channelId === 'string' ? body.channelId.trim() : undefined;

        if (!rawUrl) {
            ctx.status = 400;
            ctx.body = { error: 'invalid_url', message: 'URL is required.' };
            return;
        }

        try {
            const { platform, externalId, canonicalUrl, accountHandle } = identifyPlatformAndExternalId(rawUrl);
            const channel = matchOwnedChannel(actor, platform, canonicalUrl, accountHandle, requestedChannelId);
            const meta = await resolveMetadata(canonicalUrl, platform, externalId);

            // Check if already imported using the partial index directly
            const existing = (meta.externalId
                ? stmtFindActiveByExternalId.get(channel.id, meta.externalId)
                : stmtFindActiveByUrl.get(channel.id, canonicalUrl)) as any;

            const alreadyImported = Boolean(existing && existing.deleted_at === null);

            const result: ResolvedPulsePreview = {
                channelId: channel.id,
                platform: channel.platform,
                externalId: meta.externalId,
                url: canonicalUrl,
                title: meta.title,
                thumbnailUrl: meta.thumbnailUrl,
                publishedAt: meta.publishedAt,
                category: channel.category,
                alreadyImported,
                existingItemId: existing?.id || null,
            };

            ctx.body = { success: true, preview: result };
        } catch (err: any) {
            if (err instanceof PulseError) {
                ctx.status = pulseErrorStatus(err.code);
                ctx.body = { error: err.code.toLowerCase(), message: err.message };
                return;
            }
            if (err instanceof SsrfSecurityError) {
                ctx.status = 400;
                ctx.body = { error: 'ssrf_blocked', message: err.message };
                return;
            }
            ctx.status = 500;
            ctx.body = { error: 'internal_error', message: err?.message || 'Failed to preview URL.' };
        }
    });

    /**
     * 2. POST /api/member/pulse/submit
     * Takes { url, channelId, title, thumbnailUrl, category }.
     * Verifies channel ownership (owner_pubkey = ctx.state.actor).
     * Normalizes URL and extracts external_id.
     * Deduplicates against existing pulse_items rows. Restores tombstoned rows if resubmitted.
     * Returns { success: true, item: PulseFeedCard, deduplicated: boolean }.
     */
    router.post('/api/member/pulse/submit', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }

        const body = (ctx as any).requestBody || {};
        const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
        const requestedChannelId = typeof body.channelId === 'string' ? body.channelId.trim() : undefined;
        const customTitle = typeof body.title === 'string' && body.title.trim()
            ? cleanXmlText(body.title.trim()).slice(0, 500)
            : undefined;

        let customThumbnailUrl: string | undefined;
        if (typeof body.thumbnailUrl === 'string' && body.thumbnailUrl.trim()) {
            const trimmedThumb = body.thumbnailUrl.trim();
            if (trimmedThumb.length <= 2048 && /^https?:\/\//i.test(trimmedThumb)) {
                customThumbnailUrl = trimmedThumb;
            } else {
                ctx.status = 400;
                ctx.body = { error: 'invalid_thumbnail_url', message: 'Thumbnail URL must be a valid HTTP or HTTPS URL under 2048 characters.' };
                return;
            }
        }

        const customCategory = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : undefined;

        if (!rawUrl) {
            ctx.status = 400;
            ctx.body = { error: 'invalid_url', message: 'URL is required.' };
            return;
        }

        if (customCategory && !CHANNEL_CATEGORIES.includes(customCategory as ChannelCategory)) {
            ctx.status = 400;
            ctx.body = { error: 'bad_category', message: 'Unknown category.' };
            return;
        }

        try {
            const { platform, externalId, canonicalUrl, accountHandle } = identifyPlatformAndExternalId(rawUrl);
            const channel = matchOwnedChannel(actor, platform, canonicalUrl, accountHandle, requestedChannelId);
            const meta = await resolveMetadata(canonicalUrl, platform, externalId);

            const finalTitle = customTitle || meta.title || 'Untitled Post';
            const finalThumbnailUrl = customThumbnailUrl || meta.thumbnailUrl || null;
            const finalCategory = (customCategory as ChannelCategory) || channel.category || 'other';
            const finalExternalId = meta.externalId || externalId;
            const now = new Date().toISOString();
            const finalPublishedAt = meta.publishedAt || now;

            let finalItemId: string;
            let isDeduplicated = false;

            db.transaction(() => {
                // Check if existing row exists (active or tombstoned)
                const existing = (finalExternalId
                    ? stmtFindExistingByExternalId.get(channel.id, finalExternalId)
                    : stmtFindExistingByUrl.get(channel.id, canonicalUrl)) as any;

                if (existing) {
                    finalItemId = existing.id;
                    if (existing.deleted_at !== null) {
                        // Restore tombstoned row
                        stmtRestoreItem.run(
                            canonicalUrl,
                            finalTitle,
                            finalThumbnailUrl,
                            meta.publishedAt,
                            now,
                            finalCategory,
                            now,
                            existing.id
                        );
                        isDeduplicated = false;
                    } else {
                        // Already active: update metadata if provided and mark as deduplicated
                        stmtUpdateActiveItem.run(
                            customTitle ?? null,
                            customThumbnailUrl ?? null,
                            finalCategory,
                            now,
                            existing.id
                        );
                        isDeduplicated = true;
                    }
                } else {
                    // Fresh insert
                    finalItemId = `item_${crypto.randomBytes(12).toString('hex')}`;
                    stmtInsertItem.run(
                        finalItemId,
                        channel.id,
                        actor,
                        channel.platform,
                        finalExternalId,
                        canonicalUrl,
                        finalTitle,
                        finalThumbnailUrl,
                        finalPublishedAt,
                        finalCategory,
                        now,
                        now
                    );
                    isDeduplicated = false;
                }
            })();

            const item = rowToPulseFeedCard(finalItemId!);
            ctx.body = { success: true, item, deduplicated: isDeduplicated };
        } catch (err: any) {
            if (err instanceof PulseError) {
                ctx.status = pulseErrorStatus(err.code);
                ctx.body = { error: err.code.toLowerCase(), message: err.message };
                return;
            }
            if (err instanceof SsrfSecurityError) {
                ctx.status = 400;
                ctx.body = { error: 'ssrf_blocked', message: err.message };
                return;
            }
            ctx.status = 500;
            ctx.body = { error: 'internal_error', message: err?.message || 'Failed to submit post.' };
        }
    });

    /**
     * 3. POST /api/member/pulse/channels/:id/dismiss-nudge
     * Owner-scoped. Updates post_count_seen on creator_channels to seenCount (or probed count).
     */
    router.post('/api/member/pulse/channels/:id/dismiss-nudge', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }

        const channelId = ctx.params.id;
        const channel = stmtGetChannelById.get(channelId) as any;

        if (!channel) {
            ctx.status = 404;
            ctx.body = { error: 'not_found', message: 'Channel not found.' };
            return;
        }

        if (channel.owner_pubkey !== actor) {
            ctx.status = 403;
            ctx.body = { error: 'not_yours', message: 'That is not your channel.' };
            return;
        }

        const body = (ctx as any).requestBody || {};
        let seenCount: number | null = null;
        if (typeof body.seenCount === 'number' && Number.isSafeInteger(body.seenCount) && body.seenCount >= 0) {
            seenCount = Math.max(channel.post_count_seen ?? 0, body.seenCount);
        }

        if (seenCount === null && channel.platform === 'instagram') {
            try {
                const probed = await probeInstagramPostCount(channel.url || channel.handle);
                if (probed !== null && Number.isSafeInteger(probed) && probed >= 0) {
                    seenCount = Math.max(channel.post_count_seen ?? 0, probed);
                }
            } catch {
                seenCount = channel.post_count_seen ?? 0;
            }
        }

        if (seenCount === null) {
            seenCount = channel.post_count_seen ?? 0;
        }

        const now = new Date().toISOString();
        stmtUpdateChannelWatermark.run(seenCount, now, channel.id, actor);

        ctx.body = { success: true, channelId: channel.id, postCountSeen: seenCount };
    });

    /**
     * 4. POST /api/member/pulse/items/:id/delete
     * Owner-scoped. Calls scrubPulseItems({ id: ctx.params.id, ownerPubkey: ctx.state.actor }).
     */
    router.post('/api/member/pulse/items/:id/delete', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }

        const itemId = ctx.params.id;
        const item = stmtGetItemById.get(itemId) as any;

        if (!item || item.deleted_at !== null) {
            ctx.status = 404;
            ctx.body = { error: 'not_found', message: 'Item not found.' };
            return;
        }

        if (item.owner_pubkey !== actor) {
            ctx.status = 403;
            ctx.body = { error: 'not_yours', message: 'That item belongs to another member.' };
            return;
        }

        const now = new Date().toISOString();
        scrubPulseItems({ id: itemId, ownerPubkey: actor }, now);

        ctx.body = { success: true };
    });

    /**
     * 5. POST /api/member/pulse/nudges
     * Owner-scoped. Lists member's channels where probed post count > post_count_seen.
     */
    router.post('/api/member/pulse/nudges', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }

        const channels = stmtGetMemberChannels.all(actor) as any[];

        // Probe channels concurrently rather than sequentially
        const probePromises = channels.map(async (ch) => {
            let currentCount: number | null = null;
            if (ch.platform === 'instagram') {
                try {
                    currentCount = await probeInstagramPostCount(ch.url || ch.handle);
                } catch {
                    currentCount = null;
                }
            }
            return { ch, currentCount };
        });

        const probedChannels = await Promise.all(probePromises);

        const nudges: Array<{
            channelId: string;
            platform: string;
            handle: string | null;
            url: string | null;
            currentCount: number;
            postCountSeen: number;
            newPostsCount: number;
        }> = [];

        for (const { ch, currentCount } of probedChannels) {
            if (currentCount !== null && currentCount >= 0) {
                if (ch.post_count_seen !== null && currentCount > ch.post_count_seen) {
                    nudges.push({
                        channelId: ch.id,
                        platform: ch.platform,
                        handle: ch.handle,
                        url: ch.url,
                        currentCount,
                        postCountSeen: ch.post_count_seen,
                        newPostsCount: currentCount - ch.post_count_seen,
                    });
                } else if (ch.post_count_seen === null) {
                    // Initialize watermark to current count so future increments trigger nudges
                    const now = new Date().toISOString();
                    stmtUpdateChannelWatermark.run(currentCount, now, ch.id, actor);
                }
            }
        }

        ctx.body = { nudges };
    });

    /**
     * 6. GET /api/pulse/oauth/config
     * Public read. Returns platform OAuth availability and client identifiers.
     */
    router.get('/api/pulse/oauth/config', async (ctx) => {
        ctx.body = getPulseOAuthConfig();
    });

    /**
     * 7. POST /api/member/pulse/oauth-ingest
     * Takes { channelId, items: Array<{ url, title, thumbnailUrl, publishedAt, externalId, category }> }.
     * Verifies channel ownership (owner_pubkey = ctx.state.actor).
     * Ingests items as OAuth-sourced, deduplicating against existing pulse_items rows.
     */
    router.post('/api/member/pulse/oauth-ingest', async (ctx) => {
        const actor = ctx.state.actor;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Signed request required' };
            return;
        }

        const body = (ctx as any).requestBody || {};
        const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
        const rawItems = Array.isArray(body.items) ? body.items : [];

        if (!channelId) {
            ctx.status = 400;
            ctx.body = { error: 'missing_field', message: 'channelId is required.' };
            return;
        }

        const channel = stmtGetChannelById.get(channelId) as any;
        if (!channel) {
            ctx.status = 404;
            ctx.body = { error: 'not_found', message: 'Channel not found.' };
            return;
        }

        if (channel.owner_pubkey !== actor) {
            ctx.status = 403;
            ctx.body = { error: 'not_yours', message: 'That is not your channel.' };
            return;
        }

        const now = new Date().toISOString();
        const results: PulseFeedCard[] = [];
        let deduplicatedCount = 0;

        try {
            db.transaction(() => {
                for (const rawItem of rawItems) {
                    if (!rawItem || typeof rawItem !== 'object') continue;
                    const itemUrl = typeof rawItem.url === 'string' ? rawItem.url.trim() : '';
                    if (!itemUrl || !/^https?:\/\//i.test(itemUrl)) continue;

                    let externalId: string | null = typeof rawItem.externalId === 'string' && rawItem.externalId.trim()
                        ? rawItem.externalId.trim()
                        : null;
                    let canonicalUrl = itemUrl;

                    try {
                        const identified = identifyPlatformAndExternalId(itemUrl);
                        if (!externalId) externalId = identified.externalId;
                        canonicalUrl = identified.canonicalUrl;
                    } catch {
                        // Fall back to provided url
                    }

                    const title = typeof rawItem.title === 'string' && rawItem.title.trim()
                        ? cleanXmlText(rawItem.title.trim()).slice(0, 500)
                        : (channel.platform === 'tiktok' ? 'TikTok Video' : 'Post');

                    let thumbnailUrl: string | null = null;
                    if (typeof rawItem.thumbnailUrl === 'string' && rawItem.thumbnailUrl.trim()) {
                        const trimmedThumb = rawItem.thumbnailUrl.trim();
                        if (trimmedThumb.length <= 4096 && /^https?:\/\//i.test(trimmedThumb)) {
                            thumbnailUrl = trimmedThumb;
                        } else {
                            // Refuse item if thumbnail URL is invalid/unsafe (e.g. non-http(s) scheme or too long)
                            continue;
                        }
                    }

                    const itemCategory = typeof rawItem.category === 'string' && CHANNEL_CATEGORIES.includes(rawItem.category as ChannelCategory)
                        ? (rawItem.category as ChannelCategory)
                        : (channel.category || 'other');

                    const publishedAt = typeof rawItem.publishedAt === 'string' && rawItem.publishedAt.trim()
                        ? parseFeedDate(rawItem.publishedAt.trim()) || now
                        : now;

                    let finalItemId: string;

                    const existing = (externalId
                        ? stmtFindExistingByExternalId.get(channel.id, externalId)
                        : stmtFindExistingByUrl.get(channel.id, canonicalUrl)) as any;

                    if (existing) {
                        finalItemId = existing.id;
                        if (existing.deleted_at !== null) {
                            // Restore tombstoned row
                            stmtRestoreOauthItem.run(
                                canonicalUrl,
                                title,
                                thumbnailUrl,
                                publishedAt,
                                now,
                                itemCategory,
                                now,
                                existing.id
                            );
                        } else {
                            // Update active item
                            stmtUpdateActiveItem.run(
                                title,
                                thumbnailUrl,
                                itemCategory,
                                now,
                                existing.id
                            );
                            deduplicatedCount++;
                        }
                    } else {
                        finalItemId = `item_${crypto.randomBytes(12).toString('hex')}`;
                        stmtInsertOauthItem.run(
                            finalItemId,
                            channel.id,
                            actor,
                            channel.platform,
                            externalId,
                            canonicalUrl,
                            title,
                            thumbnailUrl,
                            publishedAt,
                            itemCategory,
                            now,
                            now
                        );
                    }

                    try {
                        results.push(rowToPulseFeedCard(finalItemId));
                    } catch { }
                }

                // Advance watermark if channel has post_count_seen
                if (channel.post_count_seen !== null && rawItems.length > channel.post_count_seen) {
                    stmtUpdateChannelWatermark.run(rawItems.length, now, channel.id, actor);
                }
            })();

            ctx.body = {
                success: true,
                count: results.length,
                deduplicatedCount,
                items: results,
            };
        } catch (err: any) {
            ctx.status = 500;
            ctx.body = { error: 'internal_error', message: err?.message || 'Failed to ingest OAuth items.' };
        }
    });

    return router;
}
