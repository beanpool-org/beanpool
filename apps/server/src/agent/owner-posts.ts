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
 * - Photos are required: 1–4, from three fields together: `photos`, each a base64 JPEG or WebP of at most the per-photo cap
 *   (state-engine.ts MAX_PHOTO_BASE64_CHARS); `photo_urls`, public addresses this server fetches; `photo_ids`, photos
 *   uploaded first to POST /mcp/photos or a photo link (slice S4, agent/owner-photos.ts: a hosted assistant can't write a photo's
 *   base64, and `photo_upload_link` makes the link).
 *   Each made here what the apps send (at most 800 px, no metadata: storage/photo-thumbnails.ts resizeToStoredPhoto), then
 *   held to the routes' photo rule. One the node can't read (cut off after a whole header) is refused, never stored as
 *   sent. No composer offers a preset tile instead of a photo, so neither does this.
 * - The owners' "Assistant posts a day" per grant per UTC day (limits.ts agentPostsPerDay: 100 unless an owner sets 1 to 1,000),
 *   read on every post; one the engine refuses is not counted. Counted in memory as each is admitted (two calls at once
 *   can't both take the last one) and, just before the row is written, from the rows the grant made today, which a
 *   restart keeps.
 * - `use_my_area: true` places a listing at the owner's own area, the point this node keeps for them (engine/member-area.ts),
 *   rounded as the apps round a pin, on every node; with no area set it is refused, naming the fields to send instead.
 * - The row records `created_via = 'assistant:<grant id>'` (schema.sql posts.created_via); the AGENT line of every create
 *   names the post id (mcp-route.ts). Revoking the grant or turning the switch off stops the next call at the door; posts
 *   made stay, and are deleted as any post is.
 * - Slice S2 (design §2.3, §2.7): `my_posts`, `update_post`, `remove_post` and `remove_all_i_made` act only on a post THIS
 *   grant made (created_via = 'assistant:<this grant id>'), still by the owner or an enterprise they keep now: never another
 *   member's post, nor one the owner made in the app, nor another assistant's. Through the routes' own engine calls
 *   (updatePost, removePost): an edit holds to the create's fields, a deal in escrow keeps a post up, and no tool moves a
 *   Bean. 200 edits a day; remove_all_i_made once a day. The owner's own "Remove its posts" in Settings
 *   (agent/grants-route.ts) runs the same removal (removeAllMadeBy), for a disconnected assistant too, and both write an
 *   ADMIN line naming the ids removed.
 * - Tags T4 (DESIGN-tags-free-entry-fable.md §8, §5; DESIGN-owner-seeding-tags-fable.md §2.6): every create and update_post takes
 *   `tags`, ids from the library in core (tags_search, agent/owner-reads.ts, finds them), and `free_tags`, the words the
 *   library lacks, each held to core's rule through the engine's own check (engine/post-fields.ts assertFreeTags). Neither is
 *   required: a listing posts with none, as in the composer. Both are held before a photo is fetched or an upload claimed
 *   (heldTags), refused in the tool's words and never dropped: an unknown id with the three nearest (nearestTagIds). An edit
 *   that names neither leaves them; [] clears; a tag the listing already carries passes, as in the apps; null on an edit is
 *   refused, since a client that fills every field would otherwise clear them unasked. The tools' words say library first,
 *   and that a list of tags never goes in a description, which is what assistants did before this.
 * - An answer carries the new post's id and its link in the app (`/?post=<id>`, a path the assistant joins to the address in
 *   its welcome), an event's start and end as its members see them, and the day's count: no key, no token, nothing about
 *   another member. An event's times must carry their offset: one without would be read in this server's own zone.
 */
import crypto from 'node:crypto';
import {
    approximateLocation, FREE_TAG_MAX_CHARS, FREE_TAG_MAX_WORDS, FREE_TAG_MIN_CHARS, FREE_TAGS_MAX, freeTagsOf, isTagId, plainWords, POST_TAGS_MAX, postTagsOf,
    PRICING_CATEGORIES, singulars, TAG_LIBRARY, tagIndex,
} from '@beanpool/core';
import { db } from '../db/db.js';
import { featureOffMessage, getProfileSwitches } from '../config/node-profile.js';
import { featureOffFor } from '../routes/profile-feature-gate.js';
import { canOperateTreasury, createPost, MAX_PHOTO_BASE64_CHARS, removePost, updatePost } from '../state-engine.js';
import { logger } from '../logger.js';
import { createEventFromBody } from '../routes/event-post.js';
import type { EventTimeOut } from '../engine/posts.js';
import { assertFreeTags } from '../engine/post-fields.js';
import { assertMayAddPhotos, assertMayEditPhotos, assertMayPost } from '../engine/probation.js';
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
import {
    admitAgentCreate, admitAgentEdit, admitAgentRemoveAll, agentCreatesToday, agentEditsToday, agentPhotosToday, agentPostsPerDay, returnAgentCreate,
    returnAgentEdit, AGENT_EDITS_PER_DAY, AGENT_LIST_MAX, agentPhotosPerDay,
} from './limits.js';
import {
    claimUploadedPhotos, fetchPhoto, issuePhotoLink, photoDayFull, PHOTO_LINK_CURL, PHOTO_LINK_KEEP_MS, PHOTO_LINK_PATH, PHOTO_LINKS_PER_GRANT,
    PHOTO_SOURCE_MAX_BYTES, PHOTO_UPLOAD_KEEP_MS,
} from './owner-photos.js';
import { grantStillLive } from './suggestions.js';
import { listOAuthGrants } from './oauth.js';
import { listAutomationTokens } from '../automation-tokens.js';
import { getLocalConfig } from '../config/local-config.js';
import type { AgentGrant, AgentTool, ToolResult } from './tools.js';

