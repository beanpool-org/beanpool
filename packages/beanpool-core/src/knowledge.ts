/**
 * Local knowledge: the fifth kind of post, read in its own place called Learn (scratch/fable-design/
 * DESIGN-local-knowledge-fable.md, amended by DESIGN-local-knowledge-amend-fable.md; Marty took every pick, 11 Nov 2026).
 * One file for the node and both apps: the kind, its topics, its limits, the reasons an owner or admin gives for "Not this
 * one", the order Learn lists in, and the shapes on the wire. Slice K0: words and rules only, no behaviour.
 *
 * - **Names.** Learn is the place; Local knowledge is the thing ("Add post → Local knowledge"); Local guide is the badge.
 *   Never "a knowledge": a count reads "3 to check". The internal type is `knowledge`.
 * - **Never in the Market.** The posts read leaves knowledge out unless a request names it (`types=…,knowledge` or
 *   `type=knowledge`), on every read, by id included, so an app built before it never meets one (§2.3). The map never pins
 *   one (map-type-filter.ts refuses the type by name; a knowledge post has no place).
 * - **On only where the node says so.** `features.knowledge` is present and true on a local community; a server from before
 *   it has none, and that is read as OFF (unlike the older switches, which a missing key leaves on): there is no Learn there.
 * - **Glyphs.** Every emoji here is Unicode 7 or older, so an API 26 phone draws it (no 🧭, which is Unicode 11).
 *
 * Pure and universal: no Node built-ins, no Intl, no regular expressions (the barrel is bundled for the phone).
 */
import { featureMode, type FeatureMode } from './features.js';
import { word } from './words.js';

/** The post type, as `posts.type` stores it and `types=` names it. */
export const KNOWLEDGE_TYPE = 'knowledge' as const;
export type KnowledgeType = typeof KNOWLEDGE_TYPE;

/** The feature key in a node's `features` (GET /api/community/info, /api/community/me, /api/home). */
export const KNOWLEDGE_FEATURE = 'knowledge' as const;

/** The three names (§2.1 as amended). Fixed words: shown through t(). */
export const KNOWLEDGE_NAMES = Object.freeze({
    /** The place: the screen's title, the Home card's "See all", "in Learn". */
    place: word('Learn'),
    /** The thing, wherever a kind is named: the chooser, a page's header, the queue. */
    kind: word('Local knowledge'),
    /** The badge (K8): three of a member's own posts, each helped three other members. Gates nothing. */
    badge: word('Local guide'),
});

/** 📖 for the kind, 🗺️ for the badge. */
export const KNOWLEDGE_EMOJI = '📖';
export const LOCAL_GUIDE_EMOJI = '🗺️';

/**
 * The topics, in Learn's fixed order (Emergencies first). The id is what `posts.category` holds for a knowledge post: none
 * is a listing category or a legacy alias (pricing-catalog.ts), so no listing read, price guide or category chip ever
 * takes one for its own. `keywords`: the topic's words in English, which the node adds to a post's search words as it
 * adds a tag's (§2.7), so "flood" finds an Emergencies page whatever its title says.
 */
export const KNOWLEDGE_TOPICS = Object.freeze([
    { id: 'emergencies', emoji: '🚨', label: word('Emergencies'), keywords: 'emergency emergencies urgent danger flood fire storm' },
    { id: 'local-services', emoji: '🚰', label: word('Local services'), keywords: 'service services council water waste recycling tip rubbish bins' },
    { id: 'getting-around', emoji: '🚌', label: word('Getting around'), keywords: 'transport bus train road roads parking travel lift' },
    { id: 'growing-animals', emoji: '🌿', label: word('Growing and animals'), keywords: 'garden growing plants seeds animals pets livestock' },
    { id: 'health-help', emoji: '⛑️', label: word('Health and help'), keywords: 'health help doctor clinic support care' },
    { id: 'places-history', emoji: '🏞️', label: word('Places and history'), keywords: 'place places history park walk heritage' },
    { id: 'good-to-know', emoji: '💡', label: word('Good to know'), keywords: 'tips good know' },
] as const);

export type KnowledgeTopicId = (typeof KNOWLEDGE_TOPICS)[number]['id'];
export type KnowledgeTopic = (typeof KNOWLEDGE_TOPICS)[number];

/** Whether a value is one of the topic ids. */
export function isKnowledgeTopic(value: unknown): value is KnowledgeTopicId {
    return typeof value === 'string' && KNOWLEDGE_TOPICS.some((topic) => topic.id === value);
}

