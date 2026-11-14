/**
 * An owner's assistant seeds the rest of a community's content (MCP-OWNER S3; DESIGN-owner-seeding-tags-fable.md §2.3, the
 * §7 S3 row; Marty, 30 Oct: "we need to be able to seed all sorts of stuff … enterprises, guilds, pulse — basically
 * everything that we could seed"): `my_groups`, `create_group`, `create_group_post` and `create_enterprise`.
 *
 * The rules of slice 1 (agent/owner-posts.ts) hold for each:
 * - Owner grants ticked "May post for me" only, on a server still this community's, inside the owners' "Assistant posts a day"
 *   (gate): a group, a group's post and an enterprise are each one of the day's posts, counted before it is made and from the
 *   rows after a restart (owner-posts.ts madeToday reads agent_made too). The member's own bound for that kind holds as well,
 *   as its route holds it: 5 groups started a day, 3 enterprises a day and 20 running (engine/writer-bounds.ts), which for an
 *   owner is the owners' "Owner and admin limit".
 * - What its route runs after the signature check, in the same order and through the same engine call: POST /api/groups
 *   (routes/groups.ts: mute, the group bound, createGroup), POST /api/marketplace/posts with audienceScope 'group' (the
 *   engine holds the owner to an active place in an open group), POST /api/enterprise (routes/treasury.ts
 *   createEnterpriseHandler, ongoing only).
 * - Every field the composer will not go without is required, by the schema and again here, refused in words that name it
 *   (phone CreateGroupModal, group-post.tsx, propose-project.tsx). A group's picture is optional, as in its form (the
 *   category's emblem stands in); an enterprise's photo is required, as in its form.
 * - Content only, never money. No schema here has a goal, a deadline, a pledge, a credit line, a ceiling, a balance or a
 *   treasury field, and one sent is refused in words (strayField): an enterprise is made `ongoing` with nothing else, so it
 *   is never a project with a goal, and its credit line is 0 as every member-made one's is. The one price is a group post's
 *   `beans`, the listing's price the group form asks where Beans are on, as create_offer's; no tool moves a Bean.
 * - An enterprise is kept by the owner (its lead keeper), never by the node: my_enterprises then lists it, and the post tools
 *   take it as as_enterprise.
 * - Each is recorded as this grant's (schema.sql agent_made, `assistant:<grant id>`), so remove_all_i_made names the groups
 *   and enterprises it made (Settings' "Remove its posts" takes posts only and does not list them yet): no route deletes a
 *   group, and an enterprise winds up through its keepers with its objection window, so they are listed back to wind up in
 *   the app, never removed here.
 * - Member-written text read back (a group's name) is fenced, as every read's.
 */
import { assistantBeansOf, hundredthsFromAssistantBeans } from '../money-body.js';
import { approximateLocation, GROUP_CATEGORIES, GROUP_CATEGORY_LABELS, JOIN_POLICIES, replaceLoneSurrogates } from '@beanpool/core';
import { db, isOperatorSwitchedOff, OPERATOR_SWITCHED_OFF_CREATE_ERROR } from '../db/db.js';
import { createGroup, createPost, createTreasury, getActingMember } from '../state-engine.js';
import { assertNotMuted } from '../engine/auto-moderation.js';
import { assertMayPost } from '../engine/probation.js';
import { assertMayStartEnterprise, assertMayStartGroupToday } from '../engine/writer-bounds.js';
import { assertEnterpriseText } from '../engine/enterprise-text.js';
import { assertMayStorePhotoBytes, incomingPhotoBytes } from '../engine/photo-upload-budget.js';
import { stripImageValue } from '../storage/image-metadata.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { cleanMemberText, fence, MEMBER_TEXT_NOTICE } from './fence.js';
import { admitAgentCreate, agentPostsPerDay, AGENT_LIST_MAX, returnAgentCreate } from './limits.js';
import {
    AGENT_POST_CATEGORIES, AGENT_POST_PHOTOS_MAX, assertAssistantDay, recordMade, assistantPostsToday, createdViaOf, dayFull, enterpriseRef, enterprisesOff, gate, heldTags,
    NO_TAGS_HERE, NOT_TICKED, notAFlag, num, OWNERS_POST_WORDS, PHOTO_PROPS, photosFrom, REFUSED_TAG_CHARS, refusalText, statusOf, TAG_PROPS, TAGS_WORDS, withPhotos,
    type PhotoRule,
} from './owner-posts.js';
import type { AgentGrant, AgentTool, ToolResult } from './tools.js';

