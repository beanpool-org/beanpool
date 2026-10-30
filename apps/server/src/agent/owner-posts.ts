/**
 * An owner's AI assistant posts for them (MCP-OWNER-POSTS; Marty, 30 Oct: "we don't want bulk approval, we want to have an
 * agent use MCP to add a new market listing as needed"): `create_offer`, `create_need`, `create_event` and
 * `create_enterprise_listing`, with `my_enterprises` to name the enterprises it may post as.
 *
 * - Owner grants only, read at call time (grant.role, which agent/mcp-route.ts reads afresh on every request), behind the
 *   owners' switch, the bearer check and the door's 60 a minute and 2,000 a day. An admin's assistant is never offered
 *   them; one that calls them anyway is refused in words.
 * - The node posts on the owner's behalf: the author is the owner's own member key, or an enterprise they keep NOW
 *   (canOperateTreasury, the keepers route's own check). No key reaches the assistant: an enterprise is named by a
 *   reference made from its key (enterpriseRef), matched only among the ones the owner keeps.
 * - Each tool runs what its HTTP route runs after the signature check, in the same order and through the same engine call
 *   (routes/marketplace.ts POST /api/marketplace/posts; routes/treasury.ts POST /api/treasury/:treasury/{offer,need,event}),
 *   so the mute, probation and daily-post limits, the engine's validation (text limits, categories, place, reach, an event's
 *   times and pin), the search index, the sync marks and the standby copy behave as for a post from the phone. A server
 *   another took over (services/identity-epoch.ts) refuses, as its /api/ routes do.
 * - Photos are required: 1–4, each a base64 JPEG or WebP of at most the per-photo cap (state-engine.ts
 *   MAX_PHOTO_BASE64_CHARS), made here what the apps send (at most 800 px, no metadata: storage/photo-thumbnails.ts
 *   resizeToStoredPhoto), then held to the routes' photo rule. No composer offers a preset tile instead of a photo, so
 *   neither does this.
 * - 50 posts per grant per UTC day (limits.ts AGENT_CREATES_PER_DAY); one the engine refuses is not counted.
 * - The row records `created_via = 'assistant:<grant id>'` (schema.sql posts.created_via); the AGENT line of every create
 *   names the post id (mcp-route.ts). Revoking the grant or turning the switch off stops the next call at the door; posts
 *   made stay, and are deleted as any post is.
 * - An answer carries the new post's id and its link in the app (`/?post=<id>`, a path the assistant joins to the address in
 *   its welcome), and the day's count: no key, no token, nothing about another member.
 */
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { canOperateTreasury, createPost, MAX_PHOTO_BASE64_CHARS } from '../state-engine.js';
import { createEventFromBody } from '../routes/event-post.js';
import type { EventTimeOut } from '../engine/posts.js';
import { assertMayAddPhotos, assertMayPost } from '../engine/probation.js';
import { assertMayPostToday, enterprisePostLimit } from '../engine/writer-bounds.js';
import { assertNotMuted } from '../engine/auto-moderation.js';
import { newListingCategory } from '../engine/shops.js';
import { photoRefusalText, routePhotosRefusal, sniffRasterImageType } from '../engine/avatar.js';
import { imageSize } from '../storage/image-metadata.js';
import { PHOTO_MAX_SIDE, resizeToStoredPhoto } from '../storage/photo-thumbnails.js';
import { syncPulseMarketplaceGate } from '../daily-pulse.js';
import { getReplacedInfo } from '../services/identity-epoch.js';
import { memberErrorText } from '../routes/member-error-text.js';
import { cleanMemberText, fence, MEMBER_TEXT_NOTICE } from './fence.js';
import { admitAgentCreate, agentCreatesToday, returnAgentCreate, AGENT_CREATES_PER_DAY } from './limits.js';
import type { AgentGrant, AgentTool, ToolResult } from './tools.js';

export const AGENT_POST_PHOTOS_MIN = 1;
export const AGENT_POST_PHOTOS_MAX = 4;
/** The longest side a photo may arrive with: the node's decoder ceiling (storage/photo-thumbnails.ts), resized from there. */
export const AGENT_PHOTO_MAX_INPUT_SIDE = 2048;

