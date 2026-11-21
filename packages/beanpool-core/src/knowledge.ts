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
import { freeTagStored, freeTagsOf } from './tags/free-tags.js';
import { t, word, wordn, type Words } from './words.js';

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

/**
 * A page's own tags (Learn's tags, 16 Nov 2026; the node is #3219): free tags only, under the Market's rule for the tags a member
 * types (tags/free-tags.ts), never the library's ids. Both apps' forms take them in the Market's Tags field, free tags alone
 * (typed-tags.ts `freeOnly`); a page shows them, and a tap searches Learn for one.
 */
export const KNOWLEDGE_TAG_WORDS = Object.freeze({
    /** Under the Tags field's sheet, in place of the Market's two lines. */
    hint: word('Tags help people find this page in Learn. Everyone can see them.'),
    /** What a screen reader says for a tag on a page. `{tag}` is the tag with its `#`. */
    searchFor: word('Search Learn for {tag}'),
});

/**
 * Whether two lists of a page's tags differ, each read in its stored form and in its order, as the node compares a fix's part
 * (engine/knowledge-drafts.ts): what "Suggest a fix" sends only when the member changed it.
 */
export function knowledgeTagsDiffer(a: unknown, b: unknown): boolean {
    const stored = (tags: unknown) => JSON.stringify(freeTagsOf(tags).map(freeTagStored));
    return stored(a) !== stored(b);
}

/** The line under Learn's title and on the Home card (amended §3.1 item 1, §3.6). */
export const KNOWLEDGE_PLACE_LINE = word('Things worth knowing about your community.');

// ── On the wire ──────────────────────────────────────────────────────────────────────────

/**
 * One source: a plain link the member's browser opens, and what the page is. `label` empty: the app shows the host.
 *
 * `photo` (pictures from Wikimedia Commons, DESIGN-learn-web-pictures-fable.md §6.3; Marty, 22 Nov 2026, "All six of Fable's
 * picks"): a credit row the node wrote for the page's picture number `photo` (1 first), never typed by anyone: its label is
 * {@link knowledgeCreditLabel}'s and its url the picture's own page on Commons. A page's sources read as its own rows, then its
 * credit rows. Forms list and send the own rows only ({@link ownKnowledgeSources}); a row sent back with the mark, or a camera
 * row pointing at one of the page's credited pictures, is dropped by the node and its own written again (Question 5).
 */
export interface KnowledgeSource {
    url: string;
    label: string;
    photo?: number;
}

/** What a credit row's label starts with, and how the node knows one sent back by an app that draws it as a source. */
export const KNOWLEDGE_CREDIT_MARK = '📷';

/**
 * What the node read about a picture from Wikimedia Commons, kept with it: on a draft for To check (`photoCredits`), and in its
 * credit row on the page. Every text is plain, cleaned and capped by the node.
 */
export interface KnowledgePhotoCredit {
    /** The picture's own page on Commons (https://commons.wikimedia.org/wiki/File:…). */
    url: string;
    /** Its file name on Commons, "File:…". */
    file: string;
    /** Who made it, as Commons gives it: plain text; '' when Commons names nobody and its licence needs no credit. */
    maker: string;
    /** The licence's own short name: "CC BY 4.0", "CC BY-SA 4.0", "CC0" or "Public domain". */
    licence: string;
    /** The licence's own page, or null for public domain. */
    licenceUrl: string | null;
    /** Commons' notes on other rights, as its codes ("personality", "trademarked"); [] for none. */
    restrictions: string[];
    /** When this server read it, an ISO instant. */
    readAt: string;
}

/** A source row is the node's credit for a picture (it carries the mark). */
export const isKnowledgeCreditRow = (s: { photo?: unknown }): boolean => s.photo !== undefined && s.photo !== null;

/** A page's own sources, without the node's credit rows: what a form lists and sends. */
export function ownKnowledgeSources<T extends { photo?: unknown }>(sources: readonly T[]): T[] {
    return sources.filter((s) => !isKnowledgeCreditRow(s));
}