/**
 * Money is never a field here (the brief: "no Beans, pledges, credit or treasury field in any schema, and each refused if
 * sent"): the names a client might send one under, refused in words that say why, before anything else is read.
 */
const MONEY_FIELD = /^(beans|credits?|price|price_type|amount|goal|goal_amount|deadline|deadline_at|pledges?|credit|credit_line|working_capital|working_capital_ceiling|ceiling|treasury|balance|lifecycle|fee|bounded)$/i;

/** A field the tool does not take, refused in words; money in words of its own. */
function strayField(args: Record<string, unknown>, takes: readonly string[], what: string): string | null {
    const field = Object.keys(args).find((k) => !takes.includes(k));
    if (field === undefined) return null;
    const name = cleanMemberText(field, REFUSED_TAG_CHARS);
    if (MONEY_FIELD.test(field)) {
        return `${what} made by an assistant is content only, so it has no ${name}: Beans, prices, pledges, goals, deadlines and credit are set by a person in the app.`;
    }
    return `${what} has no ${name}: it takes ${takes.join(', ')}.`;
}

const isText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/** The first required field left out or empty, in words that name it and ask for it. */
function missing(args: Record<string, unknown>, asks: Record<string, string>, there: (k: string) => boolean = (k) => isText(args[k])): string | null {
    const field = Object.keys(asks).find((k) => !there(k));
    return field ? `${field} is required: ${asks[field]}.` : null;
}

function tooLong(field: string, value: unknown, max: number, form: string): string | null {
    const { length } = (value as string).trim();
    return length > max ? `${field} is at most ${max} characters, as ${form} takes (this one is ${length}).` : null;
}

// ── Groups ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The group form's limits (phone CreateGroupModal: a name of 2 to 60, a description of at most 300). */
export const AGENT_GROUP_NAME_MIN = 2;
export const AGENT_GROUP_NAME_MAX = 60;
export const AGENT_GROUP_DESCRIPTION_MAX = 300;
/** A group post's title, as group-post.tsx takes it. */
export const AGENT_GROUP_POST_TITLE_MAX = 80;

const GROUP_FIELDS = ['name', 'description', 'category', 'join_policy', 'photo_urls', 'photo_ids', 'photos'] as const;
const GROUP_ASKS = {
    name: `what it is called, ${AGENT_GROUP_NAME_MIN} to ${AGENT_GROUP_NAME_MAX} characters`,
    description: `what it is for, who it is for, at most ${AGENT_GROUP_DESCRIPTION_MAX} characters`,
    category: `one of ${GROUP_CATEGORIES.join(', ')}`,
    join_policy: `who may join: one of ${JOIN_POLICIES.join(', ')}`,
};

/** A group's picture: none (its category's emblem, as in the form) or one. */
const GROUP_PHOTO_RULE: PhotoRule = {
    min: 0, max: 1, none: '',
    tooMany: "A group has one picture: send at most 1, from photo_urls, photo_ids or photos. Left out, it shows its category's emblem, as in the app.",
};

const NOT_CLOSED = 'NOT EXISTS (SELECT 1 FROM group_closures c WHERE c.group_id = g.id)';