/** One topic by id, or undefined. */
export function knowledgeTopic(id: unknown): KnowledgeTopic | undefined {
    return KNOWLEDGE_TOPICS.find((topic) => topic.id === id);
}

/** A topic's place in Learn's order (0 first); an unknown id sorts after every known one. */
export function knowledgeTopicRank(id: unknown): number {
    const at = KNOWLEDGE_TOPICS.findIndex((topic) => topic.id === id);
    return at === -1 ? KNOWLEDGE_TOPICS.length : at;
}

/**
 * The limits, in characters as the apps' fields count them (§2.2, §3.3, §4.1). A source's address follows a join link's
 * rule (http or https, at most 500 characters, no user name or password: the node's engine/posts.ts cleanEventLink).
 */
export const KNOWLEDGE_LIMITS = Object.freeze({
    title: 80,
    body: 3_000,
    place: 80,
    sources: 5,
    sourceUrl: 500,
    sourceLabel: 80,
    /** Why it was marked "may be out of date". */
    outdatedNote: 140,
    /** A fix's "What changed?" (K5). */
    changeNote: 300,
    /** The admin's own few words beside a reason for "Not this one" (K3). */
    reasonWords: 200,
    photos: 3,
});

/**
 * The reasons for "Not this one" (§5.4), in the order the sheet lists them. The writer reads the reason in their notice;
 * the notice names nobody (K3).
 */
export const KNOWLEDGE_DECLINE_REASONS = Object.freeze([
    { id: 'person', label: word("It's about a person") },
    { id: 'copied', label: word('It looks copied') },
    { id: 'unchecked', label: word("I couldn't check it") },
    { id: 'duplicate', label: word('We already have this') },
    { id: 'elsewhere', label: word("It isn't about this area") },
    { id: 'other', label: word('Another reason') },
] as const);

export type KnowledgeDeclineReason = (typeof KNOWLEDGE_DECLINE_REASONS)[number]['id'];

/** The standing line under every page and at the foot of Learn (§3.2 item 8, amended §3.1 item 7). */
export const KNOWLEDGE_STANDING_LINE = word('Local knowledge is written by members. Check the source before you rely on it.');

/** The line under Learn's title and on the Home card (amended §3.1 item 1, §3.6). */
export const KNOWLEDGE_PLACE_LINE = word('Things worth knowing about your community.');

// ── On the wire ──────────────────────────────────────────────────────────────────────────

/** One source: a plain link the member's browser opens, and what the page is. `label` empty: the app shows the host. */
export interface KnowledgeSource {
    url: string;
    label: string;
}

/**
 * What a knowledge post carries beside a post's own fields (§4.1), as `knowledge` on the posts read. Every date is an ISO
 * instant. `checkedAt`: when an owner or admin last confirmed it (approval, their own edit, "Still right"); the one meaning
 * of "Checked {date}". `gathered`: it was drafted by an owner's or admin's assistant and approved by them.
 */
export interface KnowledgeFields {
    sources: KnowledgeSource[];
    place: string | null;
    lang: string | null;
    checkedAt: string;
    outdatedAt: string | null;
    outdatedNote: string | null;
    helped: number;
    gathered: boolean;
}

/**
 * One row of Learn, as the row card draws it (amended §4.2): never the body, only its first line. `photo`: the first photo's
 * URL, or null for the topic's picture.
 */
export interface KnowledgeRow {
    id: string;
    title: string;
    line: string;
    topic: string;
    photo: string | null;
    checkedAt: string;
    helped: number;
    pinned: boolean;
    outdated: boolean;
}

/** GET /api/knowledge/front with no `q` and no `topic`: what Learn's front draws. At most three rows a topic. */
export interface KnowledgeFront {
    total: number;
    pinned: KnowledgeRow[];
    topics: Array<{ id: string; count: number; rows: KnowledgeRow[] }>;
}

/** The same read with `topic=`: that topic's rows, paged (`next` is the offset of the next page, or null). */
export interface KnowledgeTopicPage {
    topic: string;
    count: number;
    rows: KnowledgeRow[];
    next: number | null;
}

/** The same read with `q=`: the matches, best first, at most KNOWLEDGE_SEARCH_MAX. */
export interface KnowledgeSearch {
    total: number;
    rows: KnowledgeRow[];
}

