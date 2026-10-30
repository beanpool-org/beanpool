/**
 * What an owner's seeding assistant reads before it posts (design §2.2, slice S2): the lists it picks from, the board as the
 * owner's own Market shows it (to find a duplicate), and the community's area (to place a listing). Owner grants ticked
 * "May post for me" only, as the creates (agent/owner-posts.ts); my_posts, the undo list, is there too.
 *
 * - Redacted at the source, named fields only (agent/tools.ts): no key, no URL or address, no other member's name, no photo,
 *   no balance. A listing is "me", "enterprise:<ref>" (one the owner keeps, by owner-posts.ts enterpriseRef) or "another
 *   member"; its title only with include_text, fenced.
 * - listings_search reads through the Market's own read (getPosts with the owner as its viewer), so it sees what the owner's
 *   Market sees and no more: a group's post outside their groups, a direct post between others, a post hidden by reports, or
 *   another member's paused one is not there, as on their phone.
 * - community_area is the community's area as a member's app reads it (config/community-place.ts, to two decimals), the
 *   rounding a listing's pin gets (3 decimals), and the place names of this community's own events of the last 90 days,
 *   each at its pin rounded the same, fenced: never a member's area or pin, never an address a member typed beyond an
 *   event's place name on its public card.
 */
import { approximateLocation, PRICING_CATEGORIES } from '@beanpool/core';
import { db } from '../db/db.js';
import { getNodeConfig, getPosts } from '../state-engine.js';
import { placeAs } from '../config/community-place.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { fence, MEMBER_TEXT_NOTICE } from './fence.js';
import { AGENT_LIST_MAX } from './limits.js';
import { enterpriseRef, OWNER_TEND_TOOLS } from './owner-posts.js';
import type { AgentGrant, AgentTool, ToolResult } from './tools.js';

const NOT_TICKED = 'This assistant was connected without "May post for me": it reads what the other tools read, and nothing for seeding.';

function readGate(grant: AgentGrant): string | null {
    if (grant.role !== 'owner') return "Only an owner's assistant reads for seeding: an admin's cannot.";
    if (!grant.canPost) return NOT_TICKED;
    return null;
}

function clampLimit(v: unknown, def = 20): number {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, AGENT_LIST_MAX) : def;
}

const wantsText = (args: Record<string, unknown>): boolean => args.include_text === true || args.include_text === 'true';

/** The enterprises the owner keeps, by key: their listings read as "enterprise:<ref>", every other member's as "another member". */
function keptKeys(member: string): Set<string> {
    return new Set((db.prepare(`SELECT o.treasury_pubkey AS key FROM treasury_operators o JOIN members m ON m.public_key = o.treasury_pubkey
        WHERE o.member_pubkey = ? AND m.is_treasury = 1`).all(member) as Array<{ key: string }>).map((r) => r.key));
}

const KINDS = ['offer', 'need', 'event', 'poll'] as const;

function listingsSearch(grant: AgentGrant, args: Record<string, unknown>, boundary: string): ToolResult {
    const q = typeof args.q === 'string' ? args.q.trim().slice(0, 100) : '';
    const kind = typeof args.kind === 'string' && (KINDS as readonly string[]).includes(args.kind) ? args.kind : undefined;
    const category = typeof args.category === 'string' && PRICING_CATEGORIES.some((c) => c.id === args.category) ? args.category : undefined;
    const limit = clampLimit(args.limit);
    const withText = wantsText(args);
    // The Market's own read, as the owner (routes/marketplace.ts GET /api/marketplace/posts reads getPosts the same way):
    // the engine decides what this viewer may see.
    const posts = getPosts({
        viewerPubkey: grant.member, query: q || undefined, category, status: 'active', limit,
        ...(kind ? { types: [kind] } : { types: [...KINDS] }),
    });
    const kept = keptKeys(grant.member);
    const result: Record<string, unknown> = {
        q, returned: posts.length,
        listings: posts.map((p) => {
            const view: Record<string, unknown> = {
                postId: p.id, kind: p.type, status: p.status, category: p.category, createdAt: p.createdAt,
                by: p.authorPublicKey === grant.member ? 'me' : kept.has(p.authorPublicKey) ? `enterprise:${enterpriseRef(p.authorPublicKey)}` : 'another member',
                link: `/?post=${encodeURIComponent(p.id)}`,
            };
            if (withText) view.title = fence(boundary, `listing ${p.id}, title`, p.title);
            return view;
        }),
    };
    if (withText) result._notice = MEMBER_TEXT_NOTICE;
    return { ok: true, rows: posts.length, result };
}

const DAY_MS = 24 * 60 * 60_000;
export const COMMUNITY_AREA_PLACES_MAX = 30;

