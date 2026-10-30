/**
 * An owner's AI assistant posts for them (MCP-OWNER-POSTS; Marty, 30 Oct: "we don't want bulk approval, we want to have an
 * agent use MCP to add a new market listing as needed"): `create_offer`, `create_need`, `create_event` and
 * `create_enterprise_listing`, with `my_enterprises` to name the enterprises it may post as.
 *
 * - Owner grants only, read at call time (grant.role, which agent/mcp-route.ts reads afresh on every request), behind the
 *   owners' switch, the bearer check and the door's 60 a minute and 2,000 a day. An admin's assistant is never offered
 *   them; one that calls them anyway is refused in words.
 * - And only a grant ticked "May post for me" when it was connected (the token form, the consent page; default off: design
 *   Q1, what keeps a leaked read-only token from posting). Without it the tools are not listed (tools.ts toolsFor), and a
 *   call is refused in words.
 * - The node posts on the owner's behalf: the author is the owner's own member key, or an enterprise they keep NOW
 *   (canOperateTreasury, the keepers route's own check), only while the enterprise routes' switches are on (their profile
 *   gate, asked here). No key reaches the assistant: an enterprise is named by a reference made from its key
 *   (enterpriseRef), matched only among the ones the owner keeps.
 * - Each tool runs what its HTTP route runs after the signature check, in the same order and through the same engine call
 *   (routes/marketplace.ts POST /api/marketplace/posts; routes/treasury.ts POST /api/treasury/:treasury/{offer,need,event}),
 *   so the mute and probation limits, the engine's validation (text limits, categories, place, reach, an event's times and
 *   pin), the search index, the sync marks and the standby copy behave as for a post from the phone. A server another took
 *   over (services/identity-epoch.ts) refuses, as its /api/ routes do. One limit differs: a post as the owner is held to the
 *   owners' "Assistant posts a day", not to the member's own 100 (WRITER_LIMITS.postsPerDay), and does not use those up
 *   (the director, 30 Oct, from Marty's "make it 1000 per day … serious seeding on the global node"; engine/writer-bounds.ts).
 *   Its photos still count against the owner's own photo budget (engine/photo-upload-budget.ts), and the assistant is told
 *   in words how much of it is left (connection_info, and the day-full and photo refusals).
 * - Every field the phone's and the web's composer require for that kind is required here too (Marty, 30 Oct: "all the
 *   mandatory fields should be mandatory even if seeding through MCP"): by the tool's input schema and again by the server,
 *   from one list per kind (REQUIRED), each one missing or empty refused in words that name it. Then the values go through
 *   the route's own validator (engine/post-fields.ts assertPostFields, in createPost) like any post's.
 * - Photos are required: 1–4, each a base64 JPEG or WebP of at most the per-photo cap (state-engine.ts
 *   MAX_PHOTO_BASE64_CHARS), made here what the apps send (at most 800 px, no metadata: storage/photo-thumbnails.ts
 *   resizeToStoredPhoto), then held to the routes' photo rule. One the node can't read (cut off after a whole header) is
 *   refused, never stored as sent. No composer offers a preset tile instead of a photo, so neither does this.
 * - The owners' "Assistant posts a day" per grant per UTC day (limits.ts agentPostsPerDay: 100 unless an owner sets 1 to 1,000),
 *   read on every post; one the engine refuses is not counted. Counted in memory as each is admitted (two calls at once
 *   can't both take the last one) and, just before the row is written, from the rows the grant made today, which a
 *   restart keeps.
 * - `use_my_area: true` places a listing at the owner's own area, the point this node keeps for them (engine/member-area.ts),
 *   rounded as the apps round a pin, on every node; with no area set it is refused, naming the fields to send instead.
 * - The row records `created_via = 'assistant:<grant id>'` (schema.sql posts.created_via); the AGENT line of every create
 *   names the post id (mcp-route.ts). Revoking the grant or turning the switch off stops the next call at the door; posts
 *   made stay, and are deleted as any post is.
 * - An answer carries the new post's id and its link in the app (`/?post=<id>`, a path the assistant joins to the address in
 *   its welcome), an event's start and end as its members see them, and the day's count: no key, no token, nothing about
 *   another member. An event's times must carry their offset: one without would be read in this server's own zone.
 */