/** create_group: what POST /api/groups runs after its signature check, with the owner as its first convenor. */
async function createGroupFor(grant: AgentGrant, args: Record<string, unknown>): Promise<ToolResult> {
    const refused = gate(grant) ?? strayField(args, GROUP_FIELDS, 'A group') ?? missing(args, GROUP_ASKS)
        ?? tooLong('name', args.name, AGENT_GROUP_NAME_MAX, "the app's group form") ?? tooLong('description', args.description, AGENT_GROUP_DESCRIPTION_MAX, "the app's group form");
    if (refused) return { ok: false, error: refused };
    const name = (args.name as string).trim();
    if (name.length < AGENT_GROUP_NAME_MIN) return { ok: false, error: `name is at least ${AGENT_GROUP_NAME_MIN} characters, as the app's group form asks.` };
    if (!(GROUP_CATEGORIES as readonly unknown[]).includes(args.category)) return { ok: false, error: `category must be one of ${GROUP_CATEGORIES.join(', ')}, as the app offers.` };
    if (!(JOIN_POLICIES as readonly unknown[]).includes(args.join_policy)) return { ok: false, error: `join_policy must be one of ${JOIN_POLICIES.join(', ')}.` };
    const photos = await photosFrom(grant, args, GROUP_PHOTO_RULE);
    if (!photos.ok) return photos;
    return withPhotos(grant, photos, () => {
        if (!admitAgentCreate(grant.id)) return { ok: false, error: dayFull(grant) };
        const owner = grant.member;
        try {
            // In the route's order: a muted member starts nothing other members read, then the member's own groups a day.
            assertNotMuted(owner);
            assertMayStartGroupToday(owner);
            assertAssistantDay(grant);
            const group = createGroup({
                name, description: (args.description as string).trim(), category: args.category as (typeof GROUP_CATEGORIES)[number],
                joinPolicy: args.join_policy as (typeof JOIN_POLICIES)[number], avatarUrl: photos.photos[0], createdBy: owner,
            });
            recordMade(grant, 'group', group.id);
            return {
                ok: true, rows: 1,
                result: {
                    groupId: group.id, kind: 'group', category: group.category, joinPolicy: group.joinPolicy, role: 'convenor',
                    postsToday: assistantPostsToday(grant), postsPerDay: agentPostsPerDay(),
                },
            };
        } catch (e) {
            returnAgentCreate(grant.id);
            return { ok: false, error: refusalText(e, grant, 'The group could not be made: try again later.') };
        }
    });
}

const GROUP_POST_FIELDS = ['group_id', 'kind', 'title', 'description', 'category', 'beans', 'price_type', 'repeatable', 'cash_also_needed', 'tags', 'free_tags', 'photo_urls', 'photo_ids', 'photos'] as const;

/** What the group form will not post without: a price only where the community has Beans (group-post.tsx groupPostPriceInvalid). */
function groupPostAsks(): Record<string, string> {
    return {
        group_id: 'the group, by its id from my_groups or create_group', kind: 'offer or need', title: 'what it is, in a few words',
        category: `one of ${AGENT_POST_CATEGORIES.join(', ')}`,
        ...(getProfileSwitches().beans ? { beans: 'the price in Beans (0 is free)' } : {}),
    };
}

/** create_group_post: what POST /api/marketplace/posts runs for an Offer or a Need with audienceScope 'group', as the owner. */
async function createGroupPost(grant: AgentGrant, args: Record<string, unknown>): Promise<ToolResult> {
    const refused = gate(grant) ?? strayField(args, GROUP_POST_FIELDS, 'A group post')
        ?? missing(args, groupPostAsks(), (k) => (k === 'beans' ? num(args.beans) !== undefined : isText(args[k])))
        ?? tooLong('title', args.title, AGENT_GROUP_POST_TITLE_MAX, "the app's group post form") ?? notAFlag(args, ['repeatable', 'cash_also_needed']);
    if (refused) return { ok: false, error: refused };
    if (args.kind !== 'offer' && args.kind !== 'need') return { ok: false, error: 'kind must be offer or need.' };
    const category = (args.category as string).trim();
    if (!AGENT_POST_CATEGORIES.includes(category)) return { ok: false, error: `category must be one of ${AGENT_POST_CATEGORIES.join(', ')}, as the apps offer.` };
    // The assistant gives Beans; the node keeps whole hundredths (money-body.ts): a figure finer than a cent is refused.
    const credits = args.beans === undefined ? 0 : hundredthsFromAssistantBeans(args.beans);
    if (credits === null) return { ok: false, error: 'beans is the price in Beans: a number, 0 or more, to the cent.' };
    const groupId = (args.group_id as string).trim().slice(0, 200);
    const tagged = heldTags(args);
    if (!tagged.ok) return tagged;
    const photos = await photosFrom(grant, args);
    if (!photos.ok) return photos;
    const kind = args.kind;
    return withPhotos(grant, photos, () => {
        if (!admitAgentCreate(grant.id)) return { ok: false, error: dayFull(grant) };
        const owner = grant.member;
        try {
            assertNotMuted(owner);
            assertMayPost(owner, Math.min(photos.photos.length, 5));
            // No pin: the group form sends none, and the post reaches the group's members, not the map.
            const post = createPost(kind, category, (args.title as string).trim(), typeof args.description === 'string' ? args.description.trim() : '', credits,
                args.price_type === 'hourly' ? 'hourly' : 'fixed', owner, undefined, undefined, photos.photos, args.repeatable === true, undefined, args.cash_also_needed === true,
                { audienceScope: 'group', targetGroupId: groupId, beforeWrite: () => assertAssistantDay(grant), createdVia: createdViaOf(grant), ...tagged.fields });
            if (!post) {
                returnAgentCreate(grant.id);
                return { ok: false, error: 'The post could not be made.' };
            }
            return {
                ok: true, rows: 1,
                result: {
                    postId: post.id, kind, groupId, asEnterprise: false, link: `/?post=${encodeURIComponent(post.id)}`,
                    postsToday: assistantPostsToday(grant), postsPerDay: agentPostsPerDay(),
                },
            };
        } catch (e) {
            returnAgentCreate(grant.id);
            return { ok: false, error: refusalText(e, grant, 'The post could not be made: try again later.') };
        }
    });
}

