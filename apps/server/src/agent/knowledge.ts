/**
 * Local knowledge for an owner's or admin's assistant (slice K6; scratch/fable-design/DESIGN-local-knowledge-fable.md §2.2, §2.4,
 * §6, §7, as amended by DESIGN-local-knowledge-amend-fable.md §A5; every pick Marty's, 11 Nov 2026). The assistant drafts, a
 * person publishes.
 *
 * - **Offered to every owner's and admin's connection while Learn is on**, with no tick: a draft changes nothing members see,
 *   so it is to Local knowledge what `suggest_action` is to moderation. Switched off (the global community), none is listed and
 *   a call by name is refused in words.
 * - **A draft is never a post.** knowledge_draft writes a row in `knowledge_drafts` (engine/knowledge-drafts.ts
 *   fileAssistantKnowledgeDraft), `via` 'assistant:<grant id>', for the member the assistant acts for. Only an owner's or
 *   admin's approval in the app makes the page, after the tick "I opened the sources and they say this."; the page is then the
 *   approver's and marked `created_via` 'assistant-draft:<grant id>', which the assistant's own post tools (my_posts,
 *   update_post, remove_post, remove_all_i_made) and Settings' "Remove its posts" never match: they match 'assistant:<grant id>'.
 *   It can't edit or remove approved knowledge.
 * - **Pictures through the upload door only** (Damo's ask; Marty, 16 Nov 2026: "Yes, through the upload link only, the checker
 *   approves it"; this changes the design's K6 row "a photo field is refused"): `photo_ids`, at most 3, each a photo this grant
 *   uploaded through the door listings use (photo_upload_link or POST /mcp/photos, agent/owner-photos.ts: made 800 px with no
 *   metadata, at most 5 MB, a JPEG, WebP or PNG, counted in the grant's photos for the day), so only an owner's assistant
 *   ticked "May post for me" brings one. Never an address: `photo_urls`, a picture written into the call, or an address in
 *   photo_ids is refused in words, and this server fetches no picture for a draft. The pictures wait with the draft
 *   (engine/knowledge-drafts.ts), seen by nobody but the owners and admins in To check, who keep or remove each before
 *   Approve; an upload is used up only by a draft that was filed. The tool tells the assistant: only pictures the member took
 *   or owns, never one found on the web.
 * - **Its own tags** (Learn's tags, 16 Nov 2026): `free_tags`, the words a member types in the apps' Tags field, under the
 *   Market's rule for them (engine/knowledge.ts cleanKnowledgeInput, the same door as a member's). Never the library's ids:
 *   `tags` is refused in words, as the node refuses it, so the assistant never believes a library tag is on a page.
 * - **Limits** (engine/knowledge-drafts.ts ASSISTANT_KNOWLEDGE_LIMITS): 10 waiting and 20 in 24 hours per connection, 30
 *   waiting from all assistants together, so members' suggestions are never buried.
 * - **Disconnecting drops its waiting drafts** (dropAssistantKnowledgeDrafts, beside dropSuggestionsOf on every revoke path).
 * - **Reads are what members read, fenced**: the pages showing (never one hidden by reports), never who wrote one or who it
 *   helped, never a member's waiting suggestion. Every title, body, place, source and note is a member's (or a web page's)
 *   text: fenced, the fence's limit raised to the body's 3,000 for the body. A source's address comes back fenced too, as
 *   my_posts reads back an online event's join link: it is text someone typed, not a link this server vouches for.
 * - **A fix** (`fix_of`, §6) waits for slice K5, which answers fixes in To check: until then it is refused in words, so no draft
 *   sits in To check that nobody can approve or say no to.
 *
 * Nothing here calls a model or reaches another server: the assistant searches the web itself.
 */