/**
 * A credit row's label: "📷 {n} · {maker} · {licence}" (or "📷 {n} · {licence}" with no maker), at most
 * KNOWLEDGE_LIMITS.sourceLabel characters, the maker cut short with "…" to fit. No words to translate: a camera, a name and a
 * licence's own short name.
 */
export function knowledgeCreditLabel(n: number, maker: string, licence: string): string {
    const head = `${KNOWLEDGE_CREDIT_MARK} ${n} · `;
    const tail = ` · ${licence}`;
    const name = Array.from(maker.replace(/\s+/g, ' ').trim());
    if (name.length === 0) return Array.from(`${head}${licence}`).slice(0, KNOWLEDGE_LIMITS.sourceLabel).join('');
    const room = KNOWLEDGE_LIMITS.sourceLabel - Array.from(head).length - Array.from(tail).length;
    const fitted = name.length <= room ? name.join('') : `${name.slice(0, Math.max(0, room - 1)).join('').trimEnd()}…`;
    return `${head}${fitted}${tail}`;
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
    /**
     * Whether this reader tapped "This helped" (slice K5): only on a member's signed read of one page by id (`id=` or
     * `ids=`, not a sync), so a list or a copy never carries one member's taps. Absent elsewhere.
     */
    helpedByMe?: boolean;
    /**
     * Whether the page's writer is a Local guide now (slice K8; §2.10): on the same signed read by id alone, worked out as it is
     * read, so a copy on the phone never holds one that has since gone. Absent elsewhere, and on a page gathered with the
     * assistant (its writer earns no badge from it, and the page shows nobody's card).
     */
    writerLocalGuide?: boolean;
}

// ── Recognition (slice K8; §2.10) ────────────────────────────────────────────────────────

/** The Local guide badge, as the trust profile's `badges` names it. Gates nothing, pays nothing. */
export const LOCAL_GUIDE_BADGE = 'local-guide' as const;
/** A page is "used" once this many counted members tapped "This helped" on it (`helped`, the counted taps). */
export const LOCAL_GUIDE_HELPED = 3;
/** Local guide: this many pages showing now, written by the member (never gathered with the assistant), each one used. */
export const LOCAL_GUIDE_PAGES = 3;

/** The badge as both apps draw it, on the writer's line of a page and under a name on a profile. One sentence, one key. */
export const LOCAL_GUIDE_WORDS = Object.freeze({
    line: word('🗺️ Local guide'),
});

/** Whether a trust profile's `badges` hold Local guide. Anything else (a node from before K8 sends none): no. */
export function isLocalGuide(badges: unknown): boolean {
    return Array.isArray(badges) && badges.includes(LOCAL_GUIDE_BADGE);
}

/**
 * Thank (§2.10, §3.7): "🫘 Thank {name}" opens the ordinary Send form, the writer chosen and this note filled, both changeable.
 * It is a gift of the member's own Beans under today's rules: the node pays nothing, ever.
 */
export const KNOWLEDGE_THANK = Object.freeze({
    button: word('🫘 Thank {name}'),
    note: word('Thanks for "{title}"'),
});

/** The note "Thank" fills in, in the reader's language. */
export function knowledgeThankNote(title: string, words: Pick<Words, 't'> = { t }): string {
    return words.t(KNOWLEDGE_THANK.note, { title });
}

/**
 * Whether a reader is offered "🫘 Thank {name}" on a page (§2.10): a member with a key, on a live Learn, where Beans are live
 * for them (not off, not the worldwide community's preview), on a page with a writer that isn't theirs and wasn't gathered with
 * the assistant. Whether they can send yet is not asked here: the Send form answers that in today's words.
 */
export function knowledgeThankOffered(f: { signedIn: boolean; live: boolean; beansLive: boolean; own: boolean; gathered: boolean; writer: string | null | undefined }): boolean {
    return f.signedIn && f.live && f.beansLive && !f.own && !f.gathered && !!f.writer;
}

/**
 * "This helped" (slice K5; §2.10): what POST /api/knowledge/posts/:id/helped answers. The count of counted taps, and whether
 * the reader's own tap is on. Who tapped is never sent.
 */
export interface KnowledgeHelped {
    helped: number;
    helpedByMe: boolean;
}