/** my_groups: the open groups the owner is in, where a group post may go. Names fenced; no member is named. */
function myGroups(grant: AgentGrant, args: Record<string, unknown>, boundary: string): ToolResult {
    const n = Math.floor(Number(args.limit));
    const limit = Number.isFinite(n) && n >= 1 ? Math.min(n, AGENT_LIST_MAX) : 20;
    const rows = db.prepare(`SELECT g.id, g.name, g.category, g.join_policy, gm.role,
            (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id AND x.status = 'active') AS members,
            EXISTS (SELECT 1 FROM agent_made a WHERE a.kind = 'group' AND a.ref = g.id AND a.created_via = ?) AS mine
        FROM groups g JOIN group_members gm ON gm.group_id = g.id
        WHERE gm.member_pubkey = ? AND gm.status = 'active' AND gm.role IN ('convenor', 'member') AND g.kind IS NULL AND ${NOT_CLOSED}
        ORDER BY g.created_at DESC LIMIT ?`).all(createdViaOf(grant), grant.member, limit) as Array<{ id: string; name: string; category: string; join_policy: string; role: string; members: number; mine: number }>;
    return {
        ok: true, rows: rows.length,
        result: {
            groups: rows.map((r) => ({
                groupId: r.id, category: r.category, categoryLabel: GROUP_CATEGORY_LABELS[r.category as keyof typeof GROUP_CATEGORY_LABELS] ?? null,
                joinPolicy: r.join_policy, role: r.role, members: r.members, madeByThisAssistant: r.mine === 1,
                name: fence(boundary, `group ${r.id}, name`, cleanMemberText(r.name, 120)),
            })),
            _notice: MEMBER_TEXT_NOTICE,
        },
    };
}

// ── Enterprises ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The enterprise form's limits (phone propose-project.tsx: a name of at least 2, at most 60; a description). */
export const AGENT_ENTERPRISE_NAME_MIN = 2;
export const AGENT_ENTERPRISE_NAME_MAX = 60;

const ENTERPRISE_FIELDS = ['name', 'description', 'lat', 'lng', 'photo_urls', 'photo_ids', 'photos'] as const;
const ENTERPRISE_ASKS = {
    name: `what it is called, ${AGENT_ENTERPRISE_NAME_MIN} to ${AGENT_ENTERPRISE_NAME_MAX} characters`,
    description: 'what it does and for whom: its purpose, as members read it',
};
/** An enterprise's photo: one, as its form asks. */
const ENTERPRISE_PHOTO_RULE: PhotoRule = {
    min: 1, max: 1,
    none: 'Add a photo first: an enterprise has one photo, as its form asks, from photo_urls, photo_ids or photos.',
    tooMany: 'An enterprise has one photo: send 1, from photo_urls, photo_ids or photos.',
};