/** What a request to /mcp may carry from an owner's assistant: four photos at the per-photo cap, and room for the rest. */
export const AGENT_CREATE_BODY_MAX = AGENT_POST_PHOTOS_MAX * MAX_PHOTO_BASE64_CHARS + 64 * 1024;

/** `created_via` on a post an assistant made (schema.sql). */
export function createdViaOf(grant: AgentGrant): string {
    return `assistant:${grant.id}`;
}

/** An enterprise as the assistant names it: from its key, never the key (the tool table returns none). */
export function enterpriseRef(enterpriseKey: string): string {
    return crypto.createHash('sha256').update(`beanpool-agent-enterprise:${enterpriseKey}`).digest('hex').slice(0, 16);
}

const BLOCKED = new Set(['disabled', 'suspended', 'pruned']);
const statusOf = (pk: string): string | undefined =>
    (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as { status?: string } | undefined)?.status;

/** The enterprises this member keeps now, as routes/treasury.ts requireOperator would let them act for each. */
function keptEnterprises(member: string): Array<{ key: string; name: string }> {
    const rows = db.prepare(`SELECT o.treasury_pubkey AS key, m.callsign AS name FROM treasury_operators o
        JOIN members m ON m.public_key = o.treasury_pubkey
        WHERE o.member_pubkey = ? AND m.is_treasury = 1 ORDER BY m.callsign`).all(member) as Array<{ key: string; name: string | null }>;
    return rows
        .filter((r) => canOperateTreasury(member, r.key) && !BLOCKED.has(statusOf(r.key) ?? ''))
        .map((r) => ({ key: r.key, name: r.name ?? '' }));
}

type Author = { ok: true; author: string; enterprise: boolean } | { ok: false; error: string };

/** Who the post is by: the owner, or the enterprise `ref` names among the ones they keep now. */
function authorFor(grant: AgentGrant, ref: unknown, required: boolean): Author {
    if (ref === undefined || ref === null || ref === '') {
        return required
            ? { ok: false, error: 'Name the enterprise with as_enterprise: my_enterprises lists the ones you may post as.' }
            : { ok: true, author: grant.member, enterprise: false };
    }
    if (typeof ref !== 'string') return { ok: false, error: 'as_enterprise is the ref my_enterprises gives.' };
    const hit = keptEnterprises(grant.member).find((e) => enterpriseRef(e.key) === ref.trim());
    if (!hit) return { ok: false, error: 'That is not an enterprise you keep now: my_enterprises lists the ones you may post as.' };
    if (BLOCKED.has(statusOf(grant.member) ?? '')) return { ok: false, error: 'Your account is not active, so you cannot act for this enterprise.' };
    return { ok: true, author: hit.key, enterprise: true };
}

type Photos = { ok: true; photos: string[] } | { ok: false; error: string };

const DATA_URL = /^data:image\/(jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i;
const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

/** One photo made what the apps send, or why not. */
async function storablePhoto(value: unknown, n: number): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const which = `Photo ${n}`;
    const formatError = { ok: false as const, error: `${which} must be a JPEG or WebP image, as base64 (a data: URL or the bare base64).` };
    if (typeof value !== 'string' || !value.trim()) return formatError;
    const trimmed = value.trim();
    const m = DATA_URL.exec(trimmed);
    if (!m && (/^data:/i.test(trimmed) || !BASE64.test(trimmed))) return formatError;
    const b64 = m ? m[2] : trimmed;
    if (b64.length > MAX_PHOTO_BASE64_CHARS) {
        return { ok: false, error: `${which} is too large: each may be at most ${MAX_PHOTO_BASE64_CHARS.toLocaleString('en')} base64 characters. Resize it to ${PHOTO_MAX_SIDE} pixels on its longest side and send it again.` };
    }
    const bytes = Buffer.from(b64, 'base64');
    const kind = sniffRasterImageType(bytes);
    if (kind !== 'image/jpeg' && kind !== 'image/webp') return formatError;
    const size = imageSize(bytes);
    if (!size) return formatError;
    if (Math.max(size.width, size.height) > AGENT_PHOTO_MAX_INPUT_SIDE) {
        return { ok: false, error: `${which} is ${size.width} × ${size.height} pixels: send it at most ${AGENT_PHOTO_MAX_INPUT_SIDE.toLocaleString('en')} on its longest side (${PHOTO_MAX_SIDE} is what the apps send).` };
    }
    const resized = await resizeToStoredPhoto(bytes, kind === 'image/jpeg' ? 'jpeg' : 'webp');
    let out: Buffer;
    if (resized) out = resized;
    // No resizer on this host (sharp would not load): a photo already the apps' size is stored as they send it, its
    // metadata stripped at the store as every upload's is (storage/image-columns.ts storeUploadedPhotoColumns).
    else if (Math.max(size.width, size.height) <= PHOTO_MAX_SIDE) out = bytes;
    else return { ok: false, error: `This server cannot resize photos now: send ${which.toLowerCase()} at most ${PHOTO_MAX_SIDE} pixels on its longest side.` };
    return { ok: true, value: `data:${kind};base64,${out.toString('base64')}` };
}

