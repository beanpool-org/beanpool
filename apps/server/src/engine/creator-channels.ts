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
import { scrubPulseItems } from './pulse-resolver.js';

export type ChannelPlatform = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'website' | 'rss';
export type ChannelCategory = 'community' | 'food' | 'craft' | 'business' | 'repair' | 'art' | 'other';

export const CHANNEL_PLATFORMS: readonly ChannelPlatform[] =
    ['youtube', 'tiktok', 'instagram', 'facebook', 'website', 'rss'] as const;
// A channel is CONTENT, not produce. These started as the marketplace taxonomy — what a member
// sells — which left a community org, a project account or a news feed with nowhere to go but
// 'other'. `community` is additive: every other id keeps its meaning and its stored rows, only the
// labels the client renders were rewritten.
export const CHANNEL_CATEGORIES: readonly ChannelCategory[] =
    ['community', 'food', 'craft', 'business', 'repair', 'art', 'other'] as const;

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

/**
 * Whether this specific URL can be listed, not just its platform.
 *
 * A `youtu.be/<videoid>` is one video, not a channel — there is no feed behind it, so promising
 * "Updates itself" in the UI would be a lie the member only discovers when nothing ever appears.
 * Platform alone was too coarse for exactly that case.
 */
function canAutolist(platform: ChannelPlatform, url: string): boolean {
    if (!AUTOLIST_PLATFORMS.has(platform)) return false;
    if (platform === 'youtube') {
        // Only the channel-shaped forms have an RSS feed behind them.
        return /\/(channel|c|user)\/|\/@|\/feeds\/videos\.xml/.test(url);
    }
    // A site root pasted under "Blog / RSS" is a website, not a feed. Phase 2's resolver can run
    // feed autodiscovery and flip this on once it has actually found one; until then, promising
    // "Updates itself" is a promise nothing here can keep.
    //
    // Matched against the path and query ONLY. Against the whole URL, a blog homepage on
    // `rss.mycoop.org` or `feed.example.com` matches its own hostname and gets the promise anyway.
    let pathAndQuery: string;
    try {
        const u = new URL(url);
        pathAndQuery = u.pathname + u.search;
    } catch {
        return false;
    }
    return /(\/feed\b|\/rss\b|\/atom\b|\.xml(\?|$)|\.rss(\?|$)|\/feeds?\/)/i.test(pathAndQuery);
}

/** Platforms that carry video, and so can collide when a creator cross-posts. */
const VIDEO_PLATFORMS: ReadonlySet<ChannelPlatform> = new Set<ChannelPlatform>(['youtube', 'tiktok', 'instagram', 'facebook']);

const MAX_URL_LENGTH = 500;
const MAX_HANDLE_LENGTH = 100;
/** Generous enough for anyone real; low enough that nobody can bloat the members table. */
const MAX_CHANNELS_PER_MEMBER = 12;
/**
 * Rows created per member within CHURN_WINDOW_MS — a runaway guard, not a working limit.
 *
 * Tombstones are permanent (removing one un-deletes the channel on any replica that missed it, see
 * `addChannel`), so a lifetime count would brick an account that ever reached it. Reaching this
 * takes 60 deliberate add/delete cycles in a month, through signed and rate-limited requests, on
 * rows scrubbed down to three meaningful columns.
 */
const MAX_ROWS_PER_WINDOW = 60;
const CHURN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * A patch field must be a real boolean.
 *
 * The guards read `patch.x === true`, but the writes read `patch.x ? 1 : 0` — so a JSON `1` would
 * skip the NOT_VIDEO check and the demote-others step while still setting the flag, leaving two
 * rows marked primary. Rejecting the wrong type is safer than making the two ends agree, because
 * the next field added would have to remember the same trick.
 */
function asBool(value: unknown, field: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
        throw new ChannelError('BAD_FIELD', `${field} must be true or false.`);
    }
    return value;
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

/**
 * Short-link hosts, which must be left exactly as they are.
 *
 * These are what the share sheets actually copy, and their paths are opaque IDs that only resolve
 * on the short domain — rewriting `youtu.be/abc` to `www.youtube.com/abc` produces a 404, and the
 * member has no way to tell why the link they pasted stopped working.
 */