import crypto from 'node:crypto';
import { approximateLocation, PRICING_CATEGORIES } from '@beanpool/core';
import { db } from '../db/db.js';
import { featureOffMessage, getProfileSwitches } from '../config/node-profile.js';
import { featureOffFor } from '../routes/profile-feature-gate.js';
import { canOperateTreasury, createPost, MAX_PHOTO_BASE64_CHARS } from '../state-engine.js';
import { createEventFromBody } from '../routes/event-post.js';
import type { EventTimeOut } from '../engine/posts.js';
import { assertMayAddPhotos, assertMayPost } from '../engine/probation.js';
import { enterprisePostLimit } from '../engine/writer-bounds.js';
import { assertNotMuted } from '../engine/auto-moderation.js';
import { readMemberArea } from '../engine/member-area.js';
import { memberPhotoRoom, PhotoBudgetExceededError } from '../engine/photo-upload-budget.js';
import { photoRefusalText, routePhotosRefusal, sniffRasterImageType } from '../engine/avatar.js';
import { imageSize } from '../storage/image-metadata.js';
import { loadSharp, PHOTO_MAX_SIDE, resizeToStoredPhoto } from '../storage/photo-thumbnails.js';
import { syncPulseMarketplaceGate } from '../daily-pulse.js';
import { getReplacedInfo } from '../services/identity-epoch.js';
import { memberErrorText } from '../routes/member-error-text.js';
import { cleanMemberText, fence, MEMBER_TEXT_NOTICE } from './fence.js';
import { admitAgentCreate, agentCreatesToday, agentPostsPerDay, returnAgentCreate } from './limits.js';
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

/** The Market's categories, the ones both apps' composers pick from (@beanpool/core PRICING_CATEGORIES). */
export const AGENT_POST_CATEGORIES: readonly string[] = PRICING_CATEGORIES.map((c) => c.id);

/**
 * The fields each kind's composer will not post without, by the tools' own names. Each list is the tool's input schema
 * `required` and the server's re-check (missingField), so the two cannot drift:
 * - an Offer or a Need as the owner, the map's form (phone (tabs)/map.tsx handleSubmit; web MapPage handleCreatePost and
 *   lib/offer-need-submit.ts): a title, a description, a category, a place and a photo, and a price where the node has
 *   Beans (neither app asks one where it has none: phone utils/market-global.ts postFormPriceInvalid). The place is a pin
 *   (lat and lng), or `use_my_area: true` said out loud: the owner's own area, as a listing sent without a pin gets;
 * - an event (phone utils/events.ts buildEventDraft; web MapPage handleCreateEvent): a title, its start, a photo, what
 *   happens and the zone it is in (design §3 item 1: the assistant has no device clock to take one from); in person also
 *   its pin and the place's name (the phone asks for both), online neither. The end is the engine's default length;
 * - an enterprise's Offer or Need (phone treasury-post.tsx; web TreasuryDetailPage handleCreatePost): Offer or Need, the
 *   enterprise, a title, a category, a price of more than 0 Beans and a photo. Neither app asks a place or a description.
 */
export const REQUIRED = {
    listing: ['title', 'description', 'category', 'photos'],
    /** A listing's place: its pin, unless `use_my_area: true` (listingRequiredFor). */
    listingPlace: ['lat', 'lng'],
    /** A listing's price, required where the node has Beans (listingRequired). */
    listingPrice: ['beans'],
    event: ['title', 'description', 'start_at', 'timezone', 'photos'],
    /** An event in person: a JSON Schema `required` cannot say "unless online", so the schema says it in words. */
    eventInPerson: ['place_name', 'lat', 'lng'],
    enterpriseListing: ['kind', 'as_enterprise', 'title', 'category', 'beans', 'photos'],
} as const;

/** What create_offer and create_need require on this node now, in the schema: a price only where it has Beans. */
export function listingRequired(): string[] {
    return getProfileSwitches().beans ? [...REQUIRED.listing, ...REQUIRED.listingPrice] : [...REQUIRED.listing];
}