/** 1–4 photos, each made what the apps send and held to the routes' photo rule (engine/avatar.ts routePhotosRefusal). */
async function photosFrom(value: unknown): Promise<Photos> {
    if (!Array.isArray(value) || value.length < AGENT_POST_PHOTOS_MIN) {
        return { ok: false, error: 'Add a photo first: every Offer, Need and event needs 1 to 4 photos (base64 JPEG or WebP).' };
    }
    if (value.length > AGENT_POST_PHOTOS_MAX) return { ok: false, error: `At most ${AGENT_POST_PHOTOS_MAX} photos a post.` };
    const photos: string[] = [];
    for (let i = 0; i < value.length; i++) {
        const one = await storablePhoto(value[i], i + 1);
        if (!one.ok) return one;
        photos.push(one.value);
    }
    const refusal = routePhotosRefusal(photos);
    if (refusal) return { ok: false, error: photoRefusalText(refusal, 'Each photo must be a JPEG or WebP image.') };
    return { ok: true, photos };
}

function str(v: unknown, max: number): string | undefined {
    return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
    return undefined;
}

/** The refusals before anything else: an owner's grant, a server still this community's, and the day's count left. */
function gate(grant: AgentGrant): string | null {
    if (grant.role !== 'owner') return "Only an owner's assistant can post: an admin's cannot.";
    const replaced = getReplacedInfo();
    if (replaced) return `${replaced.message} This server takes no new posts; use the one that took over.`;
    if (agentCreatesToday(grant.id) >= AGENT_CREATES_PER_DAY) {
        return `This assistant has made ${AGENT_CREATES_PER_DAY} posts today, the most a day allows: try again tomorrow (UTC).`;
    }
    return null;
}

function answer(grant: AgentGrant, kind: 'offer' | 'need' | 'event', postId: string, asEnterprise: boolean): ToolResult {
    return {
        ok: true, rows: 1,
        result: {
            postId, kind, asEnterprise,
            link: `/?post=${encodeURIComponent(postId)}`,
            postsToday: agentCreatesToday(grant.id), postsPerDay: AGENT_CREATES_PER_DAY,
        },
    };
}

interface ListingArgs {
    kind: 'offer' | 'need';
    args: Record<string, unknown>;
    enterpriseRequired: boolean;
}