/**
 * create_enterprise: what POST /api/enterprise runs after its signature check (routes/treasury.ts createEnterpriseHandler),
 * for an ongoing enterprise and nothing else: no goal, deadline or ceiling, a credit line of 0, the owner its lead keeper.
 */
async function createEnterpriseFor(grant: AgentGrant, args: Record<string, unknown>): Promise<ToolResult> {
    // Its routes' switch first, as their gate runs before the handler.
    const refused = gate(grant) ?? enterprisesOff() ?? strayField(args, ENTERPRISE_FIELDS, 'An enterprise') ?? missing(args, ENTERPRISE_ASKS)
        ?? tooLong('name', args.name, AGENT_ENTERPRISE_NAME_MAX, "the app's enterprise form");
    if (refused) return { ok: false, error: refused };
    const owner = grant.member;
    // The route's own checks of who is asking, in its order.
    if (!getActingMember(owner) || statusOf(owner) !== 'active') return { ok: false, error: 'Only active community members can create an enterprise: your account is not active.' };
    if (isOperatorSwitchedOff(owner)) return { ok: false, error: OPERATOR_SWITCHED_OFF_CREATE_ERROR };
    const name = replaceLoneSurrogates((args.name as string).trim());
    if (name.length < AGENT_ENTERPRISE_NAME_MIN) return { ok: false, error: `name is at least ${AGENT_ENTERPRISE_NAME_MIN} characters, as the app's enterprise form asks.` };
    const purpose = replaceLoneSurrogates((args.description as string).trim());
    try {
        assertNotMuted(owner);
        assertEnterpriseText(name, purpose);
    } catch (e) {
        return { ok: false, error: refusalText(e, grant, 'The enterprise could not be made.') };
    }
    const latSent = args.lat !== undefined, lngSent = args.lng !== undefined;
    if (latSent !== lngSent) return { ok: false, error: 'A place on the map is lat and lng together: send both, or neither.' };
    const lat = num(args.lat), lng = num(args.lng);
    if (latSent && (lat === undefined || lng === undefined)) return { ok: false, error: 'lat and lng are numbers: the place on the map.' };
    // Rounded as the apps round a pin (@beanpool/core approximateLocation).
    const pin = lat !== undefined && lng !== undefined ? approximateLocation(lat, lng) : null;
    const photos = await photosFrom(grant, args, ENTERPRISE_PHOTO_RULE);
    if (!photos.ok) return photos;
    return withPhotos(grant, photos, () => {
        if (!admitAgentCreate(grant.id)) return { ok: false, error: dayFull(grant) };
        try {
            const photo = stripImageValue(photos.photos[0]);
            const bytes = incomingPhotoBytes(photo);
            if (bytes > 0) assertMayStorePhotoBytes(owner, bytes);
            assertMayStartEnterprise(owner);
            assertAssistantDay(grant);
            const made = createTreasury(name, photo, 0, {
                purpose, lifecycle: 'ongoing', goalAmount: null, deadlineAt: null, workingCapitalCeiling: null, leadKeeperPubkey: owner,
                lat: pin?.lat ?? null, lng: pin?.lng ?? null, locationAuthSigner: pin ? owner : undefined,
            });
            recordMade(grant, 'enterprise', made.publicKey);
            return {
                ok: true, rows: 1,
                result: {
                    ref: enterpriseRef(made.publicKey), kind: 'enterprise', lifecycle: 'ongoing', keeper: 'you',
                    postsToday: assistantPostsToday(grant), postsPerDay: agentPostsPerDay(),
                },
            };
        } catch (e) {
            returnAgentCreate(grant.id);
            return { ok: false, error: refusalText(e, grant, 'The enterprise could not be made: try again later.') };
        }
    });
}

// ── The tools ────────────────────────────────────────────────────────────────────────────────────────────────────

const ONE_PICTURE = (what: string, required: boolean) => Object.fromEntries(Object.entries(PHOTO_PROPS).map(([k, v]) => [k, {
    ...v, maxItems: 1,
    description: `${required ? `${what}'s one photo, required` : `${what}'s picture, at most one; left out, its category's emblem`}: ${v.description.replace(/ 1 to \d+ photos are required[^.]*\./, '')}`,
}]));