/** What the server asks of one call: the schema's list, and the pin unless the call says `use_my_area: true`. */
function listingRequiredFor(args: Record<string, unknown>): string[] {
    return args.use_my_area === true ? listingRequired() : [...listingRequired(), ...REQUIRED.listingPlace];
}

/** The composers' title lengths (phone map.tsx's form 50, NewEventModal 140): the engine's own 200 is wider than any app sends. */
export const AGENT_TITLE_MAX = { listing: 50, event: 140 } as const;

function titleTooLong(args: Record<string, unknown>, max: number): string | null {
    const title = (args.title as string).trim();
    return title.length > max ? `title is at most ${max} characters, as the apps' form takes (this one is ${title.length}).` : null;
}

/** A pin rounded to 3 decimals (about 100 m), as both apps round it before sending (@beanpool/core approximateLocation). */
function roundedPin(args: Record<string, unknown>): { lat: number | undefined; lng: number | undefined } {
    const lat = num(args.lat), lng = num(args.lng);
    if (lat === undefined || lng === undefined) return { lat, lng };
    return approximateLocation(lat, lng);
}

const isText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
const isNumber = (v: unknown): boolean => num(v) !== undefined;

/** Each required field: whether a value is there at all, and the words that ask for it. */
const FIELDS: Record<string, { there: (v: unknown) => boolean; asks: string }> = {
    title: { there: isText, asks: 'what it is, in a few words' },
    description: { there: isText, asks: 'the details a member reads' },
    category: { there: isText, asks: `one of ${AGENT_POST_CATEGORIES.join(', ')}` },
    beans: { there: isNumber, asks: 'the price in Beans' },
    lat: { there: isNumber, asks: 'the latitude of the place on the map (or use_my_area: true for your own area)' },
    lng: { there: isNumber, asks: 'the longitude of the place on the map (or use_my_area: true for your own area)' },
    timezone: { there: isText, asks: 'the IANA zone it is in, e.g. Australia/Melbourne' },
    photos: { there: (v) => Array.isArray(v) && v.length > 0, asks: `add 1 to ${AGENT_POST_PHOTOS_MAX} photos first (base64 JPEG or WebP)` },
    start_at: { there: isText, asks: 'when it starts, in ISO 8601 with its offset' },
    place_name: { there: isText, asks: 'the name of the place, e.g. "The old bowls club" (or online: true)' },
    kind: { there: isText, asks: 'offer or need' },
    as_enterprise: { there: isText, asks: 'the enterprise, by its ref from my_enterprises' },
};

/** The first required field left out or empty, refused in words that name it; null when every one is there. */
export function missingField(args: Record<string, unknown>, required: readonly string[]): string | null {
    const field = required.find((k) => !FIELDS[k].there(args[k]));
    return field ? `${field} is required: ${FIELDS[field].asks}.` : null;
}

/** An ISO 8601 date and time with its offset (Z or ±hh:mm): the one kind every server reads as the same instant. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/**
 * The event's start or end sent without its offset, refused in words that name it; null when both carry one (an end left
 * out is the engine's default length). The engine reads such a time in this server's own zone (engine/posts.ts
 * parseEventTime), not the event's: on a UTC host a Melbourne 10:00 would be shown at 21:00, public at once.
 */
function unzonedTime(args: Record<string, unknown>): string | null {
    const field = (['start_at', 'end_at'] as const).find((k) => args[k] !== undefined && args[k] !== '' && !(typeof args[k] === 'string' && ISO_WITH_OFFSET.test(args[k])));
    return field
        ? `${field} must carry its offset from UTC, in ISO 8601: e.g. 2026-11-07T10:00:00+11:00, or Z for UTC. Without one this server would read it in its own time zone.`
        : null;
}

const BLOCKED = new Set(['disabled', 'suspended', 'pruned']);
const statusOf = (pk: string): string | undefined =>
    (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as { status?: string } | undefined)?.status;