/** An Offer or a Need, as the owner (POST /api/marketplace/posts) or as an enterprise they keep (/api/treasury/:t/{offer,need}). */
async function createListing(grant: AgentGrant, { kind, args, enterpriseRequired }: ListingArgs): Promise<ToolResult> {
    const refused = gate(grant);
    if (refused) return { ok: false, error: refused };
    const who = authorFor(grant, args.as_enterprise, enterpriseRequired);
    if (!who.ok) return who;
    const title = str(args.title, 2000);
    if (!title || !title.trim()) return { ok: false, error: 'A title is required.' };
    const shopId = str(args.shop_id, 200);
    const category = str(args.category, 200) || newListingCategory(shopId) || (who.enterprise ? undefined : 'other');
    if (!category) return { ok: false, error: 'A category is required for an enterprise listing.' };
    const photos = await photosFrom(args.photos);
    if (!photos.ok) return photos;
    // Counted before the post is made, so two calls at once cannot both take the last one; given back when it is not made.
    if (!admitAgentCreate(grant.id)) {
        return { ok: false, error: `This assistant has made ${AGENT_CREATES_PER_DAY} posts today, the most a day allows: try again tomorrow (UTC).` };
    }
    const owner = grant.member;
    const lat = num(args.lat), lng = num(args.lng);
    const credits = num(args.beans) ?? 0;
    const priceType = args.price_type === 'hourly' ? 'hourly' : 'fixed';
    try {
        let post;
        if (who.enterprise) {
            const enterprise = who.author;
            assertNotMuted(owner);
            assertNotMuted(enterprise);
            assertMayAddPhotos(owner, Math.min(photos.photos.length, 5));
            const limit = enterprisePostLimit(enterprise, owner);
            // An Offer is repeatable unless it says not; a Need only when it says so (the enterprise routes' defaults).
            const repeatable = kind === 'offer' ? args.repeatable !== false : args.repeatable === true;
            post = createPost(kind, category, title, str(args.description, 20_000) ?? '', credits, priceType, enterprise, lat, lng,
                photos.photos, repeatable, undefined, undefined,
                { createdBy: owner, beforeWrite: limit.beforeWrite, shopId, createdVia: createdViaOf(grant) });
            if (post) limit.stored(post.id);
        } else {
            assertNotMuted(owner);
            assertMayPost(owner, Math.min(photos.photos.length, 5));
            post = createPost(kind, category, title, str(args.description, 20_000) ?? '', credits, priceType, owner, lat, lng,
                photos.photos, args.repeatable === true, undefined, args.cash_also_needed === true,
                { beforeWrite: () => assertMayPostToday(owner), shopId, createdVia: createdViaOf(grant) });
            if (post) syncPulseMarketplaceGate();
        }
        if (!post) {
            returnAgentCreate(grant.id);
            return { ok: false, error: kind === 'need' && who.enterprise ? 'The enterprise needs a live Offer before it can post a Need.' : 'The post could not be made.' };
        }
        return answer(grant, kind, post.id, who.enterprise);
    } catch (e) {
        returnAgentCreate(grant.id);
        return { ok: false, error: memberErrorText(e, 'The post could not be made: try again later.') };
    }
}

/** An event, as the owner (POST /api/marketplace/posts, type event) or as an enterprise they keep (/api/treasury/:t/event). */
async function createEvent(grant: AgentGrant, args: Record<string, unknown>): Promise<ToolResult> {
    const refused = gate(grant);
    if (refused) return { ok: false, error: refused };
    const who = authorFor(grant, args.as_enterprise, false);
    if (!who.ok) return who;
    const title = str(args.title, 2000);
    if (!title || !title.trim()) return { ok: false, error: 'A title is required.' };
    const photos = await photosFrom(args.photos);
    if (!photos.ok) return photos;
    if (!admitAgentCreate(grant.id)) {
        return { ok: false, error: `This assistant has made ${AGENT_CREATES_PER_DAY} posts today, the most a day allows: try again tomorrow (UTC).` };
    }
    const owner = grant.member;
    // The body the apps send (routes/event-post.ts reads it): instants, the zone, the place or the link.
    const body = {
        title, description: str(args.description, 20_000) ?? '', photos: photos.photos,
        lat: num(args.lat), lng: num(args.lng),
        eventStartAt: str(args.start_at, 64), eventEndAt: str(args.end_at, 64), eventTz: str(args.timezone, 64),
        eventPlaceName: str(args.place_name, 500), eventOnline: args.online === true, eventLink: str(args.link, 2000),
    };
    const timeOut: EventTimeOut = {};
    try {
        let post;
        if (who.enterprise) {
            const enterprise = who.author;
            assertNotMuted(owner);
            assertNotMuted(enterprise);
            assertMayAddPhotos(owner, Math.min(photos.photos.length, 5));
            const limit = enterprisePostLimit(enterprise, owner);
            post = createEventFromBody(body, enterprise, owner, limit.beforeWrite, timeOut, createdViaOf(grant));
            if (post) limit.stored(post.id);
        } else {
            assertNotMuted(owner);
            assertMayPost(owner, Math.min(photos.photos.length, 5));
            post = createEventFromBody(body, owner, undefined, () => assertMayPostToday(owner), timeOut, createdViaOf(grant));
            if (post) syncPulseMarketplaceGate();
        }
        if (!post) {
            returnAgentCreate(grant.id);
            return { ok: false, error: 'The event could not be made.' };
        }
        return answer(grant, 'event', post.id, who.enterprise);
    } catch (e) {
        returnAgentCreate(grant.id);
        return { ok: false, error: memberErrorText(e, 'The event could not be made: try again later.') };
    }
}