const SHORT_LINK_HOSTS: ReadonlySet<string> = new Set(['youtu.be', 'vm.tiktok.com', 'fb.me']);

/** Tracking parameters that differ per share and would defeat de-duplication. */
// Deliberately excludes `si`: it is a YouTube share parameter, and platform query strings are
// dropped wholesale anyway — so the only URLs this pattern could ever touch are website/rss ones,
// where the query string IS the feed's identity.
const TRACKING_PARAMS = [/^utm_/i, /^fbclid$/i, /^igsh(id)?$/i, /^gclid$/i, /^mc_[ce]id$/i];

/**
 * Reject anything that resolves inside the node's own network.
 *
 * A member-supplied `website`/`rss` URL is stored on a publicly-readable profile row and, from
 * Phase 2, is fetched by the node's resolver. A stored `http://169.254.169.254/latest/meta-data/`
 * would make that resolver read cloud metadata on the Binary Lane VMs, and `http://localhost:…`
 * would point it at the node's own admin surface.
 *
 * This is input validation, not the fetch-time guard — the resolver must still resolve DNS and
 * re-check the address, because a public hostname can point anywhere. Rejecting the obvious cases
 * here means they never reach the database in the first place.
 */
function assertPublicHostname(hostname: string): void {
    // `localhost.` and `foo.internal.` are valid absolute forms that resolve identically and
    // matched none of the comparisons below.
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host.endsWith('.internal') || host.endsWith('.home.arpa')) {
        throw new ChannelError('PRIVATE_HOST', 'That address is not reachable from the internet.');
    }
    // IPv6 loopback, link-local (fe80::/10) and unique-local (fc00::/7).
    if (host === '::1' || host === '::' || /^fe[89ab][0-9a-f]:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) {
        throw new ChannelError('PRIVATE_HOST', 'That address is not reachable from the internet.');
    }
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        if (a === 0 || a === 10 || a === 127 ||
            (a === 169 && b === 254) ||               // link-local, incl. cloud metadata
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) ||     // carrier-grade NAT
            a >= 224) {                                // multicast and reserved
            throw new ChannelError('PRIVATE_HOST', 'That address is not reachable from the internet.');
        }
        return;
    }
    // A hostname with no dot is a bare machine name on the local network, not a website.
    if (!host.includes('.')) {
        throw new ChannelError('BAD_URL', 'That does not look like a website address.');
    }
}

/**
 * Facebook path prefixes and how many segments below them carry the identity.
 *
 * `/groups/<id>` is one; `/people/<name>/<id>` and `/share/p/<id>` are two — truncating those to
 * one stores `facebook.com/share/p`, a dead link that also collides with every other share URL.
 */
const FB_PREFIX_DEPTH: ReadonlyMap<string, number> = new Map([
    ['groups', 1], ['g', 1], ['pages', 2], ['people', 2], ['share', 2], ['profile', 1],
]);

/**
 * How a platform is named to a member, and the article that precedes it.
 *
 * The enum values are lowercase ids; interpolating them raw produced "That is not a instagram
 * link." — wrong article and a brand name in lowercase, in a string members actually read.
 */
const PLATFORM_DISPLAY: Record<ChannelPlatform, string> = {
    youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram',
    facebook: 'Facebook', website: 'website', rss: 'feed',
};
const PLATFORM_ARTICLE: Record<ChannelPlatform, string> = {
    youtube: 'a', tiktok: 'a', instagram: 'an', facebook: 'a', website: 'a', rss: 'a',
};

/**
 * Instagram paths that are site furniture, not accounts.
 *
 * Shared by the URL branch and the bare-handle fast path below, which used to disagree — and the
 * fast path was the one skipping the check, so `@p` was stored as `instagram.com/p/`: a permanently
 * dead link that every member typing `@p` then collided with as a duplicate.
 */
const IG_RESERVED_SEGMENTS: ReadonlySet<string> =
    new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct']);

/**
 * Reject a bare handle that names a reserved path rather than an account.
 *
 * Only Instagram and Facebook can collide: TikTok and YouTube handles are stored under `/@...`, a
 * namespace of their own that no reserved segment reaches.
 */