/** Rows a topic shows on Learn's front before "See all {n} ›" (amended §3.1 item 6). */
export const KNOWLEDGE_FRONT_ROWS = 3;
/** The most matches a search answers (amended §4.2). */
export const KNOWLEDGE_SEARCH_MAX = 30;
/** The rows of one page of a topic. */
export const KNOWLEDGE_TOPIC_PAGE = 50;

/** The first line of a body, as a row shows it: up to the first line break, trimmed. */
export function knowledgeFirstLine(body: string): string {
    const text = typeof body === 'string' ? body.trim() : '';
    const end = text.indexOf('\n');
    return (end === -1 ? text : text.slice(0, end)).trim();
}

// ── Learn's order ────────────────────────────────────────────────────────────────────────

/** What the order reads of a row: the row card's fields, or the phone's copy of a post. */
export interface KnowledgeOrderFacts {
    topic: string;
    title: string;
    pinned?: boolean;
    helped?: number;
    outdated?: boolean;
}

/**
 * Learn's order (amended §2.11), never by date: topics in KNOWLEDGE_TOPICS' order; inside a topic, a page marked "may be out
 * of date" after every page that isn't; then pinned first, then most helped, then the title A to Z in the reader's
 * language (`compareTitles`, the reader's own collation where the app has one; the plain string order otherwise). The node
 * and the phone sort with this one rule, so a list reads the same online and offline.
 */
export function compareKnowledge(
    a: KnowledgeOrderFacts,
    b: KnowledgeOrderFacts,
    compareTitles: (x: string, y: string) => number = (x, y) => x.localeCompare(y),
): number {
    return knowledgeTopicRank(a.topic) - knowledgeTopicRank(b.topic)
        || Number(!!a.outdated) - Number(!!b.outdated)
        || Number(!!b.pinned) - Number(!!a.pinned)
        || (b.helped ?? 0) - (a.helped ?? 0)
        || compareTitles(a.title, b.title);
}

/** A sorted copy (the list given is not changed). */
export function sortKnowledge<T extends KnowledgeOrderFacts>(rows: readonly T[], compareTitles?: (x: string, y: string) => number): T[] {
    return [...rows].sort((a, b) => compareKnowledge(a, b, compareTitles));
}

// ── The feature ──────────────────────────────────────────────────────────────────────────

type FeatureSet = { [k: string]: unknown } | null | undefined;

/**
 * How Learn shows to one reader (features.ts modes). On only where the node's `features.knowledge` is true: a server from
 * before Learn says nothing, and has none, so a missing key is off, not on. Where it is off and the node shows previews
 * (`showcase`, the global community), Learn is previewed from Example Valley's samples (amended §2.9, slice K2).
 */
export function knowledgeFeatureMode(node: FeatureSet, reader?: FeatureSet): FeatureMode {
    const nodeOn = node?.[KNOWLEDGE_FEATURE] === true;
    const readerOn = (reader ?? node)?.[KNOWLEDGE_FEATURE] === true;
    return featureMode({ showcase: node?.showcase === true, node: nodeOn, effective: readerOn });
}

// ── The Pulse card (slice KP) ────────────────────────────────────────────────────────────

/** A feed item's `source` for the knowledge card: both apps branch on it before anything else (amended §3.8). */
export const PULSE_KNOWLEDGE_SOURCE = 'knowledge' as const;

/** One page on the Pulse's knowledge card: a row, never the body. `by`: the writer's name on a single page they wrote. */
export interface PulseKnowledgePost {
    id: string;
    title: string;
    topic: string;
    line: string;
    photo: string | null;
    by: string | null;
    gathered: boolean;
}

/**
 * The knowledge card on the Pulse feed (amended §3.8): worked out from the posts when the feed is read with
 * `with=knowledge`, one a day at most, never stored. It keeps a feed item's fields so one list holds both kinds.
 */
export interface PulseKnowledgeCard {
    /** `know_<local date>`. */
    id: string;
    source: typeof PULSE_KNOWLEDGE_SOURCE;
    platform: 'beanpool';
    category: 'knowledge';
    url: null;
    thumbnailUrl: null;
    title: string;
    publishedAt: string;
    knowledge: { count: number; posts: PulseKnowledgePost[] };
}

/** Whether a feed item is the knowledge card. */
export function isPulseKnowledgeCard(item: unknown): item is PulseKnowledgeCard {
    return !!item && typeof item === 'object' && (item as { source?: unknown }).source === PULSE_KNOWLEDGE_SOURCE;
}