/**
 * Why nothing can be posted as an enterprise here now, in its routes' words; null while it can. /api/treasury/* answers 404
 * feature_off while the enterprises or treasuries switch is off (routes/profile-feature-gate.ts, before any handler, and
 * Beans off turns both off): a gate /mcp never meets, so the tools ask it themselves.
 */
function enterprisesOff(): string | null {
    const off = featureOffFor('/api/treasury', undefined, 'POST');
    return off ? featureOffMessage(off) : null;
}

/** The enterprises this member keeps now, as routes/treasury.ts requireOperator would let them act for each; none while they are off. */
function keptEnterprises(member: string): Array<{ key: string; name: string }> {
    if (enterprisesOff()) return [];
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
    const off = enterprisesOff();
    if (off) return { ok: false, error: off };
    if (typeof ref !== 'string') return { ok: false, error: 'as_enterprise is the ref my_enterprises gives.' };
    const hit = keptEnterprises(grant.member).find((e) => enterpriseRef(e.key) === ref.trim());
    if (!hit) return { ok: false, error: 'That is not an enterprise you keep now: my_enterprises lists the ones you may post as.' };
    if (BLOCKED.has(statusOf(grant.member) ?? '')) return { ok: false, error: 'Your account is not active, so you cannot act for this enterprise.' };
    return { ok: true, author: hit.key, enterprise: true };
}

type Photos = { ok: true; photos: string[] } | { ok: false; error: string };

const DATA_URL = /^data:image\/(jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i;
const BASE64 = /^[A-Za-z0-9+/=\s]+$/;
/** `data:image/jpeg;base64,`, as long as WebP's. */
const DATA_PREFIX_CHARS = 'data:image/jpeg;base64,'.length;

/** One photo made what the apps send, or why not. */
async function storablePhoto(value: unknown, n: number): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const which = `Photo ${n}`;
    const formatError = { ok: false as const, error: `${which} must be a JPEG or WebP image, as base64 (a data: URL or the bare base64).` };
    if (typeof value !== 'string' || !value.trim()) return formatError;
    const trimmed = value.trim();
    const m = DATA_URL.exec(trimmed);
    if (!m && (/^data:/i.test(trimmed) || !BASE64.test(trimmed))) return formatError;
    const b64 = m ? m[2] : trimmed;
    // Held to the cap as the data URL it would be stored as (state-engine.ts validatePostPhotos measures the whole value).
    if (DATA_PREFIX_CHARS + b64.length > MAX_PHOTO_BASE64_CHARS) {
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
    // sharp loaded and could not read it: a photo cut off or broken after a whole header, never stored as sent.
    else if (await loadSharp()) return { ok: false, error: `${which} could not be read: send the whole image again.` };
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
    if (!grant.canPost) return NOT_TICKED;
    const replaced = getReplacedInfo();
    if (replaced) return `${replaced.message} This server takes no new posts; use the one that took over.`;
    if (assistantPostsToday(grant) >= agentPostsPerDay()) return dayFull(grant);
    return null;
}

const NOT_TICKED = 'This assistant was connected without "May post for me", so it cannot post. The owner can connect it again with that ticked.';

/** UTC midnight of `now`'s day: the grant's day, as limits.ts counts it. */
const utcMidnight = (now: number): string => `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** The posts this grant made today (UTC), read from their rows (created_via), which a restart keeps. */
function madeToday(grant: AgentGrant, now = Date.now()): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM posts WHERE (author_pubkey = ? OR created_by = ?) AND created_via = ?
        AND origin_node IS NULL AND created_at >= ?`).get(grant.member, grant.member, createdViaOf(grant), utcMidnight(now)) as { c: number }).c;
}

/** The posts this grant made today: the count kept as each is admitted, or its rows when a restart emptied that count. */
export function assistantPostsToday(grant: AgentGrant): number {
    return Math.max(agentCreatesToday(grant.id), madeToday(grant));
}

/**
 * The owners' "Assistant posts a day", just before the row is written (createPost's beforeWrite, once every other refusal
 * has passed), from the rows: what holds an assistant's posts as the owner, in place of the member's own 100.
 */