import {
    FREE_TAG_MAX_CHARS, FREE_TAG_MAX_WORDS, FREE_TAG_MIN_CHARS, FREE_TAGS_MAX, KNOWLEDGE_LIMITS, KNOWLEDGE_TOPICS, compareKnowledge, isKnowledgeTopic,
} from '@beanpool/core';
import type { MarketplacePost } from '@beanpool/engine';
import { FeatureOffError, getProfileSwitches } from '../config/node-profile.js';
import { StandbyLedgerError } from '../config/node-role.js';
import { KnowledgeRefusal, knowledgeRowOf, pageShowingTo, showingTo } from '../engine/knowledge.js';
import {
    ASSISTANT_KNOWLEDGE_LIMITS, KNOWLEDGE_ABOUT, assistantKnowledgeCounts, assistantKnowledgeDrafts, fileAssistantKnowledgeDraft,
    withdrawAssistantKnowledgeDraft,
} from '../engine/knowledge-drafts.js';
import { fence, MEMBER_TEXT_NOTICE } from './fence.js';
import { AGENT_LIST_MAX } from './limits.js';
import { claimUploadedPhotos, PHOTO_SOURCE_MAX_BYTES, PHOTO_UPLOAD_KEEP_MS } from './owner-photos.js';
import { grantMayStillPost } from './owner-posts.js';
import type { AgentGrant, AgentTool, ToolResult } from './tools.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether Learn is on here (the profile switch `knowledge`): only then are these tools offered. */
export const knowledgeOn = (): boolean => getProfileSwitches().knowledge === true;

/** A call by name while Learn is off (a tools list read before an owner switched it off). */
export const KNOWLEDGE_OFF_WORDS = 'Local knowledge is switched off on this community: there is no Learn here.';
/** The one door for a draft's pictures, in the words every picture refusal ends with. */
const PICTURE_DOOR = "upload the member's own photo with photo_upload_link (or POST /mcp/photos) and give the photoId it answers in photo_ids.";
/** A picture by its address, written into the call, or under any other name than photo_ids. */
export const NO_WEB_PICTURE = `A draft takes no picture from the web and none written into the call: ${PICTURE_DOOR}`;
/** A grant that can't use the upload door (an admin's, or an owner's without the tick): the door's own rule. */
const NO_PICTURE_DOOR = 'Only an owner\'s assistant connected with "May post for me" can upload pictures, so this one can\'t add any: file the draft '
    + 'without photo_ids, and the owner or admin who checks it can add their own.';
const TOO_MANY_PICTURES = `At most ${KNOWLEDGE_LIMITS.photos} pictures a draft, as a page holds.`;
/** What the tool says about pictures, in its description and photo_ids' (Marty, 16 Nov 2026). */
const PICTURE_RULE = 'Only pictures the member took or owns, never one found on the web; the checker sees each and keeps or removes it before '
    + 'anything shows';
const NO_FIX_YET = 'A fix to a page showing comes with a later version of this server: tell the admin what changed, with the source that says so, '
    + 'and they edit the page in the app (Learn, the page, Edit).';
/** Library ids on a draft: Local knowledge takes its own tags only, as the node refuses them (engine/knowledge.ts). */
const NO_LIBRARY_TAGS = 'Local knowledge takes no tags from the library: put its own words in free_tags.';
const FREE_TAGS_NAME = 'Its own tags go in free_tags.';
const NO_PAGE = 'No page of Local knowledge showing here has that id: list them with knowledge_list.';
const NOT_ITS_DRAFT = 'This assistant has no draft waiting with that id: my_knowledge_drafts lists them.';
/** What knowledge_draft answers, word for word (amended §A5): the assistant passes it on. */
export const KNOWLEDGE_DRAFT_WAITING = 'Waiting for an owner or admin to check it in the app (Learn, To check). Nothing shows to members yet: '
    + 'say you drafted it, never that it is published.';
/** The body's fence limit: the whole body a page may hold (§6: "the fence's limit raised to 3,000 for the body"). */
const BODY_FENCE_MAX = KNOWLEDGE_LIMITS.body;