const PHOTOS_SCHEMA = {
    type: 'array', minItems: AGENT_POST_PHOTOS_MIN, maxItems: AGENT_POST_PHOTOS_MAX,
    items: { type: 'string', description: 'a JPEG or WebP image as base64 (data:image/jpeg;base64,… or the bare base64)' },
    description: `1 to ${AGENT_POST_PHOTOS_MAX} photos, required; each at most ${MAX_PHOTO_BASE64_CHARS.toLocaleString('en')} base64 characters and `
        + `${AGENT_PHOTO_MAX_INPUT_SIDE} pixels on its longest side; the server makes each ${PHOTO_MAX_SIDE} px, as the apps do. Never a photo of people `
        + 'you were not given to post.',
};
const LISTING_PROPS = {
    title: { type: 'string', description: 'what it is, in a few words' },
    description: { type: 'string', description: 'the details a member reads' },
    category: { type: 'string', description: 'the Market category (other when left out)' },
    beans: { type: 'number', minimum: 0, description: 'the price in Beans (0 when left out)' },
    price_type: { type: 'string', enum: ['fixed', 'hourly'], description: 'fixed (default) or hourly' },
    repeatable: { type: 'boolean', description: 'stays up after each trade' },
    lat: { type: 'number', description: 'latitude of the place; left out, the author\'s own area' },
    lng: { type: 'number', description: 'longitude of the place; left out, the author\'s own area' },
    photos: PHOTOS_SCHEMA,
};
const POST_OUT = {
    type: 'object',
    properties: {
        postId: { type: 'string' }, kind: { type: 'string' }, asEnterprise: { type: 'boolean' }, link: { type: 'string' },
        postsToday: { type: 'number' }, postsPerDay: { type: 'number' },
    },
    required: ['postId', 'kind', 'asEnterprise', 'link', 'postsToday', 'postsPerDay'],
};
const LIMITS_WORDS = `at most ${AGENT_CREATES_PER_DAY} posts a day, under the member's own posting limits; the post is the owner's, `
    + 'deleted as any post is, and moderators see it was made by an assistant';