function assertAssistantDay(grant: AgentGrant): void {
    if (madeToday(grant) >= agentPostsPerDay()) throw new Error(dayFull(grant));
}

/** Today's count, which may be past the number after an owner lowers it, and the number: then the photo room left. */
function dayFull(grant: AgentGrant): string {
    return `This assistant has made ${assistantPostsToday(grant).toLocaleString('en')} posts today, and this community's owners allow `
        + `${agentPostsPerDay().toLocaleString('en')} a day: try again tomorrow (UTC). ${photoRoomWords(grant.member)}`;
}

const MB = 1024 * 1024;
const amount = (bytes: number): string => (bytes >= MB ? `${(bytes / MB).toFixed(1).replace(/\.0$/, '')} MB` : `${Math.round(bytes / 1024)} KB`);

/**
 * The owner's photo room left, in words. Every photo an assistant posts is charged to the owner as stored (engine/posts.ts
 * storedPhotoColumns), against what one member may store in any 24 hours (engine/photo-upload-budget.ts: 100 MB unless
 * the server sets PHOTO_BYTES_PER_MEMBER_PER_DAY), and the owner's own uploads share it.
 */
export function photoRoomWords(member: string): string {
    const room = memberPhotoRoom(member);
    if (!room) return 'Photos have no daily limit on this community.';
    const of = `of the ${amount(room.budget)} of photos a member may store in any 24 hours`;
    return room.left > 0
        ? `The owner has about ${amount(room.left)} of photo room left, ${of} (each photo counts as stored, at most ${PHOTO_MAX_SIDE} px).`
        : `The owner has no photo room left, ${of}.`;
}

/** A refusal's words for the assistant: the photo budget's also says how much room is left. */
function refusalText(e: unknown, grant: AgentGrant, fallback: string): string {
    const text = memberErrorText(e, fallback);
    return e instanceof PhotoBudgetExceededError ? `${text} ${photoRoomWords(grant.member)}` : text;
}

/** Said with use_my_area: true when the owner has no area on this node. */
const NO_AREA = 'use_my_area needs your area, and none is set on this community: give lat and lng, or set your area in the app first.';

/** An event's start and end as stored: the clock its members see, in its zone, so the assistant can check what it posted. */
type EventClock = { startsLocal: string; endsLocal: string; timezone: string };

function answer(grant: AgentGrant, kind: 'offer' | 'need' | 'event', postId: string, asEnterprise: boolean, clock?: EventClock): ToolResult {
    return {
        ok: true, rows: 1,
        result: {
            postId, kind, asEnterprise,
            link: `/?post=${encodeURIComponent(postId)}`,
            ...clock,
            postsToday: assistantPostsToday(grant), postsPerDay: agentPostsPerDay(),
        },
    };
}

interface ListingArgs {
    kind: 'offer' | 'need';
    args: Record<string, unknown>;
    /** As an enterprise the owner keeps (create_enterprise_listing), not as the owner. */
    enterprise: boolean;
}