function assertHandleNotReserved(platform: ChannelPlatform, handle: string): void {
    const reserved = platform === 'instagram'
        ? IG_RESERVED_SEGMENTS.has(handle)
        : platform === 'facebook'
            ? (FB_PREFIX_DEPTH.has(handle) || handle === 'profile.php')
            : false;
    if (reserved) {
        throw new ChannelError('NO_HANDLE',
            `"${handle}" is a reserved ${PLATFORM_DISPLAY[platform]} address, not an account name.`);
    }
}

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
    // ALL whitespace goes, not just the ends. Android's gesture typing and suggestion strip insert
    // spaces mid-string even with autoCorrect off — a member typing their own domain got
    // "bean pool.org", which fails to parse and reports BAD_URL for a link they typed correctly.
    // Whitespace is never valid inside a URL or a handle, so there is nothing to preserve.
    const input = (raw || '').replace(/\s+/g, '');
    if (!input) throw new ChannelError('EMPTY', 'Paste a link or handle.');
    if (input.length > MAX_URL_LENGTH) throw new ChannelError('TOO_LONG', 'That link is too long.');

    // A bare @handle only makes sense for the platforms that have handles.
    //
    // Handles may contain dots (`@my.ceramics` is a valid Instagram handle), so a dot alone cannot
    // disqualify one. What does: a dotted string with NO leading `@` is a domain someone typed —
    // otherwise `instagram.com` silently becomes `instagram.com/instagram.com/`.
    // At least one alphanumeric, or `@..` interpolates straight into `instagram.com/../` — the
    // fast path returns a built string without ever round-tripping through `new URL`.
    const bareHandle = input.match(/^@?((?=[A-Za-z0-9._-]{1,100}$)[A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*)$/);
    const looksLikeDomain = !input.startsWith('@') && input.includes('.');
    if (bareHandle && !looksLikeDomain && platform !== 'website' && platform !== 'rss') {
        // Handles are case-insensitive on all four platforms, so `@Mullum_Ceramics` and
        // `@mullum_ceramics` must produce one URL — otherwise the duplicate check misses and the
        // member appears twice on their own feed.
        // `UCabc…` is a channel ID, not a handle — folding it into `/@ucabc…` produced a 404, and
        // channel IDs are case-sensitive so it could not be recovered afterwards.
        if (platform === 'youtube' && /^UC[A-Za-z0-9_-]{20,24}$/.test(bareHandle[1])) {
            return { url: `https://www.youtube.com/channel/${bareHandle[1]}`, handle: bareHandle[1] };
        }
        const h = bareHandle[1].toLowerCase();
        // The URL branch rejects these below; the fast path returns a built string without ever
        // round-tripping through it, so the same check has to run here or it does not run at all.
        assertHandleNotReserved(platform, h);
        // Built, then checked, then returned — rather than returned straight out of the switch.
        // Every guard at the end of this function is one the fast path skips, and the handle-length
        // bound was one of them: `@` + 100 characters is 101, and it was reaching the column
        // unchecked because the `return` came first.
        const built = (() => {
            switch (platform) {
                case 'instagram': return { url: `https://www.instagram.com/${h}/`, handle: `@${h}` };
                case 'tiktok': return { url: `https://www.tiktok.com/@${h}`, handle: `@${h}` };
                case 'youtube': return { url: `https://www.youtube.com/@${h}`, handle: `@${h}` };
                case 'facebook': return { url: `https://www.facebook.com/${h}`, handle: h };
            }
        })();
        if (built) {
            if (built.handle.length > MAX_HANDLE_LENGTH) {
                throw new ChannelError('TOO_LONG', 'That account name is too long.');
            }
            return built;
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
    // `https://user:pass@example.com/feed` would otherwise be stored verbatim on a publicly
    // readable row, mirrored and backed up, while the chip shows only the hostname.
    if (parsed.username || parsed.password) {
        throw new ChannelError('HAS_CREDENTIALS', 'Please paste a link without a username or password in it.');
    }
    if (platform !== 'website' && platform !== 'rss') {
        const allowed = PLATFORM_HOSTS[platform];
        if (!hostMatches(parsed.hostname, allowed)) {
            // `my.ceramics` parses as a hostname, so the bare-handle branch declined it and we land
            // here. Say what actually fixes it rather than "that is not an instagram link".
            const looksLikeHandle = /^[A-Za-z0-9._-]+$/.test(input) && !/^https?:/i.test(input);
            throw new ChannelError('WRONG_HOST', looksLikeHandle
                ? `If that is your ${PLATFORM_DISPLAY[platform]} handle, put an @ in front of it.`
                : `That is not ${PLATFORM_ARTICLE[platform]} ${PLATFORM_DISPLAY[platform]} link.`);
        }
        if (!SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase().replace(/^www\./, ''))) {
            parsed.hostname = CANONICAL_HOST[platform];
            // The port has to go with the host. `instagram.com:8443/foo/` rewritten to
            // `www.instagram.com:8443/foo/` is a dead link that also slips past the duplicate check.
            parsed.port = '';
        } else {
            // Short links are matched with `www.` stripped, so they must be STORED that way too —
            // otherwise `www.youtu.be/x` and `youtu.be/x` are two strings for one link.
            parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
            parsed.port = '';
        }
    } else {
        assertPublicHostname(parsed.hostname);
        // Lowercased but NOT de-www'd: plenty of sites serve only on the www host, and rewriting
        // a member's own address into one that 404s is worse than a redundant prefix.
        parsed.hostname = parsed.hostname.toLowerCase();
    }

    // Tracking parameters differ per share and would defeat de-duplication — but
    // `facebook.com/profile.php?id=100064…` carries its identity IN the query string, and is the
    // only addressable form for a page with no vanity URL. Keep that one parameter, drop the rest.
    const fbProfileId = (platform === 'facebook' && /^\/profile\.php\/?$/i.test(parsed.pathname))
        ? parsed.searchParams.get('id')
        : null;
    if (platform === 'website' || platform === 'rss') {
        // A feed URL's identity often lives in the query string —
        // `youtube.com/feeds/videos.xml?channel_id=UC…` is the autolist path itself, and
        // `?feed=rss2` vs `?feed=atom` are different feeds on the same blog. Dropping it would
        // store the homepage as the feed and make two distinct feeds collide as duplicates.
        // Only the tracking parameters go.
        for (const key of [...parsed.searchParams.keys()]) {
            if (TRACKING_PARAMS.some(re => re.test(key))) parsed.searchParams.delete(key);
        }
        parsed.searchParams.sort();   // stable ordering, so one feed is one string
    } else {
        parsed.search = fbProfileId ? `?id=${encodeURIComponent(fbProfileId)}` : '';
    }
    parsed.hash = '';
    // The four platforms are https-only, so normalising their scheme is safe and helps
    // de-duplication. A member's own site is not ours to rewrite — an http-only site stored as
    // https is a link that does not resolve, with nothing at add time to say why.
    if (platform !== 'website' && platform !== 'rss') {
        parsed.protocol = 'https:';
    }

    // Short links have opaque paths that only resolve on their own host, so they are stored
    // verbatim — there is nothing to canonicalise and guessing would break them.
    const isShortLink = SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase().replace(/^www\./, ''));
    const segments = parsed.pathname.split('/').filter(Boolean);
    // Every reserved-segment and prefix comparison below runs against this, not the raw segment.
    // `instagram.com/P/Cxyz/` used to slip past the reserved list and store handle `@p`, and
    // `facebook.com/Groups/123` past FB_PREFIX_DEPTH into the very dead link its comment describes.
    const seg0 = (segments[0] || '').toLowerCase();
    let handle: string | null = null;
    if (isShortLink) {
        handle = null;
    } else if (platform === 'instagram' && segments.length >= 1 && !IG_RESERVED_SEGMENTS.has(seg0)) {
        const h = segments[0].toLowerCase();
        handle = `@${h}`;
        parsed.pathname = `/${h}/`;
    } else if (platform === 'tiktok' && segments[0]?.startsWith('@')) {
        handle = segments[0].toLowerCase();
        parsed.pathname = `/${handle}`;
    } else if (platform === 'youtube' && segments[0]?.startsWith('@')) {
        handle = segments[0].toLowerCase();
        parsed.pathname = `/${handle}`;
    } else if (platform === 'youtube' && ['channel', 'c', 'user'].includes(seg0) && segments[1]) {
        // `/channel/UC…` is the form that maps to the channel RSS feed the autolist path needs, so
        // it must be accepted, and `/c/` and `/user/` are still all over people's bios.
        //
        // A `/channel/` ID is case-SENSITIVE and must be preserved byte for byte. `/c/` and
        // `/user/` names are not, so they are folded like an @handle — otherwise `/c/Foo` and
        // `/c/foo` are two rows for one channel.
        //
        // What this still cannot collapse is the same channel added as both `/c/Foo` and `@foo`:
        // deciding they are the same requires resolving them, which Phase 2's resolver can do and
        // this cannot. The cross-post warning covers the visible symptom in the meantime.
        const isChannelId = seg0 === 'channel';
        const ident = isChannelId ? segments[1] : segments[1].toLowerCase();
        // Displayed verbatim, NOT as `@ident`: the legacy custom-URL namespace (`/c/`, `/user/`)
        // is distinct from the @handle namespace, so `youtube.com/c/foo` and `youtube.com/@foo`
        // can be different channels. Fabricating the @ form would put another channel's handle on
        // this member's chip.
        handle = ident;
        parsed.pathname = `/${seg0}/${ident}`;
    } else if (platform === 'facebook' && fbProfileId) {
        handle = `profile.php?id=${fbProfileId}`;
        parsed.pathname = '/profile.php';
    } else if (platform === 'facebook' && FB_PREFIX_DEPTH.has(seg0) && !segments[1]) {
        // `/groups/`, `/share/`, `/pages/` with nothing after them fell through to the generic
        // branch and stored `facebook.com/groups` with handle `groups` — a dead link that every
        // such paste then collided with.
        throw new ChannelError('NO_HANDLE', 'That link does not point to an account. Try your handle.');
    } else if (platform === 'facebook' && /^profile\.php$/i.test(seg0)) {
        // Reached only when there was no `id` to keep — `/profile.php` alone identifies nobody, and
        // storing it would put a dead link on the profile with "profile.php" as the handle.
        throw new ChannelError('NO_HANDLE', 'That link does not point to an account. Try your handle.');
    } else if (platform === 'facebook' && FB_PREFIX_DEPTH.has(seg0) && segments[1]) {
        // These prefixes carry the identity BELOW the first segment, and how far below differs:
        // `/groups/<id>` is one deep, while `/people/<name>/<id>` and `/share/p/<id>` are two.
        // Keeping only the first segment collapsed every group to `facebook.com/groups`, so
        // distinct channels collided as duplicates and the chip linked to a generic page.
        // A Map, not an object literal: `/constructor/…` and `/__proto__/…` are real paths, and an
        // unguarded index would give them an inherited value, a NaN slice, and a dead stored URL.
        const depth = FB_PREFIX_DEPTH.get(seg0)!;
        // Folded like every other identity form, or `/people/Some-Name/61553` and
        // `/people/some-name/61553` are two rows for one page.
        //
        // NOT for `/share/`, whose ids are opaque and case-SENSITIVE — folding `1A2b3C4d` to
        // `1a2b3c4d` produces a dead link that cannot be recovered from what was stored. Slugs and
        // numeric ids fold safely; opaque ids never do.
        const foldable = seg0 !== 'share';
        const tail = segments.slice(1, 1 + depth).filter(Boolean)
            .map(x => (foldable ? x.toLowerCase() : x));
        handle = `${seg0}/${tail.join('/')}`;
        parsed.pathname = `/${seg0}/${tail.join('/')}`;
    } else if (platform === 'facebook' && segments.length >= 1) {
        // Canonicalised like the others, or `@mypage`, `/mypage/` and `/mypage/posts/123` become
        // three separate rows for one page and the duplicate check never fires.
        const h = segments[0].toLowerCase();
        handle = h;
        parsed.pathname = `/${h}`;
    } else if (platform === 'website' || platform === 'rss') {
        handle = parsed.hostname.replace(/^www\./, '');
    }

    // `instagram.com` on its own parses, passes the host check, and yields no handle — a valid URL
    // that points at no account. Storing it would put an empty chip on the member's profile.
    if (!handle && !isShortLink && platform !== 'website' && platform !== 'rss') {
        throw new ChannelError('NO_HANDLE', 'That link does not point to an account. Try your handle.');
    }

    const url = parsed.toString();
    if (url.length > MAX_URL_LENGTH) throw new ChannelError('TOO_LONG', 'That link is too long.');
    // Rejected, NOT truncated. Slicing decoupled the handle from the URL it was derived from, so
    // the chip named one account while the link pointed at another — and for a `/people/<slug>/<id>`
    // handle the truncation could cut off the very id that distinguishes the page.
    if (handle && handle.length > MAX_HANDLE_LENGTH) {
        throw new ChannelError('TOO_LONG', 'That account name is too long.');
    }
    return { url, handle };
}