/** The rows agent/tools.ts adds to its table: owner-only, all of them. */
export const OWNER_POST_TOOLS: AgentTool[] = [
    {
        name: 'my_enterprises',
        title: 'Enterprises you may post as',
        reads: 'the enterprises the member this assistant acts for keeps now, each with a ref for as_enterprise and its name, fenced',
        never: "an enterprise's key, balance, keepers or listings",
        memberText: true,
        ownerOnly: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: { enterprises: { type: 'array' } }, required: ['enterprises'] },
        run: (grant, _args, boundary) => {
            if (grant.role !== 'owner') return { ok: false, error: "Only an owner's assistant can post: an admin's cannot." };
            const kept = keptEnterprises(grant.member);
            return {
                ok: true, rows: kept.length,
                result: {
                    enterprises: kept.map((e) => {
                        const ref = enterpriseRef(e.key);
                        return { ref, name: fence(boundary, `enterprise ${ref}, name`, cleanMemberText(e.name, 120)) };
                    }),
                    _notice: MEMBER_TEXT_NOTICE,
                },
            };
        },
    },
    {
        name: 'create_offer',
        title: 'Post an Offer',
        reads: `nothing: it posts an Offer in the Market as the member this assistant acts for, with 1 to ${AGENT_POST_PHOTOS_MAX} photos; ${LIMITS_WORDS}`,
        never: "anything but the new post's id and its link, or another member's data",
        ownerOnly: true,
        write: true,
        inputSchema: {
            type: 'object',
            properties: { ...LISTING_PROPS, cash_also_needed: { type: 'boolean', description: 'a real cash outlay is attached (fuel, materials)' } },
            required: ['title', 'photos'],
            additionalProperties: false,
        },
        outputSchema: POST_OUT,
        run: (grant, args) => createListing(grant, { kind: 'offer', args, enterpriseRequired: false }),
    },
    {
        name: 'create_need',
        title: 'Post a Need',
        reads: `nothing: it posts a Need in the Market as the member this assistant acts for, with 1 to ${AGENT_POST_PHOTOS_MAX} photos; ${LIMITS_WORDS}`,
        never: "anything but the new post's id and its link, or another member's data",
        ownerOnly: true,
        write: true,
        inputSchema: {
            type: 'object',
            properties: { ...LISTING_PROPS, cash_also_needed: { type: 'boolean', description: 'a real cash outlay is attached (fuel, materials)' } },
            required: ['title', 'photos'],
            additionalProperties: false,
        },
        outputSchema: POST_OUT,
        run: (grant, args) => createListing(grant, { kind: 'need', args, enterpriseRequired: false }),
    },
    {
        name: 'create_event',
        title: 'Post an event',
        reads: `nothing: it posts an event for this community as the member this assistant acts for, or as an enterprise they keep, with 1 to `
            + `${AGENT_POST_PHOTOS_MAX} photos; ${LIMITS_WORDS}`,
        never: "anything but the new post's id and its link, or another member's data",
        ownerOnly: true,
        write: true,
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'the event\'s name' },
                description: { type: 'string', description: 'what happens, for whom' },
                start_at: { type: 'string', description: 'when it starts: ISO 8601 with its offset, e.g. 2026-11-07T10:00:00+11:00' },
                end_at: { type: 'string', description: 'when it ends (ISO 8601); left out, the server\'s default length' },
                timezone: { type: 'string', description: 'the IANA zone it is in, e.g. Australia/Melbourne' },
                place_name: { type: 'string', description: 'the place, in words' },
                lat: { type: 'number', description: 'latitude of the place (required in person)' },
                lng: { type: 'number', description: 'longitude of the place (required in person)' },
                online: { type: 'boolean', description: 'online instead of in person: no place, a link' },
                link: { type: 'string', description: 'the join link of an online event' },
                as_enterprise: { type: 'string', description: 'host as an enterprise: its ref from my_enterprises' },
                photos: PHOTOS_SCHEMA,
            },
            required: ['title', 'start_at', 'photos'],
            additionalProperties: false,
        },
        outputSchema: POST_OUT,
        run: (grant, args) => createEvent(grant, args),
    },
    {
        name: 'create_enterprise_listing',
        title: "Post an enterprise's Offer or Need",
        reads: `nothing: it posts an Offer or a Need in the Market as an enterprise the member this assistant acts for keeps now (as_enterprise, `
            + `from my_enterprises), with 1 to ${AGENT_POST_PHOTOS_MAX} photos; an enterprise's Need needs a live Offer of its own first; ${LIMITS_WORDS}`,
        never: "anything but the new post's id and its link, an enterprise's key, or another member's data",
        ownerOnly: true,
        write: true,
        inputSchema: {
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['offer', 'need'], description: 'offer or need' },
                as_enterprise: { type: 'string', description: 'the enterprise: its ref from my_enterprises' },
                ...LISTING_PROPS,
                shop_id: { type: 'string', description: "the enterprise's own shop to put an Offer in (optional)" },
            },
            required: ['kind', 'as_enterprise', 'title', 'category', 'photos'],
            additionalProperties: false,
        },
        outputSchema: POST_OUT,
        run: (grant, args) => {
            if (args.kind !== 'offer' && args.kind !== 'need') return { ok: false, error: 'kind must be offer or need.' };
            return createListing(grant, { kind: args.kind, args, enterpriseRequired: true });
        },
    },
];
