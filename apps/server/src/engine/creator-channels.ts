// Creator channels — a member's own external publishing accounts (The Pulse, Phase 1).
//
// Phase 1 stores and returns them; nothing fetches anything yet. What lands here decides what the
// resolver can do later, so two properties are fixed now rather than retrofitted:
//
// ## 1. A channel belongs to exactly one member, and only they can touch it
//
// Every mutation takes the owner from `ctx.state.actor` — the key that signed the request — and
// every write is scoped by it. This is not defence in depth, it is the whole defence: without it
// anyone could attach `@mullum_ceramics` to their own profile, and the feed would show cards
// attributed to a real neighbour who never consented, with Message and Trade buttons pointing at
// the wrong person. In a town where everyone knows each other that is not a bug report.
//
// A typed handle is still only a *claim*. Nothing here proves the member owns it — Instagram
// serves no readable bio to a plain HTTP client, so the bio-code trick is not available, and OAuth
// (`oauth_verified_at`) is the only real proof. Claims are visible on the member's public profile
// and reportable, which is how the rest of this network's trust model works.
//
// ## 2. Deleting a link must not preserve the link
//
// `deleteChannel` NULLs `url` and `handle` as it sets `deleted_at`. A conventional soft delete
// would keep the URL in the row, in every backup and on the mirror, forever — and someone removing
// their Instagram link is usually doing it precisely so it stops being anywhere.

import { db } from '../db/db.js';
import crypto from 'node:crypto';

export type ChannelPlatform = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'website' | 'rss';
export type ChannelCategory = 'food' | 'craft' | 'business' | 'repair' | 'art' | 'other';

export const CHANNEL_PLATFORMS: readonly ChannelPlatform[] =
    ['youtube', 'tiktok', 'instagram', 'facebook', 'website', 'rss'] as const;
export const CHANNEL_CATEGORIES: readonly ChannelCategory[] =
    ['food', 'craft', 'business', 'repair', 'art', 'other'] as const;

/**
 * Platforms whose items the node can list unaided.
 *
 * YouTube publishes a channel RSS feed and blogs publish RSS/Atom, so those enumerate freely and
 * forever. Instagram's post list is built client-side by ~772KB of JavaScript and TikTok's profile
 * pages are bot-challenged, so neither can be listed by a plain fetch from anywhere — the node,
 * or a phone. Those arrive one item at a time until a member connects OAuth, which flips
 * `supports_autolist` on the row rather than changing this map.
 */
const AUTOLIST_PLATFORMS: ReadonlySet<ChannelPlatform> = new Set<ChannelPlatform>(['youtube', 'rss']);

/** Platforms that carry video, and so can collide when a creator cross-posts. */
const VIDEO_PLATFORMS: ReadonlySet<ChannelPlatform> = new Set<ChannelPlatform>(['youtube', 'tiktok', 'instagram', 'facebook']);

const MAX_URL_LENGTH = 500;
const MAX_HANDLE_LENGTH = 100;
/** Generous enough for anyone real; low enough that nobody can bloat the members table. */
const MAX_CHANNELS_PER_MEMBER = 12;

export interface CreatorChannel {
    id: string;
    ownerPubkey: string;
    platform: ChannelPlatform;
    url: string | null;
    handle: string | null;
    category: ChannelCategory;
    isPrimaryVideo: boolean;
    supportsAutolist: boolean;
    oauthVerifiedAt: string | null;
    postCountSeen: number | null;
    autopublish: boolean;
    syndicateToNode: boolean;
    createdAt: string;
    updatedAt: string;
}

export class ChannelError extends Error {
    constructor(public code: string, message: string) {
        super(message);
        this.name = 'ChannelError';
    }
}