export const AGENT_POST_PHOTOS_MIN = 1;
export const AGENT_POST_PHOTOS_MAX = 4;
/** The shortest side a photo may arrive with: at least 200 px on its shorter side. */
export const AGENT_PHOTO_MIN_SIDE = 200;
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
 *   enterprise, a title, a category, a price of more than 0 Beans where the node has Beans (Marty, 31 Oct: none asked where
 *   it has none, as for a member's own) and a photo. Neither app asks a place or a description.
 * A photo may come from any of three fields (photos, photo_urls, photo_ids), so `photos` is the server's check of all three
 * (photoCount) and the schemas say it in words: a JSON Schema `required` cannot say "one of" (schemaRequired).
 */
export const REQUIRED = {
    listing: ['title', 'description', 'category', 'photos'],
    /** A listing's place: its pin, unless `use_my_area: true` (listingRequiredFor). */
    listingPlace: ['lat', 'lng'],
    /** A listing's price, required where the node has Beans (listingRequired, enterpriseListingRequired). */
    listingPrice: ['beans'],
    event: ['title', 'description', 'start_at', 'timezone', 'photos'],
    /** An event in person: a JSON Schema `required` cannot say "unless online", so the schema says it in words. */
    eventInPerson: ['place_name', 'lat', 'lng'],
    enterpriseListing: ['kind', 'as_enterprise', 'title', 'category', 'photos'],
} as const;

/** What create_offer and create_need require on this node now: a price only where it has Beans. */
export function listingRequired(): string[] {
    return getProfileSwitches().beans ? [...REQUIRED.listing, ...REQUIRED.listingPrice] : [...REQUIRED.listing];
}

/**
 * What create_enterprise_listing requires on this node now: a price of more than 0 only where it has Beans. (Beans off
 * turns enterprises off too, config/node-profile.ts lockToLedger, and the tool is then refused before its price is read.)
 */
export function enterpriseListingRequired(): string[] {
    return getProfileSwitches().beans ? [...REQUIRED.enterpriseListing, ...REQUIRED.listingPrice] : [...REQUIRED.enterpriseListing];
}

/** A tool schema's `required`: every field the server asks for but `photos`, which any of three fields gives. */
function schemaRequired(fields: readonly string[]): string[] {
    return fields.filter((f) => f !== 'photos');
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
    // Read for the whole call, not one field: any of the three photo fields (missingField).
    photos: {
        there: () => false,
        asks: `add 1 to ${AGENT_POST_PHOTOS_MAX} photos first: photo_urls (public addresses of images this server fetches), photo_ids (uploaded `
            + 'first, to an address photo_upload_link gives or to /mcp/photos) or photos (base64 JPEG or WebP)',
    },
    start_at: { there: isText, asks: 'when it starts, in ISO 8601 with its offset' },
    place_name: { there: isText, asks: 'the name of the place, e.g. "The old bowls club" (or online: true)' },
    kind: { there: isText, asks: 'offer or need' },
    as_enterprise: { there: isText, asks: 'the enterprise, by its ref from my_enterprises' },
};

/** The first required field left out or empty, refused in words that name it; null when every one is there. */
export function missingField(args: Record<string, unknown>, required: readonly string[]): string | null {
    const field = required.find((k) => !(k === 'photos' ? photoCount(args) > 0 : FIELDS[k].there(args[k])));
    return field ? `${field} is required: ${FIELDS[field].asks}.` : null;
}

const PHOTO_FIELDS = ['photos', 'photo_urls', 'photo_ids'] as const;

/** How many photos a call sends, from the three fields together (a field that is not a list counts its one value). */
function photoCount(args: Record<string, unknown>): number {
    return PHOTO_FIELDS.reduce((n, k) => n + (Array.isArray(args[k]) ? (args[k] as unknown[]).length : args[k] === undefined || args[k] === null ? 0 : 1), 0);
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

/**
 * The library's tags for some words, nearest first: the index the pickers read (@beanpool/core tagIndex; a server's is the
 * English labels, aliases and synonym words), on the whole text, then on each word and an English plural's singular, since it
 * matches a label from what it is given: "lemons" alone finds nothing, nor does "sourdough bread". Never a top.
 */
export function libraryTagsFor(text: string): string[] {
    const index = tagIndex();
    const found = new Set(index.search(text, TAG_LIBRARY.length));
    for (const word of plainWords(text)) {
        for (const q of [word, ...singulars(word)]) for (const id of index.search(q, TAG_LIBRARY.length)) found.add(id);
    }
    return [...found];
}

/** How many letters apart two ids are (Levenshtein). */
function lettersApart(a: string, b: string): number {
    let above = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const line = [i];
        for (let j = 1; j <= b.length; j++) line[j] = Math.min(above[j] + 1, line[j - 1] + 1, above[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        above = line;
    }
    return above[b.length];
}

/** The longest an id or a free tag is read and said back in a refusal. */
const REFUSED_ID_CHARS = 80;
const REFUSED_TAG_CHARS = 40;

/**
 * The three tags nearest an id the library does not have: those its last part names (the most specific: `food.fruit.lemons`,
 * or a plain word sent as an id), then the closest spellings of the whole id. Never a top: the category is its own field.
 */
export function nearestTagIds(id: string): string[] {
    const typed = id.slice(0, REFUSED_ID_CHARS).toLowerCase();
    const spelt = TAG_LIBRARY.filter((tag) => tag.id.includes('.'))
        .map((tag) => ({ id: tag.id, apart: lettersApart(typed, tag.id) }))
        .sort((a, b) => a.apart - b.apart)
        .map((tag) => tag.id);
    return [...new Set([...libraryTagsFor(typed.slice(typed.lastIndexOf('.') + 1)), ...spelt])].slice(0, 3);
}

function unknownTagWords(id: string): string {
    const near = nearestTagIds(id);
    return `tags: there is no library tag "${cleanMemberText(id, REFUSED_ID_CHARS)}". The nearest are ${near.slice(0, -1).join(', ')} and ${near[near.length - 1]}: `
        + 'send one of those, find others with tags_search, or put what the library lacks in free_tags.';
}

/** The tags on a create or an edit, by the names the engine takes them under: a field left out is left out here. */
interface TagFields { tags?: string[]; freeTags?: string[] }
type HeldTags = { ok: true; fields: TagFields } | { ok: false; error: string };

/** The words of a refusal the engine throws; null when it passes. */
function refusedBy(check: () => unknown): string | null {
    try {
        check();
        return null;
    } catch (e) {
        return memberErrorText(e, 'that tag cannot be used');
    }
}

/**
 * A call's `tags` and `free_tags`, held before anything is spent on it (a photo fetched, an upload claimed, one of the day's
 * posts or edits), or why not in the tool's words: createPost and updatePost hold them again, as any post's. `stored` is the
 * listing an edit changes, whose own tags pass as the engine passes them; on an edit null is refused, as it is for a title.
 */
function heldTags(args: Record<string, unknown>, stored?: { tags?: string; free_tags?: string }): HeldTags {
    const fields: TagFields = {};
    const refuse = (error: string): HeldTags => ({ ok: false, error });
    for (const [field, max, what] of [['tags', POST_TAGS_MAX, 'library ids from tags_search'], ['free_tags', FREE_TAGS_MAX, 'tags, each one text']] as const) {
        const sent = args[field];
        if (sent === undefined || (sent === null && !stored)) continue;
        if (sent === null) return refuse(`${field} is a list: send [] to take them all off, or leave it out to keep them.`);
        if (!Array.isArray(sent)) return refuse(`${field} is a list of ${what}.`);
        // At most this many are read, however many a call sends.
        if (sent.length > max) return refuse(`${field}: at most ${max} on a listing (this call sends ${sent.length}): take some off.`);
        if (sent.some((v) => typeof v !== 'string')) return refuse(`${field} is a list of ${what}.`);
        if (field === 'tags') {
            const kept = postTagsOf(stored?.tags);
            const unknown = (sent as string[]).find((id) => !isTagId(id) && !kept.includes(id));
            if (unknown !== undefined) return refuse(unknownTagWords(unknown));
            fields.tags = sent;
        } else {
            const kept = freeTagsOf(stored?.free_tags);
            for (const text of sent as string[]) {
                const why = refusedBy(() => assertFreeTags([text], kept));
                if (why) return refuse(`free_tags: "${cleanMemberText(text, REFUSED_TAG_CHARS)}" is refused: ${why}`);
            }
            const together = refusedBy(() => { fields.freeTags = assertFreeTags(sent, kept); });
            if (together) return refuse(`free_tags: ${together}`);
        }
    }
    return { ok: true, fields };
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

/** The photos a post is made with, and `settle`, called once it is made or refused: an uploaded one is used up only when made. */
type Photos = { ok: true; photos: string[]; settle: (made: boolean) => void } | { ok: false; error: string };
type Stored = { ok: true; value: string } | { ok: false; error: string };

const DATA_URL = /^data:image\/(jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i;
const BASE64 = /^[A-Za-z0-9+/=\s]+$/;
/** `data:image/jpeg;base64,`, as long as WebP's. */
const DATA_PREFIX_CHARS = 'data:image/jpeg;base64,'.length;

/** A refusal's words for a photo, by where it came from: base64 in the call, an address fetched, or an upload. */
export interface ImageWords {
    /** "Photo 1", "photo_urls #2", "The upload". */
    which: string;
    /** Not an image this server stores. */
    format: string;
    /** Wider or taller than the decoder takes. */
    tooWide: (size: { width: number; height: number }) => string;
    /** Its header reads, the rest does not. */
    unreadable: string;
    /** A PNG is taken (and stored as a JPEG): from an address or an upload, never base64 (the S1 tools' rule, unchanged). */
    png: boolean;
}

/**
 * Image bytes made what the apps send (at most 800 px on its longest side, upright, no metadata: a JPEG or a WebP), or why
 * not in `words`: sniffed, whatever the sender said it was; at most AGENT_PHOTO_MAX_INPUT_SIDE a side, the decoder's
 * ceiling (storage/photo-thumbnails.ts); one resize at a time. Base64 photos, fetched ones and uploads alike.
 */
export async function storableImage(bytes: Buffer, words: ImageWords): Promise<Stored> {
    const sniffed = sniffRasterImageType(bytes);
    const kind = sniffed === 'image/jpeg' || sniffed === 'image/webp' || (words.png && sniffed === 'image/png') ? sniffed : null;
    if (!kind) return { ok: false, error: words.format };
    const size = imageSize(bytes);
    if (!size) return { ok: false, error: words.format };
    if (Math.max(size.width, size.height) > AGENT_PHOTO_MAX_INPUT_SIDE) return { ok: false, error: words.tooWide(size) };
    if (Math.min(size.width, size.height) < AGENT_PHOTO_MIN_SIDE) {
        return { ok: false, error: `${words.which} is too small: send one at least ${AGENT_PHOTO_MIN_SIDE} pixels on its shorter side.` };
    }
    // A PNG is stored as a JPEG, as the apps send one.
    const format = kind === 'image/webp' ? 'webp' : 'jpeg';
    const resized = await resizeToStoredPhoto(bytes, format);
    let out: Buffer;
    if (resized) out = resized;
    // sharp loaded and could not read it: a photo cut off or broken after a whole header, never stored as sent.
    else if (await loadSharp()) return { ok: false, error: words.unreadable };
    // No resizer on this host (sharp would not load): a photo already the apps' size is stored as they send it, its
    // metadata stripped at the store as every upload's is (storage/image-columns.ts storeUploadedPhotoColumns). A PNG
    // can't be made a JPEG without it.
    else if (kind === 'image/png') return { ok: false, error: `This server cannot convert a PNG now: send ${words.which.toLowerCase()} as a JPEG or WebP.` };
    else if (Math.max(size.width, size.height) <= PHOTO_MAX_SIDE) out = bytes;
    else return { ok: false, error: `This server cannot resize photos now: send ${words.which.toLowerCase()} at most ${PHOTO_MAX_SIDE} pixels on its longest side.` };
    return { ok: true, value: `data:image/${format};base64,${out.toString('base64')}` };
}

/** One base64 photo made what the apps send, or why not (the S1 tools' words, unchanged). */
async function storablePhoto(value: unknown, n: number): Promise<Stored> {
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
    return storableImage(Buffer.from(b64, 'base64'), {
        which, format: formatError.error, png: false,
        tooWide: (size) => `${which} is ${size.width} × ${size.height} pixels: send it at most ${AGENT_PHOTO_MAX_INPUT_SIDE.toLocaleString('en')} on its longest side (${PHOTO_MAX_SIDE} is what the apps send).`,
        unreadable: `${which} could not be read: send the whole image again.`,
    });
}

/** The words for a photo this server fetched or was sent as an upload. */
export function sourceImageWords(which: string, from: 'address' | 'upload'): ImageWords {
    const give = from === 'address' ? 'the address must give' : 'send';
    return {
        which, png: true,
        format: `${which} is not an image: ${give} a JPEG, WebP or PNG.`,
        tooWide: (size) => `${which} is ${size.width} × ${size.height} pixels: at most ${AGENT_PHOTO_MAX_INPUT_SIDE.toLocaleString('en')} on its longest side `
            + `(${PHOTO_MAX_SIDE} is what the apps send). ${from === 'address' ? 'Give the address of a smaller copy' : 'Send a smaller copy'}.`,
        unreadable: `${which} is not an image this server can read: ${give} a whole JPEG, WebP or PNG.`,
    };
}

/**
 * 1–4 photos, from `photos` (base64), `photo_urls` (fetched here) and `photo_ids` (uploaded first) together, in that order,
 * each made what the apps send and held to the routes' photo rule (engine/avatar.ts routePhotosRefusal). The uploads are
 * held for this post until `settle`; the addresses are fetched last, each counted against the grant's photos for the day,
 * all refused before any is fetched when the day has no room for them.
 */
async function photosFrom(grant: AgentGrant, args: Record<string, unknown>): Promise<Photos> {
    for (const k of PHOTO_FIELDS) {
        if (args[k] !== undefined && args[k] !== null && !Array.isArray(args[k])) return { ok: false, error: `${k} is a list.` };
    }
    const list = (k: (typeof PHOTO_FIELDS)[number]): unknown[] => (Array.isArray(args[k]) ? args[k] as unknown[] : []);
    const inline = list('photos'), urls = list('photo_urls'), ids = list('photo_ids');
    const total = inline.length + urls.length + ids.length;
    if (total < AGENT_POST_PHOTOS_MIN) {
        return { ok: false, error: `Add a photo first: every Offer, Need and event needs 1 to ${AGENT_POST_PHOTOS_MAX} photos, from photo_urls, photo_ids or photos.` };
    }
    if (total > AGENT_POST_PHOTOS_MAX) return { ok: false, error: `At most ${AGENT_POST_PHOTOS_MAX} photos a post, photos, photo_urls and photo_ids together.` };
    if (urls.length && agentPhotosToday(grant.id) + urls.length > agentPhotosPerDay()) return { ok: false, error: photoDayFull(grant.id) };
    const uploads = claimUploadedPhotos(grant.id, ids);
    if (!uploads.ok) return uploads;
    const refuse = (error: string): Photos => {
        uploads.settle(false);
        return { ok: false, error };
    };
    try {
        const photos: string[] = [];
        for (let i = 0; i < inline.length; i++) {
            const one = await storablePhoto(inline[i], i + 1);
            if (!one.ok) return refuse(one.error);
            photos.push(one.value);
        }
        for (let i = 0; i < urls.length; i++) {
            const fetched = await fetchPhoto(grant.id, urls[i], i + 1);
            if (!fetched.ok) return refuse(fetched.error);
            const one = await storableImage(fetched.bytes, sourceImageWords(`photo_urls #${i + 1}`, 'address'));
            if (!one.ok) return refuse(one.error);
            photos.push(one.value);
        }
        photos.push(...uploads.photos);
        const refusal = routePhotosRefusal(photos);
        if (refusal) return refuse(photoRefusalText(refusal, 'Each photo must be a JPEG or WebP image.'));
        return { ok: true, photos, settle: uploads.settle };
    } catch (e) {
        uploads.settle(false);
        throw e;
    }
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

/** Why this grant can't upload a photo, for a grant that does not post: both upload doors' words, and photo_upload_link's. */
export function noUploadWords(grant: AgentGrant): string {
    return grant.role !== 'owner'
        ? "Only an owner's assistant can upload photos: an admin's cannot post."
        : 'This assistant was connected without "May post for me", so it cannot upload photos. The owner can connect it again with that ticked.';
}

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
    const missing = missingField(args, asEnterprise ? enterpriseListingRequired() : listingRequiredFor(args))
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
    // Both apps' enterprise forms ask a price of more than 0 (treasury-post.tsx, TreasuryDetailPage), where the node has
    // Beans; a member's own may be 0. Where it has none, none is asked (enterpriseListingRequired).
    if (who.enterprise && getProfileSwitches().beans && credits <= 0) {
        return { ok: false, error: "beans must be more than 0: an enterprise's listing has a price, as its form asks." };
    }
    const shopId = str(args.shop_id, 200);
    const tagged = heldTags(args);
    if (!tagged.ok) return tagged;
    const photos = await photosFrom(grant, args);
    if (!photos.ok) return photos;
    return withPhotos(grant, photos, () => {
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
                    { createdBy: owner, beforeWrite: () => { assertAssistantDay(grant); limit.beforeWrite(); }, shopId, createdVia: createdViaOf(grant), ...tagged.fields });
                if (post) limit.stored(post.id);
            } else {
                assertNotMuted(owner);
                assertMayPost(owner, Math.min(photos.photos.length, 5));
                // The owners' "Assistant posts a day", in place of the member's own 100 (the director, 30 Oct).
                post = createPost(kind, category, title, description, credits, priceType, owner, lat, lng,
                    photos.photos, args.repeatable === true, undefined, args.cash_also_needed === true,
                    { beforeWrite: () => assertAssistantDay(grant), createdVia: createdViaOf(grant), ...tagged.fields });
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
    });
}

const STOPPED_MEANWHILE = 'This assistant was disconnected, or may no longer post, while its photos were fetched: nothing was posted.';

/**
 * Whether the grant may still post NOW: not revoked or expired and its member still an owner (grantStillLive), still ticked
 * "May post for me", and the owners' switch "Allow AI assistants" still on. Read again after any wait (photo fetches, uploads).
 */
export function grantMayStillPost(grant: AgentGrant, now = Date.now()): boolean {
    if (getLocalConfig().aiAssistantsAllowed === false) return false;
    const live = grantStillLive(grant.id, now);
    if (!live || live.role !== 'owner' || live.member !== grant.member) return false;
    const oauth = listOAuthGrants(now).find((g) => g.id === grant.id);
    if (oauth) return oauth.canPost === true;
    return listAutomationTokens().find((t) => t.id === grant.id)?.canPost === true;
}

/**
 * Make a post (or an edit) with its photos, then settle them: an uploaded photo is used up only by a post that was made, and
 * can be sent again after a refusal.
 */
function withPhotos(grant: AgentGrant, photos: Extract<Photos, { ok: true }>, make: () => ToolResult): ToolResult {
    let out: ToolResult | undefined;
    try {
        // Fetching photo_urls takes seconds; the grant was checked before it. Disconnecting the assistant, untick "May post for me",
        // or turning AI assistants off in that time stops the post (the manual: "Disconnecting stops it at once").
        if (!grantMayStillPost(grant)) {
            out = { ok: false, error: STOPPED_MEANWHILE };
            return out;
        }
        out = make();
        return out;
    } finally {
        photos.settle(out?.ok === true);
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
    const tagged = heldTags(args);
    if (!tagged.ok) return tagged;
    const photos = await photosFrom(grant, args);
    if (!photos.ok) return photos;
    return withPhotos(grant, photos, () => {
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
            ...tagged.fields,
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
    });
}

/** The photo rule every create states, since its schema cannot require "one of three" (schemaRequired). */
const PHOTOS_RULE = `1 to ${AGENT_POST_PHOTOS_MAX} photos are required, from photo_urls, photo_ids and photos together; the server makes each `
    + `${PHOTO_MAX_SIDE} px with no metadata, as the apps do. Never a photo of people you were not given to post`;
const PHOTOS_SCHEMA = {
    type: 'array', maxItems: AGENT_POST_PHOTOS_MAX,
    items: { type: 'string', description: 'a JPEG or WebP image as base64 (data:image/jpeg;base64,… or the bare base64)' },
    description: `photos as base64, for a program that has the files: each at most ${MAX_PHOTO_BASE64_CHARS.toLocaleString('en')} base64 characters and `
        + `${AGENT_PHOTO_MAX_INPUT_SIDE} pixels on its longest side. ${PHOTOS_RULE}.`,
};
const PHOTO_URLS_SCHEMA = {
    type: 'array', maxItems: AGENT_POST_PHOTOS_MAX,
    items: { type: 'string', maxLength: 2048, description: 'a public http or https address of a JPEG, WebP or PNG' },
    description: `public addresses of images this server fetches itself (a JPEG, WebP or PNG, at most ${PHOTO_SOURCE_MAX_BYTES / (1024 * 1024)} MB and `
        + `${AGENT_PHOTO_MAX_INPUT_SIDE} pixels a side, in 8 seconds; never a private address): the way for an assistant that cannot send a file. `
        + `Fetched and uploaded together, at most connection_info's photos.perDay a day. ${PHOTOS_RULE}.`,
};
const PHOTO_IDS_SCHEMA = {
    type: 'array', maxItems: AGENT_POST_PHOTOS_MAX,
    items: { type: 'string', pattern: '^ph_[0-9a-f]{32}$', description: 'a photoId an upload answered' },
    description: 'photos uploaded first: send each image (a JPEG, WebP or PNG, at most 5 MB) to the address photo_upload_link gives (no header but its '
        + 'Content-Type), or POST it as the whole body to /mcp/photos on this server, with its Content-Type and the same Authorization header; the '
        + `photoId it answers goes here. Each is used once, by this assistant, within ${PHOTO_UPLOAD_KEEP_MS / 3_600_000} hours. ${PHOTOS_RULE}.`,
};
/** The three photo fields, on every tool that takes photos. */
const PHOTO_PROPS = { photo_urls: PHOTO_URLS_SCHEMA, photo_ids: PHOTO_IDS_SCHEMA, photos: PHOTOS_SCHEMA };
const TAGS_SCHEMA = {
    type: 'array', maxItems: POST_TAGS_MAX,
    items: { type: 'string', description: 'a tag id from tags_search, e.g. food.fruit.lemon' },
    description: `library tags, the first choice: at most ${POST_TAGS_MAX} ids from tags_search, the list the apps' tag picker offers. Optional, but a tagged listing is `
        + 'easier to find. Ids only: an unknown one is refused with the three nearest',
};
const FREE_TAGS_SCHEMA = {
    type: 'array', maxItems: FREE_TAGS_MAX,
    items: { type: 'string', description: 'one tag, e.g. 2nd hand' },
    description: `your own tags, only for what the library lacks, after tags_search: at most ${FREE_TAGS_MAX}, beside the library's, each ${FREE_TAG_MIN_CHARS} to `
        + `${FREE_TAG_MAX_CHARS} characters and at most ${FREE_TAG_MAX_WORDS} words, never an email, a phone number, a web address or an @handle. Public with the listing, `
        + 'never translated, found only by its own letters. One tag per item: a comma parts two',
};
/** Both tag fields, on every create. */
const TAG_PROPS = { tags: TAGS_SCHEMA, free_tags: FREE_TAGS_SCHEMA };
/** What a description field says: assistants used to write "Tags: music, live, gig" into it. */
const NO_TAGS_HERE = 'never a list of tags: those go in tags and free_tags';
const LISTING_PROPS = {
    title: { type: 'string', maxLength: AGENT_TITLE_MAX.listing, description: `what it is, in a few words: at most ${AGENT_TITLE_MAX.listing} characters` },
    description: { type: 'string', description: `the details a member reads; ${NO_TAGS_HERE}` },
    category: { type: 'string', enum: AGENT_POST_CATEGORIES, description: 'the Market category, as the apps offer them' },
    beans: { type: 'number', minimum: 0, description: 'the price in Beans (0 is free); required where this community has Beans, none where it has not' },
    price_type: { type: 'string', enum: ['fixed', 'hourly'], description: 'fixed (default) or hourly' },
    repeatable: { type: 'boolean', description: 'stays up after each trade' },
    lat: { type: 'number', description: 'latitude of the place on the map, rounded to about 100 m as the apps do; required unless use_my_area' },
    lng: { type: 'number', description: 'longitude of the place on the map, rounded the same; required unless use_my_area' },
    ...TAG_PROPS,
    ...PHOTO_PROPS,
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
        required: schemaRequired(listingRequired()),
        additionalProperties: false,
    };
}
/** create_enterprise_listing's input, made when the tools are listed: a price of more than 0 only where Beans are on. */
function enterpriseListingSchema(): Record<string, unknown> {
    const beansOn = getProfileSwitches().beans;
    return {
        type: 'object',
        properties: {
            kind: { type: 'string', enum: ['offer', 'need'], description: 'offer or need' },
            as_enterprise: { type: 'string', description: 'the enterprise: its ref from my_enterprises' },
            ...LISTING_PROPS,
            beans: beansOn
                ? { type: 'number', exclusiveMinimum: 0, description: 'the price in Beans, more than 0' }
                : { type: 'number', minimum: 0, description: 'none: this community has no Beans' },
            lat: { type: 'number', description: "latitude of the place; left out, the enterprise's own area" },
            lng: { type: 'number', description: "longitude of the place; left out, the enterprise's own area" },
            shop_id: { type: 'string', description: "the enterprise's own shop to put an Offer in (optional)" },
        },
        required: schemaRequired(enterpriseListingRequired()),
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
/** Every create's and update_post's description says it, for an assistant that reads no field's. */
const TAGS_WORDS = 'tag it from the library first (tags, ids from tags_search), use free_tags only for what the library lacks, and never list tags in its description';
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
        reads: `nothing: it posts an Offer in the Market as the member this assistant acts for, with 1 to ${AGENT_POST_PHOTOS_MAX} photos; ${TAGS_WORDS}; ${LIMITS_WORDS}`,
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
        reads: `nothing: it posts a Need in the Market as the member this assistant acts for, with 1 to ${AGENT_POST_PHOTOS_MAX} photos; ${TAGS_WORDS}; ${LIMITS_WORDS}`,
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
            + `${AGENT_POST_PHOTOS_MAX} photos; ${TAGS_WORDS}; ${LIMITS_WORDS}`,
        never: "anything but the new post's id and its link, or another member's data",
        ownerOnly: true,
        posts: true,
        write: true,
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', maxLength: AGENT_TITLE_MAX.event, description: `the event's name: at most ${AGENT_TITLE_MAX.event} characters` },
                description: { type: 'string', description: `what happens, for whom; ${NO_TAGS_HERE}` },
                start_at: { type: 'string', description: 'when it starts: ISO 8601 with its offset, e.g. 2026-11-07T10:00:00+11:00 (Z for UTC); one without is refused' },
                end_at: { type: 'string', description: 'when it ends: ISO 8601 with its offset, as start_at; left out, the server\'s default length' },
                timezone: { type: 'string', description: 'the IANA zone it is in, e.g. Australia/Melbourne' },
                place_name: { type: 'string', description: 'the name of the place: required in person (the default), none online' },
                lat: { type: 'number', description: 'latitude of the place on the map, rounded to about 100 m as the apps do: required in person, none online' },
                lng: { type: 'number', description: 'longitude of the place on the map, rounded the same: required in person, none online' },
                online: { type: 'boolean', description: 'online instead of in person: no place, a link' },
                link: { type: 'string', description: 'the join link of an online event' },
                as_enterprise: { type: 'string', description: 'host as an enterprise: its ref from my_enterprises' },
                ...TAG_PROPS,
                ...PHOTO_PROPS,
            },
            // In person (online not true) place_name, lat and lng are required too (REQUIRED.eventInPerson), in their words.
            required: schemaRequired(REQUIRED.event),
            additionalProperties: false,
        },
        outputSchema: POST_OUT,
        run: (grant, args) => createEvent(grant, args),
    },
    {
        name: 'create_enterprise_listing',
        title: "Post an enterprise's Offer or Need",
        reads: `nothing: it posts an Offer or a Need in the Market as an enterprise the member this assistant acts for keeps now (as_enterprise, `
            + `from my_enterprises), with 1 to ${AGENT_POST_PHOTOS_MAX} photos; an enterprise's Need needs a live Offer of its own first; ${TAGS_WORDS}; ${LIMITS_WORDS}`,
        never: "anything but the new post's id and its link, an enterprise's key, or another member's data",
        ownerOnly: true,
        posts: true,
        write: true,
        // Read each time the tools are listed, as create_offer's: whether a price is required follows the Beans switch.
        get inputSchema() { return enterpriseListingSchema(); },
        outputSchema: POST_OUT,
        run: (grant, args) => createListing(grant, { kind: args.kind === 'need' ? 'need' : 'offer', args, enterprise: true }),
    },
    {
        name: 'photo_upload_link',
        title: 'Get an address to upload photos to',
        reads: `nothing: it makes a private address on this server that takes photos for ${PHOTO_LINK_KEEP_MS / 60_000} minutes, for an assistant that `
            + `runs commands but can't send this connection's Authorization header. For each image run \`${PHOTO_LINK_CURL}\` (a JPEG, WebP or PNG, at `
            + `most ${PHOTO_SOURCE_MAX_BYTES / (1024 * 1024)} MB, at least ${AGENT_PHOTO_MIN_SIDE} pixels on its shorter side, each a request of its own): it `
            + 'answers a photoId, and create_offer, create_need, create_event or create_enterprise_listing take those as photo_ids. One address takes many '
            + `photos, until it expires; at most ${PHOTO_LINKS_PER_GRANT} are live at once, a new one replacing the oldest. Keep the address to yourself, as a password`,
        never: "this connection's secret, a list of uploads or a photo back: the address takes uploads and reads nothing",
        ownerOnly: true,
        posts: true,
        write: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'where to send each image: a secret, in effect a password, until it expires' },
                expiresAt: { type: 'string' }, photosLeftToday: { type: 'number' },
            },
            required: ['url', 'expiresAt', 'photosLeftToday'],
        },
        run: (grant, _args, _boundary, nodeUrl) => {
            if (grant.role !== 'owner' || !grant.canPost) return { ok: false, error: noUploadWords(grant) };
            const replaced = getReplacedInfo();
            if (replaced) return { ok: false, error: `${replaced.message} This server takes no new photos; use the one that took over.` };
            // A node with no public address names itself by the host the assistant reached, which may not read as one (mcp-route.ts nodeUrlFor).
            if (!nodeUrl || !/^https?:\/\//.test(nodeUrl)) return { ok: false, error: 'This server cannot name its own address now: give the photos by photo_urls instead.' };
            const { token, expiresAt } = issuePhotoLink(grant);
            return {
                ok: true, rows: 1,
                result: { url: `${nodeUrl}${PHOTO_LINK_PATH}/${token}`, expiresAt, photosLeftToday: Math.max(0, agentPhotosPerDay() - agentPhotosToday(grant.id)) },
            };
        },
    },
];

/** A post this grant made, as it is now: for update_post, remove_post and the undo list. */
interface MadeRow {
    id: string; type: string; status: string; active: number; title: string; author_pubkey: string; created_by: string | null; created_at: string;
    tags: string; free_tags: string;
}

/** The words for a post that is not this assistant's to change (design §2.3). */
const NOT_MADE_HERE = 'That is not a post this assistant made: edit or remove it in the app. my_posts lists the ones it made.';

/**
 * The post `postId` names, when THIS grant made it (created_via) and it is this community's own (not a copy pulled from
 * another), still by the owner or an enterprise they keep now; else why not, in words.
 */
function madePost(grant: AgentGrant, postId: unknown): { ok: true; row: MadeRow } | { ok: false; error: string } {
    if (typeof postId !== 'string' || !postId.trim()) return { ok: false, error: 'post_id is required: the id a create answered, or my_posts lists.' };
    const row = db.prepare(`SELECT id, type, status, active, title, author_pubkey, created_by, created_at, tags, free_tags FROM posts
        WHERE id = ? AND created_via = ? AND origin_node IS NULL`).get(postId.trim().slice(0, 200), createdViaOf(grant)) as MadeRow | undefined;
    if (!row) return { ok: false, error: NOT_MADE_HERE };
    if (row.author_pubkey !== grant.member && !(row.created_by === grant.member && canOperateTreasury(grant.member, row.author_pubkey))) {
        return { ok: false, error: "That post is an enterprise's you no longer keep: its keepers edit or remove it in the app." };
    }
    return { ok: true, row };
}

const isLive = (r: Pick<MadeRow, 'active' | 'status'>): boolean => r.active === 1 && r.status !== 'cancelled';

/** The refusals before an edit, a removal or the undo list: an owner's grant ticked "May post for me", on a server still this community's. */
function tendGate(grant: AgentGrant): string | null {
    if (grant.role !== 'owner') return "Only an owner's assistant can change posts: an admin's cannot.";
    if (!grant.canPost) return NOT_TICKED;
    const replaced = getReplacedInfo();
    if (replaced) return `${replaced.message} This server takes no changes now; use the one that took over.`;
    return null;
}

/** update_post: the fields an edit may change, by the tools' own names, through the route's own updatePost. */
async function updateMade(grant: AgentGrant, args: Record<string, unknown>): Promise<ToolResult> {
    const refused = tendGate(grant);
    if (refused) return { ok: false, error: refused };
    const made = madePost(grant, args.post_id);
    if (!made.ok) return made;
    const { row } = made;
    if (!isLive(row) || row.status !== 'active') return { ok: false, error: `That post is ${isLive(row) ? row.status : 'removed'} now: only a live post is edited.` };
    const event = row.type === 'event';
    const updates: Record<string, unknown> = {};
    for (const k of ['title', 'description'] as const) {
        if (args[k] === undefined) continue;
        if (!isText(args[k])) return { ok: false, error: `${k} is empty: send the new ${k}, or leave it out to keep it.` };
        updates[k] = (args[k] as string).trim();
    }
    const tooLong = updates.title !== undefined ? titleTooLong(args, event ? AGENT_TITLE_MAX.event : AGENT_TITLE_MAX.listing) : null;
    if (tooLong) return { ok: false, error: tooLong };
    if (event && (args.category !== undefined || args.beans !== undefined || args.price_type !== undefined)) {
        return { ok: false, error: 'An event has no category or price: send title, description, tags, free_tags or photos.' };
    }
    if (args.category !== undefined) {
        const category = typeof args.category === 'string' ? args.category.trim() : '';
        if (!AGENT_POST_CATEGORIES.includes(category)) return { ok: false, error: `category must be one of ${AGENT_POST_CATEGORIES.join(', ')}, as the apps offer.` };
        updates.category = category;
    }
    if (args.beans !== undefined) {
        const beans = num(args.beans);
        if (beans === undefined || beans < 0) return { ok: false, error: 'beans is the price in Beans: a number, 0 or more.' };
        // An enterprise's listing keeps a price of more than 0 where the node has Beans, as its form asks (create_enterprise_listing).
        if (row.author_pubkey !== grant.member && getProfileSwitches().beans && beans <= 0) {
            return { ok: false, error: "beans must be more than 0: an enterprise's listing has a price, as its form asks." };
        }
        updates.credits = beans;
    }
    if (args.price_type !== undefined) updates.priceType = args.price_type === 'hourly' ? 'hourly' : 'fixed';
    const tagged = heldTags(args, row);
    if (!tagged.ok) return tagged;
    Object.assign(updates, tagged.fields);
    // New photos in place of the ones it has, from any of the three fields, as a create takes them.
    const newPhotos = PHOTO_FIELDS.some((k) => args[k] !== undefined) ? await photosFrom(grant, args) : null;
    if (newPhotos && !newPhotos.ok) return newPhotos;
    if (newPhotos) updates.photos = newPhotos.photos;
    if (!Object.keys(updates).length) {
        return { ok: false, error: 'Send at least one field to change: title, description, category, beans, price_type, tags, free_tags, or photos (photo_urls, photo_ids or photos).' };
    }
    const edit = (): ToolResult => {
        if (!admitAgentEdit(grant.id)) {
            return { ok: false, error: `This assistant has made ${AGENT_EDITS_PER_DAY} edits today, the most a day allows: try again tomorrow (UTC).` };
        }
        const owner = grant.member;
        try {
            // What POST /api/marketplace/posts/update runs after its signature check: the mute, the photo allowance, then the
            // engine's own edit, which holds every field to the create's rules and lets a keeper edit their enterprise's.
            assertNotMuted(owner);
            const photos = updates.photos as string[] | undefined;
            if (photos) assertMayEditPhotos(owner, row.id, Math.min(photos.length, 5), photos.length);
            const post = updatePost(row.id, row.author_pubkey, updates as Parameters<typeof updatePost>[2], owner, {});
            if (!post) {
                returnAgentEdit(grant.id);
                return { ok: false, error: 'The post could not be changed now: try again later.' };
            }
            return {
                ok: true, rows: 1,
                result: {
                    postId: row.id, kind: row.type, link: `/?post=${encodeURIComponent(row.id)}`,
                    changed: Object.keys(args).filter((k) => k !== 'post_id'), editsToday: agentEditsToday(grant.id), editsPerDay: AGENT_EDITS_PER_DAY,
                },
            };
        } catch (e) {
            returnAgentEdit(grant.id);
            return { ok: false, error: refusalText(e, grant, 'The post could not be changed: try again later.') };
        }
    };
    return newPhotos ? withPhotos(grant, newPhotos, edit) : edit();
}

/** One post taken down by `member` through the route's own removePost (the author, or the keeper who made it); why not, in words. */
function removeOne(postId: string, member: string): { ok: true } | { ok: false; error: string } {
    try {
        if (!removePost(postId, member)) return { ok: false, error: 'It could not be removed here: its author or keeper removes it in the app.' };
        syncPulseMarketplaceGate();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: memberErrorText(e, 'It could not be removed now: try again later.') };
    }
}

/** The ADMIN line of a removal of what an assistant made: the grant, who asked, and the ids (design §2.8). */
function logRemoval(grantId: string, ids: string[], via: 'assistant' | 'settings', by: string): void {
    logger.info('ADMIN', 'Posts an AI assistant made removed', { grant: grantId, via, by: by.slice(0, 16), count: ids.length, posts: ids.slice(0, 200) });
}

function removeMade(grant: AgentGrant, args: Record<string, unknown>): ToolResult {
    const refused = tendGate(grant);
    if (refused) return { ok: false, error: refused };
    const made = madePost(grant, args.post_id);
    if (!made.ok) return made;
    if (!isLive(made.row)) return { ok: false, error: 'That post is already removed.' };
    const out = removeOne(made.row.id, grant.member);
    if (!out.ok) return out;
    logRemoval(grant.id, [made.row.id], 'assistant', grant.member);
    return { ok: true, rows: 1, result: { removed: [made.row.id], kept: [] } };
}

/** The confirmation remove_all_i_made asks, said out loud (design §2.3). */
export const REMOVE_ALL_CONFIRM = 'remove everything this assistant made';

export interface RemovedMade {
    removed: string[];
    /** Posts still up (a deal in escrow, an enterprise its maker no longer keeps), each with why, in words. */
    kept: Array<{ postId: string; why: string }>;
}

/**
 * Every live post the assistant `grantId` made, taken down by the member it acted for (the keeper who made an enterprise's,
 * else the author), through the route's own removePost: remove_all_i_made, and the owner's "Remove its posts" in Settings,
 * which works whether or not the grant is still connected (its id is on the rows). Never a post it did not make.
 */
export function removeAllMadeBy(grantId: string, via: 'assistant' | 'settings', by: string): RemovedMade {
    const rows = db.prepare(`SELECT id, author_pubkey, created_by FROM posts WHERE created_via = ? AND origin_node IS NULL
        AND active = 1 AND status != 'cancelled' ORDER BY created_at`).all(`assistant:${grantId}`) as Array<{ id: string; author_pubkey: string; created_by: string | null }>;
    const result: RemovedMade = { removed: [], kept: [] };
    for (const row of rows) {
        const out = removeOne(row.id, row.created_by ?? row.author_pubkey);
        if (out.ok) result.removed.push(row.id);
        else result.kept.push({ postId: row.id, why: out.error });
    }
    logRemoval(grantId, result.removed, via, by);
    return result;
}

/** How many live posts the assistant `grantId` made (Settings' "Made: N posts"). */
export function madePostsCount(grantId: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM posts WHERE created_via = ? AND origin_node IS NULL AND active = 1 AND status != 'cancelled'`)
        .get(`assistant:${grantId}`) as { c: number }).c;
}

/** The grants that made live posts here, by id: Settings lists the ones whose assistant is gone ("a disconnected assistant"). */
export function grantIdsWithMadePosts(): string[] {
    return (db.prepare(`SELECT DISTINCT substr(created_via, 11) AS id FROM posts WHERE created_via LIKE 'assistant:%' AND origin_node IS NULL
        AND active = 1 AND status != 'cancelled'`).all() as Array<{ id: string }>).map((r) => r.id);
}

/** my_posts: what THIS grant made, newest first (design §2.2: the undo list). */
function myPosts(grant: AgentGrant, args: Record<string, unknown>, boundary: string): ToolResult {
    const status = args.status === 'removed' ? 'removed' : args.status === 'all' ? 'all' : 'live';
    const n = Math.floor(Number(args.limit));
    const limit = Number.isFinite(n) && n >= 1 ? Math.min(n, AGENT_LIST_MAX) : 20;
    const where = status === 'live' ? `AND active = 1 AND status != 'cancelled'` : status === 'removed' ? `AND (active = 0 OR status = 'cancelled')` : '';
    const rows = db.prepare(`SELECT id, type, status, active, title, author_pubkey, created_by, created_at, tags, free_tags FROM posts
        WHERE created_via = ? AND origin_node IS NULL ${where} ORDER BY created_at DESC LIMIT ?`).all(createdViaOf(grant), limit) as MadeRow[];
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM posts WHERE created_via = ? AND origin_node IS NULL ${where}`).get(createdViaOf(grant)) as { c: number }).c;
    return {
        ok: true, rows: rows.length,
        result: {
            status, total, returned: rows.length,
            posts: rows.map((r) => ({
                postId: r.id, kind: r.type, status: isLive(r) ? r.status : 'removed', createdAt: r.created_at,
                by: r.author_pubkey === grant.member ? 'me' : `enterprise:${enterpriseRef(r.author_pubkey)}`,
                link: `/?post=${encodeURIComponent(r.id)}`,
                title: fence(boundary, `post ${r.id}, title`, r.title),
                // What an edit replaces: update_post takes the whole new list of either.
                tags: postTagsOf(r.tags),
                freeTags: fence(boundary, `post ${r.id}, free tags`, freeTagsOf(r.free_tags).join(', ')),
            })),
            _notice: MEMBER_TEXT_NOTICE,
        },
    };
}