/** The members' link to a page, a path the assistant joins to the address in its welcome (as my_posts' `link`). */
const linkPath = (id: string) => `/?post=${encodeURIComponent(id)}`;
const TOPIC_IDS = KNOWLEDGE_TOPICS.map((t) => t.id as string);

/** This connection's drafts against its limits, for connection_info (`knowledge: { waiting, today, perDay }`). */
export function knowledgeSummary(grant: AgentGrant): { waiting: number; waitingMax: number; today: number; perDay: number } {
    const c = assistantKnowledgeCounts(grant.id);
    return { waiting: c.waiting, waitingMax: ASSISTANT_KNOWLEDGE_LIMITS.waiting, today: c.today, perDay: ASSISTANT_KNOWLEDGE_LIMITS.perDay };
}

/** A refusal the engine wrote in words (the form's, a limit's, a standby's), as the tool's error; anything else is thrown on. */
function refused(e: unknown): ToolResult {
    // A tag the rule refuses is named by its field, as the post tools name theirs (owner-posts.ts heldTags).
    if (e instanceof KnowledgeRefusal && e.code === 'bad_tags') return { ok: false, error: `free_tags: ${e.message}` };
    if (e instanceof KnowledgeRefusal || e instanceof StandbyLedgerError) return { ok: false, error: e.message };
    if (e instanceof FeatureOffError) return { ok: false, error: KNOWLEDGE_OFF_WORDS };
    throw e;
}

const wantsText = (args: Record<string, unknown>) => args.include_text === true || args.include_text === 'true';

function whole(v: unknown, def: number, min: number, max: number): number {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= min ? Math.min(n, max) : def;
}

function truthy(v: unknown): boolean {
    return v === true || v === 'true';
}

/** Any field that would carry a picture, but photo_ids: refused whatever its name (§2.5, §6). */
const PICTURE_FIELD = /photo|image|picture|thumbnail/i;
/** An address, never fetched: a scheme, a leading //, or www. */
const ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|www\.)/i;

type Pictures = { ok: true; photos: string[]; settle: (used: boolean) => void } | { ok: false; error: string };

/**
 * The pictures a draft brings: its photo_ids, each one this grant uploaded through the door and has not used, claimed for this
 * draft until `settle` (agent/owner-photos.ts claimUploadedPhotos). Refused in words before anything is claimed: a grant the
 * door is closed to, more than a page holds, an address or a picture written in. Nothing here fetches anything.
 */
function picturesOf(grant: AgentGrant, raw: unknown): Pictures {
    if (raw === undefined || raw === null) return { ok: true, photos: [], settle: () => undefined };
    if (!Array.isArray(raw)) return { ok: false, error: 'photo_ids is a list of the photoIds uploads answered.' };
    if (raw.length === 0) return { ok: true, photos: [], settle: () => undefined };
    if (raw.length > KNOWLEDGE_LIMITS.photos) return { ok: false, error: TOO_MANY_PICTURES };
    for (let i = 0; i < raw.length; i++) {
        const v = typeof raw[i] === 'string' ? (raw[i] as string).trim() : '';
        if (ADDRESS.test(v)) return { ok: false, error: `photo_ids #${i + 1} is an address: this server never fetches a picture for a draft. Instead, ${PICTURE_DOOR}` };
        if (/^data:/i.test(v)) return { ok: false, error: `photo_ids #${i + 1} is a picture written into the call: ${PICTURE_DOOR}` };
    }
    if (!grantMayStillPost(grant)) return { ok: false, error: NO_PICTURE_DOOR };
    return claimUploadedPhotos(grant.id, raw);
}

const OBJ = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required });
const STR = { type: 'string' };
const NUM = { type: 'number' };
const BOOL = { type: 'boolean' };
const ARR = { type: 'array' };