function communityArea(boundary: string): ToolResult {
    const config = getNodeConfig() as { serviceRadius?: { lat: number; lng: number; radiusKm: number }; location?: { lat: number; lng: number; name?: string } };
    // As a member's app reads it (config/community-place.ts 'rounded'): never the manager's exact pin, which may be a home.
    const area = placeAs(config.serviceRadius, 'rounded') ?? placeAs(config.location, 'rounded');
    const since = new Date(Date.now() - 90 * DAY_MS).toISOString();
    // This community's own public events, by their place's name on the card: an assistant reuses a hall, never finds a home.
    const rows = db.prepare(`SELECT event_place_name AS name, lat, lng FROM posts
        WHERE type = 'event' AND origin_node IS NULL AND (audience_scope IS NULL OR audience_scope = 'public')
        AND hidden_by_reports_at IS NULL AND COALESCE(event_online, 0) = 0
        AND event_place_name IS NOT NULL AND TRIM(event_place_name) != '' AND lat IS NOT NULL AND lng IS NOT NULL
        AND created_at >= ? ORDER BY created_at DESC LIMIT 500`).all(since) as Array<{ name: string; lat: number; lng: number }>;
    const seen = new Set<string>();
    const places: Array<Record<string, unknown>> = [];
    for (const r of rows) {
        const key = r.name.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const pin = approximateLocation(r.lat, r.lng);
        places.push({ name: fence(boundary, "an event's place name", r.name), lat: pin.lat, lng: pin.lng });
        if (places.length >= COMMUNITY_AREA_PLACES_MAX) break;
    }
    return {
        ok: true, rows: places.length,
        result: {
            centre: area ? { lat: area.lat, lng: area.lng } : null,
            radiusKm: area && typeof (area as { radiusKm?: number }).radiusKm === 'number' ? (area as { radiusKm: number }).radiusKm : null,
            pinRounding: 'a listing\'s or an event\'s pin is stored rounded to 3 decimals (about 100 m), as the apps send it',
            useMyArea: 'create_offer and create_need take use_my_area: true to place a listing at your own area',
            eventPlaces: places,
            _notice: MEMBER_TEXT_NOTICE,
        },
    };
}

export const OWNER_READ_TOOLS: AgentTool[] = [
    {
        name: 'categories',
        title: 'What a post picks from',
        reads: 'the Market categories with their English labels and emoji, the kinds of post, the price types, and whether this community has Beans',
        never: 'any member data',
        ownerOnly: true,
        posts: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: { categories: { type: 'array' }, kinds: { type: 'array' }, priceTypes: { type: 'array' }, beans: { type: 'boolean' } }, required: ['categories', 'kinds', 'priceTypes', 'beans'] },
        run: (grant) => {
            const refused = readGate(grant);
            if (refused) return { ok: false, error: refused };
            return {
                ok: true, rows: PRICING_CATEGORIES.length,
                result: {
                    categories: PRICING_CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji })),
                    kinds: ['offer', 'need', 'event'], priceTypes: ['fixed', 'hourly'], beans: getProfileSwitches().beans === true,
                },
            };
        },
    },
    {
        name: 'listings_search',
        title: 'Search the board',
        reads: `the live Offers, Needs, events and polls the owner's own Market shows them, newest first, at most ${AGENT_LIST_MAX}, matching q, a kind `
            + "or a category: id, kind, status, category, when, by (me, an enterprise you keep, or another member) and its link; with include_text, the title, fenced",
        never: "an author's key or name, a pin, a photo, a price, or a post the owner's Market does not show them",
        memberText: true,
        ownerOnly: true,
        posts: true,
        inputSchema: {
            type: 'object',
            properties: {
                q: { type: 'string', description: 'words to search for, as the Market search takes them' },
                kind: { type: 'string', enum: [...KINDS] },
                category: { type: 'string', enum: PRICING_CATEGORIES.map((c) => c.id) },
                include_text: { type: 'boolean', description: 'add each listing\'s fenced title' },
                limit: { type: 'integer', minimum: 1, maximum: AGENT_LIST_MAX },
            },
            additionalProperties: false,
        },
        outputSchema: { type: 'object', properties: { q: { type: 'string' }, returned: { type: 'number' }, listings: { type: 'array' } }, required: ['q', 'returned', 'listings'] },
        run: (grant, args, boundary) => {
            const refused = readGate(grant);
            return refused ? { ok: false, error: refused } : listingsSearch(grant, args, boundary);
        },
    },
    {
        name: 'community_area',
        title: "The community's area",
        reads: "the community's centre and radius as a member's app shows them (to about 1 km), how a pin is rounded, and the place names of "
            + `this community's public events of the last 90 days, at most ${COMMUNITY_AREA_PLACES_MAX}, each at its pin rounded to about 100 m, fenced`,
        never: "any member's area or pin, an address, or the exact pin the owners set",
        memberText: true,
        ownerOnly: true,
        posts: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: { centre: { type: ['object', 'null'] }, radiusKm: { type: ['number', 'null'] }, eventPlaces: { type: 'array' } }, required: ['centre', 'radiusKm', 'eventPlaces'] },
        run: (grant, _args, boundary) => {
            const refused = readGate(grant);
            return refused ? { ok: false, error: refused } : communityArea(boundary);
        },
    },
    ...OWNER_TEND_TOOLS,
];