/** An Offer or a Need, as the owner (POST /api/marketplace/posts) or as an enterprise they keep (/api/treasury/:t/{offer,need}). */
async function createListing(grant: AgentGrant, { kind, args, enterprise: asEnterprise }: ListingArgs): Promise<ToolResult> {
    // An enterprise's listing meets its routes' switch first, as their gate runs before the handler.
    const refused = gate(grant) ?? (asEnterprise ? enterprisesOff() : null);
    if (refused) return { ok: false, error: refused };
    const missing = missingField(args, asEnterprise ? REQUIRED.enterpriseListing : listingRequiredFor(args))
        ?? titleTooLong(args, AGENT_TITLE_MAX.listing);
    if (missing) return { ok: false, error: missing };
    if (asEnterprise && args.kind !== 'offer' && args.kind !== 'need') return { ok: false, error: 'kind must be offer or need.' };
    const who = authorFor(grant, args.as_enterprise, asEnterprise);
    if (!who.ok) return who;
    // Said out loud, the owner's own area: the point this node keeps for them (engine/member-area.ts), on every node,
    // whether or not it syncs by area. With none set there is no place to give the listing, so it is refused before anything.
    const area = args.use_my_area === true && !who.enterprise ? readMemberArea(grant.member) : undefined;
    if (area === null) return { ok: false, error: NO_AREA };
    // Trimmed as both apps send them; held to the route's own limits by createPost (engine/post-fields.ts), never cut here.
    const title = (args.title as string).trim();
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    const category = (args.category as string).trim();
    if (!AGENT_POST_CATEGORIES.includes(category)) {
        return { ok: false, error: `category must be one of ${AGENT_POST_CATEGORIES.join(', ')}, as the apps offer.` };
    }
    const credits = num(args.beans) ?? 0;
    // Both apps' enterprise forms ask a price of more than 0 (treasury-post.tsx, TreasuryDetailPage); a member's own may be 0.
    if (who.enterprise && credits <= 0) return { ok: false, error: "beans must be more than 0: an enterprise's listing has a price, as its form asks." };
    const shopId = str(args.shop_id, 200);
    const photos = await photosFrom(args.photos);
    if (!photos.ok) return photos;
    // Counted before the post is made, so two calls at once cannot both take the last one; given back when it is not made.
    if (!admitAgentCreate(grant.id)) {
        return { ok: false, error: dayFull(grant) };
    }
    const owner = grant.member;
    // The area rounded as the apps round a pin (@beanpool/core approximateLocation).
    const { lat, lng } = area ? approximateLocation(area.lat, area.lng) : roundedPin(args);
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
            post = createPost(kind, category, title, description, credits, priceType, enterprise, lat, lng,
                photos.photos, repeatable, undefined, undefined,
                { createdBy: owner, beforeWrite: () => { assertAssistantDay(grant); limit.beforeWrite(); }, shopId, createdVia: createdViaOf(grant) });
            if (post) limit.stored(post.id);
        } else {
            assertNotMuted(owner);
            assertMayPost(owner, Math.min(photos.photos.length, 5));
            // The owners' "Assistant posts a day", in place of the member's own 100 (the director, 30 Oct).
            post = createPost(kind, category, title, description, credits, priceType, owner, lat, lng,
                photos.photos, args.repeatable === true, undefined, args.cash_also_needed === true,
                { beforeWrite: () => assertAssistantDay(grant), createdVia: createdViaOf(grant) });
            if (post) syncPulseMarketplaceGate();
        }
        if (!post) {
            returnAgentCreate(grant.id);
            return { ok: false, error: kind === 'need' && who.enterprise ? 'The enterprise needs a live Offer before it can post a Need.' : 'The post could not be made.' };
        }
        return answer(grant, kind, post.id, who.enterprise);
    } catch (e) {
        returnAgentCreate(grant.id);
        return { ok: false, error: refusalText(e, grant, 'The post could not be made: try again later.') };
    }
}