/**
 * "Not checked for a year" (§5.2; the row card's amber "Checked over a year ago", §3.1): a page an owner or admin last
 * confirmed more than this many days ago. Listed for the owners and admins in To check; it never counts in the bell.
 */
export const KNOWLEDGE_UNCHECKED_DAYS = 365;

/** Whether a page was last checked more than {@link KNOWLEDGE_UNCHECKED_DAYS} days before `now`. An unreadable date: no. */
export function knowledgeUncheckedForAYear(checkedAt: string | null | undefined, now: number = Date.now()): boolean {
    const at = typeof checkedAt === 'string' ? Date.parse(checkedAt) : NaN;
    return Number.isFinite(at) && now - at > KNOWLEDGE_UNCHECKED_DAYS * 24 * 60 * 60 * 1000;
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

// ── Home (slice K7) ──────────────────────────────────────────────────────────────────────

/**
 * Home's doors to Learn (amended §3.6), one set of words for both apps, shown through t() (tn() for `figure`). `name` is the
 * card's caption and its row in Add a card; `seeAllSpoken` what a screen reader says for the card's "See all ›" (each app
 * draws its own "See all"); `fresh` the chip on a page that first showed in the last {@link LEARN_HOME_NEW_DAYS} days;
 * `toCheck` an owner's or admin's first row, amber, to To check; `first` their row where Learn holds nothing yet, to the
 * form; `keep` the button on the card while it arrives on an arranged Home (home-frame.ts keepArrivedCard); `figure` the
 * "Your community" card's figure, from 1, which opens Learn.
 */
export const LEARN_HOME_WORDS = Object.freeze({
    name: word('Learn something local'),
    seeAllSpoken: word('See all of Learn'),
    fresh: word('New', 'chip: a page of Local knowledge that first showed in the last 14 days'),
    toCheck: wordn('{n} to check ›', '{n} to check ›'),
    first: word('Add the first thing worth knowing about {community}'),
    keep: word('Keep on Home'),
    figure: wordn('{n} thing worth knowing', '{n} things worth knowing'),
});

/** The most rows the Home card shows. */
export const LEARN_HOME_ROWS = 3;
/** How long a page counts as new on the Home card: the newest page, if it first showed this many days ago or less. */
export const LEARN_HOME_NEW_DAYS = 14;

/** One row on the Home card: Learn's row card, its first line cut short; `isNew` on the newest page of the last 14 days. */
export interface HomeLearnRow extends KnowledgeRow {
    isNew?: true;
}

/**
 * The Home card (`cards.learn` in GET /api/home, amended §4.2), built by the node only where Learn is on and only for a
 * member: up to {@link LEARN_HOME_ROWS} rows, the newest page first when it is new, then the day's pick (the same for every
 * member that day, so the card doesn't reshuffle at each open). `toCheck`: members' suggestions waiting, for an owner or
 * admin whose app opens To check (`lands=learn`). `first`: an owner or admin, and Learn holds nothing yet. No card for a
 * member with nothing to show.
 */
export interface HomeLearnCard {
    rows: HomeLearnRow[];
    toCheck?: number;
    first?: true;
}

/** The doors an app can open from the Home card beyond a page and Learn itself: To check, and the form (slice K4's screens). */
export interface LearnHomeOpens {
    toCheck?: boolean;
    addFirst?: boolean;
}

/** What the Home card draws: the amber To check row's count (0: none), the first-page row, and the day's rows. */
export interface LearnHomeLines {
    toCheck: number;
    first: boolean;
    rows: HomeLearnRow[];
}

/**
 * What the Home card draws on both apps (amended §3.6), from the node's card and the doors this app opens: "N to check ›" only
 * where To check opens, "Add the first thing worth knowing about {community}" only where the form opens (and Learn shows
 * nothing), so neither row ever lands nowhere; then up to {@link LEARN_HOME_ROWS} rows. Null when that leaves nothing to
 * draw: the card is not drawn (a member with nothing to show gets no card).
 */
export function learnHomeLines(card: HomeLearnCard | null | undefined, opens: LearnHomeOpens = {}): LearnHomeLines | null {
    if (!card || typeof card !== 'object') return null;
    const rows = (Array.isArray(card.rows) ? card.rows : []).slice(0, LEARN_HOME_ROWS);
    const toCheck = opens.toCheck && typeof card.toCheck === 'number' && card.toCheck > 0 ? Math.floor(card.toCheck) : 0;
    const first = !!opens.addFirst && card.first === true && rows.length === 0;
    return rows.length > 0 || toCheck > 0 || first ? { toCheck, first, rows } : null;
}

/** The "Your community" card's figure (amended §3.6): the count of pages Learn shows, from 1; null at 0 or when not sent. */
export const learnFigureCount = (n: unknown): number | null =>
    typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;

// ── The waiting list (slice K3) ──────────────────────────────────────────────────────────

/**
 * A member's suggestions (§2.4): at most 3 waiting at once, and 5 sent in any 24 hours whether taken back, answered or
 * not. An answer is kept for My suggestions for 30 days, then the row goes. An owner's or admin's own page waits for
 * nobody: it publishes at once (POST /api/knowledge/posts).
 */
export const KNOWLEDGE_DRAFT_LIMITS = Object.freeze({
    waiting: 3,
    perDay: 5,
    answeredDays: 30,
});

/** A new page, or a fix to one showing (slice K5). */
export type KnowledgeDraftKind = 'new' | 'fix';

/** One of a member's own suggestions (GET /api/knowledge/drafts/mine), as My suggestions draws it. Never who answered. */
export interface KnowledgeDraftMine {
    id: string;
    kind: KnowledgeDraftKind;
    title: string;
    topic: string;
    state: 'waiting' | 'approved' | 'declined';
    createdAt: string;
    answeredAt: string | null;
    /** The page it made or changed, once added. */
    postId: string | null;
    /** A fix's page (slice K5), waiting or answered; null for a new page. The node always sends it; a server before K5 doesn't. */
    fixOf?: string | null;
    /** Why it wasn't added (a KNOWLEDGE_DECLINE_REASONS id), and the owner's or admin's own few words. */
    reason: KnowledgeDeclineReason | null;
    reasonWords: string | null;
}

/** One row of To check (GET /api/knowledge/drafts, owners and admins), the longest waiting first. */
export interface KnowledgeDraftToCheck {
    id: string;
    kind: KnowledgeDraftKind;
    title: string;
    topic: string;
    /** The member who sent it, or the owner or admin an assistant gathered it for. */
    from: { pubkey: string; name: string };
    /** The assistant's name when an owner's or admin's assistant gathered it (slice K6); null from the app. */
    assistant: string | null;
    createdAt: string;
}

/** One suggestion whole, as the checking screen shows it (GET /api/knowledge/drafts/:id). */
export interface KnowledgeDraftWhole extends KnowledgeDraftToCheck {
    body: string;
    place: string | null;
    sources: KnowledgeSource[];
    lang: string | null;
    /** What an assistant said it is about: place, service or how_to (K6); null from the app. */
    about: string | null;
    /** A fix's "What changed?" (K5); null for a new page. */
    note: string | null;
    /** Its photos as data URLs, metadata stripped: the sender's own, at most 3. */
    photos: string[];
    /**
     * One for each of {@link photos}, in order: what the node read from Wikimedia Commons for that picture, or null for one
     * uploaded (an assistant's draft, DESIGN-learn-web-pictures-fable.md §6.2). A server before the Commons door doesn't send it.
     */
    photoCredits?: (KnowledgePhotoCredit | null)[];
    /**
     * Its own tags (free tags only, the Market's rule: core tags/free-tags.ts), each in its stored form; for a fix, the page's
     * tags with the member's put in if they changed them: what Approve writes. A server before Learn's tags doesn't send it.
     */
    freeTags?: string[];
    /** A fix: whether its member changed the tags (they are not one of {@link KNOWLEDGE_FIX_PARTS}); null for a new page. */
    freeTagsChanged?: boolean | null;
    /** A fix: whether the page's own tags changed under it since it was sent, as {@link pageChanged} says of a part. */
    freeTagsPageChanged?: boolean | null;
    /** Approving waits for the tick "I opened the sources and they say this.": an assistant's draft. */
    needsSourcesTicked: boolean;
    /**
     * A fix's page as it shows now (§5.3: each changed part as "Now" beside "Suggested"); null for a new page, or when the
     * page no longer shows (approving it is then refused: say "Not this one"). The node always sends it; a server before K5
     * doesn't.
     */
    post?: KnowledgePageWords | null;
    /**
     * A fix's parts its member changed, in {@link KNOWLEDGE_FIX_PARTS} order (§5.3: "each changed part as Now and
     * Suggested"); [] for the note alone, null for a new page. For a fix the words above are the page as it shows with those
     * parts put in: what Approve writes. A server before K5 round 2 doesn't send it.
     */
    changed?: KnowledgeFixPart[] | null;
    /**
     * The changed parts the page itself changed under since the fix was sent (another fix approved, an owner's or admin's
     * edit): Approve is refused, 409 `page_changed`, until "Edit first" sends each of them; or "Not this one". [] when none.
     */
    pageChanged?: KnowledgeFixPart[] | null;
}

/** The parts of a page a fix can change (slice K5): its words, never its photos. */
export const KNOWLEDGE_FIX_PARTS = Object.freeze(['title', 'body', 'topic', 'place', 'sources', 'lang'] as const);
export type KnowledgeFixPart = (typeof KNOWLEDGE_FIX_PARTS)[number];

/** A page's words as it shows (its photos stay where they are: a fix never changes them). */
export interface KnowledgePageWords {
    id: string;
    title: string;
    body: string;
    topic: string;
    place: string | null;
    sources: KnowledgeSource[];
    lang: string | null;
    /** Its own tags as it shows, each in its stored form. A server before Learn's tags doesn't send it. */
    freeTags?: string[];
}

/**
 * To check (GET /api/knowledge/drafts, owners and admins): what waits, a page at a time, the longest waiting first; and
 * under it the pages "Not checked for a year" (§5.2), the oldest checked first, at most {@link KNOWLEDGE_UNCHECKED_ROWS}.
 * Those are information, not a problem: they never count in the bell or the admin queue.
 */
export interface KnowledgeToCheckList {
    drafts: KnowledgeDraftToCheck[];
    total: number;
    limit: number;
    offset: number;
    unchecked: { total: number; rows: KnowledgeRow[] };
}

/** The most rows of "Not checked for a year" one read of To check carries. */
export const KNOWLEDGE_UNCHECKED_ROWS = 50;

/**
 * The words of the waiting list's notices (§3.4 and §5.6, as amended). A kept notice and a push's details name nobody who
 * answered; the member reads the page's title, the reason's label and the owner's or admin's own words, if any.
 */
export const KNOWLEDGE_DRAFT_WORDS = Object.freeze({
    addedTitle: word('Your local knowledge is in'),
    addedBody: word('"{title}" is now in Learn. Thank you.'),
    declinedTitle: word("Your local knowledge wasn't added"),
    declinedBody: word('"{title}" wasn\'t added. Reason: {reason}.'),
    declinedBodyWords: word('"{title}" wasn\'t added. Reason: {reason}. {words}'),
    /** A fix's answer (slice K5; §3.4): the page's title, the reason and the admin's words; never who answered. */
    fixAddedTitle: word('Your fix is in'),
    fixAddedBody: word('Your fix to "{title}" is showing now. Thank you.'),
    fixDeclinedTitle: word("Your fix wasn't used"),
    fixDeclinedBody: word('Your fix to "{title}" wasn\'t used. Reason: {reason}.'),
    fixDeclinedBodyWords: word('Your fix to "{title}" wasn\'t used. Reason: {reason}. {words}'),
    /** To owners and admins, when a member suggests a page: who, what, one action. */
    suggestedTitle: word('Local knowledge to check'),
    suggestedBody: word('{name} suggested local knowledge: "{title}". Check it in Learn.'),
    /** The same when a member suggests a fix to a page showing (slice K5). */
    suggestedFixBody: word('{name} suggested a fix to "{title}". Check it in Learn.'),
});

/**
 * The notice a member keeps when an owner or admin answers their suggestion, in `words`' language: the node keeps it in
 * English (wordsFor('en')), and an app writes the same from the same facts in its member's. An unknown reason reads as
 * "Another reason". `kind` 'fix' (slice K5): "Your fix is in" / "Your fix wasn't used", `title` the page's.
 */
export function knowledgeAnswerNotice(
    answer: { outcome: 'approved' | 'declined'; title: string; reason?: string | null; words?: string | null; kind?: KnowledgeDraftKind },
    words: Pick<Words, 't'> = { t },
): { title: string; body: string } {
    const W = KNOWLEDGE_DRAFT_WORDS;
    const fix = answer.kind === 'fix';
    if (answer.outcome === 'approved') {
        return fix
            ? { title: words.t(W.fixAddedTitle), body: words.t(W.fixAddedBody, { title: answer.title }) }
            : { title: words.t(W.addedTitle), body: words.t(W.addedBody, { title: answer.title }) };
    }
    const reason = KNOWLEDGE_DECLINE_REASONS.find((r) => r.id === answer.reason) ?? KNOWLEDGE_DECLINE_REASONS[KNOWLEDGE_DECLINE_REASONS.length - 1];
    const said = typeof answer.words === 'string' ? answer.words.trim() : '';
    const values = { title: answer.title, reason: words.t(reason.label), words: said };
    if (fix) {
        return { title: words.t(W.fixDeclinedTitle), body: said ? words.t(W.fixDeclinedBodyWords, values) : words.t(W.fixDeclinedBody, values) };
    }
    return { title: words.t(W.declinedTitle), body: said ? words.t(W.declinedBodyWords, values) : words.t(W.declinedBody, values) };
}

/** The Needs-you line for an owner or admin with suggestions to check (§5.1): a count, never a name. */
export function knowledgeToCheckLine(count: number, words: Pick<Words, 't'> = { t }): string {
    return words.t('Local knowledge to check: {n}', { n: count });
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

/**
 * The word an app sends in GET /api/pulse/feed's `with=` to be given knowledge cards (amended §2.3): a read without it never
 * holds one, so an app from before KP never draws a card it doesn't know.
 */
export const PULSE_KNOWLEDGE_WITH = 'knowledge' as const;

/** The card's id is this and the node's local date: `know_2026-11-15`. No Pulse item's id starts so. */
export const PULSE_KNOWLEDGE_ID_PREFIX = 'know_' as const;

/** How far back the Pulse announces (amended §2.12): pages first shown in the last 30 days. */
export const PULSE_KNOWLEDGE_DAYS = 30;

/** And of those, the newest 20 only: the Pulse is no second Learn (amended §A6). */
export const PULSE_KNOWLEDGE_MAX_PAGES = 20;

/** The rows one card carries (amended §3.8): the first three titles; "and {n} more ›" counts the rest from `count`. */
export const PULSE_KNOWLEDGE_ROWS = 3;

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
 * `with=knowledge`, one a day at most, never stored. It keeps a feed item's fields so one list holds both kinds: the owner's
 * fields are there and empty (no face, no name, no profile to open).
 */
export interface PulseKnowledgeCard {
    /** `know_<local date>`. */
    id: string;
    source: typeof PULSE_KNOWLEDGE_SOURCE;
    platform: 'beanpool';
    category: 'knowledge';
    url: null;
    thumbnailUrl: null;
    ownerPubkey: '';
    callsign: '';
    avatarUrl: null;
    isVerified: false;
    /** The day's newest page's title. */
    title: string;
    /** When that day's newest page first showed, as an ISO time: the card's place in the feed's order. */
    publishedAt: string;
    /** `count`: the day's pages; `posts`: the newest PULSE_KNOWLEDGE_ROWS of them, newest first. */
    knowledge: { count: number; posts: PulseKnowledgePost[] };
}

/** Whether a feed item is the knowledge card. */
export function isPulseKnowledgeCard(item: unknown): item is PulseKnowledgeCard {
    return !!item && typeof item === 'object' && (item as { source?: unknown }).source === PULSE_KNOWLEDGE_SOURCE;
}