/**
 * The key two channels are the same by.
 *
 * `normaliseChannelInput` canonicalises the path for the four platforms, but a member's own
 * website or feed is deliberately left as they typed it — rewriting someone's address is how a
 * working link becomes a 404. That left `example.com/feed` and `example.com/feed/` as two strings
 * for one feed, which the duplicate check compared directly and let through.
 *
 * So the fold happens on the comparison key instead of on the stored URL. Case is NOT folded here:
 * Facebook `/share/` ids are case-sensitive, and lowercasing would make two genuinely different
 * share links collide as duplicates — the normaliser has already folded case everywhere it is safe.
 */
export function channelDedupeKey(platform: ChannelPlatform, url: string | null): string {
    if (!url) return `${platform}\u0000`;
    let key = url;
    try {
        const u = new URL(url);
        if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
            u.pathname = u.pathname.replace(/\/+$/, '');
        }
        key = u.toString();
    } catch {
        // Stored URLs always parse; a malformed one compares verbatim rather than throwing here.
    }
    return `${platform}\u0000${key}`;
}

/**
 * The one definition of what a channel tombstone keeps.
 *
 * Three call sites scrub channels — the member's own delete, `adminPruneUser` and
 * `purgeMemberSelf` — and as three copied statements they had already drifted: all three cleared
 * `last_error`, none cleared `fail_count` or `is_stale`, so a channel that had accumulated fetch
 * failures carried that history into every backup. One definition means the next column added to
 * the table is one edit, not three.
 *
 * Takes structured criteria rather than a SQL fragment. An exported helper whose caller supplies
 * raw `WHERE` text is a footgun for the next caller even when today's two pass literals — the
 * owner scope is the entire security property here, so it is not something a caller can phrase.
 */