const POST_ID_PROP = { post_id: { type: 'string', description: 'the id a create answered (my_posts lists them)' } };
const REMOVED_OUT = {
    type: 'object',
    properties: { removed: { type: 'array', items: { type: 'string' } }, kept: { type: 'array' } },
    required: ['removed', 'kept'],
};

/** Slice S2's rows (design §2.3, §2.7): the undo list, and tending what this assistant made, nothing else. */
export const OWNER_TEND_TOOLS: AgentTool[] = [
    {
        name: 'my_posts',
        title: 'Posts this assistant made',
        reads: `the posts THIS assistant made, newest first, at most ${AGENT_LIST_MAX}: id, kind, status, when, whether as you or an enterprise you keep, `
            + 'its link, its library tags, and its title and its own tags, fenced; the live ones (the default), the removed ones, or all',
        never: "a post made in the app or by another assistant, another member's data, or a key",
        memberText: true,
        ownerOnly: true,
        posts: true,
        inputSchema: {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ['live', 'removed', 'all'], description: 'live (default), removed or all' },
                limit: { type: 'integer', minimum: 1, maximum: AGENT_LIST_MAX },
            },
            additionalProperties: false,
        },
        outputSchema: {
            type: 'object',
            properties: { status: { type: 'string' }, total: { type: 'number' }, returned: { type: 'number' }, posts: { type: 'array' } },
            required: ['status', 'total', 'returned', 'posts'],
        },
        run: (grant, args, boundary) => {
            const refused = tendGate(grant);
            return refused ? { ok: false, error: refused } : myPosts(grant, args, boundary);
        },
    },
    {
        name: 'update_post',
        title: 'Edit a post this assistant made',
        reads: `nothing: it changes the title, description, category, price, tags or photos of a live post THIS assistant made, as the app's edit does, `
            + `at most ${AGENT_EDITS_PER_DAY} edits a day; any other post is refused; ${TAGS_WORDS}; tags or free_tags sent is the whole new list of that kind, left out it stays`,
        never: "anything but the post's id and its link, or another member's data; it never moves Beans",
        ownerOnly: true,
        posts: true,
        write: true,
        inputSchema: {
            type: 'object',
            properties: {
                ...POST_ID_PROP,
                title: { type: 'string', description: `the new title: at most ${AGENT_TITLE_MAX.listing} characters for an Offer or a Need, ${AGENT_TITLE_MAX.event} for an event` },
                description: { type: 'string', description: `the new details; ${NO_TAGS_HERE}` },
                category: { type: 'string', enum: AGENT_POST_CATEGORIES, description: "an Offer's or a Need's new Market category" },
                beans: { type: 'number', minimum: 0, description: "an Offer's or a Need's new price in Beans (an enterprise's more than 0)" },
                price_type: { type: 'string', enum: ['fixed', 'hourly'] },
                // Each the whole new list, or left out to leave them: an assistant reads what a post carries in my_posts.
                tags: { ...TAGS_SCHEMA, description: `the whole new list in place of the ones it has (my_posts lists them; [] takes them all off; left out, they stay): ${TAGS_SCHEMA.description}` },
                free_tags: { ...FREE_TAGS_SCHEMA, description: `the whole new list in place of the ones it has (my_posts lists them; [] takes them all off; left out, they stay): ${FREE_TAGS_SCHEMA.description}` },
                // New photos, in place of the ones it has, from any of the three fields as a create takes them.
                photo_urls: { ...PHOTO_URLS_SCHEMA, description: `in place of the ones it has: ${PHOTO_URLS_SCHEMA.description}` },
                photo_ids: { ...PHOTO_IDS_SCHEMA, description: `in place of the ones it has: ${PHOTO_IDS_SCHEMA.description}` },
                photos: { ...PHOTOS_SCHEMA, description: `in place of the ones it has: ${PHOTOS_SCHEMA.description}` },
            },
            required: ['post_id'],
            additionalProperties: false,
        },
        outputSchema: {
            type: 'object',
            properties: {
                postId: { type: 'string' }, kind: { type: 'string' }, link: { type: 'string' }, changed: { type: 'array' },
                editsToday: { type: 'number' }, editsPerDay: { type: 'number' },
            },
            required: ['postId', 'kind', 'link', 'changed', 'editsToday', 'editsPerDay'],
        },
        run: (grant, args) => updateMade(grant, args),
    },
    {
        name: 'remove_post',
        title: 'Remove a post this assistant made',
        reads: 'nothing: it takes down one live post THIS assistant made, as its author does in the app (an event is cancelled and its goers told); '
            + 'one with a deal in escrow stays up; any other post is refused',
        never: "another member's data; it never moves Beans",
        ownerOnly: true,
        posts: true,
        write: true,
        destructive: true,
        inputSchema: { type: 'object', properties: POST_ID_PROP, required: ['post_id'], additionalProperties: false },
        outputSchema: REMOVED_OUT,
        run: (grant, args) => removeMade(grant, args),
    },
    {
        name: 'remove_all_i_made',
        title: 'Remove everything this assistant made',
        reads: `nothing: it takes down every live post THIS assistant made, once a day, when confirm is "${REMOVE_ALL_CONFIRM}"; `
            + 'one with a deal in escrow stays up and is listed back with why',
        never: "a post made in the app or by another assistant, or another member's data; it never moves Beans",
        ownerOnly: true,
        posts: true,
        write: true,
        destructive: true,
        inputSchema: {
            type: 'object',
            properties: { confirm: { type: 'string', const: REMOVE_ALL_CONFIRM, description: `exactly "${REMOVE_ALL_CONFIRM}"` } },
            required: ['confirm'],
            additionalProperties: false,
        },
        outputSchema: REMOVED_OUT,
        run: (grant, args) => {
            const refused = tendGate(grant);
            if (refused) return { ok: false, error: refused };
            if (args.confirm !== REMOVE_ALL_CONFIRM) return { ok: false, error: `confirm must be exactly "${REMOVE_ALL_CONFIRM}": nothing was removed.` };
            if (!admitAgentRemoveAll(grant.id)) {
                return { ok: false, error: 'This assistant has removed everything it made once today, the most a day allows: try again tomorrow (UTC), or the owner presses "Remove its posts" in Settings.' };
            }
            const out = removeAllMadeBy(grant.id, 'assistant', grant.member);
            return { ok: true, rows: out.removed.length, result: { removed: out.removed, kept: out.kept } };
        },
    },
];