const DAY_COUNT_WORDS = "it counts as one of the day's posts (connection_info's posts.perDay)";
/** A group post's: it is a post, so the post words hold. */
const SEEDED_WORDS = `${OWNERS_POST_WORDS.replace('the post is', 'it is')}; ${DAY_COUNT_WORDS}`;
/** A group's or an enterprise's: neither is deleted as a post is, and nothing shows a moderator that an assistant made it. */
const STARTED_WORDS = (owner: string) => `It is the owner's (${owner}), and ${DAY_COUNT_WORDS}`;

/** Slice S3's rows: owner-only, ticked "May post for me", as every create. */
export const OWNER_SEED_TOOLS: AgentTool[] = [
    {
        name: 'my_groups',
        title: 'Groups you are in',
        reads: `the open groups the member this assistant acts for is in, as a convenor or a member, newest first, at most ${AGENT_LIST_MAX}: each group's id `
            + "(for create_group_post), its kind, who may join, your role, how many members, whether this assistant made it, and its name, fenced",
        never: 'who is in a group, its chat, a group you are not in, or a key',
        memberText: true,
        ownerOnly: true,
        posts: true,
        inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: AGENT_LIST_MAX } }, additionalProperties: false },
        outputSchema: { type: 'object', properties: { groups: { type: 'array' } }, required: ['groups'] },
        run: (grant, args, boundary) => {
            // A read, as my_enterprises is: an owner's grant ticked "May post for me", never held to the day's posts.
            if (grant.role !== 'owner') return { ok: false, error: "Only an owner's assistant can post: an admin's cannot." };
            if (!grant.canPost) return { ok: false, error: NOT_TICKED };
            return myGroups(grant, args, boundary);
        },
    },
    {
        name: 'create_group',
        title: 'Start a group',
        reads: `nothing: it starts a group (a guild, a working group, a social circle) as the member this assistant acts for, its first convenor, live at once and `
            + 'listed to every member unless it is invite_only; its chat is the members\' own, and this assistant never reads or writes it. '
            + `No assistant removes a group: its convenors close it in the app. ${STARTED_WORDS('its first convenor')}; the member's own groups a day hold too`,
        never: "anything but the new group's id, or another member's data",
        ownerOnly: true,
        posts: true,
        write: true,
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', minLength: AGENT_GROUP_NAME_MIN, maxLength: AGENT_GROUP_NAME_MAX, description: `what it is called: ${AGENT_GROUP_NAME_MIN} to ${AGENT_GROUP_NAME_MAX} characters` },
                description: { type: 'string', maxLength: AGENT_GROUP_DESCRIPTION_MAX, description: `what it is for and who it is for, at most ${AGENT_GROUP_DESCRIPTION_MAX} characters; ${NO_TAGS_HERE.replace(' and free_tags', '')}` },
                category: { type: 'string', enum: [...GROUP_CATEGORIES], description: `its kind: ${GROUP_CATEGORIES.map((c) => `${c} (${GROUP_CATEGORY_LABELS[c]})`).join(', ')}` },
                join_policy: { type: 'string', enum: [...JOIN_POLICIES], description: 'open: anyone joins; request_to_join: a convenor approves each; invite_only: hidden, by invitation' },
                ...ONE_PICTURE('the group', false),
            },
            required: Object.keys(GROUP_ASKS),
            additionalProperties: false,
        },
        outputSchema: {
            type: 'object',
            properties: { groupId: { type: 'string' }, kind: { type: 'string' }, category: { type: 'string' }, joinPolicy: { type: 'string' }, role: { type: 'string' }, postsToday: { type: 'number' }, postsPerDay: { type: 'number' } },
            required: ['groupId', 'kind', 'postsToday', 'postsPerDay'],
        },
        run: (grant, args) => createGroupFor(grant, args),
    },
    {
        name: 'create_group_post',
        title: "Post an Offer or a Need to a group",
        reads: `nothing: it posts an Offer or a Need to one group the member this assistant acts for is in (group_id, from my_groups or create_group), seen by that group's `
            + `members only, with 1 to ${AGENT_POST_PHOTOS_MAX} photos, as the app's Post to Group; ${TAGS_WORDS}; ${SEEDED_WORDS}. my_posts, update_post and remove_post tend it as any post`,
        never: "anything but the new post's id and its link, or another member's data",
        ownerOnly: true,
        posts: true,
        write: true,
        get inputSchema() {
            const beansOn = getProfileSwitches().beans;
            return {
                type: 'object',
                properties: {
                    group_id: { type: 'string', description: 'the group: its id from my_groups, or the one create_group answered' },
                    kind: { type: 'string', enum: ['offer', 'need'] },
                    title: { type: 'string', maxLength: AGENT_GROUP_POST_TITLE_MAX, description: `what it is, in a few words: at most ${AGENT_GROUP_POST_TITLE_MAX} characters` },
                    description: { type: 'string', description: `the details a member reads (optional, as in the group form); ${NO_TAGS_HERE}` },
                    category: { type: 'string', enum: AGENT_POST_CATEGORIES, description: 'the Market category, as the apps offer them' },
                    beans: beansOn
                        ? { type: 'number', minimum: 0, description: "the listing's price in Beans (0 is free), as the group form asks: a price, never a payment" }
                        : { type: 'number', minimum: 0, maximum: 0, description: 'none: this community has no Beans' },
                    price_type: { type: 'string', enum: ['fixed', 'hourly'], description: 'fixed (default) or hourly' },
                    repeatable: { type: 'boolean', description: 'stays up after each trade' },
                    cash_also_needed: { type: 'boolean', description: 'a real cash outlay is attached (fuel, materials)' },
                    ...TAG_PROPS,
                    ...PHOTO_PROPS,
                },
                required: Object.keys(groupPostAsks()),
                additionalProperties: false,
            };
        },
        outputSchema: {
            type: 'object',
            properties: { postId: { type: 'string' }, kind: { type: 'string' }, groupId: { type: 'string' }, asEnterprise: { type: 'boolean' }, link: { type: 'string' }, postsToday: { type: 'number' }, postsPerDay: { type: 'number' } },
            required: ['postId', 'kind', 'groupId', 'link', 'postsToday', 'postsPerDay'],
        },
        run: (grant, args) => createGroupPost(grant, args),
    },
    {
        name: 'create_enterprise',
        title: 'Start an enterprise',
        reads: 'nothing: it starts an ongoing enterprise (a shared account for a stall, a co-op, the community itself) kept by the member this assistant acts for, '
            + 'its name, its purpose, one photo and, if given, its place: content only. It has no goal, deadline, ceiling or pledges and is never a project, its credit '
            + 'line is 0 as every member-made one\'s is, and it holds no Beans until members trade with it; a person sets anything more in the app. my_enterprises then '
            + 'lists it, so create_enterprise_listing and create_event post as it. No assistant winds one up: its keepers do, in the app. '
            + `${STARTED_WORDS('its lead keeper')}; the member's own enterprises a day hold too`,
        never: "an enterprise's key, a balance, or another member's data; it never moves Beans",
        ownerOnly: true,
        posts: true,
        write: true,
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', minLength: AGENT_ENTERPRISE_NAME_MIN, maxLength: AGENT_ENTERPRISE_NAME_MAX, description: `what it is called: ${AGENT_ENTERPRISE_NAME_MIN} to ${AGENT_ENTERPRISE_NAME_MAX} characters, not one already here` },
                description: { type: 'string', description: 'its purpose: what it does and for whom, as members read it on its page' },
                lat: { type: 'number', description: 'latitude of where it is, with lng, rounded to about 100 m as the apps do (optional)' },
                lng: { type: 'number', description: 'longitude of where it is, with lat (optional)' },
                ...ONE_PICTURE('the enterprise', true),
            },
            required: Object.keys(ENTERPRISE_ASKS),
            additionalProperties: false,
        },
        outputSchema: {
            type: 'object',
            properties: { ref: { type: 'string', description: 'its ref for as_enterprise' }, kind: { type: 'string' }, lifecycle: { type: 'string' }, keeper: { type: 'string' }, postsToday: { type: 'number' }, postsPerDay: { type: 'number' } },
            required: ['ref', 'kind', 'lifecycle', 'postsToday', 'postsPerDay'],
        },
        run: (grant, args) => createEnterpriseFor(grant, args),
    },
];