export function scrubChannelRows(criteria: { ownerPubkey: string; id?: string }, at: string): number {
    // owner_pubkey is always required; `id` narrows one channel out of that member's set.
    const conditions = ['owner_pubkey = ?'];
    const params: unknown[] = [criteria.ownerPubkey];
    if (criteria.id !== undefined) {
        conditions.push('id = ?');
        params.push(criteria.id);
    }
    return db.prepare(
        `UPDATE creator_channels
            SET deleted_at = ?, url = NULL, handle = NULL, is_primary_video = 0,
                platform = 'deleted', category = 'other', supports_autolist = 0,
                autopublish = 0, syndicate_to_node = 0, post_count_seen = NULL,
                oauth_verified_at = NULL, last_error = NULL, fail_count = 0, is_stale = 0,
                updated_at = ?
          WHERE ${conditions.join(' AND ')} AND deleted_at IS NULL`
    ).run(at, at, ...params).changes;
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
/**
 * The display-only projection of a channel.
 *
 * `autopublish` is a private preference and `postCountSeen` is an engagement watermark; neither is
 * anyone else's business, and reusing the full row on the one endpoint other members read would
 * have handed both over.
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

function rowToPublicChannel(row: any): PublicCreatorChannel {
    return {
        id: row.id,
        platform: row.platform,
        url: row.url,
        handle: row.handle,
        category: row.category,
        isPrimaryVideo: row.is_primary_video === 1,
        supportsAutolist: row.supports_autolist === 1,
        // A boolean, not the timestamp: whether the claim is proven is the useful fact, and when
        // they connected is not.
        isVerified: !!row.oauth_verified_at,
    };
}

export function listPublicChannels(ownerPubkey: string): PublicCreatorChannel[] {
    // Joined to `members.status` rather than trusting the channel rows: `actionReport` suspends a
    // member and pauses their posts, and their external links have to go the same way. Without
    // this the one endpoint that serves unauthenticated keeps publishing them.
    const rows = db.prepare(
        `SELECT c.* FROM creator_channels c
           JOIN members m ON m.public_key = c.owner_pubkey
          WHERE c.owner_pubkey = ? AND c.deleted_at IS NULL AND c.syndicate_to_node = 1
            AND m.status = 'active'
          ORDER BY c.created_at ASC`
    ).all(ownerPubkey) as any[];
    return rows.map(rowToPublicChannel);
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
    syndicateToNode?: unknown;
    isPrimaryVideo?: unknown;
}): CreatorChannel {
    const syndicateToNode = asBool(input.syndicateToNode, 'syndicateToNode');
    const wantsPrimary = asBool(input.isPrimaryVideo, 'isPrimaryVideo');
    const platform = input.platform as ChannelPlatform;
    const category = input.category as ChannelCategory;
    if (!CHANNEL_PLATFORMS.includes(platform)) throw new ChannelError('BAD_PLATFORM', 'Unknown platform.');
    if (!CHANNEL_CATEGORIES.includes(category)) throw new ChannelError('BAD_CATEGORY', 'Unknown category.');

    const member = db.prepare(`SELECT public_key FROM members WHERE public_key = ?`).get(input.ownerPubkey);
    if (!member) throw new ChannelError('NO_MEMBER', 'Member not found.');

    const existing = listChannels(input.ownerPubkey);
    if (existing.length >= MAX_CHANNELS_PER_MEMBER) {
        throw new ChannelError('AT_LIMIT', `You can have up to ${MAX_CHANNELS_PER_MEMBER} channels. Remove one first.`);
    }
    // Tombstones are NEVER hard-deleted. The delta exporter selects on `updated_at >= since` and
    // the importer is upsert-only, so a row removed here is a row a lagging replica never hears
    // about — it would keep the deleted channel, with its URL, permanently, and only an operator
    // force-resync could clear it. Deleting the oldest tombstones first, as a pressure-relief
    // scheme would, targets exactly the ones a replica is most likely to have missed.
    //
    // They are cheap instead: `deleteChannel` scrubs every field that says anything, leaving an id
    // and two timestamps. The ceiling below is a runaway guard, not a working limit.
    // A ROLLING WINDOW, not a lifetime total. Tombstones are permanent by design, so counting them
    // forever meant an account that hit the ceiling could never add a channel again — no admin
    // route, no self-service reset, nothing to prune. A window bounds burst abuse just as well and
    // heals on its own.
    const recentRows = (db.prepare(
        `SELECT COUNT(*) AS c FROM creator_channels WHERE owner_pubkey = ? AND created_at >= ?`
    ).get(input.ownerPubkey, new Date(Date.now() - CHURN_WINDOW_MS).toISOString()) as any).c as number;
    if (recentRows >= MAX_ROWS_PER_WINDOW) {
        throw new ChannelError('TOO_MANY', 'You have added and removed a lot of channels this month. Remove one you are not using, or try again later.');
    }

    const { url, handle } = normaliseChannelInput(platform, input.raw);

    // Normalisation is what makes this check work — the same channel pasted as a handle and as a
    // share-sheet URL with tracking params must collide, or a member ends up double-posting to
    // their own feed.
    // Keyed on (platform, url), not url alone: a blog normalises the same as `website` and as
    // `rss`, and a member is entitled to both — one as a card, one as the autolisting feed.
    const dedupeKey = channelDedupeKey(platform, url);
    if (existing.some(c => channelDedupeKey(c.platform, c.url) === dedupeKey)) {
        throw new ChannelError('DUPLICATE', 'You have already added that channel.');
    }

    const id = `chan_${crypto.randomBytes(12).toString('hex')}`;
    const now = new Date().toISOString();
    const supportsAutolist = canAutolist(platform, url) ? 1 : 0;

    // The first video channel is the primary by default. Being explicit beats leaving every
    // channel unmarked and having the feed pick arbitrarily.
    // Only a video channel can be the video primary. Honouring the flag on a website would set it
    // without clearing the others (that step is video-guarded), leaving two rows marked primary.
    const isPrimary = !VIDEO_PLATFORMS.has(platform)
        ? 0
        : wantsPrimary !== undefined
            ? (wantsPrimary ? 1 : 0)
            : (otherVideoChannels(input.ownerPubkey).length === 0 ? 1 : 0);

    db.transaction(() => {
        if (isPrimary === 1) {
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
              supportsAutolist, syndicateToNode === false ? 0 : 1, now, now);
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
    rawPatch: { category?: string; syndicateToNode?: unknown; isPrimaryVideo?: unknown; autopublish?: unknown }
): CreatorChannel {
    const patch = {
        category: rawPatch.category,
        syndicateToNode: asBool(rawPatch.syndicateToNode, 'syndicateToNode'),
        isPrimaryVideo: asBool(rawPatch.isPrimaryVideo, 'isPrimaryVideo'),
        autopublish: asBool(rawPatch.autopublish, 'autopublish'),
    };
    const row = db.prepare(
        `SELECT * FROM creator_channels WHERE id = ? AND deleted_at IS NULL`
    ).get(id) as any;
    if (!row) throw new ChannelError('NOT_FOUND', 'Channel not found.');
    if (row.owner_pubkey !== ownerPubkey) throw new ChannelError('NOT_YOURS', 'That is not your channel.');

    if (patch.category !== undefined && !CHANNEL_CATEGORIES.includes(patch.category as ChannelCategory)) {
        throw new ChannelError('BAD_CATEGORY', 'Unknown category.');
    }
    // Without this a website could be made "primary video", demoting every real video channel and
    // leaving the feed with no cross-post winner at all.
    if (patch.isPrimaryVideo === true && !VIDEO_PLATFORMS.has(row.platform as ChannelPlatform)) {
        throw new ChannelError('NOT_VIDEO', 'Only a video channel can be your main one.');
    }

    const now = new Date().toISOString();
    db.transaction(() => {
        if (patch.isPrimaryVideo === true) {
            db.prepare(
                `UPDATE creator_channels SET is_primary_video = 0, updated_at = ?
                  WHERE owner_pubkey = ? AND deleted_at IS NULL AND id != ? AND is_primary_video = 1`
            ).run(now, ownerPubkey, id);
        }
        // Demoting the current primary hands it on, the same way deleting it does — otherwise the
        // member is left with video channels and no cross-post winner, which is the state the flag
        // exists to prevent.
        if (patch.isPrimaryVideo === false && row.is_primary_video === 1) {
            const heir = otherVideoChannels(ownerPubkey, id)[0];
            if (heir) {
                db.prepare(`UPDATE creator_channels SET is_primary_video = 1, updated_at = ? WHERE id = ?`)
                    .run(now, heir.id);
            }
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

    const wasPrimary = getChannel(id)?.isPrimaryVideo === true;
    const now = new Date().toISOString();
    let changed = 0;

    db.transaction(() => {
        // Everything that says anything goes, not just the link: `platform` and `category` would
        // otherwise sit in every backup announcing that this member once ran a craft video
        // channel. What survives is an id, an owner (needed to scope the row and satisfy the
        // foreign key) and two timestamps — enough to converge, and nothing else.
        //
        // The placeholders are NOT NULL columns; every read filters on `deleted_at IS NULL`, so
        // they are never shown or matched.
        changed = scrubChannelRows({ ownerPubkey, id }, now);
        try {
            scrubPulseItems({ channelId: id }, now);
        } catch { }

        // Deleting the primary would otherwise leave the member with video channels and no
        // cross-post winner, which is the state the primary exists to prevent. The oldest
        // survivor inherits it — the same rule that made the first one primary.
        if (changed > 0 && wasPrimary) {
            const heir = otherVideoChannels(ownerPubkey, id)[0];
            if (heir) {
                db.prepare(`UPDATE creator_channels SET is_primary_video = 1, updated_at = ? WHERE id = ?`)
                    .run(now, heir.id);
            }
        }
    })();

    return changed > 0;
}