/** An event, as the owner (POST /api/marketplace/posts, type event) or as an enterprise they keep (/api/treasury/:t/event). */
async function createEvent(grant: AgentGrant, args: Record<string, unknown>): Promise<ToolResult> {
    const refused = gate(grant);
    if (refused) return { ok: false, error: refused };
    const missing = missingField(args, args.online === true ? REQUIRED.event : [...REQUIRED.event, ...REQUIRED.eventInPerson])
        ?? titleTooLong(args, AGENT_TITLE_MAX.event) ?? unzonedTime(args);
    if (missing) return { ok: false, error: missing };
    const who = authorFor(grant, args.as_enterprise, false);
    if (!who.ok) return who;
    const photos = await photosFrom(args.photos);
    if (!photos.ok) return photos;
    if (!admitAgentCreate(grant.id)) {
        return { ok: false, error: dayFull(grant) };
    }
    const owner = grant.member;
    // The body the apps send (routes/event-post.ts reads it): instants, the zone, the place or the link; the text trimmed as
    // both apps trim it.
    const body = {
        title: (args.title as string).trim(), description: typeof args.description === 'string' ? args.description.trim() : '', photos: photos.photos,
        ...roundedPin(args),
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
            post = createEventFromBody(body, enterprise, owner, () => { assertAssistantDay(grant); limit.beforeWrite(); }, timeOut, createdViaOf(grant));
            if (post) limit.stored(post.id);
        } else {
            assertNotMuted(owner);
            assertMayPost(owner, Math.min(photos.photos.length, 5));
            post = createEventFromBody(body, owner, undefined, () => assertAssistantDay(grant), timeOut, createdViaOf(grant));
            if (post) syncPulseMarketplaceGate();
        }
        if (!post) {
            returnAgentCreate(grant.id);
            return { ok: false, error: 'The event could not be made.' };
        }
        const { eventStartLocal, eventEndLocal, eventTz } = post;
        return answer(grant, 'event', post.id, who.enterprise,
            eventStartLocal && eventEndLocal && eventTz ? { startsLocal: eventStartLocal, endsLocal: eventEndLocal, timezone: eventTz } : undefined);
    } catch (e) {
        returnAgentCreate(grant.id);
        return { ok: false, error: refusalText(e, grant, 'The event could not be made: try again later.') };
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
    title: { type: 'string', maxLength: AGENT_TITLE_MAX.listing, description: `what it is, in a few words: at most ${AGENT_TITLE_MAX.listing} characters` },
    description: { type: 'string', description: 'the details a member reads' },
    category: { type: 'string', enum: AGENT_POST_CATEGORIES, description: 'the Market category, as the apps offer them' },
    beans: { type: 'number', minimum: 0, description: 'the price in Beans (0 is free); required where this community has Beans, none where it has not' },
    price_type: { type: 'string', enum: ['fixed', 'hourly'], description: 'fixed (default) or hourly' },
    repeatable: { type: 'boolean', description: 'stays up after each trade' },
    lat: { type: 'number', description: 'latitude of the place on the map, rounded to about 100 m as the apps do; required unless use_my_area' },
    lng: { type: 'number', description: 'longitude of the place on the map, rounded the same; required unless use_my_area' },
    photos: PHOTOS_SCHEMA,
};
/** create_offer's and create_need's input, made when the tools are listed: a price is required only where Beans are on. */
function ownerListingSchema(): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            ...LISTING_PROPS,
            use_my_area: { type: 'boolean', description: 'true: no pin, placed at your own area (the one set in the app, rounded as a pin is); then lat and lng are not asked. Refused when no area is set' },
            cash_also_needed: { type: 'boolean', description: 'a real cash outlay is attached (fuel, materials)' },
        },
        // The pin (lat, lng) is required too unless use_my_area is true (REQUIRED.listingPlace): a JSON Schema `required` cannot say "unless".
        required: listingRequired(),
        additionalProperties: false,
    };
}
const POST_OUT = {
    type: 'object',
    properties: {
        postId: { type: 'string' }, kind: { type: 'string' }, asEnterprise: { type: 'boolean' }, link: { type: 'string' },
        startsLocal: { type: 'string', description: "an event's: when it starts as members see it, YYYY-MM-DDTHH:MM in its timezone" },
        endsLocal: { type: 'string', description: "an event's: when it ends, the same way" },
        timezone: { type: 'string', description: "an event's: the IANA zone its times are shown in" },
        postsToday: { type: 'number' }, postsPerDay: { type: 'number' },
    },
    required: ['postId', 'kind', 'asEnterprise', 'link', 'postsToday', 'postsPerDay'],
};
const LIMITS_WORDS = "at most the posts a day this community's owners set (connection_info's posts.perDay), which never use up the member's own "
    + "posts a day from the apps; its photos count against the member's photo room (connection_info's posts.photoRoom); the post is the "
    + "owner's, deleted as any post is, and moderators see it was made by an assistant";