function rowToChannel(row: any): CreatorChannel {
    return {
        id: row.id,
        ownerPubkey: row.owner_pubkey,
        platform: row.platform,
        url: row.url,
        handle: row.handle,
        category: row.category,
        isPrimaryVideo: row.is_primary_video === 1,
        supportsAutolist: row.supports_autolist === 1,
        oauthVerifiedAt: row.oauth_verified_at || null,
        postCountSeen: row.post_count_seen ?? null,
        autopublish: row.autopublish === 1,
        syndicateToNode: row.syndicate_to_node === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Per-platform host allowlist. A URL claiming to be Instagram must actually be Instagram. */
const PLATFORM_HOSTS: Record<Exclude<ChannelPlatform, 'website' | 'rss'>, string[]> = {
    youtube: ['youtube.com', 'youtu.be', 'm.youtube.com'],
    tiktok: ['tiktok.com', 'vm.tiktok.com'],
    instagram: ['instagram.com', 'instagr.am'],
    facebook: ['facebook.com', 'fb.com', 'fb.me', 'm.facebook.com'],
};

/**
 * The single host each platform's URLs are rewritten to.
 *
 * Without this, `instagram.com/x` and `www.instagram.com/x` are two different strings, so the same
 * channel added twice passes the duplicate check and the member appears twice on their own feed.
 * Canonicalising the host is what makes the URL usable as an identity.
 */
const CANONICAL_HOST: Record<Exclude<ChannelPlatform, 'website' | 'rss'>, string> = {
    youtube: 'www.youtube.com',
    tiktok: 'www.tiktok.com',
    instagram: 'www.instagram.com',
    facebook: 'www.facebook.com',
};

function hostMatches(host: string, allowed: string[]): boolean {
    const h = host.toLowerCase().replace(/^www\./, '');
    return allowed.some(a => h === a || h.endsWith('.' + a));
}

/**
 * Normalise whatever the member pasted into a canonical URL and a display handle.
 *
 * People paste all of `@nicholasisbarefoot`, `instagram.com/nicholasisbarefoot`, and the full
 * share-sheet URL with an `?igsh=` tracking tail. Left as typed, the same channel added twice
 * looks like two channels, and the cross-post de-duplication in §6 has nothing stable to match on.
 *
 * Throws ChannelError rather than returning null so the caller cannot forget to check.
 */
export function normaliseChannelInput(platform: ChannelPlatform, raw: string): { url: string; handle: string | null } {
    const input = (raw || '').trim();
    if (!input) throw new ChannelError('EMPTY', 'Paste a link or handle.');
    if (input.length > MAX_URL_LENGTH) throw new ChannelError('TOO_LONG', 'That link is too long.');

    // A bare @handle only makes sense for the platforms that have handles.
    const bareHandle = input.match(/^@?([A-Za-z0-9._-]{1,100})$/);
    if (bareHandle && platform !== 'website' && platform !== 'rss') {
        const h = bareHandle[1];
        switch (platform) {
            case 'instagram': return { url: `https://www.instagram.com/${h}/`, handle: `@${h}` };
            case 'tiktok': return { url: `https://www.tiktok.com/@${h}`, handle: `@${h}` };
            case 'youtube': return { url: `https://www.youtube.com/@${h}`, handle: `@${h}` };
            case 'facebook': return { url: `https://www.facebook.com/${h}`, handle: h };
        }
    }

    // Check the scheme on the RAW input. Prefixing first would turn `javascript:alert(1)` into
    // `https://javascript:alert(1)`, which fails to parse and reports the wrong reason — and these
    // strings end up as tappable links, so the reason matters.
    const explicitScheme = input.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (explicitScheme && !/^https?$/i.test(explicitScheme[1])) {
        throw new ChannelError('BAD_SCHEME', 'Links must start with https://');
    }

    let parsed: URL;
    try {
        parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
        throw new ChannelError('BAD_URL', 'That does not look like a link.');
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new ChannelError('BAD_SCHEME', 'Links must start with https://');
    }
    if (platform !== 'website' && platform !== 'rss') {
        const allowed = PLATFORM_HOSTS[platform];
        if (!hostMatches(parsed.hostname, allowed)) {
            throw new ChannelError('WRONG_HOST', `That is not a ${platform} link.`);
        }
        parsed.hostname = CANONICAL_HOST[platform];
    } else {
        parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    }

    // Tracking parameters differ per share and would defeat de-duplication.
    parsed.search = '';
    parsed.hash = '';
    parsed.protocol = 'https:';

    const segments = parsed.pathname.split('/').filter(Boolean);
    let handle: string | null = null;
    if (platform === 'instagram' && segments.length >= 1 && !['p', 'reel', 'reels', 'tv'].includes(segments[0])) {
        handle = `@${segments[0]}`;
        parsed.pathname = `/${segments[0]}/`;
    } else if (platform === 'tiktok' && segments[0]?.startsWith('@')) {
        handle = segments[0];
        parsed.pathname = `/${segments[0]}`;
    } else if (platform === 'youtube' && segments[0]?.startsWith('@')) {
        handle = segments[0];
        parsed.pathname = `/${segments[0]}`;
    } else if (platform === 'facebook' && segments.length >= 1) {
        handle = segments[0];
    } else if (platform === 'website' || platform === 'rss') {
        handle = parsed.hostname.replace(/^www\./, '');
    }

    const url = parsed.toString();
    if (url.length > MAX_URL_LENGTH) throw new ChannelError('TOO_LONG', 'That link is too long.');
    if (handle && handle.length > MAX_HANDLE_LENGTH) handle = handle.slice(0, MAX_HANDLE_LENGTH);
    return { url, handle };
}

export function listChannels(ownerPubkey: string): CreatorChannel[] {
    const rows = db.prepare(
        `SELECT * FROM creator_channels WHERE owner_pubkey = ? AND deleted_at IS NULL ORDER BY created_at ASC`
    ).all(ownerPubkey) as any[];
    return rows.map(rowToChannel);
}

/**
 * The channels shown on a member's public profile — the subset they chose to syndicate.
 *
 * Separate from `listChannels` so the owner's own management view can show a channel they have
 * switched off without that switch meaning nothing.
 */
export function listPublicChannels(ownerPubkey: string): CreatorChannel[] {
    const rows = db.prepare(
        `SELECT * FROM creator_channels
          WHERE owner_pubkey = ? AND deleted_at IS NULL AND syndicate_to_node = 1
          ORDER BY created_at ASC`
    ).all(ownerPubkey) as any[];
    return rows.map(rowToChannel);
}

export function getChannel(id: string): CreatorChannel | null {
    const row = db.prepare(`SELECT * FROM creator_channels WHERE id = ? AND deleted_at IS NULL`).get(id) as any;
    return row ? rowToChannel(row) : null;
}

/**
 * Does this member already have a video channel other than the one given?
 *
 * Drives the cross-post warning: a creator posting the same reel to YouTube and Instagram would
 * otherwise appear twice on the feed. The client asks before saving so it can offer the choice
 * rather than reporting a problem afterwards.
 */
export function otherVideoChannels(ownerPubkey: string, exceptId?: string): CreatorChannel[] {
    return listChannels(ownerPubkey).filter(c => VIDEO_PLATFORMS.has(c.platform) && c.id !== exceptId);
}

export function addChannel(input: {
    ownerPubkey: string;
    platform: string;
    raw: string;
    category: string;
    syndicateToNode?: boolean;
    isPrimaryVideo?: boolean;
}): CreatorChannel {
    const platform = input.platform as ChannelPlatform;
    const category = input.category as ChannelCategory;
    if (!CHANNEL_PLATFORMS.includes(platform)) throw new ChannelError('BAD_PLATFORM', 'Unknown platform.');
    if (!CHANNEL_CATEGORIES.includes(category)) throw new ChannelError('BAD_CATEGORY', 'Unknown category.');

    const member = db.prepare(`SELECT public_key FROM members WHERE public_key = ?`).get(input.ownerPubkey);
    if (!member) throw new ChannelError('NO_MEMBER', 'Member not found.');

    const existing = listChannels(input.ownerPubkey);
    if (existing.length >= MAX_CHANNELS_PER_MEMBER) {
        throw new ChannelError('TOO_MANY', `You can have up to ${MAX_CHANNELS_PER_MEMBER} channels.`);
    }

    const { url, handle } = normaliseChannelInput(platform, input.raw);

    // Normalisation is what makes this check work — the same channel pasted as a handle and as a
    // share-sheet URL with tracking params must collide, or a member ends up double-posting to
    // their own feed.
    if (existing.some(c => c.url === url)) {
        throw new ChannelError('DUPLICATE', 'You have already added that channel.');
    }

    const id = `chan_${crypto.randomBytes(12).toString('hex')}`;
    const now = new Date().toISOString();
    const supportsAutolist = AUTOLIST_PLATFORMS.has(platform) ? 1 : 0;

    // The first video channel is the primary by default. Being explicit beats leaving every
    // channel unmarked and having the feed pick arbitrarily.
    const isPrimary = input.isPrimaryVideo !== undefined
        ? (input.isPrimaryVideo ? 1 : 0)
        : (VIDEO_PLATFORMS.has(platform) && otherVideoChannels(input.ownerPubkey).length === 0 ? 1 : 0);

    db.transaction(() => {
        if (isPrimary === 1 && VIDEO_PLATFORMS.has(platform)) {
            db.prepare(
                `UPDATE creator_channels SET is_primary_video = 0, updated_at = ?
                  WHERE owner_pubkey = ? AND deleted_at IS NULL AND is_primary_video = 1`
            ).run(now, input.ownerPubkey);
        }
        db.prepare(
            `INSERT INTO creator_channels
                (id, owner_pubkey, platform, url, handle, category, is_primary_video,
                 supports_autolist, syndicate_to_node, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, input.ownerPubkey, platform, url, handle, category, isPrimary,
              supportsAutolist, input.syndicateToNode === false ? 0 : 1, now, now);
    })();

    return getChannel(id)!;
}

/**
 * Update the fields a member is allowed to change.
 *
 * Deliberately cannot set `oauth_verified_at`, `supports_autolist` or `post_count_seen` — those
 * are node-established facts, and a client that can assert them can assert a verified tick it
 * never earned.
 */
export function updateChannel(
    ownerPubkey: string,
    id: string,
    patch: { category?: string; syndicateToNode?: boolean; isPrimaryVideo?: boolean; autopublish?: boolean }
): CreatorChannel {
    const row = db.prepare(
        `SELECT * FROM creator_channels WHERE id = ? AND deleted_at IS NULL`
    ).get(id) as any;
    if (!row) throw new ChannelError('NOT_FOUND', 'Channel not found.');
    if (row.owner_pubkey !== ownerPubkey) throw new ChannelError('NOT_YOURS', 'That is not your channel.');

    if (patch.category !== undefined && !CHANNEL_CATEGORIES.includes(patch.category as ChannelCategory)) {
        throw new ChannelError('BAD_CATEGORY', 'Unknown category.');
    }

    const now = new Date().toISOString();
    db.transaction(() => {
        if (patch.isPrimaryVideo === true) {
            db.prepare(
                `UPDATE creator_channels SET is_primary_video = 0, updated_at = ?
                  WHERE owner_pubkey = ? AND deleted_at IS NULL AND id != ?`
            ).run(now, ownerPubkey, id);
        }
        db.prepare(
            `UPDATE creator_channels SET
                category          = COALESCE(?, category),
                syndicate_to_node = COALESCE(?, syndicate_to_node),
                is_primary_video  = COALESCE(?, is_primary_video),
                autopublish       = COALESCE(?, autopublish),
                updated_at        = ?
              WHERE id = ? AND owner_pubkey = ?`
        ).run(
            patch.category ?? null,
            patch.syndicateToNode === undefined ? null : (patch.syndicateToNode ? 1 : 0),
            patch.isPrimaryVideo === undefined ? null : (patch.isPrimaryVideo ? 1 : 0),
            patch.autopublish === undefined ? null : (patch.autopublish ? 1 : 0),
            now, id, ownerPubkey
        );
    })();

    return getChannel(id)!;
}

/**
 * Delete a channel, keeping the tombstone and discarding the link.
 *
 * `url` and `handle` go to NULL in the same statement that sets `deleted_at`. The row has to
 * survive so the deletion replicates — a backup that never hears about it would restore the
 * channel — but nothing about *what* was deleted needs to survive with it.
 */
export function deleteChannel(ownerPubkey: string, id: string): boolean {
    const row = db.prepare(`SELECT owner_pubkey FROM creator_channels WHERE id = ?`).get(id) as any;
    if (!row) return false;
    if (row.owner_pubkey !== ownerPubkey) throw new ChannelError('NOT_YOURS', 'That is not your channel.');

    const now = new Date().toISOString();
    const res = db.prepare(
        `UPDATE creator_channels
            SET deleted_at = ?, url = NULL, handle = NULL, is_primary_video = 0, updated_at = ?
          WHERE id = ? AND owner_pubkey = ? AND deleted_at IS NULL`
    ).run(now, now, id, ownerPubkey);
    return res.changes > 0;
}

/** Repoint every channel of a member at a new key — used by the identity-migration path. */
export function reassignChannels(oldPubkey: string, newPubkey: string): void {
    db.prepare(`UPDATE creator_channels SET owner_pubkey = ?, updated_at = ? WHERE owner_pubkey = ?`)
        .run(newPubkey, new Date().toISOString(), oldPubkey);
}