function pageRow(p: MarketplacePost, now: number) {
    const r = knowledgeRowOf(p, now);
    return {
        id: r.id,
        topic: r.topic,
        checkedAt: r.checkedAt,
        outOfDate: r.outdated,
        outOfDateSince: p.knowledge?.outdatedAt ?? null,
        helped: r.helped,
        pinned: r.pinned,
        linkPath: linkPath(r.id),
    };
}

export const KNOWLEDGE_TOOLS: AgentTool[] = [
    {
        name: 'knowledge_list',
        title: 'Local knowledge showing',
        reads: `the pages of Local knowledge showing to members here, in Learn's order (topics in order, then pinned, most helped, `
            + `title), at most ${AGENT_LIST_MAX} a call from \`offset\`: each page's id, topic, when an owner or admin last checked it, `
            + 'whether it is marked out of date and since when, how many members it helped, whether it is pinned, and the link path members '
            + 'open it at; filters `topic`, `out_of_date_only` and `older_than_days` (not checked for that many days); with include_text, '
            + 'each title, fenced. Read it before drafting so you never repeat a page',
        never: "who wrote a page or who it helped, a key, a page hidden by reports, or members' suggestions waiting for an admin",
        memberText: true,
        knowledge: true,
        refusedTo: () => (knowledgeOn() ? null : KNOWLEDGE_OFF_WORDS),
        inputSchema: {
            type: 'object',
            properties: {
                topic: { type: 'string', enum: TOPIC_IDS, description: 'one topic only' },
                out_of_date_only: { type: 'boolean', description: 'only the pages marked "may be out of date"' },
                older_than_days: { type: 'integer', minimum: 1, description: 'only the pages not checked for at least this many days (365: a year)' },
                include_text: { type: 'boolean', description: 'add each title, fenced' },
                limit: { type: 'integer', minimum: 1, maximum: AGENT_LIST_MAX },
                offset: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
        },
        outputSchema: OBJ({ total: NUM, returned: NUM, offset: NUM, pages: ARR, topics: ARR }, ['total', 'returned', 'offset', 'pages', 'topics']),
        run: (grant, args, boundary) => {
            if (!knowledgeOn()) return { ok: false, error: KNOWLEDGE_OFF_WORDS };
            if (args.topic !== undefined && !isKnowledgeTopic(args.topic)) return { ok: false, error: `topic must be one of ${TOPIC_IDS.join(', ')}.` };
            const now = Date.now();
            const asked = args.older_than_days === undefined ? null : Math.floor(Number(args.older_than_days));
            if (asked !== null && !(Number.isFinite(asked) && asked >= 1)) return { ok: false, error: 'older_than_days is a whole number of days, 1 or more (365: a year).' };
            const days = asked === null ? null : Math.min(asked, 36_500);
            const before = days === null ? null : now - days * DAY_MS;
            const pages = showingTo(grant.member)
                .filter((p) => args.topic === undefined || p.category === args.topic)
                .filter((p) => !truthy(args.out_of_date_only) || !!p.knowledge?.outdatedAt)
                .filter((p) => {
                    if (before === null) return true;
                    const at = Date.parse(p.knowledge?.checkedAt ?? p.createdAt);
                    return Number.isFinite(at) && at <= before;
                })
                .sort((x, y) => compareKnowledge(knowledgeRowOf(x, now), knowledgeRowOf(y, now)));
            const offset = whole(args.offset, 0, 0, 1_000_000);
            const page = pages.slice(offset, offset + whole(args.limit, AGENT_LIST_MAX, 1, AGENT_LIST_MAX));
            const withText = wantsText(args);
            const result: Record<string, unknown> = {
                total: pages.length,
                returned: page.length,
                offset,
                pages: page.map((p) => ({ ...pageRow(p, now), ...(withText ? { title: fence(boundary, `Local knowledge ${p.id}, title`, p.title) } : {}) })),
                topics: TOPIC_IDS,
            };
            if (withText) result._notice = MEMBER_TEXT_NOTICE;
            return { ok: true, rows: page.length, result };
        },
    },
    {
        name: 'knowledge_get',
        title: 'One page of Local knowledge',
        reads: 'one page of Local knowledge showing here: its id, topic, when it was last checked, the out-of-date mark and its note, how '
            + 'many it helped, the link path, and its title, body (whole, up to 3,000 characters), place and sources (each address and '
            + 'what the page is), fenced',
        never: 'who wrote it or who it helped, a key, a page hidden by reports, or a suggestion waiting for an admin',
        memberText: true,
        knowledge: true,
        refusedTo: () => (knowledgeOn() ? null : KNOWLEDGE_OFF_WORDS),
        inputSchema: {
            type: 'object',
            properties: { post_id: { type: 'string', description: 'the id from knowledge_list' } },
            required: ['post_id'],
            additionalProperties: false,
        },
        outputSchema: OBJ({ page: { type: 'object' } }),
        run: (grant, args, boundary) => {
            if (!knowledgeOn()) return { ok: false, error: KNOWLEDGE_OFF_WORDS };
            const p = pageShowingTo(grant.member, typeof args.post_id === 'string' ? args.post_id.trim() : args.post_id);
            if (!p) return { ok: false, error: NO_PAGE };
            const what = (field: string) => `Local knowledge ${p.id}, ${field}`;
            const k = p.knowledge;
            return {
                ok: true, rows: 1,
                result: {
                    page: {
                        ...pageRow(p, Date.now()),
                        title: fence(boundary, what('title'), p.title),
                        body: fence(boundary, what('body'), p.description, BODY_FENCE_MAX),
                        place: fence(boundary, what('place'), k?.place ?? null),
                        sources: (k?.sources ?? []).map((s, i) => ({
                            url: fence(boundary, what(`source ${i + 1}, address`), s.url),
                            label: fence(boundary, what(`source ${i + 1}, what the page is`), s.label),
                        })),
                        outOfDateNote: fence(boundary, what('out-of-date note'), k?.outdatedNote ?? null),
                    },
                    _notice: MEMBER_TEXT_NOTICE,
                },
            };
        },
    },
    {
        name: 'knowledge_draft',
        title: 'Draft Local knowledge',
        reads: 'nothing: it files a draft of Local knowledge (title, body, topic, what it is about, 1 to 5 sources, and if you like the '
            + `place, its language, up to ${FREE_TAGS_MAX} tags of its own and up to ${KNOWLEDGE_LIMITS.photos} pictures uploaded first through photo_upload_link) that waits `
            + `for an owner or admin to check in the app (Learn, To check) beside its sources; nothing shows to members until a person approves it. ${PICTURE_RULE}. `
            + `At most ${ASSISTANT_KNOWLEDGE_LIMITS.waiting} waiting and `
            + `${ASSISTANT_KNOWLEDGE_LIMITS.perDay} in 24 hours for this connection, ${ASSISTANT_KNOWLEDGE_LIMITS.allWaiting} waiting from all `
            + 'assistants together. It answers the draft\'s id and the words to pass on',
        never: 'a published page, or a picture from the web: the assistant cannot publish Local knowledge, edit or remove a page, or give a picture by its address',
        knowledge: true,
        write: true,
        refusedTo: () => (knowledgeOn() ? null : KNOWLEDGE_OFF_WORDS),
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', maxLength: KNOWLEDGE_LIMITS.title, description: 'what someone would look for, e.g. "How recycling works at the tip"' },
                body: { type: 'string', maxLength: KNOWLEDGE_LIMITS.body, description: 'the answer first, then the details: short, in your own words, plain text; quote at most one sentence, in quotation marks; never a list of tags: those go in free_tags' },
                topic: { type: 'string', enum: TOPIC_IDS },
                about: { type: 'string', enum: [...KNOWLEDGE_ABOUT], description: 'a place, a service or how to do something: never a private person' },
                sources: {
                    type: 'array', minItems: 1, maxItems: KNOWLEDGE_LIMITS.sources,
                    items: {
                        type: 'object',
                        properties: { url: { type: 'string', description: 'https:// or http://' }, title: { type: 'string', maxLength: KNOWLEDGE_LIMITS.sourceLabel, description: 'what the page is' } },
                        required: ['url'],
                    },
                },
                place: { type: 'string', maxLength: KNOWLEDGE_LIMITS.place, description: 'where, in words (there is no map pin)' },
                language: { type: 'string', description: 'the language you wrote it in, as a code (en, fr, …)' },
                free_tags: {
                    type: 'array', maxItems: FREE_TAGS_MAX,
                    items: { type: 'string', description: 'one tag, e.g. bulk waste' },
                    description: `optional: the page's own tags, words someone would search Learn for that the title and body may not say. At most ${FREE_TAGS_MAX}, `
                        + `each ${FREE_TAG_MIN_CHARS} to ${FREE_TAG_MAX_CHARS} characters and at most ${FREE_TAG_MAX_WORDS} words, never an email, a phone number, a web address `
                        + 'or an @handle. Public with the page, never translated, found only by their own letters. Never ids from tags_search: Local knowledge takes none',
                },
                photo_ids: {
                    type: 'array', maxItems: KNOWLEDGE_LIMITS.photos,
                    items: { type: 'string', pattern: '^ph_[0-9a-f]{32}$', description: 'a photoId an upload answered' },
                    description: `optional: up to ${KNOWLEDGE_LIMITS.photos} pictures for the page, each uploaded first: get an address with photo_upload_link and send `
                        + `each image to it (a JPEG, WebP or PNG, at most ${PHOTO_SOURCE_MAX_BYTES / (1024 * 1024)} MB; the server makes it 800 px with nothing hidden in it), `
                        + `then give the photoId it answers here, once, within ${PHOTO_UPLOAD_KEEP_MS / 3_600_000} hours. Only an owner's assistant connected with `
                        + `"May post for me" can upload. ${PICTURE_RULE}. Never an address: this server fetches no picture for a draft`,
                },
            },
            required: ['title', 'body', 'topic', 'about', 'sources'],
            additionalProperties: false,
        },
        outputSchema: OBJ({ draftId: STR, state: STR, published: BOOL, waitingFor: STR, waiting: NUM, today: NUM, perDay: NUM, photos: NUM }),
        run: (grant, args) => {
            if (!knowledgeOn()) return { ok: false, error: KNOWLEDGE_OFF_WORDS };
            if (Object.keys(args).some((key) => key !== 'photo_ids' && PICTURE_FIELD.test(key))) return { ok: false, error: NO_WEB_PICTURE };
            if (args.fix_of !== undefined || args.note !== undefined) return { ok: false, error: NO_FIX_YET };
            if (args.tags !== undefined && args.tags !== null && !(Array.isArray(args.tags) && args.tags.length === 0)) return { ok: false, error: NO_LIBRARY_TAGS };
            if (args.freeTags !== undefined) return { ok: false, error: FREE_TAGS_NAME };
            const sources = Array.isArray(args.sources)
                ? args.sources.map((s) => {
                    const o = (s && typeof s === 'object' ? s : {}) as { url?: unknown; title?: unknown; label?: unknown };
                    return { url: o.url, label: o.title ?? o.label };
                })
                : args.sources;
            const pictures = picturesOf(grant, args.photo_ids);
            if (!pictures.ok) return { ok: false, error: pictures.error };
            let filed: ReturnType<typeof fileAssistantKnowledgeDraft> | null = null;
            try {
                filed = fileAssistantKnowledgeDraft(
                    { id: grant.id, member: grant.member, name: grant.name },
                    {
                        title: args.title, body: args.body, topic: args.topic, place: args.place, sources, lang: args.language, about: args.about, freeTags: args.free_tags,
                        photos: pictures.photos,
                    },
                );
            } catch (e) {
                return refused(e);
            } finally {
                // An upload is used up only by a draft that was filed: refused, it can be sent again.
                pictures.settle(filed !== null);
            }
            return {
                ok: true, rows: 1,
                result: {
                    draftId: filed.id, state: 'waiting', published: false, waitingFor: KNOWLEDGE_DRAFT_WAITING,
                    waiting: filed.waiting, today: filed.today, perDay: ASSISTANT_KNOWLEDGE_LIMITS.perDay, photos: filed.photos,
                },
            };
        },
    },
    {
        name: 'my_knowledge_drafts',
        title: 'Its own drafts of Local knowledge',
        reads: `this connection's own drafts of Local knowledge, newest first, at most ${AGENT_LIST_MAX}: each one's id, topic, when it `
            + 'was filed and answered, and how it ended: waiting, added (with the page\'s id) or not_added (with the reason\'s id: person, '
            + 'copied, unchecked, duplicate, elsewhere or other); with include_text, each title, fenced. One taken back is not listed',
        never: "the admin's own words, who answered, or another connection's drafts",
        memberText: true,
        knowledge: true,
        refusedTo: () => (knowledgeOn() ? null : KNOWLEDGE_OFF_WORDS),
        inputSchema: {
            type: 'object',
            properties: {
                include_text: { type: 'boolean', description: 'add each title, fenced' },
                limit: { type: 'integer', minimum: 1, maximum: AGENT_LIST_MAX },
            },
            additionalProperties: false,
        },
        outputSchema: OBJ({ total: NUM, returned: NUM, waiting: NUM, today: NUM, perDay: NUM, drafts: ARR }),
        run: (grant, args, boundary) => {
            if (!knowledgeOn()) return { ok: false, error: KNOWLEDGE_OFF_WORDS };
            const { drafts, total } = assistantKnowledgeDrafts(grant.id, whole(args.limit, AGENT_LIST_MAX, 1, AGENT_LIST_MAX));
            const counts = assistantKnowledgeCounts(grant.id);
            const withText = wantsText(args);
            const result: Record<string, unknown> = {
                total, returned: drafts.length, waiting: counts.waiting, today: counts.today, perDay: ASSISTANT_KNOWLEDGE_LIMITS.perDay,
                drafts: drafts.map((x) => ({
                    id: x.id, kind: x.kind, topic: x.topic, state: x.state, createdAt: x.createdAt, answeredAt: x.answeredAt, postId: x.postId,
                    reason: x.reason, ...(withText ? { title: fence(boundary, `draft ${x.id}, title`, x.title) } : {}),
                })),
            };
            if (withText) result._notice = MEMBER_TEXT_NOTICE;
            return { ok: true, rows: drafts.length, result };
        },
    },
    {
        name: 'knowledge_draft_withdraw',
        title: 'Take back a draft of Local knowledge',
        reads: 'nothing: it takes back one of this connection\'s own drafts still waiting, so no owner or admin sees it; it still counts '
            + 'for the day',
        never: 'a page showing, or another connection\'s draft',
        knowledge: true,
        write: true,
        refusedTo: () => (knowledgeOn() ? null : KNOWLEDGE_OFF_WORDS),
        inputSchema: {
            type: 'object',
            properties: { draft_id: { type: 'string', description: 'the id knowledge_draft answered, or from my_knowledge_drafts' } },
            required: ['draft_id'],
            additionalProperties: false,
        },
        outputSchema: OBJ({ withdrawn: STR, waiting: NUM }),
        run: (grant, args) => {
            if (!knowledgeOn()) return { ok: false, error: KNOWLEDGE_OFF_WORDS };
            const id = typeof args.draft_id === 'string' ? args.draft_id.trim() : '';
            try {
                if (!withdrawAssistantKnowledgeDraft(grant.id, id)) return { ok: false, error: NOT_ITS_DRAFT };
            } catch (e) {
                return refused(e);
            }
            return { ok: true, rows: 1, result: { withdrawn: id, waiting: assistantKnowledgeCounts(grant.id).waiting } };
        },
    },
];