/** The rows agent/tools.ts adds to its table: owner-only, all of them. */
export const OWNER_POST_TOOLS: AgentTool[] = [
    {
        name: 'my_enterprises',
        title: 'Enterprises you may post as',
        reads: 'the enterprises the member this assistant acts for keeps now, each with a ref for as_enterprise and its name, fenced',
        never: "an enterprise's key, balance, keepers or listings",
        memberText: true,
        ownerOnly: true,
        posts: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: { enterprises: { type: 'array' } }, required: ['enterprises'] },
        run: (grant, _args, boundary) => {
            if (grant.role !== 'owner') return { ok: false, error: "Only an owner's assistant can post: an admin's cannot." };
            if (!grant.canPost) return { ok: false, error: NOT_TICKED };
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
        posts: true,
        write: true,
        // Read each time the tools are listed (agent/mcp-route.ts): whether a price is required follows the Beans switch.
        get inputSchema() { return ownerListingSchema(); },
        outputSchema: POST_OUT,
        // As the owner only: an enterprise's Offer is create_enterprise_listing's.
        run: (grant, args) => createListing(grant, { kind: 'offer', args: { ...args, as_enterprise: undefined, shop_id: undefined }, enterprise: false }),
    },
    {
        name: 'create_need',
        title: 'Post a Need',
        reads: `nothing: it posts a Need in the Market as the member this assistant acts for, with 1 to ${AGENT_POST_PHOTOS_MAX} photos; ${LIMITS_WORDS}`,
        never: "anything but the new post's id and its link, or another member's data",
        ownerOnly: true,
        posts: true,
        write: true,
        get inputSchema() { return ownerListingSchema(); },
        outputSchema: POST_OUT,
        // As the owner only: an enterprise's Need is create_enterprise_listing's.
        run: (grant, args) => createListing(grant, { kind: 'need', args: { ...args, as_enterprise: undefined, shop_id: undefined }, enterprise: false }),
    },
    {
        name: 'create_event',
        title: 'Post an event',
        reads: `nothing: it posts an event for this community as the member this assistant acts for, or as an enterprise they keep, with 1 to `
            + `${AGENT_POST_PHOTOS_MAX} photos; ${LIMITS_WORDS}`,
        never: "anything but the new post's id and its link, or another member's data",
        ownerOnly: true,
        posts: true,
        write: true,
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', maxLength: AGENT_TITLE_MAX.event, description: `the event's name: at most ${AGENT_TITLE_MAX.event} characters` },
                description: { type: 'string', description: 'what happens, for whom' },
                start_at: { type: 'string', description: 'when it starts: ISO 8601 with its offset, e.g. 2026-11-07T10:00:00+11:00 (Z for UTC); one without is refused' },
                end_at: { type: 'string', description: 'when it ends: ISO 8601 with its offset, as start_at; left out, the server\'s default length' },
                timezone: { type: 'string', description: 'the IANA zone it is in, e.g. Australia/Melbourne' },
                place_name: { type: 'string', description: 'the name of the place: required in person (the default), none online' },
                lat: { type: 'number', description: 'latitude of the place on the map, rounded to about 100 m as the apps do: required in person, none online' },
                lng: { type: 'number', description: 'longitude of the place on the map, rounded the same: required in person, none online' },
                online: { type: 'boolean', description: 'online instead of in person: no place, a link' },
                link: { type: 'string', description: 'the join link of an online event' },
                as_enterprise: { type: 'string', description: 'host as an enterprise: its ref from my_enterprises' },
                photos: PHOTOS_SCHEMA,
            },
            // In person (online not true) place_name, lat and lng are required too (REQUIRED.eventInPerson), in their words.
            required: [...REQUIRED.event],
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
        posts: true,
        write: true,
        inputSchema: {
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['offer', 'need'], description: 'offer or need' },
                as_enterprise: { type: 'string', description: 'the enterprise: its ref from my_enterprises' },
                ...LISTING_PROPS,
                beans: { type: 'number', exclusiveMinimum: 0, description: 'the price in Beans, more than 0' },
                lat: { type: 'number', description: "latitude of the place; left out, the enterprise's own area" },
                lng: { type: 'number', description: "longitude of the place; left out, the enterprise's own area" },
                shop_id: { type: 'string', description: "the enterprise's own shop to put an Offer in (optional)" },
            },
            required: [...REQUIRED.enterpriseListing],
            additionalProperties: false,
        },
        outputSchema: POST_OUT,
        run: (grant, args) => createListing(grant, { kind: args.kind === 'need' ? 'need' : 'offer', args, enterprise: true }),
    },
];
